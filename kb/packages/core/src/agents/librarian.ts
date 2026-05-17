import type { LLMClient } from '../llm/client.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { DB } from '../storage/db.js';
import type { NodeStorage } from '../storage/storage.js';
import type { OpLogService } from '../op_log/op_log.js';
import type { SynthesisService } from '../synthesis/synthesis.js';
import type { ClusteringService } from '../clustering/clustering.js';
import type { IndexService } from '../indexing/index_service.js';
import type { FlagQueueService } from '../flag/flag_queue.js';
import type {
  AgentRunType,
  HubRoleValue,
  PermissionTag,
  SynthesisCandidate,
  ToolContext,
  ClusterQualitySignal,
} from '@kb/shared';
import { newUuid } from '../util/uuid.js';
import { logger } from '../util/logger.js';
import { daysAgo, nowIso } from '../util/now.js';
import { buildOnIngestAnalysisPrompt, type OnIngestAnalysis } from '../synthesis/prompts.js';
import { autoConsumeSimpleFlag } from '../hermes/rules.js';

const LIBRARIAN_PERMS: PermissionTag[] = ['read', 'write', 'structural', 'admin'];

export interface LibrarianDeps {
  llm: LLMClient;
  tools: ToolRegistry;
  db: DB;
  storage: NodeStorage;
  oplog: OpLogService;
  synthesis: SynthesisService;
  clustering: ClusteringService;
  index: IndexService;
  flagQueue: FlagQueueService;
}

export class LibrarianAgent {
  constructor(private deps: LibrarianDeps) {}

  private isProblemStatement(l0: string, body: string): boolean {
    const text = `${l0} ${(body ?? '').slice(0, 3000)}`.toLowerCase();
    const hints = [
      '任务描述', '任务要求', '评测标准', '数据集格式',
      'task description', 'problem statement', 'overview', '概述',
      'specification', 'requirements', '项目说明', '背景',
    ];
    const score = hints.filter((h) => text.includes(h)).length;
    return score >= 2 || /problem statement|overview|概述|spec/i.test(l0);
  }

  private startRun(run_type: AgentRunType): { run_id: string; ctx: ToolContext } {
    const run_id = newUuid();
    this.deps.db
      .prepare(
        `INSERT INTO agent_runs (run_id, agent_id, run_type, started_at, status)
         VALUES (?, 'librarian', ?, ?, 'running')`,
      )
      .run(run_id, run_type, nowIso());
    return {
      run_id,
      ctx: { agent_id: 'librarian', agent_run_id: run_id, permissions: LIBRARIAN_PERMS },
    };
  }

  private finishRun(run_id: string, status: 'completed' | 'failed', summary?: string) {
    this.deps.db
      .prepare('UPDATE agent_runs SET status=?, finished_at=?, summary=? WHERE run_id=?')
      .run(status, nowIso(), summary ?? null, run_id);
  }

  // ========== v2.0 Hermes O-D-P-A-V Main Loop ==========

  async runHermesCycle(opts: { full?: boolean } = {}): Promise<HermesCycleResult> {
    const { run_id, ctx } = this.startRun('consultant');
    const start = Date.now();
    const observations = this.observe();
    const diagnoses = this.diagnose(observations);
    const plan = this.planFromDiagnoses(diagnoses, observations);
    const actions = this.actPlan(plan, ctx);
    const verification = opts.full !== false ? this.verify(actions, observations) : null;
    this.updateHeartbeat(observations, diagnoses, plan, actions, verification);
    this.finishRun(run_id, 'completed', `hermes ${opts.full !== false ? 'full' : 'fast'} cycle in ${Date.now() - start}ms`);
    return { observations, diagnoses, plan, actions, verification };
  }

  private observe(): HermesObservation {
    const counts = this.deps.storage.countByStatus();
    const clusterCount = this.deps.storage.countActiveClusters();
    const frictionClusters = this.deps.storage.listFrictionClusters();
    const queueDepth = this.deps.storage.countPendingOptimizationItems();
    const flagCounts = this.deps.flagQueue.countByStatus();
    const recentFlags = this.deps.flagQueue.list({ status: 'pending', limit: 10 });
    const expiredTraceCount = this.deps.storage.listTraces({ expired: true, limit: 100 }).length;
    const heartbeat = this.deps.storage.readHeartbeat();
    const clusterQualitySignals: ClusterQualitySignal[] = [];
    for (const c of (this.deps.db.prepare("SELECT cluster_id FROM clusters WHERE status='active'").all() as { cluster_id: number }[])) {
      try { clusterQualitySignals.push(this.deps.clustering.computeClusterQuality(c.cluster_id)); } catch { /* non-fatal */ }
    }
    const recentOps = (this.deps.db.prepare('SELECT op_id, op_type, reason, timestamp FROM op_log ORDER BY timestamp DESC LIMIT 20').all() as { op_id: string; op_type: string; reason: string; timestamp: string }[]);
    return { counts, cluster_count: clusterCount, friction_clusters: frictionClusters, optimization_queue_depth: queueDepth, flag_counts: flagCounts, recent_flags: recentFlags, expired_trace_count: expiredTraceCount, cluster_quality_signals: clusterQualitySignals, recent_ops: recentOps, heartbeat_content: heartbeat, timestamp: nowIso() };
  }

