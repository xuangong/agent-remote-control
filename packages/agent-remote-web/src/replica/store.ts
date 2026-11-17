import { transition, type SendState } from './send-state.js';
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
  AgentInputAcceptance,
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
  restoreFromDevice,
} from './reducer.js';
import type { AgentReplicaState, OutgoingMessage, SnapshotApplicationOptions, TimelineReduction } from './types.js';
import { anchorNow, PendingMessages } from './pending-messages.js';

export class AgentReplica {
  private state = createReplicaState();
  private readonly listeners = new Set<() => void>();
  private readonly historyListeners = new Set<(epoch: string, direction: HistoryPage['payload']['direction']) => void>();
  private readonly outbox = new PendingMessages(() => this.replace(this.outbox.reconcile(this.state)));

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

  /** A ledger written before row keys (`epoch`, `afterSeq`, `consumedEchoSeqs`) is read once as unconfirmed and kept in the new form. */
  restoreMessages(messages: readonly OutgoingMessage[]): void {
    if (this.state.outgoingMessages?.length) return;
    this.replace({ ...this.state, outgoingMessages: messages.map(message => {
      const { epoch: _epoch, afterSeq: _afterSeq, consumedEchoSeqs: _consumed, ...kept } = message as OutgoingMessage & { epoch?: unknown; afterSeq?: unknown; consumedEchoSeqs?: unknown };
      const step = transition(message.status, { type: 'restored', ...(message.error === undefined ? {} : { error: message.error }) });
      return { ...kept, status: step.state as SendState, error: step.error ?? undefined };
    }) });
  }

  retryMessage(id: string, operationId: string): void {
    this.replace({ ...this.state, outgoingMessages: this.state.outgoingMessages?.map(message => message.id === id && transition(message.status, { type: 'retry' }).state === 'sending'
      ? { ...message, operationId, retryRequiresNewOperation: false, status: 'sending', error: undefined,
          submittedTextSha256: message.operationId === operationId ? message.submittedTextSha256 : undefined,
          consumedEchoKeys: message.operationId === operationId ? message.consumedEchoKeys : undefined,
          afterKey: message.operationId === operationId && message.status === 'unconfirmed'
            ? this.outbox.anchorFor(this.state, message) : anchorNow(this.state) }
      : message) });
  }

  deleteMessage(id: string): void {
    this.replace({ ...this.state, outgoingMessages: this.state.outgoingMessages?.filter(message => message.id !== id) });
  }

  acknowledgeMessage(id: string, acceptance?: AgentInputAcceptance, submittedTextSha256?: string): void {
    if (acceptance?.disposition === 'handled') { this.deleteMessage(id); return; }
    this.replace({ ...this.state, outgoingMessages: this.state.outgoingMessages?.map(message => {
      if (message.id !== id) return message;
      const step = transition(message.status, { type: 'acknowledged', handled: false });
      if (step.state === 'delivered' || message.status === 'failed') return message;
      return { ...message, submittedTextSha256: submittedTextSha256 ?? message.submittedTextSha256,
        status: step.state, error: step.error === undefined ? message.error : step.error ?? undefined };
    }) });
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

  /** Seeds an unread replica from this device's record of the session; a replica that read anything keeps what it has. */
  restoreFromDevice(session: Parameters<typeof restoreFromDevice>[1]): void {
    this.replace(restoreFromDevice(this.state, session));
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
