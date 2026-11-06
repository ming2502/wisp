import { useEffect, useId, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Modal } from "../../ui/Modal";
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
      return `有新版本 ${status.update.version}`;
    case "installing":
      return `正在下载 ${formatBytes(status.downloaded)}${status.total ? ` / ${formatBytes(status.total)}` : ""}`;
    case "error":
      return status.message;
  }
}

// Controls share one width so they line up down the right edge.
const CONTROL = `${compactInputClass.replace("w-full", "w-40")} shrink-0`;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</h3>
      <div className="divide-y divide-line rounded-lg border border-line bg-canvas">{children}</div>
    </section>
  );
}

/** One setting per line: its name on the left, its control on the right. */
function Row({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex min-h-11 items-center justify-between gap-4 px-3 py-1.5">
      <label htmlFor={id} className="min-w-0 whitespace-nowrap text-sm">
        {label}
        {hint && <span className="ml-1.5 text-xs text-muted">{hint}</span>}
      </label>
      {children(id)}
    </div>
  );
}

export function SettingsDialog({ onClose, updater }: { onClose: () => void; updater: Updater }) {
  const { settings, update } = useSettings();
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);
  const terminal = (change: Partial<typeof settings.terminal>) =>
    update((current) => ({ ...current, terminal: { ...current.terminal, ...change } }));
  const busy = updater.status.kind === "checking" || updater.status.kind === "installing";

  return (
    <Modal
      title="设置"
      open
      onClose={onClose}
      closeButton
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted">修改会立即生效并自动保存</span>
          <button type="button" className={button("primary", "sm")} onClick={onClose}>
            完成
          </button>
        </div>
      }
    >
      <div className="space-y-5">
        <Section title="外观">
          <Row label="主题">
            {(id) => (
              <div id={id} role="radiogroup" aria-label="主题" className="flex rounded-md bg-panel p-0.5 text-xs">
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
        </Section>

        <Section title="终端">
          <Row label="配色">
            {(id) => (
              <select
                id={id}
                className={CONTROL}
                value={settings.terminal.scheme}
                onChange={(event) => terminal({ scheme: event.target.value as TerminalScheme })}
              >
                {(Object.keys(SCHEME_LABELS) as TerminalScheme[]).map((scheme) => (
                  <option key={scheme} value={scheme}>
                    {SCHEME_LABELS[scheme]}
                  </option>
                ))}
              </select>
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
          <Row label="光标">
            {(id) => (
              <select
                id={id}
                className={CONTROL}
                value={settings.terminal.cursorStyle}
                onChange={(event) => terminal({ cursorStyle: event.target.value as CursorStyle })}
              >
                {CURSORS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            )}
          </Row>
          <Row label="回滚行数">
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
          <Row label="光标闪烁">
            {(id) => (
              <Switch id={id} checked={settings.terminal.cursorBlink} onChange={(cursorBlink) => terminal({ cursorBlink })} />
            )}
          </Row>
        </Section>

        <Section title="关于">
          <div className="flex min-h-11 items-center justify-between gap-4 px-3 py-1.5 text-sm">
            <span className="min-w-0">
              版本 <span className="tabular-nums">{version && `v${version}`}</span>
            </span>
            <span className="flex min-w-0 items-center gap-3">
              <span
                className={`truncate text-xs ${updater.status.kind === "error" ? "text-danger" : "text-muted"}`}
                data-tooltip={updateText(updater)} data-tooltip-overflow
              >
                {updateText(updater)}
              </span>
              <button
                type="button"
                className="shrink-0 text-xs font-medium text-accent transition-colors duration-150 hover:text-accent-hover hover:underline disabled:pointer-events-none disabled:opacity-50"
                disabled={busy}
                onClick={updater.checkNow}
              >
                检查更新
              </button>
            </span>
          </div>
          <Row label="启动时自动检查更新">
            {(id) => (
              <Switch
                id={id}
                checked={settings.checkUpdates}
                onChange={(checkUpdates) => update((current) => ({ ...current, checkUpdates }))}
              />
            )}
          </Row>
        </Section>
      </div>
    </Modal>
  );
}
