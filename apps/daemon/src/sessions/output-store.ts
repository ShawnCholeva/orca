import type Database from 'better-sqlite3';
import { SessionOutputSnapshot } from '@orca/contracts';

const DEFAULT_TAIL_BYTES = 1024 * 1024;

interface SessionCounterRow {
  output_seq: number;
  output_bytes_kept: number;
  output_offset_first: number;
}

interface OldestChunkRow {
  seq: number;
  byte_offset: number;
  byte_length: number;
}

interface TailChunkRow {
  seq: number;
  byte_offset: number;
  data: Buffer;
}

export interface SessionOutputStore {
  appendChunk(sessionId: string, data: Buffer): { seq: number; byteOffset: number };
  readTail(sessionId: string): SessionOutputSnapshot;
}

export interface SessionOutputStoreOptions {
  tailBytes?: number;
  /** Called synchronously after each non-empty chunk is successfully appended. */
  onChunkAppended?: (sessionId: string) => void;
}

let _db: Database.Database | null = null;
let _stmts: {
  selectCounters: Database.Statement;
  insertChunk: Database.Statement;
  selectOldestChunk: Database.Statement;
  deleteChunk: Database.Statement;
  updateCounters: Database.Statement;
  readSessionTailState: Database.Statement;
  readTailChunks: Database.Statement;
} | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (db !== _db) {
    _db = db;
    _stmts = {
      selectCounters: db.prepare(
        `SELECT output_seq, output_bytes_kept, output_offset_first
         FROM sessions
         WHERE id = ?`
      ),
      insertChunk: db.prepare(
        `INSERT INTO session_output_chunks (
          session_id, seq, byte_offset, byte_length, written_at, data
        ) VALUES (?, ?, ?, ?, ?, ?)`
      ),
      selectOldestChunk: db.prepare(
        `SELECT seq, byte_offset, byte_length
         FROM session_output_chunks
         WHERE session_id = ?
         ORDER BY seq ASC
         LIMIT 1`
      ),
      deleteChunk: db.prepare(
        `DELETE FROM session_output_chunks
         WHERE session_id = ? AND seq = ?`
      ),
      updateCounters: db.prepare(
        `UPDATE sessions
         SET output_seq = ?,
             output_bytes_kept = ?,
             output_offset_first = ?
         WHERE id = ?`
      ),
      readSessionTailState: db.prepare(
        `SELECT output_seq, output_bytes_kept, output_offset_first
         FROM sessions
         WHERE id = ?`
      ),
      readTailChunks: db.prepare(
        `SELECT seq, byte_offset, data
         FROM session_output_chunks
         WHERE session_id = ?
         ORDER BY seq ASC`
      ),
    };
  }

  return _stmts!;
}

export function createSessionOutputStore(
  db: Database.Database,
  options?: SessionOutputStoreOptions
): SessionOutputStore {
  const stmts = ensureStmts(db);
  const capBytes = options?.tailBytes ?? DEFAULT_TAIL_BYTES;
  const onChunkAppended = options?.onChunkAppended;

  return {
    appendChunk(sessionId: string, data: Buffer): { seq: number; byteOffset: number } {
      if (data.length === 0) {
        const current = stmts.selectCounters.get(sessionId) as SessionCounterRow | undefined;
        if (!current) {
          throw new Error(`Session not found: ${sessionId}`);
        }
        return {
          seq: current.output_seq,
          byteOffset: current.output_offset_first + current.output_bytes_kept,
        };
      }

      // Bound to the cap so a single oversized chunk cannot exceed the storage limit.
      const bounded = data.length > capBytes ? data.subarray(data.length - capBytes) : data;
      const skipped = data.length - bounded.length;

      const result = db.transaction(() => {
        const current = stmts.selectCounters.get(sessionId) as SessionCounterRow | undefined;
        if (!current) {
          throw new Error(`Session not found: ${sessionId}`);
        }

        const seq = current.output_seq;
        const byteOffset = current.output_offset_first + current.output_bytes_kept;
        const now = new Date().toISOString();

        stmts.insertChunk.run(sessionId, seq, byteOffset + skipped, bounded.length, now, bounded);

        let outputSeq = seq + 1;
        let outputBytesKept = current.output_bytes_kept + bounded.length;
        let outputOffsetFirst = current.output_offset_first;

        while (outputBytesKept > capBytes) {
          const oldest = stmts.selectOldestChunk.get(sessionId) as OldestChunkRow | undefined;
          if (!oldest) {
            break;
          }

          if (oldest.seq === seq) {
            break;
          }

          stmts.deleteChunk.run(sessionId, oldest.seq);
          outputBytesKept -= oldest.byte_length;
          outputOffsetFirst = oldest.byte_offset + oldest.byte_length;
        }

        stmts.updateCounters.run(outputSeq, outputBytesKept, outputOffsetFirst, sessionId);
        return { seq, byteOffset };
      })();
      onChunkAppended?.(sessionId);
      return result;
    },

    readTail(sessionId: string): SessionOutputSnapshot {
      const state = stmts.readSessionTailState.get(sessionId) as SessionCounterRow | undefined;
      if (!state) {
        return SessionOutputSnapshot.parse({
          sessionId,
          firstByteOffset: 0,
          nextSeq: 0,
          totalBytesKept: 0,
          chunks: [],
        });
      }

      const rows = stmts.readTailChunks.all(sessionId) as TailChunkRow[];

      return SessionOutputSnapshot.parse({
        sessionId,
        firstByteOffset: state.output_offset_first,
        nextSeq: state.output_seq,
        totalBytesKept: state.output_bytes_kept,
        chunks: rows.map((row) => ({
          seq: row.seq,
          byteOffset: row.byte_offset,
          dataBase64: row.data.toString('base64'),
        })),
      });
    },
  };
}
