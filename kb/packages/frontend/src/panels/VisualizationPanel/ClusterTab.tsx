import { useState } from 'react';
import { useKBStore } from '../../stores/kb_store';
import { api } from '../../api/client';
import type { NodeBrief } from '@kb/shared';

function labelSourceTag(source: string): string {
  switch (source) {
    case 'llm_seed':
      return 'LLM 冷启动';
    case 'llm_grown':
      return 'LLM 增长';
    case 'auto_llm_named':
      return 'LLM 命名';
    case 'auto':
      return '自动';
    case 'llm_relabel':
      return 'LLM 重命名';
    default:
      return source;
  }
}

export function ClusterTab() {
  const clusters = useKBStore((s) => s.clusters);
  const [selected, setSelected] = useState<number | null>(null);
  const [members, setMembers] = useState<NodeBrief[]>([]);

  const select = async (id: number) => {
    setSelected(id);
    const res = await api.getCluster(id);
    setMembers(res.members);
  };

  return (
    <div className="grid h-full grid-cols-2">
      <div className="overflow-y-auto border-r border-primary-100 p-3 text-sm">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-primary-500">
          簇列表(共 {clusters.length})
        </h3>
        {clusters.length === 0 && (
          <p className="text-xs text-primary-500/60">尚未生成簇,运行月整理或导入更多节点</p>
        )}
        <ul className="space-y-1">
          {clusters.map((c) => (
            <li key={c.cluster_id}>
              <button
                onClick={() => void select(c.cluster_id)}
                className={
                  'block w-full rounded px-2 py-1 text-left text-xs ' +
                  (selected === c.cluster_id ? 'bg-accent-500/10 text-accent-500' : 'hover:bg-primary-50')
                }
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    {c.label ? c.label : <span className="text-primary-500/70">#{c.cluster_id}</span>}
                  </span>
                  <span className="text-[10px] text-primary-500/70">{c.member_count} 个成员</span>
                </div>
                {c.label && (
                  <div className="mt-0.5 text-[10px] text-primary-500/60">
                    #{c.cluster_id}
                    {c.label_source ? ` · ${labelSourceTag(c.label_source)}` : ''}
                    {c.homogeneous === 1 ? ' · mono-topic' : ''}
                  </div>
                )}
                {c.description && <span className="block text-[10px] text-primary-500/70">{c.description}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="overflow-y-auto p-3 text-sm">
        {selected === null ? (
          <p className="text-xs text-primary-500/60">从左侧选择一个簇</p>
        ) : (
          <ul className="space-y-2">
            {members.map((m) => (
              <li key={m.uuid} className="rounded border border-primary-100 p-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{m.node_type}</span>
                  <span className="text-primary-500/70">{m.uuid.slice(0, 8)}</span>
                </div>
                <p className="mt-1 text-primary-500">{m.l0_summary || '(无摘要)'}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
