import { CircleAlert } from "lucide-react";
import { openReleasePage } from "../../ipc";
import { formatBytes } from "../../lib/format";
import { Modal } from "../../ui/Modal";
import { button } from "../../ui/controls";
import { Notes } from "./Notes";
import type { Updater } from "./useUpdater";

interface Props {
  updater: Updater;
  /** Editor tabs with unsaved changes, which the restart would lose. */
  hasUnsaved: boolean;
  onClose: () => void;
}

/** Offers the update with its notes, shows the download, and says why it failed if it does. */
export function UpdateDialog({ updater, hasUnsaved, onClose }: Props) {
  const { status, update } = updater;
  if (!update) return null;
  const installing = status.kind === "installing";
  const failed = status.kind === "error" ? status.message : null;

  const footer = installing ? null : (
    <div className="flex items-center justify-between gap-3">
      {failed ? (
        <button
          type="button"
          className="text-xs font-medium text-accent hover:text-accent-hover hover:underline"
          onClick={() => void openReleasePage(update.version).catch(() => {})}
        >
          前往下载页手动安装
        </button>
      ) : (
        <span className="text-xs text-muted">安装后应用会自动重启，所有连接会断开</span>
      )}
      <span className="flex shrink-0 gap-2">
        <button type="button" className={button("secondary", "sm")} onClick={onClose}>
          稍后
        </button>
        <button type="button" className={button("primary", "sm")} onClick={() => void updater.install()}>
          {failed ? "重试" : hasUnsaved ? "不保存，安装并重启" : "安装并重启"}
        </button>
      </span>
    </div>
  );

  return (
    <Modal
      title={`更新到 wisp ${update.version}`}
      open
      onClose={onClose}
      modal={installing}
      closeButton={!installing}
      footer={footer}
    >
      <p className="text-sm text-muted">当前版本 {update.currentVersion}</p>
      {failed && (
        <div role="alert" className="mt-3 flex gap-2 rounded-lg border border-danger/25 bg-danger/8 p-3 text-sm text-danger">
          <CircleAlert size={16} className="mt-0.5 shrink-0" />
          <span>{failed}</span>
        </div>
      )}
      {installing && <Progress downloaded={status.downloaded} total={status.total} />}
      {hasUnsaved && !installing && <p className="mt-3 text-sm text-danger">有文件尚未保存，重启后这些修改会丢失。</p>}
      {update.body && (
        <div className="mt-3 rounded-lg border border-line bg-canvas p-3">
          <p className="mb-2 text-xs font-medium text-muted">更新内容</p>
          <Notes markdown={update.body} />
        </div>
      )}
    </Modal>
  );
}

function Progress({ downloaded, total }: { downloaded: number; total: number | null }) {
  const percent = total ? Math.min(100, Math.round((downloaded / total) * 100)) : null;
  return (
    <div role="status" className="mt-3 space-y-1.5">
      <div className="flex justify-between text-xs text-muted">
        <span>{percent === 100 ? "正在安装，完成后会自动重启…" : "正在下载更新…"}</span>
        <span className="tabular-nums">
          {formatBytes(downloaded)}
          {total ? ` / ${formatBytes(total)}` : ""}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-line">
        <div
          className={`h-full rounded-full bg-accent transition-[width] duration-150 ${percent === null ? "w-1/3 animate-pulse" : ""}`}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
