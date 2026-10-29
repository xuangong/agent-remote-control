import type { AgentProviderNativeEvidence, AgentSessionNativeEvidence, AgentPromptEditEvidence } from './native-evidence.js';
import type { AgentInputPart, ImageInputCapabilities, ResourceInputCapabilities } from './image-input.js';
import type { AgentInteractionResponse } from './control.js';
import type { AgentRuntimeInfo, ProviderStreamItem } from './observation.js';

export interface AgentCapabilities {
  /** @deprecated Compatibility-only metadata. Remote clients share the host-owned session; adapters do not choose page authorization. */
  sessionControl?: 'shared' | 'exclusive';
  resourceInput?: ResourceInputCapabilities;
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
  /** Native support for Host-owned extensions on creation and reattachment.
   * toolNamespaces: 'creation' when namespaces are fixed when the session starts, 'live' when they can change at any time. */
  sessionExtensions?: { instructions: boolean; tools: boolean; toolNamespaces?: 'creation' | 'live' };
  /** The adapter enforces AgentSessionExtensions.access natively on creation and reattachment. */
  sessionAccess?: { readOnly: true };
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
  constructor(readonly code: 'native_file_limit' | 'native_runtime_unavailable' | 'native_session_unavailable' | 'native_resume_timeout' | 'native_history_timeout' | 'native_request_timeout', message: string) {
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

/** Run only side-effect-free preparation before native dispatch or callback resolution.
 * Recheck session admission synchronously after awaiting preparation.
 */
export async function prepareAgentOperation<T>(prepare: () => T | Promise<T>): Promise<T> {
  try { return await prepare(); }
  catch (error) {
    if (error instanceof AgentOperationRejectedError) throw error;
    throw new AgentOperationRejectedError('operation_preparation_failed', error instanceof Error ? error.message : 'Operation preparation failed.');
  }
}

/** Host-owned tools are local callbacks, never accepted from public wire input. */
export interface AgentSessionTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(arguments_: unknown): Promise<string>;
}
/** Tools a provider exposes as one group: a Codex dynamic tool namespace, a Claude MCP server. */
export interface AgentSessionToolNamespace {
  name: string;
  description: string;
  tools: readonly AgentSessionTool[];
  /** Registered but offered to the model only through tool search, where the provider supports it. */
  deferred?: boolean;
}
export interface AgentSessionExtensions {
  tools?: readonly AgentSessionTool[];
  /** Additional role instructions. Preserve the provider's native base prompt and policy. */
  instructions?: string;
  /** Existing provider-specific prompt configuration; use instructions for appended roles. */
  systemPrompt?: string;
  toolNamespaces?: readonly AgentSessionToolNamespace[];
  /** The session must not write its working directory, by any tool or command. Adapters without
   * descriptor.sessionAccess.readOnly reject it. Permission settings of such a session cannot change. */
  access?: 'read_only';
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

/** Explicit Host permission to initialize a prepared empty handle with its original identity.
 * Omitted means native resume only. Missing history never grants this permission.
 */
export interface AgentSessionResumeOptions {
  initializeEmpty?: boolean;
}

/** A provider-native history boundary, independent of Host authority and roles. */
export interface AgentNativePrefixTarget { nativeSessionId: string; turnId: string; messageId: string }

/** Complete native prefix creation support. Attachment validity remains on AgentSession. */
export interface AgentNativePrefixCapability {
  readonly createdSessionIdMaxLength: number;
  validate(target: AgentNativePrefixTarget): Promise<void>;
  /** Await retention of the exact original handle before any candidate bootstrap or readback.
   * A checkpoint failure may follow native creation; callers must retain unknown outcomes. */
  create(target: AgentNativePrefixTarget, extensions: AgentSessionExtensions,
    checkpoint: (handle: AgentPersistenceHandle) => Promise<void>): Promise<AgentSession>;
  verify(target: AgentNativePrefixTarget, handle: AgentPersistenceHandle): Promise<void>;
}

/** JS adapters may omit or misdeclare optional support. Never synthesize a partial capability. */
export function resolveAgentNativePrefixCapability(adapter: { readonly nativePrefix?: AgentNativePrefixCapability }): AgentNativePrefixCapability | undefined {
  const capability = adapter.nativePrefix;
  if (!capability || typeof capability !== 'object' || Array.isArray(capability)
    || !Number.isSafeInteger(capability.createdSessionIdMaxLength) || capability.createdSessionIdMaxLength < 1
    || typeof capability.validate !== 'function' || typeof capability.create !== 'function' || typeof capability.verify !== 'function') return undefined;
  return capability;
}

export interface AgentProviderAdapter {
  readonly nativePrefix?: AgentNativePrefixCapability;
  readonly nativeEvidence?: AgentProviderNativeEvidence;
  readonly descriptor: AgentProviderDescriptor;

