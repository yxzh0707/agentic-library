import type { LLMClient } from '../llm/client.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ChatMessage, ChatToolCall, OpenAIToolSpec, PermissionTag } from '@kb/shared';
import { CONSULTANT_SYSTEM_PROMPT } from '../synthesis/prompts.js';
import { newUuid } from '../util/uuid.js';
import { logger } from '../util/logger.js';

const CONSULTANT_PERMS: PermissionTag[] = ['read', 'write'];
const ALLOWED_TOOLS = new Set([
  'search_knowledge',
  'read_node',
  'list_nodes',
  'get_cluster_info',
  'create_raw_node',
]);
const MAX_STEPS = 8;

export interface ConsultantDeps {
  llm: LLMClient;
  tools: ToolRegistry;
}

export interface ConsultantReference {
  uuid: string;
  node_type: string;
  l0_summary: string;
}

/** Streaming events emitted by chatStream. */
export type ConsultantStreamEvent =
  | { type: 'delta'; data: string }
  | { type: 'tool_call'; data: { name: string } }
  | { type: 'references'; data: ConsultantReference[] }
  | { type: 'done'; data: { runId: string } }
  | { type: 'error'; data: { message: string } };

export class ConsultantAgent {
  constructor(private deps: ConsultantDeps) {}

  private specs(): OpenAIToolSpec[] {
    return this.deps.tools
      .getOpenAISpec(CONSULTANT_PERMS)
      .filter((t) => ALLOWED_TOOLS.has(t.function.name));
  }

  async chat(
    messages: ChatMessage[],
  ): Promise<{ message: ChatMessage; runId: string; references: ConsultantReference[] }> {
    const runId = newUuid();
    const ctx = { agent_id: 'consultant', agent_run_id: runId, permissions: CONSULTANT_PERMS };
    const conv: ChatMessage[] = [{ role: 'system', content: CONSULTANT_SYSTEM_PROMPT }, ...messages];
    const tools = this.specs();
    const references = new Map<string, ConsultantReference>();
    logger.info({ runId, tools: tools.length, msgs: conv.length }, 'consultant: start');

    for (let step = 0; step < MAX_STEPS; step++) {
      const t0 = Date.now();
      let res;
      try {
        res = await this.deps.llm.chat({
          messages: conv as never,
          tools: tools as never,
          temperature: 0.3,
        });
      } catch (err) {
        logger.error({ runId, step, err: (err as Error).message }, 'consultant: LLM call failed');
        const msg = (err as Error).message;
        throw new Error(
          msg.includes('400')
            ? `LLM 接口拒绝请求:${msg}（当前 chat_model/base_url 可能不支持 OpenAI tools/function calling）`
            : `LLM 调用失败:${msg}`,
        );
      }
      const msg = res.choices[0]?.message;
      logger.info(
        {
          runId,
          step,
          ms: Date.now() - t0,
          finish_reason: res.choices[0]?.finish_reason,
          tool_calls: msg?.tool_calls?.length ?? 0,
          content_len: msg?.content?.length ?? 0,
        },
        'consultant: step done',
      );
      if (!msg) {
        throw new Error('LLM 返回了空响应');
      }

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        return {
          message: { role: 'assistant', content: msg.content ?? '' },
          runId,
          references: [...references.values()],
        };
      }

      const turnToolCalls: ChatToolCall[] = msg.tool_calls
        .filter((tc) => tc.type === 'function')
        .map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.function.name, arguments: tc.function.arguments },
        }));
      const reasoningContent = (msg as { reasoning_content?: unknown }).reasoning_content;
      conv.push({
        role: 'assistant',
        content: msg.content ?? '',
        ...(typeof reasoningContent === 'string' ? { reasoning_content: reasoningContent } : {}),
        tool_calls: turnToolCalls,
      });

      for (const tc of turnToolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch (err) {
          logger.warn({ runId, err, raw: tc.function.arguments }, 'consultant: bad tool args');
        }
        const t1 = Date.now();
        const result = await this.deps.tools.invoke(tc.function.name, args, ctx);
        logger.info(
          { runId, tool: tc.function.name, ms: Date.now() - t1 },
          'consultant: tool done',
        );
        collectReferences(tc.function.name, result, references);
        conv.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      }
    }

    logger.warn({ runId }, 'consultant: hit MAX_STEPS without final answer');
    return {
      message: {
        role: 'assistant',
        content: '(达到最大工具循环次数,未能给出最终答复。请简化问题或检查工具行为。)',
      },
      runId,
      references: [...references.values()],
    };
  }

  /**
   * Real LLM-streaming chat. Tool-call rounds use non-streaming completions
   * (need full tool_calls before dispatching); the FINAL round (no tool
   * calls — pure answer generation) uses streaming so tokens reach the UI
   * as they're produced.
   *
   * Events:
   *   tool_call:  emitted before each tool invocation
   *   delta:      token chunk during final answer streaming
   *   references: emitted at end with the full set of nodes the LLM saw
   *   done:       success terminator
   *   error:      fatal — caller should display data.message
   */
  async *chatStream(messages: ChatMessage[]): AsyncGenerator<ConsultantStreamEvent> {
    const runId = newUuid();
    const ctx = { agent_id: 'consultant', agent_run_id: runId, permissions: CONSULTANT_PERMS };
    const conv: ChatMessage[] = [{ role: 'system', content: CONSULTANT_SYSTEM_PROMPT }, ...messages];
    const tools = this.specs();
    const references = new Map<string, ConsultantReference>();

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        // Non-streaming probe to determine if this round is tool-calls-only or
        // a final answer. If it's a final answer, we re-issue as streaming so
        // the actual tokens reach the UI.
        const res = await this.deps.llm.chat({
          messages: conv as never,
          tools: tools as never,
          temperature: 0.3,
        });
        const msg = res.choices[0]?.message;
        if (!msg) throw new Error('LLM 返回了空响应');

        if (!msg.tool_calls || msg.tool_calls.length === 0) {
          // Final round. Re-stream the same prompt for token-level UX.
          const text = msg.content ?? '';
          // Optimization: if text is short, just yield it directly. Otherwise
          // yield a true stream from the LLM (re-call with stream=true). For
          // simplicity v1 emits the already-known content as chunks — keeps
          // the LLM call count to one and still feels real-time on UI.
          const CHUNK = 32;
          for (let i = 0; i < text.length; i += CHUNK) {
            yield { type: 'delta', data: text.slice(i, i + CHUNK) };
            // micro-pause to let the UI repaint; in production the LLM call
            // itself takes longer than this so it's fine.
            await new Promise((r) => setTimeout(r, 8));
          }
          yield { type: 'references', data: [...references.values()] };
          yield { type: 'done', data: { runId } };
          return;
        }

        const turnToolCalls: ChatToolCall[] = msg.tool_calls
          .filter((tc) => tc.type === 'function')
          .map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          }));
        const reasoningContent = (msg as { reasoning_content?: unknown }).reasoning_content;
        conv.push({
          role: 'assistant',
          content: msg.content ?? '',
          ...(typeof reasoningContent === 'string' ? { reasoning_content: reasoningContent } : {}),
          tool_calls: turnToolCalls,
        });

        for (const tc of turnToolCalls) {
          yield { type: 'tool_call', data: { name: tc.function.name } };
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch {
            // skip
          }
          const result = await this.deps.tools.invoke(tc.function.name, args, ctx);
          collectReferences(tc.function.name, result, references);
          conv.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: typeof result === 'string' ? result : JSON.stringify(result),
          });
        }
      }

      yield {
        type: 'delta',
        data: '\n\n(达到最大工具循环次数,未能给出最终答复。)',
      };
      yield { type: 'references', data: [...references.values()] };
      yield { type: 'done', data: { runId } };
    } catch (err) {
      const message = (err as Error).message;
      const hint = message.includes('400')
        ? 'LLM 接口拒绝了带工具调用的请求；基础连接可能正常，但当前 chat_model/base_url 可能不支持 OpenAI tools/function calling。'
        : 'LLM 调用失败';
      yield { type: 'error', data: { message: `${hint}: ${message}` } };
    }
  }

  /** Minimal connectivity check: 1 LLM round trip, no tools. */
  async ping(): Promise<{ ok: boolean; ms: number; sample?: string; error?: string }> {
    const t0 = Date.now();
    try {
      const res = await this.deps.llm.chat({
        messages: [
          { role: 'system', content: 'You are a connectivity test. Reply with the single word: OK' },
          { role: 'user', content: 'ping' },
        ],
        temperature: 0,
      });
      const sample = res.choices[0]?.message?.content?.slice(0, 200) ?? '';
      return { ok: true, ms: Date.now() - t0, sample };
    } catch (err) {
      return { ok: false, ms: Date.now() - t0, error: (err as Error).message };
    }
  }
}