  private diagnose(obs: HermesObservation): HermesDiagnosis[] {
    const diagnoses: HermesDiagnosis[] = [];
    for (const cid of obs.friction_clusters) {
      const q = obs.cluster_quality_signals.find((s) => s.cluster_id === cid);
      diagnoses.push({ id: `friction_${cid}`, type: 'cluster_quality', priority: 'high', target_cluster_id: cid, evidence: `friction累积，质量=${q?.status ?? '?'}`, recommended_action_class: 'L2', reasoning: `簇${cid}有摩擦，需LLM生成cluster_review` });
    }
    for (const q of obs.cluster_quality_signals) {
      if (q.status === 'drifting' || q.status === 'stale' || q.status === 'needs_review') {
        diagnoses.push({ id: `quality_${q.cluster_id}`, type: 'cluster_quality', priority: q.status === 'drifting' ? 'high' : 'medium', target_cluster_id: q.cluster_id, evidence: `status=${q.status}, reasons=[${q.reasons.join(',')}]`, recommended_action_class: 'L2', reasoning: `簇${q.cluster_id}质量${q.status}，需cluster_review` });
      }
    }
    const pendingTotal = Object.values(obs.flag_counts).reduce((a, b) => a + b, 0);
    if (pendingTotal > 10) diagnoses.push({ id: 'flag_backlog', type: 'workflow_feedback', priority: 'medium', evidence: `${pendingTotal} flags pending`, recommended_action_class: 'L1', reasoning: 'flag积压，runBackgroundPass可消费' });
    if (obs.optimization_queue_depth > 5) diagnoses.push({ id: 'optq_backlog', type: 'workflow_feedback', priority: 'low', evidence: `${obs.optimization_queue_depth} items queued`, recommended_action_class: 'L3', reasoning: 'L3级别，需外部agent处理' });
    if (obs.expired_trace_count > 50) diagnoses.push({ id: 'trace_gc', type: 'content_quality', priority: 'low', evidence: `${obs.expired_trace_count} expired traces`, recommended_action_class: 'L1', reasoning: 'TTL过期trace可直接删除' });
    return diagnoses;
  }

  private planFromDiagnoses(diagnoses: HermesDiagnosis[], _obs: HermesObservation): HermesActionPlan {
    const scheduled: PlannedAction[] = [];
    const queued: PlannedAction[] = [];
    for (const d of diagnoses) {
      if (d.recommended_action_class === 'L1') {
        scheduled.push({ diagnosis_id: d.id, risk_level: 'L1', action_type: d.id === 'trace_gc' ? 'deleteExpiredTraces' : 'autoConsumeSimpleFlag', target_uuid: d.target_uuid, target_cluster_id: d.target_cluster_id, reasoning: `[L1] ${d.reasoning}` });
      } else if (d.recommended_action_class === 'L2') {
        scheduled.push({ diagnosis_id: d.id, risk_level: 'L2', action_type: 'triggerOnReview', target_cluster_id: d.target_cluster_id, reasoning: `[L2] ${d.reasoning}` });
      } else {
        queued.push({ diagnosis_id: d.id, risk_level: 'L3', action_type: 'writeQueue', target_uuid: d.target_uuid, target_cluster_id: d.target_cluster_id, reasoning: `[L3] ${d.reasoning}` });
      }
    }
    return { scheduled, queued, skipped: [], total: diagnoses.length };
  }

  private actPlan(plan: HermesActionPlan, ctx: ToolContext): HermesActionResult[] {
    const results: HermesActionResult[] = [];
    const run_id = ctx.agent_run_id;
    for (const a of plan.scheduled) {
      try {
        if (a.action_type === 'deleteExpiredTraces') {
          const r = this.deps.storage.deleteExpiredTraces();
          results.push({ diagnosis_id: a.diagnosis_id, action_type: 'deleteExpiredTraces', risk_level: 'L1', ok: true, details: `deleted ${r.changes}` });
        } else if (a.action_type === 'autoConsumeSimpleFlag') {
          const r = autoConsumeSimpleFlag(this.deps.storage, this.deps.flagQueue, this.deps.oplog, run_id, 'hermes');
          results.push({ diagnosis_id: a.diagnosis_id, action_type: 'autoConsumeSimpleFlag', risk_level: 'L1', ok: true, details: `consumed ${r.length} flags` });
        } else if (a.action_type === 'triggerOnReview') {
          results.push({ diagnosis_id: a.diagnosis_id, action_type: 'triggerOnReview', risk_level: 'L2', ok: true, details: `cluster ${a.target_cluster_id} → on_review` });
        }
      } catch (err) {
        results.push({ diagnosis_id: a.diagnosis_id, action_type: a.action_type, risk_level: a.risk_level, ok: false, details: String(err) });
      }
    }
    for (const a of plan.queued) {
      try {
        const item_id = newUuid();
        this.deps.storage.insertOptimizationItem({ item_id, problem_type: a.diagnosis_id, target_uuid: a.target_uuid, target_cluster_id: a.target_cluster_id, evidence: a.reasoning, proposed_action: a.action_type, risk_level: 'L3', created_by: 'hermes' });
        results.push({ diagnosis_id: a.diagnosis_id, action_type: 'writeQueue', risk_level: 'L3', ok: true, details: `queued ${item_id}` });
      } catch (err) {
        results.push({ diagnosis_id: a.diagnosis_id, action_type: 'writeQueue', risk_level: 'L3', ok: false, details: String(err) });
      }
    }
    return results;
  }

