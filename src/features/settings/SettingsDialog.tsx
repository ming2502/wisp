import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Modal } from "../../ui/Modal";
import { Field } from "../../ui/Field";
import { inputClass, secondaryButton } from "../../ui/controls";
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

  return (
    <Modal title="设置" open onClose={onClose}>
      <div className="space-y-5">
        <section className="space-y-2">
          <h3 className="text-xs font-medium text-muted">外观</h3>
          <div role="radiogroup" aria-label="外观" className="flex rounded-md bg-panel p-0.5 text-sm">
            {APPEARANCES.map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={settings.appearance === value}
                className={`flex-1 rounded px-3 py-1 ${settings.appearance === value ? "bg-canvas shadow-sm" : "text-muted"}`}
                onClick={() => update((current) => ({ ...current, appearance: value }))}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-xs font-medium text-muted">终端</h3>
          <div className="grid grid-cols-2 gap-3">
            <Field label="配色">
              <select
                className={inputClass}
                value={settings.terminal.scheme}
                onChange={(event) => terminal({ scheme: event.target.value as TerminalScheme })}
              >
                {(Object.keys(SCHEME_LABELS) as TerminalScheme[]).map((scheme) => (
                  <option key={scheme} value={scheme}>
                    {SCHEME_LABELS[scheme]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={`字号（${FONT_SIZE_RANGE[0]}–${FONT_SIZE_RANGE[1]}）`}>
              <input
                className={inputClass}
                type="number"
                min={FONT_SIZE_RANGE[0]}
                max={FONT_SIZE_RANGE[1]}
                value={settings.terminal.fontSize}
                onChange={(event) => event.target.value && terminal({ fontSize: Number(event.target.value) })}
              />
            </Field>
            <Field label="光标">
              <select
                className={inputClass}
                value={settings.terminal.cursorStyle}
                onChange={(event) => terminal({ cursorStyle: event.target.value as CursorStyle })}
              >
                {CURSORS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="回滚行数">
              <input
                className={inputClass}
                type="number"
                min={SCROLLBACK_RANGE[0]}
                max={SCROLLBACK_RANGE[1]}
                step={1000}
                value={settings.terminal.scrollback}
                onChange={(event) => event.target.value && terminal({ scrollback: Number(event.target.value) })}
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.terminal.cursorBlink}
              onChange={(event) => terminal({ cursorBlink: event.target.checked })}
            />
            光标闪烁
          </label>
        </section>

        <section className="space-y-2">
          <h3 className="text-xs font-medium text-muted">关于</h3>
          <div className="flex items-center justify-between gap-3 text-sm">
            <span>
              wisp {version}
              <span className={`ml-2 text-xs ${updater.status.kind === "error" ? "text-danger" : "text-muted"}`}>
                {updateText(updater)}
              </span>
            </span>
            <button
              type="button"
              className={`${secondaryButton} shrink-0 py-1 text-xs`}
              disabled={updater.status.kind === "checking" || updater.status.kind === "installing"}
              onClick={updater.checkNow}
            >
              检查更新
            </button>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.checkUpdates}
              onChange={(event) => update((current) => ({ ...current, checkUpdates: event.target.checked }))}
            />
            启动时自动检查更新
          </label>
        </section>
      </div>
      <div className="mt-6 flex items-center justify-between">
        <span className="text-xs text-muted">修改会立即生效并自动保存</span>
        <button type="button" className={secondaryButton} onClick={onClose}>
          完成
        </button>
      </div>
    </Modal>
  );
}
