/** S2, A native-prefix handoff through the Relay: the projection gap blocks input, cancel reaches the Host, and the allowance is checked before any native effect. The Relay is real and in memory; the Controller's role, context and TPM state are memory files; nothing listens on a port. */
import WebSocket from 'ws';
import { expect, test } from 'vitest';
import { successionHostFixture as fixture, ref, sendOverWebSocket, nativePrefixRequest } from '@orchardworks/agent-remote-controller/succession-host-testing';
import { enrollmentTransport } from './support/succession-relay.js';
test('native prefix enrolled Host blocks WebSocket input and background dispatch throughout projection gap', async () => {
  const f = await fixture(false, true, undefined, false, false, true, true), transport = await enrollmentTransport(f);
  try {
    const input = { operationId: 'handoff', providerId: 'fixture', nativeSessionId: 'A', expectedRevision: 1, preparation: nativePrefixRequest.preparation };
    expect(await (await transport.action('describe', { providerId: 'fixture', nativeSessionId: 'A', preparation: input.preparation })).json()).toMatchObject({ eligibility: { status: 'ready' } });
    expect((await transport.action('prepare', input)).status).toBe(200);
    transport.failProjection(true);
    expect((await transport.action('commit', { operationId: 'handoff' })).status).toBe(503);
    const b = await f.attach('B');
    expect((await sendOverWebSocket(f, b.agentId, 'blocked', '00000000-0000-4000-8000-000000009971')).type).toBe('protocol_error');
    const a = await f.attach('A'); expect(a.agentId).toBeTruthy();
    expect(f.sessions.get('B')!.sent).toEqual([]);
    expect(() => f.host.executionRouting!.assertCurrent(ref('A'), ref('B'))).toThrow(/reserved/);
    transport.failProjection(false); await transport.restart(f.restart);
    const restored = await f.attach('B');
    expect((await sendOverWebSocket(f, restored.agentId, 'still blocked', '00000000-0000-4000-8000-000000009972')).type).toBe('protocol_error');
    expect((await transport.action('status', { operationId: 'handoff', includeContext: true })).status).toBe(200);
    expect((await sendOverWebSocket(f, restored.agentId, 'edited prompt', '00000000-0000-4000-8000-000000009973')).type).toBe('command_acknowledged');
    expect(f.sessions.get('B')!.sent).toEqual(['edited prompt']); expect(f.prefixForks()).toBe(1);
  } finally { await transport.close(); await f.close(); }
}, 10000);
test('native prefix original cancel reaches the real Host with no preparation progress or fork', async () => {
  const f = await fixture(false, true, undefined, false, false, false, true), transport = await enrollmentTransport(f);
  try {
    const input = { operationId: 'prefix-cancel', providerId: 'fixture', nativeSessionId: 'A', expectedRevision: 1, preparation: nativePrefixRequest.preparation };
    const response = await transport.action('cancel', input);
    expect(await response.json()).toMatchObject({ record: { phase: 'cancelled', preparation: input.preparation } });
    await transport.restart(f.restart);
    expect((await transport.action('cancel', input)).status).toBe(200);
    expect((await transport.action('prepare', input)).status).toBe(409);
    expect(f.prefixForks()).toBe(0);
  } finally { await transport.close(); await f.close(); }
}, 10000);


test('native prefix v3 rejects an insufficient projection allowance before native effect', async () => {
  const f = await fixture(false, true, undefined, false, false, false, true), transport = await enrollmentTransport(f, undefined, { ceiling: 1 });
  try {
    const input = { operationId: 'handoff', providerId: 'fixture', nativeSessionId: 'A', expectedRevision: 1, preparation: nativePrefixRequest.preparation };
    const response = await transport.action('prepare', input);
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: 'succession_projection_capacity_exceeded' });
    expect(f.prefixForks()).toBe(0); expect(transport.saved().associations!.freezes[0]!.receipt).toMatchObject({ version: 3, maxProjectionBytes: 1 });
  } finally { await transport.close(); await f.close(); }
}, 10000);
