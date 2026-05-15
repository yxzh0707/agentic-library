import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { ForceGraphMethods } from 'react-force-graph-2d';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { X } from 'lucide-react';
import type { Node } from '@kb/shared';
import type {
  RNode,
  RLink,
  RenderData,
  LayoutPresetKey,
} from './graphLayouts';
import {
  applyLayoutPreset,
  buildRenderData,
  colorForNode,
  forceSettingsForPreset,
  LAYOUT_PRESETS,
} from './graphLayouts';

interface GraphCanvasProps {
  graph: import('./graphLayouts').GraphResponse | null;
  freshNodeIds: Set<string>;
  selected: string | null;
  onSelectNode: (uuid: string | null) => void;
  preset: LayoutPresetKey;
  compact?: boolean;
}

export function GraphCanvas({
  graph,
  freshNodeIds,
  selected,
  onSelectNode,
  preset,
  compact = false,
}: GraphCanvasProps) {
  const ref = useRef<ForceGraphMethods | undefined>(undefined);
  const initialized = useRef(false);

  const rawData = useMemo(
    () => buildRenderData(graph, freshNodeIds, new Set()),
    [graph, freshNodeIds],
  );
  const data = useMemo(() => applyLayoutPreset(rawData, preset), [rawData, preset]);
  const settings = useMemo(() => forceSettingsForPreset(preset), [preset]);

  const [hovered, setHovered] = useState<RNode | null>(null);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    if (!ref.current || data.nodes.length === 0) return;
    const linkForce = ref.current.d3Force?.('link') as
      | { strength?: (n: number) => unknown; distance?: (fn: (l: RLink) => number) => unknown }
      | undefined;
    if (typeof linkForce?.distance === 'function') {
      linkForce.distance(settings.linkDistance as (l: unknown) => number);
    }
    linkForce?.strength?.(settings.linkStrength);
    const chargeForce = ref.current.d3Force?.('charge') as
      | { strength: (n: number) => unknown }
      | undefined;
    if (typeof chargeForce?.strength === 'function') {
      chargeForce.strength(settings.chargeStrength);
    }
    ref.current.d3ReheatSimulation?.();
  }, [data, preset, settings]);

  useEffect(() => {
    if (!ref.current || data.nodes.length === 0) return;
    if (!initialized.current) {
      initialized.current = true;
      const t = setTimeout(
        () => ref.current?.zoomToFit?.(400, settings.zoomPadding),
        400,
      );
      return () => clearTimeout(t);
    }
  }, [data.nodes.length, settings.zoomPadding]);

  
  const selectNode = useCallback(
    async (id: string) => {
      if (id.startsWith('__virtual_') || id.startsWith('__parent_cluster_')) return;
      onSelectNode(id);
      setLoadingDetail(true);
      try {
        const res = await fetch(`/api/nodes/${id}`);
        if (res.ok) {
          const node = await res.json() as Node;
          setSelectedNode(node);
        }
      } finally {
        setLoadingDetail(false);
      }
    },
    [onSelectNode],
  );

  const detailPanel = selectedNode ? (
    <aside className="absolute right-0 top-0 flex h-full w-[55%] max-w-[480px] flex-col border-l border-primary-100 bg-white shadow-lg">
      <header className="flex items-center justify-between border-b border-primary-100 px-3 py-2">
        <span className="text-xs font-mono text-primary-500/70">
          {selectedNode.uuid.slice(0, 8)}
        </span>
        <button
          onClick={() => {
            setSelectedNode(null);
            onSelectNode(null);
          }}
          className="rounded p-1 text-primary-500 hover:bg-primary-50"
        >
          <X size={14} />
        </button>
      </header>
      {loadingDetail ? (
        <div className="p-4 text-sm text-primary-500/60">加载中...</div>
      ) : (
        <div className="flex-1 space-y-3 overflow-y-auto p-3 text-sm">
          <div className="flex items-center gap-2">
            <span
              className={
                'rounded px-2 py-0.5 text-[10px] ' +
                (selectedNode.node_type === 'synthesis'
                  ? 'bg-accent-500/10 text-accent-500'
                  : 'bg-primary-500/10 text-primary-700')
              }
            >
              {selectedNode.node_type}
            </span>
            {selectedNode.current_path && (
              <span className="text-[10px] text-primary-500/70">
                {selectedNode.current_path}
              </span>
            )}
          </div>
          <h2 className="text-base font-semibold">
            {selectedNode.l0_summary || '(无摘要)'}
          </h2>
          {selectedNode.l1_overview && (
            <p className="rounded bg-primary-50/60 p-2 text-xs text-primary-700">
              {selectedNode.l1_overview}
            </p>
          )}
          <div className="prose prose-sm max-w-none text-primary-700">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {selectedNode.body}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </aside>
  ) : null;

  const legend = (
    <div className="absolute bottom-3 left-3 rounded bg-white/95 px-3 py-2 text-[10px] shadow ring-1 ring-primary-100 leading-relaxed">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold text-primary-700">层级</span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-4 w-4"
            style={{
              background: '#1E1B4B',
              clipPath:
                'polygon(30% 0%, 70% 0%, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0% 70%, 0% 30%)',
            }}
          />
          <strong>根中心</strong>（KB）
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-3.5 w-3.5 rounded-full"
            style={{ background: '#DC2626' }}
          />
          <strong>原始中心</strong>
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: '#EAB308' }}
          />
          子簇中心
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: '#16A34A' }}
          />
          子簇成员
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: '#9333EA' }}
          />
          直属成员
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: '#A78BFA' }}
          />
          边缘节点
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: '#94A3B8' }}
          />
          未聚类
        </span>
      </div>
      {!compact && (
        <div className="mt-1 text-primary-500/70">
          边长 ∝ 语义距离；黄虚线 ? = 前端聚合的未命名子主题；点击节点查看详情。
        </div>
      )}
    </div>
  );

  return (
    <div className="relative h-full">
      <ForceGraph2D
        ref={ref}
        graphData={data}
        nodeLabel={(n) => (n as RNode).label}
        nodeRelSize={compact ? 2 : 4}
        cooldownTicks={settings.cooldownTicks}
        d3AlphaDecay={settings.alphaDecay}
        enableNodeDrag={true}
        enableZoomInteraction={true}
        onEngineStop={() => {
          ref.current?.zoomToFit?.(400, settings.zoomPadding);
        }}
        linkColor={(l) => {
          const k = (l as RLink).kind;
          if (k === 'cluster_to_root') return 'rgba(30, 27, 75, 0.4)';
          if (k === 'edge_to_root') return 'rgba(167, 139, 250, 0.35)';
          if (k === 'wikilink') return 'rgba(100, 116, 139, 0.7)';
          if (k === 'sub_to_main') return 'rgba(234, 179, 8, 0.55)';
          if (k === 'sub_member') return 'rgba(22, 163, 74, 0.4)';
          return 'rgba(147, 51, 234, 0.35)';
        }}
        linkWidth={(l) => {
          const k = (l as RLink).kind;
          if (k === 'cluster_to_root') return 2;
          if (k === 'sub_to_main') return 1.4;
          if (k === 'wikilink') return 1;
          if (k === 'edge_to_root') return 0.5;
          return 0.6;
        }}
        nodeCanvasObject={(node, ctx, globalScale) => {
          const n = node as RNode;
          const pulse = n.isFresh ? 1 + Math.sin(Date.now() / 260) * 0.12 : 1;
          const r = n.size * pulse;
          const cx = n.x ?? 0;
          const cy = n.y ?? 0;
          const fill = colorForNode(n);

          if (n.tier === 'root_hub') {
            ctx.fillStyle = fill;
            ctx.beginPath();
            for (let i = 0; i < 8; i++) {
              const a = (i / 8) * 2 * Math.PI - Math.PI / 8;
              const x = cx + r * Math.cos(a);
              const y = cy + r * Math.sin(a);
              if (i === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            }
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = '#FFFFFF';
            ctx.font = `bold ${Math.max(9, 11 / globalScale)}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('KB', cx, cy);
          } else if (n.tier === 'virtual_sub_hub') {
            ctx.strokeStyle = fill;
            ctx.fillStyle = 'rgba(234, 179, 8, 0.15)';
            ctx.lineWidth = 1.5 / globalScale;
            ctx.setLineDash([3 / globalScale, 3 / globalScale]);
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, 2 * Math.PI);
            ctx.fill();
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = '#854D0E';
            ctx.font = `${Math.max(8, 10 / globalScale)}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('?', cx, cy);
          } else if (n.tier === 'synthesis_hub') {
            ctx.fillStyle = fill;
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(Math.PI / 4);
            ctx.fillRect(-r, -r, r * 2, r * 2);
            ctx.restore();
          } else {
            ctx.fillStyle = fill;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, 2 * Math.PI);
            ctx.fill();
          }

          if (selected === n.id) {
            ctx.beginPath();
            ctx.arc(cx, cy, r + 9, 0, 2 * Math.PI);
            ctx.strokeStyle = '#22D3EE';
            ctx.lineWidth = 2 / globalScale;
            ctx.stroke();
          }

        }}
        onNodeClick={(n) => {
          const rn = n as RNode;
          if (rn.tier !== 'cluster_hub' && rn.tier !== 'synthesis_hub') {
            void selectNode(rn.id);
          }
        }}
        onNodeHover={(n) => setHovered((n as RNode | null) ?? null)}
        backgroundColor="#fbfcfd"
      />

      {hovered && (
        <div className="pointer-events-none absolute left-3 top-3 max-w-[60%] rounded bg-white/95 px-2 py-1 text-xs shadow ring-1 ring-primary-100">
          <div className="font-medium">{hovered.label}</div>
          <div className="mt-0.5 text-[10px] text-primary-500/80">
            {hovered.tier === 'virtual_sub_hub' && (
              <>前端聚合: 同簇内 ≥3 个未归属任何 sub_hub 的成员</>
            )}
            {hovered.tier === 'root_hub' && (
              <>父簇 · 包含 {(graph?.cluster_tree ?? []).filter((c) => c.parent_cluster_id === hovered.cluster_id).length} 个子簇</>
            )}
            {(hovered.tier === 'cluster_hub' || hovered.tier === 'synthesis_hub') && (
              <>cluster #{hovered.cluster_id} 的中心</>
            )}
            {hovered.tier !== 'virtual_sub_hub' &&
              hovered.tier !== 'root_hub' &&
              hovered.tier !== 'cluster_hub' &&
              hovered.tier !== 'synthesis_hub' && (
                <>tier={hovered.tier} · hub_role={hovered.hubRole} · cluster {hovered.tier === 'unclustered' ? 'noise' : `#${hovered.cluster_id}`}</>
              )}
          </div>
        </div>
      )}

      {legend}

      {detailPanel}
    </div>
  );
}