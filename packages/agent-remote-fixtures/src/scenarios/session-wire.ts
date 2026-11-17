import { DIGEST, OPERATION, PUBLIC_ID, row, snapshot, startRelay, TERMINAL_OWNER, until, type Relay, type Wire } from '../relay-harness.js';
import type { Scenario, ScenarioRecorder } from './scenario.js';

const CONSUMER = 'packages/agent-remote-seams/tests/S3/session-wire.integration.test.ts';
type Browser = Awaited<ReturnType<Relay['openBrowser']>>;
const tail = (requestId: string) => ({ type: 'timeline_request', payload: { requestId, agentId: PUBLIC_ID, direction: 'tail', limit: 100 } });

/** Negotiates and waits for the Snapshot, as a page does when it opens. */
async function negotiated(browser: Browser) {
  browser.send({ type: 'negotiate' });
  await browser.take(message => message.type === 'agent_snapshot', 'Snapshot');
  await browser.take(message => message.type === 'session_control', 'the control state');
}

async function subscribed(browser: Browser) {
  await negotiated(browser);
  browser.send({ type: 'timeline_subscription', payload: { requestId: 'sub-1', agentIds: [PUBLIC_ID] } });
  await browser.take(message => message.type === 'timeline_subscribed', 'subscription acknowledgement');
}

/** A Controller that opened the session's journal and published two complete rows and a head. */
async function publishedController(relay: Relay) {
  const controller = await relay.connectController();
  await controller.open();
  await controller.publish([
    { op: 'append', row: row('m1', 'Hello') }, { op: 'complete', itemKey: 'm1', digest: DIGEST },
    { op: 'append', row: row('m2', 'World') }, { op: 'complete', itemKey: 'm2', digest: DIGEST },
    { op: 'head', head: { snapshot: snapshot('idle', 'native-session'), observedAt: 5 } },
  ]);
  return controller;
}

/** Runs the body against a fresh Relay and always disposes it. */
const withRelay = (options: Parameters<typeof startRelay>[0], body: (relay: Relay, recorder: ScenarioRecorder) => Promise<void>) =>
  async (recorder: ScenarioRecorder): Promise<void> => {
    const relay = await startRelay({ ...options, recorder });
    try { await body(relay, recorder); } finally { await relay.dispose(); }
  };

/** The revision of the latest control state the page was sent. */
const currentRevision = (browser: Browser): string => browser.frames.filter(frame => frame.type === 'session_control').at(-1)!.payload.revision;

const acquire = async (browser: Browser, requestId: string, revision: string) => {
  browser.send({ type: 'session_control_request', payload: { agentId: PUBLIC_ID, requestId, revision, action: 'acquire' } });
  return browser.take(message => message.type === 'session_control' && message.payload.requestId === requestId, `the answer to ${requestId}`);
};

