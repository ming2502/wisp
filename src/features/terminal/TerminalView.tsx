import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import {
  terminalAck,
  terminalClose,
  terminalOpen,
  terminalResize,
  terminalWrite,
  type TerminalEnd,
} from "../../ipc";
import { createInputQueue } from "./inputQueue";

const ACK_BATCH_BYTES = 32 * 1024;
const RESIZE_DEBOUNCE_MS = 80;

const FONT_FAMILY =
  '"JetBrains Mono", Menlo, Consolas, "PingFang SC", "Microsoft YaHei", monospace';

const END_MESSAGE: Record<TerminalEnd["kind"], string> = {
  exited: "会话已结束",
  disconnected: "连接已断开",
};

interface Props {
  sessionId: number;
  visible: boolean;
  onEnd: (end: TerminalEnd) => void;
}

export function TerminalView({ sessionId, visible, onEnd }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const fit = useRef<(() => void) | null>(null);
  const endHandler = useRef(onEnd);
  endHandler.current = onEnd;

  useEffect(() => {
    let disposed = false;
    let terminalId: number | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: FONT_FAMILY,
      fontSize: 13,
      scrollback: 10000,
      theme: { background: "#101114", foreground: "#ececf1", cursor: "#ececf1" },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.open(container.current!);

    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // xterm falls back to its DOM renderer when WebGL is unavailable.
    }

    const fitToContainer = () => {
      if (container.current?.offsetParent !== null) fitAddon.fit();
    };
    fit.current = fitToContainer;
    fitToContainer();

    const encoder = new TextEncoder();
    const send = createInputQueue((data) =>
      terminalId === null ? Promise.resolve() : terminalWrite(terminalId, data),
    );
    term.onData((text) => send(encoder.encode(text)));
    term.onBinary((text) => send(Uint8Array.from(text, (c) => c.charCodeAt(0))));
    term.onResize(({ cols, rows }) => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (terminalId !== null) void terminalResize(terminalId, cols, rows);
      }, RESIZE_DEBOUNCE_MS);
    });

    let unacked = 0;
    const onOutput = (bytes: Uint8Array) => {
      term.write(bytes, () => {
        unacked += bytes.length;
        if (unacked >= ACK_BATCH_BYTES && terminalId !== null) {
          void terminalAck(terminalId, unacked);
          unacked = 0;
        }
      });
    };
    const onTerminalEnd = (end: TerminalEnd) => {
      term.write(`\r\n\x1b[2m[${END_MESSAGE[end.kind]}]\x1b[0m\r\n`);
      term.options.disableStdin = true;
      if (!disposed) endHandler.current(end);
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
        term.write(`\r\n\x1b[31m${error}\x1b[0m\r\n`);
      });

    const observer = new ResizeObserver(fitToContainer);
    observer.observe(container.current!);

    return () => {
      disposed = true;
      clearTimeout(resizeTimer);
      observer.disconnect();
      fit.current = null;
      if (terminalId !== null) void terminalClose(terminalId);
      term.dispose();
    };
  }, [sessionId]);

  useEffect(() => {
    if (visible) fit.current?.();
  }, [visible]);

  return <div ref={container} className="h-full w-full overflow-hidden bg-[#101114] p-2" />;
}
