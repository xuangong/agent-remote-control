import type { AgentInputPart, ImageInputCapabilities } from './image-input.js';
import type { AgentInteractionResponse } from './control.js';
import type { AgentRuntimeInfo, ProviderStreamItem } from './observation.js';

export interface AgentCapabilities {
  /** Remote writer policy; omitted values retain exclusive control. Only adapters can declare shared control. */
  sessionControl?: 'shared' | 'exclusive';
  imageInput?: ImageInputCapabilities;
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
  constructor(readonly code: 'native_file_limit' | 'native_runtime_unavailable' | 'native_resume_timeout' | 'native_history_timeout' | 'native_request_timeout', message: string) {
    super(message);
    this.name = 'AgentRuntimeError';
  }
}

/** Adapter-confirmed operation rejection: native work did not start and produced no side effects. */
export class AgentOperationRejectedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AgentOperationRejectedError';
  }
}

/** Host-owned tools are local callbacks, never accepted from public wire input. */
export interface AgentSessionTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(arguments_: unknown): Promise<string>;
}
export interface AgentSessionExtensions {
  tools?: readonly AgentSessionTool[];
  systemPrompt?: string;
}
export interface AgentHistoryQuery {
  cursor?: string;
  turnId?: string;
  query?: string;
  limit?: number;
  textOffset?: number;
}
export interface AgentHistoryPage {
  entries: Array<{ id: string; turnId: string; role: string; text: string; textOffset: number; totalChars: number }>;
  nextCursor?: string;
}

export interface AgentSessionConfig extends AgentSessionExtensions {
  sessionId: string;
  cwd?: string;
  model?: string;
  reasoningEffort?: string;
  planning?: boolean;
}

export interface AgentProviderAdapter {
  readonly descriptor: AgentProviderDescriptor;

  createSession(config: AgentSessionConfig): Promise<AgentSession>;
  resumeSession(handle: AgentPersistenceHandle, extensions?: AgentSessionExtensions): Promise<AgentSession>;
  readSessionHistory?(nativeSessionId: string, query: AgentHistoryQuery): Promise<AgentHistoryPage>;
}

export interface AgentMessageOptions {
  /** Immediate input joins active work; next_turn uses the native follow-up queue. */
  delivery?: 'immediate' | 'next_turn';
}

export interface AgentSession {
  readonly capabilities: AgentCapabilities;

  observe(): AsyncIterable<ProviderStreamItem>;
  /** Reads an older, chronological Timeline page without changing live runtime state. */
  readTimelineHistory?(cursor: string): Promise<{ observations: import('./observation.js').ProviderObservation[]; nextCursor?: string }>;
  sendMessage(text: string, options?: AgentMessageOptions): Promise<void>;
  sendMessageContent?(parts: readonly AgentInputPart[], options?: AgentMessageOptions): Promise<void>;
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
