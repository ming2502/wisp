import { useState } from "react";
import { X } from "lucide-react";
import { ConnectForm } from "../features/hosts/ConnectForm";
import { TerminalView } from "../features/terminal/TerminalView";
import { sshDisconnect } from "../ipc";

interface Tab {
  sessionId: number;
  title: string;
  ended: boolean;
}

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);

  function addTab(sessionId: number, title: string) {
    setTabs((current) => [...current, { sessionId, title, ended: false }]);
    setActiveId(sessionId);
  }

  function markEnded(sessionId: number) {
    setTabs((current) =>
      current.map((tab) => (tab.sessionId === sessionId ? { ...tab, ended: true } : tab)),
    );
    void sshDisconnect(sessionId);
  }

  function closeTab(sessionId: number) {
    const remaining = tabs.filter((tab) => tab.sessionId !== sessionId);
    setTabs(remaining);
    if (activeId === sessionId) setActiveId(remaining[remaining.length - 1]?.sessionId ?? null);
    void sshDisconnect(sessionId);
  }

  return (
    <div className="flex h-screen">
      <aside className="w-72 shrink-0 overflow-y-auto border-r border-line bg-panel p-4">
        <h1 className="mb-4 text-sm font-semibold">新建连接</h1>
        <ConnectForm onConnected={addTab} />
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        {tabs.length > 0 && (
          <div role="tablist" className="flex shrink-0 overflow-x-auto border-b border-line bg-panel">
            {tabs.map((tab) => (
              <div
                key={tab.sessionId}
                className={`flex items-center border-r border-line text-sm ${
                  tab.sessionId === activeId ? "bg-canvas" : "text-muted"
                }`}
              >
                <button
                  role="tab"
                  aria-selected={tab.sessionId === activeId}
                  className="max-w-56 truncate py-2 pl-3 pr-2"
                  onClick={() => setActiveId(tab.sessionId)}
                >
                  {tab.ended ? <s>{tab.title}</s> : tab.title}
                </button>
                <button
                  aria-label={`关闭 ${tab.title}`}
                  className="mr-1.5 rounded p-1 hover:bg-line"
                  onClick={() => closeTab(tab.sessionId)}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="relative min-h-0 flex-1">
          {tabs.length === 0 && (
            <p className="flex h-full items-center justify-center text-sm text-muted">
              在左侧填写服务器信息以开始
            </p>
          )}
          {tabs.map((tab) => (
            <div
              key={tab.sessionId}
              className="absolute inset-0"
              style={{ display: tab.sessionId === activeId ? "block" : "none" }}
            >
              <TerminalView
                sessionId={tab.sessionId}
                visible={tab.sessionId === activeId}
                onEnd={() => markEnded(tab.sessionId)}
              />
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
