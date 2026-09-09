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
} from '@borgee/agent-remote-protocol';

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
import type { AgentReplicaState, SnapshotApplicationOptions, TimelineReduction } from './types.js';

export class AgentReplica {
  private state = createReplicaState();
  private readonly listeners = new Set<() => void>();

  getState(): AgentReplicaState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}
