import { useState } from "react";
import { Download, X } from "lucide-react";
import { button, iconButton } from "../../ui/controls";
import { changelogBlocks } from "./changelog";
import type { Updater } from "./useUpdater";

/** How many of the update's changes the notice lists before "查看更新". */
const SUMMARY_ITEMS = 3;

/**
 * A card in the corner when a background check finds an update, with the first few changes. It
 * stays away for that version once dismissed; the sidebar still offers the update.
 */
export function UpdateNotice({ updater, onOpen }: { updater: Updater; onOpen: () => void }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const { status } = updater;
  if (status.kind !== "available" || status.found !== "background" || dismissed === status.update.version) {
    return null;
  }
  const { update } = status;
  const items = changelogBlocks(update.body ?? "")
    .filter((block) => block.kind === "item")
    .map((block) => block.text.replace(/`/g, "").replace(/\*\*/g, ""));

  return (
    <div
      role="status"
      className="fixed bottom-4 right-4 z-30 w-80 rounded-xl border border-line-strong bg-raised p-4 shadow-overlay"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
          <Download size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">wisp {update.version} 可以更新了</p>
          <p className="text-xs text-muted">当前版本 {update.currentVersion}</p>
        </div>
        <button
          type="button"
          aria-label="关闭"
          className={`${iconButton} -mr-1.5 -mt-1.5`}
          onClick={() => setDismissed(update.version)}
        >
          <X size={14} />
        </button>
      </div>
      {items.length > 0 && (
        <ul className="mt-3 list-disc space-y-1 pl-4 text-xs leading-5 text-muted marker:text-muted">
          {items.slice(0, SUMMARY_ITEMS).map((item) => (
            <li key={item}>
              {/* Clamped inside the item, since clamping the item itself hides its bullet. */}
              <span className="line-clamp-2">{item}</span>
            </li>
          ))}
          {items.length > SUMMARY_ITEMS && <li className="list-none -ml-4">等 {items.length} 项改动</li>}
        </ul>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className={button("secondary", "sm")} onClick={() => setDismissed(update.version)}>
          稍后
        </button>
        <button
          type="button"
          className={button("primary", "sm")}
          onClick={() => {
            setDismissed(update.version);
            onOpen();
          }}
        >
          查看更新
        </button>
      </div>
    </div>
  );
}
