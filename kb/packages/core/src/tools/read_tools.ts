import type { RegisterDeps } from './index.js';
import type { NodeBrief, OpLogFilter, QueryLogEntry, QueryLogFilter } from '@kb/shared';
import { search } from '../search/search.js';

export function registerReadTools(deps: RegisterDeps) {
  const { registry, storage, db, embedding, index, params } = deps;

  registry.register({
    name: 'search_knowledge',
    description:
      '在知识库中检索相关节点。三阶段:并行 KNN(raw + 非 cluster_review synthesis) → top-K 多簇扩展 → l1 距离排序。',
    permission_tag: 'read',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        k_raw: { type: 'integer', default: 10 },
        k_synthesis: { type: 'integer', default: 5 },
      },
      required: ['query'],
    },
    handler: async (args, ctx) => {
      const query = String(args.query);
      const k_raw = Number(args.k_raw ?? 10);
      const k_synthesis = Number(args.k_synthesis ?? 5);
      return await search({ db, storage, embedding, index, params }, query, k_raw, k_synthesis, ctx);
    },
  });

  registry.register({
    name: 'read_node',
    description: '读取单个节点的完整内容,可选择是否包含 body。',
    permission_tag: 'read',
    parameters: {
      type: 'object',
      properties: {
        uuid: { type: 'string' },
        include_body: { type: 'boolean', default: true },
      },
      required: ['uuid'],
    },
    handler: async (args) => {
      const uuid = String(args.uuid);
      const include_body = args.include_body !== false;
      const node = storage.readNode(uuid);
      if (!node) return { error: 'not found' };
      return include_body ? node : { ...node, body: undefined };
    },
  });

  registry.register({
    name: 'read_full',
    description: 'L1 → L2 升级:返回节点的完整 body。用于权威验证、具体引文等少数情况。',
    permission_tag: 'read',
    parameters: {
      type: 'object',
      properties: { uuid: { type: 'string' } },
      required: ['uuid'],
    },
    handler: async (args) => {
      const node = storage.readNode(String(args.uuid));
      if (!node) return { error: 'not found' };
      return { uuid: node.uuid, body: node.body, l0_summary: node.l0_summary, l1_overview: node.l1_overview };
    },
  });

  registry.register({
    name: 'list_nodes',
    description: '列出节点,支持按 node_type、cluster_id、status、hub_role、synthesis_subtype 过滤。',
    permission_tag: 'read',
    parameters: {
      type: 'object',
      properties: {
        node_type: { type: 'string', enum: ['raw', 'synthesis', 'reflection'] },
        cluster_id: { type: 'integer' },
        status: { type: 'string', enum: ['active', 'archived', 'superseded'] },
        hub_role_value: { type: 'string', enum: ['root', 'center', 'leaf', 'neutral'] },
        synthesis_subtype: { type: 'string' },
        exclude_subtype: { type: 'string' },
        limit: { type: 'integer', default: 50 },
        offset: { type: 'integer', default: 0 },
      },
    },
    handler: async (args) => {
      const nodes: NodeBrief[] = storage.listNodes({
        node_type: args.node_type as never,
        cluster_id: args.cluster_id as never,
        status: args.status as never,
        hub_role_value: args.hub_role_value as never,
        synthesis_subtype: args.synthesis_subtype as never,
        exclude_subtype: args.exclude_subtype as never,
        limit: args.limit as never,
        offset: args.offset as never,
      });
      return { nodes };
    },
  });

  registry.register({
    name: 'get_cluster_info',
    description: '获取簇的元数据 + 成员列表 + 当前 hub 信息。',
    permission_tag: 'read',
    parameters: {
      type: 'object',
      properties: { cluster_id: { type: 'integer' } },
      required: ['cluster_id'],
    },
    handler: async (args) => {
      const cid = Number(args.cluster_id);
      const cluster = db.prepare('SELECT * FROM clusters WHERE cluster_id=?').get(cid);
      if (!cluster) return { error: 'cluster not found' };
      const members = storage.listNodes({ cluster_id: cid });
      return { ...cluster, members };
    },
  });

  registry.register({
    name: 'inspect_cluster',
    description:
      'v1.3 §11.2 专用入口:返回簇的 cluster_review 完整内容 + 成员列表 + hub 信息。普通 search_knowledge 不返回 cluster_review。',
    permission_tag: 'read',
    parameters: {
      type: 'object',
      properties: { cluster_id: { type: 'integer' } },
      required: ['cluster_id'],
    },
    handler: async (args) => {
      const cid = Number(args.cluster_id);
      const cluster = db.prepare('SELECT * FROM clusters WHERE cluster_id=?').get(cid) as
        | {
            cluster_id: number;
            hub_uuid: string | null;
            hub_source: string | null;
            friction_count: number;
            last_review_at: string | null;
            member_count: number;
          }
        | undefined;
      if (!cluster) return { error: 'cluster not found' };
      const review = db
        .prepare(
          "SELECT uuid FROM nodes WHERE node_type='synthesis' AND synthesis_subtype='cluster_review' AND status='active' AND reviewed_cluster_id=? ORDER BY created_at DESC LIMIT 1",
        )
        .get(cid) as { uuid: string } | undefined;
      const reviewNode = review ? storage.readNode(review.uuid) : null;
      const members = storage.listNodes({ cluster_id: cid });
      return {
        cluster,
        cluster_review: reviewNode,
        members,
      };
    },
  });

  registry.register({
    name: 'traverse_graph',
    description: '从起点 uuid 出发做显式图遍历,支持边类型过滤和路径返回。用于 Agent 主动探索,不是默认检索。',
    permission_tag: 'read',
    parameters: {
      type: 'object',
      properties: {
        start_uuid: { type: 'string' },
        max_hops: { type: 'integer', default: 2 },
        limit: { type: 'integer', default: 50 },
        edge_types: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['wikilink_out', 'wikilink_in', 'source_to_synthesis', 'synthesis_to_sources', 'cluster_member', 'cluster_hub'],
          },
        },
      },
      required: ['start_uuid'],
    },
    handler: async (args) => {
      const start = String(args.start_uuid);
      const maxHops = Number(args.max_hops ?? 2);
      const limit = Number(args.limit ?? 50);
      const requested = Array.isArray(args.edge_types)
        ? new Set(args.edge_types.map(String))
        : new Set(['wikilink_out', 'wikilink_in', 'source_to_synthesis', 'synthesis_to_sources']);
      type PathEdge = { from_uuid: string; to_uuid: string; edge_type: string };
      type Visit = { hops: number; via_edge_type: string | null; from_uuid: string | null; path: PathEdge[] };
      const visited = new Map<string, Visit>();
      const frontier: string[] = [start];
      visited.set(start, { hops: 0, via_edge_type: null, from_uuid: null, path: [] });
      while (frontier.length > 0) {
        const cur = frontier.shift()!;
        const state = visited.get(cur)!;
        if (state.hops >= maxHops) continue;
        if (visited.size >= limit) break;
        const out: { uuid: string; edge_type: string }[] = [];
        if (requested.has('wikilink_out')) {
          out.push(...db.prepare('SELECT target_uuid AS uuid FROM wikilinks WHERE source_uuid=?').all(cur).map((r: any) => ({ uuid: r.uuid, edge_type: 'wikilink_out' })));
        }
        if (requested.has('wikilink_in')) {
          out.push(...db.prepare('SELECT source_uuid AS uuid FROM wikilinks WHERE target_uuid=?').all(cur).map((r: any) => ({ uuid: r.uuid, edge_type: 'wikilink_in' })));
        }
        if (requested.has('source_to_synthesis')) {
          out.push(...db.prepare('SELECT synthesis_uuid AS uuid FROM synthesis_sources WHERE source_uuid=?').all(cur).map((r: any) => ({ uuid: r.uuid, edge_type: 'source_to_synthesis' })));
        }
        if (requested.has('synthesis_to_sources')) {
          out.push(...db.prepare('SELECT source_uuid AS uuid FROM synthesis_sources WHERE synthesis_uuid=?').all(cur).map((r: any) => ({ uuid: r.uuid, edge_type: 'synthesis_to_sources' })));
        }
        if (requested.has('cluster_member')) {
          const row = db.prepare('SELECT cluster_id FROM nodes WHERE uuid=?').get(cur) as { cluster_id: number | null } | undefined;
          if (row?.cluster_id != null) {
            out.push(...db.prepare("SELECT uuid FROM nodes WHERE cluster_id=? AND uuid!=? AND status='active' AND node_type='raw' LIMIT 10").all(row.cluster_id, cur).map((r: any) => ({ uuid: r.uuid, edge_type: 'cluster_member' })));
          }
        }
        if (requested.has('cluster_hub')) {
          const row = db.prepare('SELECT c.hub_uuid AS uuid FROM nodes n JOIN clusters c ON c.cluster_id=n.cluster_id WHERE n.uuid=? AND c.hub_uuid IS NOT NULL').get(cur) as { uuid: string } | undefined;
          if (row?.uuid) out.push({ uuid: row.uuid, edge_type: 'cluster_hub' });
        }
        for (const r of out) {
          if (visited.size >= limit) break;
          if (!visited.has(r.uuid)) {
            const edge = { from_uuid: cur, to_uuid: r.uuid, edge_type: r.edge_type };
            visited.set(r.uuid, {
              hops: state.hops + 1,
              via_edge_type: r.edge_type,
              from_uuid: cur,
              path: [...state.path, edge],
            });
            frontier.push(r.uuid);
          }
        }
      }
      return {
        nodes: [...visited.entries()].map(([uuid, v]) => ({ uuid, ...v })),
      };
    },
  });

  registry.register({
    name: 'get_op_log',
    description: '查询操作日志。',
    permission_tag: 'read',
    parameters: {
      type: 'object',
      properties: {
        since: { type: 'string' },
        until: { type: 'string' },
        agent_id: { type: 'string' },
        op_type: { type: 'string' },
        branch: { type: 'string' },
        limit: { type: 'integer', default: 100 },
      },
    },
    handler: async (args) => {
      return { entries: deps.oplog.list(args as OpLogFilter) };
    },
  });

  registry.register({
    name: 'get_query_log',
    description: '查询用户/Agent 的检索日志。',
    permission_tag: 'read',
    parameters: {
      type: 'object',
      properties: {
        since: { type: 'string' },
        queried_by: { type: 'string' },
        limit: { type: 'integer', default: 100 },
      },
    },
    handler: async (args) => {
      const filter = args as QueryLogFilter;
      const where: string[] = [];
      const queryParams: Record<string, unknown> = {};
      if (filter.since) {
        where.push('timestamp >= $since');
        queryParams.since = filter.since;
      }
      if (filter.queried_by) {
        where.push('queried_by = $queried_by');
        queryParams.queried_by = filter.queried_by;
      }
      const limit = filter.limit ?? 100;
      const sql = `SELECT * FROM query_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY timestamp DESC LIMIT ${limit}`;
      const rows = db.prepare(sql).all(queryParams) as RawQueryRow[];
      return { entries: rows.map(rowToQueryEntry) };
    },
  });

  // v2.0 Hermes Optimizer §6 — hermes-category read tools

  registry.register({
    name: 'read_heartbeat',
    description: '读取 KB 当前 heartbeat.md 内容，了解 KB 整体状态和开放循环。',
    permission_tag: 'read',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const content = storage.readHeartbeat();
      return { heartbeat: content, available: content !== null };
    },
  });

  registry.register({
    name: 'get_hermes_status',
    description: '返回 KB health 摘要 + heartbeat 内容。外部 agent 兼职时的操作手册。',
    permission_tag: 'read',
    parameters: {
      type: 'object',
      properties: {
        include_heartbeat: { type: 'boolean', default: true },
        include_queue_depth: { type: 'boolean', default: true },
      },
    },
    handler: async (args: { include_heartbeat?: boolean; include_queue_depth?: boolean }) => {
      const counts = storage.countByStatus();
      const clusterCount = storage.countActiveClusters();
      const frictionClusters = storage.listFrictionClusters();
      const queueDepth = args.include_queue_depth !== false ? storage.countPendingOptimizationItems() : null;
      const heartbeat = args.include_heartbeat !== false ? storage.readHeartbeat() : null;
      const flagCounts = deps.flagQueue?.countByStatus?.() ?? null;

      return {
        kb_version: '2.0',
        node_counts: counts,
        cluster_count: clusterCount,
        friction_clusters: frictionClusters,
        optimization_queue_depth: queueDepth,
        flag_queue_counts: flagCounts,
        heartbeat,
      };
    },
  });
}

interface RawQueryRow {
  query_id: string;
  timestamp: string;
  queried_by: string;
  query_text: string;
  raw_hits: string;
  synthesis_hits: string;
  raw_after_expansion: string;
  final_used: string;
  flagged_issues: string | null;
  answer_adopted: number | null;
}

function rowToQueryEntry(row: RawQueryRow): QueryLogEntry {
  return {
    query_id: row.query_id,
    timestamp: row.timestamp,
    queried_by: row.queried_by as QueryLogEntry['queried_by'],
    query_text: row.query_text,
    raw_hits: JSON.parse(row.raw_hits),
    synthesis_hits: JSON.parse(row.synthesis_hits),
    raw_after_expansion: JSON.parse(row.raw_after_expansion),
    final_used: JSON.parse(row.final_used),
    flagged_issues: row.flagged_issues ? JSON.parse(row.flagged_issues) : null,
    answer_adopted: (row.answer_adopted as 0 | 1 | null) ?? null,
  };
}
