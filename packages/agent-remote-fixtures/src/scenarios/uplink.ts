import { createTerminalRefresh } from '@orchardworks/agent-remote-controller/terminal-refresh';
import { observationBuilder, UPLINK_SESSION, uplinkHarness, type Uplink } from '../uplink-harness.js';
import type { Scenario, ScenarioContext, ScenarioRecorder } from './scenario.js';

const CONSUMER = 'packages/agent-remote-seams/tests/S2/journal-uplink.integration.test.ts';

/** Runs the body against a fresh Controller publisher and Relay journal service, and always releases them. */
const withUplink = (options: Parameters<typeof uplinkHarness>[1], body: (uplink: Uplink, recorder: ScenarioRecorder, context: ScenarioContext) => Promise<void>) =>
  async (recorder: ScenarioRecorder, context: ScenarioContext): Promise<void> => {
    const uplink = uplinkHarness(recorder, options);
    try { await body(uplink, recorder, context); } finally { await uplink.dispose(); }
  };

const live = (context: ScenarioContext) => context.recording('codex', 'settled').live.filter(observation => observation.delivery === 'live');
const reread = (context: ScenarioContext) => context.recording('codex', 'settled').reread;

export const uplinkScenarios: Scenario[] = [
  {
    seam: 'S2', name: 'publish-recorded-session', consumers: [CONSUMER], relayBacking: { uplink: {} },
    description: 'A Controller opens a journal for a session that was recorded live: open, the window, the head, and the acknowledgements.',
    run: withUplink({}, async (uplink, recorder, context) => {
      recorder.step('open and publish the recorded run');
      const publisher = uplink.start();
      await uplink.follow(publisher, [], live(context));
      await uplink.settled();
    }),
  },
  {
    seam: 'S2', name: 'reopen-unchanged', consumers: [CONSUMER], relayBacking: { uplink: {} },
    description: 'The session is released and opened again with the same native history: the Relay answers unchanged and stores nothing.',
    run: withUplink({}, async (uplink, recorder, context) => {
      const publisher = uplink.start();
      await uplink.follow(publisher, [], live(context));
      await uplink.settled();
      recorder.step('reopen from native history');
      publisher.available(undefined);
      await uplink.follow(publisher, reread(context));
      uplink.reconnect(publisher);
      await uplink.settle(60);
    }),
  },
  {
    seam: 'S2', name: 'restart-controller', consumers: [CONSUMER], relayBacking: { uplink: {} },
    description: 'The Controller restarts: a new publisher reads the same native history and meets the journal the Relay kept.',
    run: withUplink({}, async (uplink, recorder, context) => {
      const first = uplink.start();
      await uplink.follow(first, [], live(context));
      await uplink.settled();
      recorder.step('restart');
      first.close();
      const second = uplink.start();
      await uplink.follow(second, reread(context));
      await uplink.settle(60);
    }),
  },
  {
    seam: 'S2', name: 'reopen-changed-history', consumers: [CONSUMER], relayBacking: { uplink: {} },
    description: 'The native history read after a reopen no longer matches what the Relay holds: the Relay replaces its journal with the new window.',
    run: withUplink({}, async (uplink, recorder, context) => {
      const publisher = uplink.start();
      await uplink.follow(publisher, [], live(context));
      await uplink.settled();
      recorder.step('reopen with a shorter history');
      publisher.available(undefined);
      await uplink.follow(publisher, reread(context).slice(0, -2));
      uplink.reconnect(publisher);
      await uplink.settle(60);
    }),
  },
  {
    seam: 'S2', name: 'live-rows-after-open', consumers: [CONSUMER], relayBacking: { uplink: {} },
    description: 'Rows that arrive after the window was published go to the journal as appended rows, completed by their digest.',
    run: withUplink({}, async (uplink, recorder) => {
      const item = observationBuilder();
      const publisher = uplink.start();
      const { session } = await uplink.follow(publisher, [item('history', 'm1', 'Hello'), item('history', 'm2', 'World')]);
      await uplink.settled();
      recorder.step('live rows');
      session.push(item('live', 'm3', 'Hel', { completes: false }));
      session.push(item('live', 'm3', 'Hello again', { completes: true }));
      await uplink.settle(60);
    }),
  },
  {
    seam: 'S2', name: 'relay-refuses-live-row', consumers: [CONSUMER],
    description: 'The Relay refuses a live row as invalid: the refused entry consumes no sequence, and the Controller reopens with a new window to recover.',
    run: (() => {
      let refused = false;
      return withUplink({ refuseEntry: entry => { if (refused || entry.op !== 'append') return undefined; refused = true; return { reason: 'invalid' }; } }, async (uplink, recorder) => {
        const item = observationBuilder();
        const publisher = uplink.start();
        const { session } = await uplink.follow(publisher, [item('history', 'm1', 'Hello')]);
        await uplink.settled();
        recorder.step('a live row the Relay refuses');
        refused = false;
        session.push(item('live', 'm2', 'Refused once', { completes: true }));
        await uplink.settle(120);
      });
    })(),
  },
  {
    seam: 'S2', name: 'quota-refuses-window', consumers: [CONSUMER], relayBacking: { uplink: { limits: { sessionBytes: 9_000 } } },
    description: 'The Relay has no room for the whole window: it refuses it whole with quota_exceeded, and the Controller backs off: it does not open the journal again while the window is unchanged, and sends it again once it changed.',
    run: withUplink({ limits: { sessionBytes: 9_000 } }, async (uplink, recorder) => {
      const item = observationBuilder();
      recorder.step('open a window larger than the quota');
      const publisher = uplink.start();
      const { session } = await uplink.follow(publisher, Array.from({ length: 8 }, (_, at) => item('history', `m${at}`, `Item ${at} ${'y'.repeat(2000)}`)));
      await uplink.until(() => uplink.count('journal_refused') >= 1, 'the refusal');
      recorder.step('the unchanged window is held through the backoff');
      await uplink.settle(200);
      recorder.step('a new turn changes the window, which is sent once more');
      session.push(item('live', 'm8', 'A new turn', { completes: true }));
      await uplink.until(() => uplink.count('journal_refused') >= 2, 'the refusal of the changed window');
      await uplink.settle(200);
    }),
  },
  {
    seam: 'S2', name: 'connection-drops-and-returns', consumers: [CONSUMER], relayBacking: { uplink: {} },
    description: 'The uplink drops while a session is published and comes back: the Controller opens the journal again and the Relay answers from what it kept.',
    run: withUplink({}, async (uplink, recorder, context) => {
      const publisher = uplink.start();
      await uplink.follow(publisher, [], live(context));
      await uplink.settled();
      recorder.step('the connection drops and returns');
      publisher.available(undefined);
      uplink.reconnect(publisher);
      await uplink.settle(60);
    }),
  },
  {
    seam: 'S2', name: 'terminal-write-refresh', consumers: [CONSUMER], relayBacking: { uplink: {} },
    description: 'A terminal writes a turn to a released session: the next listing shows it newer and quiet, the Controller attaches the session once, and the Relay answers with an extension of its journal.',
    run: withUplink({}, async (uplink, recorder) => {
      const item = observationBuilder();
      const history = [item('history', 'm1', 'Hello'), item('history', 'm2', 'World')];
      const [providerId, nativeSessionId] = UPLINK_SESSION.split(':') as [string, string];
      const binding = { agentId: 'agent-1', providerId, nativeSessionId };
      const publisher = uplink.start();
      const turn = [item('history', 'u2', 'Fix the bug'), item('history', 'a2', 'Done')];
      const refresh = createTerminalRefresh({
        now: uplink.clock.now, directory: () => ({ canReleaseSession: () => true }), bindings: () => [binding], bindingOf: () => binding,
        isLive: () => false, hasDemand: () => false, expire: () => undefined, granted: () => true, stopped: () => false,
        attachAndRelease: async () => {
          await uplink.follow(publisher, [...history, ...turn]);
          await uplink.settle(60);
          await publisher.release(binding.agentId);
        },
        releaseJournal: agentId => publisher.release(agentId),
      });
      await uplink.follow(publisher, history);
      await uplink.settled();
      recorder.step('the session is released with its journal published');
      await refresh.releaseJournal(binding);
      recorder.step('a terminal writes a turn, and a listing shows it');
      uplink.clock.advance(120_000);
      await refresh.refresh(providerId, [{ nativeSessionId, providerId, title: 'Thread', createdAt: new Date(0).toISOString(), updatedAt: new Date(uplink.clock.now() - 60_000).toISOString(), state: 'idle' }]);
      await uplink.settle(60);
    }),
  },
];
