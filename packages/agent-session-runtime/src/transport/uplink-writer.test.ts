import { describe, expect, it, vi } from 'vitest';
import * as writerModule from './uplink-writer.js';

describe('bounded uplink writes', () => {
  it('retires the transport when pending bytes exceed capacity without silently dropping frames', () => {
    const writes: string[] = [], failures: Error[] = [];
    const writer = writerModule.createUplinkWriter({ send: (json) => { writes.push(json); } },
      { maxMessages: 2, maxBytes: 6, writeTimeoutMs: 1000, onFailure: (error) => failures.push(error) });
    writer.send('four');
    writer.send('abc');
    expect(writes).toEqual(['four']);
    expect(failures).toHaveLength(1);
    writer.send('x');
    expect(writes).toEqual(['four']);
    writer.close();
  });

  it('times out a blocked write and clears queued payloads', async () => {
    const failures: Error[] = [];
    const writer = writerModule.createUplinkWriter({ send: () => undefined },
      { maxMessages: 2, maxBytes: 100, writeTimeoutMs: 10, onFailure: (error) => failures.push(error) });
    writer.send('blocked');
    await vi.waitFor(() => expect(failures).toHaveLength(1));
    writer.close();
  });
});
