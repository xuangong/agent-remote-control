import { describe, expect, it } from 'vitest';

import { createBrokerState } from './broker-state.js';
import type { RemoteHostBrokerState } from './broker-types.js';
import { createJournalDeletion } from './journal-deletion.js';

const saved = (journalDeletions: string[]): RemoteHostBrokerState => ({ keys: [], hosts: [], bindings: [], creations: [], journalDeletions });

/** A scheduler the test moves by hand. */
function manualScheduler() {
  const timers = new Map<number, { at: number; callback: () => void }>();
  let now = 0, next = 0;
  return {
    setTimeout(callback: () => void, delayMs: number) { timers.set(++next, { at: now + delayMs, callback }); return next; },
    clearTimeout(timer: unknown) { timers.delete(timer as number); },
    advance(ms: number) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); } },
  };
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const until = async (check: () => boolean) => { for (let turn = 0; turn < 200 && !check(); turn += 1) await tick(); expect(check()).toBe(true); };

function setup(pending: string[], deleteHost: (hostId: string) => Promise<void>) {
  const saves: RemoteHostBrokerState[] = [];
  const state = createBrokerState({ initialState: saved(pending), now: () => 0, onStateChange: next => { saves.push(next); }, keepsAssociations: false, keepsSharing: false });
  const scheduler = manualScheduler();
  const diagnostics: Array<[string, string]> = [];
  const deletion = createJournalDeletion({ state, journals: { deleteHost: async hostId => { await deleteHost(hostId); } }, scheduler, diagnostics: { record: (hostId, entry) => { diagnostics.push([hostId, entry.event]); } } as never, timeoutMs: 1000 });
  return { state, saves, scheduler, diagnostics, deletion };
}

describe('journal deletion', () => {
  it('deletes the pending ids one after another and saves the list as each is confirmed', async () => {
    const called: string[] = [];
    const run = setup(['h1', 'h2'], async hostId => { called.push(hostId); });
    run.deletion.drain();
    await until(() => run.state.journalDeletions.length === 0);
    expect(called).toEqual(['h1', 'h2']);
    expect(run.saves.map(save => save.journalDeletions)).toEqual([['h2'], undefined]);
  });

  it('leaves an id pending when the store call fails, and tries it again at the next pass', async () => {
    let failing = true;
    const run = setup(['h1'], async () => { if (failing) throw new Error('store down'); });
    run.deletion.drain();
    await until(() => run.diagnostics.length > 0);
    expect(run.diagnostics[0]).toEqual(['h1', 'journal_store_failed']);
    expect(run.state.journalDeletions).toEqual(['h1']);
    failing = false;
    run.deletion.drain();
    await until(() => run.state.journalDeletions.length === 0);
  });

  it('gives up waiting at the deadline without a second store call for the same entry', async () => {
    let calls = 0;
    const run = setup(['h1'], () => { calls += 1; return new Promise<void>(() => undefined); });
    const waiting = run.deletion.deleteOne('h1');
    await tick();
    run.scheduler.advance(1000);
    expect(await waiting).toBe(false);
    const again = run.deletion.deleteOne('h1');
    await tick();
    run.scheduler.advance(1000);
    expect(await again).toBe(false);
    expect(calls).toBe(1);
    expect(run.diagnostics.filter(([, event]) => event === 'journal_store_failed')).toHaveLength(2);
  });

  it('keeps an id that was revoked again while its call ran, and deletes it with a call of its own', async () => {
    const releases: Array<() => void> = [];
    let calls = 0;
    const run = setup(['h1'], () => { calls += 1; return new Promise<void>(resolve => { releases.push(resolve); }); });
    run.deletion.drain();
    await until(() => releases.length === 1);
    run.deletion.revoked('h1');
    releases[0]!();
    await until(() => releases.length === 2);
    expect(run.state.journalDeletions).toEqual(['h1']);
    releases[1]!();
    await until(() => run.state.journalDeletions.length === 0);
    expect(calls).toBe(2);
  });

  it('shares one call among the callers that wait for the same entry', async () => {
    let release!: () => void, calls = 0;
    const run = setup(['h1'], () => { calls += 1; return new Promise<void>(resolve => { release = resolve; }); });
    const first = run.deletion.deleteOne('h1'), second = run.deletion.deleteOne('h1');
    await tick();
    release();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(calls).toBe(1);
  });

  it('starts the call for a later revoke only after the call in flight ended', async () => {
    const releases: Array<() => void> = [];
    const run = setup(['h1'], () => new Promise<void>(resolve => { releases.push(resolve); }));
    const first = run.deletion.deleteOne('h1');
    await tick();
    run.deletion.revoked('h1');
    const second = run.deletion.deleteOne('h1');
    await tick(); await tick();
    expect(releases).toHaveLength(1);
    releases[0]!();
    await until(() => releases.length === 2);
    releases[1]!();
    expect(await Promise.all([first, second])).toEqual([true, true]);
  });

  it('records an id the full list pushed out as dropped', () => {
    const run = setup([], async () => undefined);
    run.deletion.revoked('h2', 'h1');
    expect(run.diagnostics).toContainEqual(['h2', 'journal_deletion_dropped']);
  });

  it('does nothing without a journal service', async () => {
    const state = createBrokerState({ initialState: saved(['h1']), now: () => 0, keepsAssociations: false, keepsSharing: false });
    const deletion = createJournalDeletion({ state, journals: undefined, scheduler: manualScheduler(), diagnostics: undefined, timeoutMs: 1000 });
    deletion.drain();
    expect(await deletion.deleteOne('h1')).toBe(false);
    expect(state.journalDeletions).toEqual(['h1']);
  });
});