  private verify(actions: HermesActionResult[], _prev: HermesObservation): HermesVerification {
    const notes: string[] = [];
    if (actions.some((a) => a.action_type === 'deleteExpiredTraces')) {
      notes.push(`expired traces remaining: ${this.deps.storage.listTraces({ expired: true, limit: 1 }).length}`);
    }
    return { verdict: actions.every((a) => a.ok) ? 'accepted' : 'partial', action_count: actions.length, ok_count: actions.filter((a) => a.ok).length, notes, timestamp: nowIso() };
  }

  private updateHeartbeat(obs: HermesObservation, diagnoses: HermesDiagnosis[], plan: HermesActionPlan, actions: HermesActionResult[], _verification: HermesVerification | null) {
    const frictionList = obs.friction_clusters.join(', ');
    const lines = [
      '# Hermes Heartbeat',
      `last_updated: ${nowIso()}`,
      '',
      '## Current KB State',
      `- active raw: ${obs.counts.raw}  synthesis: ${obs.counts.synthesis}  reflection: ${obs.counts.reflection}`,
      `- clusters: ${obs.cluster_count}（active）`,
      `- friction clusters: [${frictionList || 'none'}]`,
      `- optimization_queue depth: ${obs.optimization_queue_depth}`,
      '',
      '## Open Loops',
      ...diagnoses.map((d) => `- ${d.id} (${d.priority}, ${d.recommended_action_class}): ${d.reasoning}`),
      '',
      '## Learned Heuristics',
      '- "high friction clusters": trigger on_review within same cycle',
      '- "stale synthesis": L1 auto-archive when ref_count=0 for 60+ days',
      '',
      '## Scheduled',
      '- next weekly: (managed by scheduler)',
      '',
      '## Action Log (this cycle)',
      ...actions.map((a) => `- ${a.action_type} [${a.risk_level}]: ${a.ok ? 'ok' : 'FAIL'}: ${a.details}`),
      '',
      '## Hermes Policy',
      '- auto_archive_threshold: 60d',
      '- dedup_similarity_threshold: 0.08',
    ];
    this.deps.storage.updateHeartbeat(lines.join('\n'));
  }

  // ========== v1.3 原有的 Librarian 接口 ==========

