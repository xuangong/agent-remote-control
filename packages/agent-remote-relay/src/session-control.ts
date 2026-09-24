import { randomUUID } from 'node:crypto';
import type { NativeSessionOwner, SessionControlClientKind, SessionControlState } from '@orchardworks/agent-remote-protocol';

type Listener = (state: SessionControlState) => void;
interface Session {
  revision: string;
  nativeOwner?: NativeSessionOwner;
  owner?: { connections: Set<symbol>; token: string; kind: SessionControlClientKind };
  listeners: Map<symbol, Listener>;
  expiry?: ReturnType<typeof setTimeout>;
}

export interface SessionControlLease {
  state(): SessionControlState;
  request(action: 'acquire' | 'take_over', revision: string, resumeToken?: string, retainOnDisconnect?: boolean, clientKind?: SessionControlClientKind): SessionControlState;
  assert(token: string | undefined): void;
  close(): void;
}

export class SessionControlError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function denied(code: string, message: string): Error { return new SessionControlError(code, message); }

/** Interaction ownership never changes the lifetime of a native session. */
export class SessionControlRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly sharedLeases = new Set<SessionControlLease>();
  private readonly graceMs: number;

  constructor(options: { graceMs?: number } = {}) { this.graceMs = options.graceMs ?? 30_000; }

  setNativeOwner(agentId: string, nativeOwner: NativeSessionOwner | undefined): void {
    let session = this.sessions.get(agentId);
    if (!session) { if (!nativeOwner) return; session = {revision: randomUUID(), listeners: new Map()}; this.sessions.set(agentId, session); }
    if (!nativeOwner && !session.nativeOwner) return;
    clearTimeout(session.expiry); session.expiry = undefined;
    session.owner = undefined; session.nativeOwner = nativeOwner; session.revision = randomUUID();
    for (const notify of session.listeners.values()) notify({agentId, revision: session.revision, access: 'read_only', available: !nativeOwner, ...(nativeOwner ? {nativeOwner} : {})});
  }

  /** Shared sessions authorize each connection without allocating a mutually exclusive owner. */
  attachShared(agentId: string): SessionControlLease {
    const revision = randomUUID();
    let token: string | undefined;
    let closed = false;
    const state = (): SessionControlState => ({agentId, revision, available: !closed,
      access: token && !closed ? 'control' : 'read_only', ...(token && !closed ? {token} : {})});
    const lease: SessionControlLease = {
      state,
      request: (_action, expectedRevision) => {
        if (closed) throw denied('session_read_only', 'This connection is closed. Reconnect before operating this session.');
        if (expectedRevision !== revision) throw denied('session_control_changed', 'Session control changed. Review its current state and retry.');
        token ??= randomUUID();
        return state();
      },
      assert: proof => {
        if (closed || !token || proof !== token) throw denied('session_read_only', 'This connection is read-only. Reconnect before operating this session.');
      },
      close: () => { closed = true; token = undefined; this.sharedLeases.delete(lease); },
    };
    this.sharedLeases.add(lease);
    return lease;
  }

  attach(agentId: string, listener: Listener): SessionControlLease {
    let session = this.sessions.get(agentId);
    if (!session) {
      session = { revision: randomUUID(), listeners: new Map() };
      this.sessions.set(agentId, session);
    }
    const current = session;
    const connection = Symbol();
    let closed = false;
    let retainOnDisconnect = true;
    const state = (): SessionControlState => ({ agentId, revision: current.revision,
      access: current.owner?.connections.has(connection) ? 'control' : 'read_only',
      available: !current.owner && !current.nativeOwner,
      ...(current.owner ? { ownerKind: current.owner.kind } : {}),
      ...(current.nativeOwner ? { nativeOwner: current.nativeOwner } : {}),
      ...(current.owner?.connections.has(connection) ? { token: current.owner.token } : {}),
    });
    current.listeners.set(connection, listener);
    const broadcast = () => {
      for (const [id, notify] of current.listeners) {
        notify({ agentId, revision: current.revision, available: !current.owner && !current.nativeOwner,
          ...(current.owner ? { ownerKind: current.owner.kind } : {}),
      ...(current.nativeOwner ? { nativeOwner: current.nativeOwner } : {}),
          access: current.owner?.connections.has(id) ? 'control' : 'read_only',
          ...(current.owner?.connections.has(id) ? { token: current.owner.token } : {}),
        });
      }
    };
    return {
      state,
      request: (action, revision, resumeToken, retain = true, clientKind = 'unknown') => {
        if (closed) throw denied('session_read_only', 'This connection is read-only. Reconnect before taking control.');
        if (current.nativeOwner) throw denied('native_session_owned', 'The native client owns this session. Explicitly interrupt it before taking control.');
        if (revision !== current.revision) throw denied('session_control_changed', 'Session control changed. Review its current state and retry.');
        if (action === 'acquire' && (resumeToken ? current.owner?.token !== resumeToken : !!current.owner)) return state();
        retainOnDisconnect = retain;
        clearTimeout(current.expiry);
        current.expiry = undefined;
        if (action === 'acquire' && resumeToken && current.owner?.token === resumeToken) {
          current.owner.connections.add(connection);
        } else {
          current.owner = { connections: new Set([connection]), token: randomUUID(), kind: clientKind };
          current.revision = randomUUID();
        }
        broadcast();
        return state();
      },
      assert: token => {
        if (closed || !current.owner?.connections.has(connection) || !token || current.owner.token !== token) {
          throw denied('session_read_only', 'This page is read-only. Take control before operating this session.');
        }
      },
      close: () => {
        if (closed) return;
        closed = true;
        current.listeners.delete(connection);
        if (current.owner?.connections.has(connection)) {
          current.owner.connections.delete(connection);
          if (current.owner.connections.size > 0) return;
          const expire = () => {
            current.owner = undefined;
            current.expiry = undefined;
            current.revision = randomUUID();
            broadcast();
            if (!current.listeners.size) this.sessions.delete(agentId);
          };
          if (!retainOnDisconnect) expire();
          else { current.expiry = setTimeout(expire, this.graceMs); current.expiry.unref?.(); }
        }
        if (!current.owner && !current.nativeOwner && !current.listeners.size) this.sessions.delete(agentId);
      },
    };
  }

  close(): void {
    for (const lease of this.sharedLeases) lease.close();
    for (const session of this.sessions.values()) {
      clearTimeout(session.expiry);
      session.owner = undefined;
      session.listeners.clear();
    }
    this.sessions.clear();
  }
}
