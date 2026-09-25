import type {
  AgentSnapshot,
  AgentStreamMessage,
  AgentUpdateMessage,
  HistoryPage,
  InteractionRequestedMessage,
  InteractionInvalidatedMessage,
  InteractionResolvedMessage,
  ResourceResponse,
  ResourceUpdate,
  TimelineResourceBindingReplacement,
} from '@orchardworks/agent-remote-protocol';

import {
  applyAgentSnapshot,
  applyHistoryPage,
  applyInteractionRequestedMessage,
  applyInteractionInvalidatedMessage,
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
  private readonly historyListeners = new Set<(epoch: string, direction: HistoryPage['payload']['direction']) => void>();
  private readonly outbox = new MessageOutbox();

  setSessionControl(control: AgentReplicaState['sessionControl']): void {
    this.replace({ ...this.state, sessionControl: control });
  }

  getState(): AgentReplicaState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Reports only accepted history applications, not buffered live or resource changes. */
  subscribeHistory(listener: (epoch: string, direction: HistoryPage['payload']['direction']) => void): () => void {
    this.historyListeners.add(listener);
    return () => this.historyListeners.delete(listener);
  }

  beginMessage(agentId: string, text: string, delivery?: OutgoingMessage['delivery'], operationId?: string, rich?: Pick<OutgoingMessage, 'content' | 'imageDigests'>): string {
    const message = this.outbox.create(this.state, agentId, text, delivery, operationId, rich);
    this.replace({ ...this.state, outgoingMessages: [...(this.state.outgoingMessages ?? []), message] });
    return message.id;
  }

  restoreMessages(messages: readonly OutgoingMessage[]): void {
    if (this.state.outgoingMessages?.length) return;
    this.replace({ ...this.state, outgoingMessages: messages.map(message => ({ ...message,
      status: message.status === 'failed' ? 'failed' : 'unconfirmed',
      error: message.error ?? 'Delivery was not confirmed before this page closed. Check the conversation before retrying.',
    })) });
  }

  retryMessage(id: string, operationId: string): void {
    this.replace({ ...this.state, outgoingMessages: this.state.outgoingMessages?.map(message => message.id === id
      ? { ...message, operationId, retryRequiresNewOperation: false, status: 'sending', error: undefined,
          epoch: this.state.timeline.epoch,
          afterSeq: message.epoch === this.state.timeline.epoch && message.status === 'unconfirmed' ? message.afterSeq : this.state.timeline.nextSeq - 1 }
      : message) });
  }

  deleteMessage(id: string): void {
    this.replace({ ...this.state, outgoingMessages: this.state.outgoingMessages?.filter(message => message.id !== id) });
  }

  updateMessage(id: string, status: OutgoingMessage['status'], error?: string, retryRequiresNewOperation?: boolean): void {
    const existing = this.state.outgoingMessages?.find(message => message.id === id);
    if (!existing || (status === 'awaiting_echo' && (existing.status === 'failed' || existing.status === 'unconfirmed'))) return;
    this.replace({ ...this.state, outgoingMessages: this.state.outgoingMessages?.map(message => message.id === id
      ? { ...message, status, error, retryRequiresNewOperation: retryRequiresNewOperation ?? message.retryRequiresNewOperation } : message) });
  }

  applySnapshot(snapshot: AgentSnapshot | AgentUpdateMessage, options?: SnapshotApplicationOptions): void {
    this.replace(applyAgentSnapshot(this.state, snapshot, options));
  }

  applyHistory(page: HistoryPage, options?: { preserveLive?: boolean }): TimelineReduction {
    const result = applyHistoryPage(this.state, page, options);
    this.replace(result.state);
    if (result.status === 'applied' || result.status === 'duplicate') {
      for (const listener of this.historyListeners) listener(page.payload.epoch, page.payload.direction);
    }
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

  applyInteractionInvalidated(message: InteractionInvalidatedMessage): void {
    this.replace(applyInteractionInvalidatedMessage(this.state, message));
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
    for (const listener of this.listeners) listener();
  }
}
