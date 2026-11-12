import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { FolderOpen, Info, Palette, SquareTerminal, type LucideIcon } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { Logo } from "../../ui/Logo";
import { Modal } from "../../ui/Modal";
import { Select } from "../../ui/Select";
import { Switch } from "../../ui/Switch";
import { button, compactInputClass } from "../../ui/controls";
import { SCHEME_LABELS } from "../terminal/schemes";
import { FONT_SIZE_RANGE, SCROLLBACK_RANGE, type Appearance, type CursorStyle, type TerminalScheme } from "./settings";
import { useSettings } from "./SettingsContext";
import type { Updater } from "../updates/useUpdater";
import { formatBytes } from "../../lib/format";

const APPEARANCES: [Appearance, string][] = [
  ["system", "跟随系统"],
  ["light", "浅色"],
  ["dark", "深色"],
];

const CURSORS: [CursorStyle, string][] = [
  ["block", "方块"],
  ["bar", "竖线"],
  ["underline", "下划线"],
];

function updateText(updater: Updater) {
  const { status } = updater;
  switch (status.kind) {
    case "idle":
      return "";
    case "checking":
      return "正在检查…";
    case "upToDate":
      return "已是最新版本";
    case "available":
      return "";
    case "installing":
      return `正在下载 ${formatBytes(status.downloaded)}${status.total ? ` / ${formatBytes(status.total)}` : ""}`;
    case "error":
      return status.message;
  }
}

// Controls share one width so they line up down the right edge.
const CONTROL = `${compactInputClass.replace("w-full", "w-40")} shrink-0`;

type Page = "appearance" | "terminal" | "files" | "about";

const PAGES: [Page, string, LucideIcon][] = [
  ["appearance", "外观", Palette],
  ["terminal", "终端", SquareTerminal],
  ["files", "文件", FolderOpen],
  ["about", "关于", Info],
];

// Reopening settings returns to the page last looked at, for as long as the app runs.
let lastPage: Page = "appearance";

/** A card of rows, with an optional heading above it. */
function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      {title && <h3 className="px-1 text-xs font-medium text-muted">{title}</h3>}
      <div className="divide-y divide-line rounded-lg border border-line bg-canvas">{children}</div>
    </section>
  );
}

/** One setting per line: its name, and what it does if that needs saying, beside its control. */
function Row({
  label,
  hint,
  description,
  children,
}: {
  label: string;
  hint?: string;
  description?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex min-h-12 items-center justify-between gap-4 px-3.5 py-2">
      <div className="min-w-0">
        <label htmlFor={id} className="block text-sm">
          {label}
          {hint && <span className="ml-1.5 text-xs text-muted">{hint}</span>}
        </label>
        {description && <p className="mt-0.5 text-xs leading-relaxed text-muted">{description}</p>}
      </div>
      {children(id)}
    </div>
  );
}

interface Props {
  onClose: () => void;
  updater: Updater;
  /** Opens the update window, once a check has found an update. */
  onOpenUpdate: () => void;
}

