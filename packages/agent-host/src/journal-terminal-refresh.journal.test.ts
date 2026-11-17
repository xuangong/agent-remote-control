import type { AgentProviderAdapter, ProviderObservation } from '@orchardworks/agent-provider-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentHostDirectory } from './host.js';
import { NativeSessionOwnerError } from './native-session-owner.js';
import { boundary, item, ScriptedSession, untilReal as until } from './test-utils/journal-scripted-session.js';
import { closeHosts, startRelayHost } from './test-utils/relay-host-harness.js';

/**
 * A session a terminal CLI wrote while the Controller held no runtime of it. The provider is scripted, but its native history is written
 * outside any session, as a terminal writes it, and its directory reports the newer update time. Everything else is real: the uplink
 * socket, the hosted Relay, the Controller's host runtime, the publisher, the Relay's journal and its store.
 */
afterEach(async () => { vi.useRealTimers(); await closeHosts(); });

async function start(options: { capable?: boolean; idleGraceMs?: number; onRequestListing?: boolean } = {}) {
  /** What the native runtime holds, which a terminal appends to without any session. */
  const native = { rows: [item('history', 'm1', 'Hello'), item('history', 'm2', 'World')] as ProviderObservation[], updatedAt: Date.now() - 120_000 };
  const listedAt = native.updatedAt;
  const behavior: { open?: () => Error | undefined; refused: number } = { refused: 0 };
  const opened: ScriptedSession[] = [];
  const adapter: AgentProviderAdapter = {
    descriptor: { providerId: 'fake', displayName: 'Fake' },
    ...(options.capable === false ? {} : { journal: { itemIdentity: 1 as const } }),
    async createSession() { throw new Error('The Host supplies directory sessions.'); },
    async resumeSession() { throw new Error('The Host supplies directory sessions.'); },
  };
  const summary = (updatedAt: number) => ({ nativeSessionId: 'thread-1', providerId: 'fake', title: 'Thread', createdAt: new Date(listedAt - 1000).toISOString(), updatedAt: new Date(updatedAt).toISOString(), state: 'idle' as const });
  const directory: AgentHostDirectory = {
    providerId: 'fake', workspaces: async () => [], create: async () => 'thread-1', canReleaseSession: () => true,
    list: async () => [summary(options.onRequestListing ? listedAt : native.updatedAt)],
    // A listing read only on request serves what it last read and does not move when a terminal writes; the session is read on its own.
    ...(options.onRequestListing ? {
      listing: { status: () => ({ refreshing: false, complete: true, version: 1 }), refresh: async () => undefined },
      sessionSummary: async () => summary(native.updatedAt),
    } : {}),
    async open(nativeSessionId) {
      const failure = behavior.open?.();
      if (failure) { behavior.refused += 1; throw failure; }
      const session = new ScriptedSession('fake', nativeSessionId, [...native.rows, boundary()]);
      opened.push(session);
      return session;
    },
    async close() { await Promise.all(opened.map(session => session.dispose())); },
  };
  const relay = await startRelayHost({ registrations: [{ adapter, directory }], ...(options.idleGraceMs ? { idleGraceMs: options.idleGraceMs } : {}) });
  const attach = () => relay.attach('fake', 'thread-1');
  const listing = (revision = false) => relay.listing('fake', revision);
  const journal = () => relay.journal('fake', 'thread-1');
  const keys = async () => (await journal())?.state().items.map(entry => entry.itemKey) ?? [];
  /** The session is opened, published and released, so the Relay's journal holds what the native history held then. */
  const published = async () => {
    await attach();
    await until(async () => (await keys()).length === native.rows.length, 'the rows');
    await until(() => relay.released() === 1, 'the idle release');
  };
  /** A terminal writes a turn to the native history, and the directory reports the newer time. */
  const terminalWrites = (...rows: ProviderObservation[]) => {
    // The terminal wrote a minute ago, after the journal's window: the clock is moved on, as a minute goes by.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 120_000 });
    native.rows.push(...rows); native.updatedAt = Date.now() - 60_000;
  };
  /** A terminal that wrote only seconds ago, and may write again. */
  const terminalWritesJustNow = (...rows: ProviderObservation[]) => { vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 120_000 }); native.rows.push(...rows); native.updatedAt = Date.now() - 5_000; };
  const clockMovesOn = (ms: number) => { vi.setSystemTime(Date.now() + ms); };
  return { terminalWritesJustNow, clockMovesOn, store: relay.store, attach, listing, journal, keys, windows: relay.windows, released: relay.released, published, terminalWrites, native, behavior, opened, lifecycle: relay.lifecycle, restart: relay.restart };
}

const GRACE = 60;
const turn = () => [item('history', 'u2', 'Fix the bug', { type: 'user_message' }), item('history', 'a2', 'Done')];

