import { createContext } from 'react';
import { RemoteSessionClient, type AgentReplica, type RemoteAgentTransport } from '@orchardworks/agent-remote-web';
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

  constructor(private readonly transport: RemoteAgentTransport, private readonly recoveryScope?: string) {}

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
        client: new RemoteSessionClient(agentId, this.transport, replica, { historyPageSize: 100, requireSessionControl: true, clientKind: 'web' }),
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
    const connection = this.connections.get(agentId);
    if (!connection) return;
    await new Promise<void>((resolve, reject) => {
      let status = '', settled = false;
      let unwatchStatus = () => {}, unwatchReplica = () => {};
      const finish = (error?: Error) => {
        if (settled) return; settled = true;
        clearTimeout(timer); unwatchStatus(); unwatchReplica();
        error ? reject(error) : resolve();
      };
      const check = () => queueMicrotask(() => {
        if (this.connections.get(agentId) !== connection) finish(new Error('The session view closed before control was acquired.'));
        else if (status === 'ready' && !connection.replica.getState().sessionControl?.nativeOwner) finish();
      });
      const timer = setTimeout(() => finish(new Error('Native resume has not synchronized yet. Check the session before retrying.')), 15000);
      unwatchStatus = connection.client.subscribeStatus(value => {status = value; check();});
      unwatchReplica = connection.replica.subscribe(check);
    });
    await connection.client.takeControl();
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
