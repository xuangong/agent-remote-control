import type { ProviderObservation } from '@orchardworks/agent-provider-sdk';
import { describe, expect, it } from 'vitest';

import { MESSAGE_BUDGET_BYTES } from './publisher/journal-items.js';
import { recording, recordingNames, type RecordedProvider } from './test-utils/recordings.js';
import { windowHarness } from './test-utils/journal-window-harness.js';

/**
 * Sessions as the real CLIs recorded them, through the Controller's publisher and the Relay's real journal service: what a Controller
 * sends when it opens a session again, and what the Relay keeps and reports. The scenarios every provider shares are one table.
 */
interface Scenarios {
  /** Recordings that reopen unchanged five times, and whether the journal then holds an item the reread cannot reproduce. */
  unchanged: Array<{ name: string; liveOnly: boolean }>;
  /** The interrupted recording: the items open after the live run, and what the first reopen is (a tool the native history reports failed is one change). */
  interrupted: { name: string; open: string[]; first: 'unchanged' | 'changed' };
  /** The recording in which one tool completes, and that tool's key: a tool that completed while the Controller was away. */
  toolAway: { name: string; key: (key: string) => boolean };
}

const SCENARIOS: Record<RecordedProvider, Scenarios> = {
  copilot: {
    unchanged: [{ name: 'approval', liveOnly: true }, { name: 'todos', liveOnly: true }, { name: 'reasoning', liveOnly: true }, { name: 'compaction', liveOnly: false }],
    interrupted: { name: 'interrupted', open: [], first: 'unchanged' },
    toolAway: { name: 'partial-tool', key: key => key.startsWith('tool:') },
  },
  codex: {
    unchanged: [{ name: 'approval', liveOnly: true }, { name: 'todos', liveOnly: true }, { name: 'plan-mode', liveOnly: true }, { name: 'reasoning', liveOnly: false }, { name: 'steer', liveOnly: false }, { name: 'compaction', liveOnly: false }, { name: 'after-reopen', liveOnly: false }, { name: 'errors', liveOnly: true }],
    interrupted: { name: 'interrupted', open: ['tool:c1'], first: 'changed' },
    toolAway: { name: 'settled', key: key => key === 'tool:c1' },
  },
  claude: {
    unchanged: [{ name: 'approval', liveOnly: true }, { name: 'plan-approval', liveOnly: true }, { name: 'todos', liveOnly: false }, { name: 'thinking', liveOnly: false }, { name: 'steer', liveOnly: false }, { name: 'queued', liveOnly: false },
      { name: 'parallel-tools', liveOnly: false }, { name: 'images', liveOnly: false }, { name: 'hook', liveOnly: false }, { name: 'slash-command', liveOnly: true }, { name: 'subagent', liveOnly: false }, { name: 'after-reopen', liveOnly: false }],
    interrupted: { name: 'interrupted', open: [], first: 'unchanged' },
    toolAway: { name: 'settled', key: key => key.startsWith('tool:') },
  },
};

