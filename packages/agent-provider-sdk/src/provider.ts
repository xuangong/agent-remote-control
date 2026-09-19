import type { AgentInteractionResponse } from './control.js';
import type { AgentRuntimeInfo, ProviderStreamItem } from './observation.js';

export interface AgentCapabilities {
  history: boolean;
  sendMessage: boolean;
  queueMessage?: boolean;
  steer: boolean;
  cancel: boolean;
  readResource: boolean;
  sessionSettings?: boolean;
  commands?: boolean;
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

/** An adapter-confirmed ownership conflict, with a message safe for remote clients. */
export class AgentSessionInUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentSessionInUseError';
  }
}

/** Adapter-confirmed runtime failure. Messages must be safe for remote clients. */
export class AgentRuntimeError extends Error {
  constructor(readonly code: 'native_runtime_unavailable' | 'native_resume_timeout' | 'native_history_timeout' | 'native_request_timeout', message: string) {
    super(message);
    this.name = 'AgentRuntimeError';
  }
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

export interface AgentMessageOptions {
  /** Immediate input joins active work; next_turn uses the native follow-up queue. */
  delivery?: 'immediate' | 'next_turn';
}

export interface AgentSession {
  readonly capabilities: AgentCapabilities;

  observe(): AsyncIterable<ProviderStreamItem>;
  sendMessage(text: string, options?: AgentMessageOptions): Promise<void>;
  respondToInteraction(requestId: string, response: AgentInteractionResponse): Promise<void>;
  steer?(text: string): Promise<void>;
  cancel?(): Promise<void>;
  setPlanning?(active: boolean): Promise<void>;
  setSessionSetting?(id: string, value: string): Promise<void>;
  listCommands?(): Promise<import('./commands.js').AgentCommand[]>;
  executeCommand?(id: string, args: string): Promise<import('./commands.js').AgentCommandResult>;
  readResource?(locator: string): Promise<AgentResourceReadResult>;
  runtimeInfo(): Promise<AgentRuntimeInfo>;
  dispose(): Promise<void>;
}

export type AgentResourceReadResult =
  | { status: 'available'; bytes: Uint8Array; mediaType: string }
  | { status: 'unavailable'; reason: string };
