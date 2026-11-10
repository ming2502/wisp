import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  CircleStop,
  Download,
  FileText,
  FolderOpen,
  Plus,
  RotateCw,
  Settings as SettingsIcon,
  SquareTerminal,
  WifiOff,
  X,
} from "lucide-react";
import { ConnectDialog } from "../features/connect/ConnectDialog";
import { GroupEditor } from "../features/hosts/GroupEditor";
import { HostEditor } from "../features/hosts/HostEditor";
import { HostList } from "../features/hosts/HostList";
import { moveHost } from "../features/hosts/order";
import { TerminalView } from "../features/terminal/TerminalView";
import { FileBrowser } from "../features/files/FileBrowser";
import type { FinishedUpload } from "../features/files/uploads";
import { TransfersPanel } from "../features/transfers/TransfersPanel";
import { createSpeedTracker } from "../features/transfers/speed";
import { SettingsDialog } from "../features/settings/SettingsDialog";
import { useSettings } from "../features/settings/SettingsContext";
import { UpdateDialog } from "../features/updates/UpdateDialog";
import { useUpdater } from "../features/updates/useUpdater";
import { WhatsNew } from "../features/updates/WhatsNew";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { button } from "../ui/controls";
import { Logo } from "../ui/Logo";
import { isMac, isShortcut, shortcutLabel } from "../lib/platform";
import {
  groupDelete,
  hostDelete,
  hostMove,
  hostsList,
  sshDisconnect,
  appReady,
  sshReplace,
  transfersSubscribe,
  type Group,
  type Host,
  type HostList as HostData,
  type TerminalEnd,
  type TransferInfo,
} from "../ipc";
import {
  nextActive,
  openEditor,
  replaceSession,
  sessionKey,
  tabsClosedWith,
  type SessionTab,
  type Tab,
  type View,
} from "./tabs";

// The editor and CodeMirror are most of the code, and only needed once a file is opened.
const EditorView = lazy(() =>
  import("../features/editor/EditorView").then((module) => ({ default: module.EditorView })),
);

const noUploads: readonly FinishedUpload[] = [];

type Dialog =
  | { kind: "connect"; host: Host; replacing?: number }
  | { kind: "editHost"; host: Host | null }
  | { kind: "deleteHost"; host: Host }
  | { kind: "editGroup"; group: Group | null }
  | { kind: "deleteGroup"; group: Group }
  | { kind: "settings" }
  | { kind: "closeTabs"; key: string; message: string }
  | { kind: "update" }
  | { kind: "quit" };

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="rounded border border-line-strong bg-canvas px-1.5 py-px font-sans text-[11px] text-muted">{children}</kbd>
  );
}

