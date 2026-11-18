import { AgentSessionInUseError } from '@orchardworks/agent-provider-sdk';
import type { RemoteSessionSummary } from '@orchardworks/agent-session-runtime';
import { describe, expect, it } from 'vitest';

import { NativeSessionOwnerError } from '../native-session-owner.js';
import {
  createTerminalRefresh, JOURNAL_REFRESH_QUIET_MS, JOURNAL_REFRESH_READS, JOURNAL_REFRESH_SESSIONS, type RefreshBinding, type RefreshDirectory,
} from './terminal-refresh.js';

const NOW = 1_000_000_000_000;
const MINUTE = 60_000;

const binding = (nativeSessionId: string, extra: Partial<RefreshBinding> = {}): RefreshBinding => ({ agentId: `agent-${nativeSessionId}`, providerId: 'fake', nativeSessionId, ...extra });
const summary = (nativeSessionId: string, updatedAt: number): RemoteSessionSummary => ({
  nativeSessionId, providerId: 'fake', title: nativeSessionId, createdAt: new Date(0).toISOString(), updatedAt: new Date(updatedAt).toISOString(), state: 'idle',
});

/** Fake ports: a clock, the bindings, the runtimes, and a record of what the refresh did. */
function harness(options: { directory?: RefreshDirectory; granted?: boolean } = {}) {
  const state = {
    now: NOW, granted: options.granted ?? true, stopped: false,
    bindings: [] as RefreshBinding[], live: new Set<string>(), demand: new Set<string>(),
    attached: [] as string[], expired: [] as string[], released: [] as string[], journalServing: true,
    attach: (_agentId: string): Promise<void> => Promise.resolve(),
    diverged: new Map<string, number>(),
  };
  const directory: RefreshDirectory = options.directory ?? { canReleaseSession: () => true, divergedAt: id => state.diverged.get(id) };
  const refresh = createTerminalRefresh({
    now: () => state.now,
    directory: providerId => providerId === 'fake' ? directory : undefined,
    bindings: () => state.bindings,
    bindingOf: (providerId, nativeSessionId) => state.bindings.find(item => item.providerId === providerId && item.nativeSessionId === nativeSessionId),
    isLive: agentId => state.live.has(agentId),
    hasDemand: agentId => state.demand.has(agentId),
    expire: agentId => { state.expired.push(agentId); },
    granted: () => state.granted,
    stopped: () => state.stopped,
    attachAndRelease: async agentId => { state.attached.push(agentId); await state.attach(agentId); },
    releaseJournal: async agentId => { state.released.push(agentId); return state.journalServing; },
  });
  /** The session was published and released at `NOW`; its journal covers what it held then. */
  const published = async (id: string) => { const item = binding(id); state.bindings.push(item); await refresh.releaseJournal(item); return item; };
  /** The terminal wrote `agoMs` before the clock's present. */
  const writtenAgo = (id: string, agoMs: number) => summary(id, state.now - agoMs);
  return { state, refresh, published, writtenAgo };
}

