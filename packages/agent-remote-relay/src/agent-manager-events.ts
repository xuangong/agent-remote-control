import type {
  AgentInteractionRequest,
  AgentInteractionResponse,
  AgentStreamEvent,
} from '@borgee/agent-provider-sdk';
import type {
  AgentSnapshot,
  ResourceBinding,
  ResourceState,
} from '@borgee/agent-remote-protocol';

import type { CanonicalTimelineRow } from './timeline-store.js';

export type AgentManagerEvent =
  | { type: 'agent_state'; agentId: string; snapshot: AgentSnapshot }
  | {
      type: 'agent_stream';
      agentId: string;
      event: AgentStreamEvent;
      timestamp: string;
      row?: CanonicalTimelineRow;
    }
  | { type: 'timeline_replacement'; agentId: string; epoch: string }
  | {
      type: 'timeline_resource_binding_replaced';
      agentId: string;
      epoch: string;
      seq: number;
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
    };
