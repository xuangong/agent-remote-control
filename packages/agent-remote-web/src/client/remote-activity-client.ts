import { watchPageResume } from './page-resume.js';
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
  private unwatchResume?: () => void;
  private attempts = 0;
  private awaitingActivity = false;
  private pageHidden = false;
  constructor(private readonly agentId: string, private readonly transport: RemoteAgentTransport,
    private readonly changed: (state: RemoteActivityState) => void) {}
  start(): void {
    this.stop(); this.attempts = 0;
    this.pageHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    this.unwatchResume = watchPageResume(suspendedMs => {
      this.pageHidden = false;
      // A restored page may not have observed pagehide before being suspended.
      if (suspendedMs === Infinity) this.clearDeadline();
      queueMicrotask(() => {
        if (this.pageHidden) return;
        if (this.timer) {
          this.closeConnection(); this.attempts = 0; this.connect();
        } else this.armDeadline();
      });
    }, () => {
      this.pageHidden = true;
      this.clearDeadline();
    });
    this.connect();
  }
  stop(): void {
    this.unwatchResume?.(); this.unwatchResume = undefined;
    this.closeConnection();
  }
  private closeConnection(): void {
    ++this.generation;
    this.awaitingActivity = false;
    clearTimeout(this.timer); this.timer = undefined;
    this.clearDeadline();
    const connection = this.connection; this.connection = undefined;
    connection?.close();
  }
  private clearDeadline(): void {
    clearTimeout(this.deadline); this.deadline = undefined;
  }
  private armDeadline(): void {
    if (!this.awaitingActivity || this.pageHidden || this.deadline !== undefined) return;
    const generation = this.generation;
    this.deadline = setTimeout(() => this.failed(generation, 'The Host did not confirm activity tracking. Retrying…'), 20000);
  }
  private connect(): void {
    this.timer = undefined;
    const generation = ++this.generation;
    this.awaitingActivity = true;
    this.changed({ connection: 'connecting' });
    this.armDeadline();
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
      this.awaitingActivity = false;
      this.clearDeadline(); this.attempts = 0;
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
    this.closeConnection();
    this.changed({ connection: 'disconnected', ...(error ? { error } : {}) });
    if (retry) this.timer = setTimeout(() => this.connect(), Math.min(1000 * 2 ** this.attempts++, 15000));
  }
}
