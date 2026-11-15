import { acceptSessionChannel, PROTOCOL_VERSION, SESSION_CAPACITY_CLOSE_CODE } from '@orchardworks/agent-remote-protocol';
import { afterEach, expect, it } from 'vitest';

import { collect, DIGEST, PUBLIC_ID, row, seedJournal, SESSION_KEY, sleep, snapshot, socketPair, startRelay, STORE_KEY, until, type Wire } from './test-utils/journal-session-fixture.js';

const started: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => { for (const relay of started.splice(0)) await relay.dispose(); });
async function relay(options: Parameters<typeof startRelay>[0] = {}) {
  const value = await startRelay(options);
  started.push(value);
  return value;
}
type Relay = Awaited<ReturnType<typeof relay>>;
type Browser = Awaited<ReturnType<Relay['openBrowser']>>;

const OPERATION = '00000000-0000-4000-8000-000000000001';
const texts = (page: Wire) => page.payload.entries.map((entry: Wire) => entry.item.text);
const tail = (requestId: string) => ({ type: 'timeline_request', payload: { requestId, agentId: PUBLIC_ID, direction: 'tail', limit: 100 } });

/** A Controller that opened the session's journal and published two complete rows and a head. */
async function publishedController(r: Relay, behavior: Parameters<Relay['connectController']>[0] = {}) {
  const controller = await r.connectController(behavior);
  const opened = await controller.open();
  await controller.publish([
    { op: 'append', row: row('m1', 'Hello') }, { op: 'complete', itemKey: 'm1', digest: DIGEST },
    { op: 'append', row: row('m2', 'World') }, { op: 'complete', itemKey: 'm2', digest: DIGEST },
    { op: 'head', head: { snapshot: snapshot('idle', 'native-session'), observedAt: 5 } },
  ]);
  return { controller, epoch: opened.epoch as string };
}

/** Negotiates and subscribes, and waits for the acknowledgement. */
async function subscribed(browser: Browser) {
  browser.send({ type: 'negotiate' });
  await browser.take(message => message.type === 'agent_snapshot', 'Snapshot');
  browser.send({ type: 'timeline_subscription', payload: { requestId: 'sub-1', agentIds: [PUBLIC_ID] } });
  await browser.take(message => message.type === 'timeline_subscribed', 'subscription acknowledgement');
}

it('serves negotiation, the Snapshot, the subscription and a page from the journal while the Host is offline', async () => {
  const r = await relay();
  const { controller, epoch } = await publishedController(r);
  controller.disconnect();
  await sleep(20);
  const browser = await r.openBrowser();
  browser.send({ type: 'negotiate' });
  await browser.take(message => message.type === 'agent_snapshot', 'Snapshot');
  expect(browser.frames.map(frame => frame.type)).toEqual(['negotiated', 'agent_snapshot', 'session_control']);
  expect(browser.frames[0]).toMatchObject({ sessionControl: true });
  expect(browser.frames[1]!.payload).toMatchObject({ id: PUBLIC_ID, status: 'idle', runtimeInfo: { connection: { state: 'restoring' } } });
  expect(browser.frames[2]!.payload).toMatchObject({ agentId: PUBLIC_ID, revision: 'relay-pending', access: 'read_only', available: false });
  browser.send({ type: 'timeline_subscription', payload: { requestId: 'sub-1', agentIds: [PUBLIC_ID] } });
  expect(await browser.take(message => message.type === 'timeline_subscribed', 'acknowledgement')).toMatchObject({ payload: { requestId: 'sub-1', agentIds: [PUBLIC_ID] } });
  browser.send(tail('page-1'));
  const page = await browser.take(message => message.type === 'timeline_page', 'page');
  expect(page.payload).toMatchObject({ agentId: PUBLIC_ID, epoch, hasOlder: true, hasNewer: false, window: { minSeq: 1, maxSeq: 2, nextSeq: 3 } });
  expect(texts(page)).toEqual(['Hello', 'World']);
  expect(controller.streams).toEqual([]);
  expect(browser.pair.server.readyState).toBe(1);
});

