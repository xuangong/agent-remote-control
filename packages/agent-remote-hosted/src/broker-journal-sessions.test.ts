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
  await controller.open();
  await controller.publish([
    { op: 'append', row: row('m1', 'Hello') }, { op: 'complete', itemKey: 'm1', digest: DIGEST },
    { op: 'append', row: row('m2', 'World') }, { op: 'complete', itemKey: 'm2', digest: DIGEST },
    { op: 'head', head: { snapshot: snapshot('idle', 'native-session'), observedAt: 5 } },
  ]);
  return { controller, epoch: (await r.store.load(STORE_KEY))!.meta.epoch };
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
  expect(browser.frames[1]!.payload).toMatchObject({ id: PUBLIC_ID, status: 'idle' });
  expect(browser.frames[1]!.payload.runtimeInfo.connection).toBeUndefined();
  expect(browser.frames[2]!.payload).toMatchObject({ agentId: PUBLIC_ID, access: 'read_only', available: true });
  browser.send({ type: 'timeline_subscription', payload: { requestId: 'sub-1', agentIds: [PUBLIC_ID] } });
  expect(await browser.take(message => message.type === 'timeline_subscribed', 'acknowledgement')).toMatchObject({ payload: { requestId: 'sub-1', agentIds: [PUBLIC_ID] } });
  browser.send(tail('page-1'));
  const page = await browser.take(message => message.type === 'timeline_page', 'page');
  expect(page.payload).toMatchObject({ agentId: PUBLIC_ID, epoch, hasOlder: true, hasNewer: false, window: { minSeq: 1, maxSeq: 2, nextSeq: 3 } });
  expect(texts(page)).toEqual(['Hello', 'World']);
  expect(controller.streams).toEqual([]);
  expect(browser.pair.server.readyState).toBe(1);
  browser.send({ type: 'session_control_request', payload: { agentId: PUBLIC_ID, requestId: 'control-1', revision: browser.frames[2]!.payload.revision, action: 'acquire' } });
  expect(await browser.take(message => message.type === 'session_control' && message.payload.requestId === 'control-1', 'control')).toMatchObject({ payload: { access: 'control', available: true, token: expect.any(String) } });
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

it('does not send a prepend live; the next page after the client\'s cursor leaves it out', async () => {
  const r = await relay();
  const { controller, epoch } = await publishedController(r);
  const browser = await r.openBrowser();
  await subscribed(browser);
  await controller.publish([
    { op: 'prepend', items: [{ row: row('m0', 'Older'), digest: DIGEST }] },
    { op: 'append', row: row('m3', 'Next') },
  ]);
  await until(() => browser.frames.some(frame => frame.type === 'agent_stream') ? true : undefined, 'the live row');
  expect(browser.frames.filter(frame => frame.type === 'agent_stream').map(frame => frame.payload.seq)).toEqual([3]);
  browser.send({ type: 'timeline_request', payload: { requestId: 'page-2', agentId: PUBLIC_ID, direction: 'after', cursor: { epoch, seq: 2 }, limit: 100 } });
  expect(texts(await browser.take(message => message.type === 'timeline_page', 'page'))).toEqual(['Next']);
});

it('announces a replacing window to subscribers and serves the new epoch', async () => {
  const r = await relay();
  const { controller, epoch } = await publishedController(r);
  const browser = await r.openBrowser();
  await subscribed(browser);
  await controller.publish([{ op: 'window', items: [{ row: row('x1', 'Fresh'), digest: DIGEST }] }]);
  const replaced = await browser.take(message => message.type === 'timeline_replacement', 'replacement');
  const stored = (await r.store.load(STORE_KEY))!;
  expect(stored.meta.epoch).not.toBe(epoch);
  expect(replaced.payload).toEqual({ agentId: PUBLIC_ID, epoch: stored.meta.epoch });
  browser.send(tail('page-2'));
  const page = await browser.take(message => message.type === 'timeline_page', 'page');
  expect(page.payload.epoch).toBe(stored.meta.epoch);
  expect(texts(page)).toEqual(['Fresh']);
});

