export type Appearance = "system" | "light" | "dark";
export type TerminalScheme = "auto" | "dracula" | "solarizedDark" | "githubLight";
export type CursorStyle = "block" | "bar" | "underline";

export interface Settings {
  appearance: Appearance;
  checkUpdates: boolean;
  terminal: {
    fontSize: number;
    scheme: TerminalScheme;
    cursorStyle: CursorStyle;
    cursorBlink: boolean;
    scrollback: number;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  appearance: "system",
  checkUpdates: true,
  terminal: { fontSize: 13, scheme: "auto", cursorStyle: "block", cursorBlink: true, scrollback: 10000 },
};

export const FONT_SIZE_RANGE = [9, 24] as const;
export const SCROLLBACK_RANGE = [1000, 100000] as const;

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function clampInt(value: unknown, [min, max]: readonly [number, number], fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

/** Accepts whatever was stored, possibly by an older or newer version, and fills in defaults. */
export function normalizeSettings(raw: unknown): Settings {
  const value = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const terminal = (typeof value.terminal === "object" && value.terminal !== null ? value.terminal : {}) as Record<
    string,
    unknown
  >;
  const defaults = DEFAULT_SETTINGS.terminal;
  return {
    appearance: pick(value.appearance, ["system", "light", "dark"], DEFAULT_SETTINGS.appearance),
    checkUpdates: typeof value.checkUpdates === "boolean" ? value.checkUpdates : DEFAULT_SETTINGS.checkUpdates,
    terminal: {
      fontSize: clampInt(terminal.fontSize, FONT_SIZE_RANGE, defaults.fontSize),
      scheme: pick(terminal.scheme, ["auto", "dracula", "solarizedDark", "githubLight"], defaults.scheme),
      cursorStyle: pick(terminal.cursorStyle, ["block", "bar", "underline"], defaults.cursorStyle),
      cursorBlink: typeof terminal.cursorBlink === "boolean" ? terminal.cursorBlink : defaults.cursorBlink,
      scrollback: clampInt(terminal.scrollback, SCROLLBACK_RANGE, defaults.scrollback),
    },
  };
}
