import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  AGENT_NATIVE_EVIDENCE_REASONS as reasons, AgentNativeEvidenceOutcomeUnknownError, AgentOperationRejectedError,
  parseAgentPreparedTextInput, serializeAgentPreparedTextInput, parseAgentInputMaterialization, serializeAgentInputMaterialization,
  serializeAgentEmptyCreationResult,
  type AgentEmptyCreationResult, type AgentEmptySessionConfig, type AgentInputAcceptance, type AgentInputMaterialization,
  type AgentInputPart, type AgentMessageOptions, type AgentNativeAuthorityScope, type AgentNativeEvidenceCode,
  type AgentNativeReadiness, type AgentNativeValidityToken, type AgentPersistenceHandle, type AgentPreparedTextInput,
  type AgentProviderNativeEvidence, type AgentSessionNativeEvidence,
} from '@orchardworks/agent-provider-sdk';
import { CodexAppServerRpcError, type CodexAppServerTransport } from './app-server-transport.js';
import { initializeCodexTransport } from './initialize.js';
import { isRecord, readString } from './native.js';

const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
export function codexEvidenceJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => isRecord(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
function reject(code: AgentNativeEvidenceCode): never { throw new AgentOperationRejectedError(code, reasons[code]); }
function unknown(code: AgentNativeEvidenceCode): AgentInputMaterialization & { status: 'unknown' } { return { status: 'unknown', code, reason: reasons[code] }; }
const same = (first: unknown, second: unknown) => codexEvidenceJson(first) === codexEvidenceJson(second);

export interface CodexEvidenceSettings {
  model: string;
  modelProvider: string;
  reasoningEffort?: string;
  approvalPolicy: unknown;
  sandboxPolicy: Record<string, unknown>;
}
export type CodexEvidenceSource = CodexEvidenceSettings & { systemPrompt?: string; instructions?: string; collaborationMode?: 'plan' };
export function codexEvidenceAuthority(home: string): AgentNativeAuthorityScope {
  return Object.freeze({ kind: 'owned-runtime', authorityId: 'codex-app-server', namespaceId: hash(resolve(home)) });
}
export function readCodexEvidenceSettings(value: unknown, previous?: CodexEvidenceSettings): CodexEvidenceSettings | undefined {
  if (!isRecord(value)) return previous;
  const thread = isRecord(value.thread) ? value.thread : {};
  const values = { ...thread, ...value };
  const model = readString(values.model) ?? previous?.model;
  const modelProvider = readString(values.modelProvider) ?? previous?.modelProvider;
  const approvalPolicy = values.approvalPolicy ?? previous?.approvalPolicy;
  const sandboxPolicy = values.sandboxPolicy ?? values.sandbox ?? previous?.sandboxPolicy;
  const effort = Object.hasOwn(values, 'effort') ? values.effort : Object.hasOwn(values, 'reasoningEffort') ? values.reasoningEffort : previous?.reasoningEffort;
  if (!model || !modelProvider || !(typeof approvalPolicy === 'string' || isRecord(approvalPolicy))
    || !isRecord(sandboxPolicy) || !readString(sandboxPolicy.type)) return;
  return structuredClone({ model, modelProvider, ...(readString(effort) ? { reasoningEffort: readString(effort) } : {}), approvalPolicy, sandboxPolicy });
}
export function codexEvidenceSelection(settings: CodexEvidenceSettings, system?: string, collaborationMode?: Record<string, unknown>): AgentPreparedTextInput['selections'] {
  return { model: settings.model, ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
    providerOptions: codexEvidenceJson({ modelProvider: settings.modelProvider, approvalPolicy: settings.approvalPolicy, sandboxPolicy: settings.sandboxPolicy,
      ...(collaborationMode ? { collaborationMode } : {}) }),
    ...(system ? { system } : {}) };
}
export function codexEvidenceTurnSettings(witness: AgentPreparedTextInput): Record<string, unknown> {
  let options: unknown;
  try { options = JSON.parse(witness.selections.providerOptions ?? 'null'); } catch { reject('native_evidence_invalid'); }
  if (!isRecord(options) || !readString(options.modelProvider) || !isRecord(options.sandboxPolicy)
    || !(typeof options.approvalPolicy === 'string' || isRecord(options.approvalPolicy))
    || options.collaborationMode !== undefined && !isRecord(options.collaborationMode)) reject('native_evidence_invalid');
  return { model: witness.selections.model, ...(witness.selections.reasoningEffort ? { effort: witness.selections.reasoningEffort } : {}),
    approvalPolicy: options.approvalPolicy, sandboxPolicy: options.sandboxPolicy,
    ...(options.collaborationMode ? { collaborationMode: options.collaborationMode } : {}) };
}
export async function updateCodexEvidenceSettings(
  transport: Pick<CodexAppServerTransport, 'request'>,
  nativeId: string,
  expected: CodexEvidenceSettings,
  subscribe: (listener: (settings: CodexEvidenceSettings) => void) => () => void,
): Promise<CodexEvidenceSettings> {
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const confirmation = new Promise<CodexEvidenceSettings>((resolve, reject) => {
    unsubscribe = subscribe(settings => { if (same(settings, expected)) resolve(structuredClone(settings)); });
    timer = setTimeout(() => reject(new AgentOperationRejectedError('native_evidence_stale', reasons.native_evidence_stale)), 10000);
  });
  try {
    const [, settings] = await Promise.all([
      transport.request('thread/settings/update', { threadId: nativeId, model: expected.model, effort: expected.reasoningEffort ?? null,
        approvalPolicy: expected.approvalPolicy, sandboxPolicy: expected.sandboxPolicy }), confirmation,
    ]);
    return settings;
  } finally { clearTimeout(timer); unsubscribe(); }
}
function handle(id: string, cwd: string, authority: AgentNativeAuthorityScope, settings?: CodexEvidenceSettings, failed = false,
  extensions?: Pick<CodexEvidenceSource, 'systemPrompt' | 'instructions' | 'collaborationMode'>): AgentPersistenceHandle {
  const result = { providerId: 'codex', sessionId: id, opaque: codexEvidenceJson({ kind: failed ? 'codex.empty-recovery' : 'codex.empty', version: 2,
    cwd, ...extensions, ...(settings ? { model: settings.model, ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}), nativeSettings: settings } : {}), nativeEvidenceAuthority: authority }) };
  serializeAgentEmptyCreationResult({ status: 'created', handle: result });
  return result;
}