it('delivers live rows to subscribers in order, after the subscription is acknowledged, with the journal\'s dense sequences', async () => {
  const r = await relay();
  const { controller, epoch } = await publishedController(r);
  const browser = await r.openBrowser();
  await subscribed(browser);
  await controller.publish([
    { op: 'append', row: row('m3', 'Hel') }, { op: 'append', row: row('m3', 'lo') },
    { op: 'complete', itemKey: 'm3', digest: DIGEST }, { op: 'append', row: row('m4', 'Next') },
  ]);
  await until(() => browser.frames.filter(frame => frame.type === 'agent_stream').length === 3 ? true : undefined, 'three live rows');
  const live = browser.frames.filter(frame => frame.type === 'agent_stream');
  expect(live.map(frame => [frame.payload.epoch, frame.payload.seq])).toEqual([[epoch, 3], [epoch, 4], [epoch, 5]]);
  expect(live.map(frame => frame.payload.event.item.text)).toEqual(['Hel', 'lo', 'Next']);
  expect(browser.frames.findIndex(frame => frame.type === 'timeline_subscribed')).toBeLessThan(browser.frames.findIndex(frame => frame.type === 'agent_stream'));
});

it('does not send a correction live; the next page after the client\'s cursor carries it', async () => {
  const r = await relay();
  const { controller, epoch } = await publishedController(r);
  const browser = await r.openBrowser();
  await subscribed(browser);
  const revision = (await r.store.load(STORE_KEY))!.items.find(item => item.itemKey === 'm1')!.revision;
  await controller.publish([
    { op: 'correct', row: row('m1', 'Hello corrected'), digest: DIGEST, expectedRevision: revision },
    { op: 'append', row: row('m3', 'Next') },
  ]);
  await until(() => browser.frames.some(frame => frame.type === 'agent_stream') ? true : undefined, 'the live row');
  expect(browser.frames.filter(frame => frame.type === 'agent_stream').map(frame => frame.payload.seq)).toEqual([4]);
  browser.send({ type: 'timeline_request', payload: { requestId: 'page-2', agentId: PUBLIC_ID, direction: 'after', cursor: { epoch, seq: 2 }, limit: 100 } });
  expect(texts(await browser.take(message => message.type === 'timeline_page', 'page'))).toEqual(['Hello corrected', 'Next']);
});

it('announces a replacement to subscribers and serves the new epoch', async () => {
  const r = await relay();
  const { controller, epoch } = await publishedController(r);
  const browser = await r.openBrowser();
  await subscribed(browser);
  await controller.publish([{ op: 'replace', items: [{ row: row('x1', 'Fresh'), digest: DIGEST }] }]);
  const replaced = await browser.take(message => message.type === 'timeline_replacement', 'replacement');
  const stored = (await r.store.load(STORE_KEY))!;
  expect(stored.meta.epoch).not.toBe(epoch);
  expect(replaced.payload).toEqual({ agentId: PUBLIC_ID, epoch: stored.meta.epoch });
  browser.send(tail('page-2'));
  const page = await browser.take(message => message.type === 'timeline_page', 'page');
  expect(page.payload.epoch).toBe(stored.meta.epoch);
  expect(texts(page)).toEqual(['Fresh']);
});