it('forwards head changes as updates as the Controller published them, and holds no Controller stream for reading', async () => {
  const r = await relay();
  const { controller } = await publishedController(r);
  const browser = await r.openBrowser();
  await subscribed(browser);
  await controller.publish([{ op: 'head', head: { snapshot: snapshot('running', 'native-session'), observedAt: 6 } }]);
  const update = await browser.take(message => message.type === 'agent_update', 'update');
  expect(update.payload).toMatchObject({ id: PUBLIC_ID, status: 'running' });
  expect(update.payload.runtimeInfo.connection).toBeUndefined();
  expect(controller.streams).toEqual([]);
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

/** Acquires control and sends one message, which opens the Controller stream; resolves with that stream, negotiated. */
async function sentThrough(browser: Browser, controller: Awaited<ReturnType<Relay['connectController']>>) {
  const token = await browser.controlled(false);
  browser.send({ type: 'send_message', controlToken: token, payload: { requestId: 'send-1', operationId: OPERATION, agentId: PUBLIC_ID, text: 'Hi' } });
  return { token, stream: await negotiatedControllerStream(controller) };
}

it('opens a Controller stream for the first operation, returns its acknowledgement and drops its read frames', async () => {
  const r = await relay();
  const { controller } = await publishedController(r);
  const browser = await r.openBrowser();
  await subscribed(browser);
  const { stream } = await sentThrough(browser, controller);
  expect(await browser.take(message => message.type === 'command_acknowledged', 'acknowledgement')).toMatchObject({ payload: { requestId: 'send-1', command: 'send_message' } });
  controller.toStream(stream.streamId, { type: 'agent_update', payload: snapshot('running', PUBLIC_ID) });
  controller.toStream(stream.streamId, { type: 'agent_stream', payload: { agentId: PUBLIC_ID, timestamp: 't', event: { type: 'turn_started', providerId: 'codex' } } });
  controller.toStream(stream.streamId, { type: 'timeline_subscribed', payload: { requestId: 'x', agentIds: [PUBLIC_ID] } });
  await sleep(50);
  expect(browser.frames.filter(frame => frame.type === 'negotiated')).toHaveLength(1);
  expect(browser.frames.filter(frame => frame.type === 'agent_snapshot')).toHaveLength(1);
  expect(browser.frames.filter(frame => frame.type === 'agent_snapshot' || frame.type === 'agent_update').every(frame => frame.payload.status === 'idle')).toBe(true);
  expect(browser.frames.filter(frame => frame.type === 'agent_stream' || frame.type === 'timeline_subscribed')).toHaveLength(1);
  expect(stream.received.map(message => message.type)).toEqual(['negotiate', 'send_message']);
  expect(controller.attaches).toHaveLength(1);
});

it('holds no Controller stream for a view that only reads and holds control', async () => {
  const r = await relay();
  const { controller } = await publishedController(r);
  const browsers = [await r.openBrowser(), await r.openBrowser(), await r.openBrowser()];
  for (const browser of browsers) { await subscribed(browser); await browser.controlled(false); }
  await sleep(50);
  expect(controller.streams).toEqual([]);
  expect(controller.inbox.all.some(message => message.type === 'stream_open')).toBe(false);
});

it('closes the Controller stream when the browser stream ends', async () => {
  const r = await relay();
  const { controller } = await publishedController(r);
  const browser = await r.openBrowser();
  await subscribed(browser);
  const { stream } = await sentThrough(browser, controller);
  browser.pair.native.close(1000);
  expect(await controller.inbox.take(message => message.type === 'stream_close', 'stream_close')).toMatchObject({ streamId: stream.streamId, code: 1000 });
});

it('answers an operation with the reason when the Host is offline, keeps control and reads, and delivers once the Host is back', async () => {
  const r = await relay();
  const { controller } = await publishedController(r);
  controller.disconnect();
  await sleep(20);
  const browser = await r.openBrowser();
  await subscribed(browser);
  const token = await browser.controlled(false);
  browser.send({ type: 'send_message', controlToken: token, payload: { requestId: 'send-1', operationId: OPERATION, agentId: PUBLIC_ID, text: 'Hi' } });
  expect(await browser.take(message => message.type === 'protocol_error' && message.payload.requestId === 'send-1', 'refusal')).toMatchObject({ payload: { code: 'host_offline', recoverable: true } });
  expect(browser.pair.server.readyState).toBe(1);
  browser.send(tail('page-1'));
  expect(texts(await browser.take(message => message.type === 'timeline_page', 'page'))).toEqual(['Hello', 'World']);
  const returned = await r.connectController();
  await sleep(30);
  expect(browser.pair.server.readyState).toBe(1);
  expect(browser.pair.server.closeCode).toBeUndefined();
  browser.send({ type: 'send_message', controlToken: token, payload: { requestId: 'send-2', operationId: OPERATION, agentId: PUBLIC_ID, text: 'Again' } });
  expect(await browser.take(message => message.type === 'command_acknowledged' && message.payload.requestId === 'send-2', 'acknowledgement')).toBeDefined();
  expect(returned.streams).toHaveLength(1);
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

it('reads a session whose listing said it had a head through the Controller, and serves it again once a publication sets a head', async () => {
  // The store lists the session as served although its journal has no head, as a listing taken before a quota refusal cleared the head does.
  const r = await relay({
    seed: store => seedJournal(store, { head: false }),
    journalStore: memory => ({ load: key => memory.load(key), apply: changes => memory.apply(changes), delete: key => memory.delete(key),
      catalog: { list: async prefix => (await memory.catalog.list(prefix)).map(entry => ({ ...entry, hasHead: true })), deletePrefix: prefix => memory.catalog.deletePrefix(prefix) } }),
  });
  const controller = await r.connectController();
  const first = await r.openBrowser();
  first.send({ type: 'negotiate' });
  await until(() => first.pair.server.readyState !== 1 ? true : undefined, 'the stream that found no head to close');
  expect(first.pair.server.closeCode).toBe(1012);
  expect(controller.streams).toEqual([]);

  const second = await r.openBrowser();
  second.send({ type: 'negotiate' });
  const stream = await negotiatedControllerStream(controller);
  second.send(tail('page-1'));
  await until(() => stream.received.some(message => message.type === 'timeline_request') ? true : undefined, 'the page read to reach the Controller');
  expect(second.frames.some(frame => frame.type === 'timeline_page')).toBe(false);

  await controller.open();
  await controller.publish([{ op: 'head', head: { snapshot: snapshot('idle', 'native-session'), observedAt: 5 } }]);
  const third = await r.openBrowser();
  third.send({ type: 'negotiate' });
  third.send(tail('page-2'));
  expect(texts(await third.take(message => message.type === 'timeline_page', 'page'))).toEqual(['Hello']);
});

it('delivers a question to the browser only inside the head, never as the Controller\'s interaction frame, and removes it with the next head', async () => {
  const question = { kind: 'question', requestId: 'question-1', questions: [{ questionId: 'q', header: 'Pick', prompt: 'Which?', required: true, selection: 'single', options: [{ value: 'a', label: 'A', description: 'a' }], allowCustomText: false, allowDismiss: false }] };
  const r = await relay();
  const { controller } = await publishedController(r);
  const browser = await r.openBrowser();
  await subscribed(browser);
  const { stream } = await sentThrough(browser, controller);
  const before = browser.frames.length;
  await controller.publish([{ op: 'head', head: { snapshot: { ...snapshot('running', 'native-session'), pendingInteractions: [question] }, observedAt: 6 } }]);
  controller.toStream(stream.streamId, { type: 'interaction_requested', payload: { agentId: PUBLIC_ID, request: question } });
  await until(() => browser.frames.slice(before).some(frame => frame.type === 'agent_update') ? true : undefined, 'the head that carries the question');
  expect(browser.frames.slice(before).find(frame => frame.type === 'agent_update')!.payload.pendingInteractions[0].requestId).toBe('question-1');
  const answered = browser.frames.length;
  controller.toStream(stream.streamId, { type: 'interaction_resolved', payload: { agentId: PUBLIC_ID, requestId: 'question-1', response: { kind: 'question', answers: [] } } });
  await controller.publish([{ op: 'head', head: { snapshot: snapshot('running', 'native-session'), observedAt: 7 } }]);
  await until(() => browser.frames.slice(answered).some(frame => frame.type === 'agent_update') ? true : undefined, 'the head that no longer carries the question');
  expect(browser.frames.slice(answered).find(frame => frame.type === 'agent_update')!.payload.pendingInteractions).toEqual([]);
  await sleep(30);
  expect(browser.frames.some(frame => String(frame.type).startsWith('interaction_'))).toBe(false);
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

it('shows the native owner and revokes control when the first operation is refused for it, and keeps serving reads', async () => {
  const r = await relay({ seed: store => seedJournal(store) });
  const nativeOwner = { kind: 'native_cli', generation: '11111111-1111-4111-8111-111111111111' };
  await r.connectController({ attach: { status: 409, body: { code: 'native_session_owned', nativeOwner } } });
  const browser = await r.openBrowser();
  await subscribed(browser);
  const token = await browser.controlled(false);
  browser.send({ type: 'send_message', controlToken: token, payload: { requestId: 'send-1', operationId: OPERATION, agentId: PUBLIC_ID, text: 'Hi' } });
  expect(await browser.take(message => message.type === 'protocol_error' && message.payload.requestId === 'send-1', 'refusal')).toMatchObject({ payload: { code: 'native_session_owned' } });
  expect(await browser.take(message => message.type === 'session_control' && !message.payload.requestId, 'control state')).toMatchObject({
    payload: { access: 'read_only', available: false, nativeOwner },
  });
  browser.send({ type: 'send_message', controlToken: token, payload: { requestId: 'send-2', operationId: OPERATION, agentId: PUBLIC_ID, text: 'Hi' } });
  expect(await browser.take(message => message.type === 'protocol_error' && message.payload.requestId === 'send-2', 'refusal')).toMatchObject({ payload: { code: 'session_read_only' } });
  browser.send(tail('page-1'));
  expect(texts(await browser.take(message => message.type === 'timeline_page', 'page'))).toEqual(['Hello']);
  expect(browser.pair.server.readyState).toBe(1);
});

it('refuses the message, not the stream, when the account has no stream slot for the Controller stream', async () => {
  const r = await relay({ seed: store => seedJournal(store), broker: { userStreamCount: () => 64 } });
  const controller = await r.connectController();
  const browser = await r.openBrowser({ principalSubject: () => 'alice' });
  await subscribed(browser);
  const token = await browser.controlled(false);
  browser.send({ type: 'send_message', controlToken: token, payload: { requestId: 'send-1', operationId: OPERATION, agentId: PUBLIC_ID, text: 'Hi' } });
  expect(await browser.take(message => message.type === 'protocol_error' && message.payload.requestId === 'send-1', 'refusal')).toMatchObject({ payload: { code: 'session_stream_capacity', recoverable: true } });
  expect(browser.pair.server.readyState).toBe(1);
  expect(controller.streams).toEqual([]);
});

it('closes the stream when the Host disconnects, and serves a new stream from the journal at once', async () => {
  const r = await relay();
  const { controller } = await publishedController(r);
  const browser = await r.openBrowser();
  await subscribed(browser);
  await sentThrough(browser, controller);
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
  const { stream } = await sentThrough(browser, controller);
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

it('opens a session through the Controller when the journal store cannot be read', async () => {
  const r = await relay({ seed: async store => { store.load = async () => { throw new Error('The store is unavailable.'); }; } });
  const controller = await r.connectController();
  const browser = await r.openBrowser();
  browser.send({ type: 'negotiate' });
  expect((await browser.take(message => message.type === 'agent_snapshot', 'the Controller\'s Snapshot')).payload.status).toBe('running');
  expect(controller.attaches).toHaveLength(1);
  expect(await until(() => controller.streams[0], 'the Controller stream')).toBeDefined();
});

it('refuses a held operation as retryable when the Controller connection is replaced during the attach, and a new operation reaches the new connection', async () => {
  const r = await relay({ seed: store => seedJournal(store) });
  const first = await r.connectController({ holdAttach: true });
  const browser = await r.openBrowser();
  await subscribed(browser);
  const token = await browser.controlled(false);
  browser.send({ type: 'send_message', controlToken: token, payload: { requestId: 'send-1', operationId: OPERATION, agentId: PUBLIC_ID, text: 'Hi' } });
  await until(() => first.attaches[0], 'the attach');
  await sleep(20);
  const second = await r.connectController();
  const outcome = await until(() => browser.frames.find(frame => frame.payload?.requestId === 'send-1') ?? (browser.pair.server.readyState !== 1 ? { closed: true } : undefined), 'an answer to the send');
  expect(outcome).not.toMatchObject({ type: 'command_acknowledged' });
  if (!('closed' in outcome)) expect(outcome).toMatchObject({ type: 'protocol_error', payload: { code: 'host_reconnected', recoverable: true } });
  const next = await r.openBrowser();
  await subscribed(next);
  const { stream } = await sentThrough(next, second);
  expect(stream.received.map(message => message.type)).toEqual(['negotiate', 'send_message']);
});

it('refuses the message, not the stream, when the Host has no stream slot left', async () => {
  const r = await relay({ seed: store => seedJournal(store) });
  const controller = await r.connectController();
  const browsers = [];
  for (let at = 0; at < 128; at++) {
    const browser = await r.openBrowser();
    await subscribed(browser);
    const token = await browser.controlled(false);
    browser.send({ type: 'send_message', controlToken: token, payload: { requestId: 'send-1', operationId: OPERATION, agentId: PUBLIC_ID, text: 'Hi' } });
    browsers.push(browser);
  }
  await until(() => controller.streams.length === 128 ? true : undefined, '128 Controller streams');
  const last = await r.openBrowser();
  await subscribed(last);
  const token = await last.controlled(false);
  last.send({ type: 'send_message', controlToken: token, payload: { requestId: 'send-1', operationId: OPERATION, agentId: PUBLIC_ID, text: 'Hi' } });
  expect(await last.take(message => message.type === 'protocol_error' && message.payload.requestId === 'send-1', 'refusal')).toMatchObject({ payload: { code: 'session_stream_capacity', recoverable: true } });
  expect(last.pair.server.readyState).toBe(1);
  expect(controller.streams).toHaveLength(128);
});
