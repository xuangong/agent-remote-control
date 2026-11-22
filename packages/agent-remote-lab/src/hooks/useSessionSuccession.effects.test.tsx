// Effects of useSessionSuccession around the pure reducers of agent-client/succession: discovery, the Relay feed, stale
// retries, attach, binding and settlement. Ports are fakes and the clock is fake; no Relay, socket or App is involved.
import { act, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeNotConfirmed, notifyFeedReopened, successionDeadlines, unconfirmedOutcome, type RemoteAgentTransport } from '@orchardworks/agent-client';
import { buildSuccessionChain } from '@orchardworks/agent-client/testing';
import type { OpenedSession } from '../kernel/directory-client.js';
import { DirectoryError } from '../kernel/directory-client.js';
import { render, unmount } from '../test/setup.js';
import { useSessionSuccession } from './useSessionSuccession.js';

const initial = { hostId: 'local', providerId: 'codex', nativeSessionId: 'A' };
const page = (successions: unknown[] = [], nextCursor: string | null = null) => ({ version: 1, successions, nextCursor });
const networkError = () => Object.assign(new Error('offline'), { code: 'network_error' });
/** The Relay's notice of a Handoff this page has not discovered, as the transport hands it to the page. */
const newHandoff = buildSuccessionChain(['A', 'B'])[0]!;

/** A bound native session whose replica the test moves forward with `synchronize`. */
function fakeLease(agentId: string, nativeSessionId: string) {
  let synchronized = false, recovering = false;
  const listeners = new Set<() => void>();
  const state = () => ({ agent: synchronized ? { id: agentId, providerId: 'codex', runtimeInfo: { providerId: 'codex', sessionId: nativeSessionId } } : undefined,
    timeline: { initialized: synchronized, epoch: synchronized ? 'epoch' : null }, sessionControl: undefined });
  const native = () => ({ synchronized, controlChecking: false, recovering, readOnly: false, runtime: { state: 'connected' }, connection: 'ready', operations: { send_message: { allowed: true } } });
  return {
    release: vi.fn(),
    replica: { getState: state, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); } },
    client: { getSessionState: native, subscribeSessionState: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); } },
    synchronize(recover = false) { synchronized = true; recovering = recover; for (const listener of [...listeners]) listener(); },
  };
}

function ports(overrides: { transport?: Partial<RemoteAgentTransport>; attach?: (...args: unknown[]) => Promise<{ agentId: string }> } = {}) {
  const lease = fakeLease('agent-A', 'A');
  const transport = {
    fetchSessionSuccessions: vi.fn(async (_query: unknown, _request: { signal: AbortSignal }) => page()),
    fetchSessionSuccessionCurrent: vi.fn(), fetchSessionSuccessionOperation: vi.fn(),
    onSessionSuccession: vi.fn((_listener: () => void) => stopFeed), ...overrides.transport,
  } as unknown as RemoteAgentTransport & { fetchSessionSuccessions: ReturnType<typeof vi.fn>; onSessionSuccession: ReturnType<typeof vi.fn> };
  const stopFeed = vi.fn();
  const attach = vi.fn(overrides.attach ?? (async () => ({ agentId: 'agent-A' })));
  const callbacks = { retireNative: vi.fn(), bindNative: vi.fn(), confirmed: vi.fn(), failed: vi.fn() };
  const connections = { find: () => undefined, acquire: vi.fn(() => lease), subscribe: vi.fn(() => () => {}), takeControlAfterNativeResume: vi.fn() };
  return { lease, transport, stopFeed, attach, callbacks, connections };
}

let scopeNumber = 0;
async function mount(built = ports(), extra: Record<string, unknown> = {}) {
  const scope = `succession-effects-${scopeNumber++}`;
  const props = { enabled: true, allowed: true, ...extra } as { enabled: boolean; allowed: boolean; staleRetryDelays?: readonly number[]; initial?: typeof initial | undefined };
  const options = () => ({
    scope, transport: built.transport, enabled: props.enabled, initial: 'initial' in props ? props.initial : initial, staleRetryDelays: props.staleRetryDelays,
    connections: built.connections as never, replicaFor: () => built.lease.replica as never, directory: () => ({ attach: built.attach }) as never,
    textStore: () => ({}) as never, tracking: () => ({ observations: {}, sessions: [], refresh: vi.fn() }) as never,
    ask: () => ({ entries: new Map(), ownerEditRevision: () => 0, applySourceProjection() {} }) as never, layout: () => ({ path: [], selections: {}, collapsed: [] }),
    attachmentAllowed: () => props.allowed, ...built.callbacks,
  });
  let current!: ReturnType<typeof useSessionSuccession>, bump!: () => void;
  function Probe() { const [, set] = useState(0); bump = () => set(count => count + 1); current = useSessionSuccession(options()); return null; }
  const container = await render(<Probe />);
  return { ...built, read: () => current, unmount: () => unmount(container),
    set: async (change: Partial<typeof props>) => { Object.assign(props, change); await act(async () => bump()); } };
}
/** Starts a refresh inside act and hands back its promise unresolved. */
async function started<T>(start: () => Promise<T>): Promise<{ promise: Promise<T> }> { let promise!: Promise<T>; await act(async () => { promise = start(); promise.catch(() => {}); }); return { promise }; }
const settle = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); });

