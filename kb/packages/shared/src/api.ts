/**
 * Shared HTTP API contract types.
 */
import type {
  AgentRun,
  ChatMessage,
  Cluster,
  ClusterInfo,
  ExternalAgentConfig,
  KBConfig,
  Node,
  NodeBrief,
  NodeFilter,
  OpLogEntry,
  OpLogFilter,
  PermissionTag,
  QueryLogEntry,
  QueryLogFilter,
  SchedulerJobName,
  SchedulerState,
} from './types.js';

// ========== chat ==========

export interface ChatRequest {
  conversation_id?: string;
  messages: ChatMessage[];
}

export interface ConsultantReference {
  uuid: string;
  node_type: string;
  l0_summary: string;
}

export interface ChatResponse {
  conversation_id: string;
  message: ChatMessage;
  references?: ConsultantReference[];
  run_id?: string;
}

// ========== nodes / clusters ==========

export interface ListNodesResponse {
  nodes: NodeBrief[];
  total: number;
}

export type ListNodesQuery = NodeFilter;

export interface ListClustersResponse {
  clusters: Cluster[];
}

export type GetClusterResponse = ClusterInfo;
export type GetNodeResponse = Node;

// ========== op log ==========

export interface ListOpLogResponse {
  entries: OpLogEntry[];
}

export type ListOpLogQuery = OpLogFilter;

// ========== query log ==========

export interface ListQueryLogResponse {
  entries: QueryLogEntry[];
}

export type ListQueryLogQuery = QueryLogFilter;

// ========== agent runs / scheduler ==========

export interface ListAgentRunsResponse {
  runs: AgentRun[];
}

export interface ListSchedulerStateResponse {
  states: SchedulerState[];
}

export interface TriggerSchedulerRequest {
  job_name: SchedulerJobName;
}

export interface TriggerSchedulerResponse {
  run_id: string;
}

// ========== config ==========

export type GetConfigResponse = KBConfig & {
  /** Dotted paths (e.g. "llm.api_key") that are sourced from .env at runtime.
   * UI edits to these fields are only effective until next restart. */
  _env_managed_keys?: string[];
};
export type UpdateConfigRequest = Partial<KBConfig>;
export interface UpdateConfigResponse {
  config: GetConfigResponse;
  dim_changed: boolean;
}

// ========== import ==========

export interface ImportTextRequest {
  body: string;
  l0_summary?: string;
  l1_overview?: string;
  current_path?: string;
}

export interface ImportResponse {
  imported: string[];
  failed: { name: string; reason: string }[];
}

// ========== agent invoke ==========

export interface AgentInvokeRequest {
  agent_id: string;
  api_key: string;
  tool_name: string;
  args: Record<string, unknown>;
}

export interface AgentInvokeResponse {
  result?: unknown;
  error?: string;
}

export interface AgentListToolsRequest {
  agent_id: string;
  api_key: string;
}

export interface AgentListToolsResponse {
  tools: OpenAIToolSpec[];
}

export interface OpenAIToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ========== external agent management ==========

export interface CreateExternalAgentRequest {
  agent_id: string;
  permissions: PermissionTag[];
  description?: string;
}

export interface CreateExternalAgentResponse {
  agent: ExternalAgentConfig;
  api_key: string;
}

// ========== ws events ==========

export type WSEvent =
  | { type: 'node_created'; uuid: string }
  | { type: 'node_updated'; uuid: string }
  | { type: 'node_archived'; uuid: string }
  | { type: 'embedding_completed'; uuid: string }
  | { type: 'cluster_assigned'; uuid: string; cluster_id: number | null }
  | { type: 'agent_run_started'; run_id: string; agent_id: string }
  | { type: 'agent_run_finished'; run_id: string; status: string }
  | { type: 'op_log_appended'; op_id: string }
  | { type: 'flag_queue_appended'; flag_id: string; flag_type: string; description: string }
  | { type: 'config_updated' };