describe('a session a terminal wrote while the Controller held no runtime of it', () => {
  it('shows the turn after the next listing without a send, as one appended window, and releases the runtime again', async () => {
    const run = await start({ idleGraceMs: GRACE });
    await run.published();
    const epoch = (await run.journal())!.epoch;
    expect(run.windows()).toEqual(['new']);
    run.terminalWrites(...turn());
    expect(await run.keys()).toEqual(['m1', 'm2']);
    await run.listing();
    await until(async () => (await run.keys()).includes('a2'), 'the turn in the journal');
    await until(() => run.released() === 2, 'the runtime released again');
    expect(await run.keys()).toEqual(['m1', 'm2', 'u2', 'a2']);
    await until(() => run.windows().length === 2, 'the window diagnostic');
    expect(run.windows()).toEqual(['new', 'appended']);
    expect((await run.journal())!.epoch).toBe(epoch);
    expect(run.opened).toHaveLength(2);
  });

  it('is reached by the revision check the page repeats, not only by a listing', async () => {
    const run = await start({ idleGraceMs: GRACE });
    await run.published();
    run.terminalWrites(...turn());
    await run.listing(true);
    await until(async () => (await run.keys()).includes('a2'), 'the turn in the journal');
  });

  it('attaches nothing for a listing that is not newer, and once only for the same update time listed again', async () => {
    const run = await start({ idleGraceMs: GRACE });
    await run.published();
    await run.listing();
    await run.listing();
    await new Promise<void>(resolve => setTimeout(resolve, 200));
    expect(run.opened).toHaveLength(1);
    run.terminalWrites(...turn());
    for (let at = 0; at < 4; at += 1) await run.listing();
    await until(() => run.released() === 2, 'the refresh');
    await run.listing();
    await run.listing();
    await new Promise<void>(resolve => setTimeout(resolve, 200));
    expect(run.opened).toHaveLength(2);
    await until(() => run.windows().length === 2, 'the window diagnostic');
    expect(run.windows()).toEqual(['new', 'appended']);
  });

  it('waits while a terminal owns the session, shows the owner\'s refusal as no attach, and catches up at the next listing after the owner exits', async () => {
    const run = await start({ idleGraceMs: GRACE });
    await run.published();
    run.terminalWrites(...turn());
    run.behavior.open = () => new NativeSessionOwnerError('native_session_owned', 'A terminal owns this session.', { kind: 'native_cli', generation: '0f3c2a1e-5b6d-4c7e-8f90-a1b2c3d4e5f6' });
    await run.listing();
    await until(() => run.behavior.refused === 1, 'the refused attach');
    await new Promise<void>(resolve => setTimeout(resolve, 100));
    expect(await run.keys()).toEqual(['m1', 'm2']);
    expect(run.opened).toHaveLength(1);
    run.behavior.open = undefined;
    await run.listing();
    await until(async () => (await run.keys()).includes('a2'), 'the turn once the owner is gone');
  });

  it('leaves a session a terminal wrote to only seconds ago, and attaches it once the terminal has been quiet for a while', async () => {
    const run = await start({ idleGraceMs: GRACE });
    await run.published();
    run.terminalWritesJustNow(...turn());
    await run.listing();
    await new Promise<void>(resolve => setTimeout(resolve, 200));
    expect(run.opened).toHaveLength(1);
    run.clockMovesOn(40_000);
    await run.listing();
    await until(async () => (await run.keys()).includes('a2'), 'the turn once the terminal was quiet');
  });

  it('reads the sessions it published one by one when the directory\'s listing is read only on request, since that listing does not move', async () => {
    const run = await start({ idleGraceMs: GRACE, onRequestListing: true });
    await run.published();
    run.terminalWrites(...turn());
    await run.listing();
    await until(async () => (await run.keys()).includes('a2'), 'the turn in the journal');
  });

  it('leaves a held session to itself: no attach while a manager follows it', async () => {
    const run = await start();
    await run.attach();
    await until(async () => (await run.keys()).length === 2, 'the rows');
    run.terminalWrites(...turn());
    await run.listing();
    await new Promise<void>(resolve => setTimeout(resolve, 200));
    expect(run.opened).toHaveLength(1);
    expect(await run.keys()).toEqual(['m1', 'm2']);
  });

  it('touches nothing of a provider that declares no journal support', async () => {
    const run = await start({ capable: false, idleGraceMs: GRACE });
    await run.attach();
    await until(() => run.released() === 1, 'the idle release');
    run.terminalWrites(...turn());
    await run.listing();
    await new Promise<void>(resolve => setTimeout(resolve, 200));
    expect(run.opened).toHaveLength(1);
    expect(await run.journal()).toBeUndefined();
  });

  it('touches nothing of a session this Controller never published', async () => {
    const run = await start({ idleGraceMs: GRACE });
    run.terminalWrites(...turn());
    await run.listing();
    await new Promise<void>(resolve => setTimeout(resolve, 200));
    expect(run.opened).toHaveLength(0);
    expect(await run.journal()).toBeUndefined();
  });

  it('does not retry a failed attach at the same update time, and tries again when the update time changes', async () => {
    const run = await start({ idleGraceMs: GRACE });
    await run.published();
    run.terminalWrites(...turn());
    let attempts = 0;
    run.behavior.open = () => { attempts += 1; return new Error('The native runtime failed to open.'); };
    await run.listing();
    await until(() => attempts === 1, 'the failed attach');
    await new Promise<void>(resolve => setTimeout(resolve, 100));
    await run.listing();
    await run.listing();
    await new Promise<void>(resolve => setTimeout(resolve, 200));
    expect(attempts).toBe(1);
    run.behavior.open = undefined;
    run.terminalWrites(item('history', 'a3', 'More'));
    await run.listing();
    await until(async () => (await run.keys()).includes('a3'), 'the turn after the update time changed');
    expect(attempts).toBe(1);
  });

  it('forgets what it published when the Controller restarts, so a turn written meanwhile shows at the next open through the Controller', async () => {
    const run = await start({ idleGraceMs: GRACE });
    await run.published();
    await run.restart();
    run.terminalWrites(...turn());
    await run.listing();
    await new Promise<void>(resolve => setTimeout(resolve, 300));
    expect(run.opened).toHaveLength(1);
    expect(await run.keys()).toEqual(['m1', 'm2']);
    await run.attach();
    await until(async () => (await run.keys()).includes('a2'), 'the turn at the next open');
    expect((await run.journal())!.state().items.map(entry => entry.itemKey)).toEqual(['m1', 'm2', 'u2', 'a2']);
    expect(run.windows().at(-1)).toBe('appended');
  });
});
