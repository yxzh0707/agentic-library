/**
 * Core domain types — derived from §2/§3 of the v1.3 implementation plan.
 * Frontmatter ←→ SQLite ←→ API responses share these shapes.
 */

export type NodeType = 'raw' | 'synthesis' | 'reflection';

// v1.3 §7.1 — six subtypes; v1.0 implements consolidation + cluster_review.
export type SynthesisSubtype =
  | 'consolidation'
  | 'cluster_review'
  | 'annotation'
  | 'question'
  | 'association'
  | 'meta';

// Reflection node subtypes (Hermes Optimizer)
export type ReflectionSubtype =
  | 'decision'
  | 'failure_analysis'
  | 'retrieval_strategy'
  | 'plan'
  | 'critique'
  | 'postmortem';

export type ReflectionOutcome = 'useful' | 'superseded' | 'rejected' | 'expired';

export type ReflectionVisibility = 'private' | 'debug' | 'retrievable';

export type ReflectionPromotionState = 'distilled' | 'promoted';

export interface ReflectionSource {
  uuid: string;
  role?: 'primary' | 'supporting' | 'context';
}

export interface ReflectionTraceSource {
  agent_run_id: string;
  query_id?: string;
  message_index?: number;
}

export interface ReflectionQuality {
  confidence: 'high' | 'medium' | 'low';
  reusability_score: number | null;
}

// v1.3 §7.2 — four triggers, all driven by librarian work cadence.
export type TriggerType = 'on_ingest' | 'on_review' | 'on_query' | 'on_reflection' | 'explicit';

export type LifecycleStatus = 'active' | 'archived' | 'superseded';

export type SourceRole = 'primary' | 'supporting';

export type HubRoleValue = 'root' | 'center' | 'leaf' | 'neutral';

export type HubRoleSource = 'auto_detected' | 'human' | 'librarian' | 'root_promoted';

export type ValidationStatus = 'confirmed' | 'partially_drifted' | 'mostly_drifted';

export type InheritanceDecision = 'kept' | 'modified' | 'reversed';

export interface EmbeddingPointer {
  e_l0_id: number | null;
  e_l1_id: number | null;
  /** v1.3 取消 e_l2; column kept on disk for backward compat, always null in new writes. */
  e_l2_id: number | null;
  model: string | null;
  embedded_at: string | null;
}

export interface SynthesisSource {
  uuid: string;
  role: SourceRole;
}

export interface SynthesisTrigger {
  type: TriggerType;
  evidence: Record<string, unknown>;
}

export interface SynthesisQuality {
  compactness_ratio: number | null;
  novelty_to_sources: number | null;
  self_rating: number | null;
}

export interface NodeLifecycle {
  status: LifecycleStatus;
  reference_count: number;
  last_accessed_at: string | null;
  superseded_by: string | null;
  superseded_reason: string | null;
}

export interface HubRoleHistoryEntry {
  changed_at: string;
  from: HubRoleValue;
  to: HubRoleValue;
  changed_by: string;
  op_id: string | null;
  reason: string;
}

export interface HubRoleInfo {
  value: HubRoleValue;
  source: HubRoleSource;
  reason: string;
  history: HubRoleHistoryEntry[];
}

export interface DerivedState {
  cluster_id: number | null;
  cluster_membership_strength: number | null; // raw only
  is_cluster_hub: boolean;
  hub_of_cluster: number | null;
}

// ========== cluster_review ==========

export interface ReviewJudgment {
  claim: string;
  confidence: 'low' | 'medium' | 'high';
  proposed_action?: 'move_out' | 'archive' | 'split_off' | null;
  target_uuid?: string | null;
  /** If move_out, where should the node go? number=existing cluster, 'new'=independent working set. */
  target_cluster_id?: number | 'new' | null;
}

export interface HubRecommendation {
  proposed_hub_uuid: string | 'self';
  reasoning: string;
}

export interface ReviewedAtState {
  member_count: number;
  member_uuids: string[];
  centroid_e_l1_hash: string;
}

export interface SubThemeRecommendation {
  label: string;
  anchor_uuid: string;
  confidence: 'high' | 'medium' | 'low';
  reasoning?: string;
}

