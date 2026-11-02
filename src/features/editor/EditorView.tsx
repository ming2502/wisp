import { useCallback, useEffect, useRef, useState } from "react";
import { Compartment, type Text } from "@codemirror/state";
import { EditorView as CodeMirror } from "@codemirror/view";
import { RotateCcw, Save } from "lucide-react";
import { asEditFailure, editorOpen, editorSave, type EditFailure, type FileVersion, type TextFile } from "../../ipc";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Modal } from "../../ui/Modal";
import { dangerButton, primaryButton, secondaryButton } from "../../ui/controls";
import { DiffDialog } from "./DiffDialog";
import { useSettings } from "../settings/SettingsContext";
import { editorState, languageFor, themeFor } from "./codemirror";

type Dialog =
  | { kind: "conflict"; current: FileVersion }
  | { kind: "diff"; server: string }
  | { kind: "direct"; reason: string; overwriteChanges: boolean }
  | { kind: "reload" };

interface Props {
  sessionId: number;
  path: string;
  connected: boolean;
  visible: boolean;
  onDirtyChange: (dirty: boolean) => void;
}

function Badge({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "danger" }) {
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[11px] ${tone === "danger" ? "border-danger text-danger" : "border-line text-muted"}`}>
      {children}
    </span>
  );
}

export function EditorView({ sessionId, path, connected, visible, onDirtyChange }: Props) {
  const { dark } = useSettings();
  const theme = useRef(new Compartment());
  // A reconnect changes the session but must not reload the file and lose the edits.
  const session = useRef(sessionId);
  session.current = sessionId;
  const darkNow = useRef(dark);
  darkNow.current = dark;
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<CodeMirror | null>(null);
  const baseline = useRef<Text | null>(null);
  const saveRef = useRef<() => void>(() => {});
  const [file, setFile] = useState<TextFile | null>(null);
  const [loadError, setLoadError] = useState<EditFailure | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [generation, setGeneration] = useState(0);
  const dirtyRef = useRef(onDirtyChange);
  dirtyRef.current = onDirtyChange;

  useEffect(() => {
    dirtyRef.current(dirty);
  }, [dirty]);

  // Loads the file and builds the editor. `generation` changes to reload from the server.
  useEffect(() => {
    let disposed = false;
    setLoadError(null);
    editorOpen(session.current, path)
      .then(async (opened) => {
        if (disposed) return;
        const language = new Compartment();
        const state = editorState({
          doc: opened.content,
          dark: darkNow.current,
          readOnly: opened.readOnly,
          theme: theme.current,
          language,
          onSave: () => saveRef.current(),
          onChange: (doc) => setDirty(baseline.current !== null && !doc.eq(baseline.current)),
        });
        view.current?.destroy();
        const editor = new CodeMirror({ state, parent: host.current! });
        view.current = editor;
        baseline.current = state.doc;
        setFile(opened);
        setDirty(false);
        setSaveError(null);
        editor.focus();
        const name = opened.path.split("/").pop() ?? "";
        const support = await languageFor(name);
        if (!disposed) editor.dispatch({ effects: language.reconfigure(support) });
      })
      .catch((reason) => {
        if (!disposed) setLoadError(asEditFailure(reason));
      });
    return () => {
      disposed = true;
    };
  }, [path, generation]);

  useEffect(() => {
    view.current?.dispatch({ effects: theme.current.reconfigure(themeFor(dark)) });
  }, [dark]);

  useEffect(() => () => view.current?.destroy(), []);

  useEffect(() => {
    if (visible) view.current?.focus();
  }, [visible]);

  const save = useCallback(
    async (options: { overwriteChanges?: boolean; direct?: boolean } = {}) => {
      const editor = view.current;
      if (!file || !editor || file.readOnly || saving || !connected) return;
      setSaving(true);
      setSaveError(null);
      const doc = editor.state.doc;
      try {
        const version = await editorSave(session.current, file.path, {
          content: doc.toString(),
          format: file.format,
          expected: file.version,
          overwriteChanges: options.overwriteChanges ?? false,
          direct: options.direct ?? false,
        });
        baseline.current = doc;
        setFile({ ...file, version, mixedLineEndings: false });
        setDirty(!editor.state.doc.eq(doc));
        setSavedAt(new Date());
      } catch (reason) {
        const failure = asEditFailure(reason);
        if (failure.kind === "conflict") setDialog({ kind: "conflict", current: failure.current });
        else if (failure.kind === "atomicUnavailable")
          setDialog({ kind: "direct", reason: failure.reason, overwriteChanges: options.overwriteChanges ?? false });
        else setSaveError(failure.message);
      } finally {
        setSaving(false);
      }
    },
    [connected, file, saving],
  );
  saveRef.current = () => void save();

  async function showDiff() {
    try {
      const server = await editorOpen(session.current, path);
      setDialog({ kind: "diff", server: server.content });
    } catch (reason) {
      setSaveError(asEditFailure(reason).message);
      setDialog(null);
    }
  }

  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm">
        <p className="text-danger">{loadError.message}</p>
        <p className="text-muted">{path}</p>
        {loadError.kind === "failed" && connected && (
          <button type="button" className={secondaryButton} onClick={() => setGeneration(generation + 1)}>
            重试
          </button>
        )}
        {(loadError.kind === "binary" || loadError.kind === "tooLarge") && (
          <p className="text-muted">可以在文件视图中下载后用本地程序打开。</p>
        )}
      </div>
    );
  }

  const status = !connected
    ? "连接已断开，修改仍保留，但暂时无法保存"
    : saveError
      ? saveError
      : saving
        ? "正在保存…"
        : dirty
          ? "有未保存的修改"
          : savedAt
            ? `已于 ${savedAt.toLocaleTimeString()} 保存`
            : "";

  return (
    <div className="flex h-full flex-col bg-canvas">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5 text-xs">
        <span className="min-w-0 flex-1 truncate font-mono text-muted" title={file?.path ?? path}>
          {file?.path ?? path}
        </span>
        {file?.readOnly && <Badge tone="danger">非 UTF-8，只读</Badge>}
        {file?.mixedLineEndings && <Badge>换行符混用，保存时统一为 {file.format.lineEnding === "crlf" ? "CRLF" : "LF"}</Badge>}
        {file && <Badge>{file.format.lineEnding === "crlf" ? "CRLF" : "LF"}</Badge>}
        {file?.format.bom && <Badge>BOM</Badge>}
        <span className={`truncate ${saveError || !connected ? "text-danger" : "text-muted"}`} title={status}>
          {status}
        </span>
        <button
          type="button"
          aria-label="从服务器重新加载"
          title="从服务器重新加载"
          className="rounded p-1 text-muted hover:bg-line hover:text-ink disabled:opacity-40"
          disabled={!connected || !file}
          onClick={() => (dirty ? setDialog({ kind: "reload" }) : setGeneration(generation + 1))}
        >
          <RotateCcw size={14} />
        </button>
        <button
          type="button"
          className={`${primaryButton} flex items-center gap-1 py-1 text-xs`}
          disabled={!file || file.readOnly || !dirty || saving || !connected}
          onClick={() => void save()}
          title="保存 (⌘S / Ctrl+S)"
        >
          <Save size={13} />
          保存
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={host} className="h-full overflow-hidden" />
        {!file && <p className="absolute inset-0 flex items-center justify-center text-sm text-muted">正在打开…</p>}
      </div>

      {dialog?.kind === "conflict" && (
        <Modal title="文件已在服务器上被修改" open onClose={() => setDialog(null)}>
          <p className="text-sm">打开之后，服务器上的这个文件被其他人或程序修改过。直接保存会覆盖那些修改。</p>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button type="button" className={secondaryButton} onClick={() => setDialog(null)}>
              取消
            </button>
            <button type="button" className={secondaryButton} onClick={() => void showDiff()}>
              查看差异
            </button>
            <button
              type="button"
              className={secondaryButton}
              onClick={() => {
                setDialog(null);
                setGeneration(generation + 1);
              }}
            >
              放弃我的修改并重新加载
            </button>
            <button
              type="button"
              className={dangerButton}
              onClick={() => {
                setDialog(null);
                void save({ overwriteChanges: true });
              }}
            >
              覆盖保存
            </button>
          </div>
        </Modal>
      )}
      {dialog?.kind === "diff" && (
        <DiffDialog
          server={dialog.server}
          mine={view.current?.state.doc.toString() ?? ""}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "direct" && (
        <ConfirmDialog
          title="直接覆盖写入？"
          message={`${dialog.reason}。可以改为直接写入原文件，但如果写入途中连接中断，文件可能只写了一部分。`}
          confirmLabel="直接写入"
          onConfirm={() => save({ overwriteChanges: dialog.overwriteChanges, direct: true })}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "reload" && (
        <ConfirmDialog
          title="重新加载"
          message="重新加载会丢弃尚未保存的修改。"
          confirmLabel="丢弃并重新加载"
          onConfirm={async () => setGeneration(generation + 1)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