it('forwards head changes as updates and shows the runtime as restoring until the Controller stream is ready', async () => {
  const r = await relay();
  const { controller } = await publishedController(r, { answerStreams: false });
  const browser = await r.openBrowser();
  await subscribed(browser);
  const stream = await until(() => controller.streams[0], 'the Controller stream');
  await controller.publish([{ op: 'head', head: { snapshot: snapshot('running', 'native-session'), observedAt: 6 } }]);
  const update = await browser.take(message => message.type === 'agent_update', 'update');
  expect(update.payload).toMatchObject({ id: PUBLIC_ID, status: 'running', runtimeInfo: { connection: { state: 'restoring' } } });
  controller.acceptStream(stream.streamId);
  const ready = await browser.take(message => message.type === 'agent_update', 'update once the stream is ready');
  expect(ready.payload).toMatchObject({ id: PUBLIC_ID, status: 'running' });
  expect(ready.payload.runtimeInfo.connection).toBeUndefined();
});

it('asks the Controller to fill a missing body before answering a page', async () => {
  const r = await relay({ seed: store => seedJournal(store, { evict: true }) });
  const controller = await r.connectController();
  const browser = await r.openBrowser();
  browser.send({ type: 'negotiate' });
  await browser.take(message => message.type === 'agent_snapshot', 'Snapshot');
  browser.send(tail('page-1'));
  const request = await controller.inbox.take(message => message.type === 'journal_fill_request', 'fill request');
  expect(request).toMatchObject({ sessionKey: SESSION_KEY, itemKeys: ['m1'] });
  controller.send({ type: 'journal_fill', requestId: request.requestId, sessionKey: SESSION_KEY, items: [{ row: row('m1', 'Hello'), digest: DIGEST }] });
  expect(texts(await browser.take(message => message.type === 'timeline_page', 'page'))).toEqual(['Hello']);
});

it('asks the Controller for older history when a before page reaches the start, and answers with what it published', async () => {
  const r = await relay();
  const { controller, epoch } = await publishedController(r);
  const browser = await r.openBrowser();
  await subscribed(browser);
  browser.send({ type: 'timeline_request', payload: { requestId: 'older-1', agentId: PUBLIC_ID, direction: 'before', cursor: { epoch, seq: 1 }, limit: 50 } });
  const request = await controller.inbox.take(message => message.type === 'journal_older_request', 'older request');
  expect(request).toMatchObject({ sessionKey: SESSION_KEY, limit: 50 });
  await controller.publish([{ op: 'prepend', items: [{ row: row('m0', 'Before'), digest: DIGEST }] }]);
  controller.send({ type: 'journal_older_done', requestId: request.requestId, sessionKey: SESSION_KEY, olderAvailable: false });
  const page = await browser.take(message => message.type === 'timeline_page', 'page');
  expect(page.payload).toMatchObject({ direction: 'before', hasOlder: false });
  expect(texts(page)).toEqual(['Before']);
});

it('sends operations and control to the Controller stream, returns its acknowledgements and drops its read frames', async () => {
  const r = await relay();
  const { controller } = await publishedController(r);
  const browser = await r.openBrowser();
  await subscribed(browser);
  const stream = await until(() => controller.streams[0], 'the Controller stream');
  await until(() => stream.received.some(message => message.type === 'negotiate') ? true : undefined, 'the Relay\'s negotiation');
  await browser.take(message => message.type === 'session_control' && message.payload.revision === 'rev-1', 'the Controller\'s control state');
  browser.send({ type: 'session_control_request', payload: { agentId: PUBLIC_ID, requestId: 'control-1', revision: 'relay-pending', action: 'acquire' } });
  expect(await browser.take(message => message.type === 'session_control' && message.payload.requestId === 'control-1', 'control')).toMatchObject({ payload: { access: 'control', token: 'token-1' } });
  browser.send({ type: 'send_message', controlToken: 'token-1', payload: { requestId: 'send-1', operationId: OPERATION, agentId: PUBLIC_ID, text: 'Hi' } });
  expect(await browser.take(message => message.type === 'command_acknowledged', 'acknowledgement')).toMatchObject({ payload: { requestId: 'send-1', command: 'send_message' } });
  controller.toStream(stream.streamId, { type: 'agent_update', payload: snapshot('running', PUBLIC_ID) });
  controller.toStream(stream.streamId, { type: 'agent_stream', payload: { agentId: PUBLIC_ID, timestamp: 't', event: { type: 'turn_started', providerId: 'codex' } } });
  controller.toStream(stream.streamId, { type: 'timeline_subscribed', payload: { requestId: 'x', agentIds: [PUBLIC_ID] } });
  await sleep(50);
  expect(browser.frames.filter(frame => frame.type === 'negotiated')).toHaveLength(1);
  expect(browser.frames.filter(frame => frame.type === 'agent_snapshot')).toHaveLength(1);
  expect(browser.frames.filter(frame => frame.type === 'agent_snapshot' || frame.type === 'agent_update').every(frame => frame.payload.status === 'idle')).toBe(true);
  expect(browser.frames.filter(frame => frame.type === 'agent_stream' || frame.type === 'timeline_subscribed')).toHaveLength(1);
  expect(stream.received.map(message => message.type)).toEqual(['negotiate', 'session_control_request', 'send_message']);
  expect(stream.received[1]!.payload.revision).toBe('rev-1');
  expect(controller.attaches).toHaveLength(1);
});

