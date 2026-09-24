import {acquireNativeSession, inspectNativeOwner, NativeSessionOwnerError, type NativeSessionLease, type NativeOwnerDiagnostic, type NativeOwnerIdentity} from './native-session-owner.js';
import { randomUUID } from 'node:crypto';
import type {RemoteSessionSummary} from '@orchardworks/agent-remote-relay';
import type { AgentPersistenceHandle, AgentProviderAdapter, AgentSession } from '@orchardworks/agent-provider-sdk';
import type { AgentHostDirectory, AgentHostWorkspace } from './host.js';

export type ManagedStdioProvider = Pick<AgentProviderAdapter, 'createSession' | 'resumeSession'> & {
    listSessions(): Promise<RemoteSessionSummary[]>;
    sessionWorkspace?(id: string): Promise<string | undefined>;
    openChildSession?(parent: string, child: string): Promise<AgentSession>;
    dispose?(): Promise<void>;
    releaseSession?(id: string): Promise<void>;
    /** Only clean up a failed open owned by this provider; never close an external writer. */
    cleanupFailedSession?(id: string): Promise<void>;
  };

/** Owns stdio sessions and their managed native leases independently of the paired uplink. */
export function createManagedStdioDirectory(
  providerId: string,
  displayName: string,
  provider: ManagedStdioProvider,
  workspaces: readonly AgentHostWorkspace[],
  ownership?: {root: string; onDiagnostic?: (event: NativeOwnerDiagnostic) => void},
): AgentHostDirectory {
  const opened = new Map<string, { session: AgentSession; handle: AgentPersistenceHandle; createdAt: string; owner?: NativeSessionLease }>();
  const leases = new Map<string, NativeSessionLease>();
  const yielded = new Set<string>();
  const unconfirmedStarts = new Set<string>();
  let onHandoff: ((id: string, next: NativeOwnerIdentity) => Promise<void>) | undefined;
  const loading = new Map<string, Promise<AgentSession>>();
  async function lease(id: string, takeOver?: string) {
    if (!ownership) return undefined;
    const key = {...ownership, providerId, sessionId: id};
    if (yielded.has(id) && !takeOver && !await inspectNativeOwner(key)) throw new NativeSessionOwnerError('native_session_released', 'Control was transferred to the CLI. Explicitly take control to reopen this session.', {kind: 'native_cli', generation: leases.get(id)!.generation});
    const value = await acquireNativeSession({...key, kind: 'controller', takeOver});
    leases.set(id, value); yielded.delete(id); return value;
  }
  async function releaseFailedStart(id: string): Promise<void> {
    if (!unconfirmedStarts.has(id)) return;
    await provider.cleanupFailedSession?.(id);
    await leases.get(id)?.release();
    unconfirmedStarts.delete(id);
  }
  function managed(session: AgentSession, id: string, owner?: NativeSessionLease): AgentSession {
    if (!owner) return session;
    let transferring = false, shutdownRequested = false, nativeReleased = false;
    let shutdown: Promise<void> | undefined;
    const releaseNative = async () => {
      if (nativeReleased) return;
      if (!provider.releaseSession) throw new Error('Native release cannot be confirmed.');
      await provider.releaseSession(id);
      nativeReleased = true;
    };
    const dispose = async () => {
      shutdownRequested = true;
      shutdown ??= (async () => {
        const info = await session.runtimeInfo();
        const entry = opened.get(id);
        if (entry && info.persistence) entry.handle = info.persistence;
        if (transferring) await releaseNative();
        await session.dispose();
      })().catch(error => { shutdown = undefined; throw error; });
      await shutdown;
      if (!transferring) await owner.release();
    };
    owner.activate(async next => {
      transferring = true; yielded.add(id);
      await onHandoff?.(id, {kind: 'controller', generation: owner.generation});
      await dispose();
      // A directory shutdown may have started before this transfer request.
      await releaseNative();
      return 'requested';
    }, next => { void onHandoff?.(id, next).catch(error => ownership?.onDiagnostic?.({event: 'native_handoff_notification_failed', providerId, sessionId: id, generation: owner.generation, at: new Date().toISOString(), outcome: String(error)})); });
    return new Proxy(session, {get(target, key) {
      if (key === 'dispose') return dispose;
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (['sendMessage','steer','cancel','respondToInteraction','setPlanning','setSessionSetting','executeCommand','readResource'].includes(String(key))) return (...args: unknown[]) => {
        if (shutdownRequested || !owner.active) return Promise.reject(new Error('Native control was transferred. Take ownership before interacting.'));
        return Reflect.apply(value, target, args);
      };
      return value.bind(target);
    }});
  }
  let discovery: Promise<RemoteSessionSummary[]> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  async function discover(): Promise<RemoteSessionSummary[]> {
    const summaries = new Map((await provider.listSessions()).map((summary) => [summary.nativeSessionId, summary]));
    for (const [nativeSessionId, entry] of opened) {
      const info = await entry.session.runtimeInfo();
      const previous = summaries.get(nativeSessionId);
      summaries.set(nativeSessionId, { nativeSessionId, providerId, title: previous?.title ?? `New ${displayName} session`,
        ...(info.cwd ?? previous?.workspace ? { workspace: info.cwd ?? previous?.workspace } : {}),
        createdAt: previous?.createdAt ?? entry.createdAt, updatedAt: previous?.updatedAt ?? entry.createdAt,
        state: info.status === 'running' ? 'running' : info.status === 'waiting' ? 'waiting' : info.status === 'failed' ? 'unavailable' : info.status === 'idle' ? 'idle' : 'unknown' });
    }
    return [...summaries.values()];
  }
  async function remember(session: AgentSession, owner?: NativeSessionLease): Promise<string> {
    try {
      if (closed) throw new Error(`${displayName} directory is closed.`);
      const info = await session.runtimeInfo();
      if (closed) throw new Error(`${displayName} directory is closed.`);
      if (!info.persistence || !info.sessionId) throw new Error(`${displayName} did not return a native persistence handle.`);
      owner ??= await lease(info.sessionId);
      if (closed) throw new Error(`${displayName} directory is closed.`);
      session = managed(session, info.sessionId, owner);
      opened.set(info.sessionId, { session, handle: info.persistence, createdAt: new Date().toISOString(), owner });
      return info.sessionId;
    } catch (error) { await session.dispose(); await owner?.release(); throw error; }
  }
  return {
    providerId,
    list() { if (closed) throw new Error(`${displayName} directory is closed.`); return discovery ??= discover().finally(() => { discovery = undefined; }); },
    workspaces: () => [...workspaces],
    ...(provider.sessionWorkspace ? {sessionWorkspace: provider.sessionWorkspace.bind(provider)} : {}),
    async create(input) {
      if (closed) throw new Error(`${displayName} directory is closed.`);
      const selected = input.workspaceId === undefined ? undefined : workspaces.find(({ id }) => id === input.workspaceId);
      if (input.workspaceId !== undefined && !selected) throw new Error(`Unknown ${displayName} workspace.`);
      const cwd = input.cwd ?? selected?.path ?? workspaces[0]?.path;
      return remember(await provider.createSession({ ...input, sessionId: randomUUID(), ...(cwd ? { cwd } : {}) }));
    },
    setSessionHandoffHandler(handler) { onHandoff = handler; },
    async open(nativeSessionId, options) {
      if (closed) throw new Error(`${displayName} directory is closed.`);
      const pending = loading.get(nativeSessionId);
      if (pending) return pending;
      const opening = (async () => {
        await releaseFailedStart(nativeSessionId);
        const existing = opened.get(nativeSessionId);
        if (existing && !yielded.has(nativeSessionId) && (await existing.session.runtimeInfo()).status !== 'closed') return existing.session;
        if (existing && yielded.has(nativeSessionId)) {
          await existing.session.dispose();
          // Outside the handoff callback, so release can wait for a failed/in-flight transfer.
          await leases.get(nativeSessionId)?.release();
        }
        const owner = await lease(nativeSessionId, options?.takeOver);
        let session: AgentSession;
        try {
          session = await provider.resumeSession(existing?.handle ?? { providerId, sessionId: nativeSessionId, opaque: '{}' });
        } catch (error) {
          if (owner) {
            unconfirmedStarts.add(nativeSessionId);
            await releaseFailedStart(nativeSessionId);
          }
          throw error;
        }
        await remember(session, owner);
        return opened.get(nativeSessionId)!.session;
      })();
      loading.set(nativeSessionId, opening);
      try { return await opening; } finally { loading.delete(nativeSessionId); }
    },
    close() {
      if (closing) return closing;
      closed = true;
      return closing = (async () => {
        await discovery?.catch(() => undefined);
        const entries = [...opened.entries()];
        const results = await Promise.allSettled(entries.map(([, {session}]) => session.dispose()));
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        for (const id of [...unconfirmedStarts]) {
          try { await releaseFailedStart(id); } catch (error) { errors.push(error); }
        }
        try { await provider.dispose?.(); } catch (error) { errors.push(error); }
        // An unconfirmed native shutdown must keep its lease, even after directory shutdown.
        if (errors.length) throw new AggregateError(errors, `${displayName} shutdown could not be confirmed.`);
        // In-flight opens still own their leases until their own cleanup confirms exit.
        await Promise.all(entries.map(([, entry]) => entry.owner?.release()));
        for (const [id, entry] of entries) {
          if (leases.get(id) === entry.owner) leases.delete(id);
          if (opened.get(id) === entry) opened.delete(id);
        }
      })();
    },
    ...(provider.openChildSession ? { async openChild(parentNativeSessionId: string, nativeSessionId: string) {
      if (closed) throw new Error(`${displayName} directory is closed.`);
      return provider.openChildSession!(parentNativeSessionId, nativeSessionId);
    } } : {}),
  };
}
