import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionOutputFrame } from "@orca/contracts";
import {
  getSession,
  openSessionStream,
  toErrorMessage,
  type ConnectionStatus,
  type SessionClientFrame,
} from "../../api";

export interface SessionTerminalWriter {
  write(data: Uint8Array): void;
}

export interface SessionStreamState {
  connectionStatus: ConnectionStatus;
  error: string | null;
  sendInput(data: string): void;
  sendResize(cols: number, rows: number): void;
}

function decodeBase64(dataBase64: string): Uint8Array {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function encodeBase64(data: string): string {
  const bytes = new TextEncoder().encode(data);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function useSessionStream(
  sessionId: string,
  writer: SessionTerminalWriter | null,
): SessionStreamState {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const writerRef = useRef<SessionTerminalWriter | null>(writer);
  const streamRef = useRef<ReturnType<typeof openSessionStream> | null>(null);
  const lastSeenSeqRef = useRef(0);
  const refetchingGapRef = useRef(false);
  const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null);

  useEffect(() => {
    writerRef.current = writer;
  }, [writer]);

  const sendFrame = useCallback((frame: SessionClientFrame): boolean => {
    return streamRef.current?.send(frame) ?? false;
  }, []);

  const writeSnapshot = useCallback(async () => {
    const detail = await getSession(sessionId);
    for (const chunk of [...detail.output.chunks].sort((a, b) => a.seq - b.seq)) {
      writerRef.current?.write(decodeBase64(chunk.dataBase64));
    }
    lastSeenSeqRef.current = detail.output.nextSeq;
  }, [sessionId]);

  const handleOutput = useCallback((frame: SessionOutputFrame) => {
    if (frame.sessionId !== sessionId) return;

    const lastSeenSeq = lastSeenSeqRef.current;
    if (frame.seq < lastSeenSeq) return;

    if (frame.seq === lastSeenSeq) {
      writerRef.current?.write(decodeBase64(frame.dataBase64));
      lastSeenSeqRef.current = frame.seq + 1;
      return;
    }

    if (refetchingGapRef.current) return;
    refetchingGapRef.current = true;
    writeSnapshot()
      .catch((err) => setError(toErrorMessage(err, "Failed to refetch session output.")))
      .finally(() => {
        refetchingGapRef.current = false;
      });
  }, [sessionId, writeSnapshot]);

  useEffect(() => {
    if (writer === null) return;

    let disposed = false;
    let hasOpened = false;
    const initialSeed = writeSnapshot()
      .catch((err) => setError(toErrorMessage(err, "Failed to load session output.")));

    const stream = openSessionStream({
      onOpen() {
        const seed = hasOpened
          ? writeSnapshot().catch((err) => setError(toErrorMessage(err, "Failed to load session output.")))
          : initialSeed;
        hasOpened = true;

        void seed
          .then(() => {
            if (!disposed) {
              stream.send({ type: "session.subscribe", sessionId });
            }
          });
      },
      onFrame(frame) {
        if (frame.type === "session.output") {
          handleOutput(frame);
          return;
        }
        if (frame.sessionId === sessionId || frame.sessionId === undefined) {
          setError(frame.message);
        }
      },
      onStatus(status) {
        if (!disposed) setConnectionStatus(status);
      },
    });

    streamRef.current = stream;

    return () => {
      disposed = true;
      stream.send({ type: "session.unsubscribe", sessionId });
      stream.close();
      streamRef.current = null;
    };
  }, [handleOutput, sessionId, writeSnapshot, writer]);

  const sendInput = useCallback((data: string) => {
    sendFrame({ type: "session.input", sessionId, dataBase64: encodeBase64(data) });
  }, [sendFrame, sessionId]);

  const sendResize = useCallback((cols: number, rows: number) => {
    const last = lastResizeRef.current;
    if (last?.cols === cols && last.rows === rows) return;
    if (sendFrame({ type: "session.resize", sessionId, cols, rows })) {
      lastResizeRef.current = { cols, rows };
    }
  }, [sendFrame, sessionId]);

  return { connectionStatus, error, sendInput, sendResize };
}
