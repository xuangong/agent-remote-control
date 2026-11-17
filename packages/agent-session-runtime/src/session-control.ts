import { randomUUID } from 'node:crypto';
import type { NativeSessionOwner, SessionControlState } from '@orchardworks/agent-remote-protocol';

type Listener = (state: SessionControlState) => void;
interface Connection {
  revision: string;
  token?: string;
  notify: () => void;
}
interface Session {
  nativeOwner?: NativeSessionOwner;
  connections: Set<Connection>;
}

export interface SessionControlLease {
  state(): SessionControlState;
  /** Grants are connection-local and not exclusive. */
  request(revision: string): SessionControlState;
  assert(token: string | undefined): void;
  close(): void;
}

export class SessionControlError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function denied(code: string, message: string): Error { return new SessionControlError(code, message); }

/** Authorized clients share a Host-owned session; native ownership changes revoke every grant. */
export class SessionControlRegistry {
  private readonly sessions = new Map<string, Session>();
  private closed = false;

  setNativeOwner(agentId: string, nativeOwner: NativeSessionOwner | undefined): void {
    if (this.closed) return;
    let session = this.sessions.get(agentId);
    if (!session) {
      if (!nativeOwner) return;
      session = {connections: new Set()}; this.sessions.set(agentId, session);
    }
    if (session.nativeOwner?.kind === nativeOwner?.kind && session.nativeOwner?.generation === nativeOwner?.generation) return;
    session.nativeOwner = nativeOwner && {...nativeOwner};
    // Revoke all grants before notifying consumers that may synchronously submit another operation.
    for (const connection of session.connections) {
      connection.token = undefined;
      connection.revision = randomUUID();
    }
    for (const connection of session.connections) connection.notify();
    if (!session.nativeOwner && !session.connections.size) this.sessions.delete(agentId);
  }

  /** The terminal or Controller that holds the session natively, if any. */
  nativeOwnerOf(agentId: string): NativeSessionOwner | undefined {
    const owner = this.sessions.get(agentId)?.nativeOwner;
    return owner && { ...owner };
  }

  attach(agentId: string, listener: Listener): SessionControlLease {
    if (this.closed) throw denied('session_read_only', 'Session access is closed. Reconnect before operating this session.');
    let session = this.sessions.get(agentId);
    if (!session) { session = {connections: new Set()}; this.sessions.set(agentId, session); }
    const current = session;
    let closed = false;
    const connection: Connection = {revision: randomUUID(), notify: () => listener(state())};
    const available = () => !closed && !this.closed && !current.nativeOwner;
    const state = (): SessionControlState => ({
      agentId, revision: connection.revision, available: available(),
      access: available() && connection.token ? 'control' : 'read_only',
      ...(current.nativeOwner ? {nativeOwner: {...current.nativeOwner}} : {}),
      ...(available() && connection.token ? {token: connection.token} : {}),
    });
    current.connections.add(connection);
    return {
      state,
      request: revision => {
        if (closed || this.closed) throw denied('session_read_only', 'This connection is closed. Reconnect before operating this session.');
        if (current.nativeOwner) throw denied('native_session_owned', 'The native client owns this session. Explicitly interrupt it before taking control.');
        if (revision !== connection.revision) throw denied('session_control_changed', 'Session access changed. Review its current state and retry.');
        connection.token ??= randomUUID();
        return state();
      },
      assert: token => {
        if (!available() || !connection.token || token !== connection.token) {
          throw denied('session_read_only', 'This connection is read-only. Reconnect before operating this session.');
        }
      },
      close: () => {
        if (closed) return;
        closed = true;
        connection.token = undefined;
        current.connections.delete(connection);
        if (!current.nativeOwner && !current.connections.size) this.sessions.delete(agentId);
      },
    };
  }

  close(): void {
    this.closed = true;
    for (const session of this.sessions.values()) {
      for (const connection of session.connections) connection.token = undefined;
      session.connections.clear();
    }
    this.sessions.clear();
  }
}
