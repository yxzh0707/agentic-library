import type { HubRoleValue } from '@kb/shared';
import type { RegisterDeps } from './index.js';
import { loadInsightInput, godNodes, surprisingConnections, knowledgeGaps } from '../graph/insights.js';

export function registerAdminTools(deps: RegisterDeps) {
  const { registry, storage, oplog, db, clustering, flagQueue } = deps;

  registry.register({
    name: 'revert_op',
    description: '回滚单个操作。如果有后续依赖未撤销,返回 blocked_by 列表。',
    permission_tag: 'admin',
    parameters: {
      type: 'object',
      properties: {
        op_id: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['op_id', 'reason'],
    },
    handler: async (args, ctx) => {
      const op = oplog.byId(String(args.op_id));
      if (!op) return { error: 'op not found' };
      if (op.reverted_by) return { error: 'already reverted' };
      const dependents = oplog.laterDependents(op);
      if (dependents.length > 0) {
        return { success: false, blocked_by: dependents.map((d) => d.op_id) };
      }
      const reverseArgs: Record<string, unknown> = { reverted: op.op_id };
      switch (op.op_type) {
        case 'move':
        case 'promote':
        case 'demote': {
          const { uuid, from_path } = op.args as { uuid: string; from_path: string };
          if (uuid && from_path !== undefined) storage.setCurrentPath(uuid, from_path);
          break;
        }
        case 'merge': {
          const { cluster_a, cluster_b, moved_uuids } = op.args as {
            cluster_a: number;
            cluster_b: number;
            moved_uuids: string[];
          };
          const tx = db.transaction(() => {
            for (const u of moved_uuids ?? []) {
              db.prepare('UPDATE nodes SET cluster_id=? WHERE uuid=?').run(cluster_b, u);
            }
            db.prepare("UPDATE clusters SET status='active' WHERE cluster_id=?").run(cluster_b);
            void cluster_a;
          });
          tx();
          break;
        }
        case 'split': {
          const { cluster_id, sub_assignments } = op.args as {
            cluster_id: number;
            sub_assignments: { cluster_id: number; uuids: string[] }[];
          };
          const tx = db.transaction(() => {
            for (const sub of sub_assignments) {
              for (const u of sub.uuids) {
                db.prepare('UPDATE nodes SET cluster_id=? WHERE uuid=?').run(cluster_id, u);
              }
              db.prepare("UPDATE clusters SET status='merged' WHERE cluster_id=?").run(sub.cluster_id);
            }
            db.prepare("UPDATE clusters SET status='active' WHERE cluster_id=?").run(cluster_id);
          });
          tx();
          break;
        }
        case 'rewrite_summary': {
          const { uuid, before } = op.args as {
            uuid: string;
            before: { l0_summary?: string; l1_overview?: string };
          };
          storage.updateNodeMetadata(uuid, before);
          break;
        }
        case 'dedupe': {
          const { dropped_uuid } = op.args as { dropped_uuid: string };
          const node = storage.readNode(dropped_uuid);
          if (node) {
            storage.updateNodeMetadata(dropped_uuid, {
              lifecycle: {
                ...node.lifecycle,
                status: 'active',
                superseded_by: null,
                superseded_reason: null,
              },
            });
          }
          break;
        }
        case 'extract': {
          const { new_uuid } = op.args as { new_uuid: string };
          if (new_uuid) storage.archiveNode(new_uuid, `revert of ${op.op_id}`);
          break;
        }
        case 'set_hub_role': {
          const { uuid, from_value } = op.args as {
            uuid: string;
            from_value: HubRoleValue;
          };
          if (uuid && from_value) {
            storage.setHubRole(
              uuid,
              from_value,
              'librarian',
              `revert of ${op.op_id}`,
              null,
              `agent:${ctx.agent_id}`,
            );
          }
          break;
        }
        default:
          return { error: `revert not supported for op_type=${op.op_type}` };
      }
      const newOp = oplog.append({
        agent_run_id: ctx.agent_run_id,
        agent_id: ctx.agent_id,
        op_type: 'revert',
        args: reverseArgs,
        reason: String(args.reason),
        affected_uuids: op.affected_uuids,
      });
      oplog.markReverted(op.op_id, newOp.op_id);
      return { success: true, op_id: newOp.op_id };
    },
  });

  registry.register({
    name: 'create_branch',
    description: '从当前 main 分出一个分支(后续 op 都标记到该分支)。',
    permission_tag: 'admin',
    parameters: {
      type: 'object',
      properties: {
        branch_name: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['branch_name', 'reason'],
    },
    handler: async (args, ctx) => {
      const name = String(args.branch_name);
      const op_id = oplog.append({
        agent_run_id: ctx.agent_run_id,
        agent_id: ctx.agent_id,
        op_type: 'branch_create',
        args: { branch_name: name },
        reason: String(args.reason),
        affected_uuids: [],
        branch_name: 'main',
      }).op_id;
      return { op_id, branch_name: name };
    },
  });

  registry.register({
    name: 'switch_branch',
    description: '切换到某个分支(影响后续 op 写入)。',
    permission_tag: 'admin',
    parameters: {
      type: 'object',
      properties: { branch_name: { type: 'string' } },
      required: ['branch_name'],
    },
    handler: async (args) => {
      oplog.setBranch(String(args.branch_name));
      return { branch_name: oplog.getBranch() };
    },
  });

  registry.register({
    name: 'merge_branch',
    description: '把分支合回 main。',
    permission_tag: 'admin',
    parameters: {
      type: 'object',
      properties: {
        from_branch: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['from_branch', 'reason'],
    },
    handler: async (args, ctx) => {
      const from = String(args.from_branch);
      const ops = oplog.list({ branch: from, limit: 1000 });
      const op_id = oplog.append({
        agent_run_id: ctx.agent_run_id,
        agent_id: ctx.agent_id,
        op_type: 'branch_merge',
        args: { from_branch: from, op_count: ops.length },
        reason: String(args.reason),
        affected_uuids: [...new Set(ops.flatMap((o) => o.affected_uuids))],
        branch_name: 'main',
      }).op_id;
      return { op_id, merged_op_count: ops.length };
    },
  });

  registry.register({
    name: 'blame_node',
    description: '查看节点经历过的所有结构性操作。',
    permission_tag: 'admin',
    parameters: {
      type: 'object',
      properties: { uuid: { type: 'string' } },
      required: ['uuid'],
    },
    handler: async (args) => {
      return { entries: oplog.blame(String(args.uuid)) };
    },
  });

  // ===== Cluster cohesion (kept for diagnostics) =====

  registry.register({
    name: 'reset_clusters_and_recluster',
    description:
      '清空当前 active clusters 与 raw 节点聚类归属,然后立即重跑 v1.4 cold_start working_set 聚类。破坏性操作,必须 confirm=true。',
    permission_tag: 'admin',
    parameters: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean' },
        reason: { type: 'string' },
        max_n: { type: 'integer', description: 'cold_start 的 N 上限,默认 80' },
        min_n: { type: 'integer', description: 'cold_start 的 N 下限,默认 2' },
      },
      required: ['confirm'],
    },
    handler: async (args, ctx) => {
      if (args.confirm !== true) return { ok: false, reason: 'confirm=true required' };
      const r = await clustering.resetClustersAndRecluster({
        reason: typeof args.reason === 'string' ? args.reason : undefined,
        agent_run_id: ctx.agent_run_id,
        agent_id: ctx.agent_id,
        maxN: args.max_n !== undefined ? Number(args.max_n) : undefined,
        minN: args.min_n !== undefined ? Number(args.min_n) : undefined,
      });
      if (!r) return { ok: false, reason: 'reset completed but cold_start declined or failed; see server logs' };
      return {
        ok: true,
        reset_clusters: r.reset_clusters,
        reset_nodes: r.reset_nodes,
        formed: r.formed,
        assignments: Object.fromEntries(r.assignments),
      };
    },
  });

  registry.register({
    name: 'cold_start_cluster',
    description:
      'v1.3 cold start: 当 0 簇 + 6≤N≤80 时,让 LLM 按 l0_summary 直接分簇。HDBSCAN 在小 N 上失效时的兜底。手动调用,失败返回 null。',
    permission_tag: 'admin',
    parameters: {
      type: 'object',
      properties: {
        max_n: { type: 'integer', description: 'N 上限,超过则不走 LLM(默认 80)' },
        min_n: { type: 'integer', description: 'N 下限(默认 6)' },
      },
    },
    handler: async (args) => {
      const r = await clustering.coldStartCluster({
        maxN: args.max_n !== undefined ? Number(args.max_n) : undefined,
        minN: args.min_n !== undefined ? Number(args.min_n) : undefined,
      });
      if (!r) return { ok: false, reason: 'declined or failed; see server logs' };
      clustering.recomputeHubs();
      clustering.recomputeSynthesisDerivedState();
      return { ok: true, formed: r.formed, assignments: Object.fromEntries(r.assignments) };
    },
  });

  registry.register({
    name: 'cluster_cohesion',
    description: '计算指定簇的内聚度评分(0-1,1=完全图)。低内聚簇是知识空白信号。',
    permission_tag: 'admin',
    parameters: {
      type: 'object',
      properties: { cluster_id: { type: 'number' } },
      required: ['cluster_id'],
    },
    handler: async (args) => {
      const cid = Number(args.cluster_id);
      const cohesion = clustering.computeCohesion(cid);
      return { cluster_id: cid, cohesion };
    },
  });

  // ===== Graph insight tools =====

  function buildInput(includeCohesion: boolean) {
    let cohesionByCluster: Map<number, number> | undefined;
    if (includeCohesion) {
      const rows = db
        .prepare("SELECT cluster_id FROM clusters WHERE status='active'")
        .all() as { cluster_id: number }[];
      cohesionByCluster = new Map();
      for (const r of rows) cohesionByCluster.set(r.cluster_id, clustering.computeCohesion(r.cluster_id));
    }
    return loadInsightInput(db, cohesionByCluster);
  }

  registry.register({
    name: 'god_nodes',
    description: '返回度数最高的 raw 节点(系统的核心抽象)。优先 hub_role=center 节点。',
    permission_tag: 'admin',
    parameters: {
      type: 'object',
      properties: { top: { type: 'number' } },
    },
    handler: async (args) => {
      const top = args.top ? Number(args.top) : 10;
      return { god_nodes: godNodes(buildInput(false), top) };
    },
  });

  registry.register({
    name: 'surprising_connections',
    description: '返回跨簇/跨置信度等"惊奇"边,按 surprise 复合分倒序。',
    permission_tag: 'admin',
    parameters: {
      type: 'object',
      properties: { top: { type: 'number' } },
    },
    handler: async (args) => {
      const top = args.top ? Number(args.top) : 5;
      return { surprises: surprisingConnections(buildInput(false), top) };
    },
  });

  registry.register({
    name: 'knowledge_gaps',
    description: '返回三类 knowledge gap: 孤立节点 / 低 cohesion 簇 / 桥接节点。',
    permission_tag: 'admin',
    parameters: {
      type: 'object',
      properties: {
        cohesion_threshold: { type: 'number' },
        min_members: { type: 'number' },
        min_bridge_clusters: { type: 'number' },
      },
    },
    handler: async (args) => {
      return {
        gaps: knowledgeGaps(buildInput(true), {
          cohesionThreshold: args.cohesion_threshold !== undefined ? Number(args.cohesion_threshold) : undefined,
          minMembers: args.min_members !== undefined ? Number(args.min_members) : undefined,
          minBridgeClusters: args.min_bridge_clusters !== undefined ? Number(args.min_bridge_clusters) : undefined,
        }),
      };
    },
  });

  // ===== Flag queue admin tools (v1.3 §11.2) =====

  registry.register({
    name: 'list_flag_queue',
    description: '列出 flag 队列待办项。可按 status/flag_type/cluster_id 过滤。',
    permission_tag: 'admin',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'pending | addressed | dismissed' },
        flag_type: { type: 'string', description: 'specific_issue | cluster_friction' },
        cluster_id: { type: 'number' },
        limit: { type: 'number' },
      },
    },
    handler: async (args) => {
      return {
        items: flagQueue.list({
          status: args.status as 'pending' | 'addressed' | 'dismissed' | undefined,
          flag_type: args.flag_type as 'specific_issue' | 'cluster_friction' | undefined,
          cluster_id: args.cluster_id !== undefined ? Number(args.cluster_id) : undefined,
          limit: args.limit !== undefined ? Number(args.limit) : undefined,
        }),
        counts: flagQueue.countByStatus(),
      };
    },
  });

  registry.register({
    name: 'dismiss_flag',
    description: '将 flag 标为 dismissed(假阳性)。',
    permission_tag: 'admin',
    parameters: {
      type: 'object',
      properties: {
        flag_id: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['flag_id', 'reason'],
    },
    handler: async (args) => {
      const ok = flagQueue.dismiss(String(args.flag_id));
      return { ok };
    },
  });
}