  async runOnIngest(uuid: string): Promise<{ synthesis_uuid: string | null; hub_role: HubRoleValue }> {
    const { run_id, ctx } = this.startRun('on_ingest');
    try {
      const node = this.deps.storage.readNode(uuid);
      if (!node || node.node_type !== 'raw') {
        this.finishRun(run_id, 'completed', 'skip: not raw');
        return { synthesis_uuid: null, hub_role: 'neutral' };
      }
      const ptr = this.deps.storage.getEmbeddingPointers(uuid);
      const neighbors: { uuid: string; l1: string }[] = [];
      if (ptr?.e_l1_id !== null && ptr?.e_l1_id !== undefined) {
        const vec = this.deps.index.getVector('l1', ptr.e_l1_id);
        if (vec) {
          const k = this.getParams().on_ingest_neighbors_k;
          const hits = this.deps.index.searchKNN('l1', vec, k + 1);
          const others = hits.filter((h) => h.id !== ptr.e_l1_id).slice(0, k);
          if (others.length > 0) {
            const placeholders = others.map(() => '?').join(',');
            const rows = this.deps.db
              .prepare(`SELECT uuid, l1_overview FROM nodes WHERE e_l1_id IN (${placeholders}) AND node_type='raw' AND status='active'`)
              .all(...others.map((o) => o.id)) as { uuid: string; l1_overview: string }[];
            for (const r of rows) { if (r.uuid !== uuid) neighbors.push({ uuid: r.uuid, l1: r.l1_overview }); }
          }
        }
      }
      const isRootCandidate = this.isProblemStatement(node.l0_summary, node.body);
      const analysis = await this.askForIngestAnalysis(node.l0_summary, node.l1_overview, node.body, neighbors);
      if (!analysis) {
        this.finishRun(run_id, 'failed', 'llm unavailable or output invalid');
        return { synthesis_uuid: null, hub_role: 'neutral' };
      }
      const currentHub = node.hub_role?.value ?? 'neutral';
      const nextHub: HubRoleValue = isRootCandidate ? 'root' : analysis.hub_role_judgment.value;
      const hubReason = isRootCandidate ? `problem statement/root anchor detected: ${analysis.hub_role_judgment.reason}` : analysis.hub_role_judgment.reason;
      const preserveExisting = (nextHub === 'neutral' && (currentHub === 'center' || currentHub === 'root')) || (nextHub === 'center' && currentHub === 'root');
      if (preserveExisting) {
        logger.info({ uuid, currentHub, nextHub }, 'on_ingest: preserving stronger existing hub role');
      } else if (nextHub !== currentHub) {
        const op = this.deps.oplog.append({ agent_run_id: ctx.agent_run_id, agent_id: ctx.agent_id, op_type: 'set_hub_role', args: { uuid, from_value: currentHub, to_value: nextHub }, reason: hubReason, affected_uuids: [uuid] });
        this.deps.storage.setHubRole(uuid, nextHub, isRootCandidate ? 'root_promoted' : 'auto_detected', hubReason, op.op_id, 'agent:librarian');
        if (nextHub === 'root') this.deps.clustering.recomputeHubs();
      }
      // Duplicate detection
      try {
        if (ptr?.e_l1_id != null) {
          const vec = this.deps.index.getVector('l1', ptr.e_l1_id);
          if (vec) {
            const topHits = this.deps.index.searchKNN('l1', vec, 5);
            const others = topHits.filter((h) => h.id !== ptr.e_l1_id).slice(0, 3);
            for (const hit of others) {
              if (hit.distance <= 0.08) {
                const cosSim = 1 - hit.distance;
                const existingUuid = (this.deps.db.prepare('SELECT uuid FROM nodes WHERE e_l1_id=? AND status=?').get(hit.id, 'active') as { uuid: string } | undefined)?.uuid;
                if (existingUuid) {
                  this.deps.flagQueue.append({ flag_type: 'specific_issue', target_uuid: uuid, description: `potential_duplicate: 与 ${existingUuid} 的 L1 余弦相似度=${cosSim.toFixed(3)}`, flagged_by: 'agent:librarian' });
                }
              }
            }
          }
        }
      } catch (err) { logger.warn({ err, uuid }, 'on_ingest: duplicate detection failed'); }
      if (!analysis.should_synthesize) {
        this.finishRun(run_id, 'completed', `hub_role=${analysis.hub_role_judgment.value} (no synthesis)`);
        return { synthesis_uuid: null, hub_role: analysis.hub_role_judgment.value };
      }
      const relatedUuids = analysis.relations_to_neighbors.filter((r) => r.relation !== 'unrelated').map((r) => r.neighbor_uuid).slice(0, 3);
      if (relatedUuids.length === 0) {
        this.finishRun(run_id, 'completed', 'no related neighbors found');
        return { synthesis_uuid: null, hub_role: analysis.hub_role_judgment.value };
      }
      const candidate: SynthesisCandidate = { source_uuids: [uuid, ...relatedUuids], cluster_id: node.derived_state?.cluster_id ?? null, subtype: 'consolidation', trigger: { type: 'on_ingest', evidence: { new_uuid: uuid, related_count: relatedUuids.length, reasoning: analysis.synthesis_reasoning } } };
      const result = await this.deps.synthesis.generateConsolidation(candidate, ctx);
      if ('rejected' in result && result.rejected) {
        this.finishRun(run_id, 'completed', `consolidation rejected: ${result.reason}`);
        return { synthesis_uuid: null, hub_role: analysis.hub_role_judgment.value };
      }
      this.finishRun(run_id, 'completed', `+1 consolidation, hub_role=${analysis.hub_role_judgment.value}`);
      return { synthesis_uuid: 'node' in result ? result.node.uuid : null, hub_role: analysis.hub_role_judgment.value };
    } catch (err) {
      logger.error({ err, uuid }, 'on_ingest failed');
      this.finishRun(run_id, 'failed', (err as Error).message);
      return { synthesis_uuid: null, hub_role: 'neutral' };
    }
  }

