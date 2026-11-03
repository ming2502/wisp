import type { ITheme } from "@xterm/xterm";
import type { TerminalScheme } from "../settings/settings";

const dark: ITheme = {
  background: "#0f172a",
  foreground: "#e2e8f0",
  cursor: "#e2e8f0",
  cursorAccent: "#0f172a",
  selectionBackground: "#334155",
  black: "#1e293b",
  red: "#f07178",
  green: "#a6d189",
  yellow: "#e5c890",
  blue: "#82aaff",
  magenta: "#c792ea",
  cyan: "#89ddff",
  white: "#d0d0d6",
  brightBlack: "#64748b",
  brightRed: "#ff8b92",
  brightGreen: "#c3e88d",
  brightYellow: "#ffcb6b",
  brightBlue: "#9cc4ff",
  brightMagenta: "#ddb6f2",
  brightCyan: "#a3f7ff",
  brightWhite: "#ffffff",
};

const githubLight: ITheme = {
  background: "#ffffff",
  foreground: "#24292f",
  cursor: "#24292f",
  cursorAccent: "#ffffff",
  selectionBackground: "#b6d3fb",
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#7d4e00",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
};

const dracula: ITheme = {
  background: "#282a36",
  foreground: "#f8f8f2",
  cursor: "#f8f8f2",
  cursorAccent: "#282a36",
  selectionBackground: "#44475a",
  black: "#21222c",
  red: "#ff5555",
  green: "#50fa7b",
  yellow: "#f1fa8c",
  blue: "#bd93f9",
  magenta: "#ff79c6",
  cyan: "#8be9fd",
  white: "#f8f8f2",
  brightBlack: "#6272a4",
  brightRed: "#ff6e6e",
  brightGreen: "#69ff94",
  brightYellow: "#ffffa5",
  brightBlue: "#d6acff",
  brightMagenta: "#ff92df",
  brightCyan: "#a4ffff",
  brightWhite: "#ffffff",
};

const solarizedDark: ITheme = {
  background: "#002b36",
  foreground: "#93a1a1",
  cursor: "#93a1a1",
  cursorAccent: "#002b36",
  selectionBackground: "#0b4f5e",
  black: "#073642",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#eee8d5",
  brightBlack: "#586e75",
  brightRed: "#cb4b16",
  brightGreen: "#93a1a1",
  brightYellow: "#839496",
  brightBlue: "#839496",
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#fdf6e3",
};

export const SCHEME_LABELS: Record<TerminalScheme, string> = {
  auto: "跟随外观",
  dracula: "Dracula",
  solarizedDark: "Solarized Dark",
  githubLight: "GitHub Light",
};

export function terminalTheme(scheme: TerminalScheme, appDark: boolean): ITheme {
  // The overview ruler beside the scrollbar draws a light 1px border by default.
  return { ...schemeTheme(scheme, appDark), overviewRulerBorder: "transparent" };
}

function schemeTheme(scheme: TerminalScheme, appDark: boolean): ITheme {
  switch (scheme) {
    case "auto":
      return appDark ? dark : githubLight;
    case "dracula":
      return dracula;
    case "solarizedDark":
      return solarizedDark;
    case "githubLight":
      return githubLight;
  }
}
