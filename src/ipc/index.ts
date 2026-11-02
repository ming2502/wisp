import { Channel, invoke } from "@tauri-apps/api/core";

export type Auth =
  | { kind: "password"; password: string }
  | { kind: "key"; path: string; passphrase?: string }
  | { kind: "agent" }
  | { kind: "keyboardInteractive" };

export interface ConnectRequest {
  host: string;
  port: number;
  user: string;
  auth: Auth;
}

export type Stage = "connecting" | "authenticating" | "ready";

export interface HostKeyInfo {
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  otherAlgorithmsKnown: boolean;
}

export interface PromptField {
  label: string;
  echo: boolean;
}

export type Prompt =
  | { kind: "passphrase"; path: string; retry: boolean }
  | { kind: "keyboardInteractive"; name: string; instructions: string; fields: PromptField[] };

export type ConnectMessage =
  | { kind: "stage"; stage: Stage }
  | { kind: "hostKey"; promptId: number; info: HostKeyInfo }
  | { kind: "prompt"; promptId: number; prompt: Prompt };

export type TerminalEnd = { kind: "exited"; status: number | null } | { kind: "disconnected" };

const FRAME_OUTPUT = 0;

export function sshConnect(
  request: ConnectRequest,
  onEvent: (message: ConnectMessage) => void,
): Promise<number> {
  const channel = new Channel<ConnectMessage>(onEvent);
  return invoke<number>("ssh_connect", { request, onEvent: channel });
}

export function answerHostKey(promptId: number, trust: boolean): Promise<void> {
  return invoke("answer_host_key", { promptId, trust });
}

export function answerPrompt(promptId: number, values: string[] | null): Promise<void> {
  return invoke("answer_prompt", { promptId, values });
}

export function sshDisconnect(sessionId: number): Promise<void> {
  return invoke("ssh_disconnect", { sessionId });
}

export function terminalOpen(
  sessionId: number,
  cols: number,
  rows: number,
  onOutput: (bytes: Uint8Array) => void,
  onEnd: (end: TerminalEnd) => void,
): Promise<number> {
  const onFrame = new Channel<ArrayBuffer>((frame) => {
    const bytes = new Uint8Array(frame);
    const payload = bytes.subarray(1);
    if (bytes[0] === FRAME_OUTPUT) {
      onOutput(payload);
    } else {
      onEnd(JSON.parse(new TextDecoder().decode(payload)));
    }
  });
  return invoke<number>("terminal_open", { sessionId, cols, rows, onFrame });
}

export function terminalWrite(terminalId: number, data: Uint8Array): Promise<void> {
  return invoke("terminal_write", { terminalId, data: Array.from(data) });
}

export function terminalResize(terminalId: number, cols: number, rows: number): Promise<void> {
  return invoke("terminal_resize", { terminalId, cols, rows });
}

export function terminalAck(terminalId: number, bytes: number): Promise<void> {
  return invoke("terminal_ack", { terminalId, bytes });
}

export function terminalClose(terminalId: number): Promise<void> {
  return invoke("terminal_close", { terminalId });
}
