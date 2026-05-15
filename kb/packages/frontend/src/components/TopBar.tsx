import {
  MessageCircle,
  Network,
  LayoutDashboard,
  Settings,
  GripVertical,
  Eye,
  EyeOff,
  type LucideIcon,
} from 'lucide-react';
import type { PanelKey } from '../App';
import clsx from 'clsx';

interface Props {
  order: PanelKey[];
  hidden: Set<PanelKey>;
  onToggle: (k: PanelKey) => void;
  onReorder: (from: PanelKey, target: PanelKey) => void;
  onOpenSettings: () => void;
  draggingKey: PanelKey | null;
  setDraggingKey: (k: PanelKey | null) => void;
}

const META: Record<PanelKey, { label: string; icon: LucideIcon }> = {
  chat: { label: 'Chat', icon: MessageCircle },
  viz: { label: 'Visualization', icon: Network },
  dash: { label: 'Dashboard', icon: LayoutDashboard },
};

export function TopBar({
  order,
  hidden,
  onToggle,
  onReorder,
  onOpenSettings,
  draggingKey,
  setDraggingKey,
}: Props) {
  return (
    <header className="flex h-12 items-center justify-between border-b border-primary-100 bg-white px-4">
      <div className="flex items-center gap-2 font-semibold text-primary-700">
        <span className="text-accent-500">◆</span>
        <span>Knowledge Base</span>
      </div>
      <div className="flex items-center gap-1">
        {order.map((k) => {
          const Icon = META[k].icon;
          const isVisible = !hidden.has(k);
          return (
            <div
              key={k}
              draggable
              onDragStart={(e) => {
                setDraggingKey(k);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() => setDraggingKey(null)}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (draggingKey && draggingKey !== k) onReorder(draggingKey, k);
                setDraggingKey(null);
              }}
              className={clsx(
                'flex h-8 cursor-grab items-center rounded text-sm transition-all active:cursor-grabbing',
                isVisible
                  ? 'bg-primary-50 text-primary-700'
                  : 'text-primary-500/60 hover:bg-primary-50',
                draggingKey === k && 'opacity-40',
                draggingKey && draggingKey !== k && 'ring-1 ring-primary-100',
              )}
              title="拖动调整顺序 / 右键单击隐藏"
            >
              <span className="px-1 text-primary-500/40">
                <GripVertical size={12} />
              </span>
              <button
                onClick={() => onToggle(k)}
                className="flex h-full items-center gap-1.5 pr-2"
              >
                <Icon size={14} />
                <span>{META[k].label}</span>
                {isVisible ? (
                  <Eye size={12} className="text-primary-500/60" />
                ) : (
                  <EyeOff size={12} className="text-primary-500/40" />
                )}
              </button>
            </div>
          );
        })}
        <button
          onClick={onOpenSettings}
          className="ml-2 flex h-8 w-8 items-center justify-center rounded text-primary-500 hover:bg-primary-50"
          title="设置"
        >
          <Settings size={16} />
        </button>
      </div>
    </header>
  );
}