function Welcome({ onNewHost }: { onNewHost: () => void }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-sm">
        <Logo size={44} />
        <h2 className="mt-5 text-xl font-semibold tracking-tight">开始连接</h2>
        <p className="mt-1.5 text-sm text-muted">在左侧选择一台主机，或者先添加一台。</p>
        <button
          type="button"
          className="mt-6 flex w-full items-center gap-3 rounded-lg border border-line bg-raised px-3.5 py-3 text-left transition-colors duration-150 hover:border-line-strong hover:bg-hover"
          onClick={onNewHost}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent/12 text-accent">
            <Plus size={16} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">新建主机</span>
            <span className="block truncate text-xs text-muted">填写地址、用户和认证方式</span>
          </span>
        </button>
      </div>
    </div>
  );
}

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
  const { settings } = useSettings();
  const updater = useUpdater(settings.checkUpdates);

  useEffect(() => {
    appReady().catch(() => {});
  }, []);

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

  // Each session's finished uploads, which its file view uses to reload the directory it shows.
  const finishedUploads = useMemo(() => {
    const bySession = new Map<number, FinishedUpload[]>();
    for (const t of transfers)
      if (t.direction === "upload" && t.state.kind === "completed")
        bySession.set(t.owner, [...(bySession.get(t.owner) ?? []), { id: t.id, remote: t.remote }]);
    return bySession;
  }, [transfers]);

  const connectedHosts = useMemo(
    () => new Set(tabs.flatMap((tab) => (tab.kind === "session" && !tab.end ? [tab.hostId] : []))),
    [tabs],
  );

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

  function updateTab(key: string, change: (tab: Tab) => Tab) {
    setTabs((current) => current.map((tab) => (tab.key === key ? change(tab) : tab)));
  }

  function connected(sessionId: number, host: Host, replacing?: number) {
    if (replacing !== undefined) {
      void sshReplace(replacing, sessionId).catch((reason) => setNotice(`传输未能转到新连接：${reason}`));
      setTabs((current) => replaceSession(current, replacing, sessionId));
      setActiveKey(sessionKey(replacing));
      return;
    }
    const key = sessionKey(sessionId);
    setTabs((current) => [
      ...current,
      { kind: "session", key, sessionId, hostId: host.id, title: host.name, end: null, view: "terminal" },
    ]);
    setActiveKey(key);
  }

  function markEnded(key: string, end: TerminalEnd) {
    updateTab(key, (tab) => (tab.kind === "session" ? { ...tab, end: end.kind } : tab));
  }

  function setView(key: string, view: View) {
    updateTab(key, (tab) => (tab.kind === "session" ? { ...tab, view } : tab));
  }

  function openFile(sessionId: number, path: string) {
    const opened = openEditor(tabs, sessionId, path);
    setTabs(opened.tabs);
    setActiveKey(opened.key);
  }

  function reconnect(tab: SessionTab) {
    const host = data.hosts.find((h) => h.id === tab.hostId);
    if (host) setDialog({ kind: "connect", host, replacing: tab.sessionId });
    else setNotice("该主机已被删除，无法重新连接");
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
  const isConnected = (sessionId: number) =>
    tabs.some((tab) => tab.kind === "session" && tab.sessionId === sessionId && tab.end !== "disconnected");

  // Global shortcuts, caught before the terminal sees them.
  const shortcuts = useRef<(event: KeyboardEvent) => void>(() => {});
  shortcuts.current = (event) => {
    const handled = (() => {
      if (isShortcut(event, "Comma")) return setDialog({ kind: "settings" }), true;
      if (isShortcut(event, "KeyW") && activeKey) return requestClose(activeKey), true;
      const digit = /^Digit([1-9])$/.exec(event.code);
      if (digit && isShortcut(event, event.code)) {
        const tab = tabs[Number(digit[1]) - 1];
        if (tab) setActiveKey(tab.key);
        return true;
      }
      if (event.ctrlKey && event.key === "Tab" && tabs.length > 1) {
        const index = tabs.findIndex((tab) => tab.key === activeKey);
        const step = event.shiftKey ? -1 : 1;
        setActiveKey(tabs[(index + step + tabs.length) % tabs.length].key);
        return true;
      }
      return false;
    })();
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => shortcuts.current(event);
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, []);

  return (
    <div className="flex h-screen">
      <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-panel">
        {/* Room for the traffic lights, which sit over the app on macOS. Windows has a title bar. */}
        {isMac && <div data-tauri-drag-region className="h-10 shrink-0" />}
        <div className="min-h-0 flex-1">
          {loadError ? (
            <p role="alert" className="p-4 text-sm text-danger">
              {loadError}
            </p>
          ) : (
            <HostList
              hosts={data.hosts}
              groups={data.groups}
              connected={connectedHosts}
              onConnect={(host) => setDialog({ kind: "connect", host })}
              onNewHost={() => setDialog({ kind: "editHost", host: null })}
              onEditHost={(host) => setDialog({ kind: "editHost", host })}
              onDeleteHost={(host) => setDialog({ kind: "deleteHost", host })}
              onNewGroup={() => setDialog({ kind: "editGroup", group: null })}
              onEditGroup={(group) => setDialog({ kind: "editGroup", group })}
              onDeleteGroup={(group) => setDialog({ kind: "deleteGroup", group })}
              onMoveHost={(host, drop) => {
                setData((current) => ({ ...current, hosts: moveHost(current.hosts, host.id, drop) }));
                hostMove(host.id, drop.groupId, drop.before)
                  .catch((reason) => setNotice(`无法移动主机：${reason}`))
                  .finally(refresh);
              }}
            />
          )}
        </div>
        {updater.update && updater.status.kind !== "installing" && (
          <button
            type="button"
            className="mx-2 mb-2 flex items-center gap-2 rounded-md border border-accent/30 bg-accent/10 px-2.5 py-2 text-left text-xs text-accent transition-colors duration-150 hover:bg-accent/15"
            onClick={() => setDialog({ kind: "update" })}
          >
            <Download size={14} className="shrink-0" />
            新版本 {updater.update.version} 可用，点击查看
          </button>
        )}
        <div className="shrink-0 border-t border-line px-2 py-1.5">
          <button
            type="button"
            className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-xs text-muted transition-colors duration-150 hover:bg-hover hover:text-ink"
            onClick={() => setDialog({ kind: "settings" })}
          >
            <SettingsIcon size={13} />
            <span className="flex-1 text-left">设置</span>
            <Kbd>{shortcutLabel(",")}</Kbd>
          </button>
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        {/* A fixed-height strip that never moves the window. The tabs sit on the bottom line and only
            scroll sideways; the active tab covers the line beneath it. Under the Windows title bar an
            empty one only cuts the sidebar's edge short, so there it appears with the first tab;
            macOS keeps it for the row the traffic lights sit in. */}
        {(isMac || tabs.length > 0) && (
          <div className="relative flex h-10 shrink-0 items-center gap-2 overflow-hidden bg-panel pr-2">
            <span aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-line" />
            <div
              role="tablist"
              className="flex h-full min-w-0 flex-1 items-end gap-0.5 overflow-x-auto overflow-y-hidden overscroll-none px-1.5 select-none [scrollbar-width:none]"
            >
              {tabs.map((tab) => {
                const active = tab.key === activeKey;
                return (
                  <div
                    key={tab.key}
                    className={`group relative flex h-8 shrink-0 items-center rounded-t-md text-[13px] transition-colors duration-150 ${
                      active ? "bg-canvas text-ink shadow-[inset_0_0_0_1px_var(--color-line)]" : "text-muted hover:bg-hover hover:text-ink"
                    }`}
                  >
                    {active && <span aria-hidden className="absolute inset-x-2 top-0 h-0.5 rounded-full bg-accent" />}
                    {active && <span aria-hidden className="absolute inset-x-px bottom-0 h-px bg-canvas" />}
                    <button
                      role="tab"
                      aria-selected={active}
                      data-tooltip={tab.kind === "editor" ? tab.path : undefined}
                      className="flex h-full max-w-56 items-center gap-2 pl-3 pr-1.5"
                      onClick={() => setActiveKey(tab.key)}
                    >
                      {tab.kind === "editor" ? (
                        <FileText size={13} className="shrink-0" />
                      ) : (
                        <span
                          aria-label={tab.end === "disconnected" ? "已断开" : tab.end ? "会话已结束" : "已连接"}
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            tab.end === "disconnected" ? "bg-danger" : tab.end ? "bg-muted" : "bg-accent"
                          }`}
                        />
                      )}
                      {/* A session tab names its host in full only when the name is cut short. */}
                      <span
                        className="truncate"
                        data-tooltip={tab.kind === "editor" ? undefined : tab.title}
                        data-tooltip-overflow
                      >
                        {tab.title}
                      </span>
                    </button>
                    <button
                      aria-label={`关闭 ${tab.title}`}
                      className="mr-1 flex h-5 w-5 items-center justify-center rounded text-muted transition-colors duration-150 hover:bg-selected hover:text-ink"
                      onClick={() => requestClose(tab.key)}
                    >
                      {tab.kind === "editor" && tab.dirty ? (
                        <>
                          <span aria-label="未保存" className="h-2 w-2 rounded-full bg-accent group-hover:hidden" />
                          <X size={13} className="hidden group-hover:block" />
                        </>
                      ) : (
                        <X size={13} />
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
            {notice && <span className="max-w-[40%] truncate text-xs text-muted" data-tooltip={notice} data-tooltip-overflow>{notice}</span>}
            {activeTab?.kind === "session" && (
              <div role="radiogroup" aria-label="视图" className="flex shrink-0 rounded-md border border-line bg-canvas p-0.5 text-xs">
                {(
                  [
                    ["terminal", "终端", SquareTerminal],
                    ["files", "文件", FolderOpen],
                  ] as const
                ).map(([view, label, Icon]) => (
                  <button
                    key={view}
                    role="radio"
                    aria-checked={activeTab.view === view}
                    className={`flex h-6 items-center gap-1.5 rounded px-2.5 transition-colors duration-150 ${
                      activeTab.view === view ? "bg-selected font-medium text-ink" : "text-muted hover:text-ink"
                    }`}
                    onClick={() => setView(activeTab.key, view)}
                  >
                    <Icon size={13} />
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {activeTab?.kind === "session" && activeTab.end && (
          <div
            role="status"
            className={`flex shrink-0 items-center justify-between gap-3 border-b px-3 py-2 text-sm ${
              activeTab.end === "disconnected" ? "border-danger/25 bg-danger/8" : "border-line bg-panel"
            }`}
          >
            <span className={`flex items-center gap-2 ${activeTab.end === "disconnected" ? "text-danger" : "text-muted"}`}>
              {activeTab.end === "disconnected" ? <WifiOff size={15} className="shrink-0" /> : <CircleStop size={15} className="shrink-0" />}
              {activeTab.end === "disconnected"
                ? "连接已断开。终端内容和未保存的编辑都已保留，未完成的传输可以在重连后继续。"
                : "终端会话已结束，文件视图仍可使用。"}
            </span>
            <button type="button" className={button("primary", "sm")} onClick={() => reconnect(activeTab)}>
              <RotateCw size={13} />
              {activeTab.end === "disconnected" ? "重新连接" : "重新打开"}
            </button>
          </div>
        )}
        <div className="relative min-h-0 flex-1">
          {tabs.length === 0 && (
<Welcome onNewHost={() => setDialog({ kind: "editHost", host: null })} />
          )}
          {tabs.map((tab) => (
            <div key={tab.key} className="absolute inset-0" style={{ display: tab.key === activeKey ? "block" : "none" }}>
              {tab.kind === "session" ? (
                <>
                  <div className="h-full" style={{ display: tab.view === "terminal" ? "block" : "none" }}>
                    <TerminalView
                      sessionId={tab.sessionId}
                      visible={tab.key === activeKey && tab.view === "terminal"}
                      onEnd={(end) => markEnded(tab.key, end)}
                    />
                  </div>
                  {tab.end !== "disconnected" && (
                    <div className="h-full" style={{ display: tab.view === "files" ? "block" : "none" }}>
                      <FileBrowser
                        key={tab.sessionId}
                        sessionId={tab.sessionId}
                        active={tab.key === activeKey && tab.view === "files"}
                        onNotice={setNotice}
                        onOpenFile={(path) => openFile(tab.sessionId, path)}
                        finishedUploads={finishedUploads.get(tab.sessionId) ?? noUploads}
                      />
                    </div>
                  )}
                </>
              ) : (
                <Suspense fallback={<p className="p-6 text-sm text-muted">正在加载编辑器…</p>}>
                  <EditorView
                    sessionId={tab.sessionId}
                    path={tab.path}
                    connected={isConnected(tab.sessionId)}
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
            connected(sessionId, dialog.host, dialog.replacing);
            close();
          }}
          onClose={close}
        />
      )}
      {dialog?.kind === "settings" && (
        <SettingsDialog onClose={close} updater={updater} onOpenUpdate={() => setDialog({ kind: "update" })} />
      )}
      <WhatsNew />
      {dialog?.kind === "update" && <UpdateDialog updater={updater} hasUnsaved={hasUnsaved} onClose={close} />}
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
        <ConfirmDialog title="关闭" message={dialog.message} confirmLabel="仍然关闭" onConfirm={async () => closeTabs(dialog.key)} onClose={close} />
      )}
      {dialog?.kind === "quit" && (
        <ConfirmDialog
          title="退出 wisp"
          message="有文件尚未保存，退出后这些修改会丢失。"
          confirmLabel="不保存并退出"
          onConfirm={() => getCurrentWindow().destroy()}
          onClose={close}
        />
      )}
    </div>
  );
}
