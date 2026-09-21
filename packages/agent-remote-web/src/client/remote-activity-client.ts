import { PROTOCOL_VERSION, type TimelineCursor, type AgentStatus } from '@orchardworks/agent-remote-protocol';
import type { RemoteAgentTransport, RemoteConnection, RemoteServerMessage } from './transport.js';

export interface RemoteActivityState {
  connection: 'connecting' | 'ready' | 'disconnected';
  activity?: AgentStatus;
  cursor?: TimelineCursor;
  error?: string;
}
/** A read-only subscription: no replica, history fetches, resources, or content commands. */
export class RemoteActivityClient {
  private connection?: RemoteConnection;
  private timer?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private attempts = 0;
  constructor(private readonly agentId: string, private readonly transport: RemoteAgentTransport,
    private readonly changed: (state: RemoteActivityState) => void) {}
  start(): void { this.stop(); this.attempts = 0; this.connect(); }
  stop(): void {
    ++this.generation;
    clearTimeout(this.timer); clearTimeout(this.deadline);
    this.timer = undefined; this.deadline = undefined;
    const connection = this.connection; this.connection = undefined;
    connection?.close();
  }
  private connect(): void {
    const generation = ++this.generation;
    this.changed({ connection: 'connecting' });
    this.deadline = setTimeout(() => this.failed(generation, 'The Host did not confirm activity tracking. Retrying…'), 20000);
    try {
      this.connection = this.transport.connect(this.agentId, {
        onOpen: () => { if (generation === this.generation) this.connection?.send({ protocolVersion: PROTOCOL_VERSION, type: 'negotiate', observation: 'activity' }); },
        onMessage: message => { if (generation === this.generation) this.receive(generation, message); },
        onDisconnect: () => this.failed(generation),
      });
    } catch { this.failed(generation, 'Activity tracking could not connect. Retrying…'); }
  }
  private receive(generation: number, message: RemoteServerMessage): void {
    if (message.type === 'agent_activity' && message.payload.agentId === this.agentId) {
      clearTimeout(this.deadline); this.deadline = undefined; this.attempts = 0;
      this.changed({ connection: 'ready', activity: message.payload.status, ...(message.payload.cursor ? { cursor: message.payload.cursor } : {}) });
    } else if (message.type === 'protocol_error') {
      const unsupported = message.payload.code === 'invalid_shape' || message.payload.code === 'incompatible_protocol_version';
      this.failed(generation, unsupported ? 'This Host does not support activity-only tracking. Update the Controller to track sessions.' : message.payload.message, !unsupported && message.payload.recoverable);
    } else if (message.type !== 'negotiated') {
      this.failed(generation, 'The Host returned content to an activity-only subscription. Update the Controller to track sessions.', false);
    }
  }
  private failed(generation: number, error?: string, retry = true): void {
    if (generation !== this.generation) return;
    this.stop();
    this.changed({ connection: 'disconnected', ...(error ? { error } : {}) });
    if (retry) this.timer = setTimeout(() => this.connect(), Math.min(1000 * 2 ** this.attempts++, 15000));
  }
}