export function SettingsDialog({ onClose, updater, onOpenUpdate }: Props) {
  const { settings, update } = useSettings();
  const [version, setVersion] = useState("");
  const [page, setPage] = useState<Page>(lastPage);
  const nav = useRef<HTMLDivElement>(null);
  const navId = useId();

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);
  const terminal = (change: Partial<typeof settings.terminal>) =>
    update((current) => ({ ...current, terminal: { ...current.terminal, ...change } }));
  const busy = updater.status.kind === "checking" || updater.status.kind === "installing";

  const open = (next: Page) => {
    lastPage = next;
    setPage(next);
  };

  // Up and down move through the pages, as in any list of tabs.
  const onNavKey = (event: KeyboardEvent) => {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const index = PAGES.findIndex(([value]) => value === page);
    const next = PAGES[(index + step + PAGES.length) % PAGES.length][0];
    open(next);
    nav.current?.querySelector<HTMLElement>(`[data-page="${next}"]`)?.focus();
  };

  const title = PAGES.find(([value]) => value === page)![1];

  return (
    <Modal title="设置" open onClose={onClose} closeButton bare width="max-w-2xl h-[min(34rem,85vh)]">
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-44 shrink-0 flex-col border-r border-line bg-panel px-2.5 pb-3 pt-5">
          <p aria-hidden className="mb-3 px-2.5 text-[15px] font-semibold tracking-tight">
            设置
          </p>
          <div ref={nav} role="tablist" aria-orientation="vertical" aria-label="设置" className="space-y-0.5" onKeyDown={onNavKey}>
            {PAGES.map(([value, label, Icon]) => {
              const selected = value === page;
              return (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  data-page={value}
                  id={`${navId}-${value}`}
                  aria-selected={selected}
                  aria-controls={`${navId}-panel`}
                  tabIndex={selected ? 0 : -1}
                  className={`flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm transition-colors duration-150 ${
                    selected ? "bg-selected font-medium text-ink" : "text-muted hover:bg-hover hover:text-ink"
                  }`}
                  onClick={() => open(value)}
                >
                  <Icon size={15} className="shrink-0" />
                  {label}
                </button>
              );
            })}
          </div>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="shrink-0 px-6 pb-4 pr-12 pt-5 text-[15px] font-semibold tracking-tight">{title}</h2>
          <div
            id={`${navId}-panel`}
            role="tabpanel"
            aria-labelledby={`${navId}-${page}`}
            className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-6"
          >
            {page === "appearance" && (
              <Group>
                <Row label="主题" description="界面和终端的浅色或深色">
                  {(id) => (
                    <div id={id} role="radiogroup" aria-label="主题" className="flex shrink-0 rounded-md bg-panel p-0.5 text-xs">
                      {APPEARANCES.map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          role="radio"
                          aria-checked={settings.appearance === value}
                          className={`h-6 rounded px-2.5 transition-colors duration-150 ${
                            settings.appearance === value ? "bg-raised font-medium text-ink shadow-sm" : "text-muted hover:text-ink"
                          }`}
                          onClick={() => update((current) => ({ ...current, appearance: value }))}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                </Row>
              </Group>
            )}

            {page === "terminal" && (
              <>
                <Group title="显示">
                  <Row label="配色">
                    {(id) => (
                      <Select
                        id={id}
                        size="sm"
                        className="w-40"
                        value={settings.terminal.scheme}
                        options={(Object.keys(SCHEME_LABELS) as TerminalScheme[]).map((scheme) => ({
                          value: scheme,
                          label: SCHEME_LABELS[scheme],
                        }))}
                        onChange={(scheme) => terminal({ scheme })}
                      />
                    )}
                  </Row>
                  <Row label="字号" hint={`${FONT_SIZE_RANGE[0]}–${FONT_SIZE_RANGE[1]}`}>
                    {(id) => (
                      <input
                        id={id}
                        className={CONTROL}
                        type="number"
                        min={FONT_SIZE_RANGE[0]}
                        max={FONT_SIZE_RANGE[1]}
                        value={settings.terminal.fontSize}
                        onChange={(event) => event.target.value && terminal({ fontSize: Number(event.target.value) })}
                      />
                    )}
                  </Row>
                  <Row label="回滚行数" description="向上翻看时保留的输出行数">
                    {(id) => (
                      <input
                        id={id}
                        className={CONTROL}
                        type="number"
                        min={SCROLLBACK_RANGE[0]}
                        max={SCROLLBACK_RANGE[1]}
                        step={1000}
                        value={settings.terminal.scrollback}
                        onChange={(event) => event.target.value && terminal({ scrollback: Number(event.target.value) })}
                      />
                    )}
                  </Row>
                </Group>
                <Group title="光标">
                  <Row label="样式">
                    {(id) => (
                      <Select
                        id={id}
                        size="sm"
                        className="w-40"
                        value={settings.terminal.cursorStyle}
                        options={CURSORS.map(([value, label]) => ({ value, label }))}
                        onChange={(cursorStyle) => terminal({ cursorStyle })}
                      />
                    )}
                  </Row>
                  <Row label="闪烁">
                    {(id) => (
                      <Switch id={id} checked={settings.terminal.cursorBlink} onChange={(cursorBlink) => terminal({ cursorBlink })} />
                    )}
                  </Row>
                </Group>
              </>
            )}

            {page === "files" && (
              <Group>
                <Row label="目录跟随" description="从终端切换到文件时，打开终端当前所在的目录">
                  {(id) => (
                    <Switch
                      id={id}
                      checked={settings.followTerminal}
                      onChange={(followTerminal) => update((current) => ({ ...current, followTerminal }))}
                    />
                  )}
                </Row>
              </Group>
            )}

            {page === "about" && (
              <>
                <div className="flex items-center gap-3.5 rounded-lg border border-line bg-canvas p-3.5">
                  <Logo size={40} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">wisp</p>
                    <p className="text-xs text-muted">
                      <span className="tabular-nums">{version && `v${version}`}</span>
                      {version && " · "}SSH 终端与 SFTP 文件管理
                    </p>
                  </div>
                </div>
                <Group title="更新">
                  <div className="flex min-h-12 items-center justify-between gap-4 px-3.5 py-2">
                    <span
                      className={`min-w-0 truncate text-sm ${updater.status.kind === "error" ? "text-danger" : ""}`}
                      data-tooltip={updateText(updater) || undefined}
                      data-tooltip-overflow
                    >
                      {updater.update ? `新版本 ${updater.update.version} 可用` : updateText(updater) || "检查是否有新版本"}
                    </span>
                    {/* Once an update is found, the button offers it instead of checking again. */}
                    {updater.update ? (
                      <button type="button" className={`${button("primary", "sm")} shrink-0`} onClick={onOpenUpdate}>
                        更新到 {updater.update.version}
                      </button>
                    ) : (
                      <button type="button" className={`${button("secondary", "sm")} shrink-0`} disabled={busy} onClick={updater.checkNow}>
                        检查更新
                      </button>
                    )}
                  </div>
                  <Row label="自动检查更新" description="启动时检查，之后每 6 小时检查一次">
                    {(id) => (
                      <Switch
                        id={id}
                        checked={settings.checkUpdates}
                        onChange={(checkUpdates) => update((current) => ({ ...current, checkUpdates }))}
                      />
                    )}
                  </Row>
                </Group>
              </>
            )}
          </div>
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-line px-6 py-3">
            <span className="text-xs text-muted">修改会立即生效并自动保存</span>
            <button type="button" className={button("primary", "sm")} onClick={onClose}>
              完成
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
