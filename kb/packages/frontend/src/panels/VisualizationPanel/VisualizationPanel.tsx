import { useState } from 'react';
import clsx from 'clsx';
import { NodesTab } from './NodesTab';
import { GraphTab } from './GraphTab';
import { ClusterTab } from './ClusterTab';
import { OpLogTab } from './OpLogTab';

type Tab = 'nodes' | 'graph' | 'cluster' | 'oplog';

const tabs: { key: Tab; label: string }[] = [
  { key: 'nodes', label: '节点' },
  { key: 'graph', label: '知识图谱' },
  { key: 'cluster', label: '聚类视图' },
  { key: 'oplog', label: '操作日志' },
];

export function VisualizationPanel() {
  const [active, setActive] = useState<Tab>('nodes');

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex border-b border-primary-100">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setActive(t.key)}
            className={clsx(
              'flex-1 px-3 py-3 text-sm transition-colors',
              active === t.key
                ? 'border-b-2 border-accent-500 text-primary-700'
                : 'text-primary-500 hover:text-primary-700',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-hidden">
        {active === 'nodes' && <NodesTab />}
        {active === 'graph' && <GraphTab />}
        {active === 'cluster' && <ClusterTab />}
        {active === 'oplog' && <OpLogTab />}
      </div>
    </div>
  );
}