export class CodexProviderNativeEvidence implements AgentProviderNativeEvidence {
  constructor(private readonly ports: {
    authority: AgentNativeAuthorityScope;
    allowed(): boolean;
    transport(cwd?: string): Promise<CodexAppServerTransport>;
    sourceSettings(id: string): Promise<CodexEvidenceSource | undefined>;
    diagnostic?(error: unknown): void;
  }) {}
  availability() { return this.ports.allowed() ? { status: 'configured' as const, version: 2 as const }
    : { status: 'unavailable' as const, code: 'native_evidence_unavailable' as const, reason: reasons.native_evidence_unavailable }; }
  async createEmpty(config: AgentEmptySessionConfig): Promise<AgentEmptyCreationResult> {
    if (!this.ports.allowed()) reject('native_evidence_admission');
    if (!config.sessionId || typeof config.sessionId !== 'string') reject('native_evidence_invalid');
    const cwd = await realpath(config.cwd ?? process.cwd()).catch(() => reject('native_evidence_invalid'));
    const selected = config.selectionSourceSessionId ? await this.ports.sourceSettings(config.selectionSourceSessionId) : undefined;
    const source = selected ? readCodexEvidenceSettings(selected) : undefined;
    const extensions = selected ? { ...(selected.systemPrompt !== undefined ? { systemPrompt: selected.systemPrompt } : {}),
      ...(selected.instructions !== undefined ? { instructions: selected.instructions } : {}),
      ...(selected.collaborationMode ? { collaborationMode: selected.collaborationMode } : {}) } : undefined;
    const instructions = [extensions?.systemPrompt, extensions?.instructions].filter(Boolean).join('\n\n');
    if (config.selectionSourceSessionId && !source) reject('native_evidence_unavailable');
    handle('B'.repeat(256), cwd, this.ports.authority, source, false, extensions);
    const transport = await this.ports.transport(cwd);
    let nativeId: string | undefined;
    try {
      await initializeCodexTransport(transport);
      let response = await transport.request('thread/start', { cwd,
        ...(instructions ? { developerInstructions: instructions } : {}),
        ...(source ? { model: source.model, modelProvider: source.modelProvider,
          config: { ...(source.reasoningEffort ? { model_reasoning_effort: source.reasoningEffort } : {}) } } : {}) });
      if (!isRecord(response) || !isRecord(response.thread) || !readString(response.thread.id)) return unknown('native_evidence_identity_unusable');
      nativeId = readString(response.thread.id)!;
      // Retain a usable native identity before any verification can fail.
      handle(nativeId, cwd, this.ports.authority, undefined, true);
      if (await realpath(String(response.thread.cwd ?? response.cwd)) !== cwd || response.thread.parentThreadId != null
        || !Array.isArray(response.thread.turns) || response.thread.turns.length !== 0) reject('native_evidence_invalid');
      let settings = readCodexEvidenceSettings(response);
      if (source && !same(settings, source)) settings = await updateCodexEvidenceSettings(transport, nativeId, source, listener => {
        transport.setNotificationHandler((method, params) => {
          if (method !== 'thread/settings/updated' || !isRecord(params) || params.threadId !== nativeId) return;
          const current = readCodexEvidenceSettings(params.threadSettings, settings);
          if (current) listener(current);
        });
        return () => transport.setNotificationHandler(() => {});
      });
      if (!settings || source && !same(settings, source)) reject('native_evidence_invalid');
      // Reading loaded history materializes the empty thread before the runtime exits.
      // Some native stores persist successfully but do not support listing zero turns.
      try { await transport.request('thread/read', { threadId: nativeId, includeTurns: true }); }
      catch (error) { if (!(error instanceof CodexAppServerRpcError) || error.code !== -32601) throw error; }
      if (transport.child) {
        if (!await closeEmptyProcess(transport)) reject('native_evidence_outcome_unknown');
        const reader = await this.ports.transport(cwd);
        try {
          await initializeCodexTransport(reader);
          const persisted = await reader.request('thread/read', { threadId: nativeId, includeTurns: true });
          if (!isRecord(persisted) || !isRecord(persisted.thread) || persisted.thread.id !== nativeId
            || await realpath(String(persisted.thread.cwd)) !== cwd || !Array.isArray(persisted.thread.turns) || persisted.thread.turns.length) reject('native_evidence_readback_mismatch');
        } finally { await reader.dispose(); }
      }
      return { status: 'created', handle: handle(nativeId, cwd, this.ports.authority, settings, false, extensions) };
    } catch (error) {
      this.ports.diagnostic?.(error);
      if (!nativeId) return unknown('native_evidence_outcome_unknown');
      return { status: 'known_rejected', handle: handle(nativeId, cwd, this.ports.authority, undefined, true), code: 'native_evidence_invalid', reason: reasons.native_evidence_invalid };
    } finally { await transport.dispose(); }
  }
}

