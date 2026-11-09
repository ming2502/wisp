import { useCallback, useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { describeUpdateError } from "./errors";

const AUTO_CHECK_DELAY_MS = 10_000;
/** While the app stays open it checks again this often, so a long session still hears about updates. */
const RECHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** A failed background check, for example while offline, is tried again after this long. */
const RETRY_FAILED_CHECK_MS = 5 * 60 * 1000;
/** Waits before the second and third attempt of a request; GitHub's downloads fail now and then. */
const RETRY_DELAYS_MS = [2_000, 5_000];

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate" }
  | { kind: "available"; update: Update }
  | { kind: "installing"; update: Update; downloaded: number; total: number | null }
  /** With `update` when installing it failed, so that it can be tried again. */
  | { kind: "error"; message: string; update?: Update };

export interface Updater {
  status: UpdateStatus;
  /** The update on offer, also while installing it or after installing it failed. */
  update: Update | null;
  checkNow: () => void;
  install: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetries<T>(attempt: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (reason) {
      if (i >= RETRY_DELAYS_MS.length) throw reason;
      await sleep(RETRY_DELAYS_MS[i]);
    }
  }
}

/** Checks GitHub Releases for a signed update, in the background and on request. */
export function useUpdater(autoCheck: boolean): Updater {
  const [status, setStatus] = useState<UpdateStatus>({ kind: "idle" });
  const busy = useRef(false);

  const run = useCallback(async (manual: boolean) => {
    if (busy.current) return false;
    busy.current = true;
    if (manual) setStatus({ kind: "checking" });
    try {
      const update = await withRetries(() => check());
      setStatus((current) => {
        // A check while an update is being installed must not interrupt it.
        if (current.kind === "installing") return current;
        if (update) return { kind: "available", update };
        return manual ? { kind: "upToDate" } : { kind: "idle" };
      });
      return true;
    } catch (reason) {
      // A failed background check is not worth interrupting anyone for; it is tried again later.
      if (manual) setStatus({ kind: "error", message: describeUpdateError(reason, "check") });
      return false;
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (!autoCheck) return;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const schedule = (delay: number) => {
      timer = setTimeout(async () => {
        const ok = await run(false);
        if (!stopped) schedule(ok ? RECHECK_EVERY_MS : RETRY_FAILED_CHECK_MS);
      }, delay);
    };
    schedule(AUTO_CHECK_DELAY_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [autoCheck, run]);

  const update =
    status.kind === "available" || status.kind === "installing"
      ? status.update
      : status.kind === "error"
        ? (status.update ?? null)
        : null;

  const install = useCallback(async () => {
    if (!update) return;
    let downloaded = 0;
    let total: number | null = null;
    setStatus({ kind: "installing", update, downloaded, total });
    try {
      await withRetries(() => {
        // Each attempt downloads from the start.
        downloaded = 0;
        return update.download((event) => {
          if (event.event === "Started") total = event.data.contentLength ?? null;
          if (event.event === "Progress") downloaded += event.data.chunkLength;
          setStatus({ kind: "installing", update, downloaded, total });
        });
      });
    } catch (reason) {
      setStatus({ kind: "error", message: describeUpdateError(reason, "download"), update });
      return;
    }
    try {
      // On Windows this starts the installer and quits the app.
      await update.install();
      await relaunch();
    } catch (reason) {
      setStatus({ kind: "error", message: describeUpdateError(reason, "install"), update });
    }
  }, [update]);

  return { status, update, checkNow: () => void run(true), install };
}
