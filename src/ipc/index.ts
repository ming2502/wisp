import { Channel, invoke } from "@tauri-apps/api/core";

export type HostAuth =
  | { kind: "password" }
  | { kind: "key"; path: string }
  | { kind: "agent" }
  | { kind: "keyboardInteractive" };

export interface Host {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  groupId: string | null;
  auth: HostAuth;
  savedSecret: boolean;
}

export interface Group {
  id: string;
  name: string;
}

export interface HostList {
  hosts: Host[];
  groups: Group[];
}

export type HostDraft = Omit<Host, "id" | "savedSecret"> & { id: string | null };

export type SecretChange = { kind: "keep" } | { kind: "set"; value: string } | { kind: "clear" };

export interface ImportCandidate {
  name: string;
  host: string;
  port: number;
  user: string;
  auth: HostAuth;
  proxyJump: string | null;
}

export interface ImportPreview {
  candidates: ImportCandidate[];
  skippedDirectives: number;
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
  | { kind: "password"; retry: boolean }
  | { kind: "passphrase"; path: string; retry: boolean }
  | { kind: "keyboardInteractive"; name: string; instructions: string; fields: PromptField[] };

export type ConnectMessage =
  | { kind: "stage"; stage: Stage }
  | { kind: "hostKey"; promptId: number; info: HostKeyInfo }
  | { kind: "prompt"; promptId: number; prompt: Prompt };

export type TerminalEnd = { kind: "exited"; status: number | null } | { kind: "disconnected" };

const FRAME_OUTPUT = 0;

export function hostsList(): Promise<HostList> {
  return invoke("hosts_list");
}

export function hostSave(draft: HostDraft, secret: SecretChange): Promise<Host> {
  return invoke("host_save", { draft, secret });
}

export function hostDelete(id: string): Promise<void> {
  return invoke("host_delete", { id });
}

export function groupSave(id: string | null, name: string): Promise<Group> {
  return invoke("group_save", { id, name });
}

export function groupDelete(id: string): Promise<void> {
  return invoke("group_delete", { id });
}

export function sshConfigPreview(): Promise<ImportPreview> {
  return invoke("ssh_config_preview");
}

/** Resolves to the number of entries that could not be saved. */
export function sshConfigImport(candidates: ImportCandidate[]): Promise<number> {
  return invoke("ssh_config_import", { candidates });
}

export function sshConnect(
  hostId: string,
  onEvent: (message: ConnectMessage) => void,
): Promise<number> {
  const channel = new Channel<ConnectMessage>(onEvent);
  return invoke<number>("ssh_connect", { hostId, onEvent: channel });
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

export type EntryKind = "file" | "dir" | "symlink" | "other";

export interface RemoteEntry {
  name: string;
  path: string;
  kind: EntryKind;
  size: number;
  modified: number | null;
  permissions: number | null;
  linkToDir: boolean;
}

export interface Listing {
  path: string;
  entries: RemoteEntry[];
}

export interface Enqueued {
  files: number;
  skipped: number;
}

export type TransferState =
  | { kind: "queued" }
  | { kind: "running" }
  | { kind: "paused" }
  | { kind: "completed" }
  | { kind: "failed"; message: string }
  | { kind: "cancelled" };

export interface TransferInfo {
  id: number;
  owner: number;
  direction: "upload" | "download";
  name: string;
  local: string;
  remote: string;
  size: number;
  transferred: number;
  state: TransferState;
}

export function sftpList(sessionId: number, path: string | null): Promise<Listing> {
  return invoke("sftp_list", { sessionId, path });
}

export function sftpMkdir(sessionId: number, dir: string, name: string): Promise<string> {
  return invoke("sftp_mkdir", { sessionId, dir, name });
}

export function sftpRename(sessionId: number, path: string, newName: string): Promise<string> {
  return invoke("sftp_rename", { sessionId, path, newName });
}

export function sftpRemove(sessionId: number, paths: string[]): Promise<void> {
  return invoke("sftp_remove", { sessionId, paths });
}

export function sftpChmod(sessionId: number, path: string, mode: number): Promise<void> {
  return invoke("sftp_chmod", { sessionId, path, mode });
}

export function transferUpload(
  sessionId: number,
  localPaths: string[],
  remoteDir: string,
): Promise<Enqueued> {
  return invoke("transfer_upload", { sessionId, localPaths, remoteDir });
}

export function transferDownload(
  sessionId: number,
  remotePaths: string[],
  localDir: string,
): Promise<Enqueued> {
  return invoke("transfer_download", { sessionId, remotePaths, localDir });
}

export function transferPause(id: number): Promise<void> {
  return invoke("transfer_pause", { id });
}

export function transferResume(id: number): Promise<void> {
  return invoke("transfer_resume", { id });
}

export function transferCancel(id: number): Promise<void> {
  return invoke("transfer_cancel", { id });
}

export function transfersClear(): Promise<void> {
  return invoke("transfers_clear");
}

export function transfersSubscribe(
  onChange: (list: TransferInfo[]) => void,
): Promise<TransferInfo[]> {
  return invoke("transfers_subscribe", { onChange: new Channel<TransferInfo[]>(onChange) });
}
