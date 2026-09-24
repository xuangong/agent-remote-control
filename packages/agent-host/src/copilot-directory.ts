import {acquireNativeSession, inspectNativeOwner, NativeSessionOwnerError, type NativeSessionLease, type NativeOwnerDiagnostic, type NativeOwnerIdentity} from './native-session-owner.js';
import { randomUUID } from 'node:crypto';
import type { CopilotSessionSummary } from '@orchardworks/agent-provider-copilot';
import type { AgentPersistenceHandle, AgentProviderAdapter, AgentSession } from '@orchardworks/agent-provider-sdk';
import type { AgentHostDirectory, AgentHostWorkspace } from './host.js';

/** Owns native queries independently of the currently paired uplink. */
export function createCopilotSessionDirectory(
  provider: Pick<AgentProviderAdapter, 'createSession' | 'resumeSession'> & {
    listSessions(): Promise<CopilotSessionSummary[]>;
    sessionWorkspace?(id: string): Promise<string | undefined>;
    openChildSession?(parent: string, child: string): Promise<AgentSession>;
    dispose?(): Promise<void>;
    releaseSession?(id: string): Promise<void>;
  },
  workspaces: readonly AgentHostWorkspace[],
  ownership?: {root: string; onDiagnostic?: (event: NativeOwnerDiagnostic) => void},
): AgentHostDirectory {
  const opened = new Map<string, { session: AgentSession; handle: AgentPersistenceHandle; createdAt: string }>();
  const leases = new Map<string, NativeSessionLease>();
  const yielded = new Set<string>();
  let onHandoff: ((id: string, next: NativeOwnerIdentity) => Promise<void>) | undefined;
  const loading = new Map<string, Promise<AgentSession>>();
  async function lease(id: string, takeOver?: string) {
    if (!ownership) return undefined;
    const key = {...ownership, providerId: 'copilot', sessionId: id};
    if (yielded.has(id) && !takeOver && !await inspectNativeOwner(key)) throw new NativeSessionOwnerError('native_session_released', 'Control was transferred to the CLI. Explicitly take control to reopen this session.', {kind: 'native_cli', generation: leases.get(id)!.generation});
    const value = await acquireNativeSession({...key, kind: 'controller', takeOver});
    leases.set(id, value); yielded.delete(id); return value;
  }
  function managed(session: AgentSession, id: string, owner?: NativeSessionLease): AgentSession {
    if (!owner) return session;
    let transferring = false, disposed = false;
    const dispose = async () => {
      if (disposed) return;
      if (transferring) {
        if (!provider.releaseSession) throw new Error('Native release cannot be confirmed.');
        await provider.releaseSession(id);
      }
      await session.dispose(); disposed = true;
      if (!transferring) await owner.release();
    };
    owner.activate(async next => {
      transferring = true; yielded.add(id);
      await onHandoff?.(id, {kind: 'controller', generation: owner.generation});
      await dispose();
      return 'requested';
    }, next => { void onHandoff?.(id, next).catch(error => ownership?.onDiagnostic?.({event: 'native_handoff_notification_failed', providerId: 'copilot', sessionId: id, generation: owner.generation, at: new Date().toISOString(), outcome: String(error)})); });
    return new Proxy(session, {get(target, key) {
      if (key === 'dispose') return dispose;
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (['sendMessage','steer','cancel','respondToInteraction','setPlanning','setSessionSetting','executeCommand','readResource'].includes(String(key))) return (...args: unknown[]) => {
        if (!owner.active) return Promise.reject(new Error('Native control was transferred. Take ownership before interacting.'));
        return Reflect.apply(value, target, args);
      };
      return value.bind(target);
    }});
  }
  let discovery: Promise<CopilotSessionSummary[]> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  async function discover(): Promise<CopilotSessionSummary[]> {
    const summaries = new Map((await provider.listSessions()).map((summary) => [summary.nativeSessionId, summary]));
    for (const [nativeSessionId, entry] of opened) {
      const info = await entry.session.runtimeInfo();
      const previous = summaries.get(nativeSessionId);
      summaries.set(nativeSessionId, { nativeSessionId, providerId: 'copilot', title: previous?.title ?? 'New Copilot session',
        ...(info.cwd ?? previous?.workspace ? { workspace: info.cwd ?? previous?.workspace } : {}),
        createdAt: previous?.createdAt ?? entry.createdAt, updatedAt: previous?.updatedAt ?? entry.createdAt,
        state: info.status === 'running' ? 'running' : info.status === 'waiting' ? 'waiting' : info.status === 'failed' ? 'unavailable' : info.status === 'idle' ? 'idle' : 'unknown' });
    }
    return [...summaries.values()];
  }
  async function remember(session: AgentSession, owner?: NativeSessionLease): Promise<string> {
    try {
      if (closed) throw new Error('Copilot directory is closed.');
      const info = await session.runtimeInfo();
      if (closed) throw new Error('Copilot directory is closed.');
      if (!info.persistence || !info.sessionId) throw new Error('Copilot did not return a native persistence handle.');
      owner ??= await lease(info.sessionId);
      session = managed(session, info.sessionId, owner);
      opened.set(info.sessionId, { session, handle: info.persistence, createdAt: new Date().toISOString() });
      return info.sessionId;
    } catch (error) { await session.dispose(); await owner?.release(); throw error; }
  }
  return {
    providerId: 'copilot',
    list() { if (closed) throw new Error('Copilot directory is closed.'); return discovery ??= discover().finally(() => { discovery = undefined; }); },
    workspaces: () => [...workspaces],
    ...(provider.sessionWorkspace ? {sessionWorkspace: provider.sessionWorkspace.bind(provider)} : {}),
    async create(input) {
      if (closed) throw new Error('Copilot directory is closed.');
      const selected = input.workspaceId === undefined ? undefined : workspaces.find(({ id }) => id === input.workspaceId);
      if (input.workspaceId !== undefined && !selected) throw new Error('Unknown Copilot workspace.');
      const cwd = input.cwd ?? selected?.path ?? workspaces[0]?.path;
      return remember(await provider.createSession({ ...input, sessionId: randomUUID(), ...(cwd ? { cwd } : {}) }));
    },
    setSessionHandoffHandler(handler) { onHandoff = handler; },
    async open(nativeSessionId, options) {
      if (closed) throw new Error('Copilot directory is closed.');
      const pending = loading.get(nativeSessionId);
      if (pending) return pending;
      const opening = (async () => {
        const existing = opened.get(nativeSessionId);
        if (existing && !yielded.has(nativeSessionId) && (await existing.session.runtimeInfo()).status !== 'closed') return existing.session;
        const owner = await lease(nativeSessionId, options?.takeOver);
        try {
          const session = await provider.resumeSession(existing?.handle ?? { providerId: 'copilot', sessionId: nativeSessionId, opaque: '{}' });
          await remember(session, owner);
          return opened.get(nativeSessionId)!.session;
        } catch (error) { await owner?.release(); throw error; }
      })();
      loading.set(nativeSessionId, opening);
      try { return await opening; } finally { loading.delete(nativeSessionId); }
    },
    close() {
      if (closing) return closing;
      closed = true;
      return closing = (async () => {
        await discovery?.catch(() => undefined);
        await Promise.allSettled([...opened.values()].map(({ session }) => session.dispose()));
        await Promise.allSettled([...leases.values()].map(value => value.release()));
        leases.clear(); opened.clear();
        await provider.dispose?.();
      })();
    },
    ...(provider.openChildSession ? { async openChild(parentNativeSessionId: string, nativeSessionId: string) {
      if (closed) throw new Error('Copilot directory is closed.');
      return provider.openChildSession!(parentNativeSessionId, nativeSessionId);
    } } : {}),
  };
}
