import { useState, type FormEvent } from "react";
import {
  answerHostKey,
  answerPrompt,
  sshConnect,
  type Auth,
  type ConnectMessage,
  type HostKeyInfo,
  type Prompt,
  type Stage,
} from "../../ipc";

type AuthKind = Auth["kind"];

const AUTH_LABELS: Record<AuthKind, string> = {
  password: "密码",
  key: "私钥",
  agent: "SSH Agent",
  keyboardInteractive: "交互式",
};

const STAGE_LABELS: Record<Stage, string> = {
  connecting: "正在连接…",
  authenticating: "正在认证…",
  ready: "已连接",
};

const inputClass =
  "w-full rounded-md border border-line bg-canvas px-2.5 py-1.5 text-sm outline-none focus:border-accent";
const primaryButton =
  "rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50";
const secondaryButton = "rounded-md border border-line px-3 py-1.5 text-sm";

type Pending =
  | { kind: "hostKey"; promptId: number; info: HostKeyInfo }
  | { kind: "prompt"; promptId: number; prompt: Prompt };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-muted">{label}</span>
      {children}
    </label>
  );
}

function HostKeyDialog({ info, onAnswer }: { info: HostKeyInfo; onAnswer: (trust: boolean) => void }) {
  return (
    <div className="space-y-3 rounded-md border border-line bg-canvas p-3 text-sm" role="alertdialog">
      <p className="font-medium">
        首次连接 {info.host}:{info.port}
      </p>
      {info.otherAlgorithmsKnown && (
        <p className="text-danger">
          此主机已记录过其他类型的密钥，但这次提供的类型没有记录。如果不是你预期的变化，请不要继续。
        </p>
      )}
      <p className="text-muted">请核对服务器指纹后再决定是否信任：</p>
      <p className="break-all font-mono text-xs">
        {info.algorithm}
        <br />
        {info.fingerprint}
      </p>
      <div className="flex justify-end gap-2">
        <button type="button" className={secondaryButton} onClick={() => onAnswer(false)}>
          取消
        </button>
        <button type="button" className={primaryButton} onClick={() => onAnswer(true)}>
          信任并连接
        </button>
      </div>
    </div>
  );
}

function SecretDialog({
  prompt,
  onAnswer,
}: {
  prompt: Prompt;
  onAnswer: (values: string[] | null) => void;
}) {
  const fields =
    prompt.kind === "passphrase"
      ? [{ label: prompt.retry ? "口令不正确，请重试" : "私钥口令", echo: false }]
      : prompt.fields;
  const [values, setValues] = useState(() => fields.map(() => ""));

  return (
    <form
      className="space-y-3 rounded-md border border-line bg-canvas p-3 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        onAnswer(values);
      }}
    >
      {prompt.kind === "passphrase" ? (
        <p className="break-all text-muted">{prompt.path}</p>
      ) : (
        prompt.instructions && <p className="text-muted">{prompt.instructions}</p>
      )}
      {fields.map((field, index) => (
        <Field key={index} label={field.label}>
          <input
            autoFocus={index === 0}
            className={inputClass}
            type={field.echo ? "text" : "password"}
            value={values[index]}
            onChange={(event) =>
              setValues(values.map((value, i) => (i === index ? event.target.value : value)))
            }
          />
        </Field>
      ))}
      <div className="flex justify-end gap-2">
        <button type="button" className={secondaryButton} onClick={() => onAnswer(null)}>
          取消
        </button>
        <button type="submit" className={primaryButton}>
          继续
        </button>
      </div>
    </form>
  );
}

interface Props {
  onConnected: (sessionId: number, title: string) => void;
}

export function ConnectForm({ onConnected }: Props) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [authKind, setAuthKind] = useState<AuthKind>("password");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("~/.ssh/id_ed25519");
  const [stage, setStage] = useState<Stage | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);

  function buildAuth(): Auth {
    switch (authKind) {
      case "password":
        return { kind: "password", password };
      case "key":
        return { kind: "key", path: keyPath };
      case "agent":
        return { kind: "agent" };
      case "keyboardInteractive":
        return { kind: "keyboardInteractive" };
    }
  }

  function onMessage(message: ConnectMessage) {
    if (message.kind === "stage") setStage(message.stage);
    else setPending(message);
  }

  async function connect(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setStage("connecting");
    try {
      const sessionId = await sshConnect(
        { host: host.trim(), port: Number(port), user: user.trim(), auth: buildAuth() },
        onMessage,
      );
      setPassword("");
      onConnected(sessionId, `${user.trim()}@${host.trim()}`);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setStage(null);
      setPending(null);
    }
  }

  const busy = stage !== null;

  return (
    <div className="space-y-4">
      <form className="space-y-3" onSubmit={connect}>
        <Field label="主机">
          <input
            autoFocus
            required
            className={inputClass}
            placeholder="example.com"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={host}
            onChange={(event) => setHost(event.target.value)}
          />
        </Field>
        <div className="grid grid-cols-[1fr_5rem] gap-2">
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
        {authKind === "password" && (
          <Field label="密码">
            <input
              className={inputClass}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
        )}
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
        <button type="submit" className={`${primaryButton} w-full`} disabled={busy}>
          {stage ? STAGE_LABELS[stage] : "连接"}
        </button>
      </form>

      {pending?.kind === "hostKey" && (
        <HostKeyDialog
          info={pending.info}
          onAnswer={(trust) => {
            setPending(null);
            void answerHostKey(pending.promptId, trust);
          }}
        />
      )}
      {pending?.kind === "prompt" && (
        <SecretDialog
          key={pending.promptId}
          prompt={pending.prompt}
          onAnswer={(values) => {
            setPending(null);
            void answerPrompt(pending.promptId, values);
          }}
        />
      )}
      {error && (
        <p role="alert" className="break-words text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
