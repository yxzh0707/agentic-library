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

  // ===== Hermes Agent 新增工具 v2.1 =====

  registry.register({
    name: 'create_reflection',
    description: '将推理轨迹(reflection)永久存入知识库。接受 trace_content + evidence_uuids，生成 reflection 类型节点。reflection 节点不同于 synthesis——它是 Agent 的元认知痕迹，有 TTL、visibility 和 outcome 字段。',
    permission_tag: 'admin',
    parameters: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'reflection 正文(CoT trace 的精炼版本)' },
        l0_summary: { type: 'string', description: '一句话摘要(≤200字符)' },
        l1_overview: { type: 'string', description: '结构化概览(≤2000字符)' },
        reflection_subtype: { type: 'string', enum: ['decision', 'failure_analysis', 'retrieval_strategy', 'plan', 'critique', 'postmortem'], description: 'reflection 子类型' },
        evidence_uuids: { type: 'array', items: { type: 'string' }, description: '参考的节点 UUID 列表' },
        trace_content: { type: 'string', description: '原始 CoT 推理文本(存到 reasoning_traces 表)' },
        outcome: { type: 'string', enum: ['success', 'failure', 'partial'], description: '本次推理的结果' },
        final_answer_summary: { type: 'string', description: '最终答案摘要' },
        visibility: { type: 'string', enum: ['private', 'debug', 'retrievable'], default: 'retrievable' },
        ttl_hours: { type: 'number', description: 'TTL 小时数(0=永不过期,默认168=7天)' },
      },
      required: ['body'],
    },
    handler: async (args, ctx) => {
      // 1. Create the reflection node
      const node = storage.createNode({
        node_type: 'reflection',
        body: String(args.body),
        l0_summary: args.l0_summary as string | undefined,
        l1_overview: args.l1_overview as string | undefined,
        created_by: `agent:${ctx.agent_id}`,
        created_by_run: ctx.agent_run_id,
      });
      
      // 2. If trace_content provided, store in reasoning_traces
      if (args.trace_content) {
        const traceContent = String(args.trace_content);
        const ttlHours = Number(args.ttl_hours ?? 168);
        storage.insertTrace({
          trace_id: node.uuid,
          agent_id: ctx.agent_id,
          agent_run_id: ctx.agent_run_id,
          task_type: (args.reflection_subtype as string) ?? 'general',
          trace_content: traceContent,
          evidence_uuids: Array.isArray(args.evidence_uuids) ? args.evidence_uuids.map(String) : [],
          final_answer_summary: args.final_answer_summary as string | undefined,
          outcome: args.outcome as string | undefined,
          expires_at: ttlHours > 0 ? new Date(Date.now() + ttlHours * 3600 * 1000).toISOString() : undefined,
        });
      }
      
      // 3. Log the operation
      oplog.append({
        agent_run_id: ctx.agent_run_id,
        agent_id: ctx.agent_id,
        op_type: 'extract',
        args: { kind: 'reflection', new_uuid: node.uuid, subtype: args.reflection_subtype ?? null },
        reason: `create_reflection: ${(args.l0_summary as string)?.slice(0, 80) ?? 'no summary'}`,
        affected_uuids: [node.uuid, ...(Array.isArray(args.evidence_uuids) ? args.evidence_uuids.map(String) : [])],
      });
      
      return { uuid: node.uuid, reflection_subtype: args.reflection_subtype ?? null };
    },
  });

  registry.register({
    name: 'batch_dismiss_flags',
    description: '批量驳回 flag 队列中的项目。按 flag_type 或 similarity 阈值过滤，一次性驳回所有匹配项。',
    permission_tag: 'admin',
    parameters: {
      type: 'object',
      properties: {
        flag_ids: { type: 'array', items: { type: 'string' }, description: '指定要驳回的 flag_id 列表(与 filter 互斥)' },
        filter: { type: 'string', enum: ['all_pending', 'potential_duplicate_low_sim', 'l1_inaccurate', 'other'], description: '过滤条件(与 flag_ids 互斥)' },
        reason: { type: 'string', description: '批量驳回的原因' },
      },
    },
    handler: async (args, ctx) => {
      const reason = String(args.reason ?? 'batch dismiss');
      const flagIds: string[] = [];
      
      if (Array.isArray(args.flag_ids)) {
        flagIds.push(...args.flag_ids.map(String));
      } else if (args.filter) {
        const all = flagQueue.list({ status: 'pending' });
        const filter = String(args.filter);
        for (const f of all) {
          if (filter === 'all_pending') {
            flagIds.push(f.flag_id);
          } else if (filter === 'l1_inaccurate' && f.issue_type === 'l1_inaccurate') {
            flagIds.push(f.flag_id);
          } else if (filter === 'other' && f.issue_type === 'other') {
            flagIds.push(f.flag_id);
          }
        }
      }
      
      let dismissed = 0;
      let errors = 0;
      for (const fid of flagIds) {
        try {
          const ok = flagQueue.dismiss(fid);
          if (ok) dismissed++;
          else errors++;
        } catch { errors++; }
      }
      
      oplog.append({
        agent_run_id: ctx.agent_run_id,
        agent_id: ctx.agent_id,
        op_type: 'extract',
        args: { kind: 'batch_dismiss_flags', count: dismissed, errors, filter: args.filter ?? null },
        reason: `batch_dismiss: ${dismissed} dismissed, ${errors} errors - ${reason}`,
        affected_uuids: [],
      });
      
      return { dismissed, errors };
    },
  });

  registry.register({
    name: 'update_cluster_description',
    description: '更新指定簇的描述文本。直接写入 clusters 表的 description 字段。',
    permission_tag: 'admin',
    parameters: {
      type: 'object',
      properties: {
        cluster_id: { type: 'integer', description: '要更新的簇 ID' },
        description: { type: 'string', description: '新的描述文本' },
        reason: { type: 'string', description: '更新原因' },
      },
      required: ['cluster_id', 'description'],
    },
    handler: async (args, ctx) => {
      const cid = Number(args.cluster_id);
      const desc = String(args.description);
      const existing = db.prepare('SELECT * FROM clusters WHERE cluster_id=?').get(cid);
      if (!existing) return { error: 'cluster not found' };
      
      db.prepare('UPDATE clusters SET description=? WHERE cluster_id=?').run(desc, cid);
      
      oplog.append({
        agent_run_id: ctx.agent_run_id,
        agent_id: ctx.agent_id,
        op_type: 'move',
        args: { cluster_id: cid, old_description: (existing as any).description ?? null, new_description: desc },
        reason: String(args.reason ?? 'update cluster description'),
        affected_uuids: [],
      });
      
      return { cluster_id: cid, description: desc, updated: true };
    },
  });

  // v2.0 Hermes Optimizer §7 + §9 — sub-agent spawning

  registry.register({
    name: 'spawn_sub_agent',
    description: 'Hermes 派生受限子任务:给一个狭窄目标 + 工具子集,子agent执行完结果合并回 Hermes。工具子集通过 allowed_tools 限制。sub-agent 的 run_id 归在父 Hermes run 下,可审计。',
    permission_tag: 'admin',
    parameters: {
      type: 'object',
      properties: {
        task_prompt: { type: 'string', description: '子任务的详细指令（LLM 系统 prompt 的 user 部分）' },
        allowed_tools: { type: 'array', items: { type: 'string' }, description: '允许子 agent 调用的工具名列表，空=无工具（纯推理）' },
        context_uuids: { type: 'array', items: { type: 'string' }, description: '相关节点 UUID，工具如 read_node 可直接读取' },
        max_turns: { type: 'integer', default: 5, description: '最大对话轮次，防止无限循环' },
        model: { type: 'string', description: '可选指定模型，不填则用默认 LLM' },
      },
      required: ['task_prompt'],
    },
    handler: async (args, ctx) => {
      const allowed = Array.isArray(args.allowed_tools) ? args.allowed_tools.map(String) : [];
      const maxTurns = Number(args.max_turns ?? 5);
      const contextUuids = Array.isArray(args.context_uuids) ? args.context_uuids.map(String) : [];

      // 构建受限工具列表（只暴露 permission_tag 为 read 的工具，或已在 allowed_tools 中的工具）
      const allowedSet = new Set(allowed);
      const readOnlyTools = registry.list().filter((t) => {
        if (allowedSet.size > 0) return allowedSet.has(t.name);
        return t.permission_tag === 'read';
      });

      if (!deps.llm) return { error: 'llm not configured' };

      // 读取 context nodes 供子 agent 参考
      const contextNodes: Record<string, unknown> = {};
      for (const uuid of contextUuids) {
        const node = storage.readNode(uuid);
        if (node) contextNodes[uuid] = { l0: node.l0_summary, l1: node.l1_overview, body_excerpt: node.body.slice(0, 500) };
      }

      // 构建子 agent system prompt（限制工具能力）
      const toolDescs = readOnlyTools.map((t) => `  - ${t.name}: ${t.description}`).join('\n');
      const systemPrompt = `你是 KB 的子任务执行 agent。你只能使用以下工具（其他工具不可用）：
${toolDescs || '  （无工具，纯推理模式）'}

重要约束：
- 每次只调用一个工具
- 结果返回后继续，直到任务完成或达到最大轮次
- 最终输出一个 JSON 对象：{"result": "...", "actions_taken": ["..."], "confidence": "high|medium|low"}`;

      let turns = 0;
      let lastResult: unknown = null;
      let done = false;

      while (turns < maxTurns && !done) {
        turns++;
        const userMsg = turns === 1
          ? `任务: ${args.task_prompt}\n\n参考上下文:\n${JSON.stringify(contextNodes, null, 2)}\n\n开始执行。`
          : `继续。上次结果: ${JSON.stringify(lastResult)}`;

        const completion = await deps.llm.chat({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMsg },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.3,
        });

        const raw = completion.choices?.[0]?.message?.content ?? '{}';
        let parsed: { result?: string; actions_taken?: string[]; confidence?: string; tool_call?: string; tool_args?: Record<string, unknown> };
        try { parsed = JSON.parse(raw); } catch { parsed = {}; }

        if (parsed.result !== undefined) {
          lastResult = parsed;
          done = true;
        } else if (parsed.tool_call && readOnlyTools.some((t) => t.name === parsed.tool_call)) {
          // Execute the tool call and continue
          const tool = readOnlyTools.find((t) => t.name === parsed.tool_call)!;
          try {
            const result = await tool.handler(parsed.tool_args ?? {}, ctx);
            lastResult = { tool: parsed.tool_call, result };
          } catch (err) {
            lastResult = { tool: parsed.tool_call, error: String(err) };
          }
        } else {
          lastResult = { raw, parsed };
          done = true;
        }
      }

      // 记录 sub-agent 执行到 op_log（挂在父 run 下）
      const subOpId = oplog.append({
        agent_run_id: ctx.agent_run_id,
        agent_id: `subagent:${ctx.agent_id}`,
        op_type: 'extract' as const,
        args: { task_prompt: args.task_prompt, turns, allowed_tools: allowed, context_uuids: contextUuids },
        reason: `sub_agent spawn: ${turns} turns`,
        affected_uuids: contextUuids,
      }).op_id;

      return {
        sub_op_id: subOpId,
        parent_run_id: ctx.agent_run_id,
        turns,
        final_result: lastResult,
        actions_taken: (lastResult as { actions_taken?: string[] })?.actions_taken ?? [],
      };
    },
  });
}
