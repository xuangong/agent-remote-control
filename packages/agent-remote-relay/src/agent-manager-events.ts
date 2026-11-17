import type {
  AgentInteractionRequest,
  AgentInteractionResponse,
  AgentStreamEvent,
} from '@orchardworks/agent-provider-sdk';
import type {
  AgentSnapshot,
  TimelineCursor,
  ResourceBinding,
  ResourceState,
} from '@orchardworks/agent-remote-protocol';

import type { CanonicalTimelineRow } from '@orchardworks/agent-timeline';

export type AgentManagerEvent =
  | { type: 'agent_state'; agentId: string; snapshot: AgentSnapshot; cursor?: TimelineCursor }
  | {
      type: 'agent_stream';
      agentId: string;
      event: AgentStreamEvent;
      delivery?: 'history' | 'live';
      timestamp: string;
      row?: CanonicalTimelineRow;
    }
  | { type: 'timeline_replacement'; agentId: string; epoch: string }
  /** Internal publication boundary after all replacement rows have been committed. */
  | { type: 'timeline_rebuilt'; agentId: string; cursor: TimelineCursor }
  | {
      type: 'timeline_resource_binding_replaced';
      agentId: string;
      epoch: string;
      seq: number;
      /** The key of the item whose row was rebound, as `rowItemKey` names it. */
      itemKey: string;
      previous: ResourceBinding;
      replacement: ResourceBinding;
    }
  | { type: 'resource_update'; agentId: string; resourceId: string; state: ResourceState }
  | { type: 'interaction_requested'; agentId: string; request: AgentInteractionRequest }
  | {
      type: 'interaction_resolved';
      agentId: string;
      requestId: string;
      response: AgentInteractionResponse;
    }
  | {
      type: 'interaction_invalidated';
      agentId: string;
      requestId: string;
      reason: string;
      turnId?: string;
    };