  async runOnReview(): Promise<{ generated: number; rejected: number }> {
    const { run_id, ctx } = this.startRun('on_review');
    try {
      const params = this.getParams();
      try {
        const cold = await this.deps.clustering.coldStartCluster();
        if (cold && cold.formed > 0) { this.deps.clustering.recomputeHubs(); this.deps.clustering.recomputeSynthesisDerivedState(); logger.info({ formed: cold.formed }, 'on_review: cold start seeded clusters'); }
      } catch (err) { logger.warn({ err }, 'on_review: cold start failed'); }
      const cluster_ids = this.selectClustersForReview(params.review_min_weeks_since_last, params.review_max_clusters_per_week);
      let generated = 0, rejected = 0;
      for (const cid of cluster_ids) {
        const prev = this.deps.db.prepare("SELECT uuid FROM nodes WHERE node_type='synthesis' AND synthesis_subtype='cluster_review' AND status='active' AND reviewed_cluster_id=? ORDER BY created_at DESC LIMIT 1").get(cid) as { uuid: string } | undefined;
        if (prev) this.deps.storage.supersedeNode(prev.uuid, 'on_review_regen');
        const r = await this.deps.synthesis.generateClusterReview(cid, ctx, { previous_uuid: prev?.uuid ?? null, inheritance_hint: prev ? 'modified' : undefined });
        if (r.rejected) rejected++; else generated++;
      }
      this.deps.clustering.snapshotClusters();
      try { const rescued = await this.deps.clustering.rescueNoiseNodes(); if (rescued.rescued > 0) logger.info({ ...rescued }, 'on_review: rescued noise nodes'); } catch (err) { logger.warn({ err }, 'on_review: noise rescue failed'); }
      this.deps.clustering.recomputeHubs();
      this.deps.clustering.recomputeSynthesisDerivedState();
      try { const sub = await this.consumeSubThemeRecommendations(cluster_ids, ctx); if (sub.auto > 0 || sub.flagged > 0) logger.info({ ...sub }, 'on_review: sub_theme consumed'); } catch (err) { logger.warn({ err }, 'on_review: sub_theme failed'); }
      const overpopulated = (this.deps.db.prepare(`SELECT cluster_id, center_count, member_count FROM (SELECT n.cluster_id AS cluster_id, SUM(CASE WHEN n.hub_role_value='center' THEN 1 ELSE 0 END) AS center_count, COUNT(*) AS member_count FROM nodes n WHERE n.status='active' AND n.node_type='raw' AND n.cluster_id IS NOT NULL GROUP BY n.cluster_id) WHERE center_count >= 4 AND center_count * 5 > member_count * 3`).all() as { cluster_id: number; center_count: number; member_count: number }[]);
      for (const o of overpopulated) {
        const existing = this.deps.flagQueue.list({ status: 'pending', flag_type: 'cluster_friction', cluster_id: o.cluster_id });
        if (!existing.some((f) => (f.description || '').includes('multi-center split'))) {
          this.deps.flagQueue.append({ flag_type: 'cluster_friction', target_cluster_id: o.cluster_id, description: `multi-center split candidate: ${o.center_count}/${o.member_count} centers — may mix working sets`, flagged_by: 'agent:librarian' });
        }
      }
      try {
        for (const c of (this.deps.db.prepare("SELECT cluster_id FROM clusters WHERE status='active'").all() as { cluster_id: number }[])) {
          const q = this.deps.clustering.computeClusterQuality(c.cluster_id);
          logger.info({ quality: q }, `cluster #${c.cluster_id} quality: ${q.status}`);
        }
      } catch (err) { logger.warn({ err }, 'on_review: cluster quality scan failed'); }
      this.finishRun(run_id, 'completed', `reviewed ${cluster_ids.length}, +${generated}/${rejected}`);
      return { generated, rejected };
    } catch (err) {
      logger.error({ err }, 'on_review failed');
      this.finishRun(run_id, 'failed', (err as Error).message);
      return { generated: 0, rejected: 0 };
    }
  }

  async runMonthly(): Promise<void> {
    const { run_id } = this.startRun('monthly_recluster');
    try {
      const r = await this.deps.clustering.fullRecluster();
      this.deps.clustering.snapshotClusters();
      let rescued = { rescued: 0, tried: 0, declined: 0 };
      try { rescued = await this.deps.clustering.rescueNoiseNodes(); if (rescued.rescued > 0) logger.info({ ...rescued }, 'monthly: rescued noise nodes'); } catch (err) { logger.warn({ err }, 'monthly: noise rescue failed'); }
      this.deps.clustering.recomputeHubs();
      this.deps.clustering.recomputeSynthesisDerivedState();
      // v2.3: auto-split oversized clusters (>60 members)
      try {
        const splits = await this.deps.clustering.splitOversizedClusters(60);
        if (splits.length > 0) {
          this.deps.clustering.recomputeHubs();
          this.deps.clustering.recomputeSynthesisDerivedState();
          logger.info({ splits: splits.map((s) => `${s.cluster_id}→${s.sub_clusters} sub (${s.moved} moved)`) },
            'monthly: auto-split oversized clusters');
        }
      } catch (err) { logger.warn({ err }, 'monthly: splitOversized failed'); }
      try { const sim = this.deps.clustering.persistClusterSimilarities(); logger.info({ ...sim }, 'monthly: similarity edges persisted'); } catch (err) { logger.warn({ err }, 'monthly: persistClusterSimilarities failed'); }
      let hierarchy = { parents_created: 0, children_attached: 0 };
      try { hierarchy = await this.deps.clustering.computeClusterHierarchy(); } catch (err) { logger.warn({ err }, 'monthly: meta-clustering failed'); }
      // Auto-fill cluster descriptions for clusters without one
      try {
        const noDesc = this.deps.db.prepare(
          "SELECT cluster_id FROM clusters WHERE status='active' AND (description IS NULL OR description='')"
        ).all() as { cluster_id: number }[];
        for (const c of noDesc) {
          const members = this.deps.db.prepare(
            "SELECT l0_summary FROM nodes WHERE cluster_id=? AND status='active' AND node_type='raw' LIMIT 5"
          ).all(c.cluster_id) as { l0_summary: string }[];
          if (members.length > 0) {
            const desc = members.map((m) => m.l0_summary.slice(0, 40)).join(' | ');
            this.deps.db.prepare('UPDATE clusters SET description=? WHERE cluster_id=?').run(desc.slice(0, 200), c.cluster_id);
          }
        }
        if (noDesc.length > 0) logger.info({ count: noDesc.length }, 'monthly: auto-filled cluster descriptions');
      } catch (err) { logger.warn({ err }, 'monthly: auto-desc failed'); }
      const cutoff = daysAgo(60);
      const stale = this.deps.db.prepare("SELECT uuid FROM nodes WHERE node_type='synthesis' AND status='active' AND reference_count = 0 AND created_at <= ?").all(cutoff) as { uuid: string }[];
      for (const s of stale) this.deps.storage.archiveNode(s.uuid, 'unused for 60 days');
      try {
        for (const c of (this.deps.db.prepare("SELECT cluster_id FROM clusters WHERE status='active'").all() as { cluster_id: number }[])) {
          const q = this.deps.clustering.computeClusterQuality(c.cluster_id);
          logger.info({ quality: q }, `cluster #${c.cluster_id} quality: ${q.status}`);
        }
      } catch (err) { logger.warn({ err }, 'monthly: cluster quality scan failed'); }
      this.finishRun(run_id, 'completed', `recluster: ${r.clusters} clusters, ${r.assignments} assignments, ${r.locked} locked; rescued ${rescued.rescued}/${rescued.tried}; hierarchy: ${hierarchy.parents_created} parents/${hierarchy.children_attached} children; archived ${stale.length} stale`);
    } catch (err) {
      logger.error({ err }, 'monthly run failed');
      this.finishRun(run_id, 'failed', (err as Error).message);
    }
  }

