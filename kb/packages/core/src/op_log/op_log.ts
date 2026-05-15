import crypto from 'node:crypto';
import type { DB } from '../storage/db.js';
import type { OpLogEntry, OpLogFilter, OpType } from '@kb/shared';
import { newUuid } from '../util/uuid.js';
import { nowIso } from '../util/now.js';
import { bus } from '../events/bus.js';

export interface AppendInput {
  agent_run_id: string;
  agent_id: string;
  op_type: OpType;
  args: Record<string, unknown>;
  reason: string;
  affected_uuids: string[];
  before_view_hash?: string;
  after_view_hash?: string;
  branch_name?: string;
}

export class OpLogService {
  private db: DB;
  private currentBranch = 'main';
  constructor(db: DB) {
    this.db = db;
  }

  setBranch(name: string) {
    this.currentBranch = name;
  }
  getBranch(): string {
    return this.currentBranch;
  }

  append(input: AppendInput): OpLogEntry {
    const op_id = newUuid();
    const ts = nowIso();
    const entry: OpLogEntry = {
      op_id,
      timestamp: ts,
      agent_run_id: input.agent_run_id,
      agent_id: input.agent_id,
      op_type: input.op_type,
      args: input.args,
      reason: input.reason,
      before_view_hash: input.before_view_hash ?? this.viewHash(),
      after_view_hash: input.after_view_hash ?? '',
      affected_uuids: input.affected_uuids,
      reverted_by: null,
      branch_name: input.branch_name ?? this.currentBranch,
    };
    this.db
      .prepare(
        `INSERT INTO op_log (
           op_id, timestamp, agent_run_id, agent_id, op_type, args, reason,
           before_view_hash, after_view_hash, affected_uuids, reverted_by, branch_name
         ) VALUES (
           @op_id, @timestamp, @agent_run_id, @agent_id, @op_type, @args, @reason,
           @before_view_hash, @after_view_hash, @affected_uuids, NULL, @branch_name
         )`,
      )
      .run({
        ...entry,
        args: JSON.stringify(entry.args),
        affected_uuids: JSON.stringify(entry.affected_uuids),
      });
    bus.publish({ type: 'op_log_appended', op_id });
    return entry;
  }

  list(filter: OpLogFilter = {}): OpLogEntry[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.since) {
      where.push('timestamp >= $since');
      params.since = filter.since;
    }
    if (filter.until) {
      where.push('timestamp <= $until');
      params.until = filter.until;
    }
    if (filter.agent_id) {
      where.push('agent_id = $agent_id');
      params.agent_id = filter.agent_id;
    }
    if (filter.op_type) {
      where.push('op_type = $op_type');
      params.op_type = filter.op_type;
    }
    if (filter.branch) {
      where.push('branch_name = $branch');
      params.branch = filter.branch;
    }
    const limit = filter.limit ?? 200;
    const sql = `SELECT * FROM op_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY timestamp DESC LIMIT ${limit}`;
    const rows = this.db.prepare(sql).all(params) as RawOpLogRow[];
    return rows.map(rowToEntry);
  }

  byId(op_id: string): OpLogEntry | null {
    const row = this.db.prepare('SELECT * FROM op_log WHERE op_id = ?').get(op_id) as
      | RawOpLogRow
      | undefined;
    return row ? rowToEntry(row) : null;
  }

  blame(uuid: string): OpLogEntry[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM op_log WHERE affected_uuids LIKE '%' || ? || '%' ORDER BY timestamp ASC",
      )
      .all(uuid) as RawOpLogRow[];
    return rows.map(rowToEntry).filter((e) => e.affected_uuids.includes(uuid));
  }

  markReverted(op_id: string, by: string) {
    this.db.prepare('UPDATE op_log SET reverted_by=? WHERE op_id=?').run(by, op_id);
  }

  laterDependents(op: OpLogEntry): OpLogEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM op_log
         WHERE timestamp > ?
           AND branch_name = ?
           AND reverted_by IS NULL
         ORDER BY timestamp ASC`,
      )
      .all(op.timestamp, op.branch_name) as RawOpLogRow[];
    const target = new Set(op.affected_uuids);
    return rows
      .map(rowToEntry)
      .filter((e) => e.op_id !== op.op_id && e.affected_uuids.some((u) => target.has(u)));
  }

  private viewHash(): string {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS c, MAX(updated_at) AS m FROM nodes WHERE status='active'",
      )
      .get() as { c: number; m: string | null };
    return crypto
      .createHash('sha256')
      .update(`${row.c}|${row.m ?? ''}`)
      .digest('hex')
      .slice(0, 16);
  }
}

interface RawOpLogRow {
  op_id: string;
  timestamp: string;
  agent_run_id: string;
  agent_id: string;
  op_type: OpType;
  args: string;
  reason: string;
  before_view_hash: string;
  after_view_hash: string;
  affected_uuids: string;
  reverted_by: string | null;
  branch_name: string;
}

function rowToEntry(row: RawOpLogRow): OpLogEntry {
  return {
    op_id: row.op_id,
    timestamp: row.timestamp,
    agent_run_id: row.agent_run_id,
    agent_id: row.agent_id,
    op_type: row.op_type,
    args: JSON.parse(row.args),
    reason: row.reason,
    before_view_hash: row.before_view_hash,
    after_view_hash: row.after_view_hash,
    affected_uuids: JSON.parse(row.affected_uuids),
    reverted_by: row.reverted_by,
    branch_name: row.branch_name,
  };
}
