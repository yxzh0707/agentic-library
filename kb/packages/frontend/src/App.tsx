import { useEffect, useState, Fragment } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { TopBar } from './components/TopBar';
import { ChatPanel } from './panels/ChatPanel/ChatPanel';
import { VisualizationPanel } from './panels/VisualizationPanel/VisualizationPanel';
import { DashboardPanel } from './panels/DashboardPanel/DashboardPanel';
import { SetupWizard } from './components/SetupWizard';
import { SettingsModal } from './components/SettingsModal';
import { useKBStore } from './stores/kb_store';
import { connectWS, onEvent } from './api/ws';

export type PanelKey = 'chat' | 'viz' | 'dash';

const ALL_KEYS: PanelKey[] = ['chat', 'viz', 'dash'];
const ORDER_KEY = 'kb.panel-order';
const HIDDEN_KEY = 'kb.panel-hidden';

const PANEL_COMPONENTS: Record<PanelKey, React.FC> = {
  chat: ChatPanel,
  viz: VisualizationPanel,
  dash: DashboardPanel,
};

export default function App() {
  const [order, setOrder] = useState<PanelKey[]>(loadOrder);
  const [hidden, setHidden] = useState<Set<PanelKey>>(loadHidden);
  const [showSettings, setShowSettings] = useState(false);
  const [draggingKey, setDraggingKey] = useState<PanelKey | null>(null);
  const config = useKBStore((s) => s.config);
  const refresh = useKBStore((s) => s.refresh);
  const [wizardDismissed, setWizardDismissed] = useState(false);

  useEffect(() => {
    connectWS();
    void refresh();
    // Refresh node/cluster store on any structural change so all panels stay current
    return onEvent((ev) => {
      if (
        ev.type === 'node_created' ||
        ev.type === 'node_updated' ||
        ev.type === 'node_archived' ||
        ev.type === 'cluster_assigned' ||
        ev.type === 'embedding_completed'
      ) {
        void refresh();
      }
    });
  }, [refresh]);
  useEffect(() => {
    saveOrder(order);
  }, [order]);
  useEffect(() => {
    saveHidden(hidden);
  }, [hidden]);

  const visible = order.filter((k) => !hidden.has(k));

  const toggle = (k: PanelKey) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const reorder = (from: PanelKey, target: PanelKey) => {
    if (from === target) return;
    setOrder((prev) => {
      const next = prev.filter((k) => k !== from);
      const idx = next.indexOf(target);
      next.splice(idx, 0, from);
      return next;
    });
  };

  const llmReady =
    !!config && !!config.llm.base_url && !!config.llm.chat_model && !!config.llm.api_key;
  const embReady =
    !!config &&
    !!config.embedding?.base_url &&
    !!config.embedding?.model &&
    !!config.embedding?.api_key;
  const needsSetup = config !== null && (!llmReady || !embReady);

  return (
    <div className="flex h-screen flex-col bg-primary-50 text-primary-700">
      <TopBar
        order={order}
        hidden={hidden}
        onToggle={toggle}
        onReorder={reorder}
        onOpenSettings={() => setShowSettings(true)}
        draggingKey={draggingKey}
        setDraggingKey={setDraggingKey}
      />
      <div className="flex-1 overflow-hidden">
        {visible.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-primary-500/60">
            没有可见面板。从顶部 bar 重新打开。
          </div>
        ) : (
          <PanelGroup
            key={visible.join('|')}
            direction="horizontal"
            autoSaveId={`kb-layout-${visible.join('|')}`}
          >
            {visible.map((k, i) => {
              const Cmp = PANEL_COMPONENTS[k];
              return (
                <Fragment key={k}>
                  {i > 0 && (
                    <PanelResizeHandle className="group relative w-1 bg-primary-100 transition-colors hover:bg-accent-500 data-[resize-handle-state=drag]:bg-accent-500">
                      <div className="absolute inset-y-0 -left-1 -right-1" />
                    </PanelResizeHandle>
                  )}
                  <Panel defaultSize={100 / visible.length} minSize={15} order={i}>
                    <Cmp />
                  </Panel>
                </Fragment>
              );
            })}
          </PanelGroup>
        )}
      </div>
      {needsSetup && !wizardDismissed && <SetupWizard onClose={() => setWizardDismissed(true)} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}

function loadOrder(): PanelKey[] {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as PanelKey[];
      const filtered = arr.filter((k) => ALL_KEYS.includes(k));
      const missing = ALL_KEYS.filter((k) => !filtered.includes(k));
      return [...filtered, ...missing];
    }
  } catch {
    // ignore
  }
  return [...ALL_KEYS];
}
function saveOrder(o: PanelKey[]) {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(o));
  } catch {
    // ignore
  }
}
function loadHidden(): Set<PanelKey> {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    if (raw) return new Set(JSON.parse(raw) as PanelKey[]);
  } catch {
    // ignore
  }
  return new Set();
}
function saveHidden(s: Set<PanelKey>) {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...s]));
  } catch {
    // ignore
  }
}