it('closes the Controller stream when the browser stream ends', async () => {
  const r = await relay();
  const { controller } = await publishedController(r);
  const browser = await r.openBrowser();
  await subscribed(browser);
  const stream = await until(() => controller.streams[0], 'the Controller stream');
  await until(() => stream.received.some(message => message.type === 'negotiate') ? true : undefined, 'the Relay\'s negotiation');
  browser.pair.native.close(1000);
  expect(await controller.inbox.take(message => message.type === 'stream_close', 'stream_close')).toMatchObject({ streamId: stream.streamId, code: 1000 });
});

it('answers an operation with the reason when the Host is offline, and keeps serving reads', async () => {
  const r = await relay();
  const { controller } = await publishedController(r);
  controller.disconnect();
  await sleep(20);
  const browser = await r.openBrowser();
  await subscribed(browser);
  browser.send({ type: 'send_message', payload: { requestId: 'send-1', operationId: OPERATION, agentId: PUBLIC_ID, text: 'Hi' } });
  expect(await browser.take(message => message.type === 'protocol_error' && message.payload.requestId === 'send-1', 'refusal')).toMatchObject({ payload: { code: 'host_offline', recoverable: true } });
  expect(browser.pair.server.readyState).toBe(1);
  browser.send(tail('page-1'));
  expect(texts(await browser.take(message => message.type === 'timeline_page', 'page'))).toEqual(['Hello', 'World']);
});

it('limits and authorizes the messages it answers itself like the ones it forwards', async () => {
  const r = await relay({ seed: store => seedJournal(store) });
  const browser = await r.openBrowser({ authorizeMessage: () => false });
  browser.send(tail('page-1'));
  expect(await browser.take(message => message.type === 'protocol_error' && message.payload.requestId === 'page-1', 'refusal')).toMatchObject({ payload: { code: 'reauthentication_required' } });
  const limited = await r.openBrowser();
  limited.send({ type: 'negotiate' });
  await limited.take(message => message.type === 'agent_snapshot', 'Snapshot');
  for (let at = 0; at < 125; at++) limited.send({ type: 'timeline_subscription', payload: { requestId: `sub-${at}`, agentIds: [PUBLIC_ID] } });
  await until(() => limited.pair.server.readyState !== 1 ? true : undefined, 'the stream to close');
  expect(limited.pair.server.closeCode).toBe(1008);
});

it('leaves a session without a journal head to the Controller, as before', async () => {
  const r = await relay();
  const controller = await r.connectController();
  const browser = await r.openBrowser();
  const stream = await until(() => controller.streams[0], 'the Controller stream');
  browser.send({ type: 'negotiate' });
  await until(() => stream.received.some(message => message.type === 'negotiate') ? true : undefined, 'the forwarded negotiation');
  const forwarded = await browser.take(message => message.type === 'agent_snapshot', 'the Controller\'s Snapshot');
  expect(forwarded.payload.status).toBe('running');
  expect(controller.attaches).toHaveLength(1);
});

