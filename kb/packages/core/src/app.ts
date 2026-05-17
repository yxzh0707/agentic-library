import path from 'node:path';
import fs from 'node:fs';
import type { KBConfig } from '@kb/shared';
import { openDb, type DB } from './storage/db.js';
import { NodeStorage } from './storage/storage.js';
import { OpLogService } from './op_log/op_log.js';
import { FlagQueueService } from './flag/flag_queue.js';
import { LLMClient } from './llm/client.js';
import { EmbeddingService, startEmbeddingWorker } from './embedding/embedding.js';
import { IndexService } from './indexing/index_service.js';
import { ClusteringService } from './clustering/clustering.js';
import { SynthesisService } from './synthesis/synthesis.js';
import { SummarizationService } from './summarization/summarizer.js';
import { ToolRegistry } from './tools/registry.js';
import { bus } from './events/bus.js';
import { registerAllTools } from './tools/index.js';
import { ConsultantAgent } from './agents/consultant.js';
import { LibrarianAgent } from './agents/librarian.js';
import { Scheduler } from './scheduler/scheduler.js';
import { saveConfig } from './config/config.js';
import { logger } from './util/logger.js';
import { nowIso } from './util/now.js';
import { filenameToUuid } from './util/uuid.js';

export interface AppContext {
  config: KBConfig;
  db: DB;
  storage: NodeStorage;
  oplog: OpLogService;
  flagQueue: FlagQueueService;
  llm: LLMClient;
  embedding: EmbeddingService;
  index: IndexService;
  clustering: ClusteringService;
  synthesis: SynthesisService;
  tools: ToolRegistry;
  consultant: ConsultantAgent;
  librarian: LibrarianAgent;
  scheduler: Scheduler;
  shutdown: () => Promise<void>;
  saveConfig: (cfg: KBConfig) => void;
  applyConfig: (patch: Partial<KBConfig>) => { dimChanged: boolean };
}