  createSession(config: AgentSessionConfig): Promise<AgentSession>;
  resumeSession(handle: AgentPersistenceHandle, extensions?: AgentSessionExtensions, options?: AgentSessionResumeOptions): Promise<AgentSession>;
  readSessionHistory?(nativeSessionId: string, query: AgentHistoryQuery): Promise<AgentHistoryPage>;
}

export interface AgentMessageOptions {
  /** Immediate input joins active work; next_turn uses the native follow-up queue. */
  delivery?: 'immediate' | 'next_turn';
  /** Process-local evidence for this invocation, possibly after its receipt was lost.
   * Never serialized or used as operation identity. A queued disposition is not settlement. */
  onAcceptance?: (acceptance: AgentInputAcceptance) => void;
  /** Process-local evidence that queued input was removed before it ran, so it had no effect.
   * Reported only with native proof and never after started or handled acceptance. */
  onWithdrawn?: (withdrawal: AgentInputWithdrawal) => void;
}

export interface AgentInputWithdrawal {
  reason: 'stopped';
}

/** Evidence about this input at acceptance time, never the current session execution state.
 * started: accepted to start a run; queued: accepted into a native queue (not guaranteed to remain there);
 * handled: consumed without starting a run for this input. Independent work may still be active.
 */
export interface AgentInputAcceptance {
  disposition: 'started' | 'queued' | 'handled';
}

export interface AgentSession {
  readonly nativeEvidence?: AgentSessionNativeEvidence;
  readonly promptEditEvidence?: AgentPromptEditEvidence;
  readonly capabilities: AgentCapabilities;

  /** One ordered stream for this native session attachment. Publish runtime_updated whenever
   * native execution changes, independently of turn results. Recovered callable interactions
   * must be confirmed by the native runtime and emitted live, including during bootstrap.
   * Fence asynchronous native reads and obsolete callbacks before publishing newer state.
   */
  observe(): AsyncIterable<ProviderStreamItem>;
  /** Reads an older, chronological Timeline page without changing live runtime state. */
  readTimelineHistory?(cursor: string): Promise<{ observations: import('./observation.js').ProviderObservation[]; nextCursor?: string }>;
  /** Resolves when input is accepted by the adapter-owned delivery channel, not when a turn completes.
   * RPC providers require a native receipt; streaming providers may accept into their owned input queue.
   * Subsequent normalized observations report execution; resolution alone does not guarantee durable persistence.
   * Return acceptance details only from native evidence. A void result leaves disposition unknown.
   * A rejected operation must throw AgentOperationRejectedError only with proof of no requested effect.
   */
  sendMessage(text: string, options?: AgentMessageOptions): Promise<AgentInputAcceptance | void>;
  sendMessageContent?(parts: readonly AgentInputPart[], options?: AgentMessageOptions): Promise<AgentInputAcceptance | void>;
  respondToInteraction(requestId: string, response: AgentInteractionResponse): Promise<void>;
  steer?(text: string, options?: AgentMessageOptions): Promise<AgentInputAcceptance | void>;
  cancel?(): Promise<void>;
  setPlanning?(active: boolean): Promise<void>;
  /** Replaces the session's tool namespaces. 'live' adapters may add and remove namespaces; 'creation' adapters
   * may only rebind the executors of namespaces declared when the session started and reject anything else. */
  updateToolNamespaces?(namespaces: readonly AgentSessionToolNamespace[]): Promise<void>;
  /** Deferred has not been submitted and may be retried after native state changes.
   * Pending has been accepted by native code and must not be submitted again.
   * Runtime settings report confirmed native selections in every case. */
  setSessionSetting?(id: string, value: string): Promise<void | { status: 'pending' | 'deferred' }>;
  listCommands?(): Promise<import('./commands.js').AgentCommand[]>;
  executeCommand?(id: string, args: string): Promise<import('./commands.js').AgentCommandResult>;
  readResource?(locator: string): Promise<AgentResourceReadResult>;
  /** Current native execution facts, consistent with live runtime_updated observations.
   * Request a fresh native settings read when supported; unsupported fields retain their last confirmation. */
  runtimeInfo(options?: { refreshSettings?: boolean }): Promise<AgentRuntimeInfo>;
  dispose(): Promise<void>;
}

export type AgentResourceReadResult =
  | { status: 'available'; bytes: Uint8Array; mediaType: string }
  | { status: 'unavailable'; reason: string };
