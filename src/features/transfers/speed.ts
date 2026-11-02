import type { TransferInfo } from "../../ipc";

const WINDOW_MS = 3000;

/** Bytes per second for each running transfer, averaged over the last few seconds. */
export function createSpeedTracker() {
  const samples = new Map<number, { at: number; bytes: number }[]>();

  return (list: TransferInfo[], now: number): Map<number, number> => {
    const speeds = new Map<number, number>();
    const live = new Set<number>();
    for (const transfer of list) {
      if (transfer.state.kind !== "running") continue;
      live.add(transfer.id);
      const history = samples.get(transfer.id) ?? [];
      history.push({ at: now, bytes: transfer.transferred });
      while (history.length > 1 && now - history[0].at > WINDOW_MS) history.shift();
      samples.set(transfer.id, history);
      const first = history[0];
      const elapsed = (now - first.at) / 1000;
      if (elapsed > 0) speeds.set(transfer.id, Math.max(0, (transfer.transferred - first.bytes) / elapsed));
    }
    for (const id of samples.keys()) if (!live.has(id)) samples.delete(id);
    return speeds;
  };
}