  async runBackgroundPass(): Promise<{ processed: number; auto_moves: number; noise_rescued: number }> {
    const { run_id, ctx } = this.startRun('background_pass');
    let processed = 0, auto_moves = 0, noise_rescued = 0;
    try {
      // 1. Process flag queue
      const pending = this.deps.flagQueue.list({ status: 'pending', flag_type: 'specific_issue', limit: 20 });
      for (const flag of pending) {
        try { const opId = await this.handleSpecificIssue(flag, ctx); if (opId) { this.deps.flagQueue.markAddressed(flag.flag_id, opId); processed++; } } catch (err) { logger.warn({ err, flag_id: flag.flag_id }, 'background_pass: flag handler failed'); }
      }
      // 2. Consume cluster_review move_outs
      auto_moves = await this.consumeClusterReviewMoveOuts(ctx);
      // 3. Auto-rescue noise nodes (v2.3): detect and assign unclustered embedded nodes
      try {
        const rescueResult = await this.deps.clustering.rescueNoiseNodes({ maxBudget: 30 });
        noise_rescued = rescueResult.rescued;
        if (noise_rescued > 0) {
          logger.info({ rescued: noise_rescued, declined: rescueResult.declined },
            'background_pass: auto-rescued noise nodes');
        }
      } catch (err) {
        logger.warn({ err }, 'background_pass: noise rescue failed');
      }
      this.finishRun(run_id, 'completed', `processed ${processed}/${pending.length} flags; auto-moved ${auto_moves}; noise-rescued ${noise_rescued}`);
      return { processed, auto_moves, noise_rescued };
    } catch (err) {
      logger.error({ err }, 'background_pass failed');
      this.finishRun(run_id, 'failed', (err as Error).message);
      return { processed, auto_moves, noise_rescued };
    }
  }

