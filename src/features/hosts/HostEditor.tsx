import { useState, type FormEvent } from "react";
import { hostSave, type Group, type Host, type HostAuth, type SecretChange } from "../../ipc";
import { Modal } from "../../ui/Modal";
import { Field } from "../../ui/Field";
import { inputClass, primaryButton, secondaryButton } from "../../ui/controls";

type AuthKind = HostAuth["kind"];

const AUTH_LABELS: Record<AuthKind, string> = {
  password: "密码",
  key: "私钥",
  agent: "SSH Agent",
  keyboardInteractive: "交互式（如 2FA）",
};

const DEFAULT_KEY = "~/.ssh/id_ed25519";

interface Props {
  host: Host | null;
  groups: Group[];
  onSaved: (host: Host, connect: boolean) => void;
  onClose: () => void;
}

export function HostEditor({ host, groups, onSaved, onClose }: Props) {
  const [name, setName] = useState(host?.name ?? "");
  const [address, setAddress] = useState(host?.host ?? "");
  const [port, setPort] = useState(String(host?.port ?? 22));
  const [user, setUser] = useState(host?.user ?? "");
  const [groupId, setGroupId] = useState(host?.groupId ?? "");
  const [authKind, setAuthKind] = useState<AuthKind>(host?.auth.kind ?? "password");
  const [keyPath, setKeyPath] = useState(host?.auth.kind === "key" ? host.auth.path : DEFAULT_KEY);
  const [secret, setSecret] = useState("");
  const [clearSecret, setClearSecret] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const usesSecret = authKind === "password" || authKind === "key";
  const authUnchanged =
    host !== null &&
    host.auth.kind === authKind &&
    (authKind !== "key" || (host.auth.kind === "key" && host.auth.path === keyPath));
  const hasSavedSecret = host?.savedSecret === true && authUnchanged;
  const secretLabel = authKind === "password" ? "密码" : "私钥口令";

  function buildAuth(): HostAuth {
    return authKind === "key" ? { kind: "key", path: keyPath.trim() } : { kind: authKind };
  }

  function secretChange(): SecretChange {
    if (secret) return { kind: "set", value: secret };
    return clearSecret ? { kind: "clear" } : { kind: "keep" };
  }

  async function save(connect: boolean) {
    setBusy(true);
    setError(null);
    try {
      const saved = await hostSave(
        {
          id: host?.id ?? null,
          name,
          host: address,
          port: Number(port),
          user,
          groupId: groupId || null,
          auth: buildAuth(),
        },
        secretChange(),
      );
      setSecret("");
      onSaved(saved, connect);
    } catch (reason) {
      setError(String(reason));
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void save(true);
  }

  return (
    <Modal title={host ? "编辑主机" : "新建主机"} open onClose={onClose}>
      <form className="space-y-3" onSubmit={submit}>
        <Field label="名称">
          <input
            className={inputClass}
            placeholder="留空则使用 用户名@主机"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <div className="grid grid-cols-[1fr_5.5rem] gap-2">
          <Field label="主机">
            <input
              autoFocus
              required
              className={inputClass}
              placeholder="example.com"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
          </Field>
          <Field label="端口">
            <input
              required
              className={inputClass}
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(event) => setPort(event.target.value)}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="用户名">
            <input
              required
              className={inputClass}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              value={user}
              onChange={(event) => setUser(event.target.value)}
            />
          </Field>
          <Field label="分组">
            <select className={inputClass} value={groupId} onChange={(event) => setGroupId(event.target.value)}>
              <option value="">无分组</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="认证方式">
          <select
            className={inputClass}
            value={authKind}
            onChange={(event) => setAuthKind(event.target.value as AuthKind)}
          >
            {(Object.keys(AUTH_LABELS) as AuthKind[]).map((kind) => (
              <option key={kind} value={kind}>
                {AUTH_LABELS[kind]}
              </option>
            ))}
          </select>
        </Field>
        {authKind === "key" && (
          <Field label="私钥路径">
            <input
              required
              className={inputClass}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              value={keyPath}
              onChange={(event) => setKeyPath(event.target.value)}
            />
          </Field>
        )}
        {usesSecret && (
          <Field
            label={`${secretLabel}（可选）`}
            hint={
              hasSavedSecret
                ? "已保存在系统钥匙串中，留空则保持不变"
                : `填写后保存在系统钥匙串中；留空则每次连接时询问`
            }
          >
            <input
              className={inputClass}
              type="password"
              autoComplete="off"
              disabled={clearSecret}
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
          </Field>
        )}
        {usesSecret && hasSavedSecret && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={clearSecret}
              onChange={(event) => {
                setClearSecret(event.target.checked);
                setSecret("");
              }}
            />
            清除已保存的{secretLabel}
          </label>
        )}
        {error && (
          <p role="alert" className="break-words text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className={secondaryButton} onClick={onClose}>
            取消
          </button>
          <button type="button" className={secondaryButton} disabled={busy} onClick={() => save(false)}>
            保存
          </button>
          <button type="submit" className={primaryButton} disabled={busy}>
            保存并连接
          </button>
        </div>
      </form>
    </Modal>
  );
}
