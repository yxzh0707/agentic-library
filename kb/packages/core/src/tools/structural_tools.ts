import type { RegisterDeps } from './index.js';
import type { HubRoleValue, OpType, SynthesisSubtype } from '@kb/shared';

export function registerStructuralTools(deps: RegisterDeps) {
  const { registry, storage, oplog, db, synthesis } = deps;

  function recordOp(
    op_type: OpType,
    args: Record<string, unknown>,
    reason: string,
    affected_uuids: string[],
    ctx: { agent_id: string; agent_run_id: string },
  ): string {
    return oplog.append({
      agent_run_id: ctx.agent_run_id,
      agent_id: ctx.agent_id,
      op_type,
      args,
      reason,
      affected_uuids,
    }).op_id;
  }

  registry.register({
    name: 'op_move',
    description: '把节点的 current_path 移到另一个路径。',
    permission_tag: 'structural',
    parameters: {
      type: 'object',
      properties: {
        uuid: { type: 'string' },
        to_path: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['uuid', 'to_path', 'reason'],
    },
    handler: async (args, ctx) => {
      const uuid = String(args.uuid);
      const toPath = String(args.to_path);
      const reason = String(args.reason);
      const before = storage.readNode(uuid);
      if (!before) return { error: 'not found' };
      const fromPath = before.current_path;
      storage.setCurrentPath(uuid, toPath);
      const op_id = recordOp('move', { uuid, from_path: fromPath, to_path: toPath }, reason, [uuid], ctx);
      return { op_id };
    },
  });

  registry.register({
    name: 'op_merge',
    description: '把两个簇合并(把 cluster_b 的成员重标到 cluster_a),触发新 cluster_review 生成。',
    permission_tag: 'structural',
    parameters: {
      type: 'object',
      properties: {
        cluster_a: { type: 'integer' },
        cluster_b: { type: 'integer' },
        into_path: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['cluster_a', 'cluster_b', 'reason'],
    },
    handler: async (args, ctx) => {
      const a = Number(args.cluster_a);
      const b = Number(args.cluster_b);
      const reason = String(args.reason);
      const into = (args.into_path as string | undefined) ?? `/cluster_${a}`;
      const movedRows = db
        .prepare("SELECT uuid FROM nodes WHERE cluster_id=? AND status='active'")
        .all(b) as { uuid: string }[];
      const moved = movedRows.map((r) => r.uuid);
      const tx = db.transaction(() => {
        db.prepare('UPDATE nodes SET cluster_id=? WHERE cluster_id=?').run(a, b);
        db.prepare("UPDATE clusters SET status='merged' WHERE cluster_id=?").run(b);
      });
      tx();
      for (const uuid of moved) storage.setCurrentPath(uuid, into);
      const op_id = recordOp(
        'merge',
        { cluster_a: a, cluster_b: b, into_path: into, moved_uuids: moved },
        reason,
        moved,
        ctx,
      );
      // v1.3 §10.4 — trigger cluster_review regen for merged cluster
      void synthesis.regenerateClusterReviewForMerge([a, b], a, ctx);
      return { op_id, moved_count: moved.length };
    },
  });

  registry.register({
    name: 'op_split',
    description:
      '把一个簇拆成多个,sub_assignments 形如 { "/sub_a": ["uuid1", ...], ... }。触发新 cluster_review 生成。',
    permission_tag: 'structural',
    parameters: {
      type: 'object',
      properties: {
        cluster_id: { type: 'integer' },
        sub_assignments: { type: 'object' },
        reason: { type: 'string' },
      },
      required: ['cluster_id', 'sub_assignments', 'reason'],
    },
    handler: async (args, ctx) => {
      const cid = Number(args.cluster_id);
      const reason = String(args.reason);
      const sub = args.sub_assignments as Record<string, string[]>;
      const allMoved: string[] = [];
      const newClusters: { sub_path: string; cluster_id: number; uuids: string[] }[] = [];
      let nextId = (db.prepare('SELECT COALESCE(MAX(cluster_id), 0) AS m FROM clusters').get() as { m: number }).m;
      const insertCluster = db.prepare(
        "INSERT INTO clusters (cluster_id, created_at, member_count, status) VALUES (?, ?, ?, 'active')",
      );
      const ts = new Date().toISOString();
      const update = db.prepare('UPDATE nodes SET cluster_id=? WHERE uuid=?');
      const tx = db.transaction(() => {
        for (const [subPath, uuids] of Object.entries(sub)) {
          nextId++;
          insertCluster.run(nextId, ts, uuids.length);
          for (const u of uuids) update.run(nextId, u);
          newClusters.push({ sub_path: subPath, cluster_id: nextId, uuids });
          allMoved.push(...uuids);
        }
        db.prepare("UPDATE clusters SET status='split' WHERE cluster_id=?").run(cid);
      });
      tx();
      for (const nc of newClusters) {
        for (const u of nc.uuids) storage.setCurrentPath(u, nc.sub_path);
      }
      const op_id = recordOp(
        'split',
        { cluster_id: cid, sub_assignments: newClusters },
        reason,
        allMoved,
        ctx,
      );
      // v1.3 §10.4 — trigger cluster_review regen for each new cluster
      void synthesis.regenerateClusterReviewForSplit(
        cid,
        newClusters.map((n) => n.cluster_id),
        ctx,
      );
      return { op_id, sub_assignments: newClusters };
    },
  });

  registry.register({
    name: 'op_promote',
    description: '把一个 raw 节点的 current_path 提升一级。',
    permission_tag: 'structural',
    parameters: {
      type: 'object',
      properties: {
        uuid: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['uuid', 'reason'],
    },
    handler: async (args, ctx) => {
      const uuid = String(args.uuid);
      const node = storage.readNode(uuid);
      if (!node) return { error: 'not found' };
      const cur = node.current_path ?? '/';
      const segments = cur.split('/').filter(Boolean);
      segments.pop();
      const newPath = '/' + segments.join('/');
      storage.setCurrentPath(uuid, newPath);
      const op_id = recordOp(
        'promote',
        { uuid, from_path: cur, to_path: newPath },
        String(args.reason),
        [uuid],
        ctx,
      );
      return { op_id };
    },
  });

  registry.register({
    name: 'op_demote',
    description: '把一个 raw 节点的 current_path 推到给定子路径。',
    permission_tag: 'structural',
    parameters: {
      type: 'object',
      properties: {
        uuid: { type: 'string' },
        to_path: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['uuid', 'to_path', 'reason'],
    },
    handler: async (args, ctx) => {
      const uuid = String(args.uuid);
      const toPath = String(args.to_path);
      const node = storage.readNode(uuid);
      if (!node) return { error: 'not found' };
      const fromPath = node.current_path;
      storage.setCurrentPath(uuid, toPath);
      const op_id = recordOp(
        'demote',
        { uuid, from_path: fromPath, to_path: toPath },
        String(args.reason),
        [uuid],
        ctx,
      );
      return { op_id };
    },
  });

  registry.register({
    name: 'op_rewrite_summary',
    description: '改写节点的 l0_summary 或 l1_overview。',
    permission_tag: 'structural',
    parameters: {
      type: 'object',
      properties: {
        uuid: { type: 'string' },
        l0_summary: { type: 'string' },
        l1_overview: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['uuid', 'reason'],
    },
    handler: async (args, ctx) => {
      const uuid = String(args.uuid);
      const node = storage.readNode(uuid);
      if (!node) return { error: 'not found' };
      const before = { l0_summary: node.l0_summary, l1_overview: node.l1_overview };
      const patch: Record<string, string> = {};
      if (typeof args.l0_summary === 'string') patch.l0_summary = args.l0_summary;
      if (typeof args.l1_overview === 'string') patch.l1_overview = args.l1_overview;
      storage.updateNodeMetadata(uuid, patch);
      const op_id = recordOp(
        'rewrite_summary',
        { uuid, before, after: patch },
        String(args.reason),
        [uuid],
        ctx,
      );
      return { op_id };
    },
  });

  registry.register({
    name: 'op_extract',
    description: '从若干源节点中抽取一个新节点。',
    permission_tag: 'structural',
    parameters: {
      type: 'object',
      properties: {
        source_uuids: { type: 'array', items: { type: 'string' } },
        body: { type: 'string' },
        l0_summary: { type: 'string' },
        l1_overview: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['source_uuids', 'body', 'reason'],
    },
    handler: async (args, ctx) => {
      const sources = (args.source_uuids as string[]) ?? [];
      const newNode = storage.createNode({
        node_type: 'raw',
        body: String(args.body),
        l0_summary: args.l0_summary as string | undefined,
        l1_overview: args.l1_overview as string | undefined,
        created_by: `agent:${ctx.agent_id}`,
        created_by_run: ctx.agent_run_id,
      });
      const op_id = recordOp(
        'extract',
        { source_uuids: sources, new_uuid: newNode.uuid },
        String(args.reason),
        [newNode.uuid, ...sources],
        ctx,
      );
      return { op_id, uuid: newNode.uuid };
    },
  });

  registry.register({
    name: 'op_dedupe',
    description: '把两个高度重复的节点合并:保留 kept,archive 掉 dropped,并记录 superseded_by。',
    permission_tag: 'structural',
    parameters: {
      type: 'object',
      properties: {
        kept_uuid: { type: 'string' },
        dropped_uuid: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['kept_uuid', 'dropped_uuid', 'reason'],
    },
    handler: async (args, ctx) => {
      const kept = String(args.kept_uuid);
      const dropped = String(args.dropped_uuid);
      const reason = String(args.reason);
      const node = storage.readNode(dropped);
      if (!node) return { error: 'dropped node not found' };
      storage.updateNodeMetadata(dropped, {
        lifecycle: { ...node.lifecycle, status: 'superseded', superseded_by: kept, superseded_reason: reason },
      });
      const op_id = recordOp(
        'dedupe',
        { kept_uuid: kept, dropped_uuid: dropped },
        reason,
        [kept, dropped],
        ctx,
      );
      return { op_id };
    },
  });

  registry.register({
    name: 'op_set_hub_role',
    description:
      'v1.3 §3.3 — 修改 raw 节点的 hub_role。所有变更进操作日志、可回滚,触发该簇 hub 重计算。',
    permission_tag: 'structural',
    parameters: {
      type: 'object',
      properties: {
        uuid: { type: 'string' },
        new_value: { type: 'string', enum: ['root', 'center', 'leaf', 'neutral'] },
        reason: { type: 'string' },
      },
      required: ['uuid', 'new_value', 'reason'],
    },
    handler: async (args, ctx) => {
      const uuid = String(args.uuid);
      const newVal = args.new_value as HubRoleValue;
      const reason = String(args.reason);
      const node = storage.readNode(uuid);
      if (!node) return { error: 'not found' };
      if (node.node_type !== 'raw') return { error: 'hub_role only applies to raw nodes' };
      const fromVal = node.hub_role?.value ?? 'neutral';
      const op = oplog.append({
        agent_run_id: ctx.agent_run_id,
        agent_id: ctx.agent_id,
        op_type: 'set_hub_role',
        args: { uuid, from_value: fromVal, to_value: newVal },
        reason,
        affected_uuids: [uuid],
      });
      storage.setHubRole(uuid, newVal, 'librarian', reason, op.op_id, `agent:${ctx.agent_id}`);
      return { op_id: op.op_id };
    },
  });

  registry.register({
    name: 'synthesize_explicit',
    description: '显式生成一个 synthesis 节点(由 source_uuids 指定的源)。subtype 默认 consolidation。',
    permission_tag: 'structural',
    parameters: {
      type: 'object',
      properties: {
        source_uuids: { type: 'array', items: { type: 'string' } },
        instruction: { type: 'string' },
        subtype_hint: {
          type: 'string',
          enum: ['consolidation', 'cluster_review', 'annotation', 'question', 'association', 'meta'],
        },
        bypass_pre_gates: { type: 'boolean', default: false },
        reason: { type: 'string' },
      },
      required: ['source_uuids', 'reason'],
    },
    handler: async (args, ctx) => {
      const result = await synthesis.generateExplicit({
        source_uuids: args.source_uuids as string[],
        subtype_hint: args.subtype_hint as SynthesisSubtype | undefined,
        instruction: args.instruction as string | undefined,
        bypass_pre_gates: Boolean(args.bypass_pre_gates),
        reason: String(args.reason),
        ctx,
      });
      return result;
    },
  });
}
