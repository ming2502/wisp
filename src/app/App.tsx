import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { ConnectDialog } from "../features/connect/ConnectDialog";
import { GroupEditor } from "../features/hosts/GroupEditor";
import { HostEditor } from "../features/hosts/HostEditor";
import { HostList } from "../features/hosts/HostList";
import { ImportDialog } from "../features/hosts/ImportDialog";
import { TerminalView } from "../features/terminal/TerminalView";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import {
  groupDelete,
  hostDelete,
  hostsList,
  sshDisconnect,
  type Group,
  type Host,
  type HostList as HostData,
} from "../ipc";

interface Tab {
  sessionId: number;
  title: string;
  ended: boolean;
}

type Dialog =
  | { kind: "connect"; host: Host }
  | { kind: "editHost"; host: Host | null }
  | { kind: "deleteHost"; host: Host }
  | { kind: "editGroup"; group: Group | null }
  | { kind: "deleteGroup"; group: Group }
  | { kind: "import" };

export default function App() {
  const [data, setData] = useState<HostData>({ hosts: [], groups: [] });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);

  const refresh = useCallback(() => {
    hostsList()
      .then((list) => {
        setData(list);
        setLoadError(null);
      })
      .catch((reason) => setLoadError(String(reason)));
  }, []);

  useEffect(refresh, [refresh]);

  const close = () => setDialog(null);

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
      <aside className="w-72 shrink-0 border-r border-line bg-panel">
        {loadError ? (
          <p role="alert" className="p-4 text-sm text-danger">
            {loadError}
          </p>
        ) : (
          <HostList
            hosts={data.hosts}
            groups={data.groups}
            onConnect={(host) => setDialog({ kind: "connect", host })}
            onNewHost={() => setDialog({ kind: "editHost", host: null })}
            onEditHost={(host) => setDialog({ kind: "editHost", host })}
            onDeleteHost={(host) => setDialog({ kind: "deleteHost", host })}
            onNewGroup={() => setDialog({ kind: "editGroup", group: null })}
            onEditGroup={(group) => setDialog({ kind: "editGroup", group })}
            onDeleteGroup={(group) => setDialog({ kind: "deleteGroup", group })}
            onImport={() => setDialog({ kind: "import" })}
          />
        )}
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
              在左侧选择主机以连接
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

      {dialog?.kind === "connect" && (
        <ConnectDialog
          host={dialog.host}
          onConnected={(sessionId) => {
            addTab(sessionId, dialog.host.name);
            close();
          }}
          onClose={close}
        />
      )}
      {dialog?.kind === "editHost" && (
        <HostEditor
          host={dialog.host}
          groups={data.groups}
          onSaved={(host, connect) => {
            refresh();
            setDialog(connect ? { kind: "connect", host } : null);
          }}
          onClose={close}
        />
      )}
      {dialog?.kind === "deleteHost" && (
        <ConfirmDialog
          title="删除主机"
          message={`确定删除“${dialog.host.name}”吗？已保存的密码也会从系统钥匙串中删除。`}
          confirmLabel="删除"
          onConfirm={async () => {
            await hostDelete(dialog.host.id);
            refresh();
          }}
          onClose={close}
        />
      )}
      {dialog?.kind === "editGroup" && (
        <GroupEditor
          group={dialog.group}
          onSaved={() => {
            refresh();
            close();
          }}
          onClose={close}
        />
      )}
      {dialog?.kind === "deleteGroup" && (
        <ConfirmDialog
          title="删除分组"
          message={`确定删除分组“${dialog.group.name}”吗？其中的主机会保留，并移到未分组。`}
          confirmLabel="删除"
          onConfirm={async () => {
            await groupDelete(dialog.group.id);
            refresh();
          }}
          onClose={close}
        />
      )}
      {dialog?.kind === "import" && (
        <ImportDialog hosts={data.hosts} onImported={refresh} onClose={close} />
      )}
    </div>
  );
}
