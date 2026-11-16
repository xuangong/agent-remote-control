import { afterEach, expect, it } from 'vitest';

import { DIGEST, PUBLIC_ID, row, startRelay, STORE_KEY, snapshot, until } from './test-utils/journal-session-fixture.js';

const started: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => { for (const relay of started.splice(0)) await relay.dispose(); });
async function relay(options: Parameters<typeof startRelay>[0] = {}) {
  const value = await startRelay(options);
  started.push(value);
  return value;
}
type Relay = Awaited<ReturnType<typeof relay>>;

/** A Controller that opened the session's journal and published two complete rows and a head. */
async function publishedController(r: Relay, behavior: Parameters<Relay['connectController']>[0] = {}) {
  const controller = await r.connectController(behavior);
  await controller.open();
  await controller.publish([
    { op: 'append', row: row('m1', 'Hello') }, { op: 'complete', itemKey: 'm1', digest: DIGEST },
    { op: 'append', row: row('m2', 'World') }, { op: 'complete', itemKey: 'm2', digest: DIGEST },
    { op: 'head', head: { snapshot: snapshot('idle', 'native-session'), observedAt: 5 } },
  ]);
  await r.store.load(STORE_KEY);
  return controller;
}

async function readThrough(browser: Awaited<ReturnType<Relay['openBrowser']>>, controller: Awaited<ReturnType<typeof publishedController>>, negotiate: Record<string, unknown>) {
  browser.send({ type: 'negotiate', ...negotiate });
  await browser.take(message => message.type === 'agent_snapshot', 'Snapshot');
  browser.send({ type: 'timeline_subscription', payload: { requestId: 'sub', agentIds: [PUBLIC_ID] } });
  await browser.take(message => message.type === 'timeline_subscribed', 'subscription');
  browser.send({ type: 'timeline_request', payload: { requestId: 'page', agentId: PUBLIC_ID, direction: 'tail', limit: 100 } });
  const page = await browser.take(message => message.type === 'timeline_page', 'page');
  await controller.publish([{ op: 'append', row: row('m3', 'Live') }]);
  const live = await until(() => browser.frames.find(frame => frame.type === 'agent_stream'), 'a live row');
  return { negotiated: browser.frames.find(frame => frame.type === 'negotiated')!, page, live };
}

it('gives a flagged client item keys on pages and live frames and echoes the flag', async () => {
  const r = await relay();
  const controller = await publishedController(r);
  const { negotiated, page, live } = await readThrough(await r.openBrowser(), controller, { itemKeys: true });
  expect(negotiated).toMatchObject({ type: 'negotiated', itemKeys: true });
  expect(page.payload.entries.map((entry: { itemKey?: string }) => entry.itemKey)).toEqual(['m1', 'm2']);
  expect(live.payload.event).toMatchObject({ type: 'timeline', itemKey: 'm3' });
});

it('gives an unflagged client the frames it always had: no flag, no item keys', async () => {
  const r = await relay();
  const controller = await publishedController(r);
  const browser = await r.openBrowser();
  const { negotiated, page, live } = await readThrough(browser, controller, {});
  expect(negotiated).not.toHaveProperty('itemKeys');
  expect(JSON.stringify([page, live])).not.toContain('itemKey');
  expect(JSON.stringify(browser.frames)).not.toContain('itemKey');
});

it('does not pass the flag to the Controller of a journal-served session, whose own stream decodes negotiate strictly', async () => {
  const r = await relay();
  const controller = await publishedController(r, { strictNegotiate: true });
  const browser = await r.openBrowser();
  await readThrough(browser, controller, { itemKeys: true });
  const stream = await until(() => controller.streams[0], 'the Controller stream');
  const negotiates = stream.received.filter(message => message.type === 'negotiate');
  expect(negotiates).toHaveLength(1);
  expect(negotiates[0]).not.toHaveProperty('itemKeys');
  expect(browser.frames.some(frame => frame.type === 'protocol_error')).toBe(false);
});

it('opens a flagged client on a session a Controller answers, without the flag reaching the Controller, an echo or an error', async () => {
  const r = await relay();
  const controller = await r.connectController({ journal: false, strictNegotiate: true });
  const browser = await r.openBrowser();
  browser.send({ type: 'negotiate', itemKeys: true });
  const negotiated = await browser.take(message => message.type === 'negotiated' || message.type === 'protocol_error', 'the answer to negotiate');
  expect(negotiated.type).toBe('negotiated');
  expect(negotiated).not.toHaveProperty('itemKeys');
  const stream = await until(() => controller.streams[0], 'the Controller stream');
  expect(stream.received.find(message => message.type === 'negotiate')).not.toHaveProperty('itemKeys');
  await browser.take(message => message.type === 'agent_snapshot', 'Snapshot');
  expect(browser.frames.some(frame => frame.type === 'protocol_error')).toBe(false);
});
