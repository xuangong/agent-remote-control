import { afterEach, describe, expect, it } from 'vitest';

import { connectLegacyController, SESSION, startRelayAndController, TERMINAL, until, type Relay, type Wire } from './test-utils/relay-session-harness.js';

const started: Relay[] = [];
afterEach(async () => { for (const relay of started.splice(0)) await relay.dispose(); });
async function relay(journalServed: boolean) {
  const value = await startRelayAndController({ journalServed });
  started.push(value);
  return value;
}

describe.each([['journal-served', true], ['crude', false]] as const)('session control of a %s session over real transports', (_mode, journalServed) => {
  it('grants control at once, and delivers the first send once', async () => {
    const r = await relay(journalServed);
    const opensBefore = r.streamOpens();
    const page = await r.openPage();
    const token = await page.controlled();
    expect(page.frames.find(frame => frame.type === 'negotiated')).toMatchObject({ sessionControl: true });
    if (journalServed) expect(r.streamOpens()).toBe(opensBefore);
    const answer = await page.sendText(token, 'send-1', 'First');
    expect(answer.type).toBe('command_acknowledged');
    await until(() => r.sessions.at(-1)!.sent.length === 1 ? true : undefined, 'the delivery');
    expect(r.sessions.at(-1)!.sent).toEqual(['First']);
    expect(page.frames.some(frame => JSON.stringify(frame).includes('restoring'))).toBe(false);
  });

  it('refuses a stale revision, and a mutation without a live grant before it reaches the Controller', async () => {
    const r = await relay(journalServed);
    const page = await r.openPage();
    page.send({ type: 'negotiate' });
    const announced = await page.take(frame => frame.type === 'session_control', 'the control state');
    page.send({ type: 'session_control_request', payload: { agentId: r.agentId, requestId: 'stale', revision: 'old', action: 'acquire' } });
    expect((await page.take(frame => frame.payload?.requestId === 'stale', 'the stale answer')).payload.code).toBe('session_control_changed');
    expect((await page.sendText(undefined, 'no-token')).payload.code).toBe('session_read_only');
    expect((await page.sendText('forged', 'forged')).payload.code).toBe('session_read_only');
    expect(announced.payload.access).toBe('read_only');
    expect(r.toController.some(message => message.type === 'stream_message' && String(message.message).includes('"send_message"'))).toBe(false);
    expect(r.sessions.at(-1)!.sent).toEqual([]);
  });

  it('lets two pages hold control at once, and revoking one leaves the other', async () => {
    const r = await relay(journalServed);
    const [first, second] = [await r.openPage(), await r.openPage()];
    const [firstToken, secondToken] = [await first.controlled(), await second.controlled()];
    expect(firstToken).not.toBe(secondToken);
    first.close();
    await until(() => first.closes.length > 0 ? true : undefined, 'the first page to close');
    expect((await second.sendText(secondToken, 'send-1')).type).toBe('command_acknowledged');
  });

  it('gives a page that reconnects a new grant, and the old token is invalid', async () => {
    const r = await relay(journalServed);
    const first = await r.openPage();
    const oldToken = await first.controlled();
    first.close();
    const second = await r.openPage();
    const newToken = await second.controlled();
    expect(newToken).not.toBe(oldToken);
    expect((await second.sendText(oldToken, 'old')).payload.code).toBe('session_read_only');
    expect((await second.sendText(newToken, 'new')).type).toBe('command_acknowledged');
  });
});

describe('control while the Controller is away and when it returns', () => {
  it('grants control and keeps reading while the Host is offline, refuses a send as recoverable, and delivers once the Host is back without closing the page', async () => {
    const r = await relay(true);
    const page = await r.openPage();
    const token = await page.controlled();
    await r.stopController();
    const refused = await page.sendText(token, 'offline');
    expect(refused.payload).toMatchObject({ code: 'host_offline', recoverable: true });
    expect(page.closes).toEqual([]);
    const later = await r.openPage();
    expect(await later.controlled()).toEqual(expect.any(String));
    await r.startController();
    await until(async () => (await r.hostsOnline()) ? true : undefined, 'the Host to return');
    expect(page.closes).toEqual([]);
    expect(page.frames.some(frame => JSON.stringify(frame).match(/Reconnecting|Restoring|Checking access/))).toBe(false);
    const delivered = await page.sendText(token, 'back');
    expect(delivered.type).toBe('command_acknowledged');
    expect(page.closes).toEqual([]);
  });
});