export interface ClusterReviewPayload {
  reviewed_cluster_id: number;
  reviewed_at_state: ReviewedAtState;
  review_judgments: ReviewJudgment[];
  hub_recommendation: HubRecommendation | null;
  sub_theme_recommendations?: SubThemeRecommendation[];
}

export interface Inheritance {
  previous_cluster_review_uuid: string | null;
  inheritance_decision: InheritanceDecision | null;
  inheritance_reason: string | null;
}

export interface ValidationState {
  last_validated_at: string;
  current_sources_distribution: Record<string, number>; // cluster_id → count
  primary_concentration: number;
  validation_status: ValidationStatus;
}

// ========== node ==========

export interface NodeFrontmatter {
  uuid: string;
  node_type: NodeType;
  created_at: string;
  updated_at: string;
  created_by: string;
  created_by_run: string;

  l0_summary: string;
  l1_overview: string;

  embeddings: EmbeddingPointer;
  wikilinks: string[];
  current_path: string | null;
  derived_state: DerivedState;
  lifecycle: NodeLifecycle;

  // raw-only
  hub_role?: HubRoleInfo;

  // synthesis common
  synthesis_subtype?: SynthesisSubtype;
  sources?: SynthesisSource[];
  trigger?: SynthesisTrigger;
  quality?: SynthesisQuality;
  cluster_when_created?: number;

  // cluster_review only
  review_payload?: ClusterReviewPayload;
  inheritance?: Inheritance;
  validation_state?: ValidationState;

  // reflection only
  reflection_subtype?: ReflectionSubtype;
  reflection_sources?: ReflectionSource[];
  trace_source?: ReflectionTraceSource;
  outcome?: ReflectionOutcome;
  visibility?: ReflectionVisibility;
  promotion_state?: ReflectionPromotionState;
}

export interface Node extends NodeFrontmatter {
  body: string;
}

export interface NodeBrief {
  uuid: string;
  node_type: NodeType;
  l0_summary: string;
  l1_overview?: string;
  current_path: string | null;
  cluster_id: number | null;
  status: LifecycleStatus;
  hub_role_value?: HubRoleValue;
  synthesis_subtype?: SynthesisSubtype;
  is_cluster_hub?: boolean;
  /** synthesis only: raw sources this synthesis was derived from. */
  sources?: SynthesisSource[];
  /** synthesis only: why/when this synthesis was generated. */
  trigger_type?: TriggerType;
  /** synthesis only: reminder that raw sources remain the factual evidence. */
  source_policy?: string;
  /** cluster_review only: the cluster it was generated for (always set). */
  reviewed_cluster_id?: number | null;
  /** True if this node has been embedded (HNSW indices contain its vectors). */
  embedded?: boolean;
}

export interface NodeFilter {
  node_type?: NodeType;
  cluster_id?: number;
  status?: LifecycleStatus;
  hub_role_value?: HubRoleValue;
  synthesis_subtype?: SynthesisSubtype;
  exclude_subtype?: SynthesisSubtype;
  limit?: number;
  offset?: number;
}

export interface CreateNodeInput {
  node_type: NodeType;
  body: string;
  l0_summary?: string;
  l1_overview?: string;
  wikilinks?: string[];
  current_path?: string | null;
  created_by?: string;
  created_by_run?: string;
  // raw-only
  hub_role?: HubRoleInfo;
  // synthesis common
  synthesis_subtype?: SynthesisSubtype;
  sources?: SynthesisSource[];
  trigger?: SynthesisTrigger;
  quality?: SynthesisQuality;
  cluster_when_created?: number;
  // cluster_review only
  review_payload?: ClusterReviewPayload;
  inheritance?: Inheritance;
  // reflection only
  reflection_subtype?: ReflectionSubtype;
  reflection_sources?: ReflectionSource[];
  trace_source?: ReflectionTraceSource;
  outcome?: ReflectionOutcome;
  visibility?: ReflectionVisibility;
  promotion_state?: ReflectionPromotionState;
}

// ========== clustering ==========

/**
 * Origin of the hub election decision for a cluster.
 * - `librarian_recommended`: cluster_review.hub_recommendation (LLM saw the whole cluster)
 * - `raw_lexical_fallback`: hub_role=center candidates, lexical/created_at order
 * - `synthesis_calculated`: cluster_review synthesis itself acts as hub (no raw center)
 * - `none`: no eligible hub
 * Legacy value `raw_explicit` is preserved for backwards compatibility with
 * historical rows; new writes use one of the four above.
 */
