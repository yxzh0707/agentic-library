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
} from '@kb/shared';
import { newUuid } from '../util/uuid.js';
import { logger } from '../util/logger.js';
import { daysAgo, nowIso } from '../util/now.js';
import { buildOnIngestAnalysisPrompt, type OnIngestAnalysis } from '../synthesis/prompts.js';

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
      '赛题',
      '原题',
      'benchmark',
      'kdd cup',
      '比赛',
      '竞赛',
      '任务描述',
      '任务要求',
      '评测标准',
      '数据集格式',
      'task description',
      'problem statement',
      'official',
      '比赛说明',
      '赛题说明',
      '官方题目',
    ];
    const score = hints.filter((h) => text.includes(h)).length;
    return score >= 2 || /赛题|原题|KDD|benchmark|Task|Problem Statement/i.test(l0);
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

  /**
   * v1.3 §7.2 §5.3 — On a new raw node, run the two-step thought chain:
   *   step 1: LLM analyzes node + top-K embedding neighbors → hub_role + should_synthesize
   *   step 2: if should_synthesize, generate a consolidation candidate
   * Returns the consolidation node if one was generated, else null.
   */
  async runOnIngest(uuid: string): Promise<{ synthesis_uuid: string | null; hub_role: HubRoleValue }> {
    const { run_id, ctx } = this.startRun('on_ingest');
    try {
      const node = this.deps.storage.readNode(uuid);
      if (!node || node.node_type !== 'raw') {
        this.finishRun(run_id, 'completed', 'skip: not raw');
        return { synthesis_uuid: null, hub_role: 'neutral' };
      }
      // Find top-K neighbors via l1
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
              .prepare(
                `SELECT uuid, l1_overview FROM nodes WHERE e_l1_id IN (${placeholders}) AND node_type='raw' AND status='active'`,
              )
              .all(...others.map((o) => o.id)) as { uuid: string; l1_overview: string }[];
            for (const r of rows) {
              if (r.uuid === uuid) continue;
              neighbors.push({ uuid: r.uuid, l1: r.l1_overview });
            }
          }
        }
      }

      // Step 1: LLM analysis
      const isRootCandidate = this.isProblemStatement(node.l0_summary, node.body);
      const analysis = await this.askForIngestAnalysis(node.l0_summary, node.l1_overview, node.body, neighbors);
      if (!analysis) {
        // LLM call failed (network / quota) or output failed schema validation.
        // Either way the node still got summarized + embedded + cluster-assigned;
        // hub_role just stays at default 'neutral'. Re-run on_ingest manually
        // (or wait for next on_review) once LLM is available again.
        this.finishRun(run_id, 'failed', 'llm unavailable or output invalid');
        return { synthesis_uuid: null, hub_role: 'neutral' };
      }

      // Apply hub_role decision (record op even if it's neutral on a node that was already neutral)
      const currentHub = node.hub_role?.value ?? 'neutral';
      const nextHub: HubRoleValue = isRootCandidate ? 'root' : analysis.hub_role_judgment.value;
      const hubReason = isRootCandidate
        ? `problem statement/root anchor detected: ${analysis.hub_role_judgment.reason}`
        : analysis.hub_role_judgment.reason;
      const preserveExisting =
        (nextHub === 'neutral' && (currentHub === 'center' || currentHub === 'root')) ||
        (nextHub === 'center' && currentHub === 'root');
      if (preserveExisting) {
        logger.info({ uuid, currentHub, nextHub }, 'on_ingest: preserving stronger existing hub role');
      } else if (nextHub !== currentHub) {
        const op = this.deps.oplog.append({
          agent_run_id: ctx.agent_run_id,
          agent_id: ctx.agent_id,
          op_type: 'set_hub_role',
          args: {
            uuid,
            from_value: currentHub,
            to_value: nextHub,
          },
          reason: hubReason,
          affected_uuids: [uuid],
        });
        this.deps.storage.setHubRole(
          uuid,
          nextHub,
          isRootCandidate ? 'root_promoted' : 'auto_detected',
          hubReason,
          op.op_id,
          'agent:librarian',
        );
        if (nextHub === 'root') this.deps.clustering.recomputeHubs();
      }

      // Duplicate detection: if a near-identical active node already exists,
      // write a flag for human review. No auto-archive or auto-supersede.
      try {
        if (ptr?.e_l1_id != null) {
          const vec = this.deps.index.getVector('l1', ptr.e_l1_id);
          if (vec) {
            const topHits = this.deps.index.searchKNN('l1', vec, 5);
            const others = topHits
              .filter((h) => h.id !== ptr.e_l1_id)
              .slice(0, 3);
            for (const hit of others) {
              // hnswlib 'cosine' space: distance = 1 - cosine_similarity
              // 0.92 cosine → ≤ 0.08 distance
              if (hit.distance <= 0.08) {
                const cosSim = (1 - hit.distance);
                const existingUuid = (this.deps.db
                  .prepare('SELECT uuid FROM nodes WHERE e_l1_id=? AND status=?')
                  .get(hit.id, 'active') as { uuid: string } | undefined)?.uuid;
                if (existingUuid) {
                  this.deps.flagQueue.append({
                    flag_type: 'specific_issue',
                    target_uuid: uuid,
                    description: `potential_duplicate: 与 ${existingUuid} 的 L1 余弦相似度=${cosSim.toFixed(3)}。请确认是否需要归档或合并。`,
                    flagged_by: 'agent:librarian',
                  });
                }
              }
            }
          }
        }
      } catch (err) {
        logger.warn({ err, uuid }, 'on_ingest: duplicate detection failed');
      }

      // Step 2: optional consolidation
      if (!analysis.should_synthesize) {
        this.finishRun(
          run_id,
          'completed',
          `hub_role=${analysis.hub_role_judgment.value} (no synthesis)`,
        );
        return { synthesis_uuid: null, hub_role: analysis.hub_role_judgment.value };
      }

      const relatedUuids = analysis.relations_to_neighbors
        .filter((r) => r.relation !== 'unrelated')
        .map((r) => r.neighbor_uuid)
        .slice(0, 3);
      if (relatedUuids.length === 0) {
        this.finishRun(run_id, 'completed', 'no related neighbors found');
        return { synthesis_uuid: null, hub_role: analysis.hub_role_judgment.value };
      }
      const candidate: SynthesisCandidate = {
        source_uuids: [uuid, ...relatedUuids],
        cluster_id: node.derived_state?.cluster_id ?? null,
        subtype: 'consolidation',
        trigger: {
          type: 'on_ingest',
          evidence: {
            new_uuid: uuid,
            related_count: relatedUuids.length,
            reasoning: analysis.synthesis_reasoning,
          },
        },
      };
      const result = await this.deps.synthesis.generateConsolidation(candidate, ctx);
      if ('rejected' in result && result.rejected) {
        this.finishRun(run_id, 'completed', `consolidation rejected: ${result.reason}`);
        return { synthesis_uuid: null, hub_role: analysis.hub_role_judgment.value };
      }
      this.finishRun(run_id, 'completed', `+1 consolidation, hub_role=${analysis.hub_role_judgment.value}`);
      return {
        synthesis_uuid: 'node' in result ? result.node.uuid : null,
        hub_role: analysis.hub_role_judgment.value,
      };
    } catch (err) {
      logger.error({ err, uuid }, 'on_ingest failed');
      this.finishRun(run_id, 'failed', (err as Error).message);
      return { synthesis_uuid: null, hub_role: 'neutral' };
    }
  }

  /**
   * v1.3 §7.2 / §3.5.1 — weekly review of clusters that satisfy:
   *   - has new members in last 7 days, OR
   *   - has accumulated friction_count > 0, OR
   *   - last review > review_min_weeks_since_last weeks ago
   * Bounded by review_max_clusters_per_week.
   */
  async runOnReview(): Promise<{ generated: number; rejected: number }> {
    const { run_id, ctx } = this.startRun('on_review');
    try {
      const params = this.getParams();
      // Cold start: if zero active clusters but enough raw nodes to LLM-batch,
      // form initial clusters. Bypasses HDBSCAN's failure zone (N<10).
      // Once seeded, future weekly/monthly runs follow normal paths.
      try {
        const cold = await this.deps.clustering.coldStartCluster();
        if (cold && cold.formed > 0) {
          this.deps.clustering.recomputeHubs();
          this.deps.clustering.recomputeSynthesisDerivedState();
          logger.info({ formed: cold.formed }, 'on_review: cold start seeded clusters');
        }
      } catch (err) {
        logger.warn({ err }, 'on_review: cold start failed');
      }
      const cluster_ids = this.selectClustersForReview(
        params.review_min_weeks_since_last,
        params.review_max_clusters_per_week,
      );
      let generated = 0;
      let rejected = 0;
      for (const cid of cluster_ids) {
        // Find existing active cluster_review for this cluster, if any.
        const prev = this.deps.db
          .prepare(
            "SELECT uuid FROM nodes WHERE node_type='synthesis' AND synthesis_subtype='cluster_review' AND status='active' AND reviewed_cluster_id=? ORDER BY created_at DESC LIMIT 1",
          )
          .get(cid) as { uuid: string } | undefined;
        // If previous review exists, supersede it before regen (prev was "live", new replaces).
        if (prev) {
          this.deps.storage.supersedeNode(prev.uuid, 'on_review_regen');
        }
        const r = await this.deps.synthesis.generateClusterReview(cid, ctx, {
          previous_uuid: prev?.uuid ?? null,
          inheritance_hint: prev ? 'modified' : undefined,
        });
        if (r.rejected) rejected++;
        else generated++;
      }
      // After review, snapshot cluster centroids + recompute hubs.
      this.deps.clustering.snapshotClusters();
      // Noise rescue is also run here (not only in monthly): high-ingest periods
      // accumulate noise nodes that don't deserve a 21-day wait. Cheap LLM call
      // per noise node, bounded by maxBudget inside the function.
      try {
        const rescued = await this.deps.clustering.rescueNoiseNodes();
        if (rescued.rescued > 0) {
          logger.info({ ...rescued }, 'on_review: rescued noise nodes via LLM');
        }
      } catch (err) {
        logger.warn({ err }, 'on_review: noise rescue failed');
      }
      this.deps.clustering.recomputeHubs();
      this.deps.clustering.recomputeSynthesisDerivedState();

      // v1.4: consume sub_theme_recommendations from freshly generated cluster_reviews.
      // Tiered execution: high+consensus → auto; high/medium new → flag_queue; low → record only.
      try {
        const subApplied = await this.consumeSubThemeRecommendations(cluster_ids, ctx);
        if (subApplied.auto > 0 || subApplied.flagged > 0) {
          logger.info({ ...subApplied }, 'on_review: sub_theme_recommendations consumed');
        }
      } catch (err) {
        logger.warn({ err }, 'on_review: sub_theme_recommendations consumption failed');
      }

      // Multi-center signal (v1.4 framing): a working_set cluster legitimately
      // has many sub-hub anchors (one per sub-theme), so absolute count ≥ 3 is
      // not a split signal — it's the design. Flag only when centers dominate
      // the membership: ≥ 4 centers AND > 60% of members. That pattern means
      // the LLM has marked almost everyone as a center, which usually
      // indicates the cluster is conceptually heterogeneous (multiple
      // working sets stuffed together) rather than one with rich sub-themes.
      const overpopulated = this.deps.db
        .prepare(
          `SELECT cluster_id, center_count, member_count FROM (
             SELECT n.cluster_id AS cluster_id,
                    SUM(CASE WHEN n.hub_role_value='center' THEN 1 ELSE 0 END) AS center_count,
                    COUNT(*) AS member_count
             FROM nodes n
             WHERE n.status='active' AND n.node_type='raw' AND n.cluster_id IS NOT NULL
             GROUP BY n.cluster_id
           )
           WHERE center_count >= 4 AND center_count * 5 > member_count * 3`,
        )
        .all() as { cluster_id: number; center_count: number; member_count: number }[];
      for (const o of overpopulated) {
        // dedupe: avoid spamming the queue if the same flag is already pending
        const existing = this.deps.flagQueue.list({
          status: 'pending',
          flag_type: 'cluster_friction',
          cluster_id: o.cluster_id,
        });
        const alreadyFlagged = existing.some((f) =>
          (f.description || '').includes('multi-center split'),
        );
        if (!alreadyFlagged) {
          this.deps.flagQueue.append({
            flag_type: 'cluster_friction',
            target_cluster_id: o.cluster_id,
            description: `multi-center split candidate: ${o.center_count}/${o.member_count} hub_role=center nodes in cluster ${o.cluster_id} — centers dominate membership, cluster may mix multiple working sets`,
            flagged_by: 'agent:librarian',
          });
        }
      }
      // Log cluster quality signals (read-only, no structural changes)
      try {
        const activeClusters = this.deps.db
          .prepare("SELECT cluster_id FROM clusters WHERE status='active'")
          .all() as { cluster_id: number }[];
        for (const c of activeClusters) {
          const q = this.deps.clustering.computeClusterQuality(c.cluster_id);
          logger.info({ quality: q }, `cluster #${c.cluster_id} quality: ${q.status}`);
        }
      } catch (err) {
        logger.warn({ err }, 'on_review: cluster quality scan failed');
      }
      this.finishRun(
        run_id,
        'completed',
        `reviewed ${cluster_ids.length}, +${generated}/${rejected}`,
      );
      return { generated, rejected };
    } catch (err) {
      logger.error({ err }, 'on_review failed');
      this.finishRun(run_id, 'failed', (err as Error).message);
      return { generated: 0, rejected: 0 };
    }
  }

  /**
   * v1.3 monthly: full UMAP+HDBSCAN recluster, then propagate hub + derived state,
   * snapshot, and archive long-stale syntheses.
   */
  async runMonthly(): Promise<void> {
    const { run_id } = this.startRun('monthly_recluster');
    try {
      const r = await this.deps.clustering.fullRecluster();
      this.deps.clustering.snapshotClusters();
      // LLM noise rescue: HDBSCAN frequently judges semantically-related edge
      // nodes as noise in dense regions. LLM looks at l1 vs each cluster's
      // representative l0s and assigns them.
      let rescued = { rescued: 0, tried: 0, declined: 0 };
      try {
        rescued = await this.deps.clustering.rescueNoiseNodes();
        if (rescued.rescued > 0) {
          logger.info({ ...rescued }, 'monthly: rescued noise nodes via LLM');
        }
      } catch (err) {
        logger.warn({ err }, 'monthly: noise rescue failed');
      }
      this.deps.clustering.recomputeHubs();
      this.deps.clustering.recomputeSynthesisDerivedState();
      // Persist pairwise cos sim per cluster so the frontend can drive edge
      // length by semantic distance and threshold-jump edge nodes to root_hub.
      try {
        const sim = this.deps.clustering.persistClusterSimilarities();
        logger.info({ ...sim }, 'monthly: similarity edges persisted');
      } catch (err) {
        logger.warn({ err }, 'monthly: persistClusterSimilarities failed');
      }
      // Hierarchical meta-cluster: LLM looks at all leaf clusters and groups
      // related ones under virtual parent clusters (e.g. "all 4 clusters belong
      // to TAAC2026 project"). Replaces the frontend root-hub patch with real
      // parent_cluster_id structure.
      let hierarchy = { parents_created: 0, children_attached: 0 };
      try {
        hierarchy = await this.deps.clustering.computeClusterHierarchy();
      } catch (err) {
        logger.warn({ err }, 'monthly: meta-clustering failed');
      }
      // Archive synthesis nodes with reference_count == 0 and older than 60 days
      const cutoff = daysAgo(60);
      const stale = this.deps.db
        .prepare(
          "SELECT uuid FROM nodes WHERE node_type='synthesis' AND status='active' AND reference_count = 0 AND created_at <= ?",
        )
        .all(cutoff) as { uuid: string }[];
      for (const s of stale) this.deps.storage.archiveNode(s.uuid, 'unused for 60 days');
      // Log cluster quality signals (read-only, no structural changes)
      try {
        const activeClusters = this.deps.db
          .prepare("SELECT cluster_id FROM clusters WHERE status='active'")
          .all() as { cluster_id: number }[];
        for (const c of activeClusters) {
          const q = this.deps.clustering.computeClusterQuality(c.cluster_id);
          logger.info({ quality: q }, `cluster #${c.cluster_id} quality: ${q.status}`);
        }
      } catch (err) {
        logger.warn({ err }, 'monthly: cluster quality scan failed');
      }
      this.finishRun(
        run_id,
        'completed',
        `recluster: ${r.clusters} clusters, ${r.assignments} assignments, ${r.locked} locked; rescued ${rescued.rescued}/${rescued.tried} noise; hierarchy: ${hierarchy.parents_created} parents/${hierarchy.children_attached} children; archived ${stale.length} stale syntheses`,
      );
    } catch (err) {
      logger.error({ err }, 'monthly run failed');
      this.finishRun(run_id, 'failed', (err as Error).message);
    }
  }

  /**
   * v1.3 §7.2 — drains pending specific_issue flags into op-level actions.
   * Also consumes move_out proposals from active cluster_reviews
   * (LLM-written judgments → automatic action, completing the framing loop).
   */
  async runBackgroundPass(): Promise<{ processed: number; auto_moves: number }> {
    const { run_id, ctx } = this.startRun('background_pass');
    let processed = 0;
    let auto_moves = 0;
    try {
      // Phase 1: user-flagged specific issues
      const pending = this.deps.flagQueue.list({ status: 'pending', flag_type: 'specific_issue', limit: 20 });
      for (const flag of pending) {
        try {
          const opId = await this.handleSpecificIssue(flag, ctx);
          if (opId) {
            this.deps.flagQueue.markAddressed(flag.flag_id, opId);
            processed++;
          }
        } catch (err) {
          logger.warn({ err, flag_id: flag.flag_id }, 'background_pass: flag handler failed');
        }
      }

      // Phase 2: act on cluster_review move_out proposals (LLM judgment → action).
      // Only execute high-confidence proposals; medium goes to flag_queue for human review.
      auto_moves = await this.consumeClusterReviewMoveOuts(ctx);

      this.finishRun(
        run_id,
        'completed',
        `processed ${processed}/${pending.length} flags; auto-moved ${auto_moves} per cluster_review`,
      );
      return { processed, auto_moves };
    } catch (err) {
      logger.error({ err }, 'background_pass failed');
      this.finishRun(run_id, 'failed', (err as Error).message);
      return { processed, auto_moves };
    }
  }

  /**
   * Walk active cluster_reviews, find review_judgments with proposed_action=move_out
   * and confidence=high. For each, move the target node to the recommended cluster
   * (LLM picks via the same wrong_cluster handler logic, or creates a new working set
   * when target_cluster_id='new'). Skips medium-confidence proposals — those go
   * through human flag_queue review instead.
   */
  private async consumeClusterReviewMoveOuts(ctx: ToolContext): Promise<number> {
    const reviews = this.deps.db
      .prepare(
        `SELECT uuid, reviewed_cluster_id FROM nodes
         WHERE node_type='synthesis' AND synthesis_subtype='cluster_review' AND status='active'`,
      )
      .all() as { uuid: string; reviewed_cluster_id: number }[];

    let moved = 0;
    for (const review of reviews) {
      const node = this.deps.storage.readNode(review.uuid);
      if (!node) continue;
      const judgments = node.review_payload?.review_judgments ?? [];
      for (const j of judgments) {
        if (j.proposed_action !== 'move_out') continue;
        if (j.confidence !== 'high') continue;
        if (!j.target_uuid) continue;
        // Verify target still exists and is in this cluster
        const target = this.deps.storage.readNode(j.target_uuid);
        if (!target) continue;
        if (target.derived_state?.cluster_id !== review.reviewed_cluster_id) continue;

        // v1.4: if LLM says this node should become its own working set,
        // run a focused mini cold-start instead of the wrong_cluster route.
        if (j.target_cluster_id === 'new') {
          try {
            const opId = await this.createNewWorkingSetForNode(j.target_uuid, j.claim, ctx);
            if (opId) moved++;
          } catch (err) {
            logger.warn({ err, target: j.target_uuid }, 'auto move_out (new cluster) failed');
          }
          continue;
        }

        // Re-use wrong_cluster LLM judgment to pick best target cluster.
        // If LLM already suggested a specific existing cluster, prefer it.
        const fakeFlag = {
          flag_id: 'auto:' + review.uuid,
          target_uuid: j.target_uuid,
          issue_type: 'wrong_cluster' as const,
          description: `cluster_review proposed move_out (${j.confidence}): ${j.claim}`,
        };
        try {
          const opId = await this.handleSpecificIssue(fakeFlag, ctx);
          if (opId) moved++;
        } catch (err) {
          logger.warn({ err, target: j.target_uuid }, 'auto move_out failed');
        }
      }
    }
    return moved;
  }

  /**
   * v1.4: when cluster_review says a node should be its own working set,
   * collect its KNN neighbours and ask LLM to form a focused working set.
   * Falls back to flag_queue if conditions aren't met.
   */
  private async createNewWorkingSetForNode(
    uuid: string,
    claim: string,
    ctx: ToolContext,
  ): Promise<string | null> {
    const node = this.deps.storage.readNode(uuid);
    if (!node) return null;
    const ePtr = this.deps.storage.getEmbeddingPointers(uuid);
    if (!ePtr || ePtr.e_l1_id === null) return null;
    const vec = this.deps.index.getVector('l1', ePtr.e_l1_id);
    if (!vec) return null;

    // Collect KNN neighbours — active raw nodes in the same cluster or noise.
    const neighbours = this.deps.index
      .searchKNN('l1', vec, 16)
      .filter((n) => n.id !== ePtr.e_l1_id)
      .slice(0, 12);
    if (neighbours.length < 2) {
      this.deps.flagQueue.append({
        flag_type: 'specific_issue',
        target_uuid: uuid,
        target_cluster_id: null,
        issue_type: 'wrong_cluster',
        description: `cluster_review moved_out 建议独立成新 working set (${claim}),但相似邻居不足,无法形成新簇`,
        flagged_by: 'system:librarian',
      });
      return null;
    }

    const neighbourIds = neighbours.map((n) => n.id);
    const placeholders = neighbourIds.map(() => '?').join(',');
    const nRows = this.deps.db
      .prepare(
        `SELECT uuid, l0_summary, l1_overview FROM nodes
         WHERE e_l1_id IN (${placeholders}) AND status='active' AND node_type='raw'`,
      )
      .all(...neighbourIds) as { uuid: string; l0_summary: string; l1_overview: string }[];
    if (nRows.length < 2) {
      this.deps.flagQueue.append({
        flag_type: 'specific_issue',
        target_uuid: uuid,
        target_cluster_id: null,
        issue_type: 'wrong_cluster',
        description: `cluster_review moved_out 建议独立成新 working set (${claim}),但解析邻居不足`,
        flagged_by: 'system:librarian',
      });
      return null;
    }

    const candidateUuids = new Set([uuid, ...nRows.map((r) => r.uuid)]);
    const items = [
      { uuid: node.uuid, l0: node.l0_summary, l1: node.l1_overview || '' },
      ...nRows.map((r) => ({ uuid: r.uuid, l0: r.l0_summary, l1: r.l1_overview || '' })),
    ];
    const N = items.length;
    const maxK = Math.max(1, Math.floor(N / 2) + 1);
    const itemsText = items
      .map((r, i) => `[${i + 1}] ${r.uuid}\n  L0: ${r.l0.replace(/\n/g, ' ')}\n  L1: ${r.l1.replace(/\n/g, ' ')}`)
      .join('\n\n');

    const prompt = `你是图书管理员。cluster_review 认为一个节点应该独立成新 working set:

节点: ${uuid}
理由: ${claim}

下面是该节点及其嵌入空间最近邻(${N} 个文档):

${itemsText}

# 你的任务

判断这些文档是否能形成一个合理的 working set:
- 一个 working set 是一个项目/语境单元
- 如果确实能形成独立 working set,只保留真正属于这个 working set 的成员
- 如果这些文档不够成独立 working set(主题发散/其实属于现有其他簇),输出空 working_sets

输出严格 JSON:
{
  "working_sets": [
    {
      "label": "<2-8 汉字>",
      "member_uuids": ["uuid1", ...],
      "sub_themes": []
    }
  ]
}
要求:
- working_sets 最多 1 个
- 必须包含 ${uuid}
- 如果该节点其实不适合独立成 working set,返回 {"working_sets": []}`;

    try {
      const completion = await this.deps.llm.chat({
        messages: [
          { role: 'system', content: '你是图书管理员,只输出严格 JSON,不要解释。' },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
      });
      const raw = completion.choices[0]?.message?.content ?? '{}';
      const parsed = JSON.parse(raw) as { working_sets?: { label: string; member_uuids: string[] }[] };
      const wss = parsed.working_sets ?? [];
      if (wss.length === 0 || !wss[0] || wss[0].member_uuids.length === 0) {
        this.deps.flagQueue.append({
          flag_type: 'specific_issue',
          target_uuid: uuid,
          target_cluster_id: null,
          issue_type: 'wrong_cluster',
          description: `cluster_review moved_out 建议独立成新 working set (${claim}),但 LLM 判断不适合独立成簇`,
          flagged_by: 'system:librarian',
        });
        return null;
      }
      const ws = wss[0];
      if (!ws.member_uuids.includes(uuid)) {
        return null;
      }

      // Create new cluster
      const ts = nowIso();
      const maxRow = this.deps.db
        .prepare('SELECT COALESCE(MAX(cluster_id), -1) AS m FROM clusters')
        .get() as { m: number };
      const newCid = (maxRow?.m ?? -1) + 1;
      const insert = this.deps.db.prepare(
        "INSERT INTO clusters (cluster_id, created_at, member_count, status, description, friction_count) VALUES (?, ?, ?, 'active', ?, 0)",
      );
      const updateNode = this.deps.db.prepare(
        'UPDATE nodes SET cluster_id=?, cluster_membership_strength=? WHERE uuid=?',
      );
      const tx = this.deps.db.transaction(() => {
        insert.run(newCid, ts, ws.member_uuids.length, ws.label);
        for (const u of ws.member_uuids) {
          if (candidateUuids.has(u)) {
            updateNode.run(newCid, 1.0, u);
          }
        }
      });
      tx();
      this.deps.clustering.refreshClusterCentroid(newCid);
      this.deps.clustering.recomputeHubs();
      this.deps.clustering.recomputeSynthesisDerivedState();

      const op = this.deps.oplog.append({
        agent_run_id: ctx.agent_run_id,
        agent_id: ctx.agent_id,
        op_type: 'move',
        args: {
          uuid,
          from_cluster: node.derived_state?.cluster_id ?? null,
          to_cluster: newCid,
          kind: 'move_out_new_working_set',
          review_claim: claim,
        },
        reason: `cluster_review move_out→new working set "${ws.label}" (#${newCid}): ${claim}`,
        affected_uuids: ws.member_uuids,
      });
      this.deps.oplog.append({
        agent_run_id: ctx.agent_run_id,
        agent_id: ctx.agent_id,
        op_type: 'extract',
        args: {
          kind: 'move_out_new_working_set',
          cluster_id: newCid,
          label: ws.label,
          member_uuids: ws.member_uuids,
        },
        reason: `cluster_review move_out 驱动的 new working set: ${claim}`,
        affected_uuids: ws.member_uuids,
      });
      return op.op_id;
    } catch (err) {
      logger.warn({ err, uuid }, 'createNewWorkingSetForNode LLM call failed');
      return null;
    }
  }

  /**
   * v1.4: consume sub_theme_recommendations from freshly generated cluster_reviews.
   *
   * Tiered execution:
   *   - high confidence + same (uuid, label) recommended ≥2 times historically → auto setHubRole(center)
   *   - high (first time) or medium → write flag_queue with full reasoning (human-in-the-loop later)
   *   - low → stored in review payload only, no action
   *
   * Historical consensus is counted from op_log set_hub_role operations tagged with
   * the same sub_theme label for the same anchor_uuid, rather than scanning old
   * markdown review files.
   */
  private async consumeSubThemeRecommendations(
    clusterIds: number[],
    ctx: ToolContext,
  ): Promise<{ auto: number; flagged: number; skipped: number }> {
    let auto = 0;
    let flagged = 0;
    let skipped = 0;

    for (const cid of clusterIds) {
      // Read the latest cluster_review node via storage (which reads the markdown
      // frontmatter, where review_payload lives).
      const reviewRow = this.deps.db
        .prepare(
          `SELECT uuid FROM nodes
           WHERE node_type='synthesis' AND synthesis_subtype='cluster_review'
             AND status='active' AND reviewed_cluster_id=?
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(cid) as { uuid: string } | undefined;
      if (!reviewRow) continue;
      const reviewNode = this.deps.storage.readNode(reviewRow.uuid);
      if (!reviewNode?.review_payload) continue;
      const recs = reviewNode.review_payload.sub_theme_recommendations ?? [];
      if (recs.length === 0) continue;

      const memberSet = new Set(
        (this.deps.db
          .prepare(
            `SELECT uuid FROM nodes WHERE cluster_id=? AND status='active' AND node_type='raw'`,
          )
          .all(cid) as { uuid: string }[]).map((r) => r.uuid),
      );

      for (const rec of recs) {
        if (!memberSet.has(rec.anchor_uuid)) { skipped++; continue; }
        if (rec.confidence === 'low') { skipped++; continue; }

        // Count historical consensus from op_log: how many times has this
        // (uuid, label) pair been promoted as a sub-theme anchor?
        const histCount = (this.deps.db
          .prepare(
            `SELECT COUNT(*) AS c FROM op_log
             WHERE op_type='set_hub_role'
               AND agent_id='agent:librarian'
               AND args LIKE '%' || ? || '%'
               AND args LIKE '%' || ? || '%'`,
          )
          .get(rec.anchor_uuid, rec.label) as { c: number }).c;

        if (rec.confidence === 'high' && histCount >= 2) {
          // Consensus: same recommendation seen multiple times → auto-execute.
          const row = this.deps.db
            .prepare("SELECT hub_role_value FROM nodes WHERE uuid=? AND status='active' AND node_type='raw'")
            .get(rec.anchor_uuid) as { hub_role_value: string | null } | undefined;
          if (!row) { skipped++; continue; }
          if (row.hub_role_value === 'center' || row.hub_role_value === 'root') { skipped++; continue; }
          const fromVal = (row.hub_role_value ?? 'neutral') as HubRoleValue;
          const opId = this.deps.oplog.append({
            agent_run_id: ctx.agent_run_id,
            agent_id: ctx.agent_id,
            op_type: 'set_hub_role',
            args: { uuid: rec.anchor_uuid, from_value: fromVal, to_value: 'center', cluster_id: cid, sub_theme: rec.label },
            reason: `cluster_review sub_theme consensus (${histCount}x "${rec.label}"): ${fromVal}→center`,
            affected_uuids: [rec.anchor_uuid],
          }).op_id;
          this.deps.storage.setHubRole(
            rec.anchor_uuid,
            'center',
            'librarian',
            `cluster_review sub_theme consensus: "${rec.label}" recommended ${histCount}x with high confidence`,
            opId ?? null,
            'agent:librarian',
          );
          auto++;
        } else {
          // New or medium-confidence recommendation → flag_queue for human decision.
          const reasonText = rec.reasoning ? ` (${rec.reasoning})` : '';
          this.deps.flagQueue.append({
            flag_type: 'specific_issue',
            target_uuid: rec.anchor_uuid,
            target_cluster_id: cid,
            issue_type: null,
            description: `cluster_review sub_theme 推荐: "${rec.label}" (confidence=${rec.confidence}, 历史推荐 ${histCount} 次)${reasonText}。该节点建议设为 center 作为子主题代表。`,
            flagged_by: 'system:librarian',
          });
          flagged++;
        }
      }
    }
    return { auto, flagged, skipped };
  }

  /**
   * Map a specific_issue flag to a structural op. Returns op_id when an action was taken,
   * else null (the librarian leaves it pending for next pass or human triage).
   */
  private async handleSpecificIssue(
    flag: { flag_id: string; target_uuid: string | null; issue_type: string | null; description: string },
    ctx: ToolContext,
  ): Promise<string | null> {
    if (!flag.target_uuid) return null;
    if (flag.issue_type === 'duplicate') {
      // Heuristic: keep the older active node, mark this one superseded.
      const target = this.deps.storage.readNode(flag.target_uuid);
      if (!target) return null;
      const op = this.deps.oplog.append({
        agent_run_id: ctx.agent_run_id,
        agent_id: ctx.agent_id,
        op_type: 'dedupe',
        args: { kept_uuid: null, dropped_uuid: flag.target_uuid },
        reason: `flagged as duplicate: ${flag.description}`,
        affected_uuids: [flag.target_uuid],
      });
      this.deps.storage.archiveNode(flag.target_uuid, `flag duplicate: ${flag.description}`);
      return op.op_id;
    }
    if (flag.issue_type === 'outdated') {
      const op = this.deps.oplog.append({
        agent_run_id: ctx.agent_run_id,
        agent_id: ctx.agent_id,
        op_type: 'dedupe',
        args: { kept_uuid: null, dropped_uuid: flag.target_uuid },
        reason: `flagged as outdated: ${flag.description}`,
        affected_uuids: [flag.target_uuid],
      });
      this.deps.storage.archiveNode(flag.target_uuid, `flag outdated: ${flag.description}`);
      return op.op_id;
    }
    if (flag.issue_type === 'wrong_cluster') {
      // LLM-driven cluster reassignment. Same logic as rescueNoiseNodes but
      // for a user-flagged node — let LLM look at node's l1 vs candidate
      // clusters' representative l0s and pick the right one.
      const node = this.deps.storage.readNode(flag.target_uuid);
      if (!node) return null;
      const clusters = this.deps.db
        .prepare(
          `SELECT cluster_id, description,
                  (SELECT GROUP_CONCAT(l0_summary, ' | ') FROM nodes
                   WHERE cluster_id=clusters.cluster_id AND status='active'
                     AND node_type='raw' AND l0_summary != ''
                   ORDER BY is_cluster_hub DESC LIMIT 5) AS member_l0s
           FROM clusters WHERE status='active' AND cluster_id != ?`,
        )
        .all(node.derived_state?.cluster_id ?? -1) as {
        cluster_id: number;
        description: string | null;
        member_l0s: string | null;
      }[];
      if (clusters.length === 0) return null;

      const prompt = `用户反馈这个节点归错簇了。请判断它最该归到哪个簇。

节点(当前在簇 ${node.derived_state?.cluster_id}):
  L0: ${node.l0_summary}
  L1: ${(node.l1_overview || '').slice(0, 600)}

用户描述: ${flag.description}

候选簇(不含当前簇):
${clusters.map((c) => `  簇 #${c.cluster_id} ${c.description ? `(${c.description})` : ''}\n     成员摘要: ${(c.member_l0s ?? '').slice(0, 300)}`).join('\n')}

只输出 JSON: {"cluster_id": <number 或 -1 表示不动>, "reason": "<理由>"}`;
      try {
        const completion = await this.deps.llm.chat({
          messages: [
            { role: 'system', content: '你是图书管理员,只输出严格 JSON。' },
            { role: 'user', content: prompt },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.2,
        });
        const raw = completion.choices[0]?.message?.content ?? '{}';
        const parsed = JSON.parse(raw) as { cluster_id?: number; reason?: string };
        const newCid = typeof parsed.cluster_id === 'number' ? parsed.cluster_id : -1;
        if (clusters.some((c) => c.cluster_id === newCid)) {
          this.deps.storage.setClusterAssignment(flag.target_uuid, newCid, 0.55);
          this.deps.clustering.refreshClusterCentroid(newCid);
          this.deps.clustering.recomputeHubs();
          this.deps.clustering.recomputeSynthesisDerivedState();
          const op = this.deps.oplog.append({
            agent_run_id: ctx.agent_run_id,
            agent_id: ctx.agent_id,
            op_type: 'move',
            args: {
              uuid: flag.target_uuid,
              from_cluster: node.derived_state?.cluster_id ?? null,
              to_cluster: newCid,
              flag_id: flag.flag_id,
            },
            reason: `LLM cluster reassign per user flag: ${parsed.reason ?? '(no reason)'}`,
            affected_uuids: [flag.target_uuid],
          });
          return op.op_id;
        }
        return null;
      } catch (err) {
        logger.warn({ err, flag_id: flag.flag_id }, 'wrong_cluster LLM call failed');
        return null;
      }
    }
    // l1_inaccurate / cluster_review_drifted / other: defer to on_review
    return null;
  }

  private selectClustersForReview(minWeeksSinceLast: number, maxClusters: number): number[] {
    const since7d = daysAgo(7);
    const sinceMin = daysAgo(minWeeksSinceLast * 7);
    const rows = this.deps.db
      .prepare(
        `SELECT cluster_id, friction_count, last_new_member_at, last_review_at
         FROM clusters WHERE status='active'`,
      )
      .all() as {
      cluster_id: number;
      friction_count: number;
      last_new_member_at: string | null;
      last_review_at: string | null;
    }[];
    const candidates: { cluster_id: number; score: number; neverReviewed: boolean }[] = [];
    for (const r of rows) {
      const hasNewMember = r.last_new_member_at !== null && r.last_new_member_at >= since7d;
      const hasFriction = r.friction_count > 0;
      const neverReviewed = r.last_review_at === null;
      const stale = neverReviewed || r.last_review_at! < sinceMin;
      if (!hasNewMember && !hasFriction && !stale) continue;
      // never-reviewed clusters get a strong boost so they're picked first.
      // Otherwise after a fullRecluster spawns new clusters they could starve
      // when review_max_clusters_per_week is smaller than the cluster count.
      const score =
        (neverReviewed ? 100 : 0) +
        (r.friction_count * 5) +
        (hasNewMember ? 3 : 0) +
        (stale ? 2 : 0);
      candidates.push({ cluster_id: r.cluster_id, score, neverReviewed });
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, maxClusters).map((c) => c.cluster_id);
  }

  private getParams() {
    // The synthesis service holds the params object; forward access for convenience.
    return (this.deps.synthesis as unknown as { deps: { params: { review_min_weeks_since_last: number; review_max_clusters_per_week: number; on_ingest_neighbors_k: number } } }).deps.params;
  }

  private async askForIngestAnalysis(
    l0: string,
    l1: string,
    body: string,
    neighbors: { uuid: string; l1: string }[],
  ): Promise<OnIngestAnalysis | null> {
    const { system, user } = buildOnIngestAnalysisPrompt({
      new_node: { l0, l1, body_excerpt: body.slice(0, 1500) },
      neighbors,
    });
    try {
      const completion = await this.deps.llm.chat({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      });
      const raw = completion.choices[0]?.message?.content ?? '';
      const parsed = JSON.parse(raw) as OnIngestAnalysis;
      // light validation
      if (!parsed.hub_role_judgment || typeof parsed.should_synthesize !== 'boolean') return null;
      const v = parsed.hub_role_judgment.value;
      if (v !== 'root' && v !== 'center' && v !== 'leaf' && v !== 'neutral') return null;
      if (!Array.isArray(parsed.relations_to_neighbors)) parsed.relations_to_neighbors = [];
      return parsed;
    } catch (err) {
      logger.warn({ err }, 'on_ingest analysis LLM call failed');
      return null;
    }
  }
}
