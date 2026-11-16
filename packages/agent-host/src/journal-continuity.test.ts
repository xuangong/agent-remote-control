import { describe, expect, it } from 'vitest';

import { continuityPlan, expectContinuity, itemsOf } from './test-utils/journal-continuity.js';
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
    await expectContinuity({ live: liveRun(), reread: reread() });
    const plan = await continuityPlan({ live: liveRun(), reread: reread() });
    expect(plan).toMatchObject({ kind: 'continue', ops: [] });
  });

  it('accepts an unchanged session that has a background item, although every reconcile restates its outcome', async () => {
    const background = { id: 'review-1', kind: 'review' as const, status: 'visible' as const };
    const withBackground = <T extends ReturnType<typeof item>>(observation: T): T => ({ ...observation, event: { ...observation.event, item: { ...observation.event.item, background } } }) as T;
    const live = [...liveRun(), withBackground(item('live', 'assistant:3', 'Review started', { completes: true }))];
    const again = [...reread(), withBackground(item('history', 'assistant:3', 'Review started'))];
    await expectContinuity({ live, reread: again });
    const plan = await continuityPlan({ live, reread: again });
    expect(plan.kind === 'continue' && plan.ops.map(({ op }) => op.op)).toEqual(['outcome']);
  });

  it('groups observations into the items a journal would hold, in order', async () => {
    const items = await itemsOf(liveRun());
    expect(items.map(({ key, complete, liveOnly }) => [key, complete, liveOnly])).toEqual([
      ['user:1', true, false], ['assistant:1', true, false], ['assistant:2', true, false], ['question:1', true, true],
    ]);
  });

  it('accepts a reread that covers only the newest items, as a provider that reads the latest page does', async () => {
    await expectContinuity({ live: liveRun(), reread: reread().slice(1) });
  });

  it('fails an adapter whose live keys are not the keys of its records', async () => {
    const live = [item('history', 'record:1', 'Hello'), item('live', 'stream:1', 'Hi', { completes: true })];
    const sameItemAfterReopen = [item('history', 'record:1', 'Hello'), item('history', 'record:2', 'Hi')];
    await expect(expectContinuity({ live, reread: sameItemAfterReopen })).rejects.toThrow(/append|prepend|correct|replace/);
  });

  it('fails an adapter whose reread content differs from what it streamed', async () => {
    const changed = [...reread().slice(0, 2), item('history', 'assistant:2', 'The cause is a deadlock.')];
    await expect(expectContinuity({ live: liveRun(), reread: changed })).rejects.toThrow(/correct/);
    expect(await continuityPlan({ live: liveRun(), reread: changed })).toMatchObject({ kind: 'continue', ops: [{ op: { op: 'correct' } }] });
  });

  it('fails an adapter whose reread does not complete its items', async () => {
    const open = [...reread().slice(0, 2), item('history', 'assistant:2', 'The cause is a race.', { completes: false })];
    await expect(expectContinuity({ live: liveRun(), reread: open })).rejects.toThrow(/complete/);
  });

  it('fails an adapter whose observations lack an item identity', async () => {
    const bare = { ...item('history', 'x', 'No identity'), itemIdentity: undefined };
    await expect(expectContinuity({ live: [bare], reread: [bare] })).rejects.toThrow(/identity/);
  });

  it('fails an adapter whose key uses the prefix the Controller reserves for its own items', async () => {
    const reserved = item('history', 'controller:answer', 'Hello');
    await expect(expectContinuity({ live: [reserved], reread: [reserved] })).rejects.toThrow(/identity contract/);
  });

  it('fails an adapter whose live observation, after a well-formed history, lacks an identity', async () => {
    const bare = { ...item('live', 'x', 'Late', { completes: true }), itemIdentity: undefined };
    await expect(expectContinuity({ live: [...reread(), bare], reread: reread() })).rejects.toThrow(/identity/);
  });

  it('covers the interaction items the agent manager builds: an adapter that gives them an identity passes, one that does not fails', async () => {
    const question = { kind: 'question' as const, requestId: 'q1', questions: [{ questionId: 'q', header: 'Pick', prompt: 'Which?', required: true, selection: 'single' as const, options: [{ value: 'a', label: 'A' }], allowCustomText: false, allowDismiss: false }] };
    const asked = { type: 'observation' as const, sourceKey: 'ask', occurredAt: 1, delivery: 'live' as const, event: { type: 'interaction_requested' as const, provider: 'fake', request: question } };
    const answered = (identity?: { key: string; completes?: true; liveOnly?: true }) => ({ type: 'observation' as const, sourceKey: 'answer', occurredAt: 2, delivery: 'live' as const,
      event: { type: 'interaction_resolved' as const, provider: 'fake', requestId: 'q1', response: { kind: 'question' as const, answers: [] } }, ...(identity ? { itemIdentity: identity } : {}) });
    const live = (identity?: { key: string; completes?: true; liveOnly?: true }) => [...liveRun(), asked, answered(identity)];
    const items = await itemsOf(live({ key: 'interaction:q1', completes: true, liveOnly: true }));
    expect(items.at(-1)).toMatchObject({ key: 'interaction:q1', complete: true, liveOnly: true });
    await expectContinuity({ live: live({ key: 'interaction:q1', completes: true, liveOnly: true }), reread: reread() });
    await expect(itemsOf(live())).rejects.toThrow(/answer.*identity|identity.*answer/);
  });

  it('tells a genuine rewrite from an extension: a removed item means a replacement', async () => {
    const rewritten = [reread()[0]!, reread()[2]!];
    expect(await continuityPlan({ live: liveRun(), reread: rewritten })).toMatchObject({ kind: 'replace', reason: 'missing' });
  });
});
