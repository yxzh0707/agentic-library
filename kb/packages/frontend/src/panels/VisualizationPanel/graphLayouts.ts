import type { GraphData } from 'react-force-graph-2d';

export interface GraphResponse {
  nodes: Array<{
    uuid: string;
    node_type: string;
    l0_summary: string;
    cluster_id: number | null;
    status: string;
    reference_count: number;
    hub_role_value?: 'root' | 'center' | 'leaf' | 'neutral' | null;
    is_cluster_hub?: boolean;
    synthesis_subtype?: string | null;
    sub_anchor_uuid?: string | null;
    anchor_sim?: number | null;
    effective_anchor?: 'sub_hub' | 'cluster_hub' | 'root_hub' | null;
  }>;
  cluster_tree?: Array<{
    cluster_id: number;
    parent_cluster_id: number | null;
    member_count: number;
    description: string | null;
    hub_uuid: string | null;
  }>;
  links: Array<{
    source: string;
    target: string;
    kind: 'wikilink' | 'source' | 'similar';
    role?: string;
    confidence?: 'EXTRACTED' | 'INFERRED';
    sim_score?: number | null;
  }>;
}

export type Tier =
  | 'root_hub'
  | 'cluster_hub'
  | 'synthesis_hub'
  | 'sub_hub'
  | 'virtual_sub_hub'
  | 'sub_member'
  | 'direct_member'
  | 'edge_member'
  | 'unclustered';

export interface RNode {
  id: string;
  label: string;
  cluster_id: number | null;
  size: number;
  tier: Tier;
  hubRole: 'root' | 'center' | 'leaf' | 'neutral';
  isVirtual?: boolean;
  isFresh?: boolean;
  x?: number;
  y?: number;
  fx?: number;
  fy?: number;
  vx?: number;
  vy?: number;
}

export interface RLink {
  source: string;
  target: string;
  kind: 'wikilink' | 'sub_to_main' | 'sub_member' | 'direct_member' | 'cluster_to_root' | 'edge_to_root';
  sim_score?: number | null;
}

export interface RenderData extends GraphData {
  nodes: RNode[];
  links: RLink[];
  collapsedMemberCount: Map<number, number>;
}

export type LayoutPresetKey = 'standard' | 'layered' | 'organic' | 'radial';

export const LAYOUT_PRESETS: Array<{ key: LayoutPresetKey; title: string; subtitle: string }> = [
  {
    key: 'layered',
    title: '混合层级',
    subtitle: '先按 cluster / sub-hub / member 分层摆放，再留少量松动空间。',
  },
  {
    key: 'organic',
    title: '有机散点',
    subtitle: '更像 Obsidian 的自然团簇，强调疏散感和阅读性。',
  },
  {
    key: 'radial',
    title: '严格放射',
    subtitle: '最规则的中心-子簇-成员拓扑，适合直接比较层级。',
  },
];

export const COLOR_ROOT_HUB = '#1E1B4B';
export const COLOR_CLUSTER_HUB = '#DC2626';
export const COLOR_SUB_HUB = '#EAB308';
export const COLOR_SUB_MEMBER = '#16A34A';
export const COLOR_DIRECT_MEMBER = '#9333EA';
export const COLOR_EDGE_MEMBER = '#A78BFA';
export const COLOR_UNCLUSTERED = '#94A3B8';

export function colorForNode(n: RNode): string {
  switch (n.tier) {
    case 'root_hub':
      return COLOR_ROOT_HUB;
    case 'cluster_hub':
      return COLOR_CLUSTER_HUB;
    case 'synthesis_hub':
      return COLOR_CLUSTER_HUB;
    case 'sub_hub':
      return COLOR_SUB_HUB;
    case 'virtual_sub_hub':
      return COLOR_SUB_HUB;
    case 'sub_member':
      return COLOR_SUB_MEMBER;
    case 'direct_member':
      return COLOR_DIRECT_MEMBER;
    case 'edge_member':
      return COLOR_EDGE_MEMBER;
    case 'unclustered':
      return COLOR_UNCLUSTERED;
  }
}

