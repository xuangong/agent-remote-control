import type { ProviderObservation } from '@orchardworks/agent-provider-sdk';
import { supportsJournal } from '@orchardworks/agent-provider-sdk';
import { describe, expect, it } from 'vitest';

import { CopilotAgentProvider } from '../../agent-provider-copilot/src/provider.js';
import { Projector } from '../../agent-provider-copilot/src/projector.js';
import type { SessionEvent } from '@github/copilot-sdk';
import type { Recording as CopilotRecording } from './test-utils/recordings.js';
import { windowHarness } from './test-utils/journal-window-harness.js';

/**
 * What only Copilot's own events show: the todo board a Controller start publishes again, and a corrected final message built from the
 * adapter's projector. The scenarios every provider shares are in journal-window.recordings.journal.test.ts.
 */
const h = windowHarness('copilot');

describe('a recorded Copilot session that is opened again', () => {
  it('keeps one todo board through five Controller starts that each publish it, a changed board updating it in place', async () => {
    const { run, relay, publisher } = await h.published('todos');
    const snapshot = run.live.filter(({ itemIdentity }) => itemIdentity?.key === 'todo').at(-1)!;
    const board = (done: boolean): ProviderObservation => {
      const event = snapshot.event;
      if (event.type !== 'timeline' || event.item.type !== 'todo') throw new Error('The recording holds no todo snapshot.');
      return { ...snapshot, event: { ...event, item: { ...event.item, items: event.item.items.map(task => ({ ...task, completed: done })) } } };
    };
    const keys = await h.keysOf(relay);
    const epoch = (await h.journalOf(relay)).epoch;
    const reported = h.windows(relay).length;
    let current = publisher;
    for (const [at, observation] of [snapshot, board(true), board(true), board(false), board(false)].entries()) {
      current = (await h.restart(relay, current, run.reread, { live: [{ ...observation, sourceKey: `copilot:local:restart-${at}` }] })).publisher;
    }
    const outcomes = h.windows(relay, reported);
    expect(outcomes).toHaveLength(5);
    expect(outcomes.every(outcome => outcome === 'unchanged' || outcome === 'appended')).toBe(true);
    expect((await h.journalOf(relay)).epoch).toBe(epoch);
    expect(await h.keysOf(relay)).toEqual(keys);
    expect((await h.keysOf(relay)).filter(key => key === 'todo')).toHaveLength(1);
  });

  it('replaces once, as a changed item, for a corrected final message, and then holds the base once and no correction item', async () => {
    let id = 0;
    const event = (type: string, data: unknown): SessionEvent => ({ type, data, id: `native-${++id}`, timestamp: new Date(1_725_000_000_000 + id).toISOString(), parentId: null }) as SessionEvent;
    const user = event('user.message', { content: 'Fix it' });
    const started = event('assistant.turn_start', { turnId: '0' });
    const delta = event('assistant.message_delta', { messageId: 'm1', deltaContent: 'Draft' });
    const final = event('assistant.message', { messageId: 'm1', content: 'Final' });
    const ended = event('assistant.turn_end', { turnId: '0' });
    const observe = (events: SessionEvent[], delivery: 'live' | 'history', projector: Projector): ProviderObservation[] => events.flatMap(native => projector.projectAll(native, delivery).map(projected => ({
      type: 'observation' as const, sourceKey: `copilot:public:${projected.key}:${native.id}`, occurredAt: Date.parse(native.timestamp), delivery, event: projected.event, ...(projected.identity ? { itemIdentity: projected.identity } : {}),
    })));
    const live = observe([user, started, delta, final, ended, event('assistant.idle', {})], 'live', new Projector());
    const historyProjector = new Projector();
    const nativeHistory = [user, started, final, ended];
    historyProjector.prepareHistory(nativeHistory);
    const reread = observe(nativeHistory, 'history', historyProjector);
    const corrected: CopilotRecording = { live, reread };

    const relay = h.relay();
    const publisher = h.start(relay);
    await h.follow(publisher, [], { live: h.liveOf(corrected.live) });
    await h.settled(relay);
    expect((await h.keysOf(relay)).filter(key => key.endsWith(':correction'))).toHaveLength(1);
    const reported = h.windows(relay).length;
    await h.reopenFrom(relay, publisher, corrected.reread);
    await h.reopenFrom(relay, publisher, corrected.reread);
    expect(h.windows(relay, reported)).toEqual(['changed', 'unchanged']);
    expect(await h.keysOf(relay)).toEqual([`user:${user.id}`, 'assistant:m1']);
    expect((await h.journalOf(relay)).state().items.map(value => (value.body?.item as { text?: string }).text)).toEqual(['Fix it', 'Final']);
  });
});

describe('journals are off unless the Relay and the Host switch them on', () => {
  it('declares journal support for Copilot and for no adapter that does not', () => {
    expect(supportsJournal(new CopilotAgentProvider())).toBe(true);
    expect(supportsJournal({})).toBe(false);
  });
});