export type HubSource =
  | 'root_anchor'
  | 'librarian_recommended'
  | 'raw_lexical_fallback'
  | 'synthesis_calculated'
  | 'none'
  | 'raw_explicit';

export interface Cluster {
  cluster_id: number;
  created_at: string;
  member_count: number;
  description: string | null;
  status: 'active' | 'merged' | 'split';
  hub_uuid: string | null;
  hub_source: HubSource | null;
  friction_count: number;
  last_review_at: string | null;
  last_new_member_at: string | null;
  /** Hierarchical clustering: NULL = top level; otherwise points at the parent cluster's id. */
  parent_cluster_id: number | null;
}

export interface ClusterInfo extends Cluster {
  members: NodeBrief[];
}

export interface ClusterAssignmentResult {
  cluster_id: number | null;
  strength: number;
}

export interface SubstructureResult {
  silhouette: number;
  recommended_action: 'split' | 'pattern_synthesis' | 'noop';
  sub_assignments: number[] | null;
  k: number | null;
}

// ========== cluster quality ==========

export type ClusterStatus =
  | 'healthy'
  | 'underanchored'
  | 'overbroad'
  | 'drifting'
  | 'stale'
  | 'needs_review';

export interface ClusterQualitySignal {
  cluster_id: number;
  member_count: number;
  cohesion: number;
  center_density: number;
  drift_score: number;
  friction_score: number;
  noise_pressure: number;
  last_review_status: string | null;
  status: ClusterStatus;
  reasons: string[];
}

// ========== synthesis ==========

export interface SynthesisCandidate {
  source_uuids: string[];
  cluster_id: number | null;
  subtype: SynthesisSubtype;
  trigger: SynthesisTrigger;
}

export type GateRejection = {
  rejected: true;
  reason: string;
};

export type SynthesisResult = Node | GateRejection;

// ========== flag queue ==========

export type FlagType = 'specific_issue' | 'cluster_friction';

export type FlagIssueType =
  | 'l1_inaccurate'
  | 'wrong_cluster'
  | 'duplicate'
  | 'outdated'
  | 'cluster_review_drifted'
  | 'other';

export type FlagStatus = 'pending' | 'addressed' | 'dismissed';

export interface FlagItem {
  flag_id: string;
  flag_type: FlagType;
  target_uuid: string | null;
  target_cluster_id: number | null;
  issue_type: FlagIssueType | null;
  description: string;
  flagged_at: string;
  flagged_by: string;
  status: FlagStatus;
  addressed_by_op_id: string | null;
  addressed_at: string | null;
}

// ========== op log ==========

export type OpType =
  | 'move'
  | 'merge'
  | 'split'
  | 'promote'
  | 'demote'
  | 'rewrite_summary'
  | 'extract'
  | 'dedupe'
  | 'set_hub_role'
  | 'cluster_status_change'
  | 'revert'
  | 'branch_create'
  | 'branch_merge';

export interface OpLogEntry {
  op_id: string;
  timestamp: string;
  agent_run_id: string;
  agent_id: string;
  op_type: OpType;
  args: Record<string, unknown>;
  reason: string;
  before_view_hash: string;
  after_view_hash: string;
  affected_uuids: string[];
  reverted_by: string | null;
  branch_name: string;
}

export interface OpLogFilter {
  since?: string;
  until?: string;
  agent_id?: string;
  op_type?: OpType;
  branch?: string;
  limit?: number;
}

// ========== query log ==========

export type QueriedBy = 'consultant' | 'librarian' | `external:${string}`;

export interface QueryLogEntry {
  query_id: string;
  timestamp: string;
  queried_by: QueriedBy;
  query_text: string;
  raw_hits: string[];
  synthesis_hits: string[];
  raw_after_expansion: string[];
  final_used: string[];
  flagged_issues: string[] | null;
  answer_adopted: 0 | 1 | null;
}

export interface QueryLogFilter {
  since?: string;
  queried_by?: string;
  limit?: number;
}

// ========== agent runs ==========

