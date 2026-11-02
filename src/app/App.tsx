import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FileText, FolderOpen, SquareTerminal, X } from "lucide-react";
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

import {
  nextActive,
  openEditor,
  sessionKey,
  tabsClosedWith,
  type Tab,
  type View,
} from "./tabs";

// The editor and CodeMirror are most of the code, and only needed once a file is opened.
const EditorView = lazy(() =>
  import("../features/editor/EditorView").then((module) => ({ default: module.EditorView })),
);

type Dialog =
  | { kind: "connect"; host: Host }
  | { kind: "editHost"; host: Host | null }
  | { kind: "deleteHost"; host: Host }
  | { kind: "editGroup"; group: Group | null }
  | { kind: "deleteGroup"; group: Group }
  | { kind: "import" }
  | { kind: "closeTabs"; key: string; message: string }
  | { kind: "quit" };

export default function App() {
  const [data, setData] = useState<HostData>({ hosts: [], groups: [] });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
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

  const hasUnsaved = tabs.some((tab) => tab.kind === "editor" && tab.dirty);
  const hasUnsavedRef = useRef(hasUnsaved);
  hasUnsavedRef.current = hasUnsaved;

  // Quitting with unsaved edits asks first.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    try {
      void getCurrentWindow()
        .onCloseRequested((event) => {
          if (!hasUnsavedRef.current) return;
          event.preventDefault();
          setDialog({ kind: "quit" });
        })
        .then((stop) => (unlisten = stop))
        .catch(() => {});
    } catch {
      // Not running inside Tauri.
    }
    return () => unlisten?.();
  }, []);

  const close = () => setDialog(null);

  function addTab(sessionId: number, title: string) {
    const key = sessionKey(sessionId);
    setTabs((current) => [...current, { kind: "session", key, sessionId, title, ended: false, view: "terminal" }]);
    setActiveKey(key);
  }

  function updateTab(key: string, change: (tab: Tab) => Tab) {
    setTabs((current) => current.map((tab) => (tab.key === key ? change(tab) : tab)));
  }

  function markEnded(sessionId: number) {
    updateTab(sessionKey(sessionId), (tab) => ({ ...tab, ended: true }));
    void sshDisconnect(sessionId);
  }

  function setView(key: string, view: View) {
    updateTab(key, (tab) => (tab.kind === "session" ? { ...tab, view } : tab));
  }

  function openFile(sessionId: number, path: string) {
    const opened = openEditor(tabs, sessionId, path);
    setTabs(opened.tabs);
    setActiveKey(opened.key);
  }

  function requestClose(key: string) {
    const closing = tabsClosedWith(tabs, key);
    const target = closing.find((tab) => tab.key === key);
    if (!target) return;
    const unsaved = closing.filter((tab) => tab.kind === "editor" && tab.dirty).length;
    const transfersLeft = target.kind === "session" ? (activeTransfers.get(target.sessionId) ?? 0) : 0;
    const reasons = [
      unsaved > 0 && `有 ${unsaved} 个文件尚未保存，关闭后修改会丢失`,
      transfersLeft > 0 && `有 ${transfersLeft} 个传输未完成，关闭后会被取消，未完成的部分会被删除`,
    ].filter(Boolean);
    if (reasons.length > 0) {
      setDialog({ kind: "closeTabs", key, message: `“${target.title}”${reasons.join("；")}。` });
    } else {
      closeTabs(key);
    }
  }

  function closeTabs(key: string) {
    const closing = tabsClosedWith(tabs, key);
    setTabs(tabs.filter((tab) => !closing.includes(tab)));
    setActiveKey(nextActive(tabs, closing, activeKey));
    const session = closing.find((tab) => tab.kind === "session");
    if (session) void sshDisconnect(session.sessionId);
  }

  const activeTab = tabs.find((tab) => tab.key === activeKey) ?? null;
  const connected = (sessionId: number) =>
    tabs.some((tab) => tab.kind === "session" && tab.sessionId === sessionId && !tab.ended);

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
                key={tab.key}
                className={`flex items-center border-r border-line text-sm ${
                  tab.key === activeKey ? "bg-canvas" : "text-muted"
                }`}
              >
                <button
                  role="tab"
                  aria-selected={tab.key === activeKey}
                  title={tab.kind === "editor" ? tab.path : tab.title}
                  className="flex max-w-56 items-center gap-1.5 py-2 pl-3 pr-2"
                  onClick={() => setActiveKey(tab.key)}
                >
                  {tab.kind === "editor" && <FileText size={13} className="shrink-0" />}
                  <span className="truncate">
                    {tab.kind === "session" && tab.ended ? <s>{tab.title}</s> : tab.title}
                  </span>
                  {tab.kind === "editor" && tab.dirty && (
                    <span aria-label="未保存" className="text-accent">
                      ●
                    </span>
                  )}
                </button>
                <button
                  aria-label={`关闭 ${tab.title}`}
                  className="mr-1.5 rounded p-1 hover:bg-line"
                  onClick={() => requestClose(tab.key)}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        {activeTab?.kind === "session" && (
          <div className="flex shrink-0 items-center justify-between border-b border-line px-2 py-1">
            <div role="radiogroup" aria-label="视图" className="flex rounded-md bg-panel p-0.5 text-xs">
              {(
                [
                  ["terminal", "终端", SquareTerminal],
                  ["files", "文件", FolderOpen],
                ] as const
              ).map(([view, label, Icon]) => {
                const current = activeTab.view === view;
                return (
                  <button
                    key={view}
                    role="radio"
                    aria-checked={current}
                    className={`flex items-center gap-1.5 rounded px-2.5 py-1 ${current ? "bg-canvas shadow-sm" : "text-muted"}`}
                    onClick={() => setView(activeTab.key, view)}
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
              key={tab.key}
              className="absolute inset-0"
              style={{ display: tab.key === activeKey ? "block" : "none" }}
            >
              {tab.kind === "session" ? (
                <>
                  <div className="h-full" style={{ display: tab.view === "terminal" ? "block" : "none" }}>
                    <TerminalView
                      sessionId={tab.sessionId}
                      visible={tab.key === activeKey && tab.view === "terminal"}
                      onEnd={() => markEnded(tab.sessionId)}
                    />
                  </div>
                  {!tab.ended && (
                    <div className="h-full" style={{ display: tab.view === "files" ? "block" : "none" }}>
                      <FileBrowser
                        sessionId={tab.sessionId}
                        active={tab.key === activeKey && tab.view === "files"}
                        onNotice={setNotice}
                        onOpenFile={(path) => openFile(tab.sessionId, path)}
                      />
                    </div>
                  )}
                </>
              ) : (
                <Suspense fallback={<p className="p-6 text-sm text-muted">正在加载编辑器…</p>}>
                <EditorView
                  sessionId={tab.sessionId}
                  path={tab.path}
                  connected={connected(tab.sessionId)}
                  visible={tab.key === activeKey}
                  onDirtyChange={(dirty) =>
                    updateTab(tab.key, (current) =>
                      current.kind === "editor" && current.dirty !== dirty ? { ...current, dirty } : current,
                    )
                  }
                />
                </Suspense>
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
      {dialog?.kind === "closeTabs" && (
        <ConfirmDialog
          title="关闭"
          message={dialog.message}
          confirmLabel="仍然关闭"
          onConfirm={async () => closeTabs(dialog.key)}
          onClose={close}
        />
      )}
      {dialog?.kind === "quit" && (
        <ConfirmDialog
          title="退出 sshtool"
          message="有文件尚未保存，退出后这些修改会丢失。"
          confirmLabel="不保存并退出"
          onConfirm={() => getCurrentWindow().destroy()}
          onClose={close}
        />
      )}
      {dialog?.kind === "import" && (
        <ImportDialog hosts={data.hosts} onImported={refresh} onClose={close} />
      )}
    </div>
  );
}
