import type { NodeStorage } from '../storage/storage.js';
import type { EmbeddingService } from '../embedding/embedding.js';
import type { IndexService } from '../indexing/index_service.js';
import type { DB } from '../storage/db.js';
import type { HubRoleValue, KBConfigParameters, NodeBrief, ToolContext } from '@kb/shared';
import { newUuid } from '../util/uuid.js';
import { nowIso } from '../util/now.js';

export interface SearchDeps {
  db: DB;
  storage: NodeStorage;
  embedding: EmbeddingService;
  index: IndexService;
  params: KBConfigParameters;
}

type CandidateVia = 'knn' | 'cluster_expand' | 'graph_synthesis' | 'graph_wikilink';

interface InternalCandidate {
  uuid: string;
  distance: number;
  source: 'raw' | 'synthesis';
  via: CandidateVia;
}

const EXPANSION_PENALTY: Record<CandidateVia, number> = {
  knn: 0,
  cluster_expand: 0.1,
  graph_synthesis: 0.12,
  graph_wikilink: 0.18,
};

/**
 * v1.3 §9.3 / §5.2 — three-stage retrieval.
 *   Stage 1: parallel KNN over l1 — raw all, synthesis filter out cluster_review.
 *   Stage 2: multi-cluster expansion (top-K=3 hit clusters, +N=5 each).
 *   Stage 3: caller does LLM generation (this function returns the candidate set).
 *
 * No l2 rerank in v1.3 (e_l2 is gone). Final order = l1 distance + expansion penalty.
 */
