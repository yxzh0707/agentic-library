import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ClusterAssignmentResult, ClusterQualitySignal, ClusterStatus, HubRoleValue, HubSource, KBConfigParameters, SubstructureResult } from '@kb/shared';
import { logger } from '../util/logger.js';
import type { IndexService } from '../indexing/index_service.js';
import type { NodeStorage } from '../storage/storage.js';
import type { DB } from '../storage/db.js';
import type { LLMClient } from '../llm/client.js';
import type { OpLogService } from '../op_log/op_log.js';
import type { FlagQueueService } from '../flag/flag_queue.js';
import { nowIso } from '../util/now.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function pythonScriptPath(): string {
  return path.resolve(__dirname, '..', '..', 'python', 'cluster.py');
}

const PY = process.env.KB_PYTHON ?? 'python3';

async function runPython<T>(task: object): Promise<T> {
  const json = JSON.stringify(task);
  const useFile = json.length > 1_000_000;
  let scriptArgs: string[];
  let tmpPath: string | null = null;
  if (useFile) {
    tmpPath = path.join(os.tmpdir(), `kb-cluster-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(tmpPath, json);
    scriptArgs = [pythonScriptPath(), '--file', tmpPath];
  } else {
    scriptArgs = [pythonScriptPath()];
  }
  return await new Promise<T>((resolve, reject) => {
    const proc = spawn(PY, scriptArgs);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (tmpPath) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          /* ignore */
        }
      }
      if (code !== 0) {
        reject(new Error(`python exited ${code}: ${err}`));
        return;
      }
      try {
        resolve(JSON.parse(out) as T);
      } catch (e) {
        reject(new Error(`python output parse failed: ${(e as Error).message}; raw=${out.slice(0, 500)}`));
      }
    });
    if (!useFile) {
      proc.stdin.write(json);
      proc.stdin.end();
    }
  });
}

function cosineSim(a: number[] | Float32Array, b: number[] | Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export class ClusteringService {
  constructor(
    private db: DB,
    private storage: NodeStorage,
    private index: IndexService,
    private params: KBConfigParameters,
    private llm?: LLMClient,
    private oplog?: OpLogService,
    private flagQueue?: FlagQueueService,
  ) {
    void this.llm;
    void this.oplog;
    void this.flagQueue;
  }

  private adaptParamsForN(N: number): KBConfigParameters {
    const adaptiveMinSize = Math.min(
      this.params.hdbscan_min_cluster_size,
      Math.max(3, Math.floor(N / 8)),
    );
    const adaptiveMinSamples = Math.min(
      this.params.hdbscan_min_samples,
      Math.max(2, Math.floor(adaptiveMinSize / 2)),
    );
    return {
      ...this.params,
      hdbscan_min_cluster_size: adaptiveMinSize,
      hdbscan_min_samples: adaptiveMinSamples,
    };
  }

  /** Threshold of unclustered raw nodes that justifies firing fullRecluster. */
  reclusterThreshold(N: number): number {
    const adaptiveMin = Math.max(3, Math.floor(N / 8));
    return Math.max(6, adaptiveMin * 2);
  }

  async resetClustersAndRecluster(opts: { reason?: string; agent_run_id?: string; agent_id?: string; maxN?: number; minN?: number } = {}): Promise<{
    reset_clusters: number;
    reset_nodes: number;
    formed: number;
    assignments: Map<string, number>;
  } | null> {
    const activeClusters = this.db
      .prepare("SELECT cluster_id, status FROM clusters WHERE status='active'")
      .all() as { cluster_id: number; status: string }[];
    const activeRawNodes = this.db
      .prepare("SELECT uuid FROM nodes WHERE status='active' AND node_type='raw'")
      .all() as { uuid: string }[];

    const ts = nowIso();
    const reason = opts.reason ?? 'admin reset clusters and rerun cold_start';
    const agentRunId = opts.agent_run_id ?? 'system';
    const agentId = opts.agent_id ?? 'system:admin';
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE nodes
           SET cluster_id=NULL,
               cluster_membership_strength=NULL,
               is_cluster_hub=0,
               hub_of_cluster=NULL
           WHERE status='active' AND node_type='raw'`,
        )
        .run();
      this.db
        .prepare(
          `UPDATE clusters
           SET status='emptied',
               member_count=0,
               hub_uuid=NULL,
               hub_source='none',
               centroid_e_l1=NULL,
               parent_cluster_id=NULL
           WHERE status='active'`,
        )
        .run();
    });
    tx();

    this.oplog?.append({
      agent_run_id: agentRunId,
      agent_id: agentId,
      op_type: 'extract',
      args: {
        kind: 'reset_and_recluster',
        reset_clusters: activeClusters.map((c) => c.cluster_id),
        reset_node_count: activeRawNodes.length,
      },
      reason,
      affected_uuids: activeRawNodes.map((n) => n.uuid),
    });
    for (const c of activeClusters) {
      this.oplog?.append({
        agent_run_id: agentRunId,
        agent_id: agentId,
        op_type: 'cluster_status_change',
        args: {
          cluster_id: c.cluster_id,
          from_status: c.status,
          to_status: 'emptied',
          kind: 'reset_and_recluster',
          timestamp: ts,
        },
        reason,
        affected_uuids: [],
      });
    }

    const r = await this.coldStartCluster({ maxN: opts.maxN, minN: opts.minN });
    if (!r) return null;
    this.recomputeHubs();
    this.recomputeSynthesisDerivedState();
    return {
      reset_clusters: activeClusters.length,
      reset_nodes: activeRawNodes.length,
      formed: r.formed,
      assignments: r.assignments,
    };
  }

  /**
   * v1.3 §6.3 incremental assignment. Centroid-primary, KNN-borderline fallback.
   *
   *   1. Cosine sim to every active cluster centroid; max ≥ 0.65 → assign
   *   2. Else if max sim ∈ [0.50, 0.65) → KNN top-20 majority vote (≥60%)
   *   3. Else → noise (cluster_id null)
   */
  async incrementalAssign(uuid: string): Promise<ClusterAssignmentResult> {
    const ptr = this.storage.getEmbeddingPointers(uuid);
    if (!ptr || ptr.e_l1_id === null) return { cluster_id: null, strength: 0 };
    const vec = this.index.getVector('l1', ptr.e_l1_id);
    if (!vec) return { cluster_id: null, strength: 0 };

    const clusterRows = this.db
      .prepare(
        "SELECT cluster_id, centroid_e_l1 FROM clusters WHERE status='active' AND centroid_e_l1 IS NOT NULL",
      )
      .all() as { cluster_id: number; centroid_e_l1: Buffer }[];

    let bestCid = -1;
    let bestSim = 0;
    for (const c of clusterRows) {
      const centroid = new Float32Array(
        c.centroid_e_l1.buffer,
        c.centroid_e_l1.byteOffset,
        c.centroid_e_l1.byteLength / 4,
      );
      const sim = cosineSim(vec, centroid);
      if (sim > bestSim) {
        bestSim = sim;
        bestCid = c.cluster_id;
      }
    }

    if (bestSim >= 0.65 && bestCid !== -1) {
      this.storage.setClusterAssignment(uuid, bestCid, bestSim);
      this.refreshClusterCentroid(bestCid);
      this.bumpClusterLastNewMember(bestCid);
      return { cluster_id: bestCid, strength: bestSim };
    }

    if (bestSim < 0.5) {
      return { cluster_id: null, strength: bestSim };
    }
    const neighbors = this.index.searchKNN('l1', vec, 21);
    const others = neighbors.filter((n) => n.id !== ptr.e_l1_id).slice(0, 20);
    if (others.length === 0) return { cluster_id: null, strength: bestSim };
    const placeholders = others.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT cluster_id FROM nodes WHERE e_l1_id IN (${placeholders}) AND cluster_id IS NOT NULL`,
      )
      .all(...others.map((o) => o.id)) as { cluster_id: number }[];
    if (rows.length === 0) return { cluster_id: null, strength: bestSim };
    const counts = new Map<number, number>();
    for (const r of rows) counts.set(r.cluster_id, (counts.get(r.cluster_id) ?? 0) + 1);
    let voteCid = -1;
    let voteCount = 0;
    for (const [cid, c] of counts) {
      if (c > voteCount) {
        voteCount = c;
        voteCid = cid;
      }
    }
    const voteStrength = voteCount / others.length;
    if (voteStrength >= 0.6 && voteCid !== -1) {
      this.storage.setClusterAssignment(uuid, voteCid, voteStrength);
      this.refreshClusterCentroid(voteCid);
      this.bumpClusterLastNewMember(voteCid);
      return { cluster_id: voteCid, strength: voteStrength };
    }
    return { cluster_id: null, strength: bestSim };
  }

  async fullRecluster(): Promise<{ assignments: number; clusters: number; locked: number }> {
    // GC is moved to AFTER HDBSCAN runs successfully — see the GC pass at the
    // bottom. Doing it up-front used to leave clusters in `emptied` state when
    // HDBSCAN later judged everything as noise and the cold-start protection
    // skipped rewriting cluster_id; nodes would point to a dead cluster row.

    // SOFT LOCK: LLM/user move ops within last 30 days are authoritative.
    // Their target nodes are excluded from HDBSCAN re-assignment so the
    // physical algorithm doesn't undo recent semantic corrections. After
    // 30 days HDBSCAN gets to argue again — embeddings may have shifted
    // (more neighbors arrived, semantic landscape changed).
    const lockCutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const lockedRows = this.db
      .prepare(
        `SELECT DISTINCT json_extract(args, '$.uuid') AS uuid
         FROM op_log
         WHERE op_type='move' AND timestamp >= ?
           AND json_extract(args, '$.uuid') IS NOT NULL`,
      )
      .all(lockCutoff) as { uuid: string }[];
    const lockedUuids = new Set(lockedRows.map((r) => r.uuid));

    const items = this.storage.allActiveRawWithL1();
    if (items.length === 0) return { assignments: 0, clusters: 0, locked: 0 };
    const embeddings: number[][] = [];
    const uuids: string[] = [];
    let locked = 0;
    for (const it of items) {
      if (lockedUuids.has(it.uuid)) {
        locked++;
        continue; // skip — preserve current cluster_id
      }
      const v = this.index.getVector('l1', it.e_l1_id);
      if (!v) continue;
      embeddings.push(v);
      uuids.push(it.uuid);
    }
    const adaptedParams = this.adaptParamsForN(embeddings.length);
    const res = await runPython<{ labels: number[]; probabilities: number[] }>({
      op: 'full_recluster',
      embeddings,
      params: adaptedParams,
    });
    // Cold-start protection: if HDBSCAN judges every node as noise, do NOT
    // overwrite existing cluster assignments — that would wipe out clusters
    // formed by coldStartCluster() while N is still in HDBSCAN's failure zone.
    // Only proceed with the wipe-and-rewrite when HDBSCAN actually formed
    // at least one cluster.
    const formedAny = res.labels.some((l) => l !== undefined && l >= 0);
    if (!formedAny) {
      const activeClusterCount = (this.db
        .prepare("SELECT COUNT(*) AS c FROM clusters WHERE status='active' AND member_count > 0")
        .get() as { c: number }).c;
      const expectedMinClusters = Math.ceil(embeddings.length / 15);
      if (this.flagQueue && activeClusterCount < expectedMinClusters) {
        const existing = this.db
          .prepare(
            `SELECT flag_id FROM flag_queue
             WHERE status='pending'
               AND flag_type='cluster_friction'
               AND target_uuid IS NULL
               AND target_cluster_id IS NULL
               AND description LIKE '%HDBSCAN 全 noise%'
             LIMIT 1`,
          )
          .get() as { flag_id: string } | undefined;
        if (!existing) {
          this.flagQueue.append({
            flag_type: 'cluster_friction',
            target_uuid: null,
            target_cluster_id: null,
            issue_type: null,
            flagged_by: 'system:full_recluster',
            description: `HDBSCAN 全 noise: ${embeddings.length} 个参与 fullRecluster 的节点没有形成密度簇; 当前 ${activeClusterCount} 个 active cluster 已保留不变。请人工检查聚类是否仍合理; 如需全面重来,使用 admin tool reset_clusters_and_recluster。`,
          });
        }
      }
      logger.info(
        { N: embeddings.length, locked, activeClusterCount, expectedMinClusters },
        'fullRecluster: HDBSCAN found no density clusters; preserving existing assignments',
      );
      return { assignments: 0, clusters: 0, locked };
    }
    const update = this.db.prepare(
      'UPDATE nodes SET cluster_id=?, cluster_membership_strength=? WHERE uuid=?',
    );
    const clusters = new Set<number>();
    const tx = this.db.transaction(() => {
      for (let i = 0; i < uuids.length; i++) {
        const cid = res.labels[i];
        const prob = res.probabilities[i];
        const finalCid = cid === undefined || cid < 0 ? null : cid;
        update.run(finalCid, prob ?? null, uuids[i]);
        if (finalCid !== null) clusters.add(finalCid);
      }
    });
    tx();
    const counts = this.db
      .prepare(
        "SELECT cluster_id, COUNT(*) AS c FROM nodes WHERE cluster_id IS NOT NULL AND status='active' GROUP BY cluster_id",
      )
      .all() as { cluster_id: number; c: number }[];
    const upsert = this.db.prepare(
      `INSERT INTO clusters (cluster_id, created_at, member_count, status)
       VALUES (?, ?, ?, 'active')
       ON CONFLICT(cluster_id) DO UPDATE SET member_count=excluded.member_count, status='active'`,
    );
    const ts = nowIso();
    for (const r of counts) upsert.run(r.cluster_id, ts, r.c);
    for (const r of counts) this.refreshClusterCentroid(r.cluster_id);

    // GC after rewrite: clusters with no active members are stale. Doing this
    // here (not at the top of fullRecluster) guarantees we never strand nodes
    // pointing to an emptied cluster — if HDBSCAN bails to noise and the
    // protection branch returns early, we never reach this point and existing
    // cluster status is preserved intact.
    //
    // Each status change is individually logged to op_log so the GC decision is
    // auditable and reversible (op log shows which full_recluster run emptied
    // which cluster, and why).
    const emptyRows = this.db
      .prepare(
        `SELECT cluster_id, status, member_count
         FROM clusters
         WHERE status='active' AND cluster_id NOT IN (
           SELECT DISTINCT cluster_id FROM nodes
           WHERE cluster_id IS NOT NULL AND status='active'
         )`,
      )
      .all() as { cluster_id: number; status: string; member_count: number }[];
    for (const c of emptyRows) {
      this.db
        .prepare("UPDATE clusters SET status='emptied', member_count=0 WHERE cluster_id=?")
        .run(c.cluster_id);
      // Dismiss pending flags for this cluster — it no longer exists
      this.db
        .prepare(
          "UPDATE flag_queue SET status='dismissed', addressed_at=? WHERE target_cluster_id=? AND status='pending'",
        )
        .run(ts, c.cluster_id);
      // Clean snapshots — drift tracking is meaningless for an emptied cluster
      this.db.prepare("DELETE FROM cluster_snapshots WHERE cluster_id=?").run(c.cluster_id);
      // Clean orphan cluster_review nodes whose reviewed_cluster_id now points to an emptied cluster
      const orphanReviews = this.db
        .prepare(
          `SELECT uuid FROM nodes
           WHERE node_type='synthesis'
             AND synthesis_subtype='cluster_review'
             AND status='active'
             AND reviewed_cluster_id=?`,
        )
        .all(c.cluster_id) as { uuid: string }[];
      for (const r of orphanReviews) {
        this.storage.supersedeNode(r.uuid, 'full_recluster_gc: reviewed cluster emptied');
      }
      this.oplog?.append({
        agent_run_id: 'system',
        agent_id: 'system:full_recluster',
        op_type: 'cluster_status_change',
        args: {
          cluster_id: c.cluster_id,
          from_status: c.status,
          to_status: 'emptied',
          from_member_count: c.member_count,
          to_member_count: 0,
          kind: 'full_recluster_gc',
          timestamp: ts,
        },
        reason: 'fullRecluster GC: cluster has no active raw members after HDBSCAN rewrite',
        affected_uuids: [],
      });
    }
    return { assignments: uuids.length, clusters: clusters.size, locked };
  }

  /**
   * v1.3 add-back of v1.2's LLM batch cluster. HDBSCAN doesn't form clusters
   * when N < ~10 (density-based algorithm needs density contrast that small
   * homogeneous-distance sets don't provide). This fills the gap by asking
   * the LLM to group l0_summaries directly when the kb is in cold start.
   *
   * Triggers ONLY when:
   *   - llm client is wired
   *   - 0 active clusters exist (don't override fullRecluster's work)
   *   - 6 ≤ N ≤ maxN active raw nodes with non-empty l0_summary
   *
   * Stays out of fullRecluster's path. Resulting clusters get
   * `description` = LLM-given Chinese label, which fullRecluster preserves
   * via ON CONFLICT DO UPDATE only on member_count.
   */
  async coldStartCluster(opts: { maxN?: number; minN?: number } = {}): Promise<{
    formed: number;
    assignments: Map<string, number>;
  } | null> {
    if (!this.llm) {
      logger.warn('coldStartCluster: no LLM client wired');
      return null;
    }
    const maxN = opts.maxN ?? 80;
    const minN = opts.minN ?? 2;

    // Bail if any active cluster exists — cold start is single-shot.
    const existing = (this.db
      .prepare("SELECT COUNT(*) AS c FROM clusters WHERE status='active'")
      .get() as { c: number }).c;
    if (existing > 0) {
      logger.info({ existing }, 'coldStartCluster: clusters already exist, skipping');
      return null;
    }

    const rows = this.db
      .prepare(
        `SELECT uuid, l0_summary, l1_overview FROM nodes
         WHERE status='active' AND node_type='raw' AND cluster_id IS NULL
           AND l0_summary IS NOT NULL AND l0_summary != ''`,
      )
      .all() as { uuid: string; l0_summary: string; l1_overview: string }[];
    if (rows.length < minN) {
      logger.info({ N: rows.length, minN }, 'coldStartCluster: too few candidates');
      return null;
    }
    if (rows.length > maxN) {
      logger.info({ N: rows.length, maxN }, 'coldStartCluster: above LLM batch ceiling');
      return null;
    }

    const N = rows.length;
    const maxK = Math.max(1, Math.floor(N / 2) + 1);
    // Two-stage framing: a cluster represents a *working set* (project / problem
    // / corpus of related work), NOT a fine-grained topic. Sub-topics inside a
    // working set surface as hub_role=center anchors on individual raw nodes,
    // which the frontend renders as sub-hubs (computeSubclusterAnchors).
    // This avoids the pre-v1.4 trap where 22 docs from the same project got
    // forcibly split into 7 thematic clusters and the project framing was lost.
    const itemsText = rows
      .map(
        (r, i) =>
          `[${i + 1}] ${r.uuid}\n  L0: ${r.l0_summary.replace(/\n/g, ' ')}\n  L1: ${(r.l1_overview || '').replace(/\n/g, ' ')}`,
      )
      .join('\n\n');
    const prompt = `下面是 ${N} 个文档,每个有 L0 一句话摘要 + L1 结构化概览。

${itemsText}

# 你的任务

第一步,判断这 ${N} 个文档来自**几个 working set**。一个 working set 是一个**项目/问题/语境单元**(例如"某场竞赛"、"某个研究方向"、"某门课程"),其内部的文档围绕共同目标展开,即使讨论的具体子系统/方法/侧面不同。

- **如果所有文档其实属于同一个项目或同一个语境,正确答案就是 1 个 working set,不要强行细分。**
- 子主题不通过拆分 working set 表达,而是通过 sub_themes 列表里的 anchor_uuid 标记每个子主题的代表节点。
- 只有当文档显然来自彼此独立的项目/语境时,才输出多个 working set。

第二步,对每个 working set,识别其内部 1-5 个**子主题代表**(sub-theme anchors):

- 子主题代表是该 working set 内最能代表某个角度/方向的具体文档(用其 uuid)
- 子主题不是必须的;如果 working set 太小或主题平铺,可以给空数组 \`sub_themes: []\`
- 同一个 anchor_uuid 不能跨子主题重复
- 子主题数量 ≤ ceil(member_count / 3),宁缺毋滥

# 判断准则

你的首要目标是**用最少的大类覆盖所有文档**。多用一个 working set 比少用一个需要更强的理由。

在决定是否新建 working set 之前,先问自己:
- 这些文档讨论的是同一件事/同一个项目/同一个语境吗?
  → 是 → 归入同一个 working set,内部差异用 sub_themes 表达
  → 否 → 才可以新建 working set

具体判断信号:
- "讨论同一产品的不同模块(前端、后端、数据库)" → 同一个 working set
- "讨论同一客户项目的不同交付物(需求、设计、测试)" → 同一个 working set
- "讨论同一研究方向的不同论文/方法" → 同一个 working set
- "一篇讲市场营销策略,一篇讲劳动法规" → 两个 working set

判断时看文档的实质语境和共同目标,不是标题措辞或技术栈差异。

反例警示:
如果 ${N} 篇文档全是同一项目的衍生内容,正确答案是 1 个 working set。
错误做法:把一个项目拆成"方案设计""技术实现""测试验收"等多个 working set。
除非文档确实来自完全不同的项目/领域,否则不要拆。

# 输出格式

严格 JSON,不要解释、不要 markdown:

{
  "working_sets": [
    {
      "label": "<2-8 汉字的项目/语境名,例如 '产品需求文档' 或 '客户调研报告'>",
      "reasoning": "<1 句话说明为什么这些文档同属一个 working set>",
      "member_uuids": ["uuid1", ...],
      "sub_themes": [
        { "label": "<2-6 汉字的子主题名>", "anchor_uuid": "<member_uuids 中的一个 uuid>" }
      ]
    }
  ]
}

要求:
- working_sets 总数 1 ≤ K ≤ ${maxK}
- 所有 ${N} 个 uuid 必须恰好出现在某个 working_set.member_uuids 中一次,不重不漏
- 拒绝"杂项""其他""验证"等兜底 working_set,边缘文档归到语义最近的真 working_set
- sub_theme.anchor_uuid 必须是其所属 working_set 的 member`;

    const inputUuids = new Set(rows.map((r) => r.uuid));
    type WS = { label: string; reasoning?: string; member_uuids: string[]; sub_themes?: { label: string; anchor_uuid: string }[] };
    let parsed: { working_sets: WS[] } | null = null;
    let lastIssue = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const completion = await this.llm.chat({
          messages: [
            {
              role: 'system',
              content: '你是图书管理员,职责是把零散文档归到正确的 working set(项目/语境单元),并标记 working set 内部的子主题代表。只输出严格 JSON,不要解释、不要 markdown 代码块。',
            },
            { role: 'user', content: prompt + (lastIssue ? `\n\n上一次输出有问题: ${lastIssue}。请修正后重新输出。` : '') },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.3,
        });
        const raw = completion.choices[0]?.message?.content ?? '{}';
        const candidate = JSON.parse(raw) as { working_sets?: WS[] };
        if (!Array.isArray(candidate.working_sets) || candidate.working_sets.length < 1) {
          lastIssue = '缺少 working_sets 数组或为空';
          continue;
        }
        const K = candidate.working_sets.length;
        if (K > maxK) {
          lastIssue = `working_sets 数 ${K} 超过上限 ${maxK}`;
          continue;
        }
        const seen = new Set<string>();
        let bad = '';
        for (const ws of candidate.working_sets) {
          if (typeof ws.label !== 'string' || ws.label.length < 1 || !Array.isArray(ws.member_uuids) || ws.member_uuids.length < 1) {
            bad = 'working_set 缺 label 或 member_uuids';
            break;
          }
          const wsUuids = new Set<string>();
          for (const u of ws.member_uuids) {
            if (!inputUuids.has(u)) { bad = `未知 uuid ${u}`; break; }
            if (seen.has(u)) { bad = `uuid ${u} 重复出现在多个 working_set`; break; }
            seen.add(u);
            wsUuids.add(u);
          }
          if (bad) break;
          if (Array.isArray(ws.sub_themes)) {
            const anchorsSeen = new Set<string>();
            for (const st of ws.sub_themes) {
              if (typeof st.label !== 'string' || typeof st.anchor_uuid !== 'string') { bad = 'sub_theme 格式错'; break; }
              if (!wsUuids.has(st.anchor_uuid)) { bad = `sub_theme.anchor_uuid ${st.anchor_uuid} 不在所属 working_set 内`; break; }
              if (anchorsSeen.has(st.anchor_uuid)) { bad = `anchor_uuid ${st.anchor_uuid} 在同一 working_set 内重复`; break; }
              anchorsSeen.add(st.anchor_uuid);
            }
            if (bad) break;
          }
        }
        if (bad) { lastIssue = bad; continue; }
        if (seen.size !== N) { lastIssue = `覆盖 ${seen.size}/${N},有遗漏`; continue; }
        parsed = candidate as { working_sets: WS[] };
        break;
      } catch (err) {
        logger.warn({ err, attempt }, 'coldStartCluster: LLM call/parse failed');
        lastIssue = `JSON 解析失败: ${(err as Error).message}`;
      }
    }

    if (!parsed) {
      logger.warn({ lastIssue }, 'coldStartCluster: validation failed after retries');
      return null;
    }
    logger.info(
      {
        N,
        K: parsed.working_sets.length,
        ws: parsed.working_sets.map((w) => ({ label: w.label, n: w.member_uuids.length, sub: w.sub_themes?.length ?? 0 })),
      },
      'coldStartCluster: accepted',
    );

    // Persist
    const ts = nowIso();
    const insert = this.db.prepare(
      "INSERT INTO clusters (cluster_id, created_at, member_count, status, description, friction_count) VALUES (?, ?, ?, 'active', ?, 0)",
    );
    const updateNode = this.db.prepare(
      'UPDATE nodes SET cluster_id=?, cluster_membership_strength=? WHERE uuid=?',
    );
    const maxRow = this.db.prepare('SELECT COALESCE(MAX(cluster_id), -1) AS m FROM clusters').get() as { m: number };
    let nextCid = (maxRow?.m ?? -1) + 1;
    const assignments = new Map<string, number>();
    const newClusterIds: number[] = [];
    const anchorsToPromote: { uuid: string; cluster_id: number; sub_theme_label: string; ws_label: string }[] = [];
    const tx = this.db.transaction(() => {
      for (const ws of parsed!.working_sets) {
        const cid = nextCid++;
        newClusterIds.push(cid);
        insert.run(cid, ts, ws.member_uuids.length, ws.label);
        for (const u of ws.member_uuids) {
          updateNode.run(cid, 1.0, u);
          assignments.set(u, cid);
        }
        for (const st of ws.sub_themes ?? []) {
          anchorsToPromote.push({ uuid: st.anchor_uuid, cluster_id: cid, sub_theme_label: st.label, ws_label: ws.label });
        }
      }
    });
    tx();
    for (const cid of newClusterIds) this.refreshClusterCentroid(cid);

    // Stage 2: surface sub-themes as hub_role='center' anchors. The frontend's
    // computeSubclusterAnchors picks these up to render sub-hubs inside the
    // working-set bubble, so the project framing is preserved while sub-topics
    // remain navigable.
    for (const a of anchorsToPromote) {
      try {
        const row = this.db
          .prepare("SELECT hub_role_value FROM nodes WHERE uuid=? AND status='active' AND node_type='raw'")
          .get(a.uuid) as { hub_role_value: string | null } | undefined;
        if (!row) continue;
        if (row.hub_role_value === 'center' || row.hub_role_value === 'root') continue;
        const fromVal = (row.hub_role_value ?? 'neutral') as HubRoleValue;
        const opId = this.oplog?.append({
          agent_run_id: 'system',
          agent_id: 'system:cold_start',
          op_type: 'set_hub_role',
          args: { uuid: a.uuid, from_value: fromVal, to_value: 'center', cluster_id: a.cluster_id, sub_theme: a.sub_theme_label },
          reason: `cold_start sub-theme anchor: ${fromVal}→center for "${a.sub_theme_label}" inside "${a.ws_label}"`,
          affected_uuids: [a.uuid],
        }).op_id;
        this.storage.setHubRole(
          a.uuid,
          'center',
          'librarian',
          `cold_start sub-theme anchor: "${a.sub_theme_label}" (working set: "${a.ws_label}")`,
          opId ?? null,
          'agent:librarian:cold_start',
        );
      } catch (err) {
        logger.warn({ err, uuid: a.uuid }, 'cold_start sub-theme anchor promotion failed');
      }
    }

    if (this.oplog) {
      for (let i = 0; i < parsed.working_sets.length; i++) {
        const ws = parsed.working_sets[i]!;
        const cid = newClusterIds[i]!;
        this.oplog.append({
          agent_run_id: 'system',
          agent_id: 'system:cold_start',
          op_type: 'extract',
          args: {
            kind: 'cold_start_cluster',
            cluster_id: cid,
            label: ws.label,
            member_count: ws.member_uuids.length,
            sub_themes: (ws.sub_themes ?? []).map((s) => ({ label: s.label, anchor_uuid: s.anchor_uuid })),
            reasoning: ws.reasoning ?? null,
          },
          reason: `LLM cold-start working set #${cid} "${ws.label}" with ${ws.sub_themes?.length ?? 0} sub-themes`,
          affected_uuids: ws.member_uuids,
        });
      }
    }
    logger.info(
      { N, K: parsed.working_sets.length, anchors: anchorsToPromote.length },
      'coldStartCluster: succeeded',
    );
    return { formed: parsed.working_sets.length, assignments };
  }

  /** v2.3 — LLM-driven sub-clustering for oversized clusters.
   *  HDBSCAN forms density-based clusters that can grow too large (100+) when
   *  all content is semantically related. This method asks the LLM to read
   *  member l0_summaries and suggest sub-themes, then executes the split.
   *
   *  Triggers when any cluster exceeds `maxSize` (default 60).
   *  Returns sub-cluster IDs created. */
  async splitOversizedClusters(maxSize = 60): Promise<{ cluster_id: number; sub_clusters: number; moved: number }[]> {
    if (!this.llm) return [];
    const oversized = this.db.prepare(
      `SELECT c.cluster_id, c.member_count FROM clusters c 
       WHERE c.status='active' AND c.member_count > ? 
       ORDER BY c.member_count DESC`
    ).all(maxSize) as { cluster_id: number; member_count: number }[];
    if (oversized.length === 0) return [];

    const results: { cluster_id: number; sub_clusters: number; moved: number }[] = [];
    for (const cl of oversized) {
      const members = this.db.prepare(
        `SELECT uuid, l0_summary FROM nodes 
         WHERE cluster_id=? AND status='active' AND node_type='raw'
         ORDER BY created_at DESC LIMIT 80`
      ).all(cl.cluster_id) as { uuid: string; l0_summary: string }[];
      if (members.length < 10) continue;

      // Ask LLM to suggest 2-5 sub-themes
      const memberList = members.map((m, i) => `${i+1}. ${m.l0_summary.slice(0, 100)}`).join('\n');
      const prompt = `Split this cluster of ${members.length} nodes into 2-4 sub-groups based on content themes. Each sub-group should have a short label and list of member indices (1-based). Return JSON: {"sub_groups": [{"label": "...", "members": [1,2,...]}, ...]}. Do NOT create a group for noise — leave dissimilar nodes unassigned.`;
      const completion = await this.llm.chat({
        messages: [
          { role: 'system', content: 'You are a cluster refinement agent. Split an oversized cluster into thematic sub-groups.' },
          { role: 'user', content: `${prompt}\n\nMembers:\n${memberList}` },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      });
      const raw = completion.choices[0]?.message?.content ?? '{}';
      let parsed: { sub_groups?: { label: string; members: number[] }[] };
      try { parsed = JSON.parse(raw); } catch { continue; }
      if (!parsed.sub_groups || parsed.sub_groups.length < 2) continue;

      // Create sub-clusters and reassign
      const ts = nowIso();
      const subIds: number[] = [];
      const movedUuids: string[] = [];
      const tx = this.db.transaction(() => {
        for (const sg of parsed.sub_groups!) {
          if (sg.members.length < 3) continue;
          const nextId = (this.db.prepare('SELECT MAX(cluster_id)+1 AS n FROM clusters').get() as { n: number }).n;
          this.db.prepare(
            `INSERT INTO clusters (cluster_id, created_at, member_count, description, status)
             VALUES (?, ?, ?, ?, 'active')`
          ).run(nextId, ts, sg.members.length, sg.label);
          for (const idx of sg.members) {
            const uuid = members[idx - 1]?.uuid;
            if (!uuid) continue;
            this.db.prepare(
              'UPDATE nodes SET cluster_id=?, cluster_membership_strength=0.8 WHERE uuid=?'
            ).run(nextId, uuid);
            movedUuids.push(uuid);
          }
          subIds.push(nextId);
        }
        // Archive original cluster
        this.db.prepare(
          "UPDATE clusters SET status='subdivided', description=description || ' (已拆分)' WHERE cluster_id=?"
        ).run(cl.cluster_id);
        // Re-assign remaining nodes to nearest sub-cluster or mark noise
        const remaining = this.db.prepare(
          `SELECT uuid FROM nodes WHERE cluster_id=? AND status='active' AND node_type='raw'`
        ).all(cl.cluster_id) as { uuid: string }[];
        for (const r of remaining) {
          this.db.prepare('UPDATE nodes SET cluster_id=NULL, cluster_membership_strength=0 WHERE uuid=?').run(r.uuid);
        }
      });
      tx();

      for (const sid of subIds) this.refreshClusterCentroid(sid);
      results.push({ cluster_id: cl.cluster_id, sub_clusters: subIds.length, moved: movedUuids.length });
      logger.info({ cluster_id: cl.cluster_id, sub_clusters: subIds.length, moved: movedUuids.length },
        'splitOversizedClusters: subdivided');
    }
    return results;
  }

  detectSubstructure(cluster_id: number): Promise<SubstructureResult> {
    const rows = this.db
      .prepare(
        "SELECT uuid, e_l1_id FROM nodes WHERE cluster_id=? AND status='active' AND node_type='raw' AND e_l1_id IS NOT NULL",
      )
      .all(cluster_id) as { uuid: string; e_l1_id: number }[];
    const embeddings: number[][] = [];
    for (const r of rows) {
      const v = this.index.getVector('l1', r.e_l1_id);
      if (v) embeddings.push(v);
    }
    if (embeddings.length < 6) {
      return { silhouette: 0, recommended_action: 'noop', sub_assignments: null, k: null };
    }
    return runPython<SubstructureResult>({
      op: 'detect_substructure',
      embeddings,
      params: this.params,
    });
  }

  refreshClusterCentroid(cluster_id: number): void {
    const rows = this.db
      .prepare(
        "SELECT e_l1_id FROM nodes WHERE cluster_id=? AND status='active' AND node_type='raw' AND e_l1_id IS NOT NULL",
      )
      .all(cluster_id) as { e_l1_id: number }[];
    if (rows.length === 0) return;
    const dim = this.index.embeddingDim;
    const sum = new Float32Array(dim);
    let n = 0;
    for (const r of rows) {
      const v = this.index.getVector('l1', r.e_l1_id);
      if (!v) continue;
      for (let i = 0; i < dim; i++) sum[i] = (sum[i] ?? 0) + (v[i] ?? 0);
      n++;
    }
    if (n === 0) return;
    for (let i = 0; i < dim; i++) sum[i] = (sum[i] ?? 0) / n;
    const buf = Buffer.from(sum.buffer, sum.byteOffset, sum.byteLength);
    this.db.prepare('UPDATE clusters SET centroid_e_l1=? WHERE cluster_id=?').run(buf, cluster_id);
  }

  private bumpClusterLastNewMember(cluster_id: number): void {
    // Recompute member_count from authoritative source (nodes table) — fixes
    // a v1.2 bug where incrementalAssign forgot to bump member_count, leaving
    // clusters.member_count stale forever.
    const c = (this.db
      .prepare(
        "SELECT COUNT(*) AS c FROM nodes WHERE cluster_id=? AND status='active' AND node_type='raw'",
      )
      .get(cluster_id) as { c: number }).c;
    this.db
      .prepare('UPDATE clusters SET last_new_member_at=?, member_count=? WHERE cluster_id=?')
      .run(nowIso(), c, cluster_id);
  }

  /**
   * v1.3 §6.7 — recompute hub_uuid for every active cluster.
   *   raw center (hub_role='center') wins; else cluster_review whose cluster_id == this cluster.
   * Updates clusters.hub_uuid + clusters.hub_source, sets nodes.is_cluster_hub flag.
   */
  recomputeHubs(): { updated: number } {
    const clusters = this.db
      .prepare("SELECT cluster_id FROM clusters WHERE status='active'")
      .all() as { cluster_id: number }[];
    let updated = 0;

    // Step 1: compute target hub uuid for each cluster
    //
    // Hub election rules (v1.4 working_set):
    //   1. hub_role=root has TOP authority. A problem anchor node defines
    //      the working set boundary — it is the semantic root that all other
    //      members explain, implement, or optimize against. No other signal
    //      can override it.
    //   2. cluster_review.hub_recommendation (when no root node exists). The
    //      LLM saw the WHOLE cluster context and judged who represents this
    //      group best. This is a finer-grained signal than hub_role=center
    //      (which is a single-doc judgment from on_ingest).
    //   3. If LLM recommends a node whose hub_role != 'center', auto-promote
    //      that node's hub_role to 'center' (via op_set_hub_role). Records
    //      the cluster-level correction to the structural layer; protected
    //      by the 30-day soft lock so it doesn't flip-flop.
    //   4. Fallback if no LLM recommendation: hub_role=center candidates
    //      (lexical order). Final fallback: cluster_review synthesis itself.
    const targetHub = new Map<number, { uuid: string; source: HubSource } | null>();
    const toPromote: { uuid: string; cluster_id: number }[] = [];
    for (const c of clusters) {
      const recommended = this.recommendedHubFromReview(c.cluster_id);
      let pick: { uuid: string; source: HubSource } | null = null;

      // Priority 1: root anchor — the problem definition node that defines
      // the working set boundary. Highest authority, no override possible.
      const rootNode = this.db
        .prepare(
          `SELECT uuid FROM nodes
           WHERE cluster_id=? AND status='active' AND node_type='raw' AND hub_role_value='root'
           ORDER BY created_at ASC LIMIT 1`,
        )
        .get(c.cluster_id) as { uuid: string } | undefined;
      if (rootNode) {
        pick = { uuid: rootNode.uuid, source: 'root_anchor' };
      }

      if (!pick && recommended) {
        const recRow = this.db
          .prepare(
            `SELECT uuid, hub_role_value FROM nodes
             WHERE uuid=? AND cluster_id=? AND status='active' AND node_type='raw'`,
          )
          .get(recommended, c.cluster_id) as
          | { uuid: string; hub_role_value: string | null }
          | undefined;
        if (recRow) {
          pick = { uuid: recRow.uuid, source: 'librarian_recommended' };
          // Cluster-level meta judgment overrides single-doc hub_role: if LLM
          // says "this leaf is actually the cluster's natural anchor", believe it
          // and update hub_role too. Captured in op_log for audit + protected by
          // soft lock so HDBSCAN won't undo it next month.
          if (recRow.hub_role_value !== 'center') {
            toPromote.push({ uuid: recRow.uuid, cluster_id: c.cluster_id });
          }
        }
      }

      // Fallback 1: hub_role=center candidates (lexical order)
      if (!pick) {
        const rawCenters = this.db
          .prepare(
            `SELECT uuid FROM nodes
             WHERE cluster_id=? AND status='active' AND node_type='raw' AND hub_role_value='center'
             ORDER BY created_at ASC`,
          )
          .all(c.cluster_id) as { uuid: string }[];
        if (rawCenters.length > 0) pick = { uuid: rawCenters[0]!.uuid, source: 'raw_lexical_fallback' };
      }
      // Fallback 2: cluster_review (synthesis) takes hub when no raw center exists
      if (!pick) {
        const synHub = this.db
          .prepare(
            `SELECT uuid FROM nodes
             WHERE reviewed_cluster_id=? AND status='active'
               AND node_type='synthesis' AND synthesis_subtype='cluster_review'
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(c.cluster_id) as { uuid: string } | undefined;
        if (synHub) pick = { uuid: synHub.uuid, source: 'synthesis_calculated' };
      }
      targetHub.set(c.cluster_id, pick);
    }

    // Step 2: sweep ALL active raw nodes — set is_cluster_hub to its
    // correct target value. Forces SQL and markdown into sync; setIsClusterHub
    // is idempotent so this is cheap when state already matches.
    const allRaws = this.db
      .prepare(
        "SELECT uuid, cluster_id FROM nodes WHERE status='active' AND node_type='raw'",
      )
      .all() as { uuid: string; cluster_id: number | null }[];
    for (const r of allRaws) {
      const shouldBeHub = r.cluster_id !== null && targetHub.get(r.cluster_id)?.uuid === r.uuid;
      try {
        this.storage.setIsClusterHub(r.uuid, shouldBeHub, shouldBeHub ? r.cluster_id : null);
      } catch {
        // file gone; skip
      }
    }

    // Step 3: also handle synthesis hubs (cluster_review can be hub when no raw center).
    // Use reviewed_cluster_id (always set at creation) instead of cluster_id
    // (derived state, computed AFTER recomputeHubs, so NULL on freshly-created
    // cluster_reviews that get picked as hub in step 1).
    const allCRs = this.db
      .prepare(
        `SELECT uuid, reviewed_cluster_id FROM nodes
         WHERE status='active' AND node_type='synthesis' AND synthesis_subtype='cluster_review'`,
      )
      .all() as { uuid: string; reviewed_cluster_id: number | null }[];
    for (const s of allCRs) {
      const shouldBeHub =
        s.reviewed_cluster_id !== null && targetHub.get(s.reviewed_cluster_id)?.uuid === s.uuid;
      try {
        this.storage.setIsClusterHub(
          s.uuid,
          shouldBeHub,
          shouldBeHub ? s.reviewed_cluster_id : null,
        );
      } catch {
        // ignore
      }
    }

    // Step 3.5: promote LLM-recommended non-center hubs to hub_role=center.
    // Recorded as set_hub_role op so it shows up in audit + benefits from
    // 30-day soft lock against fullRecluster reassignment.
    for (const p of toPromote) {
      try {
        const oldRow = this.db
          .prepare('SELECT hub_role_value FROM nodes WHERE uuid=?')
          .get(p.uuid) as { hub_role_value: string | null } | undefined;
        const fromVal = (oldRow?.hub_role_value ?? 'neutral') as HubRoleValue;
        const opId = this.oplog?.append({
          agent_run_id: 'system',
          agent_id: 'system:hub_election',
          op_type: 'set_hub_role',
          args: { uuid: p.uuid, from_value: fromVal, to_value: 'center', cluster_id: p.cluster_id },
          reason: `cluster_review hub_recommendation promoted ${fromVal}→center (LLM saw whole cluster)`,
          affected_uuids: [p.uuid],
        }).op_id;
        this.storage.setHubRole(
          p.uuid,
          'center',
          'librarian',
          'cluster_review hub_recommendation: cluster-level judgment overrides on_ingest single-doc judgment',
          opId ?? null,
          'agent:librarian',
        );
      } catch (err) {
        logger.warn({ err, uuid: p.uuid }, 'hub_role promotion failed');
      }
    }

    // Step 4: update clusters table with hub metadata. hub_source records the
    // *decision origin* (which branch picked this hub), not just the hub's
    // node_type — so the audit trail can distinguish LLM recommendation from
    // lexical fallback even though both produce a raw node as the hub.
    for (const c of clusters) {
      const pick = targetHub.get(c.cluster_id) ?? null;
      const hub_uuid = pick?.uuid ?? null;
      const hub_source: HubSource = pick?.source ?? 'none';
      if (hub_uuid) updated++;
      this.db
        .prepare('UPDATE clusters SET hub_uuid=?, hub_source=? WHERE cluster_id=?')
        .run(hub_uuid, hub_source, c.cluster_id);
    }
    return { updated };
  }

  /**
   * v1.3+ hierarchical meta-clustering: after the leaf clusters stabilize,
   * ask LLM whether they share an outer context (same project, same domain)
   * and form a parent cluster, or are genuinely independent.
   *
   * Why this exists: v1.3 base assumed clusters are flat. In real use, when
   * users dump deepsearch on one project, all resulting clusters share an
   * outer "this is project X" context — flat representation drops that signal.
   * LLM looks at each cluster's description / cluster_review l0 and decides
   * grouping. Result is written to clusters.parent_cluster_id.
   *
   * Currently builds a 2-level tree (leaf clusters + virtual parents). Could
   * extend to deeper trees but most KBs won't need it.
   */
  async computeClusterHierarchy(): Promise<{
    parents_created: number;
    children_attached: number;
  }> {
    if (!this.llm) return { parents_created: 0, children_attached: 0 };

    // Reset old hierarchy: delete previous virtual parents, NULL out children.
    // Virtual parents have member_count=0 (they hold no raw nodes directly,
    // only sub-clusters). Use that as identity marker.
    const oldParentIds = this.db
      .prepare(
        "SELECT cluster_id FROM clusters WHERE status='active' AND member_count=0 AND parent_cluster_id IS NULL",
      )
      .all() as { cluster_id: number }[];
    if (oldParentIds.length > 0) {
      this.db
        .prepare(
          `UPDATE clusters SET parent_cluster_id=NULL WHERE parent_cluster_id IN (${oldParentIds.map(() => '?').join(',')})`,
        )
        .run(...oldParentIds.map((r) => r.cluster_id));
      this.db
        .prepare(
          `DELETE FROM clusters WHERE cluster_id IN (${oldParentIds.map(() => '?').join(',')})`,
        )
        .run(...oldParentIds.map((r) => r.cluster_id));
    }

    // Gather leaf clusters with descriptions / cluster_review l0
    const leafClusters = this.db
      .prepare(
        `SELECT c.cluster_id, c.description, c.member_count,
                (SELECT l0_summary FROM nodes
                 WHERE node_type='synthesis' AND synthesis_subtype='cluster_review'
                   AND status='active' AND reviewed_cluster_id=c.cluster_id
                 ORDER BY created_at DESC LIMIT 1) AS review_l0
         FROM clusters c
         WHERE c.status='active' AND c.member_count > 0`,
      )
      .all() as {
      cluster_id: number;
      description: string | null;
      member_count: number;
      review_l0: string | null;
    }[];

    if (leafClusters.length < 2) {
      return { parents_created: 0, children_attached: 0 };
    }

    const prompt = `下面是知识库当前的 ${leafClusters.length} 个簇,每个簇有标签和一句话总结。

请判断它们之间的关系:
- 如果**多个簇属于同一个更大语境**(同一项目/同一领域/同一研究方向),把它们分到同一个父组,给父组起个 1-5 个汉字的中文标签
- 如果**簇之间领域差异大**(比如一个讲推荐系统、另一个讲法律文档),它们应该保持并列,不组成父组

簇列表:
${leafClusters.map((c) => `  簇 #${c.cluster_id} (${c.member_count} 成员) ${c.description ? `"${c.description}"` : ''}\n     概览: ${c.review_l0 ?? '(无 review)'}`).join('\n')}

输出严格 JSON,描述层级:
{
  "groups": [
    { "label": "父组标签", "child_cluster_ids": [0, 1] },
    { "label": "父组2标签", "child_cluster_ids": [2, 3] }
  ],
  "standalone_cluster_ids": [4, 5]   // 不归属任何父组的簇 id
}

要求:
- 每个父组至少 2 个子簇
- 不要造没意义的父组(比如把无关簇硬塞)
- 单簇就是单簇,直接放 standalone
- 父组标签必须实质化,拒绝"杂项""综合"等兜底词`;

    type Hierarchy = {
      groups?: { label: string; child_cluster_ids: number[] }[];
      standalone_cluster_ids?: number[];
    };
    let parsed: Hierarchy | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const completion = await this.llm.chat({
          messages: [
            { role: 'system', content: '你是图书管理员,只输出严格 JSON。' },
            { role: 'user', content: prompt },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.2,
        });
        const raw = completion.choices[0]?.message?.content ?? '{}';
        const candidate = JSON.parse(raw) as Hierarchy;
        if (!candidate || !Array.isArray(candidate.groups)) continue;
        // Validate: every child_cluster_id must exist in leafClusters; no overlap
        const leafIds = new Set(leafClusters.map((c) => c.cluster_id));
        const seen = new Set<number>();
        let bad = false;
        for (const g of candidate.groups) {
          if (typeof g.label !== 'string' || !Array.isArray(g.child_cluster_ids)) {
            bad = true;
            break;
          }
          if (g.child_cluster_ids.length < 2) {
            bad = true;
            break;
          }
          for (const cid of g.child_cluster_ids) {
            if (!leafIds.has(cid) || seen.has(cid)) {
              bad = true;
              break;
            }
            seen.add(cid);
          }
          if (bad) break;
        }
        if (bad) continue;
        parsed = candidate;
        break;
      } catch (err) {
        logger.warn({ err, attempt }, 'computeClusterHierarchy: parse failed');
      }
    }

    if (!parsed || !parsed.groups || parsed.groups.length === 0) {
      logger.info('computeClusterHierarchy: no parent groups proposed');
      return { parents_created: 0, children_attached: 0 };
    }

    // Persist: each group gets a virtual parent cluster (member_count=0,
    // description=label). Children update their parent_cluster_id.
    const ts = nowIso();
    const maxRow = this.db
      .prepare('SELECT COALESCE(MAX(cluster_id), -1) AS m FROM clusters')
      .get() as { m: number };
    let nextCid = maxRow.m + 1;
    let parents = 0;
    let children = 0;
    const insertParent = this.db.prepare(
      `INSERT INTO clusters (cluster_id, created_at, member_count, status, description, parent_cluster_id, friction_count)
       VALUES (?, ?, 0, 'active', ?, NULL, 0)`,
    );
    const updateChild = this.db.prepare(
      'UPDATE clusters SET parent_cluster_id=? WHERE cluster_id=?',
    );
    const tx = this.db.transaction(() => {
      for (const g of parsed!.groups!) {
        const parentId = nextCid++;
        insertParent.run(parentId, ts, g.label);
        for (const cid of g.child_cluster_ids) {
          updateChild.run(parentId, cid);
          children++;
        }
        parents++;
      }
    });
    tx();

    if (this.oplog) {
      this.oplog.append({
        agent_run_id: 'system',
        agent_id: 'system:meta_cluster',
        op_type: 'extract',
        args: {
          kind: 'cluster_hierarchy',
          parents_created: parents,
          children_attached: children,
          groups: parsed.groups.map((g) => ({ label: g.label, children: g.child_cluster_ids })),
        },
        reason: `LLM meta-clustering: ${parents} parent groups, ${children} children`,
        affected_uuids: [],
      });
    }
    logger.info({ parents, children }, 'computeClusterHierarchy: done');
    return { parents_created: parents, children_attached: children };
  }

  /**
   * v1.3 LLM noise rescue: after fullRecluster judges some nodes as noise
   * (cluster_id=null), let the LLM look at each one's l1 against existing
   * clusters' representative l0s and decide which cluster best fits.
   *
   * Why this matters: HDBSCAN is a density algorithm. In a tight semantic
   * region (e.g. all docs in same project) it tags edge nodes as noise even
   * though they obviously belong somewhere. Cold start LLM only kicks in
   * when 0 clusters exist; this fills the gap *after* fullRecluster.
   *
   * Bounded budget: rescues at most maxBudget nodes per call to control LLM cost.
   */
  async rescueNoiseNodes(opts: { maxBudget?: number } = {}): Promise<{
    rescued: number;
    tried: number;
    declined: number;
  }> {
    if (!this.llm) return { rescued: 0, tried: 0, declined: 0 };
    const maxBudget = opts.maxBudget ?? 20;

    const noiseNodes = this.db
      .prepare(
        `SELECT uuid, l0_summary, l1_overview FROM nodes
         WHERE status='active' AND node_type='raw' AND cluster_id IS NULL
           AND l1_overview IS NOT NULL AND l1_overview != ''
         LIMIT ?`,
      )
      .all(maxBudget) as { uuid: string; l0_summary: string; l1_overview: string }[];
    if (noiseNodes.length === 0) return { rescued: 0, tried: 0, declined: 0 };

    const clusters = this.db
      .prepare(
        `SELECT cluster_id, description,
                (SELECT GROUP_CONCAT(l0_summary, ' | ') FROM nodes
                 WHERE cluster_id=clusters.cluster_id AND status='active'
                   AND node_type='raw' AND l0_summary != ''
                 ORDER BY is_cluster_hub DESC, hub_role_value='center' DESC
                 LIMIT 5) AS member_l0s
         FROM clusters WHERE status='active'`,
      )
      .all() as { cluster_id: number; description: string | null; member_l0s: string | null }[];
    if (clusters.length === 0) return { rescued: 0, tried: 0, declined: 0 };

    const clusterIdSet = new Set(clusters.map((c) => c.cluster_id));
    let rescued = 0;
    let declined = 0;

    for (const noise of noiseNodes) {
      const prompt = `下面是一个游离的知识节点(目前未归入任何簇),以及现有的几个簇。判断它最该归到哪个簇。

节点:
  L0: ${noise.l0_summary}
  L1: ${noise.l1_overview.slice(0, 600)}

可选簇:
${clusters.map((c) => `  簇 #${c.cluster_id} ${c.description ? `(${c.description})` : ''}\n     成员摘要: ${(c.member_l0s ?? '').slice(0, 300)}`).join('\n')}

判断规则:
- 如果节点跟某簇主题明确相关 → 输出该簇 cluster_id
- 倾向归类: 即使不是完美匹配,若主题相邻也归过去,不要轻易判 -1
- 仅在节点完全跨主题(领域明显不同)时输出 -1

只输出 JSON: {"cluster_id": <number>, "reason": "<简短理由>"}`;

      try {
        const completion = await this.llm.chat({
          messages: [
            { role: 'system', content: '你是图书管理员,只输出严格 JSON。' },
            { role: 'user', content: prompt },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.2,
        });
        const raw = completion.choices[0]?.message?.content ?? '{}';
        const parsed = JSON.parse(raw) as { cluster_id?: number; reason?: string };
        const cid = typeof parsed.cluster_id === 'number' ? parsed.cluster_id : -1;
        if (clusterIdSet.has(cid)) {
          this.storage.setClusterAssignment(noise.uuid, cid, 0.55);
          this.refreshClusterCentroid(cid);
          this.bumpClusterLastNewMember(cid);
          rescued++;
          if (this.oplog) {
            this.oplog.append({
              agent_run_id: 'system',
              agent_id: 'system:noise_rescue',
              op_type: 'extract',
              args: {
                kind: 'noise_rescue',
                uuid: noise.uuid,
                cluster_id: cid,
                reason: parsed.reason,
              },
              reason: `LLM rescued noise → cluster #${cid}: ${parsed.reason ?? '(no reason)'}`,
              affected_uuids: [noise.uuid],
            });
          }
        } else {
          declined++;
        }
      } catch (err) {
        logger.warn({ err, uuid: noise.uuid }, 'rescueNoiseNodes: LLM call failed');
      }
    }
    logger.info({ rescued, declined, tried: noiseNodes.length }, 'rescueNoiseNodes: done');
    return { rescued, tried: noiseNodes.length, declined };
  }

  /**
   * v1.3 frontend hierarchy support: within a cluster, every non-hub raw node
   * is attached to its nearest "anchor" — either a sub-hub (hub_role=center
   * but not the canonical cluster hub) or, if no sub-hub is closer, the cluster
   * hub itself. Returns leaf_uuid → anchor_uuid for ALL non-hub raw members.
   *
   * Anchors picked by cosine sim on e_l1. The hub_role tier (center/leaf/neutral)
   * is treated as already correct — sub-hubs ARE the LLM-judged centers, we don't
   * second-guess them. We only decide which leaf belongs under which center.
   */
  computeSubclusterAnchors(cluster_id: number): Map<string, string> {
    const members = this.db
      .prepare(
        `SELECT uuid, is_cluster_hub, hub_role_value, e_l1_id FROM nodes
         WHERE cluster_id=? AND status='active' AND node_type='raw' AND e_l1_id IS NOT NULL`,
      )
      .all(cluster_id) as {
      uuid: string;
      is_cluster_hub: number;
      hub_role_value: HubRoleValue | null;
      e_l1_id: number;
    }[];
    const clusterHub = members.find((m) => m.is_cluster_hub === 1);
    const subHubs = members.filter(
      (m) => m.is_cluster_hub === 0 && (m.hub_role_value === 'center' || m.hub_role_value === 'root'),
    );
    const result = new Map<string, string>();
    if (!clusterHub) return result;

    // No sub-hubs: every member just attaches to cluster hub directly.
    if (subHubs.length === 0) {
      for (const m of members) {
        if (m.is_cluster_hub === 1) continue;
        result.set(m.uuid, clusterHub.uuid);
      }
      return result;
    }

    // Sub-hubs themselves attach upward to cluster hub.
    for (const sh of subHubs) result.set(sh.uuid, clusterHub.uuid);

    // For each remaining leaf/neutral, pick the nearest anchor among
    // [sub-hubs, cluster-hub] by cosine similarity on e_l1.
    const candidates = [...subHubs, clusterHub];
    const candidateVecs = new Map<string, number[]>();
    for (const c of candidates) {
      const v = this.index.getVector('l1', c.e_l1_id);
      if (v) candidateVecs.set(c.uuid, v);
    }
    for (const m of members) {
      if (m.is_cluster_hub === 1) continue;
      if (m.hub_role_value === 'center' || m.hub_role_value === 'root') continue; // sub-hub or root anchor, already attached
      const v = this.index.getVector('l1', m.e_l1_id);
      if (!v) {
        result.set(m.uuid, clusterHub.uuid);
        continue;
      }
      let best = clusterHub.uuid;
      let bestSim = -1;
      for (const c of candidates) {
        const cv = candidateVecs.get(c.uuid);
        if (!cv) continue;
        const sim = cosineSim(v, cv);
        if (sim > bestSim) {
          bestSim = sim;
          best = c.uuid;
        }
      }
      result.set(m.uuid, best);
    }
    return result;
  }

  /**
   * v1.3 — persist pairwise cosine similarities within each cluster to
   * `similarity_edges`. Frontend uses these to drive edge length (sim → short)
   * and to decide whether a leaf attaches to its cluster_hub or jumps to root.
   *
   * Wipes the table on every call (monthly run is the single writer). Pairs
   * are written symmetrically so either-direction lookups are O(1).
   */
  persistClusterSimilarities(): { edges_written: number; clusters: number } {
    this.db.prepare("DELETE FROM similarity_edges").run();

    const clusterRows = this.db
      .prepare(
        `SELECT DISTINCT cluster_id FROM nodes
         WHERE cluster_id IS NOT NULL AND status='active' AND node_type='raw'`,
      )
      .all() as { cluster_id: number }[];

    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO similarity_edges
         (source_uuid, target_uuid, sim_score, computed_at)
       VALUES (?, ?, ?, ?)`,
    );
    const now = nowIso();
    let written = 0;

    const writeCluster = this.db.transaction((cid: number) => {
      const members = this.db
        .prepare(
          `SELECT uuid, e_l1_id FROM nodes
           WHERE cluster_id=? AND status='active' AND node_type='raw' AND e_l1_id IS NOT NULL`,
        )
        .all(cid) as { uuid: string; e_l1_id: number }[];
      const vecs: { uuid: string; v: number[] }[] = [];
      for (const m of members) {
        const v = this.index.getVector('l1', m.e_l1_id);
        if (v) vecs.push({ uuid: m.uuid, v });
      }
      for (let i = 0; i < vecs.length; i++) {
        const a = vecs[i]!;
        for (let j = i + 1; j < vecs.length; j++) {
          const b = vecs[j]!;
          const sim = cosineSim(a.v, b.v);
          insert.run(a.uuid, b.uuid, sim, now);
          insert.run(b.uuid, a.uuid, sim, now);
          written += 2;
        }
      }
    });

    for (const c of clusterRows) writeCluster(c.cluster_id);
    logger.info({ edges: written, clusters: clusterRows.length }, 'persistClusterSimilarities');
    return { edges_written: written, clusters: clusterRows.length };
  }

  /** Look up the most recent active cluster_review's hub_recommendation for a cluster. */
  private recommendedHubFromReview(cluster_id: number): string | null {
    const row = this.db
      .prepare(
        `SELECT uuid FROM nodes
         WHERE node_type='synthesis' AND synthesis_subtype='cluster_review'
           AND status='active' AND reviewed_cluster_id=?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(cluster_id) as { uuid: string } | undefined;
    if (!row) return null;
    try {
      const node = this.storage.readNode(row.uuid);
      const proposed = node?.review_payload?.hub_recommendation?.proposed_hub_uuid;
      if (typeof proposed === 'string' && proposed !== 'self') return proposed;
    } catch {
      // ignore
    }
    return null;
  }

  /**
   * v1.3 §6.4 + §5.4 — for each active synthesis, recompute its derived
   * cluster_id from the distribution of its sources across raw clusters.
   * Also enforces "all sources inactive ⇒ supersede synthesis" rule.
   * For cluster_review subtype, recompute validation_state.
   */
  recomputeSynthesisDerivedState(scopeUuid?: string): {
    synthesisUpdated: number;
    clusterReviewsRevalidated: number;
    superseded: number;
  } {
    // If scopeUuid given, only revisit synthesis nodes that reference this raw
    // (precision path called from archive/delete handlers). Otherwise full sweep
    // (called from monthly/on_review).
    const sql = scopeUuid
      ? `SELECT DISTINCT n.uuid, n.synthesis_subtype, n.reviewed_cluster_id
         FROM nodes n JOIN synthesis_sources ss ON ss.synthesis_uuid = n.uuid
         WHERE ss.source_uuid = ? AND n.status='active' AND n.node_type='synthesis'`
      : `SELECT uuid, synthesis_subtype, reviewed_cluster_id FROM nodes
         WHERE status='active' AND node_type='synthesis'`;
    const stmt = this.db.prepare(sql);
    const synthRows = (scopeUuid ? stmt.all(scopeUuid) : stmt.all()) as {
      uuid: string;
      synthesis_subtype: string | null;
      reviewed_cluster_id: number | null;
    }[];
    let synthesisUpdated = 0;
    let crRevalidated = 0;
    let superseded = 0;
    for (const s of synthRows) {
      // sources known to this synthesis (regardless of source-side status)
      const allSources = this.db
        .prepare('SELECT source_uuid FROM synthesis_sources WHERE synthesis_uuid=?')
        .all(s.uuid) as { source_uuid: string }[];
      // intersect with active raw nodes
      const activeRows = this.db
        .prepare(
          `SELECT n.uuid, n.cluster_id FROM synthesis_sources ss
             JOIN nodes n ON n.uuid = ss.source_uuid
             WHERE ss.synthesis_uuid=? AND n.status='active'`,
        )
        .all(s.uuid) as { uuid: string; cluster_id: number | null }[];
      const distribution = new Map<number, number>();
      let totalActive = 0;
      for (const r of activeRows) {
        if (r.cluster_id === null) continue;
        distribution.set(r.cluster_id, (distribution.get(r.cluster_id) ?? 0) + 1);
        totalActive++;
      }
      // Enforce: all sources gone ⇒ supersede synthesis (v1.3 §5.4).
      // "Gone" means either (a) source rows missing entirely (hard-deleted)
      // or (b) every active source is null-cluster but synthesis_sources points
      // only to inactive nodes. Both reduce to activeRows.length === 0.
      if (allSources.length > 0 && activeRows.length === 0) {
        this.storage.supersedeNode(s.uuid, 'all_sources_inactive');
        superseded++;
        continue;
      }
      let derivedCid: number | null = null;
      if (totalActive > 0) {
        const allInOne = distribution.size === 1;
        if (allInOne) {
          derivedCid = [...distribution.keys()][0]!;
        }
      }
      this.storage.setSynthesisDerivedCluster(s.uuid, derivedCid);
      synthesisUpdated++;

      if (s.synthesis_subtype === 'cluster_review' && s.reviewed_cluster_id !== null) {
        const inOriginal = distribution.get(s.reviewed_cluster_id) ?? 0;
        const primary_concentration = totalActive > 0 ? inOriginal / totalActive : 0;
        let validation_status: 'confirmed' | 'partially_drifted' | 'mostly_drifted';
        if (primary_concentration >= 0.8) validation_status = 'confirmed';
        else if (primary_concentration >= 0.5) validation_status = 'partially_drifted';
        else validation_status = 'mostly_drifted';
        const distRecord: Record<string, number> = {};
        for (const [k, v] of distribution) distRecord[String(k)] = v;
        this.storage.setValidationState(s.uuid, {
          last_validated_at: nowIso(),
          current_sources_distribution: distRecord,
          primary_concentration,
          validation_status,
        });
        crRevalidated++;
      }
    }
    // Dedup: per derived cluster, keep only the best active synthesis.
    // When fullRecluster merges old clusters into one, multiple syntheses from
    // different eras end up pointing at the same cluster. This pass picks the
    // winner and supersedes the rest so the UI never shows duplicate summaries.
    const dedupRows = this.db
      .prepare(
        `SELECT n.uuid, n.synthesis_subtype, n.created_at, n.cluster_id,
                (SELECT COUNT(*) FROM synthesis_sources WHERE synthesis_uuid=n.uuid) AS source_count
         FROM nodes n
         WHERE n.status='active' AND n.node_type='synthesis' AND n.cluster_id IS NOT NULL
         ORDER BY n.cluster_id, n.created_at DESC`,
      )
      .all() as { uuid: string; synthesis_subtype: string | null; created_at: string; cluster_id: number; source_count: number }[];
    const byCluster = new Map<number, typeof dedupRows>();
    for (const r of dedupRows) {
      const arr = byCluster.get(r.cluster_id) ?? [];
      arr.push(r);
      byCluster.set(r.cluster_id, arr);
    }
    for (const [, syntheses] of byCluster) {
      if (syntheses.length <= 1) continue;
      // Sort: cluster_review first, then most sources, then newest
      syntheses.sort((a, b) => {
        const aIsReview = a.synthesis_subtype === 'cluster_review' ? 1 : 0;
        const bIsReview = b.synthesis_subtype === 'cluster_review' ? 1 : 0;
        if (aIsReview !== bIsReview) return bIsReview - aIsReview;
        if (a.source_count !== b.source_count) return b.source_count - a.source_count;
        return b.created_at.localeCompare(a.created_at);
      });
      const keep = syntheses[0]!;
      for (let i = 1; i < syntheses.length; i++) {
        const r = syntheses[i]!;
        this.storage.supersedeNode(r.uuid, `dedup: cluster ${keep.cluster_id} kept ${keep.uuid}`);
        superseded++;
      }
    }
    return { synthesisUpdated, clusterReviewsRevalidated: crRevalidated, superseded };
  }

  computeCohesion(cluster_id: number): number {
    const members = this.db
      .prepare(
        "SELECT uuid FROM nodes WHERE cluster_id=? AND status='active' AND node_type='raw'",
      )
      .all(cluster_id) as { uuid: string }[];
    const N = members.length;
    if (N < 2) return 0;
    const uuidSet = new Set(members.map((m) => m.uuid));
    const placeholders = members.map(() => '?').join(',');
    const edgeRows = this.db
      .prepare(
        `SELECT source_uuid, target_uuid FROM wikilinks
         WHERE source_uuid IN (${placeholders}) AND target_uuid IN (${placeholders})`,
      )
      .all(...members.map((m) => m.uuid), ...members.map((m) => m.uuid)) as {
      source_uuid: string;
      target_uuid: string;
    }[];
    let actual = 0;
    const seen = new Set<string>();
    for (const e of edgeRows) {
      if (!uuidSet.has(e.source_uuid) || !uuidSet.has(e.target_uuid)) continue;
      const key = e.source_uuid < e.target_uuid ? `${e.source_uuid}|${e.target_uuid}` : `${e.target_uuid}|${e.source_uuid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      actual++;
    }
    const possible = (N * (N - 1)) / 2;
    return possible === 0 ? 0 : actual / possible;
  }

  /**
   * v1.3 §6.6 — snapshot each active cluster's centroid + covariance trace
   * for drift detection. Stored in cluster_snapshots.
   */
  /**
   * Compute a quality/stability signal for a single active cluster.
   * Read-only — does not mutate any state.
   */
  computeClusterQuality(cluster_id: number): ClusterQualitySignal {
    const members = this.db
      .prepare(
        "SELECT uuid, hub_role_value, e_l1_id FROM nodes WHERE cluster_id=? AND status='active' AND node_type='raw' AND e_l1_id IS NOT NULL",
      )
      .all(cluster_id) as { uuid: string; hub_role_value: string | null; e_l1_id: number }[];

    const member_count = members.length;

    // cohesion: average cosine similarity from each member to the centroid
    let cohesion = 0;
    if (member_count > 0) {
      const centroidRow = this.db
        .prepare('SELECT centroid_e_l1 FROM clusters WHERE cluster_id=?')
        .get(cluster_id) as { centroid_e_l1: Buffer | null } | undefined;
      if (centroidRow?.centroid_e_l1) {
        const centroid = new Float32Array(
          centroidRow.centroid_e_l1.buffer,
          centroidRow.centroid_e_l1.byteOffset,
          centroidRow.centroid_e_l1.byteLength / 4,
        );
        let simSum = 0;
        for (const m of members) {
          const v = this.index.getVector('l1', m.e_l1_id);
          if (v) simSum += cosineSim(v, centroid);
        }
        cohesion = simSum / member_count;
      }
    }

    // center_density: fraction of members with hub_role = 'center'
    let centerDensity = 0;
    if (member_count > 0) {
      const centerCount = members.filter((m) => m.hub_role_value === 'center').length;
      centerDensity = centerCount / member_count;
    }

    // drift_score: relative change in covariance_trace from last two snapshots
    let driftScore = 0;
    const snaps = this.db
      .prepare(
        'SELECT covariance_trace FROM cluster_snapshots WHERE cluster_id=? ORDER BY taken_at DESC LIMIT 2',
      )
      .all(cluster_id) as { covariance_trace: number | null }[];
    if (snaps.length === 2 && snaps[0]?.covariance_trace != null && snaps[1]?.covariance_trace != null) {
      const t0 = snaps[0]!.covariance_trace!;
      const t1 = snaps[1]!.covariance_trace!;
      if (t1 > 0) driftScore = Math.abs(t0 - t1) / t1;
    }

    // friction_score
    const fRow = this.db
      .prepare('SELECT friction_count FROM clusters WHERE cluster_id=?')
      .get(cluster_id) as { friction_count: number } | undefined;
    const frictionScore = fRow?.friction_count ?? 0;

    // noise_pressure: unclustered active raw nodes within cosine ≥ 0.55 of centroid
    let noisePressure = 0;
    const centroidRow = this.db
      .prepare('SELECT centroid_e_l1 FROM clusters WHERE cluster_id=?')
      .get(cluster_id) as { centroid_e_l1: Buffer | null } | undefined;
    if (centroidRow?.centroid_e_l1) {
      const centroid = new Float32Array(
        centroidRow.centroid_e_l1.buffer,
        centroidRow.centroid_e_l1.byteOffset,
        centroidRow.centroid_e_l1.byteLength / 4,
      );
      const noiseRows = this.db
        .prepare(
          "SELECT e_l1_id FROM nodes WHERE cluster_id IS NULL AND status='active' AND node_type='raw' AND e_l1_id IS NOT NULL",
        )
        .all() as { e_l1_id: number }[];
      for (const n of noiseRows) {
        const v = this.index.getVector('l1', n.e_l1_id);
        if (v && cosineSim(v, centroid) >= 0.55) noisePressure++;
      }
    }

    // last_review_status
    const reviewRow = this.db
      .prepare(
        `SELECT n.uuid FROM nodes n
         WHERE n.node_type='synthesis' AND n.synthesis_subtype='cluster_review'
           AND n.status='active' AND n.reviewed_cluster_id=?
         ORDER BY n.created_at DESC LIMIT 1`,
      )
      .get(cluster_id) as { uuid: string } | undefined;
    let lastReviewStatus: string | null = null;
    if (reviewRow) {
      try {
        const reviewNode = this.storage.readNode(reviewRow.uuid);
        lastReviewStatus = reviewNode?.validation_state?.validation_status ?? null;
      } catch {
        // ignore
      }
    }

    // status determination
    const reasons: string[] = [];
    let status: ClusterStatus = 'healthy';

    if (member_count >= 6 && centerDensity > 0.6) {
      status = 'overbroad';
      reasons.push(`center_density=${centerDensity.toFixed(2)} exceeds 0.6 — may mix multiple working sets`);
    } else if (member_count >= 6 && centerDensity < 0.08) {
      status = 'underanchored';
      reasons.push(`center_density=${centerDensity.toFixed(2)} below 0.08 with ${member_count} members`);
    }

    if (driftScore > 0.3) {
      if (status === 'healthy') status = 'drifting';
      reasons.push(`drift_score=${driftScore.toFixed(2)} exceeds 0.3`);
    }

    if (frictionScore > 0) {
      if (status === 'healthy') status = 'needs_review';
      reasons.push(`friction_count=${frictionScore}`);
    }

    // stale check: last_new_member_at older than 30 days AND no review in last 60 days
    const staleRow = this.db
      .prepare(
        `SELECT last_new_member_at, last_review_at FROM clusters WHERE cluster_id=?`,
      )
      .get(cluster_id) as { last_new_member_at: string | null; last_review_at: string | null } | undefined;
    if (staleRow) {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
      const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 3600_000).toISOString();
      const noNew = !staleRow.last_new_member_at || staleRow.last_new_member_at < thirtyDaysAgo;
      const noReview = !staleRow.last_review_at || staleRow.last_review_at < sixtyDaysAgo;
      if (noNew && noReview) {
        if (status === 'healthy') status = 'stale';
        reasons.push('no new members in 30d and no review in 60d');
      }
    }

    return {
      cluster_id,
      member_count,
      cohesion,
      center_density: centerDensity,
      drift_score: driftScore,
      friction_score: frictionScore,
      noise_pressure: noisePressure,
      last_review_status: lastReviewStatus,
      status,
      reasons,
    };
  }

  snapshotClusters(): void {
    const clusters = this.db
      .prepare("SELECT cluster_id FROM clusters WHERE status='active'")
      .all() as { cluster_id: number }[];
    const ts = nowIso();
    const insert = this.db.prepare(
      `INSERT INTO cluster_snapshots (taken_at, cluster_id, centroid_e_l1, member_count, member_uuids, covariance_trace)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const c of clusters) {
      const members = this.db
        .prepare(
          "SELECT uuid, e_l1_id FROM nodes WHERE cluster_id=? AND status='active' AND node_type='raw' AND e_l1_id IS NOT NULL",
        )
        .all(c.cluster_id) as { uuid: string; e_l1_id: number }[];
      if (members.length === 0) continue;
      const dim = this.index.embeddingDim;
      const vectors: number[][] = [];
      for (const m of members) {
        const v = this.index.getVector('l1', m.e_l1_id);
        if (v) vectors.push(v);
      }
      if (vectors.length === 0) continue;
      const centroid = new Float32Array(dim);
      for (const v of vectors) {
        for (let i = 0; i < dim; i++) centroid[i] = (centroid[i] ?? 0) + (v[i] ?? 0);
      }
      for (let i = 0; i < dim; i++) centroid[i] = (centroid[i] ?? 0) / vectors.length;
      // covariance trace = sum of per-dim variances
      let trace = 0;
      for (let i = 0; i < dim; i++) {
        let s = 0;
        for (const v of vectors) {
          const d = (v[i] ?? 0) - (centroid[i] ?? 0);
          s += d * d;
        }
        trace += s / vectors.length;
      }
      const buf = Buffer.from(centroid.buffer, centroid.byteOffset, centroid.byteLength);
      insert.run(
        ts,
        c.cluster_id,
        buf,
        members.length,
        JSON.stringify(members.map((m) => m.uuid)),
        trace,
      );
    }
  }
}