it('does not serve a journal that has rows but no head, and refuses an offline Host as before', async () => {
  const r = await relay({ seed: store => seedJournal(store, { head: false }) });
  const prepared = await r.broker.prepareUpgrade(new Request(`https://relay.example/v1/sessions/${PUBLIC_ID}/events`, { headers: { origin: 'https://relay.example' } }));
  expect(prepared).toBeInstanceOf(Response);
  expect((prepared as Response).status).toBe(503);
  expect(await (prepared as Response).json()).toMatchObject({ code: 'host_offline' });
});

it('answers a session channel subscription from the journal', async () => {
  const r = await relay({ seed: store => seedJournal(store) });
  const channel = socketPair(r.closers);
  const inbox = collect(channel.native);
  const dispose = acceptSessionChannel(channel.server, 'session', async () => {
    const prepared = await r.broker.prepareUpgrade(new Request(`https://relay.example/v1/sessions/${PUBLIC_ID}/events`, { headers: { origin: 'https://relay.example' } }), { principalSubject: () => 'alice' });
    if (!prepared || prepared instanceof Response) throw new Error('Session stream rejected');
    return prepared;
  });
  r.closers.push(dispose);
  const frame = (fields: Wire) => channel.native.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...fields }));
  frame({ type: 'subscribe', subscriptionId: 1, agentId: PUBLIC_ID, message: { protocolVersion: PROTOCOL_VERSION, type: 'negotiate' } });
  await inbox.take(item => item.type === 'message' && item.message.type === 'agent_snapshot', 'Snapshot');
  expect(inbox.all.filter(item => item.type === 'message').map(item => item.message.type)).toEqual(['negotiated', 'agent_snapshot', 'session_control']);
  frame({ type: 'message', subscriptionId: 1, message: { protocolVersion: PROTOCOL_VERSION, ...tail('page-1') } });
  const page = await inbox.take(item => item.type === 'message' && item.message.type === 'timeline_page', 'page');
  expect(texts(page.message)).toEqual(['Hello']);
});

/** Waits for the Relay's Controller stream of a browser stream to be open and negotiated. */
async function negotiatedControllerStream(controller: Awaited<ReturnType<Relay['connectController']>>) {
  const stream = await until(() => controller.streams[0], 'the Controller stream');
  await until(() => stream.received.some(message => message.type === 'negotiate') ? true : undefined, 'the Relay\'s negotiation');
  return stream;
}

const acquire = (requestId: string) => ({ type: 'session_control_request', payload: { agentId: PUBLIC_ID, requestId, revision: 'relay-pending', action: 'acquire' } });

it('answers an acquire with the pending state while the Host is offline, and closes the stream for the Host\'s return', async () => {
  const r = await relay({ seed: store => seedJournal(store) });
  const browser = await r.openBrowser();
  await subscribed(browser);
  browser.send(acquire('control-1'));
  expect(await browser.take(message => message.type === 'session_control' && message.payload.requestId === 'control-1', 'pending control state')).toMatchObject({
    payload: { agentId: PUBLIC_ID, revision: 'relay-pending', access: 'read_only', available: false },
  });
  await sleep(30);
  expect(browser.pair.server.readyState).toBe(1);
  await r.connectController();
  await until(() => browser.pair.server.readyState !== 1 ? true : undefined, 'the stream to close when the Host returns');
  expect(browser.pair.server.closeCode).toBe(1012);
  expect(browser.pair.server.closeReason).toBe('Remote Host reconnected');
});

