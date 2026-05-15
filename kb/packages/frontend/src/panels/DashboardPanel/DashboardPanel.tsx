import { useEffect, useState } from 'react';
import { useKBStore } from '../../stores/kb_store';
import { connectWS, onEvent } from '../../api/ws';
import { api } from '../../api/client';
import { AgentManagementSection } from './AgentManagementSection';

export function DashboardPanel() {
  const { status, schedulerState, opLog, flags, flagCounts, refresh, refreshOpLog, refreshFlags, triggerJob } = useKBStore();
  const [busyJob, setBusyJob] = useState<string | null>(null);

  useEffect(() => {
    connectWS();
    void refresh();
    void refreshOpLog();
    void refreshFlags();
    const off = onEvent((ev) => {
      void refresh();
      void refreshOpLog();
      if (ev.type === 'flag_queue_appended') void refreshFlags();
    });
    const handle = setInterval(() => {
      void refresh();
    }, 30_000);
    return () => {
      off();
      clearInterval(handle);
    };
  }, [refresh, refreshOpLog, refreshFlags]);

  const onTrigger = async (job: 'weekly' | 'monthly' | 'background') => {
    setBusyJob(job);
    try {
      await triggerJob(job);
    } finally {
      setBusyJob(null);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-white">
      <div className="border-b border-primary-100 px-4 py-3 text-sm font-medium">仪表盘</div>
      <div className="space-y-4 p-4">
        <Section title="状态">
          <Stat label="raw 节点" value={status?.raw ?? '—'} />
          <Stat label="synthesis 节点" value={status?.synthesis ?? '—'} />
          <Stat label="待嵌入" value={status?.pending_embed ?? '—'} />
        </Section>
        <Section title="调度">
          {schedulerState.length === 0 && <p className="text-xs text-primary-500/60">未运行</p>}
          {schedulerState.map((s) => (
            <div key={s.job_name} className="flex items-center justify-between text-xs">
              <span className="text-primary-500">{s.job_name}</span>
              <span className="text-primary-700">
                {s.last_run_at ? new Date(s.last_run_at).toLocaleString() : '—'} ({s.last_status ?? '—'})
              </span>
            </div>
          ))}
        </Section>
        <Section title="操作">
          {(['weekly', 'monthly', 'background'] as const).map((j) => (
            <button
              key={j}
              onClick={() => void onTrigger(j)}
              disabled={busyJob === j}
              className="w-full rounded bg-primary-50 px-3 py-2 text-left text-sm hover:bg-primary-100 disabled:opacity-50"
            >
              立即跑 {j === 'weekly' ? '周' : j === 'monthly' ? '月' : '后台'} 整理
              {busyJob === j && ' (运行中...)'}
            </button>
          ))}
        </Section>
        <Section title="最近操作日志">
          {opLog.length === 0 && <p className="text-xs text-primary-500/60">暂无</p>}
          {opLog.slice(0, 10).map((e) => (
            <div key={e.op_id} className="rounded border border-primary-100 px-2 py-1 text-xs">
              <div className="flex justify-between text-primary-500">
                <span>{e.op_type}</span>
                <span>{new Date(e.timestamp).toLocaleTimeString()}</span>
              </div>
              <div className="text-primary-700">{e.reason}</div>
            </div>
          ))}
        </Section>
        <SystemSignalsSection flags={flags} counts={flagCounts} onDismiss={async (id) => { await api.dismissFlag(id); void refreshFlags(); }} />
        <AgentManagementSection />
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-card border border-primary-100 bg-white p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-primary-500">
        {title}
      </h3>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-primary-500">{label}</span>
      <span className="font-medium text-primary-700">{value}</span>
    </div>
  );
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

function SystemSignalsSection({
  flags,
  counts,
  onDismiss,
}: {
  flags: FlagBrief[];
  counts: { pending: number; addressed: number; dismissed: number };
  onDismiss: (id: string) => void;
}) {
  const pending = flags.filter((f) => f.status === 'pending');
  return (
    <Section title={`系统信号 (${counts.pending})`}>
      {pending.length === 0 && (
        <p className="text-xs text-primary-500/60">暂无系统信号</p>
      )}
      {pending.slice(0, 20).map((f) => {
        const isFriction = f.flag_type === 'cluster_friction';
        return (
          <div
            key={f.flag_id}
            className="rounded border border-primary-100 px-2 py-1.5 text-xs"
          >
            <div className="flex items-center justify-between mb-1">
              <span
                className={`rounded px-1 py-0.5 text-[10px] font-medium ${
                  isFriction
                    ? 'bg-indigo-100 text-indigo-700'
                    : 'bg-amber-100 text-amber-700'
                }`}
              >
                {isFriction ? '簇摩擦' : '具体问题'}
              </span>
              <span className="text-primary-500/60">
                {new Date(f.flagged_at).toLocaleString()}
              </span>
            </div>
            <p className="text-primary-700 leading-relaxed whitespace-pre-wrap">
              {f.description}
            </p>
            <div className="flex items-center justify-between mt-1.5">
              <span className="text-[10px] text-primary-500/60">
                {f.flagged_by}
              </span>
              <button
                onClick={() => onDismiss(f.flag_id)}
                className="rounded px-2 py-0.5 text-[10px] text-primary-500 hover:bg-primary-50"
              >
                忽略
              </button>
            </div>
          </div>
        );
      })}
    </Section>
  );
}
