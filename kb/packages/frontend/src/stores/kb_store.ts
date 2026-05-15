import { create } from 'zustand';
import type { GetConfigResponse, NodeBrief, OpLogEntry, SchedulerState } from '@kb/shared';
import { api } from '../api/client';

interface KBStatus {
  total: number;
  raw: number;
  synthesis: number;
  pending_embed: number;
}

interface FlagBrief {
  flag_id: string;
  flag_type: string;
  target_uuid: string | null;
  target_cluster_id: number | null;
  issue_type: string | null;
  description: string;
  flagged_at: string;
  flagged_by: string;
  status: string;
}

interface KBState {
  status: KBStatus | null;
  nodes: NodeBrief[];
  clusters: {
    cluster_id: number;
    member_count: number;
    description?: string | null;
    status?: string;
    label?: string | null;
    label_source?: string | null;
    homogeneous?: number;
    parent_cluster_id?: number | null;
  }[];
  opLog: OpLogEntry[];
  schedulerState: SchedulerState[];
  config: GetConfigResponse | null;
  freshNodeIds: Set<string>;
  flags: FlagBrief[];
  flagCounts: { pending: number; addressed: number; dismissed: number };

  refresh: () => Promise<void>;
  refreshOpLog: () => Promise<void>;
  refreshFlags: () => Promise<void>;
  triggerJob: (job: 'weekly' | 'monthly' | 'background') => Promise<void>;
  saveConfig: (patch: Partial<GetConfigResponse>) => Promise<{ dim_changed: boolean }>;
  markFreshNodes: (uuids: string[]) => void;
  clearFreshNode: (uuid: string) => void;
}

export const useKBStore = create<KBState>((set, get) => ({
  status: null,
  nodes: [],
  clusters: [],
  opLog: [],
  schedulerState: [],
  config: null,
  freshNodeIds: new Set(),
  flags: [],
  flagCounts: { pending: 0, addressed: 0, dismissed: 0 },

  refresh: async () => {
    const [status, nodes, clusters, sch, cfg] = await Promise.all([
      api.status().catch(() => null),
      api.listNodes({ limit: 100 }).catch(() => ({ nodes: [], total: 0 })),
      api.listClusters().catch(() => ({ clusters: [] })),
      api.schedulerState().catch(() => ({ states: [] })),
      api.getConfig().catch(() => null),
    ]);
    set({
      status: status ? status.counts : null,
      nodes: nodes.nodes,
      clusters: clusters.clusters as KBState['clusters'],
      schedulerState: sch.states as SchedulerState[],
      config: cfg,
    });
  },

  refreshOpLog: async () => {
    const { entries } = await api.listOpLog({ limit: 100 });
    set({ opLog: entries });
  },

  triggerJob: async (job) => {
    await api.triggerJob(job);
    await get().refreshOpLog();
  },

  saveConfig: async (patch) => {
    const res = await api.updateConfig(patch);
    set({ config: res.config });
    return { dim_changed: res.dim_changed };
  },

  markFreshNodes: (uuids) => {
    set({ freshNodeIds: new Set(uuids) });
  },

  refreshFlags: async () => {
    const { items, counts } = await api.listFlags({ limit: 50 });
    set({ flags: items as FlagBrief[], flagCounts: counts as { pending: number; addressed: number; dismissed: number } });
  },

  clearFreshNode: (uuid) => {
    set((state) => {
      if (!state.freshNodeIds.has(uuid)) return state;
      const freshNodeIds = new Set(state.freshNodeIds);
      freshNodeIds.delete(uuid);
      return { freshNodeIds };
    });
  },
}));
