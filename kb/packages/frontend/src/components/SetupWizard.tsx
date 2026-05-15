import { useState } from 'react';
import { useKBStore } from '../stores/kb_store';

export function SetupWizard({ onClose }: { onClose: () => void }) {
  const config = useKBStore((s) => s.config);
  const saveConfig = useKBStore((s) => s.saveConfig);
  const [step, setStep] = useState(0);
  const [llm, setLlm] = useState({
    base_url: config?.llm.base_url ?? '',
    api_key: config?.llm.api_key?.startsWith('****') ? '' : config?.llm.api_key ?? '',
    chat_model: config?.llm.chat_model ?? '',
  });
  const [emb, setEmb] = useState({
    base_url: config?.embedding.base_url ?? '',
    api_key: config?.embedding.api_key?.startsWith('****') ? '' : config?.embedding.api_key ?? '',
    model: config?.embedding.model ?? '',
    dim: config?.embedding.dim ?? 1024,
  });
  const [saving, setSaving] = useState(false);

  const finish = async () => {
    setSaving(true);
    try {
      await saveConfig({
        llm: { ...config!.llm, ...llm },
        embedding: { ...config!.embedding, ...emb },
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[520px] space-y-4 rounded-card bg-white p-6">
        <h2 className="text-lg font-semibold">首次配置</h2>
        {step === 0 && (
          <div className="space-y-2 text-sm">
            <p>
              欢迎使用 Knowledge Base v1.0。数据将保存在{' '}
              <code className="rounded bg-primary-50 px-1 text-xs">{config?.data_dir}</code>。
              下一步配置 Chat 和 Embedding。Embedding 可与 chat 走不同的服务商(例如 chat 用 GLM,embedding 用 DashScope)。
              也可以在项目根目录的 <code className="rounded bg-primary-50 px-1 text-xs">.env</code> 中预填,见 <code className="rounded bg-primary-50 px-1 text-xs">.env.example</code>。
            </p>
            <button className="w-full rounded bg-accent-500 py-2 text-white" onClick={() => setStep(1)}>
              下一步
            </button>
          </div>
        )}
        {step === 1 && (
          <div className="space-y-3 text-sm">
            <h3 className="font-semibold">Chat / LLM</h3>
            <Input label="base_url" value={llm.base_url} onChange={(v) => setLlm({ ...llm, base_url: v })} />
            <Input
              label="api_key"
              type="password"
              value={llm.api_key}
              onChange={(v) => setLlm({ ...llm, api_key: v })}
            />
            <Input
              label="chat_model"
              value={llm.chat_model}
              onChange={(v) => setLlm({ ...llm, chat_model: v })}
            />
            <div className="flex gap-2">
              <button className="flex-1 rounded bg-primary-50 py-2" onClick={() => setStep(0)}>
                上一步
              </button>
              <button
                className="flex-1 rounded bg-accent-500 py-2 text-white disabled:opacity-50"
                disabled={!llm.base_url || !llm.api_key || !llm.chat_model}
                onClick={() => setStep(2)}
              >
                下一步
              </button>
            </div>
          </div>
        )}
        {step === 2 && (
          <div className="space-y-3 text-sm">
            <h3 className="font-semibold">Embedding</h3>
            <Input label="base_url" value={emb.base_url} onChange={(v) => setEmb({ ...emb, base_url: v })} />
            <Input
              label="api_key"
              type="password"
              value={emb.api_key}
              onChange={(v) => setEmb({ ...emb, api_key: v })}
            />
            <Input label="model" value={emb.model} onChange={(v) => setEmb({ ...emb, model: v })} />
            <Input
              label="dim"
              value={String(emb.dim)}
              onChange={(v) => setEmb({ ...emb, dim: Number(v) })}
            />
            <div className="flex gap-2">
              <button className="flex-1 rounded bg-primary-50 py-2" onClick={() => setStep(1)}>
                上一步
              </button>
              <button
                disabled={!emb.base_url || !emb.api_key || !emb.model || saving}
                className="flex-1 rounded bg-accent-500 py-2 text-white disabled:opacity-50"
                onClick={() => void finish()}
              >
                {saving ? '保存中...' : '完成'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Input({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-wide text-primary-500">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded border border-primary-100 px-2 py-1 font-mono text-xs"
      />
    </label>
  );
}
