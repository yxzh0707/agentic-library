import { useEffect, useMemo, useState } from 'react';
import { X, Eye, EyeOff, Activity, Lock } from 'lucide-react';
import type { GetConfigResponse, UpdateConfigRequest } from '@kb/shared';
import { api } from '../api/client';
import { useKBStore } from '../stores/kb_store';

interface PingResult {
  chat: { ok: boolean; ms: number; sample?: string; error?: string };
  embedding: { ok: boolean; ms: number; dim?: number; error?: string };
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const refresh = useKBStore((s) => s.refresh);
  const [draft, setDraft] = useState<GetConfigResponse | null>(null);
  const [original, setOriginal] = useState<GetConfigResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'llm' | 'embedding' | 'parameters'>('llm');
  const [ping, setPing] = useState<PingResult | null>(null);
  const [pinging, setPinging] = useState(false);

  const runPing = async () => {
    setPinging(true);
    setPing(null);
    try {
      const res = await api.pingLLM();
      setPing(res);
    } catch (err) {
      setPing({
        chat: { ok: false, ms: 0, error: (err as Error).message },
        embedding: { ok: false, ms: 0, error: (err as Error).message },
      });
    } finally {
      setPinging(false);
    }
  };

  // Pull unredacted config so user can see/edit api_keys instead of "****xxxx"
  useEffect(() => {
    void (async () => {
      try {
        const cfg = await api.getConfig(true);
        setDraft(cfg);
        setOriginal(cfg);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, []);

  const envManaged = useMemo(
    () => new Set(draft?._env_managed_keys ?? []),
    [draft?._env_managed_keys],
  );
  const isEnv = (path: string) => envManaged.has(path);

  if (!draft || !original) {
    return (
      <ModalShell onClose={onClose}>
        <div className="p-4 text-sm text-primary-500">
          {error ? `加载失败:${error}` : '加载中...'}
        </div>
      </ModalShell>
    );
  }

  const setLLM = (k: string, v: string | number) =>
    setDraft({ ...draft, llm: { ...draft.llm, [k]: v } });
  const setEmb = (k: string, v: string | number) =>
    setDraft({ ...draft, embedding: { ...draft.embedding, [k]: v } });
  const setParam = (k: string, v: number) =>
    setDraft({ ...draft, parameters: { ...draft.parameters, [k]: v } });

  const buildPatch = (): UpdateConfigRequest => {
    const patch: UpdateConfigRequest = {};
    if (JSON.stringify(draft.llm) !== JSON.stringify(original.llm)) patch.llm = draft.llm;
    if (JSON.stringify(draft.embedding) !== JSON.stringify(original.embedding))
      patch.embedding = draft.embedding;
    if (JSON.stringify(draft.parameters) !== JSON.stringify(original.parameters))
      patch.parameters = draft.parameters;
    return patch;
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const patch = buildPatch();
      if (Object.keys(patch).length === 0) {
        onClose();
        return;
      }
      const res = await api.updateConfig(patch, true);
      if (res.dim_changed) {
        alert(
          'embedding.dim 已变更。已有的 HNSW 索引仍是旧维度,需要重启后端并对所有节点重新嵌入才能生效。',
        );
      }
      // Push fresh config into the global store so other panels reflect changes immediately
      await refresh();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const tabs: { key: typeof tab; label: string }[] = [
    { key: 'llm', label: 'Chat / LLM' },
    { key: 'embedding', label: 'Embedding' },
    { key: 'parameters', label: '参数' },
  ];

  return (
    <ModalShell onClose={onClose}>
      <div className="flex items-center border-b border-primary-100">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={
              'flex-1 px-3 py-2 text-sm transition-colors ' +
              (tab === t.key
                ? 'border-b-2 border-accent-500 text-primary-700'
                : 'text-primary-500 hover:text-primary-700')
            }
          >
            {t.label}
          </button>
        ))}
        <button
          onClick={() => void runPing()}
          disabled={pinging}
          className="mr-3 flex h-8 items-center gap-1 rounded bg-primary-50 px-2 text-xs text-primary-700 hover:bg-primary-100 disabled:opacity-50"
          title="向 LLM 和 Embedding 各发一次最小请求,验证连通性"
        >
          <Activity size={12} />
          {pinging ? '测试中...' : '测试连接'}
        </button>
      </div>
      {ping && (
        <div className="border-b border-primary-100 bg-primary-50/40 px-4 py-2 text-xs">
          <PingLine label="Chat" ms={ping.chat.ms} ok={ping.chat.ok} extra={ping.chat.ok ? `示例响应: ${ping.chat.sample?.slice(0, 60) ?? ''}` : ping.chat.error} />
          <PingLine
            label="Embedding"
            ms={ping.embedding.ms}
            ok={ping.embedding.ok}
            extra={ping.embedding.ok ? `dim=${ping.embedding.dim}` : ping.embedding.error}
          />
        </div>
      )}
      <div className="flex-1 space-y-3 overflow-y-auto p-4 text-sm">
        {tab === 'llm' && (
          <>
            <p className="text-xs text-primary-500/70">
              用于咨询员对话和图书管理员生成 synthesis(OpenAI 兼容接口)。
            </p>
            {hasEnvManaged(envManaged, 'llm') && <EnvManagedHint />}
            <Field
              label="base_url"
              value={draft.llm.base_url}
              onChange={(v) => setLLM('base_url', v)}
              envManaged={isEnv('llm.base_url')}
            />
            <SecretField
              label="api_key"
              value={draft.llm.api_key}
              onChange={(v) => setLLM('api_key', v)}
              envManaged={isEnv('llm.api_key')}
            />
            <Field
              label="chat_model"
              value={draft.llm.chat_model}
              onChange={(v) => setLLM('chat_model', v)}
              envManaged={isEnv('llm.chat_model')}
            />
          </>
        )}
        {tab === 'embedding' && (
          <>
            <p className="text-xs text-primary-500/70">
              embedding 可与 chat 走不同提供方(例如 chat 用 GLM,embedding 用 DashScope)。修改 model 或 dim 后,旧索引会与新维度冲突,需手动重建。
            </p>
            {hasEnvManaged(envManaged, 'embedding') && <EnvManagedHint />}
            <Field
              label="base_url"
              value={draft.embedding.base_url}
              onChange={(v) => setEmb('base_url', v)}
              envManaged={isEnv('embedding.base_url')}
            />
            <SecretField
              label="api_key"
              value={draft.embedding.api_key}
              onChange={(v) => setEmb('api_key', v)}
              envManaged={isEnv('embedding.api_key')}
            />
            <Field
              label="model"
              value={draft.embedding.model}
              onChange={(v) => setEmb('model', v)}
              envManaged={isEnv('embedding.model')}
            />
            <Field
              label="dim"
              value={String(draft.embedding.dim)}
              onChange={(v) => setEmb('dim', Number(v))}
              envManaged={isEnv('embedding.dim')}
            />
          </>
        )}
        {tab === 'parameters' && (
          <div className="space-y-2">
            {Object.entries(draft.parameters).map(([k, v]) => (
              <Field
                key={k}
                label={k}
                value={String(v)}
                onChange={(val) => setParam(k, Number(val))}
              />
            ))}
          </div>
        )}
        {error && <p className="rounded bg-red-50 p-2 text-xs text-red-600">{error}</p>}
      </div>
      <footer className="flex justify-end gap-2 border-t border-primary-100 px-4 py-3">
        <button
          onClick={onClose}
          className="rounded bg-primary-50 px-4 py-2 text-sm hover:bg-primary-100"
        >
          取消
        </button>
        <button
          onClick={() => void save()}
          disabled={saving}
          className="rounded bg-accent-500 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {saving ? '保存中...' : '保存'}
        </button>
      </footer>
    </ModalShell>
  );
}

function PingLine({
  label,
  ms,
  ok,
  extra,
}: {
  label: string;
  ms: number;
  ok: boolean;
  extra?: string;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span
        className={
          'inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] text-white ' +
          (ok ? 'bg-green-500' : 'bg-red-500')
        }
      >
        {ok ? '✓' : '✗'}
      </span>
      <span className="font-medium">{label}</span>
      <span className="text-primary-500/70">{ms}ms</span>
      {extra && (
        <span className={ok ? 'text-primary-500/70' : 'text-red-600'}>· {extra}</span>
      )}
    </div>
  );
}

function ModalShell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="flex h-[80vh] w-[640px] flex-col rounded-card bg-white shadow-lg">
        <header className="flex items-center justify-between border-b border-primary-100 px-4 py-3">
          <h2 className="font-semibold">设置</h2>
          <button onClick={onClose} className="rounded p-1 text-primary-500 hover:bg-primary-50">
            <X size={16} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

function hasEnvManaged(set: Set<string>, section: string): boolean {
  for (const k of set) if (k.startsWith(section + '.')) return true;
  return false;
}

function EnvManagedHint() {
  return (
    <div className="flex items-start gap-1.5 rounded border border-primary-100 bg-primary-50/40 p-2 text-[11px] text-primary-700">
      <Lock size={12} className="mt-0.5 text-primary-500" />
      <span>
        带 🔒 的字段由项目根目录的 <code className="rounded bg-white px-1 font-mono">.env</code> 接管。在这里改保存仅当前会话有效,下次启动会被 .env 重新覆盖。如需永久修改,请编辑 .env。
      </span>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  envManaged = false,
}: {
  label: string;
  value: string;
  type?: string;
  onChange: (v: string) => void;
  envManaged?: boolean;
}) {
  return (
    <label className="block">
      <span className="flex items-center gap-1 text-xs uppercase tracking-wide text-primary-500">
        {envManaged && <Lock size={10} />}
        <span>{label}</span>
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={
          'mt-1 w-full rounded border px-2 py-1 font-mono text-xs ' +
          (envManaged ? 'border-primary-100 bg-primary-50/30' : 'border-primary-100')
        }
      />
    </label>
  );
}

function SecretField({
  label,
  value,
  onChange,
  envManaged = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  envManaged?: boolean;
}) {
  const [reveal, setReveal] = useState(false);
  return (
    <label className="block">
      <span className="flex items-center justify-between text-xs uppercase tracking-wide text-primary-500">
        <span className="flex items-center gap-1">
          {envManaged && <Lock size={10} />}
          {label}
        </span>
        <span className="lowercase text-primary-500/60">长度 {value.length}</span>
      </span>
      <div className="mt-1 flex items-stretch gap-1">
        <input
          type={reveal ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className={
            'flex-1 rounded border px-2 py-1 font-mono text-xs ' +
            (envManaged ? 'border-primary-100 bg-primary-50/30' : 'border-primary-100')
          }
        />
        <button
          type="button"
          onClick={() => setReveal((v) => !v)}
          className="flex w-9 items-center justify-center rounded border border-primary-100 text-primary-500 hover:bg-primary-50"
          title={reveal ? '隐藏' : '显示'}
        >
          {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    </label>
  );
}
