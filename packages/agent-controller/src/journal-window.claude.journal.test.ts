import type { ProviderObservation } from '@orchardworks/agent-provider-sdk';
import { supportsJournal } from '@orchardworks/agent-provider-sdk';
import { describe, expect, it } from 'vitest';

import { ClaudeAgentProvider } from '../../agent-provider-claude/src/provider.js';
import { MESSAGE_BUDGET_BYTES } from './journal-items.js';
import { recording } from './test-utils/recordings.js';
import { windowHarness } from './test-utils/journal-window-harness.js';

/**
 * What only Claude Code's recordings show, through the Controller's publisher and the Relay's real journal service. The scenarios every
 * provider shares are in journal-window.recordings.journal.test.ts.
 */
const h = windowHarness('claude');
const itemsOf = async (relay: ReturnType<typeof h.relay>) => (await h.journalOf(relay)).state().items;

describe('a recorded Claude Code session that is opened again', () => {
  it('replaces once, as a changed item, after a compaction, because the chain restarts at the boundary, and changes the epoch only then', async () => {
    const { run, relay, publisher } = await h.published('compaction');
    const epoch = (await h.journalOf(relay)).epoch;
    const reported = h.windows(relay).length;
    await h.reopenFrom(relay, publisher, run.reread);
    const replaced = (await h.journalOf(relay)).epoch;
    for (let open = 0; open < 4; open += 1) await h.reopenFrom(relay, publisher, run.reread);
    expect(h.windows(relay, reported)).toEqual(['changed', 'unchanged', 'unchanged', 'unchanged', 'unchanged']);
    expect(replaced).not.toBe(epoch);
    expect((await h.journalOf(relay)).epoch).toBe(replaced);
    expect((await itemsOf(relay)).some(value => value.body?.item.type === 'compaction')).toBe(false);
  });

  it('ends a compaction that never reached its boundary as failed, keeps the error the CLI printed, and drops the compaction at the next reopen', async () => {
    const { run, relay, publisher } = await h.published('failed-compaction');
    expect((await itemsOf(relay)).flatMap(value => value.body?.item.type === 'compaction' ? [value.body.item.status] : [])).toEqual(['failed']);
    const printed = (await itemsOf(relay)).filter(value => value.liveOnly).map(value => value.itemKey);
    expect(printed).toHaveLength(1);
    const reported = h.windows(relay).length;
    await h.reopenFrom(relay, publisher, run.reread);
    await h.reopenFrom(relay, publisher, run.reread);
    expect(h.windows(relay, reported)).toEqual(['changed', 'unchanged']);
    expect((await itemsOf(relay)).filter(value => value.liveOnly).map(value => value.itemKey)).toEqual(printed);
  });

  it('shows input withdrawn from the native queue until the next reopen, which replaces once and drops it', async () => {
    const { run, relay, publisher } = await h.published('withdrawn');
    const withdrawn = (await itemsOf(relay)).filter(value => (value.body?.item as { withdrawn?: unknown }).withdrawn !== undefined);
    expect(withdrawn).toHaveLength(1);
    const reported = h.windows(relay).length;
    await h.reopenFrom(relay, publisher, run.reread);
    await h.reopenFrom(relay, publisher, run.reread);
    expect(h.windows(relay, reported)).toEqual(['changed', 'unchanged']);
    expect((await itemsOf(relay)).some(value => (value.body?.item as { withdrawn?: unknown }).withdrawn !== undefined)).toBe(false);
  });

  it('keeps a folded input, a queued input and a hook-enriched turn unchanged over five reopens', async () => {
    for (const name of ['steer', 'queued', 'hook']) {
      const { run, relay, publisher } = await h.published(name);
      const reported = h.windows(relay).length;
      for (let at = 0; at < 5; at += 1) await h.reopenFrom(relay, publisher, run.reread);
      expect(h.windows(relay, reported), name).toEqual(Array(5).fill('unchanged'));
    }
  });

  it('answers a scroll past the window from the whole timeline it read at open, since Claude has no paged history, and reports one older request', async () => {
    const template = recording('claude', 'settled').reread.find(({ event }) => event.type === 'timeline' && event.item.type === 'assistant_message')!;
    if (template.event.type !== 'timeline' || template.event.item.type !== 'assistant_message') throw new Error('The recording has no assistant message.');
    const large = (key: string): ProviderObservation => ({ ...template, sourceKey: `claude:public:${key}`, itemIdentity: { key: `assistant:${key}`, completes: true },
      event: { ...template.event, item: { ...template.event.item, messageId: key, text: 'x'.repeat(Math.floor(MESSAGE_BUDGET_BYTES * 0.3)) } } } as ProviderObservation);
    const history = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map(large);
    const relay = h.relay();
    const publisher = h.start(relay);
    const { session } = await h.follow(publisher, history);
    expect(session.readTimelineHistory).toBeUndefined();
    await h.settled(relay);
    const before = await h.keysOf(relay);
    expect(before.length).toBeLessThan(6);
    const anchor = (await h.journalOf(relay)).oldestItemKey!;
    await expect(relay.connection.requestOlder(h.SESSION, 10, anchor)).resolves.toEqual({ olderAvailable: expect.any(Boolean) });
    await h.settle(60);
    const after = await h.keysOf(relay);
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.slice(-before.length)).toEqual(before);
    expect(relay.diagnosticDetails.filter(({ event, reason }) => event === 'journal_request' && reason === 'older')).toHaveLength(1);
  });
});

describe('journals are off unless the Relay and the Host switch them on', () => {
  it('declares journal support for Claude and for no adapter that does not', () => {
    expect(supportsJournal(new ClaudeAgentProvider())).toBe(true);
    expect(supportsJournal({})).toBe(false);
  });
});
