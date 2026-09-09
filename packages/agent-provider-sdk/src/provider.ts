import type { AgentInteractionResponse } from './control.js';
import type { AgentRuntimeInfo, ProviderStreamItem } from './observation.js';

export interface AgentCapabilities {
  history: boolean;
  sendMessage: boolean;
  steer: boolean;
  cancel: boolean;
  readResource: boolean;
  planning?: boolean;
  interactions: {
    question: boolean;
    planApproval: boolean;
    toolApproval: boolean;
    form?: boolean;
    permissionApproval?: boolean;
    externalAction?: boolean;
  };
}

export interface AgentProviderDescriptor {
  providerId: string;
  displayName: string;
}

export interface AgentPersistenceHandle {
  providerId: string;
  sessionId: string;
  opaque: string;
}

export interface AgentSessionConfig {
  sessionId: string;
  cwd?: string;
  model?: string;
  reasoningEffort?: string;
  systemPrompt?: string;
  planning?: boolean;
}

export interface AgentProviderAdapter {
  readonly descriptor: AgentProviderDescriptor;

  createSession(config: AgentSessionConfig): Promise<AgentSession>;
  resumeSession(handle: AgentPersistenceHandle): Promise<AgentSession>;
}

export interface AgentSession {
  readonly capabilities: AgentCapabilities;

  observe(): AsyncIterable<ProviderStreamItem>;
  sendMessage(text: string): Promise<void>;
  respondToInteraction(requestId: string, response: AgentInteractionResponse): Promise<void>;
  steer?(text: string): Promise<void>;
  cancel?(): Promise<void>;
  setPlanning?(active: boolean): Promise<void>;
  readResource?(locator: string): Promise<AgentResourceReadResult>;
  runtimeInfo(): Promise<AgentRuntimeInfo>;
  dispose(): Promise<void>;
}

export type AgentResourceReadResult =
  | { status: 'available'; bytes: Uint8Array; mediaType: string }
  | { status: 'unavailable'; reason: string };
