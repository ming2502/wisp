import { useEffect, useState } from "react";
import { sshConfigImport, sshConfigPreview, type Host, type ImportPreview } from "../../ipc";
import { Modal } from "../../ui/Modal";
import { primaryButton, secondaryButton } from "../../ui/controls";
import { defaultSelection, isSameTarget } from "./importSelection";

interface Props {
  hosts: Host[];
  onImported: () => void;
  onClose: () => void;
}

export function ImportDialog({ hosts, onImported, onClose }: Props) {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [selected, setSelected] = useState<boolean[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    sshConfigPreview()
      .then((result) => {
        setPreview(result);
        setSelected(defaultSelection(result.candidates, hosts));
      })
      .catch((reason) => setError(String(reason)));
    // Only the hosts present when the dialog opened decide the initial selection.
  }, []);

  async function importSelected() {
    if (!preview) return;
    setBusy(true);
    try {
      const failed = await sshConfigImport(preview.candidates.filter((_, index) => selected[index]));
      if (failed > 0) {
        setError(`有 ${failed} 项无法导入，其余已导入`);
        setBusy(false);
        onImported();
        return;
      }
      onImported();
      onClose();
    } catch (reason) {
      setError(String(reason));
      setBusy(false);
    }
  }

  const count = selected.filter(Boolean).length;

  return (
    <Modal title="从 SSH 配置导入" open onClose={onClose} width="max-w-lg">
      <p className="mb-3 text-xs text-muted">读取 ~/.ssh/config，只读，不会修改该文件。</p>
      {!preview && !error && <p className="text-sm text-muted">正在读取…</p>}
      {preview && preview.candidates.length === 0 && (
        <p className="text-sm text-muted">没有找到可导入的主机。</p>
      )}
      {preview && preview.candidates.length > 0 && (
        <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-md border border-line">
          {preview.candidates.map((candidate, index) => {
            const exists = hosts.some((host) => isSameTarget(candidate, host));
            return (
              <li key={candidate.name}>
                <label className="flex items-start gap-3 px-3 py-2 text-sm hover:bg-panel">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selected[index] ?? false}
                    onChange={(event) =>
                      setSelected(selected.map((value, i) => (i === index ? event.target.checked : value)))
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{candidate.name}</span>
                    <span className="block truncate text-xs text-muted">
                      {candidate.user}@{candidate.host}:{candidate.port}
                      {candidate.auth.kind === "key" ? ` · ${candidate.auth.path}` : " · 密码"}
                    </span>
                    {candidate.proxyJump && (
                      <span className="block text-xs text-danger">
                        需要跳板机 {candidate.proxyJump}，暂不支持，导入后可能无法连接
                      </span>
                    )}
                    {exists && <span className="block text-xs text-muted">已存在相同的主机</span>}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {preview !== null && preview.skippedDirectives > 0 && (
        <p className="mt-3 text-xs text-muted">
          已跳过 {preview.skippedDirectives} 处 Include 或 Match 指令，其中的设置没有读取。
        </p>
      )}
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className={secondaryButton} onClick={onClose}>
          取消
        </button>
        <button type="button" className={primaryButton} disabled={busy || count === 0} onClick={importSelected}>
          导入 {count} 项
        </button>
      </div>
    </Modal>
  );
}
