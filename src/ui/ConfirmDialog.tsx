import { useState } from "react";
import { Modal } from "./Modal";
import { dangerButton, secondaryButton } from "./controls";

interface Props {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

export function ConfirmDialog({ title, message, confirmLabel, onConfirm, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } catch (reason) {
      setError(String(reason));
      setBusy(false);
    }
  }

  return (
    <Modal title={title} open onClose={onClose}>
      <p className="text-sm">{message}</p>
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className={secondaryButton} onClick={onClose}>
          取消
        </button>
        <button type="button" className={dangerButton} disabled={busy} onClick={confirm}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
