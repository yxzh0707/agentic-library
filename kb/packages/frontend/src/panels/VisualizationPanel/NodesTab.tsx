import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { useKBStore } from '../../stores/kb_store';
import { onEvent } from '../../api/ws';
import type { Node, NodeBrief } from '@kb/shared';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type Filter = 'all' | 'raw' | 'synthesis' | 'archived';

type GroupedItem =
  | { kind: 'single'; node: NodeBrief }
  | { kind: 'group'; cluster_id: number; head: NodeBrief; members: NodeBrief[] }
  | {
      kind: 'parent_group';
      parent_cluster_id: number;
      label: string;
      child_groups: { cluster_id: number; head: NodeBrief; members: NodeBrief[] }[];
      total_members: number;
    };

export function NodesTab() {
  const nodes = useKBStore((s) => s.nodes);
  const clusters = useKBStore((s) => s.clusters);
  const refresh = useKBStore((s) => s.refresh);
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<Node | null>(null);
  const [loading, setLoading] = useState(false);
  // expanded keys: cluster:N (子簇展开) / parent:N (父簇展开)
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    void refresh();
    return onEvent((ev) => {
      if (ev.type === 'node_created' || ev.type === 'node_updated' || ev.type === 'node_archived') {
        void refresh();
      }
    });
  }, [refresh]);

  const filtered = nodes.filter((n) => {
    if (filter === 'all') return n.status === 'active';
    if (filter === 'archived') return n.status !== 'active';
    return n.status === 'active' && n.node_type === filter;
  });

  // 'all' view: build 3-level tree —
  //   parent_group (virtual parent cluster, e.g. "推荐系统赛题")
  //     → group   (子簇, head = cluster_review)
  //         → single (raw 成员)
  // Children of a parent appear under it; standalone clusters (no parent)
  // appear at top level as plain groups.
  const items: GroupedItem[] = useMemo(() => {
    if (filter !== 'all') return filtered.map((n) => ({ kind: 'single', node: n }));

    // Step 1: bucket nodes by effective cluster_id.
    //   - raw nodes: cluster_id (HDBSCAN-assigned)
    //   - cluster_review synthesis: reviewed_cluster_id (always set; derived
    //     cluster_id can be NULL when sources span multiple clusters after
    //     a fullRecluster shuffle)
    //   - other synthesis: cluster_id (derived from sources)
    const byCluster = new Map<number, NodeBrief[]>();
    const orphans: NodeBrief[] = [];
    for (const n of filtered) {
      const effectiveCid =
        n.synthesis_subtype === 'cluster_review' && n.reviewed_cluster_id != null
          ? n.reviewed_cluster_id
          : n.cluster_id;
      if (effectiveCid === null || effectiveCid === undefined) {
        orphans.push(n);
      } else {
        const arr = byCluster.get(effectiveCid) ?? [];
        arr.push(n);
        byCluster.set(effectiveCid, arr);
      }
    }

    // Step 2: build child groups (cluster_id -> { head, members })
    const childGroupByCluster = new Map<
      number,
      { cluster_id: number; head: NodeBrief; members: NodeBrief[] }
    >();
    const flatSingles: GroupedItem[] = [];
    for (const [cid, members] of byCluster) {
      const head =
        members.find((m) => m.node_type === 'synthesis' && m.synthesis_subtype === 'cluster_review') ??
        members.find((m) => m.node_type === 'synthesis');
      if (head) {
        childGroupByCluster.set(cid, {
          cluster_id: cid,
          head,
          members: members.filter((m) => m.uuid !== head.uuid),
        });
      } else {
        for (const m of members) flatSingles.push({ kind: 'single', node: m });
      }
    }

    // Step 3: lookup parent for each cluster from clusters store
    const clusterMeta = new Map<number, { parent: number | null; description: string | null }>();
    for (const c of clusters) {
      clusterMeta.set(c.cluster_id, {
        parent: c.parent_cluster_id ?? null,
        description: c.description ?? null,
      });
    }

    // Step 4: gather parent → children map
    const childrenOfParent = new Map<number, number[]>();
    for (const [cid] of childGroupByCluster) {
      const meta = clusterMeta.get(cid);
      const pid = meta?.parent ?? null;
      if (pid !== null) {
        const list = childrenOfParent.get(pid) ?? [];
        list.push(cid);
        childrenOfParent.set(pid, list);
      }
    }

    // Step 5: emit items —
    //   parent_groups first (with their child sub-groups, only when ≥2 children)
    //   then standalone groups (no parent, or single-child parent flattened)
    //   then orphan singles
    const out: GroupedItem[] = [];
    const consumed = new Set<number>();
    for (const [pid, childCids] of childrenOfParent) {
      const parentMeta = clusterMeta.get(pid);
      const childGroups = childCids
        .map((cid) => childGroupByCluster.get(cid))
        .filter((g): g is NonNullable<typeof g> => !!g);
      if (childGroups.length >= 2) {
        const totalMembers = childGroups.reduce((n, g) => n + 1 + g.members.length, 0);
        out.push({
          kind: 'parent_group',
          parent_cluster_id: pid,
          label: parentMeta?.description ?? `父簇 #${pid}`,
          child_groups: childGroups,
          total_members: totalMembers,
        });
      } else {
        // Single-child parent: flatten — emit each child as a standalone group.
        for (const g of childGroups) {
          out.push({ kind: 'group', cluster_id: g.cluster_id, head: g.head, members: g.members });
        }
      }
      for (const cid of childCids) consumed.add(cid);
    }
    for (const [cid, group] of childGroupByCluster) {
      if (consumed.has(cid)) continue;
      out.push({ kind: 'group', cluster_id: cid, head: group.head, members: group.members });
    }
    for (const s of flatSingles) out.push(s);
    for (const m of orphans) out.push({ kind: 'single', node: m });
    return out;
  }, [filter, filtered, clusters]);

  const groupCount = items.reduce((n, it) => {
    if (it.kind === 'group') return n + 1;
    if (it.kind === 'parent_group') return n + it.child_groups.length;
    return n;
  }, 0);
  const collapsedCount = items.reduce((n, it) => {
    if (it.kind === 'group' && !expanded.has(`cluster:${it.cluster_id}`)) {
      return n + it.members.length;
    }
    if (it.kind === 'parent_group') {
      const parentExpanded = expanded.has(`parent:${it.parent_cluster_id}`);
      if (!parentExpanded) return n + it.total_members;
      // parent expanded: count children that are themselves collapsed
      return (
        n +
        it.child_groups.reduce(
          (a, g) => a + (expanded.has(`cluster:${g.cluster_id}`) ? 0 : g.members.length),
          0,
        )
      );
    }
    return n;
  }, 0);
  const parentCount = items.filter((i) => i.kind === 'parent_group').length;

  const toggleExpand = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const select = async (uuid: string) => {
    setLoading(true);
    try {
      const node = await api.getNode(uuid);
      setSelected(node);
    } finally {
      setLoading(false);
    }
  };

  const archive = async (uuid: string) => {
    if (!confirm(`归档节点 ${uuid.slice(0, 8)}?\n\n（节点会保留在"已归档"列表里,可恢复）`)) return;
    try {
      await api.archiveNode(uuid);
      if (selected?.uuid === uuid) setSelected(null);
      await refresh();
    } catch (err) {
      alert(`归档失败: ${(err as Error).message}`);
    }
  };

  const hardDelete = async (uuid: string) => {
    if (!confirm(`⚠️ 硬删除节点 ${uuid.slice(0, 8)}?\n\n这会永久删除 markdown 文件 + SQL 数据 + 关联边。\n用于清理污染数据,不可恢复。`)) return;
    try {
      await api.deleteNode(uuid);
      if (selected?.uuid === uuid) setSelected(null);
      await refresh();
    } catch (err) {
      alert(`删除失败: ${(err as Error).message}`);
    }
  };

  return (
    <div className="grid h-full grid-cols-[42%_58%]">
      <div className="flex flex-col overflow-hidden border-r border-primary-100">
        <div className="flex items-center gap-1 border-b border-primary-100 p-2 text-xs">
          {(['all', 'raw', 'synthesis', 'archived'] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={
                'rounded px-2 py-1 ' +
                (filter === f ? 'bg-accent-500/10 text-accent-500' : 'text-primary-500 hover:bg-primary-50')
              }
            >
              {f}
            </button>
          ))}
          <button
            onClick={() => void refresh()}
            className="ml-auto rounded px-2 py-1 text-primary-500 hover:bg-primary-50"
          >
            刷新
          </button>
        </div>
        <div className="border-b border-primary-100 px-3 py-1.5 text-[11px] text-primary-500/80">
          共 {filtered.length} 个节点
          {filter === 'all' && parentCount > 0 && <> · {parentCount} 个父簇</>}
          {filter === 'all' && groupCount > 0 && <> · {groupCount} 个簇组</>}
          {filter === 'all' && collapsedCount > 0 && ` · 已收起 ${collapsedCount} 个子节点`}
        </div>
        <div className="flex-1 overflow-y-auto p-2 text-xs">
          {filtered.length === 0 && (
            <p className="p-3 text-center text-primary-500/60">无节点</p>
          )}
          <ul className="space-y-1">
            {items.map((item) => {
              if (item.kind === 'single') {
                const n = item.node;
                return (
                  <NodeRow
                    key={n.uuid}
                    node={n}
                    selected={selected?.uuid === n.uuid}
                    onClick={() => void select(n.uuid)}
                    onArchive={() => void archive(n.uuid)}
                    onDelete={() => void hardDelete(n.uuid)}
                  />
                );
              }
              if (item.kind === 'group') {
                const isExpanded = expanded.has(`cluster:${item.cluster_id}`);
                return (
                  <li key={`group-${item.cluster_id}`}>
                    <NodeRow
                      node={item.head}
                      selected={selected?.uuid === item.head.uuid}
                      onClick={() => void select(item.head.uuid)}
                      onArchive={() => void archive(item.head.uuid)}
                      onDelete={() => void hardDelete(item.head.uuid)}
                      groupSize={item.members.length}
                      expanded={isExpanded}
                      onToggleExpand={() => toggleExpand(`cluster:${item.cluster_id}`)}
                    />
                    {isExpanded && item.members.length > 0 && (
                      <ul className="mt-1 space-y-1 border-l-2 border-accent-500/30 pl-3">
                        {item.members.map((m) => (
                          <NodeRow
                            key={m.uuid}
                            node={m}
                            selected={selected?.uuid === m.uuid}
                            onClick={() => void select(m.uuid)}
                            onArchive={() => void archive(m.uuid)}
                            onDelete={() => void hardDelete(m.uuid)}
                          />
                        ))}
                      </ul>
                    )}
                  </li>
                );
              }
              // parent_group
              const parentExpanded = expanded.has(`parent:${item.parent_cluster_id}`);
              return (
                <li key={`parent-${item.parent_cluster_id}`}>
                  <ParentRow
                    label={item.label}
                    parentClusterId={item.parent_cluster_id}
                    childCount={item.child_groups.length}
                    totalMembers={item.total_members}
                    expanded={parentExpanded}
                    onToggle={() => toggleExpand(`parent:${item.parent_cluster_id}`)}
                  />
                  {parentExpanded && (
                    <ul className="mt-1 space-y-1 border-l-2 border-indigo-400/40 pl-3">
                      {item.child_groups.map((g) => {
                        const childExp = expanded.has(`cluster:${g.cluster_id}`);
                        return (
                          <li key={`child-${g.cluster_id}`}>
                            <NodeRow
                              node={g.head}
                              selected={selected?.uuid === g.head.uuid}
                              onClick={() => void select(g.head.uuid)}
                              onArchive={() => void archive(g.head.uuid)}
                              onDelete={() => void hardDelete(g.head.uuid)}
                              groupSize={g.members.length}
                              expanded={childExp}
                              onToggleExpand={() => toggleExpand(`cluster:${g.cluster_id}`)}
                            />
                            {childExp && g.members.length > 0 && (
                              <ul className="mt-1 space-y-1 border-l-2 border-accent-500/30 pl-3">
                                {g.members.map((m) => (
                                  <NodeRow
                                    key={m.uuid}
                                    node={m}
                                    selected={selected?.uuid === m.uuid}
                                    onClick={() => void select(m.uuid)}
                                    onArchive={() => void archive(m.uuid)}
                                    onDelete={() => void hardDelete(m.uuid)}
                                  />
                                ))}
                              </ul>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
      <div className="overflow-y-auto p-3 text-sm">
        {loading ? (
          <p className="text-primary-500/60">加载中...</p>
        ) : !selected ? (
          <p className="text-primary-500/60">从左侧选择一个节点查看详情</p>
        ) : (
          <NodeDetail node={selected} />
        )}
      </div>
    </div>
  );
}

function ParentRow({
  label,
  parentClusterId,
  childCount,
  totalMembers,
  expanded,
  onToggle,
}: {
  label: string;
  parentClusterId: number;
  childCount: number;
  totalMembers: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="block w-full rounded border border-indigo-300 bg-indigo-50/50 px-2 py-1.5 text-left text-xs transition-colors hover:bg-indigo-100/60"
      title={expanded ? '收起父簇' : `展开 ${childCount} 个子簇 / 共 ${totalMembers} 个节点`}
    >
      <div className="flex items-center justify-between">
        <span className="rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">
          父簇 #{parentClusterId}
        </span>
        <span className="flex items-center gap-1 text-[10px] text-indigo-600">
          <span className="leading-none">{expanded ? '▾' : '▸'}</span>
          <span>{childCount} 子簇 / {totalMembers}</span>
        </span>
      </div>
      <p className="mt-1 line-clamp-2 font-medium text-indigo-900">{label}</p>
    </button>
  );
}

function NodeRow({
  node,
  selected,
  onClick,
  onArchive,
  onDelete,
  groupSize,
  expanded,
  onToggleExpand,
}: {
  node: NodeBrief;
  selected: boolean;
  onClick: () => void;
  onArchive: () => void;
  onDelete: () => void;
  groupSize?: number;
  expanded?: boolean;
  onToggleExpand?: () => void;
}) {
  const stage = pipelineStage(node);
  const isGroupHead = groupSize !== undefined && onToggleExpand !== undefined;
  return (
    <li>
      <div
        className={
          'group block w-full rounded border px-2 py-1.5 text-left transition-colors ' +
          (selected
            ? 'border-accent-500 bg-accent-500/5'
            : 'border-primary-100 hover:bg-primary-50')
        }
      >
        <button onClick={onClick} className="block w-full text-left">
          <div className="flex items-center justify-between">
            <span
              className={
                'rounded px-1.5 py-0.5 text-[10px] ' +
                (node.node_type === 'synthesis'
                  ? 'bg-accent-500/10 text-accent-500'
                  : 'bg-primary-500/10 text-primary-700')
              }
            >
              {node.node_type}
            </span>
            <span className="font-mono text-[10px] text-primary-500/60">{node.uuid.slice(0, 8)}</span>
          </div>
          <p
            className={
              'mt-1 line-clamp-2 ' +
              (node.l0_summary ? 'text-primary-700' : 'italic text-primary-500/60')
            }
          >
            {node.l0_summary || '(摘要生成中...)'}
          </p>
        </button>
        <div className="mt-1 flex items-center gap-1.5 text-[10px]">
          <span className={'rounded px-1.5 py-0.5 ' + stage.cls}>{stage.label}</span>
          {node.cluster_id !== null && (
            <span className="text-primary-500/70">· cluster #{node.cluster_id}</span>
          )}
          {isGroupHead && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpand?.();
              }}
              className="ml-auto flex items-center gap-0.5 rounded px-1 text-[10px] text-primary-500 hover:bg-primary-100"
              title={expanded ? '收起子节点' : `展开 ${groupSize} 个子节点`}
            >
              <span className="leading-none">{expanded ? '▾' : '▸'}</span>
              <span>{groupSize}</span>
            </button>
          )}
        </div>
        <div className="mt-1.5 flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {node.status === 'active' && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onArchive();
              }}
              className="rounded px-2 py-0.5 text-[10px] text-primary-500 hover:bg-primary-100"
              title="归档(可恢复)"
            >
              归档
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="rounded px-2 py-0.5 text-[10px] text-red-600 hover:bg-red-50"
            title="硬删除(不可恢复)"
          >
            删除
          </button>
        </div>
      </div>
    </li>
  );
}

function pipelineStage(node: NodeBrief): { label: string; cls: string } {
  if (node.status !== 'active') {
    return { label: node.status, cls: 'bg-primary-500/10 text-primary-500/70' };
  }
  if (node.node_type === 'synthesis') {
    return { label: '✓ synthesis', cls: 'bg-accent-500/10 text-accent-500' };
  }
  if (!node.l0_summary) return { label: '⋯ 摘要中', cls: 'bg-amber-100 text-amber-700' };
  if (!node.embedded) return { label: '⋯ 嵌入中', cls: 'bg-amber-100 text-amber-700' };
  if (node.cluster_id === null) return { label: '· 待聚类', cls: 'bg-primary-100 text-primary-700' };
  return { label: '✓ 已聚类', cls: 'bg-green-100 text-green-700' };
}

function NodeDetail({ node }: { node: Node }) {
  return (
    <article className="space-y-3">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <span
            className={
              'rounded px-2 py-0.5 text-[10px] ' +
              (node.node_type === 'synthesis'
                ? 'bg-accent-500/10 text-accent-500'
                : 'bg-primary-500/10 text-primary-700')
            }
          >
            {node.node_type}
          </span>
          <span className="font-mono text-xs text-primary-500/70">{node.uuid}</span>
        </div>
        <h2 className="text-base font-semibold">{node.l0_summary || '(无摘要)'}</h2>
        <p className="text-xs text-primary-500/70">
          创建于 {new Date(node.created_at).toLocaleString()} · 由 {node.created_by} ·{' '}
          {node.lifecycle.status}
          {node.current_path && ` · ${node.current_path}`}
        </p>
      </header>
      {node.l1_overview && (
        <section className="rounded border border-primary-100 bg-primary-50/40 p-2 text-xs">
          <h3 className="mb-1 font-semibold uppercase tracking-wide text-primary-500">概览</h3>
          <p className="text-primary-700">{node.l1_overview}</p>
        </section>
      )}
      {node.sources && node.sources.length > 0 && (
        <section className="text-xs">
          <h3 className="mb-1 font-semibold uppercase tracking-wide text-primary-500">来源</h3>
          <ul className="space-y-0.5">
            {node.sources.map((s) => (
              <li key={s.uuid} className="font-mono">
                [{s.role}] {s.uuid.slice(0, 8)}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-primary-500">正文</h3>
        <div className="prose prose-sm max-w-none text-primary-700">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{node.body}</ReactMarkdown>
        </div>
      </section>
      {node.quality && (
        <section className="rounded border border-primary-100 p-2 text-xs">
          <h3 className="mb-1 font-semibold uppercase tracking-wide text-primary-500">质量指标</h3>
          <p>compactness: {node.quality.compactness_ratio?.toFixed(3) ?? '—'}</p>
          <p>novelty: {node.quality.novelty_to_sources?.toFixed(3) ?? '—'}</p>
          <p>self_rating: {node.quality.self_rating ?? '—'}</p>
        </section>
      )}
    </article>
  );
}