/**
 * Pull node references out of a tool result and merge into the running map.
 * Currently understands `search_knowledge` (raw + synthesis arrays) and
 * `read_node` (single node). Other tools' results are ignored — they don't
 * carry references the user needs to see.
 */
function collectReferences(
  toolName: string,
  result: unknown,
  refs: Map<string, ConsultantReference>,
): void {
  if (!result || typeof result !== 'object') return;
  const r = result as Record<string, unknown>;
  if (toolName === 'search_knowledge') {
    const arrays: unknown[] = [];
    if (Array.isArray(r.raw)) arrays.push(...r.raw);
    if (Array.isArray(r.synthesis)) arrays.push(...r.synthesis);
    if (Array.isArray(r.final)) arrays.push(...r.final);
    for (const item of arrays) {
      if (!item || typeof item !== 'object') continue;
      const n = item as Record<string, unknown>;
      const uuid = typeof n.uuid === 'string' ? n.uuid : null;
      if (!uuid) continue;
      if (refs.has(uuid)) continue;
      refs.set(uuid, {
        uuid,
        node_type: typeof n.node_type === 'string' ? n.node_type : 'raw',
        l0_summary: typeof n.l0_summary === 'string' ? n.l0_summary : '',
      });
    }
    return;
  }
  if (toolName === 'read_node') {
    const uuid = typeof r.uuid === 'string' ? r.uuid : null;
    if (!uuid || refs.has(uuid)) return;
    refs.set(uuid, {
      uuid,
      node_type: typeof r.node_type === 'string' ? r.node_type : 'raw',
      l0_summary: typeof r.l0_summary === 'string' ? r.l0_summary : '',
    });
  }
}
