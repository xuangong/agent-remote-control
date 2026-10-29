import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { SDKMessage, SessionMessage, StopHookInput } from '@anthropic-ai/claude-agent-sdk';
import { AGENT_NATIVE_EVIDENCE_REASONS, AgentOperationRejectedError, parseAgentInputMaterialization, parseAgentPreparedTextInput,
  serializeAgentEmptyCreationResult, serializeAgentInputMaterialization, serializeAgentPreparedTextInput,
  type AgentInputMaterialization, type AgentInputPart, type AgentMessageOptions, type AgentNativeAuthorityScope,
  type AgentNativeEvidenceCode, type AgentNativeReadiness, type AgentNativeValidityToken, type AgentPersistenceHandle,
  type AgentPreparedTextInput, type AgentSessionNativeEvidence } from '@orchardworks/agent-provider-sdk';
import { isResumableClaudePermissionMode } from './permission-modes.js';
import type { ClaudeSessionConfig, ClaudeSessionOptions } from './session.js';

export function claudeEvidenceReject(code: AgentNativeEvidenceCode): never { throw new AgentOperationRejectedError(code, AGENT_NATIVE_EVIDENCE_REASONS[code]); }
function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value);
}
function same(a: unknown, b: unknown) { return canonical(a) === canonical(b); }
function unknown(code: AgentNativeEvidenceCode): AgentInputMaterialization { return { status: 'unknown', code, reason: AGENT_NATIVE_EVIDENCE_REASONS[code] }; }
/** Native tools that schedule or cancel a later turn of this session. */
const sessionCronTools = new Set(['CronCreate', 'CronDelete', 'ScheduleWakeup']);
export function validClaudeId(id: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id); }

/** Stable profile namespace; owned-runtime does not claim a shared service or process survival. */
export function claudeAuthority(sessionId: string, cwd: string, options: ClaudeSessionOptions): AgentNativeAuthorityScope {
  const env = { ...process.env, ...options.env };
  const profile = resolve(env.CLAUDE_CONFIG_DIR ?? resolve(env.HOME ?? homedir(), '.claude'));
  return { kind: 'owned-runtime', authorityId: `claude-${hash(profile)}`, namespaceId: hash(canonical({ profile, sessionId, cwd })) };
}
export interface ClaudeEmptyDescriptor { version: 2; kind: 'claude-empty-session'; sessionId: string; cwd: string; authority: AgentNativeAuthorityScope; config: Partial<ClaudeSessionConfig> }
export function claudeEmptyHandle(config: ClaudeSessionConfig, options: ClaudeSessionOptions): AgentPersistenceHandle {
  const { tools: _tools, ...saved } = config;
  const descriptor: ClaudeEmptyDescriptor = { version: 2, kind: 'claude-empty-session', sessionId: config.sessionId,
    cwd: config.cwd!, authority: claudeAuthority(config.sessionId, config.cwd!, options), config: saved };
  const handle = { providerId: 'claude', sessionId: config.sessionId, opaque: canonical(descriptor) };
  serializeAgentEmptyCreationResult({ status: 'created', handle });
  return handle;
}
export function readClaudeEmptyDescriptor(handle: AgentPersistenceHandle, options: ClaudeSessionOptions): ClaudeEmptyDescriptor | undefined {
  let value: any;
  try { value = JSON.parse(handle.opaque); } catch { return; }
  if (value?.kind !== 'claude-empty-session') return;
  serializeAgentEmptyCreationResult({ status: 'created', handle });
  if (handle.providerId !== 'claude' || !validClaudeId(handle.sessionId) || value.version !== 2 || value.sessionId !== handle.sessionId
    || typeof value.cwd !== 'string' || !value.cwd || value.cwd.includes('\0') || !value.config || typeof value.config !== 'object'
    || value.config.sessionId !== handle.sessionId || value.config.cwd !== value.cwd
    || !same(value.authority, claudeAuthority(handle.sessionId, value.cwd, options))) claudeEvidenceReject('native_evidence_stale');
  const fields = ['sessionId', 'cwd', 'model', 'reasoningEffort', 'systemPrompt', 'instructions', 'planning', 'permissionMode', 'access'];
  if (Object.keys(value).some(key => !['version', 'kind', 'sessionId', 'cwd', 'authority', 'config'].includes(key))
    || Object.keys(value.config).some(key => !fields.includes(key))) claudeEvidenceReject('native_evidence_invalid');
  for (const key of ['model', 'reasoningEffort', 'systemPrompt', 'instructions']) if (value.config[key] !== undefined && typeof value.config[key] !== 'string') claudeEvidenceReject('native_evidence_invalid');
  if (value.config.planning !== undefined && typeof value.config.planning !== 'boolean') claudeEvidenceReject('native_evidence_invalid');
  if (value.config.permissionMode !== undefined && !isResumableClaudePermissionMode(value.config.permissionMode)) claudeEvidenceReject('native_evidence_invalid');
  if (value.config.access !== undefined && value.config.access !== 'read_only') claudeEvidenceReject('native_evidence_invalid');
  return value;
}

