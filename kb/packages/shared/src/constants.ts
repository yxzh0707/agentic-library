import type { KBConfigParameters } from './types.js';

export const DEFAULT_PARAMETERS: KBConfigParameters = {
  // clustering
  hdbscan_min_cluster_size: 12,
  hdbscan_min_samples: 5,
  umap_n_neighbors: 15,
  umap_n_components: 50,
  // substructure
  silhouette_split_threshold: 0.5,
  silhouette_pattern_threshold: 0.4,
  // drift detection
  drift_centroid_shift_threshold: 0.15,
  drift_covariance_change_threshold: 0.3,
  // on_review
  review_max_clusters_per_week: 3,
  review_min_weeks_since_last: 4,
  // on_ingest
  on_ingest_neighbors_k: 8,
  on_ingest_max_synthesis_per_node: 2,
  // synthesis budgets
  synthesis_budget_per_review_cluster: 2,
  // post-gates (consolidation)
  compactness_max: 0.4,
  compactness_hard_max: 0.6,
  similarity_to_source_max: 0.9,
  self_rating_min: 3,
  // retrieval (v1.3 §9.4)
  search_expansion_top_k_clusters: 3,
  search_expansion_per_cluster: 5,
  search_centroid_min_distance_fallback: 0.5,
  search_hub_boost: 0.05,
  search_graph_expand_from_top_k: 5,
  search_graph_expand_max: 8,
};

export const DEFAULT_PORT = 7823;
export const DEFAULT_HOST = '127.0.0.1';

export const HNSW_M = 16;
export const HNSW_EF_CONSTRUCTION = 200;
export const HNSW_EF_SEARCH = 50;

// v1.3 schedule: weekly (on_review), monthly (full recluster + reflection), background (flag queue + cluster_review regen).
export const CRON_WEEKLY = '0 4 * * 0';
export const CRON_MONTHLY = '0 5 1 * *';
export const CRON_BACKGROUND = '*/15 * * * *';
