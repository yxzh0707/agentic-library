import type { DB } from '../storage/db.js';

/**
 * Build an InsightInput by reading the current view-layer state. Caller
 * provides the DB; cohesion needs ClusteringService.computeCohesion to be
 * passed in (we don't import it here to keep this module pure).
 */
export function loadInsightInput(
  db: DB,
  cohesionByCluster?: Map<number, number>,
): InsightInput {
  const nodeRows = db
    .prepare(
      `SELECT uuid, node_type, cluster_id, l0_summary, status FROM nodes WHERE status='active'`,
    )
    .all() as InsightNode[];
  const wikilinkRows = db
    .prepare(
      `SELECT w.source_uuid AS source, w.target_uuid AS target,
              w.relation_type, w.confidence
       FROM wikilinks w
       JOIN nodes ns ON ns.uuid=w.source_uuid AND ns.status='active'
       JOIN nodes nt ON nt.uuid=w.target_uuid AND nt.status='active'`,
    )
    .all() as Array<{ source: string; target: string; relation_type: string; confidence: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS' }>;
  const sourceRows = db
    .prepare(
      `SELECT s.synthesis_uuid AS source, s.source_uuid AS target
       FROM synthesis_sources s
       JOIN nodes ns ON ns.uuid=s.synthesis_uuid AND ns.status='active'
       JOIN nodes nt ON nt.uuid=s.source_uuid AND nt.status='active'`,
    )
    .all() as Array<{ source: string; target: string }>;
  const simRows = db
    .prepare(
      `SELECT se.source_uuid AS source, se.target_uuid AS target
       FROM similarity_edges se
       JOIN nodes ns ON ns.uuid=se.source_uuid AND ns.status='active'
       JOIN nodes nt ON nt.uuid=se.target_uuid AND nt.status='active'`,
    )
    .all() as Array<{ source: string; target: string }>;
  const edges: InsightEdge[] = [
    ...wikilinkRows.map<InsightEdge>((r) => ({
      source: r.source,
      target: r.target,
      kind: 'wikilink',
      relation_type: r.relation_type,
      confidence: r.confidence,
    })),
    ...sourceRows.map<InsightEdge>((r) => ({
      source: r.source,
      target: r.target,
      kind: 'source',
      relation_type: 'sources',
      confidence: 'EXTRACTED',
    })),
    ...simRows.map<InsightEdge>((r) => ({
      source: r.source,
      target: r.target,
      kind: 'similar',
      relation_type: 'semantically_similar',
      confidence: 'INFERRED',
    })),
  ];
  return { nodes: nodeRows, edges, cohesionByCluster };
}

/**
 * Graph insight algorithms — pure functions over a node/edge representation.
 *
 * Ports the spirit of graphify's analyze.py:
 *   - god_nodes: top-degree real entities (system core abstractions)
 *   - surprising_connections: cross-cluster / low-confidence / peripheral→hub edges
 *   - knowledge_gaps: orphan nodes, low-cohesion clusters, bridge nodes
 *
 * Adapted to kb's framing:
 *   - Nodes are documents (raw) + commentary (synthesis), not entity-level
 *   - "Cluster" is HDBSCAN/LLM density grouping, not Leiden community
 *   - Confidence comes from the wikilinks.confidence column added in P1
 *
 * All functions are deterministic and side-effect free. Database access is
 * abstracted via the InsightInput shape — caller assembles the data once.
 */

export interface InsightNode {
  uuid: string;
  node_type: 'raw' | 'synthesis' | 'reflection';
  cluster_id: number | null;
  l0_summary: string;
  status: 'active' | 'archived' | 'superseded';
}

export interface InsightEdge {
  source: string;
  target: string;
  kind: 'wikilink' | 'source' | 'similar';
  relation_type: string;
  confidence: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';
}

export interface InsightInput {
  nodes: InsightNode[];
  edges: InsightEdge[];
  /** Optional cohesion per cluster_id, computed by caller (it has DB access). */
  cohesionByCluster?: Map<number, number>;
}

// =====================================================================
// god_nodes
// =====================================================================

export interface GodNode {
  uuid: string;
  label: string;
  degree: number;
  cluster_id: number | null;
}

/**
 * Top-degree active raw nodes. Synthesis nodes are excluded — they connect
 * to many sources by construction, so they'd dominate the list with no
 * informational value about which raw is structurally central.
 *
 * "god" here means: this document is what other documents in the KB are
 * about / build on / cite. It's the de-facto central abstraction.
 */
export function godNodes(input: InsightInput, topN = 10): GodNode[] {
  const degree = new Map<string, number>();
  for (const e of input.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const candidates: GodNode[] = [];
  for (const n of input.nodes) {
    if (n.status !== 'active') continue;
    if (n.node_type !== 'raw') continue;
    const d = degree.get(n.uuid) ?? 0;
    if (d === 0) continue;
    candidates.push({
      uuid: n.uuid,
      label: n.l0_summary || n.uuid.slice(0, 8),
      degree: d,
      cluster_id: n.cluster_id,
    });
  }
  candidates.sort((a, b) => b.degree - a.degree);
  return candidates.slice(0, topN);
}

// =====================================================================
// surprising_connections
// =====================================================================

export interface Surprise {
  source: string;
  target: string;
  source_label: string;
  target_label: string;
  relation_type: string;
  confidence: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';
  score: number;
  reasons: string[];
  cluster_pair: [number | null, number | null];
}

/**
 * Composite-score ranked cross-cluster edges. Adapted from graphify's
 * `_surprise_score`:
 *
 *   confidence_bonus = AMBIGUOUS:3, INFERRED:2, EXTRACTED:1
 *   + 1 if cross-cluster (cid_u != cid_v)
 *   + 1 if cross-type (raw <-> synthesis)
 *   + 1 if peripheral→hub (one degree ≤ 2, other degree ≥ 5)
 *   * 1.5 if relation_type == 'semantically_similar' (no structural link, only semantic)
 *
 * After ranking, dedupe by cluster pair so a single hub doesn't flood the
 * top-N (we want one representative edge per (A, B) cluster boundary).
 */
export function surprisingConnections(input: InsightInput, topN = 5): Surprise[] {
  const nodeIdx = new Map<string, InsightNode>();
  for (const n of input.nodes) nodeIdx.set(n.uuid, n);
  const degree = new Map<string, number>();
  for (const e of input.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  const all: Surprise[] = [];
  for (const e of input.edges) {
    const u = nodeIdx.get(e.source);
    const v = nodeIdx.get(e.target);
    if (!u || !v) continue;
    if (u.status !== 'active' || v.status !== 'active') continue;
    // Skip purely structural edges (mention is the default raw [[uuid]] —
    // intra-document, not surprising; sources is by-construction so synthesis
    // points to its raws, not a "discovery").
    if (e.relation_type === 'mention' || e.relation_type === 'sources') continue;

    const score = computeSurpriseScore(e, u, v, degree);
    if (score.score === 0) continue;
    all.push({
      source: e.source,
      target: e.target,
      source_label: u.l0_summary || u.uuid.slice(0, 8),
      target_label: v.l0_summary || v.uuid.slice(0, 8),
      relation_type: e.relation_type,
      confidence: e.confidence,
      score: score.score,
      reasons: score.reasons,
      cluster_pair: [u.cluster_id, v.cluster_id],
    });
  }

  all.sort((a, b) => b.score - a.score);

  // Dedupe by sorted cluster pair — one representative per boundary.
  const seenPairs = new Set<string>();
  const deduped: Surprise[] = [];
  for (const s of all) {
    const a = s.cluster_pair[0];
    const b = s.cluster_pair[1];
    const key = a !== null && b !== null
      ? (a < b ? `${a}|${b}` : `${b}|${a}`)
      : `none|${s.source}|${s.target}`; // when one side is unclustered, pair is unique per node
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    deduped.push(s);
    if (deduped.length >= topN) break;
  }
  return deduped;
}

function computeSurpriseScore(
  e: InsightEdge,
  u: InsightNode,
  v: InsightNode,
  degree: Map<string, number>,
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  // Confidence weight — uncertain connections are more noteworthy.
  const confBonus = e.confidence === 'AMBIGUOUS' ? 3 : e.confidence === 'INFERRED' ? 2 : 1;
  score += confBonus;
  if (e.confidence === 'AMBIGUOUS' || e.confidence === 'INFERRED') {
    reasons.push(`${e.confidence.toLowerCase()}: not explicitly stated`);
  }

  // Cross-cluster bonus.
  if (u.cluster_id !== null && v.cluster_id !== null && u.cluster_id !== v.cluster_id) {
    score += 1;
    reasons.push(`cross-cluster: ${u.cluster_id} ↔ ${v.cluster_id}`);
  }

  // Cross-type bonus — raw ↔ synthesis connections often surface meta-observations.
  if (u.node_type !== v.node_type) {
    score += 1;
    reasons.push(`cross-type: ${u.node_type} ↔ ${v.node_type}`);
  }

  // Peripheral → hub bonus.
  const du = degree.get(u.uuid) ?? 0;
  const dv = degree.get(v.uuid) ?? 0;
  if (Math.min(du, dv) <= 2 && Math.max(du, dv) >= 5) {
    score += 1;
    reasons.push('peripheral node reaches hub');
  }

  // Pure semantic similarity edges (no structural link) — boost.
  if (e.relation_type === 'semantically_similar') {
    score = Math.round(score * 1.5);
    reasons.push('semantic similarity without structural link');
  }

  return { score, reasons };
}

// =====================================================================
// knowledge_gaps
// =====================================================================

export interface KnowledgeGap {
  type: 'orphan' | 'low_cohesion_cluster' | 'bridge_node';
  message: string;
  refs: { uuid?: string; cluster_id?: number; label?: string };
  evidence: Record<string, unknown>;
}

/**
 * Three classes of gap, each implying a different research action:
 *
 *   orphan: degree ≤ 1 active node — under-connected, may need cross-references
 *   low_cohesion_cluster: cohesion < 0.15 + member_count ≥ 5 — sparse domain
 *   bridge_node: connects ≥ 3 distinct clusters — potential cross-cutting concern
 */
export function knowledgeGaps(
  input: InsightInput,
  opts: { cohesionThreshold?: number; minMembers?: number; minBridgeClusters?: number } = {},
): KnowledgeGap[] {
  const cohesionThreshold = opts.cohesionThreshold ?? 0.15;
  const minMembers = opts.minMembers ?? 5;
  const minBridgeClusters = opts.minBridgeClusters ?? 3;

  const gaps: KnowledgeGap[] = [];
  const nodeIdx = new Map<string, InsightNode>();
  for (const n of input.nodes) nodeIdx.set(n.uuid, n);

  // Compute neighborhood + cluster reach per node.
  const neighbors = new Map<string, Set<string>>();
  for (const e of input.edges) {
    if (!neighbors.has(e.source)) neighbors.set(e.source, new Set());
    if (!neighbors.has(e.target)) neighbors.set(e.target, new Set());
    neighbors.get(e.source)!.add(e.target);
    neighbors.get(e.target)!.add(e.source);
  }

  // 1. Orphans
  for (const n of input.nodes) {
    if (n.status !== 'active') continue;
    if (n.node_type !== 'raw') continue;
    const d = neighbors.get(n.uuid)?.size ?? 0;
    if (d <= 1) {
      gaps.push({
        type: 'orphan',
        message: `节点 "${(n.l0_summary || n.uuid.slice(0, 8))}" 几乎没有与其他节点的关联`,
        refs: { uuid: n.uuid, label: n.l0_summary, cluster_id: n.cluster_id ?? undefined },
        evidence: { degree: d },
      });
    }
  }

  // 2. Low cohesion clusters
  if (input.cohesionByCluster) {
    const memberCount = new Map<number, number>();
    for (const n of input.nodes) {
      if (n.status === 'active' && n.cluster_id !== null) {
        memberCount.set(n.cluster_id, (memberCount.get(n.cluster_id) ?? 0) + 1);
      }
    }
    for (const [cid, cohesion] of input.cohesionByCluster) {
      const mc = memberCount.get(cid) ?? 0;
      if (mc >= minMembers && cohesion < cohesionThreshold) {
        gaps.push({
          type: 'low_cohesion_cluster',
          message: `簇 #${cid}（${mc} 成员）内部连接稀疏（cohesion=${cohesion.toFixed(2)}）`,
          refs: { cluster_id: cid },
          evidence: { cohesion, member_count: mc, threshold: cohesionThreshold },
        });
      }
    }
  }

  // 3. Bridge nodes (reach ≥ N clusters via 1-hop neighbors)
  for (const n of input.nodes) {
    if (n.status !== 'active') continue;
    if (n.node_type !== 'raw') continue;
    const nbrs = neighbors.get(n.uuid);
    if (!nbrs || nbrs.size < minBridgeClusters) continue;
    const reachedClusters = new Set<number>();
    for (const nb of nbrs) {
      const nbNode = nodeIdx.get(nb);
      if (nbNode && nbNode.cluster_id !== null && nbNode.cluster_id !== n.cluster_id) {
        reachedClusters.add(nbNode.cluster_id);
      }
    }
    if (reachedClusters.size >= minBridgeClusters) {
      gaps.push({
        type: 'bridge_node',
        message: `节点 "${(n.l0_summary || n.uuid.slice(0, 8))}" 桥接 ${reachedClusters.size} 个簇`,
        refs: { uuid: n.uuid, label: n.l0_summary, cluster_id: n.cluster_id ?? undefined },
        evidence: { bridged_clusters: [...reachedClusters], own_cluster: n.cluster_id },
      });
    }
  }

  return gaps;
}
