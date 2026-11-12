import type { TerminalEnd } from "../ipc";

export type View = "terminal" | "files";

export type Tab =
  | {
      kind: "session";
      key: string;
      sessionId: number;
      hostId: string;
      title: string;
      /** Why the shell stopped, if it did. After "exited" the connection itself is still usable. */
      end: TerminalEnd["kind"] | null;
      view: View;
      /** Counts the switches to the files that should open the shell's directory. */
      follow?: number;
    }
  | { kind: "editor"; key: string; sessionId: number; path: string; title: string; dirty: boolean };

export type SessionTab = Extract<Tab, { kind: "session" }>;

export function sessionKey(sessionId: number) {
  return `s${sessionId}`;
}

export function editorKey(sessionId: number, path: string) {
  return `e${sessionId}:${path}`;
}

/** Opens a file in a new tab after the session's other tabs, or returns its existing tab. */
export function openEditor(tabs: Tab[], sessionId: number, path: string): { tabs: Tab[]; key: string } {
  const key = editorKey(sessionId, path);
  if (tabs.some((tab) => tab.key === key)) return { tabs, key };
  const title = path.split("/").filter(Boolean).pop() ?? path;
  const tab: Tab = { kind: "editor", key, sessionId, path, title, dirty: false };
  let last = -1;
  tabs.forEach((existing, index) => {
    if (existing.sessionId === sessionId) last = index;
  });
  const at = last === -1 ? tabs.length : last + 1;
  return { tabs: [...tabs.slice(0, at), tab, ...tabs.slice(at)], key };
}

/** A session tab takes its editors with it, since they cannot save without the connection. */
export function tabsClosedWith(tabs: Tab[], key: string): Tab[] {
  const target = tabs.find((tab) => tab.key === key);
  if (!target) return [];
  if (target.kind === "editor") return [target];
  return tabs.filter((tab) => tab.sessionId === target.sessionId);
}

/** The tab to show after closing some, preferring the neighbour on the left. */
export function nextActive(tabs: Tab[], closing: Tab[], active: string | null): string | null {
  const closingKeys = new Set(closing.map((tab) => tab.key));
  if (active !== null && !closingKeys.has(active)) return active;
  const first = tabs.findIndex((tab) => closingKeys.has(tab.key));
  const remaining = tabs.filter((tab) => !closingKeys.has(tab.key));
  if (remaining.length === 0) return null;
  const before = tabs.slice(0, Math.max(first, 0)).filter((tab) => !closingKeys.has(tab.key));
  return (before[before.length - 1] ?? remaining[0]).key;
}

/** Points a session tab and its editors at the session that replaced a lost one. */
export function replaceSession(tabs: Tab[], oldId: number, newId: number): Tab[] {
  return tabs.map((tab) => {
    if (tab.sessionId !== oldId) return tab;
    return tab.kind === "session" ? { ...tab, sessionId: newId, end: null } : { ...tab, sessionId: newId };
  });
}
