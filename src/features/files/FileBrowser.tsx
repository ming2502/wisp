import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  ArrowUp,
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
  sftpChmod,
  sftpList,
  sftpMkdir,
  sftpRemove,
  sftpRename,
  transferDownload,
  transferUpload,
  type RemoteEntry,
} from "../../ipc";
import { formatBytes, formatPermissions, formatTime } from "../../lib/format";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { NameDialog } from "../../ui/NameDialog";
import { iconButton, inputClass } from "../../ui/controls";
import { ChmodDialog } from "./ChmodDialog";
import { emptySelection, moveFocus, prune, select, selectAll, type Selection } from "./selection";

const ROW_HEIGHT = 30;
const COLUMNS = "grid grid-cols-[minmax(0,1fr)_6rem_9.5rem_6.5rem] gap-3";
const DOWNLOAD_DIR_KEY = "sshtool.downloadDir";

type Dialog =
  | { kind: "mkdir" }
  | { kind: "rename"; entry: RemoteEntry }
  | { kind: "chmod"; entry: RemoteEntry }
  | { kind: "delete"; entries: RemoteEntry[] }
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

interface Props {
  sessionId: number;
  active: boolean;
  onNotice: (message: string) => void;
  onOpenFile: (path: string) => void;
}

export function FileBrowser({ sessionId, active, onNotice, onOpenFile }: Props) {
  const [path, setPath] = useState<string | null>(null);
  const [typedPath, setTypedPath] = useState("");
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(emptySelection);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [dragging, setDragging] = useState(false);
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

  // Opens the home directory once, the first time the file view is shown.
  useEffect(() => {
    if (active && path === null && !loading && error === null) load(null);
  }, [active, path, loading, error, load]);

  const refresh = () => load(path);

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
    const picked = await openDialog({ multiple: true, directory, title: directory ? "选择要上传的文件夹" : "选择要上传的文件" });
    if (picked) void upload(Array.isArray(picked) ? picked : [picked]);
  }

  async function download(items: RemoteEntry[]) {
    if (items.length === 0) return;
    let remembered: string | undefined;
    try {
      remembered = localStorage.getItem(DOWNLOAD_DIR_KEY) ?? undefined;
    } catch {
      remembered = undefined;
    }
    const dir = await openDialog({ directory: true, title: "选择保存位置", defaultPath: remembered });
    if (typeof dir !== "string") return;
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
        <button type="button" aria-label="上级目录" title="上级目录" className={iconButton} onClick={goUp} disabled={!path || path === "/"}>
          <ArrowUp size={15} />
        </button>
        <button type="button" aria-label="刷新" title="刷新" className={iconButton} onClick={refresh}>
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
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
            className={`${inputClass} py-1 font-mono text-xs`}
            spellCheck={false}
            value={typedPath}
            onChange={(event) => setTypedPath(event.target.value)}
          />
        </form>
        <span className="mx-1 h-5 w-px bg-line" />
        <button type="button" aria-label="新建文件夹" title="新建文件夹" className={iconButton} onClick={() => setDialog({ kind: "mkdir" })} disabled={!path}>
          <FolderPlus size={15} />
        </button>
        <button type="button" aria-label="上传文件" title="上传文件" className={iconButton} onClick={() => void pickAndUpload(false)} disabled={!path}>
          <Upload size={15} />
        </button>
        <button type="button" aria-label="上传文件夹" title="上传文件夹" className={iconButton} onClick={() => void pickAndUpload(true)} disabled={!path}>
          <FolderUp size={15} />
        </button>
        <button type="button" aria-label="下载" title="下载所选" className={iconButton} onClick={() => void download(selected)} disabled={selected.length === 0}>
          <Download size={15} />
        </button>
        <button type="button" aria-label="编辑" title="在编辑器中打开" className={iconButton} onClick={() => one && !isDir(one) && onOpenFile(one.path)} disabled={!one || isDir(one)}>
          <FilePen size={15} />
        </button>
        <button type="button" aria-label="重命名" title="重命名 (F2)" className={iconButton} onClick={() => one && setDialog({ kind: "rename", entry: one })} disabled={!one}>
          <Pencil size={15} />
        </button>
        <button type="button" aria-label="修改权限" title="修改权限" className={iconButton} onClick={() => one && setDialog({ kind: "chmod", entry: one })} disabled={!one}>
          <KeyRound size={15} />
        </button>
        <button type="button" aria-label="删除" title="删除" className={iconButton} onClick={() => setDialog({ kind: "delete", entries: selected })} disabled={selected.length === 0}>
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
                title={entry.name}
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
              >
                <span className="flex min-w-0 items-center gap-2">
                  <EntryIcon entry={entry} />
                  <span className="truncate">{entry.name}</span>
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
          <p className="pt-10 text-center text-muted">空目录，可将文件拖到这里上传</p>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-line px-3 py-1 text-xs text-muted">
        {error ? (
          <span role="alert" className="truncate text-danger" title={error}>
            {error}
          </span>
        ) : (
          <span>
            {entries.length} 项{selected.length > 0 && `，已选 ${selected.length} 项`}
          </span>
        )}
      </div>

      {dragging && (
        <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent/10">
          <p className="rounded-md bg-canvas px-3 py-2 shadow">松开以上传到 {path}</p>
        </div>
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
