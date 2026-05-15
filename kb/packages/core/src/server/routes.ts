import type { Express, Request, Response } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../app.js';
import type {
  AgentInvokeRequest,
  ChatRequest,
  CreateExternalAgentRequest,
  HubRoleValue,
  ImportTextRequest,
  TriggerSchedulerRequest,
  UpdateConfigRequest,
} from '@kb/shared';
import { logger } from '../util/logger.js';
import { newUuid } from '../util/uuid.js';
import { nowIso } from '../util/now.js';
import { envManagedKeys } from '../config/config.js';
import { parseFile, classifyFile } from '../ingest/parsers.js';
import { loadInsightInput, godNodes, surprisingConnections, knowledgeGaps } from '../graph/insights.js';
import { NodeStorage } from '../storage/storage.js';
import crypto from 'node:crypto';

const upload = multer({ storage: multer.memoryStorage() });

// Below this cosine sim, a non-hub node's "best anchor" is judged too weak —
// the frontend should detach it from its cluster_hub and connect it to root_hub
// instead, marking it as an edge node. Surfaces the difference between
// "belongs to the cluster's broad theme" and "geometric nearest-neighbor only".
const ANCHOR_SIM_THRESHOLD = 0.5;

export function registerRoutes(server: Express, app: AppContext) {
  // ===== Health =====
  server.get('/api/health', (_req, res) => {
    res.json({ ok: true, ts: nowIso() });
  });

  // Connectivity self-test for chat LLM and embedding service
  server.post('/api/llm/ping', async (_req, res) => {
    const chat = await app.consultant.ping();
    let embedding: { ok: boolean; ms: number; dim?: number; error?: string };
    const t0 = Date.now();
    try {
      const v = await app.embedding.embedOne('connectivity test');
      embedding = { ok: v.length > 0, ms: Date.now() - t0, dim: v.length };
    } catch (err) {
      embedding = { ok: false, ms: Date.now() - t0, error: (err as Error).message };
    }
    res.json({ chat, embedding });
  });

  // ===== Chat =====
  server.post('/api/chat', async (req: Request<unknown, unknown, ChatRequest>, res: Response) => {
    try {
      const { messages } = req.body;
      if (!messages?.length) return res.status(400).json({ error: 'messages required' });
      const result = await app.consultant.chat(messages);
      res.json({
        conversation_id: req.body.conversation_id ?? newUuid(),
        message: result.message,
        references: result.references,
        run_id: result.runId,
      });
    } catch (err) {
      logger.error({ err }, 'chat failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  server.post('/api/chat/stream', async (req: Request<unknown, unknown, ChatRequest>, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    try {
      const { messages } = req.body;
      for await (const ev of app.consultant.chatStream(messages)) {
        res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.data ?? null)}\n\n`);
      }
    } catch (err) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: (err as Error).message })}\n\n`);
    } finally {
      res.end();
    }
  });

  // ===== Nodes / Clusters =====
  server.get('/api/nodes', (req, res) => {
    const filter = {
      node_type: req.query.node_type as never,
      cluster_id: req.query.cluster_id ? Number(req.query.cluster_id) : undefined,
      status: req.query.status as never,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    };
    const nodes = app.storage.listNodes(filter);
    res.json({ nodes, total: nodes.length });
  });

  server.get('/api/nodes/:uuid', (req, res) => {
    const node = app.storage.readNode(req.params.uuid);
    if (!node) return res.status(404).json({ error: 'not found' });
    res.json(node);
  });

  server.get('/api/nodes/:uuid/blame', (req, res) => {
    res.json({ entries: app.oplog.blame(req.params.uuid) });
  });

  // Soft delete: status -> archived, content/file/blame retained, op_log row written.
  // Then immediately reconcile: any synthesis whose sources all became inactive
  // gets superseded (v1.3 §5.4). cluster_review validation_state also recomputed.
  server.post('/api/nodes/:uuid/archive', (req, res) => {
    const reason = String((req.body as { reason?: string })?.reason ?? 'archived from UI');
    const uuid = req.params.uuid;
    const node = app.storage.readNode(uuid);
    if (!node) return res.status(404).json({ error: 'not found' });
    app.storage.archiveNode(uuid, reason);
    let downstream = { synthesisUpdated: 0, clusterReviewsRevalidated: 0, superseded: 0 };
    if (node.node_type === 'raw') {
      downstream = app.clustering.recomputeSynthesisDerivedState(uuid);
      if (downstream.superseded > 0 || node.derived_state?.is_cluster_hub) {
        app.clustering.recomputeHubs();
      }
    }
    res.json({ ok: true, downstream });
  });

  // Hard delete: removes nodes row + markdown file + wikilinks/synthesis_sources.
  // Used to clear pollution / mistaken imports. Does NOT write op_log
  // (the node should look like it never existed).
  // Synthesis cleanup: scan for synthesis whose sources all became inactive and
  // supersede them. We compute this BEFORE the delete because synthesis_sources
  // rows are dropped together — after the delete we'd lose the trace.
  server.delete('/api/nodes/:uuid', (req, res) => {
    const uuid = req.params.uuid;
    const node = app.storage.readNode(uuid);
    if (!node) return res.status(404).json({ error: 'not found' });
    // Pre-compute affected synthesis (those that referenced this uuid).
    const affectedSynth = app.db
      .prepare(
        `SELECT DISTINCT ss.synthesis_uuid AS uuid FROM synthesis_sources ss
           JOIN nodes n ON n.uuid = ss.synthesis_uuid
           WHERE ss.source_uuid=? AND n.status='active' AND n.node_type='synthesis'`,
      )
      .all(uuid) as { uuid: string }[];
    const wasHub = node.derived_state?.is_cluster_hub ?? false;

    const tx = app.db.transaction(() => {
      app.db.prepare('DELETE FROM wikilinks WHERE source_uuid=? OR target_uuid=?').run(uuid, uuid);
      app.db.prepare('DELETE FROM synthesis_sources WHERE synthesis_uuid=? OR source_uuid=?').run(uuid, uuid);
      app.db.prepare('DELETE FROM nodes WHERE uuid=?').run(uuid);
    });
    tx();
    // Remove markdown file using storage's locateFile to match actual layout
    const deleted = app.storage.deleteNodeFile(uuid);
    if (!deleted) {
      logger.warn({ uuid }, 'hard-delete: no markdown file found for uuid');
    }
    // Now reconcile each affected synthesis individually.
    let supersededCount = 0;
    for (const s of affectedSynth) {
      const remaining = (app.db
        .prepare(
          `SELECT COUNT(*) AS c FROM synthesis_sources ss
             JOIN nodes n ON n.uuid=ss.source_uuid
             WHERE ss.synthesis_uuid=? AND n.status='active'`,
        )
        .get(s.uuid) as { c: number }).c;
      if (remaining === 0) {
        app.storage.supersedeNode(s.uuid, 'all_sources_inactive');
        supersededCount++;
      }
    }
    // Also recompute hubs if we just removed one
    if (wasHub) app.clustering.recomputeHubs();
    res.json({ ok: true, deleted: uuid, superseded_synthesis: supersededCount });
  });

  // Knowledge graph: nodes + real edges (wikilinks + synthesis sources)
  server.get('/api/graph', (_req, res) => {
    const nodeRows = app.db
      .prepare(
        `SELECT uuid, node_type, l0_summary, cluster_id, status, reference_count,
                hub_role_value, is_cluster_hub, synthesis_subtype
         FROM nodes WHERE status='active'`,
      )
      .all() as Array<{
      uuid: string;
      node_type: string;
      l0_summary: string;
      cluster_id: number | null;
      status: string;
      reference_count: number;
      hub_role_value: HubRoleValue | null;
      is_cluster_hub: number;
      synthesis_subtype: string | null;
    }>;
    const wikilinks = app.db
      .prepare(
        `SELECT w.source_uuid AS s, w.target_uuid AS t, se.sim_score AS sim
         FROM wikilinks w
         JOIN nodes ns ON ns.uuid=w.source_uuid AND ns.status='active'
         JOIN nodes nt ON nt.uuid=w.target_uuid AND nt.status='active'
         LEFT JOIN similarity_edges se
           ON se.source_uuid=w.source_uuid AND se.target_uuid=w.target_uuid`,
      )
      .all() as Array<{ s: string; t: string; sim: number | null }>;
    const sources = app.db
      .prepare(
        `SELECT s.synthesis_uuid AS s, s.source_uuid AS t, s.role AS role
         FROM synthesis_sources s
         JOIN nodes ns ON ns.uuid=s.synthesis_uuid AND ns.status='active'
         JOIN nodes nsr ON nsr.uuid=s.source_uuid AND nsr.status='active'`,
      )
      .all() as Array<{ s: string; t: string; role: string }>;
    // v1.3 hierarchical view: compute sub-cluster anchors per cluster.
    const subAnchors = new Map<string, string>();
    const clusterIds = new Set<number>();
    for (const n of nodeRows) if (n.cluster_id !== null) clusterIds.add(n.cluster_id);
    for (const cid of clusterIds) {
      const m = app.clustering.computeSubclusterAnchors(cid);
      for (const [uuid, anchor] of m) subAnchors.set(uuid, anchor);
    }

    // For each node, fetch its cosine sim to its anchor (from similarity_edges,
    // populated by monthly persistClusterSimilarities). Then decide where the
    // frontend should ultimately connect it: sub_hub / cluster_hub / root_hub.
    const simStmt = app.db.prepare(
      "SELECT sim_score FROM similarity_edges WHERE source_uuid=? AND target_uuid=?",
    );
    const anchorSim = new Map<string, number>();
    for (const [uuid, anchor] of subAnchors) {
      const row = simStmt.get(uuid, anchor) as { sim_score: number } | undefined;
      if (row) anchorSim.set(uuid, row.sim_score);
    }
    const isHubByUuid = new Map<string, boolean>();
    for (const n of nodeRows) isHubByUuid.set(n.uuid, n.is_cluster_hub === 1);
    const effectiveAnchor = new Map<string, 'sub_hub' | 'cluster_hub' | 'root_hub'>();
    for (const n of nodeRows) {
      if (n.is_cluster_hub === 1) continue;
      const anchor = subAnchors.get(n.uuid);
      if (!anchor) continue;
      const sim = anchorSim.get(n.uuid);
      // Sim data missing (e.g. before first monthly run) → fall back to anchor's own type.
      if (sim !== undefined && sim < ANCHOR_SIM_THRESHOLD) {
        effectiveAnchor.set(n.uuid, 'root_hub');
        continue;
      }
      effectiveAnchor.set(n.uuid, isHubByUuid.get(anchor) ? 'cluster_hub' : 'sub_hub');
    }

    // Cluster tree: parent_cluster_id + virtual parent metadata.
    // Frontend uses this to render real hierarchy (replaces root-hub patch).
    const clusterTree = app.db
      .prepare(
        `SELECT cluster_id, parent_cluster_id, member_count, description, hub_uuid
         FROM clusters WHERE status='active'`,
      )
      .all() as Array<{
      cluster_id: number;
      parent_cluster_id: number | null;
      member_count: number;
      description: string | null;
      hub_uuid: string | null;
    }>;

    res.json({
      nodes: nodeRows.map((n) => ({
        ...n,
        is_cluster_hub: n.is_cluster_hub === 1,
        sub_anchor_uuid: subAnchors.get(n.uuid) ?? null,
        anchor_sim: anchorSim.get(n.uuid) ?? null,
        effective_anchor: effectiveAnchor.get(n.uuid) ?? null,
      })),
      cluster_tree: clusterTree,
      links: [
        ...wikilinks.map((r) => ({
          source: r.s,
          target: r.t,
          kind: 'wikilink' as const,
          sim_score: r.sim ?? null,
        })),
        ...sources.map((r) => ({
          source: r.s,
          target: r.t,
          kind: 'source' as const,
          role: r.role,
        })),
      ],
    });
  });

  // Composite graph insights — god_nodes, surprising_connections, knowledge_gaps
  // computed in one pass. Caller can request individual sections via query.
  server.get('/api/graph/insights', (req, res) => {
    const want = (req.query.want as string | undefined)?.split(',').map((s) => s.trim()) ?? [
      'god_nodes',
      'surprises',
      'gaps',
    ];
    const topN = req.query.top ? Number(req.query.top) : 10;

    // Compute cohesion for any cluster the gaps section needs.
    let cohesionByCluster: Map<number, number> | undefined;
    if (want.includes('gaps')) {
      const clusterRows = app.db
        .prepare("SELECT cluster_id FROM clusters WHERE status='active'")
        .all() as { cluster_id: number }[];
      cohesionByCluster = new Map();
      for (const c of clusterRows) {
        cohesionByCluster.set(c.cluster_id, app.clustering.computeCohesion(c.cluster_id));
      }
    }
    const input = loadInsightInput(app.db, cohesionByCluster);

    const out: Record<string, unknown> = {};
    if (want.includes('god_nodes')) out.god_nodes = godNodes(input, topN);
    if (want.includes('surprises')) out.surprises = surprisingConnections(input, topN);
    if (want.includes('gaps')) out.gaps = knowledgeGaps(input);
    res.json(out);
  });

  // ===== Flag queue (v1.3 §7.2) =====
  server.get('/api/flag_queue', (req, res) => {
    const status = req.query.status as 'pending' | 'addressed' | 'dismissed' | undefined;
    const flag_type = req.query.flag_type as 'specific_issue' | 'cluster_friction' | undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const items = app.flagQueue.list({ status, flag_type, limit });
    const counts = app.flagQueue.countByStatus();
    res.json({ items, counts });
  });

  server.post('/api/flag_queue/:id/dismiss', (req, res) => {
    const ok = app.flagQueue.dismiss(String(req.params.id));
    res.json({ ok });
  });

  server.get('/api/clusters', (_req, res) => {
    const rows = app.db
      .prepare(
        `SELECT cluster_id, created_at, member_count, description, status,
                hub_uuid, hub_source, friction_count, last_review_at, last_new_member_at,
                parent_cluster_id
         FROM clusters WHERE status='active' ORDER BY member_count DESC`,
      )
      .all();
    res.json({ clusters: rows });
  });

  server.get('/api/clusters/:id', (req, res) => {
    const cid = Number(req.params.id);
    const cluster = app.db
      .prepare('SELECT * FROM clusters WHERE cluster_id=?')
      .get(cid) as Record<string, unknown> | undefined;
    if (!cluster) return res.status(404).json({ error: 'not found' });
    const members = app.storage.listNodes({ cluster_id: cid });
    res.json({ ...cluster, members });
  });

  // ===== op log / query log / agent runs / scheduler =====
  server.get('/api/op_log', (req, res) => {
    const entries = app.oplog.list({
      since: req.query.since as string | undefined,
      until: req.query.until as string | undefined,
      agent_id: req.query.agent_id as string | undefined,
      op_type: req.query.op_type as never,
      branch: req.query.branch as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    res.json({ entries });
  });

  server.get('/api/query_log', (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const rows = app.db
      .prepare('SELECT * FROM query_log ORDER BY timestamp DESC LIMIT ?')
      .all(limit);
    res.json({ entries: rows });
  });

  server.get('/api/agent_runs', (_req, res) => {
    const rows = app.db
      .prepare('SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT 100')
      .all();
    res.json({ runs: rows });
  });

  server.get('/api/scheduler_state', (_req, res) => {
    const rows = app.db.prepare('SELECT * FROM scheduler_state').all();
    res.json({ states: rows });
  });

  server.post('/api/scheduler/trigger', async (req: Request<unknown, unknown, TriggerSchedulerRequest>, res: Response) => {
    const { job_name } = req.body;
    if (!['weekly', 'monthly', 'background'].includes(job_name)) {
      return res.status(400).json({ error: 'invalid job_name' });
    }
    const run_id = newUuid();
    void app.scheduler.runJob(job_name);
    res.json({ run_id });
  });

  // ===== Status =====
  server.get('/api/status', (_req, res) => {
    res.json({
      counts: app.storage.countByStatus(),
      cluster_count: (app.db.prepare("SELECT COUNT(*) AS c FROM clusters WHERE status='active'").get() as { c: number }).c,
    });
  });

  // ===== Config =====
  // GET /api/config            -> redacted (api_key shown as ****xxxx)
  // GET /api/config?reveal=1   -> unredacted (used by SettingsModal; safe because server binds 127.0.0.1 only)
  server.get('/api/config', (req, res) => {
    const reveal = req.query.reveal === '1';
    res.json({
      ...(reveal ? app.config : redactConfig(app.config)),
      _env_managed_keys: envManagedKeys(),
    });
  });

  server.put('/api/config', (req: Request<unknown, unknown, UpdateConfigRequest>, res: Response) => {
    const reveal = req.query.reveal === '1';
    const result = app.applyConfig(req.body);
    const cfg = reveal ? app.config : redactConfig(app.config);
    res.json({
      config: { ...cfg, _env_managed_keys: envManagedKeys() },
      dim_changed: result.dimChanged,
    });
  });

  // ===== Import =====
  server.post('/api/import/text', (req: Request<unknown, unknown, ImportTextRequest>, res: Response) => {
    const node = app.storage.createNode({
      node_type: 'raw',
      body: req.body.body,
      l0_summary: req.body.l0_summary,
      l1_overview: req.body.l1_overview,
      current_path: req.body.current_path,
      created_by: 'human:default',
      created_by_run: 'manual',
    });
    res.json({ uuid: node.uuid });
  });

  server.post('/api/import/markdown_files', upload.array('files', 200), (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const imported: string[] = [];
    const failed: { name: string; reason: string }[] = [];
    for (const f of files) {
      try {
        const text = f.buffer.toString('utf-8');
        const node = app.storage.createNode({
          node_type: 'raw',
          body: text,
          created_by: 'human:default',
          created_by_run: `import:${f.originalname}`,
        });
        imported.push(node.uuid);
      } catch (err) {
        failed.push({ name: f.originalname, reason: (err as Error).message });
      }
    }
    res.json({ imported, failed });
  });

  // Multi-format batch import. Dispatches each file by extension:
  //   .md/.txt → utf-8        .pdf → pdf-parse        .docx → mammoth
  // Unsupported types are reported in `failed`, never crash the batch.
  server.post('/api/import/files', upload.array('files', 200), async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const imported: {
      uuid: string;
      filename: string;
      format: string;
      warnings: string[];
      structure: { heading_count: number; source: string };
      deduped?: boolean;
    }[] = [];
    const failed: { name: string; reason: string }[] = [];
    const dedupedCount = { value: 0 };
    for (const f of files) {
      try {
        if (classifyFile(f.originalname) === 'unsupported') {
          failed.push({ name: f.originalname, reason: 'unsupported format' });
          continue;
        }
        const parsed = await parseFile(f.buffer, f.originalname);
        if (!parsed.body.trim()) {
          failed.push({ name: f.originalname, reason: 'empty body after parse' });
          continue;
        }
        // SHA256 dedupe — if identical body content already exists as an active
        // node, point the import response at the existing uuid and skip
        // summarize/embed entirely. Major savings on duplicate uploads.
        const bodyHash = NodeStorage.hashBody(parsed.body);
        const existingUuid = app.storage.findByBodyHash(bodyHash);
        if (existingUuid) {
          dedupedCount.value++;
          imported.push({
            uuid: existingUuid,
            filename: f.originalname,
            format: parsed.format,
            warnings: [...parsed.warnings, 'duplicate content — pointed at existing node'],
            structure: {
              heading_count: parsed.structure.headings.length,
              source: parsed.structure.source,
            },
            deduped: true,
          });
          continue;
        }
        const node = app.storage.createNode({
          node_type: 'raw',
          body: parsed.body,
          created_by: 'human:default',
          created_by_run: `import:${parsed.format}:${f.originalname}`,
        });
        imported.push({
          uuid: node.uuid,
          filename: f.originalname,
          format: parsed.format,
          warnings: parsed.warnings,
          structure: {
            heading_count: parsed.structure.headings.length,
            source: parsed.structure.source,
          },
        });
      } catch (err) {
        logger.warn({ err, name: f.originalname }, 'import file failed');
        failed.push({ name: f.originalname, reason: (err as Error).message });
      }
    }
    res.json({ imported, failed, deduped_count: dedupedCount.value });
  });

  // ===== Agent invoke =====
  server.post('/api/agent/invoke', async (req, res) => {
    const { agent_id, api_key, tool_name, args } = req.body;

    // 1. 参数校验
    if (!agent_id || !api_key || !tool_name) {
      return res.status(400).json({
        error: { code: 'INVALID_ARGUMENTS', message: 'agent_id, api_key, tool_name are required' }
      });
    }

    // 2. 认证
    const ext = (app.config.external_agents ?? []).find((a) => a.agent_id === agent_id);
    if (!ext || !verifyKey(api_key, ext.api_key)) {
      return res.status(401).json({
        error: { code: 'INVALID_CREDENTIALS', message: 'invalid agent credentials' }
      });
    }

    // 3. 工具存在性校验
    const tool = app.tools.get(tool_name);
    if (!tool) {
      return res.status(404).json({
        error: { code: 'UNKNOWN_TOOL', message: `tool '${tool_name}' not found`, tool_name }
      });
    }

    // 4. 权限校验
    if (!ext.permissions.includes(tool.permission_tag)) {
      return res.status(403).json({
        error: {
          code: 'PERMISSION_DENIED',
          message: `permission '${tool.permission_tag}' required`,
          tool_name,
          details: { required: tool.permission_tag, granted: ext.permissions }
        }
      });
    }

    // 5. 执行工具
    const ctx = { agent_id, agent_run_id: newUuid(), permissions: ext.permissions };
    const result = await app.tools.invoke(tool_name, args, ctx);

    // 6. 检查 tool 返回的错误（权限级别由 invoke handler 处理，tool 返回 {error:...} 表示权限被拒绝）
    if (typeof result === 'object' && result !== null && 'error' in result) {
      return res.status(403).json({
        error: { code: 'PERMISSION_DENIED', message: (result as { error: string }).error, tool_name }
      });
    }

    res.json({ result });
  });

  server.post('/api/agent/list_tools', (req, res) => {
    const { agent_id, api_key } = req.body as { agent_id: string; api_key: string };

    if (!agent_id || !api_key) {
      return res.status(400).json({
        error: { code: 'INVALID_ARGUMENTS', message: 'agent_id and api_key are required' }
      });
    }

    const ext = (app.config.external_agents ?? []).find((a) => a.agent_id === agent_id);
    if (!ext || !verifyKey(api_key, ext.api_key)) {
      return res.status(401).json({
        error: { code: 'INVALID_CREDENTIALS', message: 'invalid agent credentials' }
      });
    }

    const tools = app.tools.visibleTo(ext.permissions);
    const toolSpecs = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      permission_tag: t.permission_tag,
      category: t.permission_tag as 'read' | 'write' | 'structural' | 'admin',
      restricted: t.permission_tag === 'structural' || t.permission_tag === 'admin'
        ? { reason: 'structural/admin tools require explicit KB admin authorization', suggestion: 'use flag_specific_issue / flag_cluster_friction for feedback' }
        : undefined
    }));

    const warnings: string[] = [];
    if (!ext.permissions.includes('structural')) {
      warnings.push('KB structural operations (op_*, synthesize_explicit) require structural permission. Use flag_specific_issue / flag_cluster_friction for feedback.');
    }
    if (!ext.permissions.includes('write')) {
      warnings.push('write permission required to create nodes. Current permissions are read-only.');
    }

    res.json({
      tools: toolSpecs,
      agent_id: ext.agent_id,
      permissions: ext.permissions,
      warnings: warnings.length ? warnings : undefined
    });
  });

  server.post('/api/agent/create', (req: Request<unknown, unknown, CreateExternalAgentRequest>, res: Response) => {
    const apiKey = `kb_${crypto.randomBytes(24).toString('hex')}`;
    const entry = {
      agent_id: req.body.agent_id,
      api_key: apiKey,
      permissions: req.body.permissions,
      description: req.body.description,
      created_at: nowIso(),
    };
    app.config.external_agents = [...(app.config.external_agents ?? []), entry];
    app.saveConfig(app.config);
    res.json({ agent: entry, api_key: apiKey });
  });
}

function redactConfig(cfg: import('@kb/shared').KBConfig) {
  return {
    ...cfg,
    llm: { ...cfg.llm, api_key: cfg.llm.api_key ? '****' + cfg.llm.api_key.slice(-4) : '' },
    embedding: {
      ...cfg.embedding,
      api_key: cfg.embedding.api_key ? '****' + cfg.embedding.api_key.slice(-4) : '',
    },
    external_agents: (cfg.external_agents ?? []).map((a) => ({
      ...a,
      api_key: '****' + a.api_key.slice(-4),
    })),
  };
}

function verifyKey(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}