describe.each([['journal-served', true], ['crude', false]] as const)('a terminal driving a %s session', (_mode, journalServed) => {
  it('refuses the send at delivery, keeps the text out of the session, shows the owner, and refuses again until take-over', async () => {
    const r = await relay(journalServed);
    const page = await r.openPage();
    const token = await page.controlled();
    expect((await page.sendText(token, 'before')).type).toBe('command_acknowledged');
    const sentBefore = r.sessions.flatMap(session => session.sent).length;
    await r.terminalTakes();
    const refused = await page.sendText(token, 'raced');
    expect(refused.payload.code).toBe('native_session_owned');
    const state = await page.take(frame => frame.type === 'session_control' && !frame.payload.requestId && frame.payload.nativeOwner, 'the owner');
    expect(state.payload).toMatchObject({ access: 'read_only', available: false, nativeOwner: { kind: 'native_cli', generation: TERMINAL } });
    expect(r.sessions.flatMap(session => session.sent).length).toBe(sentBefore);
    expect((await page.sendText(token, 'again')).payload.code).toBe('session_read_only');
  });
});

describe.each([['journal-served', true], ['crude', false]] as const)('taking a %s session back from a terminal', (_mode, journalServed) => {
  it('gives control back after the take-over, and the first message after it is delivered', async () => {
    const r = await relay(journalServed);
    const page = await r.openPage();
    const token = await page.controlled();
    await r.terminalTakes();
    expect((await page.sendText(token, 'raced')).payload.code).toBe('native_session_owned');
    const owned = await page.take(frame => frame.type === 'session_control' && frame.payload.nativeOwner, 'the owner');
    const takeOver = await r.attach(owned.payload.nativeOwner.generation);
    expect(takeOver.status).toBe(200);
    // The client opens a new stream after a take-over: the Controller session of the old one is the one the terminal closed.
    const current = await r.openPage();
    current.send({ type: 'negotiate' });
    const announced = await current.take(frame => frame.type === 'session_control', 'the control state');
    current.send({ type: 'session_control_request', payload: { agentId: r.agentId, requestId: 'take', revision: announced.payload.revision, action: 'acquire' } });
    const granted = await current.take(frame => frame.type === 'session_control' && frame.payload.requestId === 'take', 'control after take-over');
    expect(granted.payload).toMatchObject({ access: 'control', available: true });
    expect(granted.payload.nativeOwner).toBeUndefined();
    expect((await current.sendText(granted.payload.token, 'after')).type).toBe('command_acknowledged');
    await until(() => r.sessions.flatMap(session => session.sent).includes('Hi') ? true : undefined, 'the delivery');
    expect(page.closes).toEqual([]);
  });

  it('refuses a take-over with a stale generation and changes nothing', async () => {
    const r = await relay(journalServed);
    await r.terminalTakes();
    const refused = await r.attach('22222222-2222-4222-8222-222222222222');
    expect(refused.body.code).toBe('native_owner_changed');
    expect((await r.attach()).body.code).toBe('native_session_owned');
  });

  it('shows no owner on a new stream after the terminal exits, and on its own stream after the next acquire', async () => {
    const r = await relay(journalServed);
    const page = await r.openPage();
    const token = await page.controlled();
    await r.terminalTakes();
    await page.sendText(token, 'raced');
    const owned = await page.take(frame => frame.type === 'session_control' && frame.payload.nativeOwner, 'the owner');
    r.terminalExits();
    const fresh = await r.openPage();
    fresh.send({ type: 'negotiate' });
    const announced = await fresh.take(frame => frame.type === 'session_control', 'the control state');
    expect(announced.payload.nativeOwner).toBeUndefined();
    page.send({ type: 'session_control_request', payload: { agentId: r.agentId, requestId: 'again', revision: owned.payload.revision, action: 'acquire' } });
    const granted = await page.take(frame => frame.type === 'session_control' && frame.payload.requestId === 'again', 'the grant');
    expect(granted.payload.nativeOwner).toBeUndefined();
    expect(granted.payload.access).toBe('control');
  });

  it('shows the owner only on the stream whose send was refused', async () => {
    const r = await relay(journalServed);
    const [first, second] = [await r.openPage(), await r.openPage()];
    const [firstToken, secondToken] = [await first.controlled(), await second.controlled()];
    await r.terminalTakes();
    expect((await first.sendText(firstToken, 'raced')).payload.code).toBe('native_session_owned');
    await first.take(frame => frame.type === 'session_control' && frame.payload.nativeOwner, 'the owner');
    expect(second.frames.some(frame => frame.type === 'session_control' && frame.payload.nativeOwner)).toBe(false);
    expect((await second.sendText(secondToken, 'also-raced')).payload.code).toBe('native_session_owned');
  });
});