describe('discovery', () => {
  it('reads the replays once on mount and then reports a settled, error-free page', async () => {
    const test = await mount();
    await settle();
    expect(test.transport.fetchSessionSuccessions).toHaveBeenCalledTimes(1);
    expect(test.transport.fetchSessionSuccessions.mock.calls[0]![0]).toEqual({ limit: 64 });
    expect(test.read()).toMatchObject({ discovering: false, error: undefined });
  });
  it('reads nothing while workspace access is off, and again once it is on', async () => {
    const test = await mount(ports(), { enabled: false });
    await settle();
    expect(test.transport.fetchSessionSuccessions).not.toHaveBeenCalled();
    await test.set({ enabled: true }); await settle();
    expect(test.transport.fetchSessionSuccessions).toHaveBeenCalledTimes(1);
  });
  it('follows the cursor until the Relay has no more pages', async () => {
    const built = ports();
    built.transport.fetchSessionSuccessions.mockResolvedValueOnce(page([], 'next')).mockResolvedValueOnce(page());
    await mount(built); await settle();
    expect(built.transport.fetchSessionSuccessions.mock.calls.map(call => call[0])).toEqual([{ limit: 64 }, { limit: 64, cursor: 'next' }]);
  });
  it('treats a Relay that answers route_not_found as unsupported: it asks once, then attaches the fixed locator', async () => {
    const built = ports();
    built.transport.fetchSessionSuccessions.mockRejectedValue(Object.assign(new Error('no route'), { code: 'route_not_found' }));
    const test = await mount(built); await settle();
    expect(built.transport.fetchSessionSuccessions).toHaveBeenCalledTimes(1);
    expect(built.attach).toHaveBeenCalledTimes(1);
    expect(test.read().error).toBeUndefined();
  });
  it('asks nothing of a Relay without succession routes and still settles', async () => {
    const built = ports({ transport: { fetchSessionSuccessions: undefined } });
    const test = await mount(built); await settle();
    expect(built.transport.onSessionSuccession).toHaveBeenCalled();
    expect(test.read().discovering).toBe(false);
    expect(built.attach).toHaveBeenCalledTimes(1);
  });
  it('shows why a read failed and does not keep asking', async () => {
    const built = ports();
    built.transport.fetchSessionSuccessions.mockRejectedValue(new Error('Relay says no'));
    const test = await mount(built); await settle(60_000);
    expect(test.read().error).toBe('Relay says no');
    expect(built.transport.fetchSessionSuccessions).toHaveBeenCalledTimes(1);
  });
  it('does not read through a page whose access is off, even when asked to refresh', async () => {
    const test = await mount(ports(), { enabled: false }); await settle();
    await act(async () => { await test.read().refresh(); });
    expect(test.transport.fetchSessionSuccessions).not.toHaveBeenCalled();
  });
  it('stops the request in flight when the page unmounts', async () => {
    const built = ports(); let signal!: AbortSignal;
    built.transport.fetchSessionSuccessions.mockImplementation((_query, request) => { signal = request.signal; return new Promise(() => {}); });
    const test = await mount(built); await settle();
    expect(signal.aborted).toBe(false);
    await test.unmount();
    expect(signal.aborted).toBe(true);
  });
});