  private selectClustersForReview(minWeeksSinceLast: number, maxClusters: number): number[] {
    const since7d = daysAgo(7), sinceMin = daysAgo(minWeeksSinceLast * 7);
    const rows = this.deps.db.prepare('SELECT cluster_id, friction_count, last_new_member_at, last_review_at FROM clusters WHERE status=\'active\'').all() as { cluster_id: number; friction_count: number; last_new_member_at: string | null; last_review_at: string | null }[];
    const candidates: { cluster_id: number; score: number }[] = [];
    for (const r of rows) {
      const hasNewMember = r.last_new_member_at !== null && r.last_new_member_at >= since7d;
      const hasFriction = r.friction_count > 0;
      const neverReviewed = r.last_review_at === null;
      const stale = neverReviewed || r.last_review_at! < sinceMin;
      if (!hasNewMember && !hasFriction && !stale) continue;
      const score = (neverReviewed ? 100 : 0) + (r.friction_count * 5) + (hasNewMember ? 3 : 0) + (stale ? 2 : 0);
      candidates.push({ cluster_id: r.cluster_id, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, maxClusters).map((c) => c.cluster_id);
  }

  private getParams() {
    return (this.deps.synthesis as unknown as { deps: { params: { review_min_weeks_since_last: number; review_max_clusters_per_week: number; on_ingest_neighbors_k: number } } }).deps.params;
  }

  private async askForIngestAnalysis(l0: string, l1: string, body: string, neighbors: { uuid: string; l1: string }[]): Promise<OnIngestAnalysis | null> {
    const { system, user } = buildOnIngestAnalysisPrompt({ new_node: { l0, l1, body_excerpt: body.slice(0, 1500) }, neighbors });
    try {
      const completion = await this.deps.llm.chat({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], response_format: { type: 'json_object' }, temperature: 0.2 });
      const raw = completion.choices[0]?.message?.content ?? '';
      const parsed = JSON.parse(raw) as OnIngestAnalysis;
      if (!parsed.hub_role_judgment || typeof parsed.should_synthesize !== 'boolean') return null;
      const v = parsed.hub_role_judgment.value;
      if (v !== 'root' && v !== 'center' && v !== 'leaf' && v !== 'neutral') return null;
      if (!Array.isArray(parsed.relations_to_neighbors)) parsed.relations_to_neighbors = [];
      return parsed;
    } catch (err) { logger.warn({ err }, 'on_ingest analysis LLM call failed'); return null; }
  }

  private async handleSpecificIssue(flag: { flag_id: string; target_uuid: string | null; issue_type: string | null; description: string }, ctx: ToolContext): Promise<string | null> {
    if (!flag.target_uuid) return null;
    if (flag.issue_type === 'duplicate' || flag.issue_type === 'outdated') {
      const op = this.deps.oplog.append({ agent_run_id: ctx.agent_run_id, agent_id: ctx.agent_id, op_type: 'dedupe', args: { dropped_uuid: flag.target_uuid }, reason: `flagged as ${flag.issue_type}: ${flag.description}`, affected_uuids: [flag.target_uuid] });
      this.deps.storage.archiveNode(flag.target_uuid, `flag ${flag.issue_type}: ${flag.description}`);
      return op.op_id;
    }
    if (flag.issue_type === 'wrong_cluster') {
      const node = this.deps.storage.readNode(flag.target_uuid);
      if (!node) return null;
      const clusters = this.deps.db.prepare(`SELECT cluster_id, description, (SELECT GROUP_CONCAT(l0_summary, ' | ') FROM nodes WHERE cluster_id=clusters.cluster_id AND status='active' AND node_type='raw' AND l0_summary != '' ORDER BY is_cluster_hub DESC LIMIT 5) AS member_l0s FROM clusters WHERE status='active' AND cluster_id != ?`).all(node.derived_state?.cluster_id ?? -1) as { cluster_id: number; description: string | null; member_l0s: string | null }[];
      if (clusters.length === 0) return null;
      const prompt = `用户反馈这个节点归错簇了。请判断它最该归到哪个簇。\n\n节点(当前在簇 ${node.derived_state?.cluster_id}):\n  L0: ${node.l0_summary}\n  L1: ${(node.l1_overview || '').slice(0, 600)}\n\n用户描述: ${flag.description}\n\n候选簇(不含当前簇):\n${clusters.map((c) => `  簇 #${c.cluster_id} ${c.description ? `(${c.description})` : ''}\n     成员摘要: ${(c.member_l0s ?? '').slice(0, 300)}`).join('\n')}\n\n只输出 JSON: {"cluster_id": <number 或 -1 表示不动>, "reason": "<理由>"}`;
      try {
        const completion = await this.deps.llm.chat({ messages: [{ role: 'system', content: '你是图书管理员,只输出严格 JSON。' }, { role: 'user', content: prompt }], response_format: { type: 'json_object' }, temperature: 0.2 });
        const raw = completion.choices[0]?.message?.content ?? '{}';
        const parsed = JSON.parse(raw) as { cluster_id?: number; reason?: string };
        const newCid = typeof parsed.cluster_id === 'number' ? parsed.cluster_id : -1;
        if (clusters.some((c) => c.cluster_id === newCid)) {
          this.deps.storage.setClusterAssignment(flag.target_uuid, newCid, 0.55);
          this.deps.clustering.refreshClusterCentroid(newCid);
          this.deps.clustering.recomputeHubs();
          this.deps.clustering.recomputeSynthesisDerivedState();
          const op = this.deps.oplog.append({ agent_run_id: ctx.agent_run_id, agent_id: ctx.agent_id, op_type: 'move', args: { uuid: flag.target_uuid, from_cluster: node.derived_state?.cluster_id ?? null, to_cluster: newCid }, reason: `LLM cluster reassign: ${parsed.reason ?? ''}`, affected_uuids: [flag.target_uuid] });
          return op.op_id;
        }
        return null;
      } catch (err) { logger.warn({ err, flag_id: flag.flag_id }, 'wrong_cluster LLM call failed'); return null; }
    }
    return null;
  }

  private async consumeClusterReviewMoveOuts(ctx: ToolContext): Promise<number> {
    const reviews = this.deps.db.prepare(`SELECT uuid, reviewed_cluster_id FROM nodes WHERE node_type='synthesis' AND synthesis_subtype='cluster_review' AND status='active'`).all() as { uuid: string; reviewed_cluster_id: number }[];
    let moved = 0;
    for (const review of reviews) {
      const node = this.deps.storage.readNode(review.uuid);
      if (!node) continue;
      const judgments = node.review_payload?.review_judgments ?? [];
      for (const j of judgments) {
        if (j.proposed_action !== 'move_out' || j.confidence !== 'high' || !j.target_uuid) continue;
        const target = this.deps.storage.readNode(j.target_uuid);
        if (!target || target.derived_state?.cluster_id !== review.reviewed_cluster_id) continue;
        const fakeFlag = { flag_id: 'auto:' + review.uuid, target_uuid: j.target_uuid, issue_type: 'wrong_cluster' as const, description: `cluster_review proposed move_out (${j.confidence}): ${j.claim}` };
        try { const opId = await this.handleSpecificIssue(fakeFlag, ctx); if (opId) moved++; } catch (err) { logger.warn({ err, target: j.target_uuid }, 'auto move_out failed'); }
      }
    }
    return moved;
  }

  private async consumeSubThemeRecommendations(clusterIds: number[], ctx: ToolContext): Promise<{ auto: number; flagged: number; skipped: number }> {
    let auto = 0, flagged = 0, skipped = 0;
    for (const cid of clusterIds) {
      const reviewRow = this.deps.db.prepare(`SELECT uuid FROM nodes WHERE node_type='synthesis' AND synthesis_subtype='cluster_review' AND status='active' AND reviewed_cluster_id=? ORDER BY created_at DESC LIMIT 1`).get(cid) as { uuid: string } | undefined;
      if (!reviewRow) continue;
      const reviewNode = this.deps.storage.readNode(reviewRow.uuid);
      if (!reviewNode?.review_payload) continue;
      const recs = reviewNode.review_payload.sub_theme_recommendations ?? [];
      if (recs.length === 0) continue;
      const memberSet = new Set((this.deps.db.prepare(`SELECT uuid FROM nodes WHERE cluster_id=? AND status='active' AND node_type='raw'`).all(cid) as { uuid: string }[]).map((r) => r.uuid));
      for (const rec of recs) {
        if (!memberSet.has(rec.anchor_uuid)) { skipped++; continue; }
        if (rec.confidence === 'low') { skipped++; continue; }
        const histCount = (this.deps.db.prepare(`SELECT COUNT(*) AS c FROM op_log WHERE op_type='set_hub_role' AND args LIKE '%' || ? || '%' AND args LIKE '%' || ? || '%'`).get(rec.anchor_uuid, rec.label) as { c: number }).c;
        if (rec.confidence === 'high' && histCount >= 2) {
          const row = this.deps.db.prepare("SELECT hub_role_value FROM nodes WHERE uuid=? AND status='active' AND node_type='raw'").get(rec.anchor_uuid) as { hub_role_value: string | null } | undefined;
          if (!row || row.hub_role_value === 'center' || row.hub_role_value === 'root') { skipped++; continue; }
          const fromVal = (row.hub_role_value ?? 'neutral') as HubRoleValue;
          const opId = this.deps.oplog.append({ agent_run_id: ctx.agent_run_id, agent_id: ctx.agent_id, op_type: 'set_hub_role', args: { uuid: rec.anchor_uuid, from_value: fromVal, to_value: 'center' }, reason: `sub_theme consensus (${histCount}x "${rec.label}"): ${fromVal}→center`, affected_uuids: [rec.anchor_uuid] }).op_id;
          this.deps.storage.setHubRole(rec.anchor_uuid, 'center', 'librarian', `sub_theme consensus: "${rec.label}" recommended ${histCount}x`, opId ?? null, 'agent:librarian');
          auto++;
        } else {
          this.deps.flagQueue.append({ flag_type: 'specific_issue', target_uuid: rec.anchor_uuid, target_cluster_id: cid, description: `sub_theme 推荐: "${rec.label}" (confidence=${rec.confidence}, 历史${histCount}次)${rec.reasoning ? ` (${rec.reasoning})` : ''}`, flagged_by: 'system:librarian' });
          flagged++;
        }
      }
    }
    return { auto, flagged, skipped };
  }
}

// ========== Hermes 类型（导出供 scheduler 使用）==========

export interface HermesObservation {
  counts: { total: number; raw: number; synthesis: number; reflection: number; pending_embed: number };
  cluster_count: number;
  friction_clusters: number[];
  optimization_queue_depth: number;
  flag_counts: Record<string, number>;
  recent_flags: unknown[];
  expired_trace_count: number;
  cluster_quality_signals: ClusterQualitySignal[];
  recent_ops: { op_id: string; op_type: string; reason: string; timestamp: string }[];
  heartbeat_content: string | null;
  timestamp: string;
}

export interface HermesDiagnosis {
  id: string;
  type: 'cluster_quality' | 'retrieval_quality' | 'content_quality' | 'coverage_gap' | 'workflow_feedback' | 'reflection_opportunity';
  priority: 'high' | 'medium' | 'low';
  target_uuid?: string;
  target_cluster_id?: number;
  evidence: string;
  recommended_action_class: 'L1' | 'L2' | 'L3';
  reasoning: string;
}

export interface PlannedAction {
  diagnosis_id: string;
  risk_level: string;
  action_type: string;
  target_uuid?: string;
  target_cluster_id?: number;
  reasoning: string;
}

export interface HermesActionPlan {
  scheduled: PlannedAction[];
  queued: PlannedAction[];
  skipped: PlannedAction[];
  total: number;
}

export interface HermesActionResult {
  diagnosis_id: string;
  action_type: string;
  risk_level: string;
  ok: boolean;
  details: string;
}

export interface HermesVerification {
  verdict: 'accepted' | 'reverted' | 'escalated' | 'partial';
  action_count: number;
  ok_count: number;
  notes: string[];
  timestamp: string;
}

export interface HermesCycleResult {
  observations: HermesObservation;
  diagnoses: HermesDiagnosis[];
  plan: HermesActionPlan;
  actions: HermesActionResult[];
  verification: HermesVerification | null;
}