it('shows the native owner in the pending control state and keeps serving reads', async () => {
  const r = await relay({ seed: store => seedJournal(store) });
  const nativeOwner = { kind: 'native_cli', generation: '11111111-1111-4111-8111-111111111111' };
  await r.connectController({ attach: { status: 409, body: { code: 'native_session_owned', nativeOwner } } });
  const browser = await r.openBrowser();
  await subscribed(browser);
  browser.send(acquire('control-1'));
  expect(await browser.take(message => message.type === 'session_control' && message.payload.requestId === 'control-1', 'pending control state')).toMatchObject({
    payload: { revision: 'relay-pending', access: 'read_only', available: false, nativeOwner },
  });
  browser.send(tail('page-1'));
  expect(texts(await browser.take(message => message.type === 'timeline_page', 'page'))).toEqual(['Hello']);
  expect(browser.pair.server.readyState).toBe(1);
});

it('closes the stream with the capacity code when the account has no stream slot for the Controller stream', async () => {
  const r = await relay({ seed: store => seedJournal(store), broker: { userStreamCount: () => 64 } });
  const controller = await r.connectController();
  const browser = await r.openBrowser({ principalSubject: () => 'alice' });
  browser.send({ type: 'negotiate' });
  await until(() => browser.pair.server.readyState !== 1 ? true : undefined, 'the stream to close');
  expect(browser.pair.server.closeCode).toBe(SESSION_CAPACITY_CLOSE_CODE);
  expect(browser.pair.server.closeReason).toBe('Remote stream capacity reached');
  expect(controller.streams).toEqual([]);
});

it('closes the stream when the Host disconnects, and serves a new stream from the journal at once', async () => {
  const r = await relay();
  const { controller } = await publishedController(r);
  const browser = await r.openBrowser();
  await subscribed(browser);
  await negotiatedControllerStream(controller);
  controller.disconnect();
  await until(() => browser.pair.server.readyState !== 1 ? true : undefined, 'the stream to close');
  expect(browser.pair.server.closeCode).toBe(1012);
  const next = await r.openBrowser();
  next.send({ type: 'negotiate' });
  await next.take(message => message.type === 'agent_snapshot', 'Snapshot');
  next.send(tail('page-1'));
  expect(texts(await next.take(message => message.type === 'timeline_page', 'page'))).toEqual(['Hello', 'World']);
});

it('closes the Controller stream and the browser stream of a user whose share is revoked', async () => {
  const r = await relay({
    seed: store => seedJournal(store),
    broker: { ownerSubject: 'alice' },
    state: saved => ({ ...saved,
      bindings: saved.bindings.map(binding => ({ ...binding, creatorSubject: 'bob' })),
      sharing: { grants: [{ hostId: 'host', subject: 'bob', label: 'Bob', sessionLimit: 1, revoked: false }], reservations: [] } }),
  });
  const controller = await r.connectController();
  const browser = await r.openBrowser({ principalSubject: () => 'bob' });
  await subscribed(browser);
  const stream = await negotiatedControllerStream(controller);
  await r.broker.manageShares('alice', 'host', 'revoke-share', 'bob');
  await until(() => browser.pair.server.readyState !== 1 ? true : undefined, 'the stream to close');
  expect(browser.pair.server.closeCode).toBe(1008);
  await controller.inbox.take(message => message.type === 'stream_close' && message.streamId === stream.streamId && message.code === 1008, 'stream_close');
  await sleep(30);
  expect(controller.inbox.all.filter(message => message.type === 'stream_close' && message.streamId === stream.streamId)).toHaveLength(1);
});

it('never opens a Controller stream for an activity observer', async () => {
  const r = await relay({ seed: store => seedJournal(store) });
  const controller = await r.connectController();
  const observer = await r.openBrowser();
  observer.send({ type: 'negotiate', observation: 'activity' });
  await observer.take(message => message.type === 'agent_activity', 'activity');
  await sleep(50);
  expect(controller.streams).toEqual([]);
  expect(controller.inbox.all.some(message => message.type === 'stream_open')).toBe(false);
  expect(controller.attaches).toEqual([]);
});
