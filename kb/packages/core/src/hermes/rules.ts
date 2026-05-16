/**
 * v2.0 Hermes Optimizer §5 — L1 auto-execute rules.
 * These are low-risk, deterministic functions Hermes calls without LLM reasoning.
 * All actions go through op_log for auditability.
 */

import type { NodeStorage } from '../storage/storage.js';
import type { OpLogService } from '../op_log/op_log.js';
import type { FlagQueueService } from '../flag/flag_queue.js';
import type { IndexService } from '../indexing/index_service.js';

const AUTO_ARCHIVE_THRESHOLD_DAYS = 60;
const DUPLICATE_SIMILARITY_THRESHOLD = 0.08; // cosine distance ≤ 0.08 ≈ similarity ≥ 0.92

export interface RuleResult {
  action: string;
  affected_uuids: string[];
  details: string;
}

/**
 * L1 rule: archive synthesis nodes with zero references after AUTO_ARCHIVE_THRESHOLD_DAYS.
 * Does NOT archive raw or reflection nodes.
 */
export function autoArchiveStaleSynthesis(
  storage: NodeStorage,
  oplog: OpLogService,
  agent_run_id: string,
  agent_id: string,
): RuleResult[] {
  const cutoff = new Date(Date.now() - AUTO_ARCHIVE_THRESHOLD_DAYS * 24 * 3600 * 1000).toISOString();
  const rows = storage.queryAll<{ uuid: string; l0_summary: string }>(
    `SELECT uuid, l0_summary FROM nodes
     WHERE status='active' AND node_type='synthesis' AND reference_count=0 AND updated_at < ?`,
    [cutoff],
  );

  const results: RuleResult[] = [];
  for (const row of rows) {
    storage.archiveNode(row.uuid, `auto-archive: stale (>${AUTO_ARCHIVE_THRESHOLD_DAYS}d, ref=0)`);
    oplog.append({
      agent_run_id,
      agent_id,
      op_type: 'revert',
      args: { uuid: row.uuid, reason: 'stale_synthesis' },
      reason: `auto-archive stale synthesis: "${row.l0_summary.slice(0, 50)}"`,
      before_view_hash: '',
      after_view_hash: '',
      affected_uuids: [row.uuid],
      branch_name: 'main',
    });
    results.push({
      action: 'archived',
      affected_uuids: [row.uuid],
      details: row.l0_summary.slice(0, 60),
    });
  }
  return results;
}

/**
 * L1 rule: find near-duplicate nodes (embed distance ≤ 0.08) and write flag candidates.
 * Compares only raw nodes that have embeddings.
 */
export function autoMarkDuplicate(
  storage: NodeStorage,
  index: IndexService,
  flagQueue: FlagQueueService,
  agent_id: string,
): RuleResult[] {
  // Collect active raw nodes that have embeddings
  const nodes = storage.queryAll<{ uuid: string; l0_summary: string; cluster_id: number | null; e_l1_id: number }>(
    `SELECT uuid, l0_summary, cluster_id, e_l1_id
     FROM nodes
     WHERE status='active' AND node_type='raw' AND e_l1_id IS NOT NULL`,
  );

  const results: RuleResult[] = [];
  const checked = new Set<string>();

  for (const node of nodes) {
    if (!node.cluster_id) continue;
    // Find nearest neighbor — [0] is self, [1] is nearest
    const hits = index.searchKNN('l1', [node.e_l1_id], 2);
    if (hits.length < 2) continue;
    const nearest = hits[1]!;
    if (nearest.distance > DUPLICATE_SIMILARITY_THRESHOLD) continue;

    const pairKey = [node.uuid, String(nearest.id)].sort().join('::');
    if (checked.has(pairKey)) continue;
    checked.add(pairKey);

    flagQueue.append({
      flag_type: 'specific_issue',
      target_uuid: String(nearest.id),
      issue_type: 'duplicate',
      description: `Near-duplicate of ${node.uuid}: embed distance ${nearest.distance.toFixed(3)}`,
      flagged_by: `hermes:autoMarkDuplicate:${agent_id}`,
    });

    results.push({
      action: 'flagged_duplicate',
      affected_uuids: [node.uuid, String(nearest.id)],
      details: `dist=${nearest.distance.toFixed(3)}`,
    });
  }
  return results;
}

/**
 * L1 rule: delete wikilink edges where the target node no longer exists.
 */
export function autoCleanOrphanWikilinks(storage: NodeStorage): RuleResult {
  // Find wikilinks whose target_uuid is not in nodes table
  const orphanRows = storage.queryAll<{ source_uuid: string; target_uuid: string }>(
    `SELECT w.source_uuid, w.target_uuid
     FROM wikilinks w
     LEFT JOIN nodes n ON w.target_uuid = n.uuid
     WHERE n.uuid IS NULL`,
  );

  if (orphanRows.length === 0) {
    return { action: 'noop', affected_uuids: [], details: 'no orphan wikilinks found' };
  }

  for (const row of orphanRows) {
    storage.deleteWikilink(row.source_uuid, row.target_uuid);
  }

  return {
    action: 'deleted_orphan_wikilinks',
    affected_uuids: orphanRows.map((r) => r.source_uuid),
    details: `${orphanRows.length} orphan wikilink(s) removed`,
  };
}

/**
 * L1 rule: auto-consume a flag if it is a specific_issue with a clear resolution path.
 * Currently handles 'outdated' flags on synthesis nodes by archiving.
 */
export function autoConsumeSimpleFlag(
  storage: NodeStorage,
  flagQueue: FlagQueueService,
  oplog: OpLogService,
  agent_run_id: string,
  agent_id: string,
): RuleResult[] {
  const clearFlags = flagQueue.list({ status: 'pending', flag_type: 'specific_issue' });
  const results: RuleResult[] = [];

  for (const flag of clearFlags) {
    if (flag.issue_type === 'outdated' && flag.target_uuid) {
      // Archive the outdated synthesis; Hermes will regenerate on next review
      const candidates = storage.queryAll<{ uuid: string }>(
        `SELECT uuid FROM nodes WHERE uuid=? AND node_type='synthesis' AND status='active'`,
        [flag.target_uuid],
      );
      if (candidates.length > 0) {
        storage.archiveNode(flag.target_uuid, `auto-consume: outdated flag`);
        flagQueue.markAddressed(flag.flag_id, `auto-consume-${flag.flag_id.slice(0, 8)}`);
        oplog.append({
          agent_run_id,
          agent_id,
          op_type: 'revert',
          args: { uuid: flag.target_uuid, flag_id: flag.flag_id },
          reason: `auto-consume outdated flag on synthesis`,
          before_view_hash: '',
          after_view_hash: '',
          affected_uuids: [flag.target_uuid],
          branch_name: 'main',
        });
        results.push({
          action: 'consumed_outdated_flag',
          affected_uuids: [flag.target_uuid],
          details: flag.flag_id,
        });
      }
    }
  }
  return results;
}