export function buildRenderData(
  graph: GraphResponse | null,
  freshNodeIds: Set<string>,
  collapsedClusters: Set<number>,
): RenderData {
  if (!graph) return { nodes: [], links: [], collapsedMemberCount: new Map<number, number>() };

  const visibleNodes = graph.nodes.filter((n) => {
    if (n.node_type !== 'raw' && !(n.node_type === 'synthesis' && n.is_cluster_hub)) return false;
    if (
      n.cluster_id !== null &&
      collapsedClusters.has(n.cluster_id) &&
      n.node_type === 'raw' &&
      !n.is_cluster_hub
    ) {
      return false;
    }
    return true;
  });
  const rawById = new Map(visibleNodes.map((n) => [n.uuid, n]));

  const nodes = visibleNodes.map<RNode>((n) => {
    const role = (n.hub_role_value ?? 'neutral') as 'root' | 'center' | 'leaf' | 'neutral';
    let tier: Tier;
    let size = 5;
    if (n.cluster_id === null && !n.is_cluster_hub) {
      tier = 'unclustered';
      size = 4;
    } else if (n.is_cluster_hub) {
      tier = n.node_type === 'synthesis' ? 'synthesis_hub' : 'cluster_hub';
      size = 12;
    } else if (role === 'center') {
      tier = 'sub_hub';
      size = 8;
    } else if (n.effective_anchor === 'root_hub') {
      tier = 'edge_member';
      size = 4;
    } else if (n.effective_anchor === 'sub_hub') {
      tier = 'sub_member';
      size = 5;
    } else if (n.effective_anchor === 'cluster_hub') {
      tier = 'direct_member';
      size = 5;
    } else {
      const anchor = n.sub_anchor_uuid ? rawById.get(n.sub_anchor_uuid) : null;
      const anchorIsSubHub = anchor && !anchor.is_cluster_hub && anchor.hub_role_value === 'center';
      tier = anchorIsSubHub ? 'sub_member' : 'direct_member';
      size = 5;
    }
    return {
      id: n.uuid,
      label: n.l0_summary || n.uuid.slice(0, 8),
      cluster_id: n.cluster_id,
      size,
      tier,
      hubRole: role,
      isFresh: freshNodeIds.has(n.uuid),
    };
  });

  const links: RLink[] = [];
  const hubByCluster = new Map<number, string>();
  for (const n of visibleNodes) {
    if (n.is_cluster_hub && n.cluster_id !== null) {
      hubByCluster.set(n.cluster_id, n.uuid);
    }
  }
  for (const n of visibleNodes) {
    if (n.is_cluster_hub) continue;
    if (n.cluster_id === null) continue;
    if (n.effective_anchor === 'root_hub') continue;

    let target: string | undefined;
    let kind: RLink['kind'] = 'direct_member';
    if (n.sub_anchor_uuid && rawById.has(n.sub_anchor_uuid)) {
      target = n.sub_anchor_uuid;
      const anchor = rawById.get(n.sub_anchor_uuid)!;
      if (n.hub_role_value === 'center') kind = 'sub_to_main';
      else if (anchor.hub_role_value === 'center' && !anchor.is_cluster_hub) kind = 'sub_member';
      else kind = 'direct_member';
    } else {
      target = hubByCluster.get(n.cluster_id);
      kind = 'direct_member';
    }
    if (target) links.push({ source: n.uuid, target, kind, sim_score: n.anchor_sim ?? null });
  }

  const edgeMembers = visibleNodes.filter((n) => n.effective_anchor === 'root_hub');
  if (edgeMembers.length > 0) {
    const edgeRootId = '__edge_root__';
    nodes.push({
      id: edgeRootId,
      label: `边缘节点 (${edgeMembers.length})`,
      cluster_id: null,
      size: 12,
      tier: 'root_hub',
      hubRole: 'center',
      isVirtual: true,
    });
    for (const en of edgeMembers) {
      links.push({
        source: en.uuid,
        target: edgeRootId,
        kind: 'edge_to_root',
        sim_score: en.anchor_sim ?? null,
      });
    }
  }

  const rawIds = new Set(visibleNodes.filter((n) => n.node_type === 'raw').map((n) => n.uuid));
  const wikiSimByPair = new Map<string, number | null>();
  for (const l of graph.links) {
    if (l.kind === 'wikilink') wikiSimByPair.set(`${l.source}->${l.target}`, l.sim_score ?? null);
  }
  for (const l of graph.links) {
    if (l.kind === 'wikilink' && rawIds.has(l.source) && rawIds.has(l.target)) {
      links.push({
        source: l.source,
        target: l.target,
        kind: 'wikilink',
        sim_score: wikiSimByPair.get(`${l.source}->${l.target}`) ?? null,
      });
    }
  }

  const directByCluster = new Map<number, RNode[]>();
  for (const n of nodes) {
    if (n.tier === 'direct_member' && n.cluster_id !== null) {
      const list = directByCluster.get(n.cluster_id) ?? [];
      list.push(n);
      directByCluster.set(n.cluster_id, list);
    }
  }
  const virtThreshold = 3;
  for (const [cid, members] of directByCluster) {
    if (members.length < virtThreshold) continue;
    const hub = nodes.find((n) => n.tier === 'cluster_hub' && n.cluster_id === cid);
    if (!hub) continue;
    const vId = `__virtual_subhub_${cid}__`;
    nodes.push({
      id: vId,
      label: `其他成员 (${members.length})`,
      cluster_id: cid,
      size: 7,
      tier: 'virtual_sub_hub',
      hubRole: 'center',
      isVirtual: true,
    });
    for (const m of members) m.tier = 'sub_member';
    const memberIds = new Set(members.map((m) => m.id));
    const keptLinks = links.filter(
      (l) => !(memberIds.has(l.source) && l.target === hub.id && l.kind === 'direct_member'),
    );
    links.length = 0;
    links.push(...keptLinks);
    for (const m of members) {
      links.push({ source: m.id, target: vId, kind: 'sub_member' });
    }
    links.push({ source: vId, target: hub.id, kind: 'sub_to_main' });
  }

  const tree = graph.cluster_tree ?? [];
  if (tree.length > 0) {
    const childrenByParent = new Map<number, number[]>();
    const clusterMeta = new Map<number, { description: string | null }>();
    for (const c of tree) {
      clusterMeta.set(c.cluster_id, { description: c.description });
      if (c.parent_cluster_id !== null) {
        const list = childrenByParent.get(c.parent_cluster_id) ?? [];
        list.push(c.cluster_id);
        childrenByParent.set(c.parent_cluster_id, list);
      }
    }

    const hubNodeByCluster = new Map<number, string>();
    for (const n of nodes) {
      if ((n.tier === 'cluster_hub' || n.tier === 'synthesis_hub') && n.cluster_id !== null) {
        hubNodeByCluster.set(n.cluster_id, n.id);
      }
    }

    for (const [parentCid, childCids] of childrenByParent) {
      if (childCids.length < 2) continue;
      const meta = clusterMeta.get(parentCid);
      if (!meta) continue;
      const parentId = `__parent_cluster_${parentCid}__`;
      nodes.push({
        id: parentId,
        label: meta.description || `父组 #${parentCid}`,
        cluster_id: parentCid,
        size: 16,
        tier: 'root_hub',
        hubRole: 'center',
        isVirtual: true,
      });
      for (const childCid of childCids) {
        const childHubId = hubNodeByCluster.get(childCid);
        if (childHubId) {
          links.push({ source: childHubId, target: parentId, kind: 'cluster_to_root' });
        }
      }
    }
  } else {
    const clusterHubs = nodes.filter((n) => n.tier === 'cluster_hub' || n.tier === 'synthesis_hub');
    if (clusterHubs.length >= 2) {
      const rootId = '__virtual_root_hub__';
      nodes.push({
        id: rootId,
        label: `知识库 (${clusterHubs.length} 簇)`,
        cluster_id: null,
        size: 16,
        tier: 'root_hub',
        hubRole: 'center',
        isVirtual: true,
      });
      for (const ch of clusterHubs) {
        links.push({ source: ch.id, target: rootId, kind: 'cluster_to_root' });
      }
    }
  }

  const collapsedMemberCount = new Map<number, number>();
  for (const n of graph.nodes) {
    if (
      n.cluster_id !== null &&
      collapsedClusters.has(n.cluster_id) &&
      n.node_type === 'raw' &&
      !n.is_cluster_hub
    ) {
      const count = collapsedMemberCount.get(n.cluster_id) ?? 0;
      collapsedMemberCount.set(n.cluster_id, count + 1);
    }
  }

  return { nodes, links, collapsedMemberCount };
}

