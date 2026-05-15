import { create } from 'zustand';
import type { ChatMessage, ConsultantReference } from '@kb/shared';
import { api, chatStream } from '../api/client';

const STORAGE_KEY = 'kb.conversations';
// v1: single conversation under this key. Migrated on first load.
const LEGACY_KEY = 'kb.conversation';

/** Per-message metadata held in store but not part of the LLM-facing message
 *  history (so it round-trips through localStorage but doesn't confuse the
 *  next chat() request). Keyed by message index in the conversation. */
export interface MessageMeta {
  references?: ConsultantReference[];
  tool_calls?: { name: string }[];
}

interface Conv {
  id: string;
  messages: ChatMessage[];
  /** Per-message metadata, indexed by position in `messages`. */
  meta?: Record<number, MessageMeta>;
  /** Epoch ms of last update — used to sort the history dropdown. */
  updated_at: number;
}

function blankConv(): Conv {
  return { id: crypto.randomUUID(), messages: [], updated_at: Date.now() };
}

function loadInitial(): { conversations: Conv[]; conversation: Conv } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const list = JSON.parse(raw) as Conv[];
      if (Array.isArray(list) && list.length > 0 && list[0]) {
        return { conversations: list, conversation: list[0] };
      }
    }
    // Migrate from the v1 single-conversation format if present.
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const old = JSON.parse(legacy) as Omit<Conv, 'updated_at'>;
      const c: Conv = { ...old, updated_at: Date.now() };
      const list = [c];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
      localStorage.removeItem(LEGACY_KEY);
      return { conversations: list, conversation: c };
    }
  } catch {
    // ignore
  }
  const c = blankConv();
  return { conversations: [c], conversation: c };
}