export async function search(
  deps: SearchDeps,
  query: string,
  k_raw = 10,
  k_synthesis = 5,
  ctx?: ToolContext,
): Promise<{ raw: NodeBrief[]; synthesis: NodeBrief[]; final: NodeBrief[]; query_id: string }> {
  const { db, storage, embedding, index, params } = deps;
  const q = await embedding.embedOne(query);

  // ===== Stage 1: parallel coarse retrieval =====
  const rawHits = index.searchKNN('l1', q, k_raw * 2);
  const synHits = index.searchKNN('l1', q, k_synthesis * 4);

  const rawIds = rawHits.map((h) => h.id);
  const synIds = synHits.map((h) => h.id);

  const rawByEl1 = mapByEl1Id(db, rawIds, 'raw', false);
  // synthesis filter: exclude cluster_review (v1.3 §7.6 — special-purpose tool only)
  const synByEl1 = mapByEl1Id(db, synIds, 'synthesis', true);

  const rawCandidates: InternalCandidate[] = [];
  for (const h of rawHits) {
    const u = rawByEl1.get(h.id);
    if (u) rawCandidates.push({ uuid: u, distance: h.distance, source: 'raw', via: 'knn' });
    if (rawCandidates.length >= k_raw) break;
  }
  const synCandidates: InternalCandidate[] = [];
  for (const h of synHits) {
    const u = synByEl1.get(h.id);
    if (u) synCandidates.push({ uuid: u, distance: h.distance, source: 'synthesis', via: 'knn' });
    if (synCandidates.length >= k_synthesis) break;
  }

  // ===== Stage 2: multi-cluster expansion (v1.3 §9.4) =====
  // Count hit cluster frequencies, pick top-K clusters, fetch in-cluster top-N each.
  const seenRaw = new Set(rawCandidates.map((c) => c.uuid));
  const clusterFreq = new Map<number, number>();
  for (const c of rawCandidates) {
    const row = db.prepare('SELECT cluster_id FROM nodes WHERE uuid=?').get(c.uuid) as
      | { cluster_id: number | null }
      | undefined;
    if (row?.cluster_id !== null && row?.cluster_id !== undefined) {
      clusterFreq.set(row.cluster_id, (clusterFreq.get(row.cluster_id) ?? 0) + 1);
    }
  }
  const topKClusters = [...clusterFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, params.search_expansion_top_k_clusters)
    .map(([cid]) => cid);

  for (const cid of topKClusters) {
    const members = db
      .prepare(
        "SELECT uuid, e_l1_id FROM nodes WHERE cluster_id=? AND status='active' AND node_type='raw' AND e_l1_id IS NOT NULL LIMIT 100",
      )
      .all(cid) as { uuid: string; e_l1_id: number }[];
    if (members.length === 0) continue;
    const subset = new Set(members.map((m) => m.e_l1_id));
    const local = index.searchKNN('l1', q, 50);
    let added = 0;
    for (const h of local) {
      if (!subset.has(h.id)) continue;
      const u = members.find((m) => m.e_l1_id === h.id)?.uuid;
      if (!u || seenRaw.has(u)) continue;
      seenRaw.add(u);
      rawCandidates.push({ uuid: u, distance: h.distance, source: 'raw', via: 'cluster_expand' });
      added++;
      if (added >= params.search_expansion_per_cluster) break;
    }
  }

  // ===== Stage 2.5: safe 1-hop graph expansion =====
  const graphSeeds = rawCandidates
    .filter((c) => c.via === 'knn')
    .slice(0, params.search_graph_expand_from_top_k);
  const seenAll = new Set([...rawCandidates, ...synCandidates].map((c) => c.uuid));
  let graphAdded = 0;
  for (const seed of graphSeeds) {
    if (graphAdded >= params.search_graph_expand_max) break;
    const synthesisRows = db
      .prepare(
        `SELECT n.uuid FROM synthesis_sources ss
         JOIN nodes n ON n.uuid = ss.synthesis_uuid
         WHERE ss.source_uuid=? AND n.status='active' AND n.node_type='synthesis'
           AND (n.synthesis_subtype IS NULL OR n.synthesis_subtype != 'cluster_review')
         ORDER BY n.created_at DESC LIMIT 3`,
      )
      .all(seed.uuid) as { uuid: string }[];
    for (const row of synthesisRows) {
      if (graphAdded >= params.search_graph_expand_max) break;
      if (seenAll.has(row.uuid)) continue;
      seenAll.add(row.uuid);
      synCandidates.push({ uuid: row.uuid, distance: seed.distance, source: 'synthesis', via: 'graph_synthesis' });
      graphAdded++;
    }

    const linkedRows = db
      .prepare(
        `SELECT n.uuid FROM wikilinks w
         JOIN nodes n ON n.uuid = w.target_uuid
         WHERE w.source_uuid=? AND n.status='active' AND n.node_type='raw'
         LIMIT 3`,
      )
      .all(seed.uuid) as { uuid: string }[];
    for (const row of linkedRows) {
      if (graphAdded >= params.search_graph_expand_max) break;
      if (seenAll.has(row.uuid)) continue;
      seenAll.add(row.uuid);
      rawCandidates.push({ uuid: row.uuid, distance: seed.distance, source: 'raw', via: 'graph_wikilink' });
      graphAdded++;
    }
  }

  // ===== Stage 3 surrogate: order by l1 distance + expansion penalty =====
  // (No l2 rerank in v1.3. Caller LLM does the actual generation.)
  const all = [...rawCandidates, ...synCandidates];
  const rawCandidateUuids = all.filter((c) => c.source === 'raw').map((c) => c.uuid);
  const hubRoles = mapHubRoles(db, rawCandidateUuids);
  const reranked = all.map((c) => {
    const hubBoost = c.source === 'raw' && hubRoles.get(c.uuid) === 'center' ? params.search_hub_boost : 0;
    return { ...c, distance: c.distance + EXPANSION_PENALTY[c.via] - hubBoost };
  });
  reranked.sort((a, b) => a.distance - b.distance);

  const rawBriefs = toBriefs(
    db,
    reranked.filter((r) => r.source === 'raw').map((r) => r.uuid),
  );
  const synBriefs = toBriefs(
    db,
    reranked.filter((r) => r.source === 'synthesis').map((r) => r.uuid),
  );
  const finalBriefs = toBriefs(
    db,
    reranked.slice(0, Math.min(12, reranked.length)).map((r) => r.uuid),
  );

  // ===== Persist query_log =====
  const query_id = newUuid();
  const directRawHits = rawCandidates.filter((c) => c.via === 'knn').map((c) => c.uuid);
  const directSynHits = synCandidates.filter((c) => c.via === 'knn').map((c) => c.uuid);
  db.prepare(
    `INSERT INTO query_log (query_id, timestamp, queried_by, query_text, raw_hits, synthesis_hits, raw_after_expansion, final_used, flagged_issues, answer_adopted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(
    query_id,
    nowIso(),
    ctx?.agent_id ?? 'unknown',
    query,
    JSON.stringify(directRawHits),
    JSON.stringify(directSynHits),
    JSON.stringify(rawCandidates.map((c) => c.uuid)),
    JSON.stringify(finalBriefs.map((b) => b.uuid)),
  );

  void storage;
  return { raw: rawBriefs, synthesis: synBriefs, final: finalBriefs, query_id };
}

function mapByEl1Id(
  db: DB,
  ids: number[],
  type: 'raw' | 'synthesis',
  excludeClusterReview: boolean,
): Map<number, string> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const filterSubtype = excludeClusterReview
    ? "AND (synthesis_subtype IS NULL OR synthesis_subtype != 'cluster_review')"
    : '';
  const rows = db
    .prepare(
      `SELECT uuid, e_l1_id FROM nodes
       WHERE e_l1_id IN (${placeholders}) AND node_type=? AND status='active' ${filterSubtype}`,
    )
    .all(...ids, type) as { uuid: string; e_l1_id: number }[];
  return new Map(rows.map((r) => [r.e_l1_id, r.uuid]));
}

function mapHubRoles(db: DB, uuids: string[]): Map<string, string> {
  if (uuids.length === 0) return new Map();
  const placeholders = uuids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT uuid, hub_role_value FROM nodes WHERE uuid IN (${placeholders})`)
    .all(...uuids) as { uuid: string; hub_role_value: string | null }[];
  return new Map(rows.map((r) => [r.uuid, r.hub_role_value ?? 'neutral']));
}