export function cloneForLayout(data: RenderData): RenderData {
  return {
    nodes: data.nodes.map((n) => ({ ...n, vx: 0, vy: 0, fx: undefined, fy: undefined })),
    links: data.links.map((l) => ({ ...l })),
    collapsedMemberCount: data.collapsedMemberCount,
  };
}

export function applyLayoutPreset(data: RenderData, preset: LayoutPresetKey): RenderData {
  const next = cloneForLayout(data);
  if (preset === 'standard') return next;

  const nodesById = new Map(next.nodes.map((n) => [n.id, n]));
  const parentByChild = new Map<string, string>();
  const childrenByParent = new Map<string, string[]>();
  for (const link of next.links) {
    if (link.kind === 'wikilink') continue;
    parentByChild.set(link.source, link.target);
    const list = childrenByParent.get(link.target) ?? [];
    list.push(link.source);
    childrenByParent.set(link.target, list);
  }

  const clusterHubs = next.nodes.filter((n) => (n.tier === 'cluster_hub' || n.tier === 'synthesis_hub') && n.cluster_id !== null);
  const centers = computeClusterCenters(clusterHubs);

  for (const hub of clusterHubs) {
    const center = centers.get(hub.cluster_id!) ?? { x: 0, y: 0 };
    if (preset === 'organic') seedNode(hub, center.x, center.y);
    else pinNode(hub, center.x, center.y);

    const anchors = next.nodes.filter(
      (n) => n.cluster_id === hub.cluster_id && (n.tier === 'sub_hub' || n.tier === 'virtual_sub_hub'),
    );
    const directMembers = next.nodes.filter(
      (n) => n.cluster_id === hub.cluster_id && n.tier === 'direct_member',
    );
    const edgeMembers = next.nodes.filter(
      (n) => n.cluster_id === hub.cluster_id && n.tier === 'edge_member',
    );

    const anchorRadius = preset === 'radial' ? 170 : 155;
    const anchorPoints = evenlySpread(anchors.length, anchorRadius, -Math.PI / 2);
    anchors.forEach((anchor, index) => {
      const point = anchorPoints[index] ?? { x: 0, y: 0, angle: -Math.PI / 2 };
      const ax = center.x + point.x;
      const ay = center.y + point.y;
      if (preset === 'organic') seedNode(anchor, ax, ay);
      else pinNode(anchor, ax, ay);

      const members = (childrenByParent.get(anchor.id) ?? [])
        .map((id) => nodesById.get(id))
        .filter((n): n is RNode => n !== undefined && n.tier === 'sub_member');
      const memberRing = preset === 'radial' ? 92 : 74;
      const spread = preset === 'radial' ? Math.PI / 2.4 : Math.PI / 1.8;
      const start = point.angle - spread / 2;
      const memberPoints = arcSpread(members.length, memberRing, start, spread);
      members.forEach((member, memberIndex) => {
        const offset = memberPoints[memberIndex] ?? { x: 0, y: 0 };
        const mx = ax + offset.x;
        const my = ay + offset.y;
        if (preset === 'organic') seedNode(member, mx, my, 18);
        else pinNode(member, mx, my);
      });
    });

    const directRadius = preset === 'radial' ? 280 : 250;
    const directPoints = evenlySpread(directMembers.length, directRadius, 0);
    directMembers.forEach((member, index) => {
      const point = directPoints[index] ?? { x: 0, y: 0 };
      const mx = center.x + point.x;
      const my = center.y + point.y;
      if (preset === 'organic') seedNode(member, mx, my, 34);
      else pinNode(member, mx, my);
    });

    const edgeRadius = preset === 'radial' ? 360 : 320;
    const edgePoints = evenlySpread(edgeMembers.length, edgeRadius, Math.PI / 3);
    edgeMembers.forEach((member, index) => {
      const point = edgePoints[index] ?? { x: 0, y: 0 };
      const mx = center.x + point.x;
      const my = center.y + point.y;
      if (preset === 'organic') seedNode(member, mx, my, 44);
      else pinNode(member, mx, my);
    });
  }

  const unclustered = next.nodes.filter((n) => n.tier === 'unclustered');
  const mainClusterMaxRadius = 340;
  const unclusteredPoints = arcSpread(unclustered.length, mainClusterMaxRadius + 55, Math.PI * 0.75, Math.PI / 1.8);
  unclustered.forEach((node, index) => {
    const point = unclusteredPoints[index] ?? { x: 0, y: 0 };
    if (preset === 'organic') seedNode(node, point.x, point.y, 52);
    else pinNode(node, point.x, point.y);
  });

  positionRootNodes(next.nodes, next.links, nodesById, preset);
  return next;
}

