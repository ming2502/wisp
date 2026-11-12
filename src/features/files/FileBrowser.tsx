import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  ArchiveRestore,
  ArrowUp,
  CopyPlus,
  Download,
  File,
  FilePen,
  FileSymlink,
  Folder,
  FolderPlus,
  FolderUp,
  KeyRound,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import {
  clipboardFiles,
  pickPaths,
  sftpChmod,
  sftpCopy,
  sftpList,
  sftpMkdir,
  sftpRemove,
  sftpRename,
  sftpRenameReplacing,
  transferDownload,
  terminalDir,
  transferUpload,
  type RemoteEntry,
} from "../../ipc";
import { formatBytes, formatPermissions, formatTime } from "../../lib/format";
import { isMac } from "../../lib/platform";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { ContextMenu } from "../../ui/ContextMenu";
import { NameDialog } from "../../ui/NameDialog";
import { compactInputClass, iconButton } from "../../ui/controls";
import { backupName, restoredName } from "./backup";
import { ChmodDialog } from "./ChmodDialog";
import { landedIn, type FinishedUpload } from "./uploads";
import { emptySelection, moveFocus, prune, select, selectAll, type Selection } from "./selection";

const ROW_HEIGHT = 30;
const COLUMNS = "grid grid-cols-[minmax(0,1fr)_6rem_9.5rem_6.5rem] gap-3";
const DOWNLOAD_DIR_KEY = "wisp.downloadDir";

type Dialog =
  | { kind: "mkdir" }
  | { kind: "rename"; entry: RemoteEntry }
  | { kind: "chmod"; entry: RemoteEntry }
  | { kind: "delete"; entries: RemoteEntry[] }
  | { kind: "restore"; entry: RemoteEntry; name: string }
  | { kind: "replaceBackup"; entry: RemoteEntry; name: string }
  | { kind: "overwrite"; localPaths: string[]; names: string[] };

function isDir(entry: RemoteEntry) {
  return entry.kind === "dir" || entry.linkToDir;
}

function baseName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function EntryIcon({ entry }: { entry: RemoteEntry }) {
  if (entry.kind === "symlink") return <FileSymlink size={15} className="shrink-0 text-muted" />;
  if (isDir(entry)) return <Folder size={15} className="shrink-0 text-accent" />;
  return <File size={15} className="shrink-0 text-muted" />;
}

/** The running backup, with a bar, in the status bar. */
function CopyStatus({ name, done, size }: { name: string; done: number; size: number }) {
  const percent = size > 0 ? Math.min(100, Math.round((done / size) * 100)) : 100;
  return (
    <span role="status" className="flex min-w-0 items-center gap-2">
      <span className="truncate">正在备份 {name}</span>
      <span className="h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-line">
        <span className="block h-full rounded-full bg-accent transition-[width] duration-150" style={{ width: `${percent}%` }} />
      </span>
      <span className="shrink-0 tabular-nums">
        {percent}% · {formatBytes(done)} / {formatBytes(size)}
      </span>
    </span>
  );
}

interface Props {
  sessionId: number;
  active: boolean;
  onNotice: (message: string) => void;
  onOpenFile: (path: string) => void;
  /** Uploads of this session the queue has finished, so the listing can pick them up. */
  finishedUploads: readonly FinishedUpload[];
  /** Goes up each time the view should open the directory the terminal's shell is in. */
  follow: number;
}

