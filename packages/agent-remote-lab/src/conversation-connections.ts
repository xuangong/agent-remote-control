import { createContext } from 'react';
import { RemoteSessionClient, type AgentReplica, type RemoteAgentTransport, type SessionControlExtension } from '@orchardworks/agent-remote-web';
import { recoverMessages } from './message-recovery.js';
import { sessionKey, type SessionEntry } from './session-tree.js';
import { observeWorkspaceDisplay } from './workspace-display-cache.js';

type Identity = Pick<SessionEntry, 'hostId' | 'providerId' | 'nativeSessionId'>;
interface Connection {
  agentId: string;
  key?: string;
  client: RemoteSessionClient;
  replica: AgentReplica;
  viewers: number;
  stopRecovery(): void;
  stopDisplay(): void;
}

/** Keeps already opened conversations live while a view or retention owner needs them. */
export class ConversationConnections {
  private readonly connections = new Map<string, Connection>();
  private readonly listeners = new Set<() => void>();
  private readonly retained = new Map<string, Set<string>>();

  constructor(private readonly transport: RemoteAgentTransport, private readonly recoveryScope?: string, private readonly controlExtension?: (agentId: string, session?: Identity) => SessionControlExtension | undefined) {}

  get agentIds(): string[] { return [...this.connections.keys()]; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  find(session: Identity): Connection | undefined {
    const key = sessionKey(session);
    return [...this.connections.values()].find(connection => connection.key === key);
  }

  retainSessions(owner: string, sessions: readonly Identity[]): void {
    if (sessions.length) this.retained.set(owner, new Set(sessions.map(sessionKey)));
    else this.retained.delete(owner);
    for (const connection of this.connections.values()) this.collect(connection);
  }

  acquire(agentId: string, replica: AgentReplica, session?: Identity): { client: RemoteSessionClient; replica: AgentReplica; release(): void } {
    let connection = this.connections.get(agentId);
    const previous = connection;
    const previousKey = connection?.key;
    if (!connection) {
      const key = session ? sessionKey(session) : undefined;
      connection = { agentId, key, replica, viewers: 0,
        client: new RemoteSessionClient(agentId, this.transport, replica, { historyPageSize: 100, requireSessionControl: true, clientKind: 'web', handoffTarget: key, controlExtension: this.controlExtension?.(agentId, session) }),
        stopRecovery: this.recoveryScope ? recoverMessages(replica, this.recoveryScope, key ?? agentId, agentId) : () => {},
        stopDisplay: this.recoveryScope && session ? observeWorkspaceDisplay(this.recoveryScope, session, replica) : () => {},
      };
      this.connections.set(agentId, connection);
      try { connection.client.start(); }
      catch (error) { this.close(connection); throw error; }
    }
    if (session && connection.key !== sessionKey(session)) {
      connection.stopDisplay();
      connection.key = sessionKey(session);
      connection.stopDisplay = this.recoveryScope ? observeWorkspaceDisplay(this.recoveryScope, session, connection.replica) : () => {};
    }
    connection.viewers += 1;
    if (!previous || previousKey !== connection.key) this.notify();
    const acquired = connection;
    let released = false;
    return { client: connection.client, replica: connection.replica, release: () => {
      if (released) return;
      released = true;
      acquired.viewers -= 1;
      // A layout transfer can release and reacquire the same session in one turn.
      // Let the next view retain its client before collecting unused subscriptions.
      queueMicrotask(() => this.collect(acquired));
    } };
  }

  async takeControlAfterNativeResume(agentId: string): Promise<void> {
    await this.connections.get(agentId)?.client.takeControlAfterNativeResume();
  }

  clear(): void {
    for (const connection of this.connections.values()) this.close(connection);
  }

  private collect(connection: Connection): void {
    if (this.connections.get(connection.agentId) !== connection || connection.viewers > 0) return;
    if (connection.key && [...this.retained.values()].some(sessions => sessions.has(connection.key!))) return;
    this.close(connection);
  }

  private close(connection: Connection): void {
    this.connections.delete(connection.agentId);
    connection.stopDisplay();
    connection.client.stop();
    connection.stopRecovery();
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const ConversationConnectionScope = createContext<ConversationConnections | undefined>(undefined);