function toBriefs(db: DB, uuids: string[]): NodeBrief[] {
  if (uuids.length === 0) return [];
  const placeholders = uuids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT uuid, node_type, l0_summary, l1_overview, current_path, cluster_id, status,
              hub_role_value, synthesis_subtype, trigger_type, is_cluster_hub
       FROM nodes WHERE uuid IN (${placeholders})`,
    )
    .all(...uuids) as {
    uuid: string;
    node_type: 'raw' | 'synthesis' | 'reflection';
    l0_summary: string;
    l1_overview: string;
    current_path: string | null;
    cluster_id: number | null;
    status: 'active' | 'archived' | 'superseded';
    hub_role_value: HubRoleValue | null;
    synthesis_subtype: string | null;
    trigger_type: 'on_ingest' | 'on_review' | 'on_query' | 'on_reflection' | 'explicit' | null;
    is_cluster_hub: number;
  }[];
  const order = new Map(uuids.map((u, i) => [u, i]));
  const sourceRows = db
    .prepare(
      `SELECT synthesis_uuid, source_uuid, role FROM synthesis_sources
       WHERE synthesis_uuid IN (${placeholders})`,
    )
    .all(...uuids) as { synthesis_uuid: string; source_uuid: string; role: 'primary' | 'supporting' }[];
  const sourcesBySynthesis = new Map<string, { uuid: string; role: 'primary' | 'supporting' }[]>();
  for (const s of sourceRows) {
    const arr = sourcesBySynthesis.get(s.synthesis_uuid) ?? [];
    arr.push({ uuid: s.source_uuid, role: s.role });
    sourcesBySynthesis.set(s.synthesis_uuid, arr);
  }
  return rows
    .map((r) => ({
      uuid: r.uuid,
      node_type: r.node_type,
      l0_summary: r.l0_summary,
      l1_overview: r.l1_overview,
      current_path: r.current_path,
      cluster_id: r.cluster_id,
      status: r.status,
      hub_role_value: r.hub_role_value ?? undefined,
      synthesis_subtype: (r.synthesis_subtype ?? undefined) as never,
      is_cluster_hub: r.is_cluster_hub === 1,
      sources: r.node_type === 'synthesis' ? sourcesBySynthesis.get(r.uuid) : undefined,
      trigger_type: r.node_type === 'synthesis' ? (r.trigger_type ?? undefined) as never : undefined,
      source_policy: r.node_type === 'synthesis'
        ? 'synthesis is librarian interpretation; read raw sources for factual verification'
        : undefined,
    }))
    .sort((a, b) => (order.get(a.uuid) ?? 0) - (order.get(b.uuid) ?? 0));
}