describe.each(['copilot', 'codex', 'claude'] as const)('a recorded %s session that is opened again', provider => {
  const names = recordingNames(provider);
  const h = windowHarness(provider);
  const scenarios = SCENARIOS[provider];

  describe.skipIf(!names.includes('settled'))('through a real publisher and journal', () => {
    it('writes no item and keeps the epoch when the connection drops and the session is read again, and reports one unchanged window', async () => {
      const { run, relay, publisher } = await h.published('settled');
      const epoch = (await h.journalOf(relay)).epoch;
      const keys = await h.keysOf(relay);
      const writes = relay.writes.length;
      const reported = h.windows(relay).length;
      await h.reopenFrom(relay, publisher, run.reread);
      expect(h.windows(relay, reported)).toEqual(['unchanged']);
      expect(h.itemWrites(relay, writes)).toEqual([]);
      expect((await h.journalOf(relay)).epoch).toBe(epoch);
      expect(await h.keysOf(relay)).toEqual(keys);
      const reportedWindow = relay.diagnosticDetails.filter(({ event }) => event === 'journal_window').at(-1)!;
      expect(reportedWindow).toMatchObject({ agentId: h.SESSION, reason: 'unchanged' });
      expect(reportedWindow.bytes).toBeGreaterThan(0);
    });

    it('keeps the epoch across five releases of the runtime, each reading the history again', async () => {
      const { run, relay, publisher } = await h.published('settled');
      const epoch = (await h.journalOf(relay)).epoch;
      const reported = h.windows(relay).length;
      for (let at = 0; at < 5; at += 1) await h.reopenFrom(relay, publisher, run.reread);
      expect((await h.journalOf(relay)).epoch).toBe(epoch);
      expect(h.windows(relay, reported)).toEqual(Array(5).fill('unchanged'));
    });

    it('keeps the epoch when the Controller restarts under a new publisher, for the recording a new CLI process read', async () => {
      const { run, relay, publisher } = await h.published('restart');
      const epoch = (await h.journalOf(relay)).epoch;
      const writes = relay.writes.length;
      const next = await h.restart(relay, publisher, run.reread);
      await h.reopenFrom(relay, next.publisher, run.reread);
      expect((await h.journalOf(relay)).epoch).toBe(epoch);
      expect(h.itemWrites(relay, writes)).toEqual([]);
      expect(h.windows(relay).slice(-2)).toEqual(['unchanged', 'unchanged']);
    });

    it.each(scenarios.unchanged)('$name: reopens unchanged five times, and the items the reread cannot reproduce stay', async ({ name, liveOnly }) => {
      const { run, relay, publisher } = await h.published(name);
      const keys = await h.keysOf(relay);
      const writes = relay.writes.length;
      for (let at = 0; at < 5; at += 1) await h.reopenFrom(relay, publisher, run.reread);
      expect(await h.keysOf(relay)).toEqual(keys);
      expect(h.itemWrites(relay, writes)).toEqual([]);
      expect(h.windows(relay).slice(-5)).toEqual(Array(5).fill('unchanged'));
      expect((await h.journalOf(relay)).state().items.some(value => value.liveOnly)).toBe(liveOnly);
    });

    it('interrupted: what the turn left open is what the scenario says, the first reopen settles it, and five more are unchanged', async () => {
      const { run, relay, publisher } = await h.published(scenarios.interrupted.name);
      expect(await h.openKeysOf(relay)).toEqual(scenarios.interrupted.open);
      const reported = h.windows(relay).length;
      for (let at = 0; at < 6; at += 1) await h.reopenFrom(relay, publisher, run.reread);
      expect(h.windows(relay, reported)).toEqual([scenarios.interrupted.first, ...Array(5).fill('unchanged')]);
      expect(await h.openKeysOf(relay)).toEqual([]);
    });

    it('replaces once, as an open item, when a tool completed while the Controller was away', async () => {
      const run = recording(provider, scenarios.toolAway.name);
      const completes = run.live.findIndex(({ itemIdentity }) => itemIdentity !== undefined && scenarios.toolAway.key(itemIdentity.key) && itemIdentity.completes === true);
      expect(completes).toBeGreaterThan(0);
      const relay = h.relay();
      const first = h.start(relay);
      await h.follow(first, [], { live: h.liveOf(run.live.slice(0, completes)) });
      await h.settled(relay);
      expect((await h.openKeysOf(relay)).filter(scenarios.toolAway.key)).toHaveLength(1);
      const reported = h.windows(relay).length;
      const next = await h.restart(relay, first, run.reread);
      expect(h.windows(relay, reported)).toEqual(['open_item']);
      await h.reopenFrom(relay, next.publisher, run.reread);
      expect(h.windows(relay, reported)).toEqual(['open_item', 'unchanged']);
    });

    it('sends a scroll past the window as an older request, lands the page below the oldest item, and reports one older request', async () => {
      const run = recording(provider, 'settled');
      const users = run.reread.flatMap(({ event }, at) => event.type === 'timeline' && event.item.type === 'user_message' ? [at] : []);
      const secondTurn = users[1] ?? -1;
      expect(secondTurn).toBeGreaterThan(0);
      const relay = h.relay();
      const publisher = h.start(relay);
      const older = run.reread.slice(0, secondTurn).filter(({ event }) => event.type === 'timeline');
      await h.follow(publisher, run.reread.slice(secondTurn), { older: [{ observations: older }] });
      await h.settled(relay);
      const before = await h.keysOf(relay);
      const anchor = (await h.journalOf(relay)).oldestItemKey!;
      expect(anchor).toBe(before[0]);
      await expect(relay.connection.requestOlder(h.SESSION, 10, anchor)).resolves.toEqual({ olderAvailable: expect.any(Boolean) });
      await h.settle(60);
      const after = await h.keysOf(relay);
      expect(after.length).toBeGreaterThan(before.length);
      expect(after.slice(-before.length)).toEqual(before);
      expect(relay.diagnosticDetails.filter(({ event, reason }) => event === 'journal_request' && reason === 'older')).toHaveLength(1);
    });

    it('syncs unchanged when the runtime replaces the whole timeline with the history it read again', async () => {
      const { run, relay, publisher } = await h.published('settled');
      const reread = run.reread.filter(({ event }) => event.type === 'timeline');
      const { session } = await h.reopenFrom(relay, publisher, run.reread);
      const epoch = (await h.journalOf(relay)).epoch;
      const writes = relay.writes.length;
      const reported = h.windows(relay).length;
      session.push({ type: 'timeline_replacement', observations: reread });
      await h.settle(60);
      expect(h.windows(relay, reported).every(reason => reason === 'unchanged')).toBe(true);
      expect(h.itemWrites(relay, writes)).toEqual([]);
      expect((await h.journalOf(relay)).epoch).toBe(epoch);
    });
  });

  describe.skipIf(!names.includes('settled'))('the size of the session', () => {
    /** A large assistant message in the shape the CLI recorded. */
    function large(key: string, share: number): ProviderObservation[] {
      const template = recording(provider, 'settled').reread.find(({ event }) => event.type === 'timeline' && event.item.type === 'assistant_message')!;
      if (template.event.type !== 'timeline' || template.event.item.type !== 'assistant_message') throw new Error('The recording has no assistant message.');
      return [{ ...template, sourceKey: `${provider}:public:${key}`, itemIdentity: { key: `assistant:${key}`, completes: true }, event: { ...template.event, item: { ...template.event.item, messageId: key, text: 'x'.repeat(Math.floor(MESSAGE_BUDGET_BYTES * share)) } } }];
    }
    const session = () => ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].flatMap(key => large(key, 0.3));

    it('serves the newest items when the window does not fit one message, and the older ones are fetched on demand', async () => {
      const relay = h.relay();
      const publisher = h.start(relay);
      await h.follow(publisher, session());
      await h.settled(relay);
      const served = await h.keysOf(relay);
      expect(served.length).toBeGreaterThan(0);
      expect(served.length).toBeLessThan(6);
      expect(served.at(-1)).toBe('assistant:m6');
      const reported = h.windows(relay).length;
      await h.reopenFrom(relay, publisher, session());
      expect(h.windows(relay, reported)).toEqual(['unchanged']);
    });

    it('refuses a window larger than the Host\'s room, and serves nothing while it is refused', async () => {
      const relay = h.relay({ limits: { sessionBytes: 400_000 } });
      const publisher = h.start(relay);
      await h.follow(publisher, large('m1', 0.4));
      await h.settle(200);
      const journal = await relay.journal(h.SESSION);
      expect(journal?.head).toBeUndefined();
      expect(relay.diagnostics).toContain('journal_quota_exceeded');
    });
  });
});
