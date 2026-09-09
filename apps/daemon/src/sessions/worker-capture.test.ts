import { describe, expect, it, vi } from 'vitest';

import { createWorkerCaptureSink } from './worker-capture.js';

describe('createWorkerCaptureSink', () => {
  it('stores the chunk and pushes it to viewers, in that order', () => {
    const calls: string[] = [];
    const appendChunk = vi.fn(() => {
      calls.push('append');
      return { seq: 7, byteOffset: 512 };
    });
    const broadcastOutput = vi.fn(() => {
      calls.push('broadcast');
    });

    createWorkerCaptureSink({ appendChunk, broadcastOutput })('sess-1', Buffer.from('drawn'));

    // Storing first means the seq a viewer is told about is one it can re-fetch.
    expect(calls).toEqual(['append', 'broadcast']);
    expect(appendChunk).toHaveBeenCalledWith('sess-1', Buffer.from('drawn'));
    expect(broadcastOutput).toHaveBeenCalledWith('sess-1', 7, 512, Buffer.from('drawn'));
  });
});
