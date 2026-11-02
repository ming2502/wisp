import { useCallback, useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

const AUTO_CHECK_DELAY_MS = 10_000;

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate" }
  | { kind: "available"; update: Update }
  | { kind: "installing"; downloaded: number; total: number | null }
  | { kind: "error"; message: string };

export interface Updater {
  status: UpdateStatus;
  checkNow: () => void;
  install: () => Promise<void>;
}

/** Checks GitHub Releases for a signed update, once in the background and on request. */
export function useUpdater(autoCheck: boolean): Updater {
  const [status, setStatus] = useState<UpdateStatus>({ kind: "idle" });
  const checked = useRef(false);

  const run = useCallback(async (manual: boolean) => {
    checked.current = true;
    if (manual) setStatus({ kind: "checking" });
    try {
      const update = await check();
      setStatus(update ? { kind: "available", update } : manual ? { kind: "upToDate" } : { kind: "idle" });
    } catch (reason) {
      // A failed background check, for example when offline, is not worth interrupting anyone for.
      setStatus(manual ? { kind: "error", message: String(reason) } : { kind: "idle" });
    }
  }, []);

  useEffect(() => {
    if (!autoCheck || checked.current) return;
    const timer = setTimeout(() => void run(false), AUTO_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [autoCheck, run]);

  const install = useCallback(async () => {
    if (status.kind !== "available") return;
    const { update } = status;
    let downloaded = 0;
    let total: number | null = null;
    setStatus({ kind: "installing", downloaded, total });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? null;
        if (event.event === "Progress") downloaded += event.data.chunkLength;
        setStatus({ kind: "installing", downloaded, total });
      });
      await relaunch();
    } catch (reason) {
      setStatus({ kind: "error", message: `更新失败：${reason}` });
    }
  }, [status]);

  return { status, checkNow: () => void run(true), install };
}