/** An empty native thread becomes durable on orderly EOF; never signal a shared daemon. */
async function closeEmptyProcess(transport: CodexAppServerTransport): Promise<boolean> {
  const child = transport.child;
  if (!child) return true;
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode === 0;
  const exited = once(child, 'exit').then(([code]) => code === 0, () => false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 2000); });
  child.stdin.end();
  try { return await Promise.race([exited, timeout]); }
  finally { clearTimeout(timer); }
}

interface SessionPorts {
  authority: AgentNativeAuthorityScope;
  nativeId(): string | undefined;
  cwd(): string | undefined;
  readable(): boolean;
  localReadiness(): Pick<AgentNativeReadiness, 'idle' | 'pendingInputs' | 'pendingInteractions'>;
  selections(): AgentPreparedTextInput['selections'] | undefined;
  request(method: string, params: unknown): Promise<unknown>;
  dispatch(witness: AgentPreparedTextInput): Promise<AgentInputAcceptance | void>;
}
/** Native clientId binds one frozen turn/start request; history never invents per-field settings. */
export class CodexSessionNativeEvidence implements AgentSessionNativeEvidence {
  private revision = 0;
  private baseline = -1;
  private baselineReady = false;
  private readonly tokens = new WeakMap<object, number>();
  private readonly submitted = new Set<string>();
  constructor(private readonly ports: SessionPorts) {}
  availability() { return { status: 'configured' as const, version: 2 as const }; }
  invalidate(): void { this.revision++; this.baseline = -1; this.baselineReady = false; }
  captureValidity(): AgentNativeValidityToken {
    if (!this.ports.readable() || !this.baselineReady || this.baseline !== this.revision || !this.ports.localReadiness().idle) reject('native_evidence_stale');
    const token = Object.freeze({}) as AgentNativeValidityToken; this.tokens.set(token, this.revision); return token;
  }
  isCurrent(token: AgentNativeValidityToken): boolean {
    return !!token && typeof token === 'object' && this.tokens.get(token) === this.revision && this.baselineReady && this.baseline === this.revision
      && this.ports.readable() && this.ports.localReadiness().idle;
  }
  private current(revision: number): boolean { return this.ports.readable() && revision === this.revision; }
  async inspectReadiness(): Promise<AgentNativeReadiness> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.readReadiness(); }
      catch (error) {
        if (!(error instanceof AgentOperationRejectedError) || error.code !== 'native_evidence_stale' || attempt >= 2) throw error;
      }
    }
  }
  private async readReadiness(): Promise<AgentNativeReadiness> {
    if (!this.ports.readable() || !this.ports.nativeId()) reject('native_evidence_unavailable');
    const revision = this.revision;
    const cwd = await realpath(this.ports.cwd() ?? '').catch(() => reject('native_evidence_invalid'));
    const nativeId = this.ports.nativeId()!;
    const response = await this.ports.request('thread/read', { threadId: nativeId, includeTurns: false });
    if (!isRecord(response) || !isRecord(response.thread) || response.thread.id !== nativeId || !isRecord(response.thread.status)
      || !Object.hasOwn(response.thread, 'parentThreadId') || typeof response.thread.canAcceptDirectInput !== 'boolean'
      || await realpath(String(response.thread.cwd)) !== cwd) reject('native_evidence_unsupported');
    const queue = await this.ports.request('thread/queue/list', { threadId: nativeId, limit: 100 });
    if (!isRecord(queue) || !Array.isArray(queue.data) || !Object.hasOwn(queue, 'nextCursor')) reject('native_evidence_unsupported');
    let activeChildren = 0, cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const children = await this.ports.request('thread/list', { ancestorThreadId: nativeId, limit: 100, ...(cursor ? { cursor } : {}),
        modelProviders: [], sourceKinds: ['subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther'] });
      if (!isRecord(children) || !Array.isArray(children.data) || !Object.hasOwn(children, 'nextCursor')) reject('native_evidence_unsupported');
      for (const child of children.data) {
        if (!isRecord(child) || !readString(child.id) || !readString(child.parentThreadId) || !isRecord(child.status)
          || !['idle', 'notLoaded', 'active', 'systemError'].includes(String(child.status.type))) reject('native_evidence_unsupported');
        if (child.status.type !== 'idle' && child.status.type !== 'notLoaded') activeChildren++;
      }
      cursor = readString(children.nextCursor);
      if (cursor && (cursors.has(cursor) || cursors.size >= 20)) reject('native_evidence_limit');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (!this.current(revision)) reject('native_evidence_stale');
    const local = this.ports.localReadiness();
    const status = response.thread.status;
    const idle = local.idle && response.thread.canAcceptDirectInput && status.type === 'idle'
      && (!Array.isArray(status.activeFlags) || status.activeFlags.length === 0);
    const result = { cwd, idle, pendingInputs: local.pendingInputs + queue.data.length + (queue.nextCursor ? 1 : 0), pendingInteractions: local.pendingInteractions, activeChildren };
    this.baseline = revision;
    this.baselineReady = idle && !result.pendingInputs && !result.pendingInteractions && !activeChildren;
    return result;
  }
  private validate(value: AgentPreparedTextInput): AgentPreparedTextInput {
    const witness = parseAgentPreparedTextInput(serializeAgentPreparedTextInput(value));
    if (witness.providerId !== 'codex' || witness.nativeSessionId !== this.ports.nativeId() || !same(witness.authority, this.ports.authority)) reject('native_evidence_stale');
    return witness;
  }
  async prepareInput(parts: readonly AgentInputPart[], options?: AgentMessageOptions): Promise<AgentPreparedTextInput> {
    if (parts.length !== 1 || parts[0]?.type !== 'text' || options && (Object.keys(options).some(key => key !== 'delivery')
      || options.delivery !== undefined && options.delivery !== 'immediate')) reject('native_evidence_unsupported');
    const readiness = await this.inspectReadiness();
    if (!readiness.idle || readiness.pendingInputs || readiness.pendingInteractions || readiness.activeChildren) reject('native_evidence_admission');
    const selections = this.ports.selections(); if (!selections) reject('native_evidence_unsupported');
    const text = parts[0].text;
    const witness: AgentPreparedTextInput = { version: 2, providerId: 'codex', nativeSessionId: this.ports.nativeId()!, inputId: randomUUID(), cwd: readiness.cwd,
      authority: this.ports.authority, parts: [{ type: 'text', text }], content: { encoding: 'utf-8', bytes: Buffer.byteLength(text), sha256: hash(text) },
      selections: { ...selections, ...(options?.delivery ? { delivery: 'immediate' as const } : {}) } };
    return this.validate(witness);
  }
  async dispatchInput(value: AgentPreparedTextInput): Promise<AgentInputAcceptance | void> {
    const witness = this.validate(value);
    if (this.submitted.has(witness.inputId)) reject('native_evidence_admission');
    const readiness = await this.inspectReadiness();
    const { delivery: _delivery, ...selected } = witness.selections;
    if (witness.cwd !== readiness.cwd || !same(selected, this.ports.selections())) reject('native_evidence_stale');
    if (!readiness.idle || readiness.pendingInputs || readiness.pendingInteractions || readiness.activeChildren) reject('native_evidence_admission');
    this.submitted.add(witness.inputId);
    this.invalidate();
    try { return await this.ports.dispatch(witness); }
    catch (error) { if (error instanceof AgentOperationRejectedError) throw error; throw new AgentNativeEvidenceOutcomeUnknownError(); }
  }
  async inspectInput(value: AgentPreparedTextInput): Promise<AgentInputMaterialization> {
    const witness = this.validate(value);
    if (!this.ports.readable()) return unknown('native_evidence_unavailable');
    try {
      const response = await this.ports.request('thread/read', { threadId: witness.nativeSessionId, includeTurns: false });
      if (!this.ports.readable() || !isRecord(response) || !isRecord(response.thread) || response.thread.id !== witness.nativeSessionId
        || await realpath(String(response.thread.cwd)) !== witness.cwd) return unknown('native_evidence_readback_mismatch');
      const matches: Array<{ item: Record<string, unknown>; turn: Record<string, unknown> }> = [];
      let cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        const page = await this.ports.request('thread/turns/list', { threadId: witness.nativeSessionId, limit: 100, itemsView: 'full',
          sortDirection: 'asc', ...(cursor ? { cursor } : {}) });
        if (!this.ports.readable() || !isRecord(page) || !Array.isArray(page.data) || !Object.hasOwn(page, 'nextCursor')
          || page.data.length > 100) return unknown('native_evidence_readback_failed');
        for (const turn of page.data) {
          if (!isRecord(turn) || !Array.isArray(turn.items)) return unknown('native_evidence_readback_failed');
          if (turn.items.length > 10000) return unknown('native_evidence_limit');
          for (const item of turn.items) if (isRecord(item) && item.type === 'userMessage' && item.clientId === witness.inputId) matches.push({ item, turn });
        }
        if (matches.length > 1) return unknown('native_evidence_readback_mismatch');
        cursor = readString(page.nextCursor);
        if (cursor && (cursors.has(cursor) || cursors.size >= 19)) return unknown('native_evidence_limit');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      if (matches.length !== 1) return unknown(matches.length ? 'native_evidence_readback_mismatch' : 'native_evidence_readback_missing');
      const { item, turn } = matches[0]!;
      if (!readString(item.id) || !readString(turn.id) || !Array.isArray(item.content) || item.content.length !== 1
        || !isRecord(item.content[0]) || item.content[0].type !== 'text' || item.content[0].text !== witness.parts[0].text
        || !['inProgress', 'completed', 'interrupted', 'failed'].includes(String(turn.status))) return unknown('native_evidence_readback_mismatch');
      const { delivery: _delivery, ...selections } = witness.selections;
      return parseAgentInputMaterialization(serializeAgentInputMaterialization({ status: 'materialized', proof: { version: 2, providerId: 'codex',
        nativeSessionId: witness.nativeSessionId, inputId: witness.inputId, nativeInputId: item.id as string, cwd: witness.cwd, authority: witness.authority,
        witnessSha256: hash(serializeAgentPreparedTextInput(witness)), contentSha256: witness.content.sha256, nativeSelectionsSha256: hash(codexEvidenceJson(selections)) },
        execution: { disposition: 'started', nativeExecutionId: turn.id as string } }));
    } catch (error) { return unknown(error instanceof CodexAppServerRpcError ? 'native_evidence_readback_failed' : 'native_evidence_readback_mismatch'); }
  }
}
