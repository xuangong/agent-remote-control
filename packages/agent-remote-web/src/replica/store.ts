import type {
  AgentSnapshot,
  AgentStreamMessage,
  AgentUpdateMessage,
  HistoryPage,
  InteractionRequestedMessage,
  InteractionResolvedMessage,
  ResourceResponse,
  ResourceUpdate,
  TimelineResourceBindingReplacement,
} from '@agent-remote-controller/agent-remote-protocol';

import {
  applyAgentSnapshot,
  applyHistoryPage,
  applyInteractionRequestedMessage,
  applyInteractionResolvedMessage,
  applyResourceResponse,
  applyResourceUpdate,
  applyTimelineResourceBindingReplacement,
  applyTimelineReplacement,
  createReplicaState,
  reduceTimelineEvent,
} from './reducer.js';
import type { AgentReplicaState, OutgoingMessage, SnapshotApplicationOptions, TimelineReduction } from './types.js';
import { MessageOutbox } from './message-outbox.js';

export class AgentReplica {
  private state = createReplicaState();
  private readonly listeners = new Set<() => void>();
  private readonly outbox = new MessageOutbox();
  private readonly messageTimers = new Map<string, { confirmation?: ReturnType<typeof setTimeout>; removal?: ReturnType<typeof setTimeout> }>();

  getState(): AgentReplicaState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  beginMessage(agentId: string, text: string, delivery?: OutgoingMessage['delivery']): string {
    const message = this.outbox.create(this.state, agentId, text, delivery);
    this.replace({ ...this.state, outgoingMessages: [...(this.state.outgoingMessages ?? []), message] });
    return message.id;
  }

  updateMessage(id: string, status: OutgoingMessage['status'], error?: string): void {
    const existing = this.state.outgoingMessages?.find(message => message.id === id);
    if (!existing || (status === 'awaiting_echo' && (existing.status === 'failed' || existing.status === 'unconfirmed'))) return;
    this.replace({ ...this.state, outgoingMessages: this.state.outgoingMessages?.map(message => message.id === id
      ? { ...message, status, error } : message) });
  }

  applySnapshot(snapshot: AgentSnapshot | AgentUpdateMessage, options?: SnapshotApplicationOptions): void {
    this.replace(applyAgentSnapshot(this.state, snapshot, options));
  }

  applyHistory(page: HistoryPage): TimelineReduction {
    const result = applyHistoryPage(this.state, page);
    this.replace(result.state);
    return result;
  }

  applyStream(message: AgentStreamMessage): TimelineReduction {
    const result = reduceTimelineEvent(this.state, message);
    this.replace(result.state);
    return result;
  }

  applyInteractionRequested(message: InteractionRequestedMessage): void {
    this.replace(applyInteractionRequestedMessage(this.state, message));
  }

  applyInteractionResolved(message: InteractionResolvedMessage): void {
    this.replace(applyInteractionResolvedMessage(this.state, message));
  }

  applyResource(message: ResourceResponse | ResourceUpdate): void {
    this.replace(message.type === 'resource_response'
      ? applyResourceResponse(this.state, message)
      : applyResourceUpdate(this.state, message));
  }

  replaceTimelineResourceBinding(message: TimelineResourceBindingReplacement): void {
    this.replace(applyTimelineResourceBindingReplacement(this.state, message));
  }

  replaceTimeline(epoch: string): void {
    this.replace(applyTimelineReplacement(this.state, epoch));
  }

  reportDiagnostic(code: string, message: string, recoverable: boolean): void {
    this.replace({
      ...this.state,
      diagnostics: [...this.state.diagnostics, { code, message, recoverable }],
    });
  }

  private replace(next: AgentReplicaState): void {
    if (next === this.state) return;
    this.state = this.outbox.reconcile(next);
    this.syncMessageTimers();
    for (const listener of this.listeners) listener();
  }

  private syncMessageTimers(): void {
    const messages = this.state.outgoingMessages ?? [];
    for (const [id, timers] of this.messageTimers) {
      if (messages.some(message => message.id === id)) continue;
      clearTimeout(timers.confirmation); clearTimeout(timers.removal);
      this.messageTimers.delete(id);
    }
    for (const message of messages) {
      const timers = this.messageTimers.get(message.id) ?? {};
      this.messageTimers.set(message.id, timers);
      if (message.status === 'failed' || message.status === 'unconfirmed') {
        clearTimeout(timers.confirmation); timers.confirmation = undefined;
        timers.removal ??= backgroundTimer(() => this.replace({ ...this.state,
          outgoingMessages: this.state.outgoingMessages?.filter(item => item.id !== message.id) }), 10_000);
      } else if (!timers.confirmation && !timers.removal) {
        timers.confirmation = backgroundTimer(() => this.updateMessage(message.id, 'unconfirmed',
          'No message confirmation arrived within 30 seconds. Check the conversation before sending again.'), 30_000);
      }
    }
  }
}

function backgroundTimer(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, delay);
  // Local feedback must not keep a headless Node consumer alive.
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  return timer;
}