export function FileBrowser({ sessionId, active, onNotice, onOpenFile, finishedUploads, follow }: Props) {
  const [path, setPath] = useState<string | null>(null);
  const [typedPath, setTypedPath] = useState("");
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(emptySelection);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [dragging, setDragging] = useState(false);
  const [copying, setCopying] = useState<{ name: string; done: number; size: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entries: RemoteEntry[] } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const scroller = useRef<HTMLDivElement>(null);
  const request = useRef(0);

  const order = useMemo(() => entries.map((entry) => entry.path), [entries]);
  const selected = entries.filter((entry) => selection.selected.has(entry.path));

  const load = useCallback(
    (target: string | null) => {
      const id = ++request.current;
      setLoading(true);
      sftpList(sessionId, target)
        .then((listing) => {
          if (id !== request.current) return;
          const changedDir = listing.path !== path;
          setPath(listing.path);
          setTypedPath(listing.path);
          setEntries(listing.entries);
          setError(null);
          setSelection((current) =>
            changedDir ? emptySelection : prune(current, listing.entries.map((e) => e.path)),
          );
          if (changedDir) scroller.current?.scrollTo({ top: 0 });
        })
        .catch((reason) => {
          if (id !== request.current) return;
          setError(String(reason));
          setTypedPath(path ?? "");
        })
        .finally(() => {
          if (id === request.current) setLoading(false);
        });
    },
    [sessionId, path],
  );

  // Coming over from the terminal opens the directory its shell is in. Where the server cannot
  // tell, the view stays where it was, or starts in the home directory.
  const [following, setFollowing] = useState(false);
  const followPending = useRef(false);
  const handledFollow = useRef(follow);
  const loadLatest = useRef(load);
  loadLatest.current = load;
  const pathNow = useRef(path);
  pathNow.current = path;
  useEffect(() => {
    if (follow === handledFollow.current) return;
    handledFollow.current = follow;
    followPending.current = true;
    setFollowing(true);
    terminalDir(sessionId)
      .catch(() => null)
      .then((dir) => {
        if (follow !== handledFollow.current) return;
        if (dir && dir !== pathNow.current) loadLatest.current(dir);
      })
      .finally(() => {
        if (follow !== handledFollow.current) return;
        followPending.current = false;
        setFollowing(false);
      });
  }, [follow, sessionId]);

  // Opens the home directory once, the first time the file view is shown, unless it is about to
  // open the terminal's directory instead.
  useEffect(() => {
    if (active && path === null && !loading && !following && !followPending.current && error === null) load(null);
  }, [active, path, loading, following, error, load]);

  const refresh = () => load(path);

  // A finished upload into the shown directory, or a folder under it, reloads the listing. Uploads
  // that had already finished when the view opened are not news; a burst of small files reloads once.
  const seenUploads = useRef<Set<number> | null>(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latestLoad = useRef(() => {});
  latestLoad.current = () => load(path);
  useEffect(() => {
    const seen = seenUploads.current;
    if (seen === null) {
      seenUploads.current = new Set(finishedUploads.map((upload) => upload.id));
      return;
    }
    const fresh = finishedUploads.filter((upload) => !seen.has(upload.id));
    for (const upload of fresh) seen.add(upload.id);
    if (path === null || !landedIn(path, fresh) || reloadTimer.current !== undefined) return;
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = undefined;
      latestLoad.current();
    }, 250);
  }, [finishedUploads, path]);
  useEffect(() => () => clearTimeout(reloadTimer.current), []);

  const upload = useCallback(
    async (localPaths: string[], confirmed = false) => {
      if (path === null || localPaths.length === 0) return;
      const existing = new Set(entries.map((entry) => entry.name));
      const clashes = localPaths.map(baseName).filter((name) => existing.has(name));
      if (clashes.length > 0 && !confirmed) {
        setDialog({ kind: "overwrite", localPaths, names: clashes });
        return;
      }
      try {
        const result = await transferUpload(sessionId, localPaths, path);
        onNotice(
          `已加入 ${result.files} 个上传` + (result.skipped ? `，跳过 ${result.skipped} 个链接或特殊文件` : ""),
        );
      } catch (reason) {
        setError(String(reason));
      }
    },
    [entries, onNotice, path, sessionId],
  );

  const latestUpload = useRef(upload);
  latestUpload.current = upload;

  // Files copied in Finder or Explorer upload on paste while this view is shown. The shortcut and
  // the paste event can both arrive for one press, so a second request close behind is ignored.
  const notice = useRef(onNotice);
  notice.current = onNotice;
  useEffect(() => {
    if (!active) return;
    let last = 0;
    const ignored = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.isContentEditable || target.matches("input, textarea, select") || target.closest("[role=dialog]") !== null);
    const paste = async () => {
      if (Date.now() - last < 500) return;
      last = Date.now();
      const files = await clipboardFiles().catch(() => [] as string[]);
      if (files.length > 0) void latestUpload.current(files);
      else notice.current("剪贴板中没有文件：在访达或资源管理器中复制文件后再粘贴");
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      const v = event.code === "KeyV" || event.key.toLowerCase() === "v";
      if (!v || !mod || event.altKey || ignored(event.target)) return;
      event.preventDefault();
      void paste();
    };
    const onPaste = (event: ClipboardEvent) => {
      if (ignored(event.target)) return;
      event.preventDefault();
      void paste();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("paste", onPaste);
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    try {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          const { type } = event.payload;
          if (type === "enter" || type === "over") setDragging(true);
          else if (type === "leave") setDragging(false);
          else if (type === "drop") {
            setDragging(false);
            void latestUpload.current(event.payload.paths);
          }
        })
        .then((stop) => {
          if (disposed) stop();
          else unlisten = stop;
        })
        .catch(() => {});
    } catch {
      // Not running inside Tauri, for example in a plain browser preview.
    }
    return () => {
      disposed = true;
      unlisten?.();
      setDragging(false);
    };
  }, [active]);

  async function pickAndUpload(directory: boolean) {
    const picked = await pickPaths({
      folders: directory,
      multiple: true,
      title: directory ? "选择要上传的文件夹" : "选择要上传的文件",
    });
    if (picked.length > 0) void upload(picked);
  }

  async function download(items: RemoteEntry[]) {
    if (items.length === 0) return;
    let remembered: string | undefined;
    try {
      remembered = localStorage.getItem(DOWNLOAD_DIR_KEY) ?? undefined;
    } catch {
      remembered = undefined;
    }
    const [dir] = await pickPaths({ folders: true, multiple: false, title: "选择保存位置", defaultPath: remembered });
    if (!dir) return;
    try {
      localStorage.setItem(DOWNLOAD_DIR_KEY, dir);
    } catch {
      // Remembering the folder is only a convenience.
    }
    try {
      const result = await transferDownload(sessionId, items.map((entry) => entry.path), dir);
      onNotice(
        `已加入 ${result.files} 个下载` + (result.skipped ? `，跳过 ${result.skipped} 个链接或特殊文件` : ""),
      );
    } catch (reason) {
      setError(String(reason));
    }
  }

  function selectOnly(path: string) {
    setSelection({ selected: new Set([path]), anchor: path, focus: path });
  }

  /** Copies the file to today's backup name, asking first when today's backup already exists. */
  async function backup(entry: RemoteEntry, replace = false) {
    const name = backupName(entry.name, new Date());
    if (!replace && entries.some((other) => other.name === name)) {
      setDialog({ kind: "replaceBackup", entry, name });
      return;
    }
    setCopying({ name: entry.name, done: 0, size: entry.size });
    try {
      const target = await sftpCopy(sessionId, entry.path, name, replace, ({ done, size }) =>
        setCopying({ name: entry.name, done, size }),
      );
      selectOnly(target);
      onNotice(`已备份为 ${baseName(target)}`);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setCopying(null);
    }
    refresh();
  }

  /** Renames the backup back to `name`, replacing the file there. Throws so a dialog can show why. */
  async function restore(entry: RemoteEntry, name: string) {
    try {
      selectOnly(await sftpRenameReplacing(sessionId, entry.path, name));
      onNotice(`已还原 ${name}`);
    } finally {
      refresh();
    }
  }

  /** Asks first when restoring would replace a file that is still there. */
  function askRestore(entry: RemoteEntry) {
    const name = restoredName(entry.name);
    if (name === null) return;
    if (entries.some((other) => other.name === name)) setDialog({ kind: "restore", entry, name });
    else restore(entry, name).catch((reason) => setError(String(reason)));
  }

  function openEntry(entry: RemoteEntry) {
    if (isDir(entry)) load(entry.path);
    else onOpenFile(entry.path);
  }

  function goUp() {
    if (path && path !== "/") load(`${path.replace(/\/+$/, "")}/..`);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const mod = event.metaKey || event.ctrlKey;
    const move = (step: number) => {
      const next = moveFocus(selection, order, step, event.shiftKey);
      setSelection(next);
      if (next.focus) virtualizer.scrollToIndex(order.indexOf(next.focus));
    };
    if (event.key === "ArrowDown") move(1);
    else if (event.key === "ArrowUp") move(-1);
    else if (event.key === "Enter" && selected.length === 1) openEntry(selected[0]);
    else if (event.key === "Backspace" && !mod) goUp();
    else if ((event.key === "Delete" || (event.key === "Backspace" && mod)) && selected.length > 0)
      setDialog({ kind: "delete", entries: selected });
    else if (event.key === "F2" && selected.length === 1) setDialog({ kind: "rename", entry: selected[0] });
    else if (event.key === "a" && mod) setSelection(selectAll(order));
    else return;
    event.preventDefault();
  }

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const one = selected.length === 1 ? selected[0] : null;

  return (
    <div className="relative flex h-full flex-col bg-canvas text-sm">
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
        <button type="button" aria-label="上级目录" data-tooltip="上级目录" className={iconButton} onClick={goUp} disabled={!path || path === "/"}>
          <ArrowUp size={15} />
        </button>
        <button type="button" aria-label="刷新" data-tooltip="刷新" className={iconButton} onClick={refresh}>
          <RefreshCw size={15} className={loading || following ? "animate-spin" : ""} />
        </button>
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (typedPath.trim()) load(typedPath.trim());
          }}
        >
          <input
            aria-label="路径"
            className={`${compactInputClass} font-mono`}
            spellCheck={false}
            value={typedPath}
            onChange={(event) => setTypedPath(event.target.value)}
          />
        </form>
        <span className="mx-1 h-5 w-px bg-line" />
        <button type="button" aria-label="新建文件夹" data-tooltip="新建文件夹" className={iconButton} onClick={() => setDialog({ kind: "mkdir" })} disabled={!path}>
          <FolderPlus size={15} />
        </button>
        <button type="button" aria-label="上传文件" data-tooltip="上传文件" className={iconButton} onClick={() => void pickAndUpload(false)} disabled={!path}>
          <Upload size={15} />
        </button>
        <button type="button" aria-label="上传文件夹" data-tooltip="上传文件夹" className={iconButton} onClick={() => void pickAndUpload(true)} disabled={!path}>
          <FolderUp size={15} />
        </button>
        <button type="button" aria-label="下载" data-tooltip="下载所选" className={iconButton} onClick={() => void download(selected)} disabled={selected.length === 0}>
          <Download size={15} />
        </button>
        <button type="button" aria-label="编辑" data-tooltip="在编辑器中打开" className={iconButton} onClick={() => one && !isDir(one) && onOpenFile(one.path)} disabled={!one || isDir(one)}>
          <FilePen size={15} />
        </button>
        <button type="button" aria-label="重命名" data-tooltip="重命名 (F2)" className={iconButton} onClick={() => one && setDialog({ kind: "rename", entry: one })} disabled={!one}>
          <Pencil size={15} />
        </button>
        <button type="button" aria-label="修改权限" data-tooltip="修改权限" className={iconButton} onClick={() => one && setDialog({ kind: "chmod", entry: one })} disabled={!one}>
          <KeyRound size={15} />
        </button>
        <button type="button" aria-label="删除" data-tooltip="删除" className={iconButton} onClick={() => setDialog({ kind: "delete", entries: selected })} disabled={selected.length === 0}>
          <Trash2 size={15} />
        </button>
      </div>

      <div className={`${COLUMNS} shrink-0 border-b border-line px-3 py-1 text-xs text-muted`}>
        <span>名称</span>
        <span className="text-right">大小</span>
        <span>修改时间</span>
        <span>权限</span>
      </div>

      <div
        ref={scroller}
        role="listbox"
        aria-label="远程文件"
        aria-multiselectable
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto outline-none"
        onKeyDown={onKeyDown}
        onClick={(event) => {
          if (event.target === event.currentTarget) setSelection(emptySelection);
        }}
        // Only a file row offers a menu; the blank space around the rows does nothing.
        onContextMenu={(event) => event.preventDefault()}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const entry = entries[item.index];
            const isSelected = selection.selected.has(entry.path);
            return (
              <div
                key={entry.path}
                role="option"
                aria-selected={isSelected}
                className={`${COLUMNS} absolute left-0 right-0 cursor-default select-none items-center px-3 ${
                  isSelected ? "bg-accent/15" : "hover:bg-panel"
                }`}
                style={{ top: item.start, height: ROW_HEIGHT }}
                onClick={(event) =>
                  setSelection((current) =>
                    select(current, order, entry.path, {
                      toggle: event.metaKey || event.ctrlKey,
                      range: event.shiftKey,
                    }),
                  )
                }
                onDoubleClick={() => openEntry(entry)}
                onContextMenu={(event) => {
                  // A row outside the selection becomes the selection, as in Finder and Explorer.
                  const targets = isSelected ? selected : [entry];
                  if (!isSelected) setSelection(select(emptySelection, order, entry.path, { toggle: false, range: false }));
                  setMenu({ x: event.clientX, y: event.clientY, entries: targets });
                }}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <EntryIcon entry={entry} />
                  <span className="truncate" data-tooltip={entry.name} data-tooltip-overflow>
                    {entry.name}
                  </span>
                </span>
                <span className="text-right text-xs tabular-nums text-muted">
                  {isDir(entry) ? "" : formatBytes(entry.size)}
                </span>
                <span className="text-xs tabular-nums text-muted">{formatTime(entry.modified)}</span>
                <span className="font-mono text-xs text-muted">{formatPermissions(entry.permissions)}</span>
              </div>
            );
          })}
        </div>
        {!loading && path !== null && entries.length === 0 && (
          <p className="pt-10 text-center text-muted">空目录，可将文件拖到这里，或复制后按 {isMac ? "⌘V" : "Ctrl+V"} 上传</p>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-line px-3 py-1 text-xs text-muted">
        {error ? (
          <span role="alert" className="truncate text-danger" data-tooltip={error} data-tooltip-overflow>
            {error}
          </span>
        ) : (
          <span>
            {entries.length} 项{selected.length > 0 && `，已选 ${selected.length} 项`}
          </span>
        )}
        {copying && <CopyStatus {...copying} />}
      </div>

      {dragging && (
        <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent/10">
          <p className="rounded-md bg-canvas px-3 py-2 shadow">松开以上传到 {path}</p>
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          items={[
            {
              label: "编辑",
              icon: <FilePen size={14} />,
              disabled: menu.entries.length !== 1 || isDir(menu.entries[0]),
              onSelect: () => onOpenFile(menu.entries[0].path),
            },
            { label: "下载", icon: <Download size={14} />, onSelect: () => void download(menu.entries) },
            {
              label: "重命名",
              icon: <Pencil size={14} />,
              disabled: menu.entries.length !== 1,
              onSelect: () => setDialog({ kind: "rename", entry: menu.entries[0] }),
            },
            {
              label: "备份",
              icon: <CopyPlus size={14} />,
              // One backup at a time, so the status bar can show its progress.
              disabled: menu.entries.length !== 1 || menu.entries[0].kind !== "file" || copying !== null,
              onSelect: () => void backup(menu.entries[0]),
            },
            // Offered only on backups, named as backup() names them.
            ...(menu.entries.length === 1 && menu.entries[0].kind === "file" && restoredName(menu.entries[0].name)
              ? [{ label: "还原", icon: <ArchiveRestore size={14} />, onSelect: () => askRestore(menu.entries[0]) }]
              : []),
          ]}
        />
      )}

      {dialog?.kind === "mkdir" && path && (
        <NameDialog
          title="新建文件夹"
          label="名称"
          confirmLabel="创建"
          onSubmit={async (name) => {
            await sftpMkdir(sessionId, path, name);
            refresh();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "rename" && (
        <NameDialog
          title="重命名"
          label="新名称"
          initial={dialog.entry.name}
          confirmLabel="重命名"
          onSubmit={async (name) => {
            const target = await sftpRename(sessionId, dialog.entry.path, name);
            setSelection({ selected: new Set([target]), anchor: target, focus: target });
            refresh();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "chmod" && (
        <ChmodDialog
          entry={dialog.entry}
          onSubmit={async (mode) => {
            await sftpChmod(sessionId, dialog.entry.path, mode);
            refresh();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          title="删除"
          message={
            dialog.entries.length === 1
              ? `确定删除“${dialog.entries[0].name}”吗？${isDir(dialog.entries[0]) && dialog.entries[0].kind === "dir" ? "文件夹中的所有内容都会被删除，" : ""}此操作无法撤销。`
              : `确定删除选中的 ${dialog.entries.length} 项吗？文件夹中的内容也会一并删除，此操作无法撤销。`
          }
          confirmLabel="删除"
          onConfirm={async () => {
            try {
              await sftpRemove(sessionId, dialog.entries.map((entry) => entry.path));
            } finally {
              refresh();
            }
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "restore" && (
        <ConfirmDialog
          title="还原备份"
          message={`将用“${dialog.entry.name}”替换当前的“${dialog.name}”，备份文件会改回原名。当前的“${dialog.name}”会被覆盖，此操作无法撤销。`}
          confirmLabel="还原"
          onConfirm={() => restore(dialog.entry, dialog.name)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "replaceBackup" && (
        <ConfirmDialog
          title="覆盖今天的备份"
          message={`今天已经备份过，“${dialog.name}”已存在。要用“${dialog.entry.name}”的当前内容覆盖这个备份吗？`}
          confirmLabel="覆盖"
          onConfirm={async () => void backup(dialog.entry, true)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "overwrite" && (
        <ConfirmDialog
          title="覆盖已有文件"
          message={`当前目录已有同名项目：${dialog.names.slice(0, 5).join("、")}${dialog.names.length > 5 ? ` 等 ${dialog.names.length} 项` : ""}。上传会覆盖同名文件，文件夹则会合并。`}
          confirmLabel="覆盖"
          onConfirm={() => upload(dialog.localPaths, true)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
