export const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

/**
 * App shortcuts use Cmd on macOS. Elsewhere they use Ctrl+Shift, because plain Ctrl combinations
 * belong to the programs running in the terminal. `code` is a KeyboardEvent code such as "KeyK".
 */
export function isShortcut(event: KeyboardEvent, code: string) {
  if (event.code !== code || event.altKey) return false;
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && event.shiftKey && !event.metaKey;
}

export function shortcutLabel(key: string) {
  return isMac ? `⌘${key}` : `Ctrl+Shift+${key}`;
}
