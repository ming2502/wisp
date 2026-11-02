import { useState } from "react";
import type { RemoteEntry } from "../../ipc";
import { Modal } from "../../ui/Modal";
import { Field } from "../../ui/Field";
import { inputClass, primaryButton, secondaryButton } from "../../ui/controls";
import { formatOctal, formatPermissions, parseOctal } from "../../lib/format";

const WHO = ["所有者", "用户组", "其他人"];
const WHAT = ["读", "写", "执行"];

interface Props {
  entry: RemoteEntry;
  onSubmit: (mode: number) => Promise<void>;
  onClose: () => void;
}

export function ChmodDialog({ entry, onSubmit, onClose }: Props) {
  const [text, setText] = useState(formatOctal(entry.permissions ?? 0o644));
  const [error, setError] = useState<string | null>(null);
  const mode = parseOctal(text);

  function toggle(bit: number) {
    if (mode !== null) setText(formatOctal(mode ^ bit));
  }

  return (
    <Modal title={`修改权限：${entry.name}`} open onClose={onClose} width="max-w-sm">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (mode === null) return;
          onSubmit(mode)
            .then(onClose)
            .catch((reason) => setError(String(reason)));
        }}
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted">
              <th />
              {WHAT.map((label) => (
                <th key={label} className="pb-1 font-normal">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {WHO.map((who, row) => (
              <tr key={who}>
                <td className="py-1 pr-2 text-muted">{who}</td>
                {WHAT.map((what, column) => {
                  const bit = 1 << (8 - (row * 3 + column));
                  return (
                    <td key={what} className="text-center">
                      <input
                        type="checkbox"
                        aria-label={`${who}${what}`}
                        disabled={mode === null}
                        checked={mode !== null && (mode & bit) !== 0}
                        onChange={() => toggle(bit)}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <Field label="八进制" hint={mode === null ? "请输入 3 到 4 位八进制数字，如 644" : formatPermissions(mode)}>
          <input
            className={`${inputClass} font-mono`}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </Field>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={secondaryButton} onClick={onClose}>
            取消
          </button>
          <button type="submit" className={primaryButton} disabled={mode === null}>
            应用
          </button>
        </div>
      </form>
    </Modal>
  );
}
