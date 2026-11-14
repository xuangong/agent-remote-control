import { expect, it } from 'vitest';
import { decodeSessionChannelServerMessage } from './codec.js';
import { decodeRemoteHostUplinkMessage } from './remote-host-uplink.js';
import { OUTBOX_LIMIT, OUTBOX_TEXT_BYTES, isOutboxEntry, isOutboxHostCall, isOutboxPoll, isOutboxRequest } from './session-outbox.js';

const id = '0b6f1d4e-3c1a-4f7e-9a51-2d9c8b7a6e5f';
const request = { id, hostId: 'host', providerId: 'codex', nativeSessionId: 'thread', text: 'Run the suite when you are back.' };
const entry = { ...request, createdAt: 1_000, status: 'waiting' };

it('accepts a message to wait for its Host, text only and within its byte bound', () => {
  expect(isOutboxRequest(request)).toBe(true);
  expect(isOutboxRequest({ ...request, text: 'a'.repeat(OUTBOX_TEXT_BYTES) })).toBe(true);
  expect(isOutboxRequest({ ...request, text: '草'.repeat(OUTBOX_TEXT_BYTES / 2) })).toBe(false);
  for (const invalid of [{ ...request, text: '' }, { ...request, id: 'not-a-uuid' }, { ...request, hostId: '' }, { ...request, images: [] }]) expect(isOutboxRequest(invalid)).toBe(false);
});

it('describes an entry with its delivery status and an error only as a short reason', () => {
  for (const status of ['waiting', 'delivering', 'failed', 'unknown']) expect(isOutboxEntry({ ...entry, status })).toBe(true);
  expect(isOutboxEntry({ ...entry, status: 'failed', error: 'The session is unavailable.' })).toBe(true);
  expect(isOutboxEntry({ ...entry, status: 'sent' })).toBe(false);
  expect(isOutboxEntry({ ...entry, error: 'x'.repeat(513) })).toBe(false);
});

it('lets a Controller poll, claim and settle the messages for its Host', () => {
  expect(isOutboxHostCall({ action: 'poll' })).toBe(true);
  expect(isOutboxHostCall({ action: 'claim', id })).toBe(true);
  for (const outcome of ['accepted', 'rejected', 'unknown']) expect(isOutboxHostCall({ action: 'settle', id, outcome })).toBe(true);
  expect(isOutboxHostCall({ action: 'settle', id, outcome: 'rejected', error: 'Session not found.' })).toBe(true);
  expect(isOutboxHostCall({ action: 'settle', id, outcome: 'maybe' })).toBe(false);
  expect(isOutboxHostCall({ action: 'claim' })).toBe(false);
  const { hostId: _, ...delivery } = entry;
  expect(isOutboxPoll({ entries: [delivery, { ...delivery, status: 'delivering' }] })).toBe(true);
  expect(isOutboxPoll({ entries: [{ ...delivery, status: 'failed' }] })).toBe(false);
});

it('carries outbox requests, answers and the ready signal on the uplink', () => {
  const frame = (value: object) => decodeRemoteHostUplinkMessage(JSON.stringify({ uplinkVersion: 2, ...value })).status;
  expect(frame({ type: 'outbox_request', requestId: 'r1', call: { action: 'poll' } })).toBe('ok');
  expect(frame({ type: 'outbox_response', requestId: 'r1', status: 200, body: '{"entries":[]}' })).toBe('ok');
  expect(frame({ type: 'outbox_ready' })).toBe('ok');
  expect(frame({ type: 'outbox_ready', extra: 1 })).not.toBe('ok');
  expect(frame({ type: 'outbox_request', requestId: 'r1', call: { action: 'send' } })).not.toBe('ok');
  const registered = { type: 'registered', hostId: 'host', heartbeat: { intervalMs: 30_000, timeoutMs: 10_000 }, pairingPurpose: 'host-only' };
  expect(frame({ ...registered, outbox: 1 })).toBe('ok');
  expect(frame({ ...registered, outbox: 2 })).not.toBe('ok');
});

it('shares the outbox on the session channel', () => {
  const frame = (fields: Record<string, unknown>) => decodeSessionChannelServerMessage(JSON.stringify({ protocolVersion: '1.8.0', type: 'session_outbox', ...fields })).status;
  expect(frame({ snapshot: true, entries: [entry] })).toBe('ok');
  expect(frame({ entries: [], removed: [id] })).toBe('ok');
  expect(frame({ entries: Array.from({ length: OUTBOX_LIMIT + 1 }, () => entry) })).not.toBe('ok');
  expect(frame({ entries: [{ ...entry, status: 'sent' }] })).not.toBe('ok');
});