export async function initApp(config: KBConfig): Promise<AppContext> {
  if (!fs.existsSync(config.data_dir)) fs.mkdirSync(config.data_dir, { recursive: true });
  const logDir = path.join(config.data_dir, 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

  const db = openDb(config.data_dir);
  const storage = new NodeStorage({ db, dataDir: config.data_dir });
  const oplog = new OpLogService(db);
  const flagQueue = new FlagQueueService(db);
  const llm = new LLMClient(config.llm, config.embedding);
  const embedding = new EmbeddingService(llm);
  const index = new IndexService(config.data_dir, config.embedding.dim);
  const clustering = new ClusteringService(db, storage, index, config.parameters, llm, oplog, flagQueue);
  const synthesis = new SynthesisService({
    db,
    storage,
    oplog,
    llm,
    embedding,
    index,
    params: config.parameters,
  });

  const tools = new ToolRegistry();

  const consultant = new ConsultantAgent({ llm, tools });
  const librarian = new LibrarianAgent({
    llm,
    tools,
    db,
    storage,
    oplog,
    synthesis,
    clustering,
    index,
    flagQueue,
  });
  const scheduler = new Scheduler({ db, librarian });

  registerAllTools({
    registry: tools,
    storage,
    oplog,
    db,
    embedding,
    index,
    synthesis,
    clustering,
    flagQueue,
    params: config.parameters,
  });

  const stateStmt = db.prepare(
    `INSERT OR IGNORE INTO scheduler_state (job_name, last_run_at, next_run_at, last_status)
     VALUES (?, NULL, NULL, NULL)`,
  );
  for (const j of ['weekly', 'monthly', 'background']) stateStmt.run(j);

  // ===== Embedding worker (v1.3 §5.1: 2 layers only) =====
  const worker = startEmbeddingWorker({
    embedding,
    pendingUuids: () => storage.pendingEmbeddingUuids(0),  // 0 = all pending, no artificial cap
    embedNode: async (uuid) => {
      const node = storage.readNode(uuid);
      if (!node) return;
      const l0 = node.l0_summary || node.body.slice(0, 200);
      const l1 = node.l1_overview || node.body.slice(0, 1500);
      const vectors = await embedding.embedTexts([l0, l1]);
      const id_l0 = index.addVector('l0', vectors[0] ?? []);
      const id_l1 = index.addVector('l1', vectors[1] ?? []);
      storage.setEmbeddingPointers(uuid, {
        e_l0_id: id_l0,
        e_l1_id: id_l1,
        model: config.embedding.model,
      });
      if (node.node_type === 'raw') {
        let assigned = false;
        try {
          const result = await clustering.incrementalAssign(uuid);
          assigned = result.cluster_id !== null;
        } catch (err) {
          logger.warn({ err, uuid }, 'incrementalAssign failed');
        }
        // Auto-recluster guard: if this is the last node in a batch and many
        // are noise, auto-trigger to prevent permanent orphan accumulation.
        if (!assigned && pendingCount <= 1) {
          const noiseCount = (db.prepare(
            "SELECT COUNT(*) AS c FROM nodes WHERE status='active' AND node_type='raw' AND e_l1_id IS NOT NULL AND cluster_id IS NULL"
          ).get() as { c: number }).c;
          const totalEmbedded = (db.prepare(
            "SELECT COUNT(*) AS c FROM nodes WHERE status='active' AND node_type='raw' AND e_l1_id IS NOT NULL"
          ).get() as { c: number }).c;
          if (totalEmbedded > 10 && noiseCount / totalEmbedded > 0.20) {
            logger.info({ noiseCount, totalEmbedded, ratio: noiseCount/totalEmbedded },
              'high noise ratio detected after embedding batch — triggering auto recluster');
            try { await clustering.rescueNoiseNodes({ maxBudget: 50 }); } catch (err) { 
              logger.warn({ err }, 'auto rescueNoiseNodes failed'); 
            }
          }
        }
        // v1.3 §5.1: incremental assign 完成后立即触发 on_ingest
        try {
          const result = await librarian.runOnIngest(uuid);
          // v1.4: root anchor 入集后立即触发 hub recompute，让 problem
          // statement 立即成为 cluster hub，不等下一次定期 recompute。
          if (result.hub_role === 'root') {
            clustering.recomputeHubs();
          }
        } catch (err) {
          logger.warn({ err, uuid }, 'on_ingest failed');
        }
      }
      index.persist();
    },
  });

  // ===== Auto-summarize before embed (for nodes ingested without l0/l1) =====
  const summarizer = new SummarizationService(llm);
  const summarizeQueue: string[] = [];
  const summarizeInflight = new Set<string>();
  const MAX_CONCURRENT_SUMMARIES = Number(process.env.SUMMARIZE_CONCURRENCY ?? '3') || 3;

  const enqueueSummary = (uuid: string) => {
    if (summarizeInflight.has(uuid)) return;
    if (!summarizeQueue.includes(uuid)) summarizeQueue.push(uuid);
    pumpSummaryQueue();
  };

  const pumpSummaryQueue = () => {
    while (summarizeInflight.size < MAX_CONCURRENT_SUMMARIES && summarizeQueue.length > 0) {
      const uuid = summarizeQueue.shift()!;
      summarizeInflight.add(uuid);
      void runSummarize(uuid).finally(() => {
        summarizeInflight.delete(uuid);
        pumpSummaryQueue();
      });
    }
  };

  const runSummarize = async (uuid: string) => {
    const node = storage.readNode(uuid);
    if (!node) return;
    if (node.l0_summary && node.l1_overview) return;
    const t0 = Date.now();
    try {
      const { l0_summary, l1_overview } = await summarizer.summarize(node.body);
      storage.updateNodeMetadata(uuid, {
        l0_summary,
        l1_overview,
        embeddings: { ...node.embeddings, embedded_at: null },
      });
      logger.info({ uuid, ms: Date.now() - t0 }, 'auto-summarize: done');
      worker.kick();
    } catch (err) {
      logger.warn({ err, uuid, ms: Date.now() - t0 }, 'auto-summarize: failed');
    }
  };

  bus.subscribe((ev) => {
    if (ev.type === 'node_created') {
      const node = storage.readNode(ev.uuid);
      if (node?.node_type === 'raw' && (!node.l0_summary || !node.l1_overview)) {
        enqueueSummary(ev.uuid);
      }
      worker.kick();
    } else if (ev.type === 'node_updated') {
      worker.kick();
    }
  });

  // Mark any runs that were still running when the last process exited as failed
  const stuck = db
    .prepare("UPDATE agent_runs SET status='failed', finished_at=? WHERE status='running'")
    .run(nowIso());
  if (stuck.changes > 0) {
    logger.warn({ count: stuck.changes }, 'startup: marked stuck agent runs as failed');
  }

  scheduler.start();

  reconcileFiles(config.data_dir, storage, db);

  // Catch-up: any active raw node missing l0/l1 (early-imported before
  // summarize ran, or reset for re-summarize) gets enqueued. Embedded-but-
  // un-summarized nodes also enqueue, since worker only re-embeds when
  // embedded_at is NULL.
  const incomplete = db
    .prepare(
      "SELECT uuid FROM nodes WHERE status='active' AND node_type='raw' AND (l0_summary IS NULL OR l0_summary='' OR l1_overview IS NULL OR l1_overview='')",
    )
    .all() as { uuid: string }[];
  if (incomplete.length > 0) {
    logger.info({ count: incomplete.length }, 'startup catch-up: enqueueing summarize for incomplete nodes');
    for (const r of incomplete) enqueueSummary(r.uuid);
  }

  logger.info({ ts: nowIso() }, 'app initialized');

  const ctx: AppContext = {
    config,
    db,
    storage,
    oplog,
    flagQueue,
    llm,
    embedding,
    index,
    clustering,
    synthesis,
    tools,
    consultant,
    librarian,
    scheduler,
    shutdown: async () => {
      worker.stop();
      scheduler.stop();
      try {
        index.persist();
      } catch {
        // ignore
      }
      try {
        db.close();
      } catch {
        // ignore
      }
      storage.releaseLock();
    },
    saveConfig: (cfg) => saveConfig(cfg),
    applyConfig: (patch) => {
      const oldDim = ctx.config.embedding.dim;
      if (patch.parameters) {
        ctx.config.parameters = { ...ctx.config.parameters, ...patch.parameters };
      }
      if (patch.llm) {
        const merged = { ...ctx.config.llm, ...patch.llm };
        if (merged.api_key && merged.api_key.startsWith('****')) {
          merged.api_key = ctx.config.llm.api_key;
        }
        ctx.config.llm = merged;
      }
      if (patch.embedding) {
        const merged = { ...ctx.config.embedding, ...patch.embedding };
        if (merged.api_key && merged.api_key.startsWith('****')) {
          merged.api_key = ctx.config.embedding.api_key;
        }
        ctx.config.embedding = merged;
      }
      ctx.llm.update(ctx.config.llm, ctx.config.embedding);
      saveConfig(ctx.config);
      const dimChanged = ctx.config.embedding.dim !== oldDim;
      if (dimChanged) {
        logger.warn(
          { oldDim, newDim: ctx.config.embedding.dim },
          'embedding.dim changed; restart and re-embed all nodes to rebuild.',
        );
      }
      return { dimChanged };
    },
  };
  return ctx;
}

function reconcileFiles(dataDir: string, storage: NodeStorage, db: DB) {
  const contentDir = path.join(dataDir, 'content');
  if (!fs.existsSync(contentDir)) return;
  const have = new Set(
    (db.prepare('SELECT uuid FROM nodes').all() as { uuid: string }[]).map((r) => r.uuid),
  );
  const subs = fs.readdirSync(contentDir);
  let added = 0;
  for (const sub of subs) {
    const subPath = path.join(contentDir, sub);
    if (!fs.statSync(subPath).isDirectory()) continue;
    for (const fname of fs.readdirSync(subPath)) {
      if (!fname.endsWith('.md')) continue;
      const uuid = filenameToUuid(fname);
      if (!uuid) continue;
      if (have.has(uuid)) continue;
      try {
        const node = storage.readNode(uuid);
        if (node) added++;
      } catch (err) {
        logger.warn({ err, uuid }, 'failed to reconcile file');
      }
    }
  }
  if (added > 0) logger.info({ added }, 'reconciled files into db');
}
