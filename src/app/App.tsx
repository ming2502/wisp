import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, SquareTerminal, X } from "lucide-react";
import { ConnectDialog } from "../features/connect/ConnectDialog";
import { GroupEditor } from "../features/hosts/GroupEditor";
import { HostEditor } from "../features/hosts/HostEditor";
import { HostList } from "../features/hosts/HostList";
import { ImportDialog } from "../features/hosts/ImportDialog";
import { TerminalView } from "../features/terminal/TerminalView";
import { FileBrowser } from "../features/files/FileBrowser";
import { TransfersPanel } from "../features/transfers/TransfersPanel";
import { createSpeedTracker } from "../features/transfers/speed";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import {
  groupDelete,
  hostDelete,
  hostsList,
  sshDisconnect,
  transfersSubscribe,
  type Group,
  type TransferInfo,
  type Host,
  type HostList as HostData,
} from "../ipc";

type View = "terminal" | "files";

interface Tab {
  sessionId: number;
  title: string;
  ended: boolean;
  view: View;
}

type Dialog =
  | { kind: "connect"; host: Host }
  | { kind: "editHost"; host: Host | null }
  | { kind: "deleteHost"; host: Host }
  | { kind: "editGroup"; group: Group | null }
  | { kind: "deleteGroup"; group: Group }
  | { kind: "import" }
  | { kind: "closeTab"; tab: Tab; active: number };

export default function App() {
  const [data, setData] = useState<HostData>({ hosts: [], groups: [] });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [transfers, setTransfers] = useState<TransferInfo[]>([]);
  const [speeds, setSpeeds] = useState<Map<number, number>>(new Map());
  const [notice, setNotice] = useState<string | null>(null);
  const trackSpeed = useRef(createSpeedTracker());

  useEffect(() => {
    const update = (list: TransferInfo[]) => {
      setTransfers(list);
      setSpeeds(trackSpeed.current(list, performance.now()));
    };
    try {
      transfersSubscribe(update).then(update).catch(() => {});
    } catch {
      // Not running inside Tauri.
    }
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const activeTransfers = useMemo(() => {
    const counts = new Map<number, number>();
    for (const t of transfers)
      if (t.state.kind === "running" || t.state.kind === "queued")
        counts.set(t.owner, (counts.get(t.owner) ?? 0) + 1);
    return counts;
  }, [transfers]);

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
    setTabs((current) => [...current, { sessionId, title, ended: false, view: "terminal" }]);
    setActiveId(sessionId);
  }

  function markEnded(sessionId: number) {
    setTabs((current) =>
      current.map((tab) => (tab.sessionId === sessionId ? { ...tab, ended: true } : tab)),
    );
    void sshDisconnect(sessionId);
  }

  function setView(sessionId: number, view: View) {
    setTabs((current) => current.map((tab) => (tab.sessionId === sessionId ? { ...tab, view } : tab)));
  }

  function requestCloseTab(tab: Tab) {
    const active = activeTransfers.get(tab.sessionId) ?? 0;
    if (active > 0) setDialog({ kind: "closeTab", tab, active });
    else closeTab(tab.sessionId);
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
                  onClick={() => requestCloseTab(tab)}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        {tabs.some((tab) => tab.sessionId === activeId) && (
          <div className="flex shrink-0 items-center justify-between border-b border-line px-2 py-1">
            <div role="radiogroup" aria-label="视图" className="flex rounded-md bg-panel p-0.5 text-xs">
              {(
                [
                  ["terminal", "终端", SquareTerminal],
                  ["files", "文件", FolderOpen],
                ] as const
              ).map(([view, label, Icon]) => {
                const current = tabs.find((tab) => tab.sessionId === activeId)!.view === view;
                return (
                  <button
                    key={view}
                    role="radio"
                    aria-checked={current}
                    className={`flex items-center gap-1.5 rounded px-2.5 py-1 ${current ? "bg-canvas shadow-sm" : "text-muted"}`}
                    onClick={() => setView(activeId!, view)}
                  >
                    <Icon size={13} />
                    {label}
                  </button>
                );
              })}
            </div>
            {notice && <span className="truncate text-xs text-muted">{notice}</span>}
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
              <div className="h-full" style={{ display: tab.view === "terminal" ? "block" : "none" }}>
                <TerminalView
                  sessionId={tab.sessionId}
                  visible={tab.sessionId === activeId && tab.view === "terminal"}
                  onEnd={() => markEnded(tab.sessionId)}
                />
              </div>
              {!tab.ended && (
                <div className="h-full" style={{ display: tab.view === "files" ? "block" : "none" }}>
                  <FileBrowser
                    sessionId={tab.sessionId}
                    active={tab.sessionId === activeId && tab.view === "files"}
                    onNotice={setNotice}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
        <TransfersPanel transfers={transfers} speeds={speeds} />
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
      {dialog?.kind === "closeTab" && (
        <ConfirmDialog
          title="关闭连接"
          message={`“${dialog.tab.title}”还有 ${dialog.active} 个传输未完成。关闭后这些传输会被取消，未完成的部分会被删除。`}
          confirmLabel="关闭并取消传输"
          onConfirm={async () => closeTab(dialog.tab.sessionId)}
          onClose={close}
        />
      )}
      {dialog?.kind === "import" && (
        <ImportDialog hosts={data.hosts} onImported={refresh} onClose={close} />
      )}
    </div>
  );
}
