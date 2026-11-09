import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Modal } from "../../ui/Modal";
import { button } from "../../ui/controls";
import { changelogSection } from "./changelog";
import { Notes } from "./Notes";

const SEEN_VERSION_KEY = "wisp.seenVersion";

/**
 * Shows what changed the first time a new version starts. A fresh install has nothing to compare
 * with, so it only remembers its version.
 */
export function WhatsNew() {
  const [shown, setShown] = useState<{ version: string; notes: string } | null>(null);

  useEffect(() => {
    getVersion()
      .then((version) => {
        let seen: string | null = null;
        try {
          seen = localStorage.getItem(SEEN_VERSION_KEY);
          localStorage.setItem(SEEN_VERSION_KEY, version);
        } catch {
          // Without storage the notice is skipped rather than shown at every start.
          return;
        }
        const notes = changelogSection(version);
        if (seen && seen !== version && notes) setShown({ version, notes });
      })
      .catch(() => {});
  }, []);

  if (!shown) return null;
  const close = () => setShown(null);
  return (
    <Modal
      title={`已更新到 wisp ${shown.version}`}
      open
      onClose={close}
      closeButton
      footer={
        <div className="flex justify-end">
          <button type="button" className={button("primary", "sm")} onClick={close}>
            知道了
          </button>
        </div>
      }
    >
      <p className="mb-3 text-xs font-medium text-muted">本次更新</p>
      <Notes markdown={shown.notes} />
    </Modal>
  );
}