describe('the Relay feed', () => {
  it('reads again when the Relay says a succession happened, and stops listening when unmounted', async () => {
    const test = await mount(); await settle();
    const notify = test.transport.onSessionSuccession.mock.calls[0]![0] as (replay: typeof newHandoff) => void;
    await act(async () => { notify(newHandoff); }); await settle();
    expect(test.transport.fetchSessionSuccessions).toHaveBeenCalledTimes(2);
    await test.unmount();
    await act(async () => { notify(newHandoff); }); await settle();
    expect(test.transport.fetchSessionSuccessions).toHaveBeenCalledTimes(2);
    expect(test.stopFeed).toHaveBeenCalledTimes(1);
  });
  it('keeps the bound session and attaches nothing new while a notified read is still in flight', async () => {
    const test = await mount(); await settle();
    await act(async () => test.lease.synchronize());
    test.transport.fetchSessionSuccessions.mockImplementation(() => new Promise(() => {}));
    await act(async () => { (test.transport.onSessionSuccession.mock.calls[0]![0] as (replay: typeof newHandoff) => void)(newHandoff); }); await settle();
    expect(test.transport.fetchSessionSuccessions).toHaveBeenCalledTimes(2);
    expect(test.read().binding).toBeDefined();
    expect(test.attach).toHaveBeenCalledTimes(1);
  });
  it('reads again when the shared feed reopens, but only once a hidden page is shown', async () => {
    const test = await mount(); await settle();
    await act(async () => notifyFeedReopened()); await settle();
    expect(test.transport.fetchSessionSuccessions).toHaveBeenCalledTimes(2);
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => notifyFeedReopened()); await settle();
    expect(test.transport.fetchSessionSuccessions).toHaveBeenCalledTimes(2);
    hidden.mockReturnValue('visible'); await act(async () => { document.dispatchEvent(new Event('visibilitychange')); }); await settle();
    expect(test.transport.fetchSessionSuccessions).toHaveBeenCalledTimes(3);
    hidden.mockRestore();
  });
});

