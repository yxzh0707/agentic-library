import type { DB } from '../storage/db.js';
import type { FlagItem, FlagType, FlagIssueType, FlagStatus } from '@kb/shared';
import { newUuid } from '../util/uuid.js';
import { nowIso } from '../util/now.js';
import { bus } from '../events/bus.js';

export interface FlagAppendInput {
  flag_type: FlagType;
  target_uuid?: string | null;
  target_cluster_id?: number | null;
  issue_type?: FlagIssueType | null;
  description: string;
  flagged_by: string;
}

export interface FlagListFilter {
  status?: FlagStatus;
  flag_type?: FlagType;
  cluster_id?: number;
  limit?: number;
}

/**
 * v1.3 §7.2 / §9.1 — consultant-side flag queue. Two flag types:
 *   - specific_issue: a precise complaint about one node
 *   - cluster_friction: a trend-style complaint about a cluster (also bumps clusters.friction_count)
 * Librarian consumes via background pass / next on_review.
 */
export class FlagQueueService {
  constructor(private db: DB) {}

  append(input: FlagAppendInput): FlagItem {
    const flag_id = newUuid();
    const flagged_at = nowIso();
    this.db
      .prepare(
        `INSERT INTO flag_queue (
           flag_id, flag_type, target_uuid, target_cluster_id, issue_type,
           description, flagged_at, flagged_by, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(
        flag_id,
        input.flag_type,
        input.target_uuid ?? null,
        input.target_cluster_id ?? null,
        input.issue_type ?? null,
        input.description,
        flagged_at,
        input.flagged_by,
      );
    if (input.flag_type === 'cluster_friction' && input.target_cluster_id !== null && input.target_cluster_id !== undefined) {
      this.db
        .prepare('UPDATE clusters SET friction_count = friction_count + 1 WHERE cluster_id=?')
        .run(input.target_cluster_id);
    }
    bus.publish({
      type: 'flag_queue_appended',
      flag_id,
      flag_type: input.flag_type,
      description: input.description,
    });
    return {
      flag_id,
      flag_type: input.flag_type,
      target_uuid: input.target_uuid ?? null,
      target_cluster_id: input.target_cluster_id ?? null,
      issue_type: input.issue_type ?? null,
      description: input.description,
      flagged_at,
      flagged_by: input.flagged_by,
      status: 'pending',
      addressed_by_op_id: null,
      addressed_at: null,
    };
  }

  byId(flag_id: string): FlagItem | null {
    const row = this.db
      .prepare('SELECT * FROM flag_queue WHERE flag_id=?')
      .get(flag_id) as FlagItem | undefined;
    return row ?? null;
  }

  list(filter: FlagListFilter = {}): FlagItem[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      where.push('status=?');
      params.push(filter.status);
    }
    if (filter.flag_type) {
      where.push('flag_type=?');
      params.push(filter.flag_type);
    }
    if (typeof filter.cluster_id === 'number') {
      where.push('target_cluster_id=?');
      params.push(filter.cluster_id);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = filter.limit ?? 100;
    return this.db
      .prepare(`SELECT * FROM flag_queue ${whereSql} ORDER BY flagged_at DESC LIMIT ?`)
      .all(...params, limit) as FlagItem[];
  }

  countByStatus(): Record<FlagStatus, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS c FROM flag_queue GROUP BY status')
      .all() as { status: FlagStatus; c: number }[];
    const out: Record<FlagStatus, number> = { pending: 0, addressed: 0, dismissed: 0 };
    for (const r of rows) out[r.status] = r.c;
    return out;
  }

  /** Mark a flag as addressed (resolution pointed to an op_log entry). */
  markAddressed(flag_id: string, opId: string): boolean {
    const ts = nowIso();
    const res = this.db
      .prepare(
        "UPDATE flag_queue SET status='addressed', addressed_by_op_id=?, addressed_at=? WHERE flag_id=? AND status='pending'",
      )
      .run(opId, ts, flag_id);
    return res.changes > 0;
  }

  /** Mark a flag as dismissed (false positive / not actionable). */
  dismiss(flag_id: string): boolean {
    const ts = nowIso();
    const res = this.db
      .prepare(
        "UPDATE flag_queue SET status='dismissed', addressed_at=? WHERE flag_id=? AND status='pending'",
      )
      .run(ts, flag_id);
    return res.changes > 0;
  }
}