describe('a Controller from before session control moved to the Relay', () => {
  it('registers, appears in the Hosts list and answers update requests, but cannot open sessions until it is updated', async () => {
    const r = await startRelayAndController({ journalServed: false, withoutController: true });
    started.push(r);
    const legacy = await connectLegacyController(r);
    try {
      expect(legacy.reply.type).toBe('registered');
      expect(legacy.reply).not.toHaveProperty('control');
      const hosts = (await (await r.broker.handleRequest(new Request(`${r.origin}/v1/remote/hosts`)))!.json()) as { hosts: Array<Record<string, unknown>> };
      expect(hosts.hosts).toHaveLength(1);
      expect(hosts.hosts[0]).toMatchObject({ name: 'Legacy Host', online: true });
      expect(hosts.hosts[0]).not.toHaveProperty('sessionControl');
      const hostId = hosts.hosts[0]!.id as string;
      // The update path: the Relay asks the Controller for its update state, which the website reads before an update.
      const update = await r.broker.handleRequest(new Request(`${r.origin}/v1/remote/hosts/${hostId}/controller-update`, { headers: { origin: r.origin } }));
      expect(update?.status).toBe(200);
      expect(await update!.json()).toMatchObject({ status: 'idle' });
      expect(legacy.requests).toContain('GET /remote/controller-update');
      // Opening a session is refused with the words the page shows, and nothing reaches the Controller's session wire.
      const attached = await r.broker.handleRequest(new Request(`${r.origin}/v1/remote/hosts/${hostId}/attach`, { method: 'POST', body: JSON.stringify({ providerId: 'fake', nativeSessionId: SESSION }) }));
      expect(attached?.status).toBe(409);
      expect(await attached!.json()).toMatchObject({ code: 'controller_upgrade_required', error: expect.stringContaining('Update required') });
      expect(legacy.received.some(message => message.type === 'stream_open')).toBe(false);
    } finally { legacy.close(); }
  });
});

describe('a stream that passes through the Relay, over real transports', () => {
  it('refuses a mutation sent before negotiation and one that does not decode, and delivers neither', async () => {
    const r = await relay(false);
    const page = await r.openPage();
    page.send({ type: 'send_message', controlToken: 'forged', payload: { agentId: r.agentId, requestId: 'early', operationId: '00000000-0000-4000-8000-0000000000aa', text: 'early' } });
    expect((await page.take(frame => frame.payload?.requestId === 'early', 'the early refusal')).payload.code).toBe('session_read_only');
    page.send({ type: 'send_message', controlToken: 'forged', payload: { agentId: r.agentId, requestId: 'broken' } });
    expect((await page.take(frame => frame.payload?.requestId === 'broken', 'the refusal')).payload.code).toBe('invalid_shape');
    const token = await page.controlled();
    expect((await page.sendText(token, 'fine')).type).toBe('command_acknowledged');
    expect(r.sessions.flatMap(session => session.sent)).toEqual(['Hi']);
  });
});
