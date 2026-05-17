import type { RegisterDeps } from './index.js';
import type { NodeBrief, OpLogFilter, QueryLogEntry, QueryLogFilter } from '@kb/shared';
import { search } from '../search/search.js';
import { loadInsightInput, godNodes } from '../graph/insights.js';

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
    name: 'batch_read',
    description: '批量读取多个节点的完整内容。一次调用返回所有节点，节省 HTTP 往返。是深度分析时最常用的工具。',
    permission_tag: 'read',
    parameters: {
      type: 'object',
      properties: {
        uuids: { type: 'array', items: { type: 'string' }, description: '要读取的 UUID 列表' },
        include_body: { type: 'boolean', default: true },
      },
      required: ['uuids'],
    },
    handler: async (args) => {
      const uuids = Array.isArray(args.uuids) ? args.uuids.map(String) : [];
      const include_body = args.include_body !== false;
      const nodes: Record<string, unknown>[] = [];
      for (const uuid of uuids.slice(0, 50)) {
        const node = storage.readNode(uuid);
        if (!node) continue;
        nodes.push(include_body ? node : { ...node, body: undefined });
      }
      return { nodes, total: nodes.length, requested: uuids.length };
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

  // ===== Hermes Agent 深度分析工具 v2.1 =====

  registry.register({
    name: 'deep_analyze',
    description: '深度分析工具:接受一个问题/查询,自动执行 search_knowledge → 读取 top 节点 → 图遍历扩展 → synthesis 归档。返回完整的分析结果。',
    permission_tag: 'read',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '分析问题' },
        k_raw: { type: 'integer', default: 5, description: '检索的 raw 节点数' },
        k_synthesis: { type: 'integer', default: 3, description: '检索的 synthesis 节点数' },
        max_traverse_hops: { type: 'integer', default: 1, description: '图遍历跳数(0=不遍历)' },
        save_as_synthesis: { type: 'boolean', default: true, description: '是否将分析结果保存为 synthesis 节点(通过 quality gate)' },
      },
      required: ['query'],
    },
    handler: async (args, ctx) => {
      const query = String(args.query);
      const kRaw = Number(args.k_raw ?? 5);
      const kSynth = Number(args.k_synthesis ?? 3);
      const maxHops = Number(args.max_traverse_hops ?? 1);
      const svAsSynth = args.save_as_synthesis !== false;

      // Phase 1: Search
      const searchResult = await search({ db, storage, embedding, index, params }, query, kRaw, kSynth, ctx);
      const rawHits = (searchResult as any)?.raw ?? [];
      const synthHits = (searchResult as any)?.synthesis ?? [];
      const allHits = [...rawHits.slice(0, 5), ...synthHits.slice(0, 3)];

      // Phase 2: Read content
      const readNodes: Record<string, { l0: string; l1: string; body: string; cluster: number | null }> = {};
      for (const h of allHits) {
        if (!h.uuid) continue;
        const node = storage.readNode(h.uuid);
        if (node) readNodes[h.uuid] = { l0: node.l0_summary, l1: node.l1_overview, body: node.body?.slice(0, 3000) ?? '', cluster: node.derived_state?.cluster_id ?? null };
      }

      // Phase 3: Traverse
      const sourceUuids = Object.keys(readNodes);
      const traversedUuids: string[] = [];
      if (maxHops > 0) {
        for (const uid of sourceUuids.slice(0, 3)) {
          const out = db.prepare('SELECT target_uuid AS uid FROM wikilinks WHERE source_uuid=?').all(uid) as { uid: string }[];
          const inp = db.prepare('SELECT source_uuid AS uid FROM wikilinks WHERE target_uuid=?').all(uid) as { uid: string }[];
          for (const r of [...out, ...inp]) { if (!traversedUuids.includes(r.uid)) traversedUuids.push(r.uid); }
        }
        for (const uid of traversedUuids.slice(0, 10)) {
          const node = storage.readNode(uid);
          if (node && !readNodes[uid]) readNodes[uid] = { l0: node.l0_summary, l1: node.l1_overview, body: node.body?.slice(0, 1000) ?? '', cluster: node.derived_state?.cluster_id ?? null };
        }
      }

      // Phase 4: Save as synthesis (through proper gating pipeline)
      let synthesisUuid: string | null = null;
      let gateResult: string | null = null;
      if (svAsSynth && sourceUuids.length > 0 && deps.synthesis) {
        try {
          const result = await deps.synthesis.generateExplicit({
            source_uuids: sourceUuids.slice(0, 5),
            subtype_hint: 'consolidation',
            instruction: `Deep analysis query: ${query}. Synthesize findings from ${sourceUuids.length} related nodes.`,
            bypass_pre_gates: true,
            reason: `deep_analyze: ${query.slice(0, 100)}`,
            ctx,
          });
          if ('rejected' in result) {
            gateResult = `rejected: ${result.reason}`;
          } else {
            synthesisUuid = result.node.uuid;
            gateResult = 'created';
          }
        } catch (err) {
          gateResult = `error: ${String(err)}`;
        }
      }

      return {
        query,
        total_sources: Object.keys(readNodes).length,
        traversed: traversedUuids.length,
        sources: Object.entries(readNodes).map(([uuid, n]) => ({ uuid, l0_summary: n.l0, cluster_id: n.cluster, body_excerpt: n.body.slice(0, 500) })),
        synthesis_uuid: synthesisUuid,
        synthesis_gate: gateResult,
        note: synthesisUuid ? 'Analysis saved with quality gate. Embeddings generated by librarian.' : gateResult ? `Synthesis rejected by gate: ${gateResult}` : 'Not saved.',
      };
    },
  });

  // ===== Agent 即插即用工具 v2.2 =====

  registry.register({
    name: 'agent_onboarding',
    description: 'Agent 首次接入的着陆页。返回 KB 全局快照、核心知识图谱、最近活动、待处理问题和操作指南。任何外部 Agent 接入后应先调此工具了解 KB 全貌。',
    permission_tag: 'read',
    parameters: { type: 'object', properties: {
      include_god_nodes: { type: 'boolean', default: true },
      include_recent_reflections: { type: 'boolean', default: true },
      include_flag_summary: { type: 'boolean', default: true },
      god_nodes_top: { type: 'integer', default: 8 },
      reflections_limit: { type: 'integer', default: 5 },
    }},
    handler: async (args) => {
      const out: Record<string, unknown> = {};
      
      // 1. KB health snapshot
      const counts = storage.countByStatus();
      const clusterCount = storage.countActiveClusters();
      out.kb_snapshot = {
        version: '2.1',
        nodes_total: counts.total,
        nodes_raw: counts.raw,
        nodes_synthesis: counts.synthesis,
        nodes_reflection: counts.reflection,
        pending_embed: counts.pending_embed,
        clusters: clusterCount,
      };

      // 2. Cluster map
      const clusterRows = db.prepare("SELECT cluster_id, member_count, description, hub_uuid FROM clusters WHERE status='active' ORDER BY member_count DESC").all() as { cluster_id: number; member_count: number; description: string | null; hub_uuid: string | null }[];
      out.cluster_map = clusterRows.map((c) => ({
        id: c.cluster_id,
        members: c.member_count,
        description: c.description ?? '(no description)',
        hub: c.hub_uuid?.slice(0, 8) ?? null,
      }));

      // 3. God nodes
      if (args.include_god_nodes !== false) {
        const top = Number(args.god_nodes_top ?? 8);
        const input = loadInsightInput(db);
        out.god_nodes = godNodes(input, top);
      }

      // 4. Recent reflections
      if (args.include_recent_reflections !== false) {
        const limit = Number(args.reflections_limit ?? 5);
        const rows = db.prepare("SELECT uuid, l0_summary, created_at, synthesis_subtype FROM nodes WHERE node_type='reflection' AND status='active' ORDER BY created_at DESC LIMIT ?").all(limit) as { uuid: string; l0_summary: string; created_at: string; synthesis_subtype: string | null }[];
        out.recent_reflections = rows.map((r) => ({ uuid: r.uuid, summary: r.l0_summary, subtype: r.synthesis_subtype, created: r.created_at?.slice(0, 10) }));
      }

      // 5. Flag queue summary
      if (args.include_flag_summary !== false && deps.flagQueue) {
        const cts = deps.flagQueue.countByStatus();
        out.flag_queue = { pending: cts.pending, addressed: cts.addressed, dismissed: cts.dismissed };
      }

      // 6. Quick-start guide (generated from available tools)
      out.quick_start = {
        overview: `KB has ${clusterCount} clusters, ${counts.total} active nodes.`,
        recommended_first_steps: [
          'Call suggest_context with your current task to find relevant nodes and past reflections.',
          'Use deep_analyze for comprehensive search + read + traverse + synthesize.',
          'After completing a task, call create_reflection to store your reasoning trace.',
          'Use list_reflections to check if past thinking applies to your current problem.',
        ],
        common_tools: {
          search: 'search_knowledge — semantic search across all nodes',
          read: 'read_node — get full content by UUID',
          traverse: 'traverse_graph — explore related nodes from a starting UUID',
          analyze: 'deep_analyze — one-shot search + read + traverse + synthesize',
          reflect: 'create_reflection — store CoT trace as permanent KB node',
        },
        note: `Full tool list: POST /api/agent/list_tools with agent_id + api_key. Total tools available: ${registry.list().length}.`,
      };

      return out;
    },
  });

  registry.register({
    name: 'suggest_context',
    description: '给定 Agent 当前任务描述，自动搜索 KB 并建议相关上下文：相关节点、过去的 reflection、同簇的开放问题。帮助 Agent 在思考前快速获取背景知识。',
    permission_tag: 'read',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '当前任务描述(越具体越好)' },
        k: { type: 'integer', default: 8, description: '返回的建议数' },
        include_reflections: { type: 'boolean', default: true },
        include_flags: { type: 'boolean', default: false },
      },
      required: ['task'],
    },
    handler: async (args, ctx) => {
      const task = String(args.task);
      const k = Number(args.k ?? 8);
      
      // Search for related nodes
      const searchResult = await search({ db, storage, embedding, index, params }, task, k, Math.min(k, 5), ctx);
      const rawHits = (searchResult as any)?.raw ?? [];
      const synthHits = (searchResult as any)?.synthesis ?? [];
      
      // Get related cluster IDs
      const clusterIds = new Set<number>();
      const seen = new Set<string>();
      const suggestions: Array<{ type: string; uuid: string; summary: string }> = [];
      
      for (const h of [...rawHits, ...synthHits]) {
        if (!h.uuid || seen.has(h.uuid)) continue;
        seen.add(h.uuid);
        const node = storage.readNode(h.uuid);
        if (node && node.derived_state?.cluster_id) clusterIds.add(node.derived_state.cluster_id);
        suggestions.push({ type: 'node', uuid: h.uuid, summary: h.l0_summary || node?.l0_summary || '' });
      }
      
      // Search for related reflections — ranked by task relevance
      if (args.include_reflections !== false) {
        const taskWords = new Set(task.toLowerCase().split(/\s+/).filter((w: string) => w.length > 2));
        const reflRows = db.prepare("SELECT uuid, l0_summary FROM nodes WHERE node_type='reflection' AND status='active'").all() as { uuid: string; l0_summary: string }[];
        // Score by word overlap with task
        const scored = reflRows.map((r) => {
          const text = r.l0_summary.toLowerCase();
          let score = 0;
          for (const w of taskWords) if (text.includes(w)) score++;
          return { ...r, score };
        });
        scored.sort((a, b) => b.score - a.score);
        for (const r of scored.slice(0, 8)) {
          if (seen.has(r.uuid)) continue;
          suggestions.push({ type: 'reflection', uuid: r.uuid, summary: r.l0_summary });
        }
      }
      
      // Surface open flags in related clusters
      if (args.include_flags && deps.flagQueue && clusterIds.size > 0) {
        for (const cid of [...clusterIds].slice(0, 3)) {
          const flags = deps.flagQueue.list({ cluster_id: cid, status: 'pending', limit: 3 });
          for (const f of flags) {
            suggestions.push({ type: 'flag', uuid: f.flag_id, summary: `[${f.flag_type}] ${f.description?.slice(0, 80)}` });
          }
        }
      }
      
      return {
        task,
        suggestions: suggestions.slice(0, k),
        related_clusters: [...clusterIds],
        hint: 'Use read_node to explore suggestions, deep_analyze for comprehensive analysis.',
      };
    },
  });

  registry.register({
    name: 'list_reflections',
    description: '列出所有 reflection 节点(Agent 的元认知痕迹)，按创建时间倒序。可过滤 subtype。用于检查之前的思考是否有可复用的 insight。',
    permission_tag: 'read',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', default: 20 },
        subtype: { type: 'string', enum: ['decision', 'failure_analysis', 'retrieval_strategy', 'plan', 'critique', 'postmortem'] },
        since: { type: 'string', description: 'ISO 日期，只返回此日期之后创建的' },
      },
    },
    handler: async (args) => {
      const limit = Number(args.limit ?? 20);
      let sql = "SELECT uuid, l0_summary, synthesis_subtype, created_at FROM nodes WHERE node_type='reflection' AND status='active'";
      const params: Array<string | number> = [];
      if (args.subtype) { sql += ' AND synthesis_subtype=?'; params.push(String(args.subtype)); }
      if (args.since) { sql += ' AND created_at>=?'; params.push(String(args.since)); }
      sql += ' ORDER BY created_at DESC LIMIT ?'; params.push(limit);
      const rows = db.prepare(sql).all(...params) as { uuid: string; l0_summary: string; synthesis_subtype: string | null; created_at: string }[];
      return {
        reflections: rows.map((r) => ({ uuid: r.uuid, summary: r.l0_summary, subtype: r.synthesis_subtype, created: r.created_at?.slice(0, 16) })),
        total: rows.length,
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