describe('which sessions a listing makes due', () => {
  it('attaches a published session once its listed update is newer than its coverage and the terminal has been quiet', async () => {
    const run = harness();
    const item = await run.published('s1');
    run.state.now += 2 * MINUTE;
    await run.refresh.refresh('fake', [run.writtenAgo('s1', MINUTE)]);
    expect(run.state.attached).toEqual([item.agentId]);
  });

  it('attaches nothing for an update that is not newer than the coverage', async () => {
    const run = harness();
    await run.published('s1');
    run.state.now += 2 * MINUTE;
    await run.refresh.refresh('fake', [summary('s1', NOW - 1), summary('s1', NOW)]);
    expect(run.state.attached).toEqual([]);
  });

  it('attaches the same update time once: the coverage moves to it before the attach', async () => {
    const run = harness();
    await run.published('s1');
    run.state.now += 2 * MINUTE;
    const listed = [run.writtenAgo('s1', MINUTE)];
    for (let at = 0; at < 4; at += 1) await run.refresh.refresh('fake', listed);
    expect(run.state.attached).toHaveLength(1);
    expect(run.refresh.coverage().get('fake:s1')).toBe(Date.parse(listed[0]!.updatedAt));
  });

  it('leaves a session a terminal wrote to only seconds ago, and attaches it once the terminal has been quiet', async () => {
    const run = harness();
    await run.published('s1');
    run.state.now += 2 * MINUTE;
    await run.refresh.refresh('fake', [run.writtenAgo('s1', JOURNAL_REFRESH_QUIET_MS - 1)]);
    expect(run.state.attached).toEqual([]);
    run.state.now += 1;
    await run.refresh.refresh('fake', [summary('s1', run.state.now - JOURNAL_REFRESH_QUIET_MS)]);
    expect(run.state.attached).toHaveLength(1);
  });

  it('touches nothing it never published, nor a summary with no readable time', async () => {
    const run = harness();
    run.state.bindings.push(binding('never'));
    await run.published('s1');
    run.state.now += 2 * MINUTE;
    await run.refresh.refresh('fake', [run.writtenAgo('never', MINUTE), { ...run.writtenAgo('s1', MINUTE), updatedAt: 'not a time' }]);
    expect(run.state.attached).toEqual([]);
  });

  it('leaves a held session to itself: neither a runtime nor demand lets the refresh attach it', async () => {
    const run = harness();
    const held = await run.published('s1');
    const wanted = await run.published('s2');
    run.state.live.add(held.agentId);
    run.state.demand.add(wanted.agentId);
    run.state.now += 2 * MINUTE;
    await run.refresh.refresh('fake', [run.writtenAgo('s1', MINUTE), run.writtenAgo('s2', MINUTE)]);
    expect(run.state.attached).toEqual([]);
  });

  it('attaches the due sessions newest first', async () => {
    const run = harness();
    const older = await run.published('older');
    const newer = await run.published('newer');
    run.state.now += 10 * MINUTE;
    await run.refresh.refresh('fake', [run.writtenAgo('older', 5 * MINUTE), run.writtenAgo('newer', MINUTE)]);
    expect(run.state.attached).toEqual([newer.agentId, older.agentId]);
  });

  it('does nothing for a provider that has no directory, or while the connection holds no journal grant', async () => {
    const run = harness({ granted: false });
    await run.published('s1');
    run.state.now += 2 * MINUTE;
    await run.refresh.refresh('fake', [run.writtenAgo('s1', MINUTE)]);
    await run.refresh.refresh('other', [run.writtenAgo('s1', MINUTE)]);
    expect(run.state.attached).toEqual([]);
  });

  it('stops attaching once the Controller stops', async () => {
    const run = harness();
    await run.published('s1');
    await run.published('s2');
    run.state.now += 10 * MINUTE;
    run.state.attach = async () => { run.state.stopped = true; };
    await run.refresh.refresh('fake', [run.writtenAgo('s1', 2 * MINUTE), run.writtenAgo('s2', MINUTE)]);
    expect(run.state.attached).toHaveLength(1);
  });
});

describe('a failed attach', () => {
  it('waits for the next change when it failed for any other reason, and tries again when the update time changes', async () => {
    const run = harness();
    await run.published('s1');
    run.state.now += 2 * MINUTE;
    run.state.attach = () => Promise.reject(new Error('The native runtime failed to open.'));
    await run.refresh.refresh('fake', [run.writtenAgo('s1', MINUTE)]);
    await run.refresh.refresh('fake', [run.writtenAgo('s1', MINUTE)]);
    expect(run.state.attached).toHaveLength(1);
    run.state.now += MINUTE;
    await run.refresh.refresh('fake', [run.writtenAgo('s1', 40_000)]);
    expect(run.state.attached).toHaveLength(2);
  });

  it.each([
    ['a terminal owns the session', () => new NativeSessionOwnerError('native_session_owned', 'A terminal owns this session.', { kind: 'native_cli', generation: '0f3c2a1e-5b6d-4c7e-8f90-a1b2c3d4e5f6' })],
    ['the session is in use', () => new AgentSessionInUseError('The session is in use.')],
  ])('is tried again at the next listing, with the same update time, when %s', async (_name, refusal) => {
    const run = harness();
    await run.published('s1');
    run.state.now += 2 * MINUTE;
    const listed = [run.writtenAgo('s1', MINUTE)];
    run.state.attach = () => Promise.reject(refusal());
    await run.refresh.refresh('fake', listed);
    expect(run.refresh.coverage().get('fake:s1')).toBe(NOW);
    run.state.attach = () => Promise.resolve();
    await run.refresh.refresh('fake', listed);
    expect(run.state.attached).toHaveLength(2);
    await run.refresh.refresh('fake', listed);
    expect(run.state.attached).toHaveLength(2);
  });
});

describe('a directory whose listing is read only on request', () => {
  it('reads the remembered sessions one by one, in batches, and ignores a read that fails', async () => {
    const reads: string[] = [];
    let inFlight = 0, widest = 0;
    const times = new Map<string, number>();
    const run = harness({ directory: {
      listing: {}, canReleaseSession: () => true,
      async sessionSummary(id) {
        reads.push(id); inFlight += 1; widest = Math.max(widest, inFlight);
        await Promise.resolve(); inFlight -= 1;
        if (id === 'broken') throw new Error('unreadable');
        return summary(id, times.get(id)!);
      },
    } });
    const ids = ['a', 'b', 'c', 'd', 'e', 'broken'];
    for (const id of ids) await run.published(id);
    run.state.now += 10 * MINUTE;
    for (const id of ids) times.set(id, run.state.now - MINUTE);
    await run.refresh.refresh('fake', []);
    expect(reads).toEqual(ids);
    expect(widest).toBe(JOURNAL_REFRESH_READS);
    expect(run.state.attached).toHaveLength(5);
    expect(run.state.attached).not.toContain('agent-broken');
  });

  it('ignores the listing it rides on and reads only what it remembers', async () => {
    const run = harness({ directory: { listing: {}, canReleaseSession: () => true, sessionSummary: async () => undefined } });
    await run.published('s1');
    run.state.now += 2 * MINUTE;
    await run.refresh.refresh('fake', [run.writtenAgo('s1', MINUTE)]);
    expect(run.state.attached).toEqual([]);
  });
});

