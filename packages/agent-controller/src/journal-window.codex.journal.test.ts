import { supportsJournal } from '@orchardworks/agent-provider-sdk';
import { describe, expect, it } from 'vitest';

import { CodexAppServerProvider } from '../../agent-provider-codex/src/provider.js';
import { windowHarness } from './test-utils/journal-window-harness.js';

/**
 * What only Codex's recordings show, through the Controller's publisher and the Relay's real journal service. The scenarios every
 * provider shares are in journal-window.recordings.journal.test.ts.
 */
const h = windowHarness('codex');
const itemsOf = async (relay: ReturnType<typeof h.relay>) => (await h.journalOf(relay)).state().items;
const textOf = (value: { body?: { item: unknown } }) => (value.body?.item as { text?: string }).text;

describe('a recorded Codex session that is opened again', () => {
  it('replaces once, as a changed item, for a final message that does not continue the stream, and then holds the base once and no correction item', async () => {
    const { run, relay, publisher } = await h.published('correction');
    expect((await h.keysOf(relay)).filter(key => key.endsWith(':correction'))).toHaveLength(1);
    const reported = h.windows(relay).length;
    const epoch = (await h.journalOf(relay)).epoch;
    await h.reopenFrom(relay, publisher, run.reread);
    await h.reopenFrom(relay, publisher, run.reread);
    expect(h.windows(relay, reported)).toEqual(['changed', 'unchanged']);
    expect((await h.journalOf(relay)).epoch).not.toBe(epoch);
    expect((await h.keysOf(relay)).filter(key => key.endsWith(':correction'))).toEqual([]);
    expect((await h.keysOf(relay)).filter(key => key === 'assistant:m1')).toHaveLength(1);
    expect((await itemsOf(relay)).filter(value => value.itemKey === 'assistant:m1').map(textOf)).toEqual(['xyz']);
  });

  it('shows a plan turn once, as the plan message and the card that approved it, and reopens it unchanged', async () => {
    const { run, relay, publisher } = await h.published('plan-mode');
    const keys = await h.keysOf(relay);
    expect(keys.filter(key => key.startsWith('assistant:') && key.endsWith('-plan'))).toHaveLength(1);
    expect(keys.filter(key => key.startsWith('interaction:plan:'))).toHaveLength(1);
    const reported = h.windows(relay).length;
    await h.reopenFrom(relay, publisher, run.reread);
    expect(h.windows(relay, reported)).toEqual(['unchanged']);
    expect(await h.keysOf(relay)).toEqual(keys);
  });

  it('keeps the question and the approval that native history never held, through a reopen after a turn that ran after another reopen', async () => {
    const { run, relay, publisher } = await h.published('approval');
    expect((await itemsOf(relay)).filter(value => value.liveOnly).map(value => value.itemKey)).toEqual(['interaction:q1', 'interaction:c1']);
    await h.reopenFrom(relay, publisher, run.reread);
    expect((await itemsOf(relay)).filter(value => value.liveOnly).map(value => value.itemKey)).toEqual(['interaction:q1', 'interaction:c1']);
  });
});

describe('journals are off unless the Relay and the Host switch them on', () => {
  it('declares journal support for Codex and for no adapter that does not', () => {
    expect(supportsJournal(new CodexAppServerProvider())).toBe(true);
    expect(supportsJournal({})).toBe(false);
  });
});
