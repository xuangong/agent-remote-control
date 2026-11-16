import { describe, expect, it } from 'vitest';

import { continuityOutcome, itemsOf } from './test-utils/journal-continuity.js';
import { item } from './test-utils/journal-scripted-session.js';

/** What a session emitted while it ran: history at open, then live deltas of one reply and a user message. */
const liveRun = () => [
  item('history', 'user:1', 'Fix the bug', { type: 'user_message' }),
  item('history', 'assistant:1', 'On it.'),
  item('live', 'assistant:2', 'The cause ', { completes: false }),
  item('live', 'assistant:2', 'is a race.', { completes: true }),
  item('live', 'question:1', 'Which file?', { completes: true, liveOnly: true }),
];

/** What the adapter returns after the session was reopened: finalized records, whole. */
const reread = () => [
  item('history', 'user:1', 'Fix the bug', { type: 'user_message' }),
  item('history', 'assistant:1', 'On it.'),
  item('history', 'assistant:2', 'The cause is a race.'),
];

describe('the continuity fixture', () => {
  it('accepts an adapter whose live deltas and reread records share keys and content, and adds nothing to the journal', async () => {
    expect(await continuityOutcome({ live: liveRun(), reread: reread() })).toEqual({ outcome: 'unchanged' });
  });

  it('accepts an unchanged session that has a background item', async () => {
    const background = { id: 'review-1', kind: 'review' as const, status: 'visible' as const };
    const withBackground = <T extends ReturnType<typeof item>>(observation: T): T => ({ ...observation, event: { ...observation.event, item: { ...observation.event.item, background } } }) as T;
    const live = [...liveRun(), withBackground(item('live', 'assistant:3', 'Review started', { completes: true }))];
    const again = [...reread(), withBackground(item('history', 'assistant:3', 'Review started'))];
    expect(await continuityOutcome({ live, reread: again })).toEqual({ outcome: 'unchanged' });
  });

  it('groups observations into the items a journal would hold, in order', async () => {
    const items = await itemsOf(liveRun());
    expect(items.map(({ key, complete, liveOnly }) => [key, complete, liveOnly])).toEqual([
      ['user:1', true, false], ['assistant:1', true, false], ['assistant:2', true, false], ['question:1', true, true],
    ]);
  });

  it('accepts a reread that covers only the newest items, as a provider that reads the latest page does', async () => {
    expect(await continuityOutcome({ live: liveRun(), reread: reread().slice(1) })).toEqual({ outcome: 'unchanged' });
  });

  it('tells an adapter whose live keys are not the keys of its records: the reread replaces the journal', async () => {
    const live = [item('history', 'record:1', 'Hello'), item('live', 'stream:1', 'Hi', { completes: true })];
    const sameItemAfterReopen = [item('history', 'record:1', 'Hello'), item('history', 'record:2', 'Hi')];
    expect(await continuityOutcome({ live, reread: sameItemAfterReopen })).toEqual({ outcome: 'replaced', reason: 'changed' });
  });

  it('tells an adapter whose reread content differs from what it streamed, and one whose reread leaves an item open', async () => {
    const changed = [...reread().slice(0, 2), item('history', 'assistant:2', 'The cause is a deadlock.')];
    expect(await continuityOutcome({ live: liveRun(), reread: changed })).toEqual({ outcome: 'replaced', reason: 'changed' });
    const open = [...reread().slice(0, 2), item('history', 'assistant:2', 'The cause is a race.', { completes: false })];
    expect(await continuityOutcome({ live: liveRun(), reread: open })).toEqual({ outcome: 'replaced', reason: 'open_item' });
  });

  it('fails an adapter whose observations lack an item identity', async () => {
    const bare = { ...item('history', 'x', 'No identity'), itemIdentity: undefined };
    await expect(continuityOutcome({ live: [bare], reread: [bare] })).rejects.toThrow(/identity/);
  });

  it('fails an adapter whose key uses the prefix the Controller reserves for its own items', async () => {
    const reserved = item('history', 'controller:answer', 'Hello');
    await expect(continuityOutcome({ live: [reserved], reread: [reserved] })).rejects.toThrow(/identity contract/);
  });

  it('fails an adapter whose live observation, after a well-formed history, lacks an identity', async () => {
    const bare = { ...item('live', 'x', 'Late', { completes: true }), itemIdentity: undefined };
    await expect(continuityOutcome({ live: [...reread(), bare], reread: reread() })).rejects.toThrow(/identity/);
  });

  it('covers the interaction items the agent manager builds: an adapter that gives them an identity passes, one that does not fails', async () => {
    const question = { kind: 'question' as const, requestId: 'q1', questions: [{ questionId: 'q', header: 'Pick', prompt: 'Which?', required: true, selection: 'single' as const, options: [{ value: 'a', label: 'A' }], allowCustomText: false, allowDismiss: false }] };
    const asked = { type: 'observation' as const, sourceKey: 'ask', occurredAt: 1, delivery: 'live' as const, event: { type: 'interaction_requested' as const, provider: 'fake', request: question } };
    const answered = (identity?: { key: string; completes?: true; liveOnly?: true }) => ({ type: 'observation' as const, sourceKey: 'answer', occurredAt: 2, delivery: 'live' as const,
      event: { type: 'interaction_resolved' as const, provider: 'fake', requestId: 'q1', response: { kind: 'question' as const, answers: [] } }, ...(identity ? { itemIdentity: identity } : {}) });
    const live = (identity?: { key: string; completes?: true; liveOnly?: true }) => [...liveRun(), asked, answered(identity)];
    const items = await itemsOf(live({ key: 'interaction:q1', completes: true, liveOnly: true }));
    expect(items.at(-1)).toMatchObject({ key: 'interaction:q1', complete: true, liveOnly: true });
    expect(await continuityOutcome({ live: live({ key: 'interaction:q1', completes: true, liveOnly: true }), reread: reread() })).toEqual({ outcome: 'unchanged' });
    await expect(itemsOf(live())).rejects.toThrow(/answer.*identity|identity.*answer/);
  });

  it('tells a genuine rewrite from an extension: a removed item means a replacement, a new item at the end an append', async () => {
    const rewritten = [reread()[0]!, reread()[2]!];
    expect(await continuityOutcome({ live: liveRun(), reread: rewritten })).toMatchObject({ outcome: 'replaced' });
    expect(await continuityOutcome({ live: liveRun(), reread: [...reread(), item('history', 'assistant:3', 'More')] })).toEqual({ outcome: 'appended' });
  });
});