export type AgentRunType =
  | 'on_ingest'
  | 'on_review'
  | 'on_query'
  | 'on_reflection'
  | 'background_pass'
  | 'monthly_recluster'
  | 'consultant'
  | 'manual';

export type AgentRunStatus = 'running' | 'completed' | 'failed';

export interface AgentRun {
  run_id: string;
  agent_id: string;
  run_type: AgentRunType;
  started_at: string;
  finished_at: string | null;
  status: AgentRunStatus;
  summary: string | null;
}

// ========== scheduler ==========

export type SchedulerJobName = 'weekly' | 'monthly' | 'background';

export interface SchedulerState {
  job_name: SchedulerJobName;
  last_run_at: string | null;
  next_run_at: string | null;
  last_status: string | null;
}

// ========== registered agents ==========

export interface RegisteredAgent {
  agent_id: string;
  name: string;
  permissions: PermissionTag[];
  created_at: string;
  status: 'active' | 'revoked';
}

// ========== config ==========

export interface KBConfigLLM {
  provider: 'openai_compatible';
  base_url: string;
  api_key: string;
  chat_model: string;
}

export interface KBConfigEmbedding {
  base_url: string;
  api_key: string;
  model: string;
  dim: number;
}

export interface KBConfigParameters {
  // clustering
  hdbscan_min_cluster_size: number;
  hdbscan_min_samples: number;
  umap_n_neighbors: number;
  umap_n_components: number;
  // substructure (used as signal for cluster_review, not direct split trigger)
  silhouette_split_threshold: number;
  silhouette_pattern_threshold: number;
  // drift detection (v1.3 §6.6)
  drift_centroid_shift_threshold: number;
  drift_covariance_change_threshold: number;
  // on_review
  review_max_clusters_per_week: number;
  review_min_weeks_since_last: number;
  // on_ingest
  on_ingest_neighbors_k: number;
  on_ingest_max_synthesis_per_node: number;
  // synthesis budgets
  synthesis_budget_per_review_cluster: number;
  // post-gates (consolidation)
  compactness_max: number;
  compactness_hard_max: number;
  similarity_to_source_max: number;
  self_rating_min: number;
  // retrieval
  search_expansion_top_k_clusters: number;
  search_expansion_per_cluster: number;
  search_centroid_min_distance_fallback: number;
  search_hub_boost: number;
  search_graph_expand_from_top_k: number;
  search_graph_expand_max: number;
}

export interface KBConfig {
  version: '1.3';
  data_dir: string;
  llm: KBConfigLLM;
  embedding: KBConfigEmbedding;
  parameters: KBConfigParameters;
  external_agents?: ExternalAgentConfig[];
}

export interface ExternalAgentConfig {
  agent_id: string;
  api_key: string;
  permissions: PermissionTag[];
  description?: string;
  created_at: string;
}

// ========== tools ==========

export type PermissionTag = 'read' | 'write' | 'structural' | 'admin';

export interface ToolContext {
  agent_id: string;
  agent_run_id: string;
  permissions: PermissionTag[];
}

// ========== agent API ==========

export type AgentErrorCode =
  | 'INVALID_CREDENTIALS' // 401 认证失败
  | 'PERMISSION_DENIED' // 403 权限不足
  | 'UNKNOWN_TOOL' // 404 工具不存在
  | 'INVALID_ARGUMENTS' // 400 参数校验失败
  | 'TOOL_EXECUTION_ERROR' // 500 工具执行异常
  | 'RATE_LIMITED' // 429 限流
  | 'INTERNAL_ERROR'; // 500 服务器错误

export interface AgentErrorResponse {
  error: {
    code: AgentErrorCode;
    message: string;
    tool_name?: string;
    details?: unknown;
  };
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  permission_tag: PermissionTag;
  /** 'read' | 'write' | 'structural' | 'admin' */
  category: 'read' | 'write' | 'structural' | 'admin';
  restricted?: {
    reason: string;
    suggestion?: string;
  };
}

export interface AgentToolListResponse {
  tools: ToolSpec[];
  agent_id: string;
  permissions: PermissionTag[];
  warnings?: string[];
}

// ========== chat ==========

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
  name?: string;
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  created_at: string;
  updated_at: string;
}
