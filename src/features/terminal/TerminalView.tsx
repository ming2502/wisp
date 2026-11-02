import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import {
  terminalAck,
  terminalClose,
  terminalOpen,
  terminalResize,
  terminalWrite,
  type TerminalEnd,
} from "../../ipc";
import { isMac, isShortcut } from "../../lib/platform";
import { useSettings } from "../settings/SettingsContext";
import { createInputQueue } from "./inputQueue";
import { terminalTheme } from "./schemes";

const ACK_BATCH_BYTES = 32 * 1024;
const RESIZE_DEBOUNCE_MS = 80;
const FONT_FAMILY = '"JetBrains Mono", Menlo, Consolas, "PingFang SC", "Microsoft YaHei", monospace';

const END_MESSAGE: Record<TerminalEnd["kind"], string> = {
  exited: "会话已结束",
  disconnected: "连接已断开",
};

interface Props {
  sessionId: number;
  visible: boolean;
  onEnd: (end: TerminalEnd) => void;
}

/**
 * One xterm instance for the life of the tab. A reconnect binds it to a new session, so the
 * scrollback from before the disconnect stays.
 */
export function TerminalView({ sessionId, visible, onEnd }: Props) {
  const { settings, dark } = useSettings();
  const container = useRef<HTMLDivElement>(null);
  const [term, setTerm] = useState<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const search = useRef<SearchAddon | null>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const boundBefore = useRef(false);
  const endHandler = useRef(onEnd);
  endHandler.current = onEnd;
  const initial = useRef({ settings, dark });

  // Creates the terminal once the bundled font is ready, since xterm measures it only once.
  useEffect(() => {
    let disposed = false;
    let instance: Terminal | null = null;
    let observer: ResizeObserver | null = null;
    const { settings: start, dark: startDark } = initial.current;

    void document.fonts
      .load(`${start.terminal.fontSize}px "JetBrains Mono"`)
      .catch(() => {})
      .then(() => {
        if (disposed) return;
        const created = new Terminal({
          allowProposedApi: true,
          fontFamily: FONT_FAMILY,
          fontSize: start.terminal.fontSize,
          cursorStyle: start.terminal.cursorStyle,
          cursorBlink: start.terminal.cursorBlink,
          scrollback: start.terminal.scrollback,
          theme: terminalTheme(start.terminal.scheme, startDark),
          macOptionIsMeta: true,
        });
        const fitAddon = new FitAddon();
        const searchAddon = new SearchAddon();
        created.loadAddon(fitAddon);
        created.loadAddon(searchAddon);
        created.loadAddon(new Unicode11Addon());
        created.unicode.activeVersion = "11";
        created.open(container.current!);
        try {
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => webgl.dispose());
          created.loadAddon(webgl);
        } catch {
          // xterm falls back to its DOM renderer when WebGL is unavailable.
        }
        fit.current = fitAddon;
        search.current = searchAddon;
        const fitToContainer = () => {
          if (container.current?.offsetParent !== null) fitAddon.fit();
        };
        fitToContainer();
        observer = new ResizeObserver(fitToContainer);
        observer.observe(container.current!);
        instance = created;
        setTerm(created);
      });

    return () => {
      disposed = true;
      observer?.disconnect();
      instance?.dispose();
      fit.current = null;
      search.current = null;
    };
  }, []);

  // Applies settings changes to the running terminal.
  useEffect(() => {
    if (!term) return;
    term.options.fontSize = settings.terminal.fontSize;
    term.options.cursorStyle = settings.terminal.cursorStyle;
    term.options.cursorBlink = settings.terminal.cursorBlink;
    term.options.scrollback = settings.terminal.scrollback;
    term.options.theme = terminalTheme(settings.terminal.scheme, dark);
    if (container.current?.offsetParent !== null) fit.current?.fit();
  }, [term, settings.terminal, dark]);

  // Connects the terminal to the session's shell.
  useEffect(() => {
    if (!term) return;
    let disposed = false;
    let terminalId: number | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let unacked = 0;

    if (boundBefore.current) term.write("\r\n\x1b[2m[已重新连接]\x1b[0m\r\n");
    boundBefore.current = true;
    term.options.disableStdin = false;

    const encoder = new TextEncoder();
    const send = createInputQueue((data) =>
      terminalId === null ? Promise.resolve() : terminalWrite(terminalId, data),
    );
    const subscriptions = [
      term.onData((text) => send(encoder.encode(text))),
      term.onBinary((text) => send(Uint8Array.from(text, (c) => c.charCodeAt(0)))),
      term.onResize(({ cols, rows }) => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (terminalId !== null) void terminalResize(terminalId, cols, rows);
        }, RESIZE_DEBOUNCE_MS);
      }),
    ];

    const onOutput = (bytes: Uint8Array) => {
      if (disposed) return;
      term.write(bytes, () => {
        unacked += bytes.length;
        if (unacked >= ACK_BATCH_BYTES && terminalId !== null) {
          void terminalAck(terminalId, unacked);
          unacked = 0;
        }
      });
    };
    const onTerminalEnd = (end: TerminalEnd) => {
      if (disposed) return;
      term.write(`\r\n\x1b[2m[${END_MESSAGE[end.kind]}]\x1b[0m\r\n`);
      term.options.disableStdin = true;
      endHandler.current(end);
    };

    terminalOpen(sessionId, term.cols, term.rows, onOutput, onTerminalEnd)
      .then((id) => {
        if (disposed) {
          void terminalClose(id);
          return;
        }
        terminalId = id;
        term.focus();
      })
      .catch((error) => {
        if (!disposed) term.write(`\r\n\x1b[31m${error}\x1b[0m\r\n`);
      });

    return () => {
      disposed = true;
      clearTimeout(resizeTimer);
      subscriptions.forEach((subscription) => subscription.dispose());
      if (terminalId !== null) void terminalClose(terminalId);
    };
  }, [term, sessionId]);

  // Search, and copy and paste where Ctrl+C and Ctrl+V belong to the shell.
  useEffect(() => {
    if (!term) return;
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      if (isShortcut(event, "KeyF")) {
        setSearching(true);
        requestAnimationFrame(() => {
          searchInput.current?.focus();
          searchInput.current?.select();
        });
        return false;
      }
      if (!isMac && event.ctrlKey && event.shiftKey && event.code === "KeyC") {
        const selection = term.getSelection();
        if (selection) void writeText(selection).catch(() => {});
        return false;
      }
      if (!isMac && event.ctrlKey && event.shiftKey && event.code === "KeyV") {
        void readText()
          .then((text) => text && term.paste(text))
          .catch(() => {});
        return false;
      }
      return true;
    });
  }, [term]);

  useEffect(() => {
    if (visible && term) {
      fit.current?.fit();
      if (!searching) term.focus();
    }
  }, [visible, term, searching]);

  function find(backwards = false) {
    if (!query) return;
    const options = { caseSensitive: false, decorations: { matchOverviewRuler: "#888", activeMatchColorOverviewRuler: "#f80", activeMatchBackground: "#f8a00066", matchBackground: "#88888844" } };
    if (backwards) search.current?.findPrevious(query, options);
    else search.current?.findNext(query, options);
  }

  function closeSearch() {
    search.current?.clearDecorations();
    setSearching(false);
    term?.focus();
  }

  const background = terminalTheme(settings.terminal.scheme, dark).background;

  return (
    <div className="relative h-full w-full" style={{ background }}>
      <div ref={container} className="h-full w-full overflow-hidden p-2" />
      {searching && (
        <form
          className="absolute right-3 top-2 flex items-center gap-1 rounded-md border border-line bg-canvas p-1 shadow-lg"
          onSubmit={(event) => {
            event.preventDefault();
            find();
          }}
        >
          <input
            ref={searchInput}
            aria-label="在终端中搜索"
            className="w-48 bg-transparent px-1.5 text-sm outline-none"
            placeholder="搜索"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeSearch();
              if (event.key === "Enter" && event.shiftKey) {
                event.preventDefault();
                find(true);
              }
            }}
          />
          <button type="button" aria-label="上一个" className="rounded p-1 text-muted hover:bg-line" onClick={() => find(true)}>
            <ChevronUp size={14} />
          </button>
          <button type="submit" aria-label="下一个" className="rounded p-1 text-muted hover:bg-line">
            <ChevronDown size={14} />
          </button>
          <button type="button" aria-label="关闭搜索" className="rounded p-1 text-muted hover:bg-line" onClick={closeSearch}>
            <X size={14} />
          </button>
        </form>
      )}
    </div>
  );
}