interface ClaudeEvidencePorts {
  id: string; cwd: string; options: ClaudeSessionOptions;
  open(): boolean;
  mutable(): boolean;
  counts(): { pendingInteractions: number; activeChildren: number; pendingInput: boolean };
  selections(): AgentPreparedTextInput['selections'];
  messages(): Promise<SessionMessage[]>;
  dispatch(text: string, inputId: ReturnType<typeof randomUUID>): void;
}

/** In-memory native observations and admission fences; durable recovery uses the public transcript. */
export class ClaudeNativeEvidence implements AgentSessionNativeEvidence {
  private revision = 0;
  private initialized = false;
  private nativeState: 'idle' | 'running' | 'requires_action' = 'idle';
  private queuedInputs = 0;
  private backgroundTasks = 0;
  private scheduledTasks = 0;
  /** Only a Stop snapshot lists session crons, so one created or deleted since the last snapshot leaves their count unknown. */
  private scheduledTasksUnconfirmed = false;
  private stopInput?: string;
  private readonly tokens = new WeakMap<AgentNativeValidityToken, number>();
  private prepared?: { id: string; encoded: string; revision: number };
  private dispatched?: { id: string; executionId?: string };
  private readonly authority: AgentNativeAuthorityScope;
  constructor(private readonly ports: ClaudeEvidencePorts) { this.authority = claudeAuthority(ports.id, ports.cwd, ports.options); }
  availability() { return { status: 'configured' as const, version: 2 as const }; }
  initialize(): void { this.initialized = true; this.invalidate(); }
  invalidate(): void { this.revision++; }
  noteDispatch(id: string): void { this.stopInput = undefined; this.nativeState = 'running'; this.queuedInputs = 1; this.dispatched = { id }; this.invalidate(); }
  noteStop(input: StopHookInput): void {
    this.stopInput = undefined; this.invalidate();
    // The main agent's Stop describes this session. Its cwd is the Bash tool's current directory, which a command may have changed.
    if (!this.available() || input.agent_id || input.session_id !== this.ports.id
      || !Array.isArray(input.background_tasks) || !Array.isArray(input.session_crons)) return;
    // Background work and session crons are session state, so a turn Claude started itself, such as a fired cron, reports them too.
    this.backgroundTasks = input.background_tasks.length; this.scheduledTasks = input.session_crons.length; this.scheduledTasksUnconfirmed = false;
    if (this.ports.counts().pendingInput && this.dispatched) this.stopInput = this.dispatched.id;
    this.invalidate();
  }
  noteMessage(message: SDKMessage): boolean {
    if (!this.scheduledTasksUnconfirmed && message.type === 'assistant'
      && message.message.content.some(block => block.type === 'tool_use' && sessionCronTools.has(block.name))) { this.scheduledTasksUnconfirmed = true; this.invalidate(); }
    if ('parent_tool_use_id' in message && message.parent_tool_use_id) return false;
    if (message.type === 'stream_event' || message.type === 'assistant' || message.type === 'system' && message.subtype === 'background_tasks_changed') this.stopInput = undefined;
    if (message.type === 'stream_event' && (message.event.type as string) !== 'ping' || message.type === 'assistant'
      || message.type === 'system' && message.subtype === 'status' && message.status !== null) this.nativeState = 'running';
    let started = false;
    // A turn the model API rejected answers only with an error, and one interrupted before any reply only with its result.
    if ((message.type === 'stream_event' && (message.event.type as string) !== 'ping' || message.type === 'assistant' || message.type === 'result')
      && message.user_message_uuid && message.user_message_uuid === this.dispatched?.id) {
      if (!this.dispatched.executionId) { this.dispatched.executionId = message.uuid; started = true; }
      this.queuedInputs = 0;
    }
    if (message.type === 'system' && message.subtype === 'session_state_changed') {
      if (message.state !== 'idle') this.stopInput = undefined;
      this.nativeState = message.state;
      if (message.state === 'idle') this.queuedInputs = 0;
    }
    if (message.type === 'system' && message.subtype === 'background_tasks_changed') this.backgroundTasks = message.tasks.filter(task => !task.ambient).length;
    if (message.type === 'result' && message.user_message_uuid === this.dispatched?.id && message.queued_turn_count !== undefined) {
      this.queuedInputs = message.queued_turn_count;
      if (this.stopInput === message.user_message_uuid && message.queued_turn_count === 0 && !this.ports.counts().pendingInteractions) this.nativeState = 'idle';
      this.stopInput = undefined;
    }
    this.invalidate();
    return started;
  }
  private available(): boolean { return this.initialized && this.ports.open(); }
  private ready(): AgentNativeReadiness {
    const counts = this.ports.counts();
    return { cwd: this.ports.cwd, idle: this.nativeState === 'idle' && this.ports.mutable(),
      pendingInputs: Math.max(this.queuedInputs, counts.pendingInput ? 1 : 0), pendingInteractions: counts.pendingInteractions,
      activeChildren: Math.max(this.backgroundTasks, counts.activeChildren) + (this.scheduledTasksUnconfirmed ? Math.max(this.scheduledTasks, 1) : this.scheduledTasks) };
  }
  async inspectReadiness(): Promise<AgentNativeReadiness> { if (!this.available()) claudeEvidenceReject('native_evidence_unavailable'); return this.ready(); }
  captureValidity(): AgentNativeValidityToken {
    if (!this.available() || !this.ports.mutable()) claudeEvidenceReject('native_evidence_stale');
    const token = Object.freeze(Object.create(null)) as AgentNativeValidityToken; this.tokens.set(token, this.revision); return token;
  }
  isCurrent(token: AgentNativeValidityToken): boolean { return this.available() && this.ports.mutable() && this.tokens.get(token) === this.revision; }
  async prepareInput(parts: readonly AgentInputPart[], options?: AgentMessageOptions): Promise<AgentPreparedTextInput> {
    if (!Array.isArray(parts) || parts.length !== 1) claudeEvidenceReject('native_evidence_unsupported');
    const item = Object.getOwnPropertyDescriptor(parts, '0');
    if (!item || !('value' in item) || !item.value || Object.getOwnPropertySymbols(item.value).length) claudeEvidenceReject('native_evidence_invalid');
    const fields = Object.getOwnPropertyDescriptors(item.value);
    if (Object.keys(fields).sort().join(',') !== 'text,type' || Object.values(fields).some(field => !('value' in field))) claudeEvidenceReject('native_evidence_invalid');
    const text = fields.text!.value;
    if (fields.type!.value !== 'text' || typeof text !== 'string' || !text.trim()) claudeEvidenceReject('native_evidence_unsupported');
    if (options !== undefined && (Object.getOwnPropertySymbols(options).length || Object.keys(options).some(key => key !== 'delivery')
      || Object.values(Object.getOwnPropertyDescriptors(options)).some(field => !('value' in field)) || options.delivery !== undefined && options.delivery !== 'immediate')) claudeEvidenceReject('native_evidence_unsupported');
    this.captureValidity();
    const ready = this.ready();
    if (!ready.idle || ready.pendingInputs || ready.pendingInteractions || ready.activeChildren) claudeEvidenceReject('native_evidence_admission');
    const selections = { ...this.ports.selections(), ...(options?.delivery === 'immediate' ? { delivery: 'immediate' as const } : {}) };
    const input: AgentPreparedTextInput = { version: 2, providerId: 'claude', nativeSessionId: this.ports.id, inputId: randomUUID(), cwd: this.ports.cwd,
      authority: this.authority, parts: [{ type: 'text', text }], content: { encoding: 'utf-8', bytes: Buffer.byteLength(text), sha256: hash(text) }, selections };
    const encoded = serializeAgentPreparedTextInput(input);
    this.prepared = { id: input.inputId, encoded, revision: this.revision };
    return parseAgentPreparedTextInput(encoded);
  }
  async dispatchInput(input: AgentPreparedTextInput): Promise<void> {
    const encoded = serializeAgentPreparedTextInput(input), witness = parseAgentPreparedTextInput(encoded);
    this.matches(witness);
    const prepared = this.prepared;
    const { delivery: _delivery, ...selections } = witness.selections;
    if (!this.available() || !prepared || prepared.id !== witness.inputId || prepared.encoded !== encoded || prepared.revision !== this.revision
      || !same(selections, this.ports.selections())) claudeEvidenceReject('native_evidence_stale');
    const ready = this.ready();
    if (!ready.idle || ready.pendingInputs || ready.pendingInteractions || ready.activeChildren) claudeEvidenceReject('native_evidence_admission');
    this.prepared = undefined;
    this.ports.dispatch(witness.parts[0].text, witness.inputId as ReturnType<typeof randomUUID>);
  }
  private matches(witness: AgentPreparedTextInput): void {
    if (witness.providerId !== 'claude' || witness.nativeSessionId !== this.ports.id || witness.cwd !== this.ports.cwd || !same(witness.authority, this.authority)) claudeEvidenceReject('native_evidence_stale');
  }
  async inspectInput(input: AgentPreparedTextInput): Promise<AgentInputMaterialization> {
    const witness = parseAgentPreparedTextInput(serializeAgentPreparedTextInput(input));
    try { this.matches(witness); } catch { return unknown('native_evidence_readback_mismatch'); }
    if (!this.available()) return unknown('native_evidence_unavailable');
    try {
      const records = await this.ports.messages();
      if (!this.available()) return unknown('native_evidence_stale');
      const matches = records.filter(row => row.uuid === witness.inputId);
      if (!matches.length) return unknown('native_evidence_readback_missing');
      if (matches.length !== 1) return unknown('native_evidence_readback_mismatch');
      const row = matches[0]!, message = row.message as { role?: unknown; content?: unknown } | null;
      if (row.type !== 'user' || row.session_id !== witness.nativeSessionId || row.parent_tool_use_id !== null || message?.role !== 'user'
        || message.content !== witness.parts[0].text) return unknown('native_evidence_readback_mismatch');
      const { delivery: _delivery, ...selections } = witness.selections;
      // The exact caller UUID binds this native record to the pre-dispatch frozen request.
      // Public transcript rows do not expose historical settings or reply correlation.
      const materialized: AgentInputMaterialization = { status: 'materialized', proof: { version: 2, providerId: 'claude', nativeSessionId: witness.nativeSessionId,
        inputId: witness.inputId, nativeInputId: row.uuid, cwd: witness.cwd, authority: witness.authority,
        witnessSha256: hash(serializeAgentPreparedTextInput(witness)), contentSha256: witness.content.sha256, nativeSelectionsSha256: hash(canonical(selections)) } };
      if (this.dispatched?.id === witness.inputId && this.dispatched.executionId) materialized.execution = { disposition: 'started', nativeExecutionId: this.dispatched.executionId };
      return parseAgentInputMaterialization(serializeAgentInputMaterialization(materialized));
    } catch { return unknown('native_evidence_readback_failed'); }
  }
}
