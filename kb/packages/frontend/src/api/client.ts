import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  GetConfigResponse,
  UpdateConfigResponse,
  ListAgentRunsResponse,
  ListClustersResponse,
  ListNodesResponse,
  ListOpLogResponse,
  ListSchedulerStateResponse,
  Node,
  NodeBrief,
  SchedulerJobName,
  TriggerSchedulerResponse,
  UpdateConfigRequest,
} from '@kb/shared';

const BASE = '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => request<{ ok: boolean; ts: string }>('/api/health'),

  chat: (body: ChatRequest) =>
    request<ChatResponse>('/api/chat', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  listNodes: (filter: Record<string, string | number | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v !== undefined) qs.set(k, String(v));
    return request<ListNodesResponse>(`/api/nodes?${qs.toString()}`);
  },

  getNode: (uuid: string) => request<Node>(`/api/nodes/${uuid}`),

  archiveNode: (uuid: string, reason = 'archived from UI') =>
    request<{ ok: boolean }>(`/api/nodes/${uuid}/archive`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  deleteNode: (uuid: string) =>
    request<{ ok: boolean; deleted: string }>(`/api/nodes/${uuid}`, {
      method: 'DELETE',
    }),

  listClusters: () => request<ListClustersResponse>('/api/clusters'),

  getCluster: (id: number) =>
    request<{ cluster_id: number; member_count: number; members: NodeBrief[] }>(
      `/api/clusters/${id}`,
    ),

  listOpLog: (filter: Record<string, string | number | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v !== undefined) qs.set(k, String(v));
    return request<ListOpLogResponse>(`/api/op_log?${qs.toString()}`);
  },

  status: () =>
    request<{ counts: { total: number; raw: number; synthesis: number; pending_embed: number }; cluster_count: number }>(
      '/api/status',
    ),

  agentRuns: () => request<ListAgentRunsResponse>('/api/agent_runs'),

  schedulerState: () => request<ListSchedulerStateResponse>('/api/scheduler_state'),

  triggerJob: (job_name: SchedulerJobName) =>
    request<TriggerSchedulerResponse>('/api/scheduler/trigger', {
      method: 'POST',
      body: JSON.stringify({ job_name }),
    }),

  getConfig: (reveal = false) =>
    request<GetConfigResponse>(`/api/config${reveal ? '?reveal=1' : ''}`),

  updateConfig: (patch: UpdateConfigRequest, reveal = false) =>
    request<UpdateConfigResponse>(`/api/config${reveal ? '?reveal=1' : ''}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),

  importText: (body: string, l0?: string, l1?: string) =>
    request<{ uuid: string }>('/api/import/text', {
      method: 'POST',
      body: JSON.stringify({ body, l0_summary: l0, l1_overview: l1 }),
    }),

  importFiles: async (files: File[]) => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    // Use the multi-format endpoint — supports .md / .txt / .pdf / .docx
    // and applies SHA256 dedupe automatically.
    const res = await fetch('/api/import/files', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(`${res.status}`);
    return (await res.json()) as {
      imported: {
        uuid: string;
        filename: string;
        format: string;
        warnings: string[];
        structure: { heading_count: number; source: string };
        deduped?: boolean;
      }[];
      failed: { name: string; reason: string }[];
      deduped_count?: number;
    };
  },

  fetchInsights: (want = ['god_nodes', 'surprises', 'gaps'], top = 10) =>
    request<{
      god_nodes?: Array<{ uuid: string; label: string; degree: number; cluster_id: number | null }>;
      surprises?: Array<{
        source: string;
        target: string;
        source_label: string;
        target_label: string;
        relation_type: string;
        confidence: string;
        score: number;
        reasons: string[];
        cluster_pair: [number | null, number | null];
      }>;
      gaps?: Array<{
        type: 'orphan' | 'low_cohesion_cluster' | 'bridge_node';
        message: string;
        refs: { uuid?: string; cluster_id?: number; label?: string };
        evidence: Record<string, unknown>;
      }>;
    }>(`/api/graph/insights?want=${want.join(',')}&top=${top}`),

  listReviewQueue: (status: 'pending' | 'resolved' | 'dismissed' = 'pending') =>
    request<{
      items: Array<{
        review_id: string;
        created_at: string;
        kind: string;
        source_uuid: string | null;
        target_uuid: string | null;
        cluster_id: number | null;
        payload: Record<string, unknown>;
        status: string;
        resolved_at: string | null;
        resolved_by: string | null;
        resolution: Record<string, unknown> | null;
      }>;
      counts: { pending: number; resolved: number; dismissed: number };
    }>(`/api/review_queue?status=${status}`),

  resolveReview: (review_id: string, resolution: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/api/review_queue/${review_id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ resolution, resolved_by: 'human:default' }),
    }),

  listFlags: (filter: { status?: string; flag_type?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v !== undefined) qs.set(k, String(v));
    return request<{ items: Array<{ flag_id: string; flag_type: string; target_uuid: string | null; target_cluster_id: number | null; issue_type: string | null; description: string; flagged_at: string; flagged_by: string; status: string }>; counts: Record<string, number> }>(`/api/flag_queue?${qs.toString()}`);
  },

  dismissFlag: (flag_id: string) =>
    request<{ ok: boolean }>(`/api/flag_queue/${encodeURIComponent(flag_id)}/dismiss`, {
      method: 'POST',
    }),

  dismissReview: (review_id: string, reason: string) =>
    request<{ ok: boolean }>(`/api/review_queue/${review_id}/dismiss`, {
      method: 'POST',
      body: JSON.stringify({ reason, resolved_by: 'human:default' }),
    }),

  createAgent: (agent_id: string, permissions: string[], description?: string) =>
    request<{ agent: { agent_id: string }; api_key: string }>('/api/agent/create', {
      method: 'POST',
      body: JSON.stringify({ agent_id, permissions, description }),
    }),

  fetchGraph: () =>
    request<{
      nodes: Array<{
        uuid: string;
        node_type: string;
        l0_summary: string;
        cluster_id: number | null;
        status: string;
        reference_count: number;
      }>;
      links: Array<{ source: string; target: string; kind: 'wikilink' | 'source'; role?: string }>;
    }>('/api/graph'),

  pingLLM: () =>
    request<{
      chat: { ok: boolean; ms: number; sample?: string; error?: string };
      embedding: { ok: boolean; ms: number; dim?: number; error?: string };
    }>('/api/llm/ping', { method: 'POST' }),
};

export type ChatStreamEvent =
  | { type: 'delta'; data: string }
  | { type: 'tool_call'; data: unknown }
  | { type: 'references'; data: unknown }
  | { type: 'done'; data?: unknown }
  | { type: 'error'; data: { message: string } };

export async function* chatStream(messages: ChatMessage[]): AsyncGenerator<ChatStreamEvent> {
  const res = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  });
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';
    for (const ev of events) {
      const lines = ev.split('\n');
      let evtType = 'delta';
      let dataRaw = '';
      for (const l of lines) {
        if (l.startsWith('event: ')) evtType = l.slice(7);
        else if (l.startsWith('data: ')) dataRaw = l.slice(6);
      }
      try {
        const data = dataRaw ? JSON.parse(dataRaw) : null;
        yield { type: evtType as ChatStreamEvent['type'], data } as ChatStreamEvent;
      } catch {
        // ignore malformed
      }
    }
  }
}
