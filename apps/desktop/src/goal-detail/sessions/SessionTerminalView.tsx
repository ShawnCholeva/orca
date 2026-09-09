import { useEffect, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import type { SessionStatus } from "@orca/contracts";
import { useSessionStream, type SessionTerminalWriter } from "./useSessionStream";

type Props = {
  sessionId: string;
  status: SessionStatus;
  /**
   * The fixed grid of the pane behind this session, when the daemon owns it (a
   * workflow worker's tmux pane). Passed in rather than fetched: the recorded
   * output is full of redraws addressed to these exact coordinates, so the
   * terminal has to be built at this grid — there must be no first frame at some
   * other size for that output to land in. Absent means the viewer sizes itself,
   * as a pty-backed session allows.
   */
  pane?: { cols: number; rows: number } | null;
  /**
   * Put the keyboard in the terminal as soon as it mounts. For a view whose whole
   * purpose is this one session, making the reader click before they can type is
   * a step with no decision in it.
   */
  autoFocus?: boolean;
};

const TERMINAL_STATUSES = new Set<SessionStatus>(["exited", "failed", "stopped"]);

// The size the terminal is measured at before it is scaled to fit. Everything
// else is derived from it, so a re-fit never compounds on an already-scaled size.
const BASE_FONT_SIZE = 13;
const MIN_FONT_SIZE = 6;
// Font sizes are kept to a tenth of a pixel: whole pixels throw away up to 0.6px
// of cell width, which over a 220-column pane is a visible strip of dead space.
const floorToTenth = (value: number) => Math.floor(value * 10) / 10;
/**
 * How wide and tall the grid ACTUALLY draws.
 *
 * xterm's DOM renderer lays each row out as inline text, so a glyph whose advance
 * its cell measurement did not predict — the symbols and box-drawing an agent's
 * TUI is full of, which fall back to another font — pushes the end of that row
 * past the width xterm reports for itself. Those rows are what hangs outside the
 * panel, so they are what has to be measured.
 */
function renderedExtent(surface: HTMLElement): { width: number; height: number } | null {
  const screen = surface.querySelector<HTMLElement>(".xterm-screen");
  if (!screen || !screen.clientWidth || !screen.clientHeight) return null;
  let width = screen.clientWidth;
  const rows = surface.querySelector<HTMLElement>(".xterm-rows");
  if (rows) {
    const left = rows.getBoundingClientRect().left;
    for (const row of rows.children) {
      const last = row.lastElementChild;
      if (last) width = Math.max(width, last.getBoundingClientRect().right - left);
    }
  }
  return { width, height: screen.clientHeight };
}

/** A CSS length in pixels, or 0 where it is absent or not a length. */
const px = (value: string) => {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function SessionTerminalView({ sessionId, status, pane = null, autoFocus = false }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const inputDisabledRef = useRef(TERMINAL_STATUSES.has(status));
  const sendInputRef = useRef<(data: string) => void>(() => {});
  const sendResizeRef = useRef<(cols: number, rows: number) => void>(() => {});
  const [writer, setWriter] = useState<SessionTerminalWriter | null>(null);
  const { connectionStatus, error, busy, sendInput, sendResize } = useSessionStream(sessionId, writer);

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
      fontSize: BASE_FONT_SIZE,
      // Built at the pane's grid, so not one byte of output is ever written to a
      // terminal of the wrong width.
      ...(pane ? { cols: pane.cols, rows: pane.rows } : {}),
    });
    terminalRef.current = terminal;
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    if (autoFocus) terminal.focus();

    // onData carries two different things: what the human typed, and xterm's own
    // answers to the terminal queries (device attributes, cursor position, colour)
    // embedded in the output it is rendering. A real terminal owes the program
    // those answers — but this is a VIEWER, and tmux has already answered them.
    // Forwarding ours injected escape sequences into the live agent's composer as
    // if typed (32 of them just from replaying one session's scrollback).
    //
    // xterm raises a human keystroke while still handling the DOM event that
    // caused it, and a query answer from its write queue in a task of its own. So
    // the two are told apart by whether a real input event is being handled right
    // now — cleared on a macrotask, not a microtask, because a typed character
    // can surface on `input` (IME, paste, synthetic typing) one event AFTER the
    // keydown, which a microtask would already have swallowed.
    let fromHuman = false;
    let clearHuman: ReturnType<typeof setTimeout> | null = null;
    const markHuman = () => {
      fromHuman = true;
      if (clearHuman !== null) clearTimeout(clearHuman);
      clearHuman = setTimeout(() => {
        fromHuman = false;
        clearHuman = null;
      }, 0);
    };
    for (const event of ["keydown", "input", "paste", "compositionend"]) {
      container.addEventListener(event, markHuman, true);
    }

    const dataDisposable = terminal.onData((data) => {
      if (fromHuman && !inputDisabledRef.current) {
        sendInputRef.current(data);
      }
    });

    // A fixed-grid pane cannot be re-flowed to the container, so the TYPE is
    // scaled instead: shrink the font until all of the agent's screen fits.
    // A viewer-sized session keeps the ordinary re-flow.
    function applyGrid(fontSize: number) {
      terminal.options.fontSize = fontSize;
      // The grid never changes; only the type does. Re-asserted because setting
      // fontSize makes xterm re-measure, and a stale measurement leaves the
      // viewport out of step with the buffer.
      terminal.resize(pane!.cols, pane!.rows);
    }

    function applySize() {
      if (!pane) {
        fitAddon.fit();
        sendResizeRef.current(terminal.cols, terminal.rows);
        return;
      }
      applyGrid(BASE_FONT_SIZE);

      const surface = containerRef.current;
      if (!surface) return;
      const style = getComputedStyle(surface);
      const availWidth = surface.clientWidth - px(style.paddingLeft) - px(style.paddingRight);
      const availHeight = surface.clientHeight - px(style.paddingTop) - px(style.paddingBottom);
      if (availWidth <= 0 || availHeight <= 0) return;

      const drawn = renderedExtent(surface);
      if (!drawn) return;

      // Scale off what the grid ACTUALLY draws. Neither the proposed column count
      // nor xterm's reported width is that: proposeDimensions() called an
      // overflowing grid a fit, and the reported width missed rows that draw past
      // it. Whichever axis is tighter decides, so all of the agent's screen is
      // inside the panel.
      const scale = Math.min(availWidth / drawn.width, availHeight / drawn.height);
      let size = Math.max(MIN_FONT_SIZE, floorToTenth(BASE_FONT_SIZE * scale));
      applyGrid(size);

      // Glyph widths do not scale perfectly linearly, so the result is checked
      // rather than trusted.
      for (let attempt = 0; attempt < 4 && size > MIN_FONT_SIZE; attempt += 1) {
        const now = renderedExtent(surface);
        if (!now || (now.width <= availWidth && now.height <= availHeight)) break;
        size = Math.max(MIN_FONT_SIZE, floorToTenth(size - 0.2));
        applyGrid(size);
      }
    }

    const resizeObserver = new ResizeObserver(() => applySize());
    resizeObserver.observe(container);
    applySize();

    // The rows that overflow are the ones carrying the agent's TUI chrome — its
    // prompt, rules and status line — so none of them exist at mount, when the
    // terminal is empty and the first measurement is taken. Measure again once
    // there is something drawn to measure.
    let measuredDrawnContent = false;
    setWriter({
      write(data) {
        terminal.write(data);
        if (measuredDrawnContent) return;
        measuredDrawnContent = true;
        requestAnimationFrame(() => applySize());
      },
    });

    return () => {
      for (const event of ["keydown", "input", "paste", "compositionend"]) {
        container.removeEventListener(event, markHuman, true);
      }
      if (clearHuman !== null) clearTimeout(clearHuman);
      dataDisposable.dispose();
      resizeObserver.disconnect();
      fitAddon.dispose();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [sessionId, pane?.cols, pane?.rows, autoFocus]);

  // "open" is the whole point of a terminal being on screen, so saying it earns
  // nothing and costs a bar. The header appears only when the stream is in a state
  // worth reading. The session's own status belongs to whatever frames the
  // terminal, which already shows it.
  const streamTrouble = connectionStatus !== "open";
  return (
    <div className="session-terminal">
      {(streamTrouble || busy) && (
        <div className="session-terminal-header">
          {streamTrouble && (
            <span className={`session-terminal-status session-terminal-status--${connectionStatus}`}>
              {connectionStatus}
            </span>
          )}
          {busy && (
            <span className="session-terminal-busy" role="status">
              the agent is working — your keys land once it stops
            </span>
          )}
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
      <div ref={containerRef} className="session-terminal-surface" />
    </div>
  );
}