export function forceSettingsForPreset(preset: LayoutPresetKey) {
  if (preset === 'layered') {
    return {
      cooldownTicks: 80,
      alphaDecay: 0.08,
      chargeStrength: -12,
      linkStrength: 0.25,
      zoomPadding: 80,
      collisionRadiusScale: 1.7,
      linkDistance: (l: RLink) => structuralDistance(l, {
        cluster_to_root: 220,
        edge_to_root: 230,
        sub_to_main: 90,
        defaultDistance: 110,
      }),
    };
  }
  if (preset === 'organic') {
    return {
      cooldownTicks: 320,
      alphaDecay: 0.028,
      chargeStrength: -150,
      linkStrength: 0.55,
      zoomPadding: 90,
      collisionRadiusScale: 1.45,
      linkDistance: (l: RLink) => structuralDistance(l, {
        cluster_to_root: 260,
        edge_to_root: 280,
        sub_to_main: 130,
        defaultDistance: 150,
      }),
    };
  }
  if (preset === 'radial') {
    return {
      cooldownTicks: 30,
      alphaDecay: 0.12,
      chargeStrength: -4,
      linkStrength: 0.1,
      zoomPadding: 80,
      collisionRadiusScale: 1.6,
      linkDistance: (l: RLink) => structuralDistance(l, {
        cluster_to_root: 240,
        edge_to_root: 250,
        sub_to_main: 100,
        defaultDistance: 120,
      }),
    };
  }
  return {
    cooldownTicks: 600,
    alphaDecay: 0.02,
    chargeStrength: -50,
    linkStrength: 1,
    zoomPadding: 60,
    collisionRadiusScale: 1.15,
    linkDistance: (l: RLink) => structuralDistance(l, {
      cluster_to_root: 220,
      edge_to_root: 260,
      sub_to_main: 90,
      defaultDistance: 120,
    }),
  };
}

