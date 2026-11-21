import { afterEach, expect, it } from 'vitest';

import { PUBLIC_ID, SESSION_KEY, sleep, startRelay } from './test-utils/journal-session-fixture.js';

/**
 * Visibility over the uplink: the Relay tells a Controller that asked for it (`journalShown=1`) the complete set of its sessions that
 * pages show (`journal_shown`), when it registers and whenever the set changes, and attaches a shown session the Controller does not hold.
 */
const started: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => { for (const relay of started.splice(0)) await relay.dispose(); });
async function relay() {
  const value = await startRelay();
  started.push(value);
  return value;
}
async function journalServed(r: Awaited<ReturnType<typeof relay>>, controller: Awaited<ReturnType<Awaited<ReturnType<typeof relay>>['connectController']>>) {
  await controller.open();
  await controller.publish([{ op: 'head', head: { snapshot: { id: 'native-session', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle', activeTurn: null,
    capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } }, pendingInteractions: [],
    runtimeInfo: { providerId: 'codex', sessionId: 'native-session', status: 'idle' } }, observedAt: 5 } }]);
  return r;
}

it('tells a Controller that asked which sessions pages show: none at registration, then each change as pages open and close', async () => {
  const r = await relay();
  const controller = await r.connectController({ shown: true });
  expect(await controller.inbox.take(message => message.type === 'journal_shown', 'the set at registration')).toMatchObject({ sessionKeys: [] });
  await journalServed(r, controller);
  const page = await r.openBrowser();
  page.send({ type: 'negotiate' });
  expect(await controller.inbox.take(message => message.type === 'journal_shown', 'the page showing the session')).toMatchObject({ sessionKeys: [SESSION_KEY] });
  const second = await r.openBrowser();
  second.send({ type: 'negotiate' });
  page.pair.native.close(1000);
  second.pair.native.close(1000);
  expect(await controller.inbox.take(message => message.type === 'journal_shown', 'the last page leaving')).toMatchObject({ sessionKeys: [] });
  await sleep(20);
  expect(controller.inbox.all.filter(message => message.type === 'journal_shown')).toHaveLength(3);
});

it('does not count a page that only observes activity', async () => {
  const r = await relay();
  const controller = await r.connectController({ shown: true });
  await journalServed(r, controller);
  const observer = await r.openBrowser();
  observer.send({ type: 'negotiate', observation: 'activity' });
  await observer.take(message => message.type === 'agent_activity', 'activity');
  expect(controller.inbox.all.filter(message => message.type === 'journal_shown').map(message => message.sessionKeys)).toEqual([[]]);
});

it('tells a Controller that did not ask nothing, so a Controller from before visibility keeps its connection', async () => {
  const r = await relay();
  const controller = await r.connectController();
  await journalServed(r, controller);
  const page = await r.openBrowser();
  page.send({ type: 'negotiate' });
  await page.take(message => message.type === 'agent_snapshot', 'Snapshot');
  expect(controller.inbox.all.some(message => message.type === 'journal_shown')).toBe(false);
  expect(controller.pair.native.readyState).toBe(1);
});

it('attaches a shown session again on the Controller that replaced the one holding it, so it stays resident', async () => {
  const r = await relay();
  const first = await r.connectController({ shown: true });
  await journalServed(r, first);
  const page = await r.openBrowser();
  page.send({ type: 'negotiate' });
  await first.inbox.take(message => message.type === 'journal_shown' && message.sessionKeys.length === 1, 'the page showing the session');
  first.disconnect();
  await sleep(20);
  const second = await r.connectController({ shown: true });
  expect(await second.inbox.take(message => message.type === 'journal_shown', 'the set at registration')).toMatchObject({ sessionKeys: [SESSION_KEY] });
  // The attach follows the set at once, before the fixture answers attaches, so it is read from what the Relay sent.
  const attach = await second.inbox.take(message => message.type === 'rpc_request' && message.path === '/remote/attach', 'the attach of the shown session');
  expect(JSON.parse(attach.body)).toMatchObject({ providerId: 'codex', nativeSessionId: 'native-session' });
  expect(attach.sessionId).toBe(PUBLIC_ID);
});
