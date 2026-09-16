import type { AgentToolCallTimelineItem } from '@agent-remote-controller/agent-provider-sdk';

import type { DshImageReference } from './content.js';

export interface AssistantStreamState {
  text: string;
  reasoning: string;
}

export class DshSessionState {
  readonly assistants = new Map<string, AssistantStreamState>();
  readonly tools = new Map<string, AgentToolCallTimelineItem>();
  readonly images = new Map<string, DshImageReference>();
  readonly pendingWrites = new Map<string, { locator: string }>();
}
