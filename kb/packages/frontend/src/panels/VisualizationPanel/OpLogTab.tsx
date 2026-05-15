import { useEffect } from 'react';
import { useKBStore } from '../../stores/kb_store';
import { api } from '../../api/client';

export function OpLogTab() {
  const opLog = useKBStore((s) => s.opLog);
  const refreshOpLog = useKBStore((s) => s.refreshOpLog);

  useEffect(() => {
    void refreshOpLog();
  }, [refreshOpLog]);

  return (
    <div className="h-full overflow-y-auto p-3 text-sm">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-primary-500">
          操作日志(最近 {opLog.length})
        </h3>
        <button
          onClick={() => void refreshOpLog()}
          className="rounded px-2 py-1 text-xs text-primary-500 hover:bg-primary-50"
        >
          刷新
        </button>
      </div>
      <ol className="relative ml-3 space-y-3 border-l border-primary-100 pl-4">
        {opLog.map((e) => (
          <li key={e.op_id} className="relative">
            <span className="absolute -left-[1.05rem] top-1 h-2 w-2 rounded-full bg-accent-500" />
            <div className="rounded border border-primary-100 p-2 text-xs">
              <div className="flex justify-between text-primary-500">
                <span className="font-mono">{e.op_type}</span>
                <span>{new Date(e.timestamp).toLocaleString()}</span>
              </div>
              <div className="mt-1 text-primary-700">{e.reason}</div>
              <div className="mt-1 text-primary-500/70">
                agent={e.agent_id} · branch={e.branch_name} · uuids={e.affected_uuids.length}
              </div>
              {e.reverted_by ? (
                <div className="mt-1 text-accent-500">已被 {e.reverted_by.slice(0, 8)} 回滚</div>
              ) : (
                <button
                  className="mt-1 rounded bg-primary-50 px-2 py-1 text-[10px] hover:bg-primary-100"
                  onClick={() => void revert(e.op_id)}
                >
                  回滚
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

async function revert(op_id: string) {
  const res = await fetch('/api/agent/invoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_id: '__internal__',
      api_key: '__internal__',
      tool_name: 'revert_op',
      args: { op_id, reason: 'manual revert from UI' },
    }),
  });
  // Note: This will fail unless an admin agent is configured. Surface guidance.
  if (!res.ok) {
    alert(
      '回滚需要一个具有 admin 权限的外部 agent。请先在仪表盘 → 外部 Agent 创建一个 admin agent,然后用其 api_key 走 /api/agent/invoke。',
    );
    return;
  }
  const json = await res.json();
  if (json.result?.blocked_by) {
    alert(`被以下后续操作依赖:\n${json.result.blocked_by.join('\n')}`);
    return;
  }
  alert('回滚成功');
}
