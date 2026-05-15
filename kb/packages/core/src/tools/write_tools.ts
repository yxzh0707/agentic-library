import type { RegisterDeps } from './index.js';
import type { FlagIssueType } from '@kb/shared';

export function registerWriteTools(deps: RegisterDeps) {
  const { registry, storage, flagQueue } = deps;

  registry.register({
    name: 'create_raw_node',
    description: '录入一个新的 raw 知识节点。l0/l1 缺省时后台异步生成。',
    permission_tag: 'write',
    parameters: {
      type: 'object',
      properties: {
        body: { type: 'string' },
        l0_summary: { type: 'string' },
        l1_overview: { type: 'string' },
        wikilinks: { type: 'array', items: { type: 'string' } },
        created_by_run: { type: 'string' },
        current_path: { type: 'string' },
      },
      required: ['body'],
    },
    handler: async (args, ctx) => {
      const node = storage.createNode({
        node_type: 'raw',
        body: String(args.body),
        l0_summary: args.l0_summary as string | undefined,
        l1_overview: args.l1_overview as string | undefined,
        wikilinks: args.wikilinks as string[] | undefined,
        current_path: args.current_path as string | undefined,
        created_by: `agent:${ctx.agent_id}`,
        created_by_run: (args.created_by_run as string | undefined) ?? ctx.agent_run_id,
      });
      return node;
    },
  });

  registry.register({
    name: 'update_node_content',
    description: '修改节点正文(触发 git commit + 重新嵌入)。',
    permission_tag: 'write',
    parameters: {
      type: 'object',
      properties: {
        uuid: { type: 'string' },
        new_body: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['uuid', 'new_body', 'reason'],
    },
    handler: async (args) => {
      return storage.updateNodeContent(
        String(args.uuid),
        String(args.new_body),
        String(args.reason),
      );
    },
  });

  registry.register({
    name: 'archive_node',
    description: '归档节点(软删除)。',
    permission_tag: 'write',
    parameters: {
      type: 'object',
      properties: {
        uuid: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['uuid', 'reason'],
    },
    handler: async (args) => {
      storage.archiveNode(String(args.uuid), String(args.reason));
      return { ok: true };
    },
  });

  // ===== v1.3 §7.2 / §11.2 — flag tools (consultant 写入) =====

  registry.register({
    name: 'flag_specific_issue',
    description:
      '对一个具体节点上报问题(L1 不准、错簇、重复、过时等)。图书管理员在 background pass 或下次 on_review 处理。',
    permission_tag: 'write',
    parameters: {
      type: 'object',
      properties: {
        target_uuid: { type: 'string' },
        issue_type: {
          type: 'string',
          enum: ['l1_inaccurate', 'wrong_cluster', 'duplicate', 'outdated', 'cluster_review_drifted', 'other'],
        },
        description: { type: 'string' },
      },
      required: ['target_uuid', 'issue_type', 'description'],
    },
    handler: async (args, ctx) => {
      const flag = flagQueue.append({
        flag_type: 'specific_issue',
        target_uuid: String(args.target_uuid),
        issue_type: args.issue_type as FlagIssueType,
        description: String(args.description),
        flagged_by: `agent:${ctx.agent_id}`,
      });
      return flag;
    },
  });

  registry.register({
    name: 'flag_cluster_friction',
    description:
      '标记某簇的趋势性问题(用户在该簇反复查询不顺)。累加到 clusters.friction_count,影响下次 on_review 优先级。',
    permission_tag: 'write',
    parameters: {
      type: 'object',
      properties: {
        cluster_id: { type: 'integer' },
        description: { type: 'string' },
      },
      required: ['cluster_id', 'description'],
    },
    handler: async (args, ctx) => {
      const flag = flagQueue.append({
        flag_type: 'cluster_friction',
        target_cluster_id: Number(args.cluster_id),
        description: String(args.description),
        flagged_by: `agent:${ctx.agent_id}`,
      });
      return flag;
    },
  });
}