describe('a resident session another writer moved past', () => {
  it('is expired when its transcript diverged, it has no demand and its provider can release it', async () => {
    const run = harness();
    const idleOne = await run.published('idle');
    const wanted = await run.published('wanted');
    const child = binding('child', { parentNativeSessionId: 'idle' });
    run.state.bindings.push(child);
    for (const item of [idleOne, wanted, child]) { run.state.live.add(item.agentId); run.state.diverged.set(item.nativeSessionId, 1); }
    run.state.demand.add(wanted.agentId);
    await run.refresh.refresh('fake', []);
    expect(run.state.expired).toEqual([idleOne.agentId]);
  });

  it('is left alone when nothing diverged, or when the provider cannot release it', async () => {
    const run = harness();
    const item = await run.published('s1');
    run.state.live.add(item.agentId);
    await run.refresh.refresh('fake', []);
    expect(run.state.expired).toEqual([]);
    const other = harness({ directory: { canReleaseSession: () => false, divergedAt: () => 1 } });
    const held = await other.published('s1');
    other.state.live.add(held.agentId);
    await other.refresh.refresh('fake', []);
    expect(other.state.expired).toEqual([]);
  });

  it('is expired even while the connection holds no journal grant', async () => {
    const run = harness({ granted: false });
    const item = await run.published('s1');
    run.state.live.add(item.agentId);
    run.state.diverged.set('s1', 1);
    await run.refresh.refresh('fake', []);
    expect(run.state.expired).toEqual([item.agentId]);
  });
});

describe('what a released session covers', () => {
  it('covers the time the release started, or the diverged write when the session was behind its transcript', async () => {
    const run = harness();
    await run.published('s1');
    run.state.diverged.set('s2', 123);
    await run.published('s2');
    expect(run.refresh.coverage().get('fake:s1')).toBe(NOW);
    expect(run.refresh.coverage().get('fake:s2')).toBe(123);
  });

  it('never covers less than what a listing already told', async () => {
    const run = harness();
    const item = await run.published('s1');
    run.state.now += 2 * MINUTE;
    await run.refresh.refresh('fake', [run.writtenAgo('s1', MINUTE)]);
    const told = run.refresh.coverage().get('fake:s1')!;
    run.state.now -= 10 * MINUTE;
    await run.refresh.releaseJournal(item);
    expect(run.refresh.coverage().get('fake:s1')).toBe(told);
  });

  it('remembers nothing when the journal was not serving the session', async () => {
    const run = harness();
    run.state.journalServing = false;
    await run.published('s1');
    expect(run.refresh.coverage().size).toBe(0);
  });

  it('keeps only the sessions released most recently, a re-release counting as most recent', async () => {
    const run = harness();
    const first = await run.published('s0');
    for (let at = 1; at < JOURNAL_REFRESH_SESSIONS; at += 1) await run.published(`s${at}`);
    await run.refresh.releaseJournal(first);
    await run.published('extra');
    const kept = [...run.refresh.coverage().keys()];
    expect(kept).toHaveLength(JOURNAL_REFRESH_SESSIONS);
    expect(kept).not.toContain('fake:s1');
    expect(kept.at(-1)).toBe('fake:extra');
    expect(kept.at(-2)).toBe('fake:s0');
  });
});

describe('the listing entry point', () => {
  it('runs one refresh at a time and starts the next after it ends', async () => {
    const run = harness();
    await run.published('s1');
    run.state.now += 2 * MINUTE;
    let finish!: () => void;
    run.state.attach = () => new Promise<void>(resolve => { finish = resolve; });
    const listed = [run.writtenAgo('s1', MINUTE)];
    run.refresh.listed('fake', listed);
    await Promise.resolve();
    run.refresh.listed('fake', [run.writtenAgo('s1', 30_000)]);
    await Promise.resolve();
    expect(run.state.attached).toHaveLength(1);
    finish();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    run.refresh.listed('fake', [run.writtenAgo('s1', 30_000)]);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(run.state.attached).toHaveLength(2);
  });

  it('starts nothing while the Controller stops, and never fails the listing it rides on', async () => {
    const run = harness();
    await run.published('s1');
    run.state.now += 2 * MINUTE;
    run.state.stopped = true;
    run.refresh.listed('fake', [run.writtenAgo('s1', MINUTE)]);
    run.state.stopped = false;
    run.state.granted = true;
    run.state.attach = () => Promise.reject(new Error('boom'));
    expect(() => run.refresh.listed('fake', [run.writtenAgo('s1', MINUTE)])).not.toThrow();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(run.state.attached).toHaveLength(1);
  });
});
