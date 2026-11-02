import { useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, Pause, Play, RotateCw, X } from "lucide-react";
import { transferCancel, transferPause, transferResume, transfersClear, type TransferInfo } from "../../ipc";
import { formatBytes } from "../../lib/format";
import { iconButton } from "../../ui/controls";

const STATE_LABELS: Record<TransferInfo["state"]["kind"], string> = {
  queued: "排队中",
  running: "传输中",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

function TransferRow({ transfer, speed }: { transfer: TransferInfo; speed?: number }) {
  const { state } = transfer;
  const percent = transfer.size > 0 ? Math.min(100, (transfer.transferred / transfer.size) * 100) : state.kind === "completed" ? 100 : 0;
  const Direction = transfer.direction === "upload" ? ArrowUp : ArrowDown;
  const destination = transfer.direction === "upload" ? transfer.remote : transfer.local;

  return (
    <li className="flex items-center gap-3 px-3 py-1.5">
      <Direction size={14} className="shrink-0 text-muted" aria-label={transfer.direction === "upload" ? "上传" : "下载"} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span className="truncate" title={destination}>
            {transfer.name}
          </span>
          <span className="shrink-0 text-xs tabular-nums text-muted">
            {formatBytes(transfer.transferred)} / {formatBytes(transfer.size)}
            {speed !== undefined && ` · ${formatBytes(speed)}/s`}
          </span>
        </div>
        <div className="mt-1 h-1 overflow-hidden rounded bg-line">
          <div
            className={`h-full ${state.kind === "failed" ? "bg-danger" : "bg-accent"}`}
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className={`mt-0.5 truncate text-xs ${state.kind === "failed" ? "text-danger" : "text-muted"}`} title={state.kind === "failed" ? state.message : undefined}>
          {state.kind === "failed" ? `失败：${state.message}` : STATE_LABELS[state.kind]}
        </p>
      </div>
      <span className="flex shrink-0">
        {(state.kind === "running" || state.kind === "queued") && (
          <button type="button" aria-label="暂停" title="暂停" className={iconButton} onClick={() => void transferPause(transfer.id)}>
            <Pause size={14} />
          </button>
        )}
        {state.kind === "paused" && (
          <button type="button" aria-label="继续" title="继续" className={iconButton} onClick={() => void transferResume(transfer.id)}>
            <Play size={14} />
          </button>
        )}
        {state.kind === "failed" && (
          <button type="button" aria-label="重试" title="重试" className={iconButton} onClick={() => void transferResume(transfer.id)}>
            <RotateCw size={14} />
          </button>
        )}
        {state.kind !== "completed" && state.kind !== "cancelled" && (
          <button type="button" aria-label="取消" title="取消并删除未完成的部分" className={iconButton} onClick={() => void transferCancel(transfer.id)}>
            <X size={14} />
          </button>
        )}
      </span>
    </li>
  );
}

interface Props {
  transfers: TransferInfo[];
  speeds: Map<number, number>;
}

export function TransfersPanel({ transfers, speeds }: Props) {
  const [open, setOpen] = useState(true);
  if (transfers.length === 0) return null;
  const active = transfers.filter((t) => t.state.kind === "running" || t.state.kind === "queued").length;
  const failed = transfers.filter((t) => t.state.kind === "failed").length;
  const finished = transfers.some((t) => t.state.kind === "completed" || t.state.kind === "cancelled");

  return (
    <section aria-label="传输" className="shrink-0 border-t border-line bg-panel">
      <div className="flex items-center justify-between px-3 py-1.5 text-xs">
        <button type="button" className="flex items-center gap-1.5 font-medium" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          传输
          <span className="font-normal text-muted">
            {active > 0 ? `进行中 ${active}` : "全部结束"}
            {failed > 0 && <span className="text-danger">，失败 {failed}</span>}
          </span>
        </button>
        {finished && (
          <button type="button" className="text-muted hover:text-ink" onClick={() => void transfersClear()}>
            清除已结束
          </button>
        )}
      </div>
      {open && (
        <ul className="max-h-56 divide-y divide-line overflow-y-auto border-t border-line bg-canvas">
          {transfers.map((transfer) => (
            <TransferRow key={transfer.id} transfer={transfer} speed={speeds.get(transfer.id)} />
          ))}
        </ul>
      )}
    </section>
  );
}
