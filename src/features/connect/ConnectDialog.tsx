import { useEffect, useRef, useState } from "react";
import {
  answerHostKey,
  answerPrompt,
  sshConnect,
  sshDisconnect,
  type ConnectMessage,
  type Host,
  type HostKeyInfo,
  type Prompt,
  type Stage,
} from "../../ipc";
import { Modal } from "../../ui/Modal";
import { Field } from "../../ui/Field";
import { inputClass, primaryButton, secondaryButton } from "../../ui/controls";

const STAGE_LABELS: Record<Stage, string> = {
  connecting: "正在连接…",
  authenticating: "正在认证…",
  ready: "已连接",
};

type Pending =
  | { kind: "hostKey"; promptId: number; info: HostKeyInfo }
  | { kind: "prompt"; promptId: number; prompt: Prompt };

function decline(promptId: number, kind: Pending["kind"]) {
  if (kind === "hostKey") void answerHostKey(promptId, false);
  else void answerPrompt(promptId, null);
}

function HostKeyPrompt({ info, onAnswer }: { info: HostKeyInfo; onAnswer: (trust: boolean) => void }) {
  return (
    <div className="space-y-3 text-sm" role="alert">
      <p className="font-medium">
        首次连接 {info.host}:{info.port}
      </p>
      {info.otherAlgorithmsKnown && (
        <p className="text-danger">
          此主机已记录过其他类型的密钥，但这次提供的类型没有记录。如果不是你预期的变化，请不要继续。
        </p>
      )}
      <p className="text-muted">请核对服务器指纹后再决定是否信任：</p>
      <p className="break-all rounded-md bg-panel p-2 font-mono text-xs">
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

function promptFields(prompt: Prompt) {
  switch (prompt.kind) {
    case "password":
      return [{ label: prompt.retry ? "密码不正确，请重试" : "密码", echo: false }];
    case "passphrase":
      return [{ label: prompt.retry ? "口令不正确，请重试" : "私钥口令", echo: false }];
    case "keyboardInteractive":
      return prompt.fields;
  }
}

function SecretPrompt({ prompt, onAnswer }: { prompt: Prompt; onAnswer: (values: string[] | null) => void }) {
  const fields = promptFields(prompt);
  const [values, setValues] = useState(() => fields.map(() => ""));

  return (
    <form
      className="space-y-3 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        onAnswer(values);
      }}
    >
      {prompt.kind === "passphrase" && <p className="break-all text-muted">{prompt.path}</p>}
      {prompt.kind === "keyboardInteractive" && prompt.instructions && (
        <p className="text-muted">{prompt.instructions}</p>
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
  host: Host;
  onConnected: (sessionId: number) => void;
  onClose: () => void;
}

export function ConnectDialog({ host, onConnected, onClose }: Props) {
  const [attempt, setAttempt] = useState(0);
  const [stage, setStage] = useState<Stage>("connecting");
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closed = useRef(false);
  /** Prompts of the current attempt that still wait for an answer, by id. */
  const unanswered = useRef(new Map<number, Pending["kind"]>());
  const callbacks = useRef({ onConnected, onClose });
  callbacks.current = { onConnected, onClose };

  useEffect(() => {
    let stale = false;
    const open = new Map<number, Pending["kind"]>();
    unanswered.current = open;
    const onMessage = (message: ConnectMessage) => {
      if (message.kind === "stage") {
        if (!stale) setStage(message.stage);
        return;
      }
      // An abandoned attempt would otherwise wait for this answer forever.
      if (stale) decline(message.promptId, message.kind);
      else {
        open.set(message.promptId, message.kind);
        setPending(message);
      }
    };
    setError(null);
    setPending(null);
    setStage("connecting");
    sshConnect(host.id, onMessage)
      .then((sessionId) => {
        // The dialog was dismissed while connecting, so nobody wants this session any more.
        if (stale || closed.current) void sshDisconnect(sessionId);
        else callbacks.current.onConnected(sessionId);
      })
      .catch((reason) => {
        if (!stale) {
          setPending(null);
          setError(String(reason));
        }
      });
    return () => {
      stale = true;
      open.forEach((kind, promptId) => decline(promptId, kind));
      open.clear();
    };
  }, [host.id, attempt]);

  function answered(promptId: number) {
    unanswered.current.delete(promptId);
    setPending(null);
  }

  function close() {
    closed.current = true;
    unanswered.current.forEach((kind, promptId) => decline(promptId, kind));
    unanswered.current.clear();
    callbacks.current.onClose();
  }

  return (
    <Modal title={`连接 ${host.name}`} open onClose={close} modal={pending !== null}>
      <p className="mb-4 truncate text-xs text-muted">
        {host.user}@{host.host}:{host.port}
      </p>
      {error ? (
        <div className="space-y-4">
          <p role="alert" className="break-words text-sm text-danger">
            {error}
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" className={secondaryButton} onClick={close}>
              关闭
            </button>
            <button type="button" className={primaryButton} onClick={() => setAttempt(attempt + 1)}>
              重试
            </button>
          </div>
        </div>
      ) : pending?.kind === "hostKey" ? (
        <HostKeyPrompt
          info={pending.info}
          onAnswer={(trust) => {
            answered(pending.promptId);
            void answerHostKey(pending.promptId, trust);
          }}
        />
      ) : pending?.kind === "prompt" ? (
        <SecretPrompt
          key={pending.promptId}
          prompt={pending.prompt}
          onAnswer={(values) => {
            answered(pending.promptId);
            void answerPrompt(pending.promptId, values);
          }}
        />
      ) : (
        <div className="flex items-center justify-between">
          <p className="text-sm">{STAGE_LABELS[stage]}</p>
          <button type="button" className={secondaryButton} onClick={close}>
            取消
          </button>
        </div>
      )}
    </Modal>
  );
}
