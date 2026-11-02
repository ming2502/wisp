import { useRef, useState } from "react";
import { Modal } from "./Modal";
import { Field } from "./Field";
import { inputClass, primaryButton, secondaryButton } from "./controls";

interface Props {
  title: string;
  label: string;
  initial?: string;
  confirmLabel: string;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}

/** Asks for one name, keeping the dialog open with the error if saving fails. */
export function NameDialog({ title, label, initial = "", confirmLabel, onSubmit, onClose }: Props) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // Selects the name without its extension, as file managers do.
  function focusName(event: Event) {
    const element = input.current;
    if (!element) return;
    event.preventDefault();
    const dot = element.value.lastIndexOf(".");
    element.focus();
    element.setSelectionRange(0, dot > 0 ? dot : element.value.length);
  }

  return (
    <Modal title={title} open onClose={onClose} onOpenAutoFocus={focusName}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          onSubmit(name.trim())
            .then(onClose)
            .catch((reason) => {
              setError(String(reason));
              setBusy(false);
            });
        }}
      >
        <Field label={label}>
          <input
            ref={input}
            required
            className={inputClass}
            spellCheck={false}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        {error && <p className="break-words text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={secondaryButton} onClick={onClose}>
            取消
          </button>
          <button type="submit" className={primaryButton} disabled={busy || !name.trim()}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