function structuralDistance(
  link: RLink,
  opts: { cluster_to_root: number; edge_to_root: number; sub_to_main: number; defaultDistance: number },
): number {
  if (link.kind === 'cluster_to_root') return opts.cluster_to_root;
  if (link.kind === 'edge_to_root') return opts.edge_to_root;
  if (link.kind === 'sub_to_main') return opts.sub_to_main;
  const sim = link.sim_score;
  if (sim === null || sim === undefined) return opts.defaultDistance;
  return Math.max(36, opts.defaultDistance - sim * 70 + (1 - sim) * 70);
}

function computeClusterCenters(clusterHubs: RNode[]): Map<number, { x: number; y: number }> {
  const ids = clusterHubs
    .map((n) => n.cluster_id)
    .filter((id): id is number => id !== null)
    .sort((a, b) => a - b);
  const unique = Array.from(new Set(ids));
  const out = new Map<number, { x: number; y: number }>();
  if (unique.length === 0) return out;
  if (unique.length === 1) {
    out.set(unique[0]!, { x: 0, y: 10 });
    return out;
  }
  const radius = Math.max(260, unique.length * 120);
  unique.forEach((id, index) => {
    const angle = (Math.PI * 2 * index) / unique.length - Math.PI / 2;
    out.set(id, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius + 40,
    });
  });
  return out;
}

