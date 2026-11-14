import { expect, it } from 'vitest';
import { decodeSessionChannelServerMessage } from './codec.js';
import { SESSION_READ_BATCH, SESSION_READ_LIMIT, isSessionRead, isSessionReadsRequest } from './session-reads.js';

const read = { hostId: 'host', providerId: 'codex', nativeSessionId: 'thread', readAt: 7 };

it('accepts bounded batches of read positions', () => {
  expect(isSessionReadsRequest({ reads: [read] })).toBe(true);
  expect(isSessionReadsRequest({ reads: [] })).toBe(true);
  expect(isSessionReadsRequest({ reads: Array.from({ length: SESSION_READ_BATCH + 1 }, (_, index) => ({ ...read, nativeSessionId: `thread-${index}` })) })).toBe(false);
  for (const invalid of [{ ...read, readAt: -1 }, { ...read, readAt: 1.5 }, { ...read, hostId: '' }, { ...read, title: 'Secret' }]) {
    expect(isSessionRead(invalid)).toBe(false);
    expect(isSessionReadsRequest({ reads: [invalid] })).toBe(false);
  }
  expect(isSessionReadsRequest({ reads: [read], extra: true })).toBe(false);
});

it('shares read positions on the session channel', () => {
  const frame = (fields: Record<string, unknown>) => decodeSessionChannelServerMessage(JSON.stringify({ protocolVersion: '1.8.0', type: 'session_reads', ...fields })).status;
  expect(frame({ snapshot: true, since: 5, reads: [read] })).toBe('ok');
  expect(frame({ reads: [read] })).toBe('ok');
  expect(frame({ snapshot: true })).toBe('ok');
  expect(frame({ reads: Array.from({ length: SESSION_READ_LIMIT + 1 }, (_, index) => ({ ...read, nativeSessionId: `thread-${index}` })) })).not.toBe('ok');
  expect(frame({ since: -1 })).not.toBe('ok');
});
