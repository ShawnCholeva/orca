import { useEffect, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import type { SessionStatus } from "@orca/contracts";
import { useSessionStream, type SessionTerminalWriter } from "./useSessionStream";

type Props = {
  sessionId: string;
  status: SessionStatus;
};

const TERMINAL_STATUSES = new Set<SessionStatus>(["exited", "failed", "stopped"]);

export function SessionTerminalView({ sessionId, status }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const inputDisabledRef = useRef(TERMINAL_STATUSES.has(status));
  const sendInputRef = useRef<(data: string) => void>(() => {});
  const sendResizeRef = useRef<(cols: number, rows: number) => void>(() => {});
  const [writer, setWriter] = useState<SessionTerminalWriter | null>(null);
  const { connectionStatus, error, sendInput, sendResize } = useSessionStream(sessionId, writer);

  useEffect(() => {
    const disabled = TERMINAL_STATUSES.has(status);
    inputDisabledRef.current = disabled;
    if (terminalRef.current) {
      terminalRef.current.options.disableStdin = disabled;
    }
  }, [status]);

  useEffect(() => {
    sendInputRef.current = sendInput;
  }, [sendInput]);

  useEffect(() => {
    sendResizeRef.current = sendResize;
  }, [sendResize]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      disableStdin: TERMINAL_STATUSES.has(status),
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
    });
    terminalRef.current = terminal;
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);

    const dataDisposable = terminal.onData((data) => {
      if (!inputDisabledRef.current) {
        sendInputRef.current(data);
      }
    });

    function fitAndSendResize() {
      fitAddon.fit();
      sendResizeRef.current(terminal.cols, terminal.rows);
    }

    const resizeObserver = new ResizeObserver(fitAndSendResize);
    resizeObserver.observe(container);
    fitAndSendResize();

    setWriter({
      write(data) {
        terminal.write(data);
      },
    });

    return () => {
      dataDisposable.dispose();
      resizeObserver.disconnect();
      fitAddon.dispose();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [sessionId]);

  return (
    <div className="session-terminal">
      <div className="session-terminal-header">
        <span className={`session-terminal-status session-terminal-status--${connectionStatus}`}>
          {connectionStatus}
        </span>
        {TERMINAL_STATUSES.has(status) && (
          <span className="session-terminal-ended">{status}</span>
        )}
      </div>
      {error && <p className="form-error">{error}</p>}
      <div ref={containerRef} className="session-terminal-surface" />
    </div>
  );
}
