import { createContext } from 'react';
import { RemoteSessionClient, type AgentReplica, type RemoteAgentTransport, type SessionControlExtension } from '@orchardworks/agent-remote-web';
import { recoverMessages } from './message-recovery.js';
import { sessionKey, type SessionEntry } from './session-tree.js';

type Identity = Pick<SessionEntry, 'hostId' | 'providerId' | 'nativeSessionId'>;
interface Connection {
  agentId: string;
  key?: string;
  client: RemoteSessionClient;
  replica: AgentReplica;
  viewers: number;
  stopRecovery(): void;
}

/** Keeps already opened tracked conversations live independently of their mounted views. */
export class ConversationConnections {
  private readonly connections = new Map<string, Connection>();
  private tracked = new Set<string>();

  constructor(private readonly transport: RemoteAgentTransport, private readonly recoveryScope?: string, private readonly controlExtension?: (agentId: string, session?: Identity) => SessionControlExtension | undefined) {}

  get agentIds(): string[] { return [...this.connections.keys()]; }

  find(session: Identity): Connection | undefined {
    const key = sessionKey(session);
    return [...this.connections.values()].find(connection => connection.key === key);
  }

  retainTracked(sessions: readonly Identity[]): void {
    this.tracked = new Set(sessions.map(sessionKey));
    for (const connection of this.connections.values()) this.collect(connection);
  }

  acquire(agentId: string, replica: AgentReplica, session?: Identity): { client: RemoteSessionClient; replica: AgentReplica; release(): void } {
    let connection = this.connections.get(agentId);
    if (!connection) {
      const key = session ? sessionKey(session) : undefined;
      connection = { agentId, key, replica, viewers: 0,
        client: new RemoteSessionClient(agentId, this.transport, replica, { historyPageSize: 100, requireSessionControl: true, clientKind: 'web', handoffTarget: key, controlExtension: this.controlExtension?.(agentId, session) }),
        stopRecovery: this.recoveryScope ? recoverMessages(replica, this.recoveryScope, key ?? agentId, agentId) : () => {},
      };
      this.connections.set(agentId, connection);
      try { connection.client.start(); }
      catch (error) { this.close(connection); throw error; }
    }
    if (session) connection.key = sessionKey(session);
    connection.viewers += 1;
    const acquired = connection;
    let released = false;
    return { client: connection.client, replica: connection.replica, release: () => {
      if (released) return;
      released = true;
      acquired.viewers -= 1;
      this.collect(acquired);
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
    if (connection.key && this.tracked.has(connection.key)) return;
    this.close(connection);
  }

  private close(connection: Connection): void {
    this.connections.delete(connection.agentId);
    connection.client.stop();
    connection.stopRecovery();
  }
}

export const ConversationConnectionScope = createContext<ConversationConnections | undefined>(undefined);
