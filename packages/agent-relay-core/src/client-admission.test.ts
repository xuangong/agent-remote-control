import { describe, expect, it } from 'vitest';
import { encodeClientMessage, PROTOCOL_VERSION } from '@orchardworks/agent-remote-protocol';
import { createClientAdmission } from './client-admission.js';
import type { BrokerRequestContext, RelaySocket } from './transport.js';

const KIB = 1024;

function stream(options: { now?: { value: number }; owner?: boolean; context?: BrokerRequestContext; expiry?: () => number | undefined } = {}) {
  const clock = options.now ?? { value: 1_000 };
  const closed: Array<{ code: number; reason: string }> = [];
  const sent: unknown[] = [];
  const client = { close: (code: number, reason: string) => { closed.push({ code, reason }); }, send: (data: string) => { sent.push(JSON.parse(data)); } } as unknown as RelaySocket;
  const admit = createClientAdmission({ now: () => clock.value, owner: () => options.owner ?? true })(client, options.context ?? {}, 'alice', options.expiry ?? (() => undefined));
  return { admit, closed, sent, clock };
}
const message = (type: string, size = 0) => JSON.stringify({ type, payload: { pad: 'x'.repeat(size) } });
const admitAll = (s: ReturnType<typeof stream>, raw: string, times: number) => { for (let at = 0; at < times; at++) if (!s.admit(raw, false)) return at; return times; };

describe('client admission', () => {
  it('refuses a binary frame and a message that is not JSON, closing with the protocol codes', () => {
    const a = stream(); expect(a.admit('{}', true)).toBe(false); expect(a.closed).toEqual([{ code: 1003, reason: 'Text protocol required' }]);
    const b = stream(); expect(b.admit('not json', false)).toBe(false); expect(b.closed).toEqual([{ code: 1008, reason: 'Invalid session message' }]);
  });

  it('allows 120 control messages in a window and refuses the 121st, then allows again in the next window', () => {
    const s = stream();
    expect(admitAll(s, message('send_message'), 120)).toBe(120); expect(s.closed).toEqual([]);
    expect(s.admit(message('send_message'), false)).toBe(false);
    expect(s.closed).toEqual([{ code: 1008, reason: 'Control message rate exceeded' }]);
    const next = stream(); admitAll(next, message('send_message'), 120); next.clock.value += 60_000;
    expect(next.admit(message('send_message'), false)).toBe(true);
  });

  it('keeps a window for 59 seconds and starts a new one at 60', () => {
    const s = stream(); admitAll(s, message('send_message'), 120);
    s.clock.value += 59_999; expect(s.admit(message('send_message'), false)).toBe(false);
  });

  it('counts timeline requests apart from control messages: 600 reads, then a refusal, while control stays open', () => {
    const s = stream();
    expect(admitAll(s, message('timeline_request'), 600)).toBe(600);
    expect(s.admit(message('send_message'), false)).toBe(true);
    expect(s.admit(message('timeline_request'), false)).toBe(false);
    expect(s.closed).toEqual([{ code: 1008, reason: 'Timeline request rate exceeded' }]);
  });

  it('limits an image upload by the size of a chunk, their count and their total bytes', () => {
    const big = stream(); expect(big.admit(message('image_upload_chunk', 48 * KIB), false)).toBe(false);
    expect(big.closed).toEqual([{ code: 1008, reason: 'Image upload rate exceeded' }]);
    const count = stream(); expect(admitAll(count, message('image_upload_chunk'), 2048)).toBe(2048);
    expect(count.admit(message('image_upload_chunk'), false)).toBe(false);
    const bytes = stream(), chunk = message('image_upload_chunk', 47 * KIB);
    expect(admitAll(bytes, chunk, 1100)).toBe(Math.floor(48 * 1024 * KIB / Buffer.byteLength(chunk)));
    expect(bytes.closed).toEqual([{ code: 1008, reason: 'Image upload rate exceeded' }]);
  });

  it.each(['resource_upload_chunk', 'resource_download_request', 'resource_resolve_request', 'resource_request'])('counts %s as a resource transfer, not a control message', type => {
    const s = stream(), raw = message(type);
    expect(admitAll(s, raw, 8192)).toBe(8192); expect(s.admit(raw, false)).toBe(false);
    expect(s.closed).toEqual([{ code: 1008, reason: 'Resource transfer rate exceeded' }]);
    const control = stream(); admitAll(control, raw, 200); expect(control.admit(message('send_message'), false)).toBe(true);
  });

  it('refuses a resource message over 48 KiB, and total resource bytes over 192 MiB', () => {
    const big = stream(); expect(big.admit(message('resource_request', 48 * KIB), false)).toBe(false);
    const total = stream(), chunk = message('resource_upload_chunk', 47 * KIB);
    const accepted = admitAll(total, chunk, 5000);
    expect(accepted).toBe(Math.floor(192 * 1024 * KIB / Buffer.byteLength(chunk)));
  });

  it('answers a message that needs a fresh sign-in with reauthentication_required and keeps the stream open', () => {
    const s = stream({ context: { authorizeMessage: () => false } });
    const raw = encodeClientMessage({ protocolVersion: PROTOCOL_VERSION, type: 'send_message', controlToken: 'token', payload: { requestId: 'r-1', operationId: '00000000-0000-4000-8000-000000000001', agentId: 'a', text: 'hi' } } as never);
    if (raw.status !== 'ok') throw new Error(`the fixture message must encode: ${JSON.stringify(raw)}`);
    expect(s.admit(raw.json, false)).toBe(false);
    expect(s.closed).toEqual([]);
    expect(s.sent).toEqual([{ protocolVersion: PROTOCOL_VERSION, type: 'protocol_error', payload: { requestId: 'r-1', code: 'reauthentication_required', message: expect.any(String), recoverable: true } }]);
  });

  it('closes the stream when a message that needs a fresh sign-in cannot be read for its request id', () => {
    const s = stream({ context: { authorizeMessage: () => false } });
    expect(s.admit(message('unknown_type'), false)).toBe(false);
    expect(s.closed).toEqual([{ code: 1008, reason: 'Invalid session message' }]);
  });

  it('lets only the Host owner resolve a locator other than an input image', () => {
    const input = JSON.stringify({ type: 'resource_resolve_request', payload: { locator: 'input-image:00000000-0000-0000-0000-000000000000' } });
    const file = JSON.stringify({ type: 'resource_resolve_request', payload: { locator: 'file:/etc/passwd' } });
    const guest = stream({ owner: false });
    expect(guest.admit(input, false)).toBe(true);
    expect(guest.admit(file, false)).toBe(false);
    expect(guest.closed).toEqual([{ code: 1008, reason: expect.stringContaining('Only the Host owner') }]);
    expect(stream({ owner: true }).admit(file, false)).toBe(true);
  });

  it('refuses every message once the credential has expired, and none while it has not', () => {
    const clock = { value: 1_000 };
    expect(stream({ now: clock, expiry: () => 1_001 }).admit(message('send_message'), false)).toBe(true);
    const expired = stream({ now: clock, expiry: () => 1_000 });
    expect(expired.admit(message('send_message'), false)).toBe(false);
    expect(expired.closed).toEqual([{ code: 1008, reason: 'Credential expired' }]);
    expect(stream({ now: clock, expiry: () => undefined }).admit(message('send_message'), false)).toBe(true);
  });
});
