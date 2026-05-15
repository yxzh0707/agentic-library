import { useState, useRef, useEffect } from 'react';
import {
  Send,
  Upload,
  RefreshCw,
  Loader2,
  CheckCircle2,
  AlertCircle,
  History,
  Trash2,
  X,
  Check,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useChatStore } from '../../stores/chat_store';
import { useKBStore } from '../../stores/kb_store';
import { api } from '../../api/client';
import { connectWS, onEvent } from '../../api/ws';

export function ChatPanel() {
  const conversation = useChatStore((s) => s.conversation);
  const conversations = useChatStore((s) => s.conversations);
  const send = useChatStore((s) => s.send);
  const reset = useChatStore((s) => s.reset);
  const switchTo = useChatStore((s) => s.switchTo);
  const deleteConv = useChatStore((s) => s.deleteConv);
  const loading = useChatStore((s) => s.loading);
  const flags = useKBStore((s) => s.flags);
  const refreshFlags = useKBStore((s) => s.refreshFlags);

  const [input, setInput] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [dismissedFlags, setDismissedFlags] = useState<Set<string>>(new Set());
  const [importStatus, setImportStatus] = useState<
    | { state: 'uploading'; total: number }
    | { state: 'done'; ok: number; fail: number; failures: { name: string; reason: string }[] }
    | { state: 'error'; message: string }
    | null
  >(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const refreshKB = useKBStore((s) => s.refresh);
  const markFreshNodes = useKBStore((s) => s.markFreshNodes);

  // Click-outside closes the dropdown. Listening only while open keeps the
  // global handler off the document the rest of the time.
  useEffect(() => {
    if (!showHistory) return;
    const onDown = (e: MouseEvent) => {
      if (!historyRef.current?.contains(e.target as Node)) setShowHistory(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showHistory]);

  useEffect(() => {
    connectWS();
    void refreshFlags();
    const off = onEvent((ev) => {
      if (ev.type === 'flag_queue_appended') void refreshFlags();
    });
    return () => off();
  }, [refreshFlags]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [conversation.messages.length, loading]);

  const onSubmit = async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    await send(text);
  };

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? [...e.target.files] : [];
    if (fileInput.current) fileInput.current.value = '';
    if (files.length === 0) return;
    setImportStatus({ state: 'uploading', total: files.length });
    try {
      const res = await api.importFiles(files);
      setImportStatus({
        state: 'done',
        ok: res.imported.length,
        fail: res.failed.length,
        failures: res.failed,
      });
      markFreshNodes(res.imported.map((item) => item.uuid));
      void refreshKB();
      setTimeout(() => setImportStatus(null), 8000);
    } catch (err) {
      setImportStatus({ state: 'error', message: (err as Error).message });
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-primary-100 bg-white px-4 py-3 text-sm font-medium">
        <span>与咨询员对话</span>
        <div className="flex items-center gap-1">
          <div className="relative" ref={historyRef}>
            <button
              onClick={() => setShowHistory((v) => !v)}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-primary-500 hover:bg-primary-50"
              title="查看历史对话"
            >
              <History size={12} /> 历史 ({conversations.length})
            </button>
            {showHistory && (
              <div className="absolute right-0 top-full z-20 mt-1 max-h-80 w-72 overflow-y-auto rounded border border-primary-100 bg-white shadow-lg">
                {conversations.length === 0 && (
                  <p className="p-3 text-center text-xs text-primary-500/60">无历史对话</p>
                )}
                {[...conversations]
                  .sort((a, b) => b.updated_at - a.updated_at)
                  .map((c) => {
                    const active = c.id === conversation.id;
                    return (
                      <div
                        key={c.id}
                        className={
                          'group flex items-start gap-1 border-b border-primary-100/50 px-2 py-1.5 text-xs last:border-b-0 ' +
                          (active ? 'bg-accent-500/5' : 'hover:bg-primary-50')
                        }
                      >
                        <button
                          onClick={() => {
                            switchTo(c.id);
                            setShowHistory(false);
                          }}
                          className="flex-1 text-left"
                        >
                          <div
                            className={
                              'line-clamp-1 ' +
                              (active ? 'font-medium text-accent-500' : 'text-primary-700')
                            }
                          >
                            {convTitle(c)}
                          </div>
                          <div className="mt-0.5 text-[10px] text-primary-500/70">
                            {timeAgo(c.updated_at)} · {c.messages.length} 条消息
                          </div>
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (
                              c.messages.length > 0 &&
                              !confirm(`删除对话「${convTitle(c)}」?`)
                            )
                              return;
                            deleteConv(c.id);
                          }}
                          className="rounded p-1 text-red-500 opacity-0 hover:bg-red-50 group-hover:opacity-100"
                          title="删除此对话"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
          <button
            onClick={reset}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-primary-500 hover:bg-primary-50"
          >
            <RefreshCw size={12} /> 新对话
          </button>
        </div>
      </div>
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4 text-sm">
        {/* Pending decision cards from flag_queue — human-in-the-loop bridge */}
        {flags
          .filter((f) => f.status === 'pending' && !dismissedFlags.has(f.flag_id))
          .slice(0, 5)
          .map((f) => (
            <DecisionCard
              key={f.flag_id}
              flag={f}
              onDismiss={async () => {
                await api.dismissFlag(f.flag_id);
                setDismissedFlags((prev) => new Set(prev).add(f.flag_id));
                void refreshFlags();
              }}
            />
          ))}
        {conversation.messages.length === 0 && flags.filter((f) => f.status === 'pending').length === 0 && (
          <p className="text-primary-500/70">向咨询员提问,或拖入 .md / .txt 文件入库。</p>
        )}
        {conversation.messages.map((m, i) => (
          <Message key={i} role={m.role} content={m.content} />
        ))}
        {loading && <p className="text-primary-500/60">咨询员正在思考...</p>}
      </div>
      {importStatus && (
        <div className="border-t border-primary-100 bg-primary-50/40 px-3 py-2 text-xs">
          {importStatus.state === 'uploading' && (
            <span className="flex items-center gap-1.5 text-primary-700">
              <Loader2 size={12} className="animate-spin" />
              正在导入 {importStatus.total} 个文件...
            </span>
          )}
          {importStatus.state === 'done' && (
            <div className="space-y-1">
              <span className="flex items-center gap-1.5 text-green-700">
                <CheckCircle2 size={12} />
                已导入 {importStatus.ok} 个{importStatus.fail ? `,失败 ${importStatus.fail} 个` : ''} · 嵌入会在后台异步生成
              </span>
              {importStatus.failures.slice(0, 3).map((f) => (
                <div key={f.name} className="text-red-600">
                  · {f.name}:{f.reason}
                </div>
              ))}
            </div>
          )}
          {importStatus.state === 'error' && (
            <span className="flex items-center gap-1.5 text-red-600">
              <AlertCircle size={12} />
              导入失败:{importStatus.message}
            </span>
          )}
        </div>
      )}
      <div className="border-t border-primary-100 bg-white p-3">
        <div className="flex items-end gap-2">
          <button
            onClick={() => fileInput.current?.click()}
            className="flex h-9 w-9 items-center justify-center rounded text-primary-500 hover:bg-primary-50"
            title="Upload file"
          >
            <Upload size={16} />
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept=".md,.mdx,.markdown,.txt,.rst,.log,.pdf,.docx"
            className="hidden"
            onChange={onUpload}
          />
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
              e.preventDefault();
              void onSubmit();
            }}
            placeholder="输入消息(Enter 发送,Shift + Enter 换行)..."
            className="flex-1 resize-none rounded border border-primary-100 bg-white px-3 py-2 text-sm focus:border-accent-500 focus:outline-none"
            rows={2}
            disabled={loading}
          />
          <button
            onClick={() => void onSubmit()}
            className="flex h-9 w-9 items-center justify-center rounded bg-accent-500 text-white hover:opacity-90 disabled:opacity-50"
            disabled={!input.trim() || loading}
            title="Send"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

interface FlagBrief {
  flag_id: string;
  flag_type: string;
  target_uuid: string | null;
  target_cluster_id: number | null;
  issue_type: string | null;
  description: string;
  flagged_at: string;
  flagged_by: string;
  status: string;
}

function DecisionCard({ flag, onDismiss }: { flag: FlagBrief; onDismiss: () => Promise<void> }) {
  const isFriction = flag.flag_type === 'cluster_friction';
  const isSubTheme = flag.description.includes('sub_theme');
  const title = isFriction
    ? '聚类健康信号'
    : isSubTheme
      ? '子主题锚点建议'
      : '图书管理员建议';
  const accent = isFriction ? 'border-indigo-400 bg-indigo-50/60' : isSubTheme ? 'border-amber-400 bg-amber-50/60' : 'border-sky-400 bg-sky-50/60';
  const label = isFriction ? '需要检查' : '等待决策';

  return (
    <div className={`rounded-card border-l-4 p-3 text-left shadow-sm ${accent}`}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-primary-800">{title}</div>
          <div className="mt-0.5 text-[10px] text-primary-500/70">
            {label} · {new Date(flag.flagged_at).toLocaleString()} · {flag.flagged_by}
          </div>
        </div>
        <button
          onClick={() => void onDismiss()}
          className="rounded p-1 text-primary-500 hover:bg-white/70"
          title="忽略"
        >
          <X size={14} />
        </button>
      </div>
      <p className="whitespace-pre-wrap text-xs leading-relaxed text-primary-700">{flag.description}</p>
      <div className="mt-2 flex justify-end gap-2">
        {isSubTheme && (
          <button
            onClick={() => void onDismiss()}
            className="flex items-center gap-1 rounded bg-accent-500 px-2 py-1 text-xs text-white hover:opacity-90"
            title="第一期仅确认并关闭卡片;实际结构修改后续接 admin action"
          >
            <Check size={12} /> 采纳
          </button>
        )}
        <button
          onClick={() => void onDismiss()}
          className="rounded bg-white/80 px-2 py-1 text-xs text-primary-600 hover:bg-white"
        >
          忽略
        </button>
      </div>
    </div>
  );
}

function Message({ role, content }: { role: string; content: string }) {
  const isUser = role === 'user';
  return (
    <div className={isUser ? 'text-right' : 'text-left'}>
      <div
        className={
          'inline-block max-w-[90%] rounded-card px-3 py-2 text-left ' +
          (isUser ? 'bg-primary-500 text-white' : 'bg-primary-50 text-primary-700')
        }
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    </div>
  );
}

function convTitle(c: { messages: { role: string; content: string }[] }): string {
  const firstUser = c.messages.find((m) => m.role === 'user');
  if (!firstUser) return '(空对话)';
  const text = firstUser.content.replace(/\s+/g, ' ').trim();
  return text.length > 30 ? text.slice(0, 30) + '...' : text || '(空对话)';
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(ms).toLocaleDateString();
}
