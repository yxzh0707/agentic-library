import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { useKBStore } from '../../stores/kb_store';
import { api } from '../../api/client';
import { onEvent } from '../../api/ws';
import { GraphCanvas } from './GraphCanvas';
import type { GraphResponse } from './graphLayouts';
import { LAYOUT_PRESETS, type LayoutPresetKey } from './graphLayouts';

type ViewMode = 'standard' | 'compare';
const DEFAULT_STANDARD_PRESET: LayoutPresetKey = 'organic';

export function GraphTab() {
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('standard');
  const freshNodeIds = useKBStore((s) => s.freshNodeIds);
  const clearFreshNode = useKBStore((s) => s.clearFreshNode);
  const [selected, setSelected] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await api.fetchGraph();
      setGraph(res);
    } catch {
      setGraph({ nodes: [], links: [] });
    }
  };

  useEffect(() => {
    void load();
    return onEvent((ev) => {
      if (
        ev.type === 'node_created' ||
        ev.type === 'node_updated' ||
        ev.type === 'node_archived' ||
        ev.type === 'cluster_assigned'
      ) {
        void load();
      }
    });
  }, []);

  const handleSelectNode = (uuid: string | null) => {
    if (uuid) clearFreshNode(uuid);
    setSelected(uuid);
  };

  if (graph && graph.nodes.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm">
        <p className="text-primary-500">暂无节点</p>
        <p className="text-xs text-primary-500/60">从 Chat 面板上传文件,或调用 /api/import/text</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* View mode toggle */}
      <div className="flex shrink-0 items-center justify-between border-b border-primary-100 bg-white px-4 py-2">
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium text-primary-700">图谱布局</span>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-primary-100 bg-primary-50 p-0.5">
          <button
            onClick={() => setViewMode('standard')}
            className={clsx(
              'rounded px-3 py-1 text-xs transition-colors',
              viewMode === 'standard'
                ? 'bg-white text-primary-700 shadow-sm'
                : 'text-primary-500 hover:text-primary-700',
            )}
          >
            有机散点
          </button>
          <button
            onClick={() => setViewMode('compare')}
            className={clsx(
              'rounded px-3 py-1 text-xs transition-colors',
              viewMode === 'compare'
                ? 'bg-white text-primary-700 shadow-sm'
                : 'text-primary-500 hover:text-primary-700',
            )}
          >
            三方案对比
          </button>
        </div>
      </div>

      {/* Graph area */}
      <div className="flex-1 overflow-hidden">
        {viewMode === 'standard' ? (
          <GraphCanvas
            graph={graph}
            freshNodeIds={freshNodeIds}
            selected={selected}
            onSelectNode={handleSelectNode}
            preset={DEFAULT_STANDARD_PRESET}
            compact={false}
          />
        ) : (
          <div className="grid h-full grid-cols-3 gap-px bg-primary-100">
            {LAYOUT_PRESETS.map((preset) => (
              <div key={preset.key} className="relative flex flex-col bg-white">
                {/* Card header */}
                <div className="shrink-0 border-b border-primary-100 bg-primary-50 px-3 py-2">
                  <div className="text-xs font-semibold text-primary-700">{preset.title}</div>
                  <div className="mt-0.5 text-[10px] text-primary-500/70">{preset.subtitle}</div>
                </div>
                {/* Graph canvas */}
                <div className="flex-1 overflow-hidden">
                  <GraphCanvas
                    graph={graph}
                    freshNodeIds={freshNodeIds}
                    selected={selected}
                    onSelectNode={handleSelectNode}
                    preset={preset.key}
                    compact={true}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}