describe('an unreachable Relay after a confirmed read', () => {
  it('keeps the confirmed evidence, retries on the backoff and stops once the Relay answers', async () => {
    const test = await mount(ports(), { staleRetryDelays: [100, 300] }); await settle();
    const fetch = test.transport.fetchSessionSuccessions;
    fetch.mockRejectedValueOnce(networkError()).mockRejectedValueOnce(networkError());
    await act(async () => notifyFeedReopened()); await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    await settle(99); expect(fetch).toHaveBeenCalledTimes(2);
    await settle(1); expect(fetch).toHaveBeenCalledTimes(3);
    await settle(299); expect(fetch).toHaveBeenCalledTimes(3);
    await settle(1); expect(fetch).toHaveBeenCalledTimes(4);
    await settle(60_000); expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('cancels the waiting retry when the page unmounts', async () => {
    const test = await mount(ports(), { staleRetryDelays: [100] }); await settle();
    test.transport.fetchSessionSuccessions.mockRejectedValueOnce(networkError());
    await act(async () => notifyFeedReopened()); await settle();
    await test.unmount();
    await settle(60_000);
    expect(test.transport.fetchSessionSuccessions).toHaveBeenCalledTimes(2);
  });
  it('does not fall back to old locators when the Relay itself said they changed', async () => {
    const test = await mount(ports(), { staleRetryDelays: [100] }); await settle();
    test.transport.fetchSessionSuccessions.mockRejectedValue(networkError());
    await act(async () => { (test.transport.onSessionSuccession.mock.calls[0]![0] as (replay: typeof newHandoff) => void)(newHandoff); }); await settle(60_000);
    expect(test.read().error).toBe('offline');
    expect(test.transport.fetchSessionSuccessions).toHaveBeenCalledTimes(2);
  });
});

describe('attaching the selected session', () => {
  it('attaches once after discovery, binds the lease and confirms the session when its replica is synchronized', async () => {
    const test = await mount(); await settle();
    expect(test.attach).toHaveBeenCalledTimes(1);
    expect(test.attach.mock.calls[0]!.slice(0, 2)).toEqual(['codex', 'A']);
    expect(test.connections.acquire).toHaveBeenCalledWith('agent-A', test.lease.replica, expect.objectContaining({ nativeSessionId: 'A' }));
    expect(test.callbacks.confirmed).not.toHaveBeenCalled();
    expect(test.read().binding).toBeUndefined();
    await act(async () => test.lease.synchronize());
    expect(test.callbacks.bindNative).toHaveBeenCalledTimes(1);
    expect(test.callbacks.confirmed).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-A', nativeSessionId: 'A' }));
    expect(test.read().binding?.session.nativeSessionId).toBe('A');
    await act(async () => test.lease.synchronize());
    expect(test.callbacks.confirmed).toHaveBeenCalledTimes(1);
    await test.set({}); await settle();
    expect(test.attach).toHaveBeenCalledTimes(1);
  });
  it('waits for the live budget: a view that may not attach attaches when it may', async () => {
    const test = await mount(ports(), { allowed: false }); await settle();
    expect(test.attach).not.toHaveBeenCalled();
    await test.set({ allowed: true }); await settle();
    expect(test.attach).toHaveBeenCalledTimes(1);
  });
  it('lets go of a bound session when the live budget takes it back, and attaches again when it returns', async () => {
    const test = await mount(); await settle();
    await act(async () => test.lease.synchronize());
    expect(test.read().binding).toBeDefined();
    await test.set({ allowed: false }); await settle();
    expect(test.lease.release).toHaveBeenCalledTimes(1);
    expect(test.read().binding).toBeUndefined();
    await test.set({ allowed: true }); await settle();
    expect(test.attach).toHaveBeenCalledTimes(2);
  });
  it('reports a refused attach once, shows it, and does not retry a refusal', async () => {
    const test = await mount(ports({ attach: async () => { throw new DirectoryError('No such session.', 'not_found', 404); } }));
    await settle(120_000);
    expect(test.attach).toHaveBeenCalledTimes(1);
    expect(test.callbacks.failed).toHaveBeenCalledWith(expect.any(DirectoryError), expect.objectContaining({ nativeSessionId: 'A' }));
    expect(test.callbacks.failed.mock.calls[0]).toHaveLength(2);
    expect(test.read().error).toBe('No such session.');
  });
  it('retries an attach that failed on the Host with backoff and reports it as retrying', async () => {
    const attach = vi.fn().mockRejectedValueOnce(new DirectoryError('Host busy.', 'busy', 503)).mockResolvedValue({ agentId: 'agent-A' });
    const test = await mount(ports({ attach }));
    await settle();
    expect(test.callbacks.failed).toHaveBeenCalledWith(expect.any(DirectoryError), expect.anything(), true);
    expect(attach).toHaveBeenCalledTimes(1);
    await settle(5_000); expect(attach).toHaveBeenCalledTimes(2);
    expect(test.connections.acquire).toHaveBeenCalledTimes(1);
  });
  it('stops the attach in flight and releases a bound lease when the page unmounts', async () => {
    let signal!: AbortSignal;
    const pending = await mount(ports({ attach: (_provider, _session, given) => { signal = given as AbortSignal; return new Promise(() => {}); } })); await settle();
    expect(signal.aborted).toBe(false);
    await pending.unmount();
    expect(signal.aborted).toBe(true);
    const bound = await mount(); await settle();
    await bound.unmount();
    expect(bound.lease.release).toHaveBeenCalled();
  });
});

describe('settling a refresh after a Handoff', () => {
  const source = { agentId: 'agent-A', providerId: 'codex', nativeSessionId: 'A', title: 'A', hostId: 'local' } as OpenedSession;
  const native = (nativeSessionId: string) => ({ controllerId: 'c', providerId: 'codex', nativeSessionId });
  const result = (phase: string, from: string, current: string) => ({ record: { phase, from: native(from), operationId: 'op' }, role: { id: 'role', current: native(current) } }) as never;
  it('refuses an outcome that confirms nothing without reading the Relay again', async () => {
    const test = await mount(); await settle();
    const reads = test.transport.fetchSessionSuccessions.mock.calls.length;
    await expect(test.read().refreshSettled(result('prepared', 'A', 'A'), source)).rejects.toThrow(unconfirmedOutcome);
    expect(test.transport.fetchSessionSuccessions).toHaveBeenCalledTimes(reads);
  });
  it('after a cancelled Handoff reads again and settles when the original binds and synchronizes', async () => {
    const test = await mount(); await settle();
    const reads = test.transport.fetchSessionSuccessions.mock.calls.length;
    let outcome: 'pending' | 'settled' = 'pending';
    const settled = (await started(() => test.read().refreshSettled(result('cancelled', 'A', 'A'), source))).promise.then(() => { outcome = 'settled'; });
    await settle();
    expect(test.transport.fetchSessionSuccessions.mock.calls.length).toBe(reads + 1);
    expect(outcome).toBe('pending');
    await act(async () => test.lease.synchronize(true)); await settle();
    expect(outcome).toBe('pending');
    await act(async () => test.lease.synchronize()); await settled;
    expect(outcome).toBe('settled');
  });
  it('gives up when the native session is not confirmed within its deadline', async () => {
    const test = await mount(); await settle();
    const failure = expect((await started(() => test.read().refreshSettled(result('cancelled', 'A', 'A'), source))).promise).rejects.toThrow(nativeNotConfirmed);
    await settle(successionDeadlines.nativeConfirmation - 1);
    await settle(1); await failure;
  });
  it('fails at once when workspace access is lost while waiting', async () => {
    const test = await mount(); await settle();
    const failure = expect((await started(() => test.read().refreshSettled(result('cancelled', 'A', 'A'), source))).promise).rejects.toThrow('Workspace access changed');
    await settle();
    await test.set({ enabled: false }); await failure;
  });
  it('refuses a committed refresh when access is off', async () => {
    const test = await mount(ports(), { enabled: false });
    await expect(test.read().refreshCommitted('op')).rejects.toThrow('Workspace access is required');
  });
});