export const sessionWireScenarios: Scenario[] = [
  {
    seam: 'S3', name: 'open-offline-host', consumers: [CONSUMER],
    description: 'A page opens a session whose Host is offline: negotiation, the Snapshot, the control state, the subscription and the newest page, all from the journal.',
    run: withRelay({ seed: true }, async (relay, recorder) => {
      const browser = await relay.openBrowser();
      recorder.step('negotiate');
      await negotiated(browser);
      recorder.step('subscribe');
      browser.send({ type: 'timeline_subscription', payload: { requestId: 'sub-1', agentIds: [PUBLIC_ID] } });
      await browser.take(message => message.type === 'timeline_subscribed', 'subscription acknowledgement');
      recorder.step('newest page');
      browser.send(tail('page-1'));
      await browser.take(message => message.type === 'timeline_page', 'page');
    }),
  },
  {
    seam: 'S3', name: 'live-rows', consumers: [CONSUMER],
    description: 'A subscribed page receives the rows a Controller publishes, in order, with the journal\'s dense sequences, after the subscription is acknowledged.',
    run: withRelay({}, async (relay, recorder) => {
      const controller = await publishedController(relay);
      const browser = await relay.openBrowser();
      recorder.step('subscribe');
      await subscribed(browser);
      recorder.step('live rows');
      await controller.publish([
        { op: 'append', row: row('m3', 'Hel') }, { op: 'append', row: row('m3', 'lo') }, { op: 'complete', itemKey: 'm3', digest: DIGEST },
      ]);
      await until(() => browser.frames.filter(frame => frame.type === 'agent_stream').length === 2 ? true : undefined, 'two live rows');
    }),
  },
  {
    seam: 'S3', name: 'page-after-cursor', consumers: [CONSUMER],
    description: 'A page that reconnects asks for what follows its cursor, and a prepend is not sent live.',
    run: withRelay({}, async (relay, recorder) => {
      const controller = await publishedController(relay);
      const epoch = await relay.epoch();
      const browser = await relay.openBrowser();
      await subscribed(browser);
      recorder.step('publish a prepend and an append');
      await controller.publish([{ op: 'prepend', items: [{ row: row('m0', 'Older'), digest: DIGEST }] }, { op: 'append', row: row('m3', 'Next') }]);
      await until(() => browser.frames.some(frame => frame.type === 'agent_stream') ? true : undefined, 'the live row');
      recorder.step('page after the cursor');
      browser.send({ type: 'timeline_request', payload: { requestId: 'page-2', agentId: PUBLIC_ID, direction: 'after', cursor: { epoch, seq: 2 }, limit: 100 } });
      await browser.take(message => message.type === 'timeline_page', 'page');
    }),
  },
  {
    seam: 'S3', name: 'replacement', consumers: [CONSUMER],
    description: 'A Controller replaces the window: subscribers are told of the new epoch and the next page comes from it.',
    run: withRelay({}, async (relay, recorder) => {
      const controller = await publishedController(relay);
      const browser = await relay.openBrowser();
      await subscribed(browser);
      recorder.step('replacing window');
      await controller.publish([{ op: 'window', items: [{ row: row('x1', 'Fresh'), digest: DIGEST }] }]);
      await browser.take(message => message.type === 'timeline_replacement', 'replacement');
      recorder.step('newest page');
      browser.send(tail('page-2'));
      await browser.take(message => message.type === 'timeline_page', 'page');
    }),
  },
  {
    seam: 'S3', name: 'acquire-control', consumers: [CONSUMER],
    description: 'A page acquires control; the Relay answers with the lease: its revision, access and token.',
    run: withRelay({ seed: true }, async (relay, recorder) => {
      const browser = await relay.openBrowser();
      await negotiated(browser);
      recorder.step('acquire');
      await acquire(browser, 'acquire-1', currentRevision(browser));
    }),
  },
  {
    seam: 'S3', name: 'send-without-lease', consumers: [CONSUMER],
    description: 'A page that holds no lease sends a message: the Relay refuses it with the reason, keeps the stream open, and does not forward it to a Controller.',
    run: withRelay({ seed: true }, async (relay, recorder) => {
      await relay.connectController();
      const browser = await relay.openBrowser();
      await negotiated(browser);
      recorder.step('send without a lease');
      browser.send({ type: 'send_message', payload: { requestId: 'send-1', operationId: OPERATION, agentId: PUBLIC_ID, text: 'Hi' } });
      await browser.take(message => message.payload?.requestId === 'send-1', 'the answer to the send');
      recorder.step('reads continue');
      browser.send(tail('page-1'));
      await browser.take(message => message.type === 'timeline_page', 'page');
    }),
  },
  {
    seam: 'S3', name: 'acquire-stale-revision', consumers: [CONSUMER],
    description: 'An acquire that names a revision the Relay no longer holds is refused with session_control_changed, not given a lease.',
    run: withRelay({ seed: true }, async (relay, recorder) => {
      const browser = await relay.openBrowser();
      await negotiated(browser);
      recorder.step('acquire with a stale revision');
      browser.send({ type: 'session_control_request', payload: { agentId: PUBLIC_ID, requestId: 'acquire-stale', revision: 'stale', action: 'acquire' } });
      await browser.take(message => message.payload?.requestId === 'acquire-stale', 'the answer to the stale acquire');
    }),
  },
  {
    seam: 'S3', name: 'send-acknowledged', consumers: [CONSUMER],
    description: 'A page with control sends a message; the Relay opens a Controller stream and returns the Controller\'s acknowledgement.',
    run: withRelay({}, async (relay, recorder) => {
      await publishedController(relay);
      const browser = await relay.openBrowser();
      await subscribed(browser);
      recorder.step('acquire');
      const granted = await acquire(browser, 'acquire-1', currentRevision(browser));
      recorder.step('send');
      browser.send({ type: 'send_message', controlToken: granted.payload.token, payload: { requestId: 'send-1', operationId: OPERATION, agentId: PUBLIC_ID, text: 'Hi' } });
      await browser.take(message => message.type === 'command_acknowledged', 'acknowledgement');
    }),
  },
  {
    seam: 'S3', name: 'native-owner-refuses-send', consumers: [CONSUMER],
    description: 'The Controller refuses a message because a terminal owns the session: the page gets the reason, then a read-only control state, and reads keep working.',
    run: withRelay({ seed: true }, async (relay, recorder) => {
      await relay.connectController({ attach: { status: 409, body: { code: 'native_session_owned', nativeOwner: TERMINAL_OWNER } } });
      const browser = await relay.openBrowser();
      await subscribed(browser);
      recorder.step('acquire');
      const granted = await acquire(browser, 'acquire-1', currentRevision(browser));
      recorder.step('send is refused for the native owner');
      browser.send({ type: 'send_message', controlToken: granted.payload.token, payload: { requestId: 'send-1', operationId: OPERATION, agentId: PUBLIC_ID, text: 'Hi' } });
      await browser.take(message => message.type === 'protocol_error' && message.payload.requestId === 'send-1', 'refusal');
      await browser.take(message => message.type === 'session_control' && !message.payload.requestId, 'control state');
      recorder.step('the next send is refused as read only');
      browser.send({ type: 'send_message', controlToken: granted.payload.token, payload: { requestId: 'send-2', operationId: OPERATION, agentId: PUBLIC_ID, text: 'Hi' } });
      await browser.take(message => message.type === 'protocol_error' && message.payload.requestId === 'send-2', 'second refusal');
      recorder.step('reads continue');
      browser.send(tail('page-1'));
      await browser.take(message => message.type === 'timeline_page', 'page');
    }),
  },
  {
    seam: 'S3', name: 'send-offline-host', consumers: [CONSUMER],
    description: 'A page with control sends while the Host is offline: the Relay answers with the reason and keeps control and reads.',
    run: withRelay({}, async (relay, recorder) => {
      const controller = await publishedController(relay);
      controller.disconnect();
      await new Promise(resolve => setTimeout(resolve, 20));
      const browser = await relay.openBrowser();
      await subscribed(browser);
      recorder.step('acquire');
      const granted = await acquire(browser, 'acquire-1', currentRevision(browser));
      recorder.step('send to an offline Host');
      browser.send({ type: 'send_message', controlToken: granted.payload.token, payload: { requestId: 'send-1', operationId: OPERATION, agentId: PUBLIC_ID, text: 'Hi' } });
      await browser.take((message: Wire) => message.payload?.requestId === 'send-1', 'the answer to the send');
    }),
  },
];
