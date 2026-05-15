import { useState } from 'react';
import { useKBStore } from '../../stores/kb_store';
import { api } from '../../api/client';

const PERMS = ['read', 'write', 'structural', 'admin'] as const;

export function AgentManagementSection() {
  const config = useKBStore((s) => s.config);
  const refresh = useKBStore((s) => s.refresh);
  const [agentId, setAgentId] = useState('');
  const [perms, setPerms] = useState<string[]>(['read']);
  const [created, setCreated] = useState<{ agent_id: string; api_key: string } | null>(null);

  if (!config) return null;
  const agents = config.external_agents ?? [];

  const create = async () => {
    if (!agentId) return;
    const res = await api.createAgent(agentId, perms);
    setCreated({ agent_id: res.agent.agent_id, api_key: res.api_key });
    setAgentId('');
    setPerms(['read']);
    void refresh();
  };

  const togglePerm = (p: string) => {
    setPerms((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));
  };

  return (
    <section className="rounded-card border border-primary-100 bg-white p-3 text-xs">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-primary-500">
        外部 Agent
      </h3>
      {agents.length === 0 ? (
        <p className="text-primary-500/60">尚未创建外部 agent</p>
      ) : (
        <ul className="space-y-1">
          {agents.map((a) => (
            <li key={a.agent_id} className="flex justify-between">
              <span>{a.agent_id}</span>
              <span className="text-primary-500">{a.permissions.join(', ')}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 space-y-2 border-t border-primary-100 pt-3">
        <input
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          placeholder="agent_id"
          className="w-full rounded border border-primary-100 px-2 py-1"
        />
        <div className="flex flex-wrap gap-1">
          {PERMS.map((p) => (
            <label key={p} className="flex items-center gap-1">
              <input type="checkbox" checked={perms.includes(p)} onChange={() => togglePerm(p)} />
              {p}
            </label>
          ))}
        </div>
        <button
          onClick={() => void create()}
          disabled={!agentId}
          className="w-full rounded bg-accent-500 px-2 py-1 text-white disabled:opacity-50"
        >
          创建并生成 api_key
        </button>
        {created && (
          <div className="rounded border border-accent-500 p-2">
            <div>已创建 agent <strong>{created.agent_id}</strong></div>
            <div className="mt-1 break-all font-mono">api_key: {created.api_key}</div>
            <div className="mt-1 text-primary-500/70">这是唯一一次显示完整 api_key,请保存。</div>
          </div>
        )}
      </div>
    </section>
  );
}