function positionRootNodes(
  nodes: RNode[],
  links: RLink[],
  nodesById: Map<string, RNode>,
  preset: LayoutPresetKey,
) {
  const rootNodes = nodes.filter((n) => n.tier === 'root_hub');
  const defaultJitter = preset === 'organic' ? 24 : 0;
  rootNodes.forEach((root, index) => {
    if (root.id === '__edge_root__') {
      const attached = links
        .filter((l) => l.target === root.id)
        .map((l) => nodesById.get(l.source))
        .filter((n): n is RNode => Boolean(n));
      const anchor = centroid(attached);
      if (preset === 'organic') seedNode(root, anchor.x + 120, anchor.y + 120, 28);
      else pinNode(root, anchor.x + 110, anchor.y + 120);
      return;
    }

    const children = links
      .filter((l) => l.target === root.id && l.kind === 'cluster_to_root')
      .map((l) => nodesById.get(l.source))
      .filter((n): n is RNode => Boolean(n));
    const anchor = centroid(children);
    const x = anchor.x + (index - (rootNodes.length - 1) / 2) * 120;
    const y = anchor.y - 230;
    if (preset === 'organic') seedNode(root, x, y, defaultJitter);
    else pinNode(root, x, y);
  });
}

function centroid(nodes: RNode[]): { x: number; y: number } {
  if (nodes.length === 0) return { x: 0, y: -220 };
  const total = nodes.reduce(
    (acc, node) => ({ x: acc.x + (node.x ?? 0), y: acc.y + (node.y ?? 0) }),
    { x: 0, y: 0 },
  );
  return { x: total.x / nodes.length, y: total.y / nodes.length };
}

function evenlySpread(count: number, radius: number, startAngle = -Math.PI / 2) {
  if (count <= 0) return [];
  return Array.from({ length: count }, (_, index) => {
    const angle = startAngle + (Math.PI * 2 * index) / count;
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, angle };
  });
}

function arcSpread(count: number, radius: number, startAngle: number, spread: number) {
  if (count <= 0) return [];
  if (count === 1) {
    const angle = startAngle + spread / 2;
    return [{ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, angle }];
  }
  return Array.from({ length: count }, (_, index) => {
    const angle = startAngle + (spread * index) / (count - 1);
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, angle };
  });
}

function pinNode(node: RNode, x: number, y: number) {
  node.x = x;
  node.y = y;
  node.fx = x;
  node.fy = y;
}

function seedNode(node: RNode, x: number, y: number, jitter = 0) {
  node.x = x + jitterOffset(node.id + ':x', jitter);
  node.y = y + jitterOffset(node.id + ':y', jitter);
}

function jitterOffset(seed: string, amount: number): number {
  if (amount <= 0) return 0;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return ((hash % 2000) / 1000 - 1) * amount;
}
