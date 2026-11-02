import { useState } from "react";
import { groupSave, type Group } from "../../ipc";
import { Modal } from "../../ui/Modal";
import { Field } from "../../ui/Field";
import { inputClass, primaryButton, secondaryButton } from "../../ui/controls";

interface Props {
  group: Group | null;
  onSaved: () => void;
  onClose: () => void;
}

export function GroupEditor({ group, onSaved, onClose }: Props) {
  const [name, setName] = useState(group?.name ?? "");
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal title={group ? "重命名分组" : "新建分组"} open onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          groupSave(group?.id ?? null, name)
            .then(onSaved)
            .catch((reason) => setError(String(reason)));
        }}
      >
        <Field label="名称">
          <input
            autoFocus
            required
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={secondaryButton} onClick={onClose}>
            取消
          </button>
          <button type="submit" className={primaryButton}>
            保存
          </button>
        </div>
      </form>
    </Modal>
  );
}