function persist(list: Conv[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
}

interface State {
  conversations: Conv[];
  conversation: Conv;
  loading: boolean;
  /** Streaming the most recent in-flight tool call name (UI hint). */
  toolHint: string | null;
  send: (text: string, opts?: { stream?: boolean }) => Promise<void>;
  reset: () => void;
  switchTo: (id: string) => void;
  deleteConv: (id: string) => void;
}

function attachMeta(conv: Conv, idx: number, meta: MessageMeta): Conv {
  return { ...conv, meta: { ...(conv.meta ?? {}), [idx]: meta } };
}

/** Replace the active conversation in the list with `next`, preserving
 *  list order. Persistence is handled by the caller (we don't want to
 *  flush every streaming token to disk). */
function applyActive(conversations: Conv[], next: Conv): Conv[] {
  const idx = conversations.findIndex((c) => c.id === next.id);
  if (idx === -1) return [next, ...conversations];
  const list = [...conversations];
  list[idx] = next;
  return list;
}

export const useChatStore = create<State>((set, get) => {
  const initial = loadInitial();
  return {
    conversations: initial.conversations,
    conversation: initial.conversation,
    loading: false,
    toolHint: null,

    // Streaming is the default — gives users immediate token-level feedback
    // instead of waiting for the full LLM round trip. Pass {stream: false}
    // to opt into the non-streaming path (e.g. for testing).
    send: async (text, opts = {}) => {
      const stream = opts.stream !== false;
      const userMsg: ChatMessage = { role: 'user', content: text };
      let conv: Conv = {
        ...get().conversation,
        messages: [...get().conversation.messages, userMsg],
        updated_at: Date.now(),
      };
      let conversations = applyActive(get().conversations, conv);
      set({ conversation: conv, conversations, loading: true, toolHint: null });
      persist(conversations);

      try {
        if (stream) {
          let assistant: ChatMessage = { role: 'assistant', content: '' };
          conv = { ...conv, messages: [...conv.messages, assistant] };
          const assistantIdx = conv.messages.length - 1;
          conversations = applyActive(conversations, conv);
          set({ conversation: conv, conversations });

          for await (const ev of chatStream(conv.messages.slice(0, -1))) {
            if (ev.type === 'delta' && typeof ev.data === 'string') {
              assistant = { ...assistant, content: assistant.content + ev.data };
              conv = { ...conv, messages: [...conv.messages.slice(0, -1), assistant] };
              conversations = applyActive(conversations, conv);
              set({ conversation: conv, conversations, toolHint: null });
            } else if (ev.type === 'tool_call') {
              const name = (ev.data as { name?: string } | null)?.name ?? '';
              set({ toolHint: name });
            } else if (ev.type === 'references') {
              const refs = ev.data as ConsultantReference[];
              conv = attachMeta(conv, assistantIdx, { references: refs });
              conversations = applyActive(conversations, conv);
              set({ conversation: conv, conversations });
            } else if (ev.type === 'error') {
              const data = ev.data as { message?: string } | null;
              assistant = {
                ...assistant,
                content: `❌ 调用失败:${data?.message ?? '未知错误'}\n\n请到 ⚙️ 设置 → Chat / LLM 检查 base_url、api_key、chat_model,然后点"测试连接"。`,
              };
              conv = { ...conv, messages: [...conv.messages.slice(0, -1), assistant] };
              conversations = applyActive(conversations, conv);
              set({ conversation: conv, conversations });
              break;
            } else if (ev.type === 'done') {
              break;
            }
          }
          conv = { ...get().conversation, updated_at: Date.now() };
          conversations = applyActive(get().conversations, conv);
          set({ conversation: conv, conversations });
          persist(conversations);
        } else {
          const res = await api.chat({ conversation_id: conv.id, messages: conv.messages });
          conv = {
            ...conv,
            messages: [...conv.messages, res.message],
            updated_at: Date.now(),
          };
          if (res.references && res.references.length > 0) {
            conv = attachMeta(conv, conv.messages.length - 1, { references: res.references });
          }
          conversations = applyActive(conversations, conv);
          set({ conversation: conv, conversations });
          persist(conversations);
        }
      } catch (err) {
        const msg = (err as Error).message;
        const cur = get().conversation;
        conv = {
          ...cur,
          messages: [
            ...cur.messages,
            {
              role: 'assistant' as const,
              content: `❌ 调用失败:${msg}\n\n常见原因:\n- LLM 配置缺失或错误(打开 ⚙️ 设置 → Chat / LLM,点击右上"测试连接")\n- chat_model 名称拼错\n- base_url 不对\n- 网络或鉴权失败`,
            },
          ],
          updated_at: Date.now(),
        };
        conversations = applyActive(get().conversations, conv);
        set({ conversation: conv, conversations });
        persist(conversations);
      } finally {
        set({ loading: false, toolHint: null });
      }
    },

    reset: () => {
      // Start a new conversation, archiving the current one in history.
      // If the current conversation is empty, reuse it instead of stacking
      // blank entries.
      const { conversation, conversations } = get();
      if (conversation.messages.length === 0) {
        return; // already on a blank — nothing to do
      }
      const fresh = blankConv();
      const next = [fresh, ...conversations];
      persist(next);
      set({ conversation: fresh, conversations: next, toolHint: null });
    },

    switchTo: (id) => {
      const target = get().conversations.find((c) => c.id === id);
      if (!target) return;
      set({ conversation: target, toolHint: null });
    },

    deleteConv: (id) => {
      const { conversations, conversation } = get();
      const remaining = conversations.filter((c) => c.id !== id);
      if (remaining.length === 0) {
        // Always keep at least one conversation so the UI never has "no
        // active conversation" state.
        const fresh = blankConv();
        persist([fresh]);
        set({ conversations: [fresh], conversation: fresh, toolHint: null });
        return;
      }
      // If we deleted the active one, fall through to the most recent.
      const nextActive =
        conversation.id === id
          ? [...remaining].sort((a, b) => b.updated_at - a.updated_at)[0]
          : conversation;
      persist(remaining);
      set({ conversations: remaining, conversation: nextActive, toolHint: null });
    },
  };
});
