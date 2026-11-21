import { describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@orchardworks/agent-provider-sdk';

import { createAdmission } from './admission.js';
import { createAttachment } from './attachment.js';
import { createAttachmentLedger } from './attachment-ledger.js';
import { createBoundSessions } from './bound-sessions.js';
import type { SessionCoreContext } from './context.js';

interface LiveStub { id: string; canReleaseIdle(): boolean }
type Release = () => Promise<void>;
type Reconcile = (isCurrent: () => boolean) => Promise<boolean>;

/** A session core context whose ports record what the attachment does to them, in order. */
function attachmentHarness(options: { sink?: (diagnostic: { event: string; agentId: string; providerId: string }) => void } = {}) {
  const log: string[] = [];
  const live = new Map<string, LiveStub>();
  const admission = createAdmission();
  const sessions = createBoundSessions<LiveStub>(agentId => live.get(agentId));
  const ledger = createAttachmentLedger();
  const retained = new Map<string, number>();
  const released = new Map<string, number>();
  const watched = new Map<string, { release: Release; reconcile?: Reconcile }>();
  const nativeSession = () => ({ dispose: vi.fn(async () => { log.push('session.dispose'); }) }) as unknown as AgentSession & { dispose: ReturnType<typeof vi.fn> };
  const hooks = {
    open: async (_id: string): Promise<AgentSession> => nativeSession(),
    createdSessionId: (agentId: string, nativeSessionId: string) => ({ sessionId: nativeSessionId, agentId }),
  };
  const directory = {
    providerId: 'claude',
    open: (id: string) => hooks.open(id),
    openChild: (_parent: string, id: string) => hooks.open(id),
    sessionReleased: vi.fn(async (id: string) => { log.push(`directory.sessionReleased:${id}`); }),
    reconcileIdleSession: vi.fn(async () => true),
    canReleaseSession: vi.fn(() => true),
  };
  const relay = {
    createAgent: vi.fn(async (message: { payload: { agentId: string } }) => {
      const agentId = message.payload.agentId;
      live.set(agentId, { id: agentId, canReleaseIdle: () => true });
      return { payload: { sessionId: hooks.createdSessionId(agentId, nativeIdOf.get(agentId) ?? '').sessionId } };
    }),
    closeAgent: vi.fn(async (agentId: string) => { log.push(`relay.closeAgent:${agentId}`); live.delete(agentId); }),
    requireAgent: (agentId: string) => live.get(agentId)!,
  };
  const nativeIdOf = new Map<string, string>();
  const ctx = {
    options: { onSessionLifecycleDiagnostic: options.sink },
    admission, sessions, ledger, relay,
    idle: {
      retain: (id: string) => {
        log.push(`idle.retain:${id}`);
        retained.set(id, (retained.get(id) ?? 0) + 1);
        return () => { released.set(id, (released.get(id) ?? 0) + 1); };
      },
      hasDemand: () => false,
      touch: (id: string) => { log.push(`idle.touch:${id}`); },
      wait: async (id: string) => { log.push(`idle.wait:${id}`); },
      watch: (id: string, _safe: () => boolean, release: Release, reconcile?: Reconcile) => { watched.set(id, { release, reconcile }); },
    },
    providers: { require: () => ({ directory }) },
    terminalRefresh: { releaseJournal: vi.fn(async (binding: { agentId: string }) => { log.push(`journal.release:${binding.agentId}`); }) },
    journals: { attach: vi.fn(() => true) },
    roles: { extensions: async () => undefined },
    successionReady: Promise.resolve(),
    originalCreation: () => undefined,
    originalNativePrefix: () => undefined,
    nativeRef: (binding: { providerId: string; nativeSessionId: string }) => binding,
    genericSuccessionSource: () => undefined,
    workerExtensions: () => undefined,
    liveAgent: (agentId: string) => live.get(agentId),
    tracked: <T,>(operation: Promise<T>) => operation,
  } as unknown as SessionCoreContext;
  const attachment = createAttachment(ctx);
  const project = (agentId: string, nativeSessionId: string, parentNativeSessionId?: string, qualifiedResult = false) => {
    nativeIdOf.set(agentId, nativeSessionId);
    return attachment.project('claude', agentId, nativeSessionId, parentNativeSessionId, undefined, false, 'host:takeover', qualifiedResult);
  };
  return { attachment, project, admission, sessions, relay, directory, hooks, log, live, retained, released, watched, ctx, nativeSession };
}

describe('acquiring a session', () => {
  it('holds the parent of a child first and releases the runtime and its parent exactly once', async () => {
    const h = attachmentHarness();
    await h.project('parent', 'native-parent');
    await h.project('child', 'native-child', 'native-parent');
    h.log.length = 0; h.released.clear();
    const lease = await h.attachment.acquireSession('child');
    expect(lease?.agent).toBe(h.live.get('child'));
    // The parent is held before the child waits for a release in progress.
    expect(h.log.indexOf('idle.retain:parent')).toBeGreaterThanOrEqual(0);
    expect(h.log.indexOf('idle.retain:parent')).toBeLessThan(h.log.indexOf('idle.wait:child'));
    expect(h.released.get('child') ?? 0).toBe(0);
    expect(h.released.get('parent') ?? 0).toBe(0);
    lease!.release();
    lease!.release();
    expect(h.released.get('child')).toBe(1);
    expect(h.released.get('parent')).toBe(1);
  });

  it('releases what it held when the runtime is gone, and hands out nothing', async () => {
    const h = attachmentHarness();
    await h.project('parent', 'native-parent');
    await h.project('child', 'native-child', 'native-parent');
    h.released.clear(); h.admission.close();
    expect(await h.attachment.acquireSession('child')).toBeUndefined();
    expect(h.released.get('child') ?? 0).toBe(0);
  });

  it('releases the runtime and the parent when the attach after waiting fails', async () => {
    const h = attachmentHarness();
    await h.project('parent', 'native-parent');
    await h.project('child', 'native-child', 'native-parent');
    h.live.delete('child'); h.released.clear(); h.retained.clear();
    h.hooks.open = async () => { throw new Error('native open failed'); };
    await expect(h.attachment.acquireSession('child')).rejects.toThrow('native open failed');
    // Every hold taken for the failed acquisition is given back, the parent's included (the attach holds it once more for its own open).
    expect(h.retained.get('child')).toBe(1);
    expect(h.released.get('child')).toBe(1);
    expect(h.retained.get('parent')).toBeGreaterThan(0);
    expect(h.released.get('parent')).toBe(h.retained.get('parent'));
  });
});

describe('an identity chosen after a qualified source create', () => {
  const run = async (agentId: string, nativeSessionId: string) => {
    const h = attachmentHarness();
    return h.project(agentId, nativeSessionId, undefined, true);
  };

  it.each([511, 512])('accepts %i characters', async length => {
    const id = 'a'.repeat(length);
    await expect(run(id, 'native-1')).resolves.toMatchObject({ agentId: id });
    await expect(run('agent-1', id)).resolves.toMatchObject({ nativeSessionId: id });
  });

  it.each([['513 characters', 'a'.repeat(513)], ['blank', '   '], ['empty', '']])('fails the attach for %s', async (_name, id) => {
    await expect(run(id, 'native-1')).rejects.toThrow(/unbounded canonical identity/);
    await expect(run('agent-1', id)).rejects.toThrow(/unbounded canonical identity/);
  });

  it('does not apply the bound when the source is not qualified', async () => {
    const h = attachmentHarness();
    await expect(h.project('a'.repeat(600), 'native-1')).resolves.toMatchObject({ nativeSessionId: 'native-1' });
  });
});

describe('attaching a native session', () => {
  it('closes and refuses a provider that returns another native identity', async () => {
    const h = attachmentHarness();
    h.hooks.createdSessionId = () => ({ sessionId: 'someone-elses-session' });
    await expect(h.project('agent-1', 'native-1')).rejects.toThrow('Provider returned a different native session identity.');
    expect(h.relay.closeAgent).toHaveBeenCalledWith('agent-1');
    expect(h.ctx.journals.attach).not.toHaveBeenCalled();
    expect(h.sessions.byAgent('agent-1')).toBeUndefined();
  });

  it('disposes what it opened and answers 503 host_closed when the Controller closed meanwhile', async () => {
    const h = attachmentHarness();
    const opened = h.nativeSession();
    h.hooks.open = async () => { h.admission.close(); return opened; };
    await expect(h.project('agent-1', 'native-1')).rejects.toMatchObject({ status: 503, code: 'host_closed' });
    expect(opened.dispose).toHaveBeenCalledTimes(1);
    expect(h.relay.createAgent).not.toHaveBeenCalled();
    expect(h.sessions.byAgent('agent-1')).toBeUndefined();
  });
});

describe('releasing an idle session', () => {
  const idleRelease = async (sink?: (diagnostic: { event: string; agentId: string; providerId: string }) => void) => {
    const h = attachmentHarness({ sink });
    await h.project('agent-1', 'native-1');
    h.log.length = 0;
    return { h, entry: h.watched.get('agent-1')! };
  };

  it('closes the journal, then the runtime, then the directory, and reports the release last', async () => {
    const events: string[] = [];
    const { h, entry } = await idleRelease(diagnostic => { events.push(`diagnostic:${diagnostic.event}`); });
    await entry.release();
    expect(h.log).toEqual(['journal.release:agent-1', 'relay.closeAgent:agent-1', 'directory.sessionReleased:native-1']);
    expect(events).toEqual(['diagnostic:session_idle_released']);
  });

  it('is not changed by a lifecycle diagnostic sink that throws', async () => {
    const sink = vi.fn(() => { throw new Error('sink down'); });
    const { h, entry } = await idleRelease(sink);
    await expect(entry.release()).resolves.toBeUndefined();
    expect(h.log).toEqual(['journal.release:agent-1', 'relay.closeAgent:agent-1', 'directory.sessionReleased:native-1']);
    expect(sink).toHaveBeenCalledWith({ event: 'session_idle_released', agentId: 'agent-1', providerId: 'claude' });
  });

  it('releases a diverged session in the same order before a send continues from it, then reads it again', async () => {
    const h = attachmentHarness();
    await h.project('agent-1', 'native-1');
    const first = h.live.get('agent-1');
    Object.assign(h.directory, { checkDivergence: vi.fn(async () => true) });
    h.log.length = 0;
    const lease = await h.attachment.acquireSession('agent-1');
    const released = h.log.filter(entry => /^(journal|relay|directory)\./.test(entry));
    expect(released).toEqual(['journal.release:agent-1', 'relay.closeAgent:agent-1', 'directory.sessionReleased:native-1']);
    expect(lease?.agent).toBe(h.live.get('agent-1'));
    expect(lease?.agent).not.toBe(first);
    lease!.release();
  });

  it('confirms a reconciliation although the sink throws', async () => {
    const sink = vi.fn(() => { throw new Error('sink down'); });
    const { entry } = await idleRelease(sink);
    await expect(entry.reconcile!(() => true)).resolves.toBe(true);
    expect(sink).toHaveBeenCalledWith({ event: 'session_idle_reconciled', agentId: 'agent-1', providerId: 'claude' });
  });
});
