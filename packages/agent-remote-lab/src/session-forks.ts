import { nativeSessionRefKey, serializeNormalizedHistory, quotedSessionContextPrefix } from '@orchardworks/agent-remote-protocol';
import type { SessionRelation } from '@orchardworks/agent-remote-hosted/session-relations';
import { conversationLocalStorage } from './conversation-storage.js';
import type { AgentSessionSetting, ProjectedTimelineEntry, TimelineCursor } from '@orchardworks/agent-remote-protocol';
import type { AgentReplicaState, RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { RemoteOperationError } from '@orchardworks/agent-remote-web';
import type { CreateSessionOptions, OpenedSession } from './directory-client.js';
import { sessionKey } from './session-tree.js';

export interface SnapshotForkContext {
  mode?: 'snapshot';
  source: OpenedSession;
  capturedAt: string;
  boundary: TimelineCursor;
  itemCount: number;
  text: string;
  shortenedToolCount?: number;
}
export interface SourceReferenceContext { mode: 'reference'; source: OpenedSession; capturedAt: string }
export type ForkContext = SnapshotForkContext | SourceReferenceContext;
export type SessionFork = ForkContext & ForkDelivery;
interface ForkDelivery {
  /** Shared navigation only; this browser does not own the creation or first-input ledger. */
  remote?: boolean;
  nativeSourceRef?: import('@orchardworks/agent-remote-protocol').NativeSessionRef;
  sourceBinding?: import('@orchardworks/agent-remote-protocol').SourceBinding;
  roleRevision?: number;
  relationOperation?: SessionRelation['operation'];
  hostLocator?: SessionRelation['hostLocator'];
  /** Effective shared source for ordinary navigation; never delivery provenance. */
  currentSource?: OpenedSession;
  /** Authorized prompt-edit follow target; separate from the original delivery recipient. */
  currentTarget?: OpenedSession;
  navigationSource?: SessionRelation['navigationSource'];
  relationEditPending?: boolean;
  /** Navigation can be detached without changing provenance or first-input delivery. */
  linked?: boolean;
  revision?: number;
  /** The shared relation can have a different identity from an older local delivery record. */
  relationId?: string;
  id: string;
  target?: OpenedSession;
  configured?: boolean;
  pendingInput?: string;
  firstInput?: string;
  pendingInputIdentity?: string;
  firstInputIdentity?: string;
  creationKey?: string;
  delivery: 'pending' | 'uncertain' | 'sent';
  options: CreateSessionOptions;
  settings: Pick<AgentSessionSetting, 'id' | 'value'>[];
}
const MAX_CONTEXT_ENTRIES = 20_000;
interface ForkNavigationIdentity { hostId: string; controllerId: string; target: string; relationId: string; originalSource: string }
interface ForkNavigation { source: string; controllerId?: string; linked: boolean; revision: number; relationId?: string; editedTarget?: OpenedSession; identity?: ForkNavigationIdentity }

/** A single projection freezes lifecycle updates together with their original entries. */
export async function captureForkContext(transport: Pick<RemoteAgentTransport, 'fetchTimeline'>, source: OpenedSession): Promise<SnapshotForkContext> {
  const signal = AbortSignal.timeout(30_000);
  const page = (await transport.fetchTimeline(source.agentId, 'tail', undefined, MAX_CONTEXT_ENTRIES, { signal })).payload;
  if (page.reset || page.staleCursor || page.gap || page.error) throw new Error('Source history changed during capture. Try the fork again.');
  if (page.hasOlder) throw new Error('The source history could not be fully captured in one snapshot.');
  const boundary = { epoch: page.epoch, seq: page.window.maxSeq };
  const { text, itemCount, shortenedToolCount } = serializeNormalizedHistory(page.entries, Number.POSITIVE_INFINITY);
  return { source: { ...source }, capturedAt: new Date().toISOString(), boundary, itemCount, text, ...(shortenedToolCount ? { shortenedToolCount } : {}) };
}

export function referenceForkContext(source: OpenedSession): SourceReferenceContext {
  return { mode: 'reference', source: { ...source }, capturedAt: new Date().toISOString() };
}

export function contextPrefix(record: SessionFork): string {
  if (record.mode === 'reference') return `<source-session-reference>${JSON.stringify({ id: record.remote ? record.relationId ?? record.id : record.id, sourceSession: record.remote ? record.nativeSourceRef?.nativeSessionId ?? record.source.nativeSessionId : record.source.nativeSessionId })}</source-session-reference>\n\n`;
  return quotedSessionContextPrefix({ ...record, sourceSession: record.source.nativeSessionId }, false);
}

export function forkDisplayState(state: AgentReplicaState | undefined, record?: SessionFork): AgentReplicaState | undefined {
  if (!state || !record) return state;
  const prefix = contextPrefix(record);
  return { ...state, timeline: { ...state.timeline, entries: state.timeline.entries.map((entry): ProjectedTimelineEntry =>
    (entry.item.type === 'user_message' || entry.item.type === 'assistant_message') && entry.item.text.includes(prefix)
      ? { ...entry, item: { ...entry.item, text: entry.item.text.replace(prefix, ''), ...(entry.item.type === 'user_message' && entry.item.content ? { content: entry.item.content.map(part => part.type === 'text' ? { ...part, text: part.text.replace(prefix, '') } : part) } : {}) } } : entry) } };
}

/** Local creation/delivery ledger with an independent shared navigation overlay. */
export class ForkStore {
  private readonly key: string;
  private readonly navigationKey: string;
  private shared = new Map<string, SessionFork>();
  private readonly listeners = new Set<() => void>();
  private readonly storage?: Storage;
  constructor(baseUrl: string, storage?: Storage) {
    this.key = `agent-remote-forks:${baseUrl}:record:`;
    this.navigationKey = `agent-remote-forks:${baseUrl}:navigation:`;
    try { this.storage = storage ?? conversationLocalStorage; } catch { /* Normal conversations remain usable when storage is unavailable. */ }
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    const refresh = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(this.key) || event.key.startsWith(this.navigationKey)) listener();
    };
    window.addEventListener('storage', refresh);
    return () => { this.listeners.delete(listener); window.removeEventListener('storage', refresh); };
  }
  /** Concrete local creation and input records, without shared navigation projection. */
  allLocal(): readonly SessionFork[] {
    const records: SessionFork[] = [];
    try {
      for (let index = 0; index < (this.storage?.length ?? 0); index += 1) {
        const key = this.storage!.key(index);
        if (!key?.startsWith(this.key)) continue;
        const value: unknown = JSON.parse(this.storage!.getItem(key) ?? 'null');
        if (validRecord(value) && !value.remote) records.push(value);
      }
    } catch { /* Ordinary navigation remains available without browser storage. */ }
    return records.sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
  }
  getLocal(id: string): SessionFork | undefined {
    try {
      const value: unknown = JSON.parse(this.storage?.getItem(this.key + id) ?? 'null');
      if (validRecord(value) && !value.remote) return value;
    } catch { /* Shared navigation remains usable without browser persistence. */ }
  }
  /** Native effects require a successful raw read; read failures never prove absence. */
  getLocalForEffect(id: string): SessionFork | undefined {
    try {
      if (!this.storage) throw new Error('Storage unavailable');
      const stored = this.storage.getItem(this.key + id);
      if (stored === null) return;
      const value: unknown = JSON.parse(stored);
      if (validRecord(value) && !value.remote) return value;
    } catch { /* Report the same recoverable delivery error for unavailable or invalid storage. */ }
    throw new Error('The fork context is unavailable. Restore browser storage before sending again.');
  }
  all(): readonly SessionFork[] {
    const local = this.allLocal();
    const matched = new Set(local.flatMap(record => { const relation = this.sharedFor(record); return relation ? [relation.id] : []; }));
    const records = [...local.map(record => this.withSharedNavigation(record)), ...[...this.shared.values()].filter(record => !matched.has(record.id)).map(record => this.withEditedNavigation(record))];
    return records.sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
  }
  linked(): readonly SessionFork[] { return this.all().filter(record => sideLinkVisible(record)); }
  setSharedRelations(relations: readonly SessionRelation[]): void {
    const previous = new Map([...this.shared.values()].map(record => [record.id, record]));
    const local = this.allLocal();
    const records = relations.map((relation): SessionFork => {
      const record: SessionFork = { id: relationViewKey(relation), relationId: relation.id, mode: 'reference', source: relation.source, target: relation.target,
        navigationSource:relation.navigationSource,hostLocator:relation.hostLocator,nativeSourceRef:relation.nativeSourceRef,sourceBinding:relation.sourceBinding,roleRevision:relation.roleRevision,relationOperation:relation.operation,
        capturedAt: relation.createdAt, remote: true, linked: relation.linked !== false, revision: relation.revision ?? 0,
        delivery: 'pending', options: { sourceNativeSessionId: relation.nativeSourceRef?.nativeSessionId ?? relation.source.nativeSessionId }, settings: [] };
      const earlier = previous.get(record.id);
      const stored = this.readNavigation(record);
      for (const navigation of [earlier && (earlier.relationId===record.relationId || sessionKey(earlier.source)===sessionKey(record.source)) ? earlier : undefined, stored]) {
        if (navigation && ((navigation.revision ?? 0) > record.revision! || navigation === earlier && (navigation.revision ?? 0) === record.revision && (earlier.roleRevision ?? 0) > (record.roleRevision ?? 0))) {
          record.linked = navigation.linked !== false; record.revision = navigation.revision ?? 0;
          if (navigation===earlier) {record.source=earlier!.source;record.sourceBinding=earlier!.sourceBinding;record.nativeSourceRef=earlier!.nativeSourceRef;record.roleRevision=earlier!.roleRevision;record.relationOperation=earlier!.relationOperation;}
        }
      }
      const phase = (operation: SessionRelation['operation']) => operation ? ['reserved','metadata_committed','overlay_applied','committed'].indexOf(operation.phase) : -1;
      if (earlier && earlier.id===record.id && earlier.revision===record.revision && earlier.roleRevision===record.roleRevision
        && earlier.relationOperation?.operationId===record.relationOperation?.operationId && phase(earlier.relationOperation)>phase(record.relationOperation)) {
        record.relationOperation=earlier.relationOperation;
      }
      return record;
    });
    if (JSON.stringify([...this.shared.values()]) === JSON.stringify(records)) return;
    this.shared = new Map(records.map(record => [record.id, record]));
    for (const delivery of local) {
      const relation = this.sharedFor(delivery);
      if (!relation) continue;
      const stored = this.readNavigation(delivery);
      if (stored && stored.revision > (relation.revision ?? 0)) continue;
      try { this.saveNavigation({ ...delivery, hostLocator: relation.hostLocator, relationId: relation.relationId }, relation.linked !== false, relation.revision ?? 0); }
      catch { /* Shared navigation remains available when persistence is denied. */ }
    }
    for (const listener of this.listeners) listener();
  }
  get(id: string): SessionFork {
    const local = this.getLocal(id);
    if (local) return this.withSharedNavigation(local);
    if (this.shared.has(id)) return this.withEditedNavigation(this.shared.get(id)!);
    const matches = [...this.shared.values()].filter(record => record.relationId === id);
    if (matches.length === 1) return this.withEditedNavigation(matches[0]!);
    throw new Error('The fork context is unavailable.');
  }
  private sharedFor(record: SessionFork): SessionFork | undefined {
    const knownNavigation = this.readNavigation(record);
    const matches = [...this.shared.values()].filter(relation => deliveryMatchesRelation(record, relation)
      && (!knownNavigation?.controllerId || relation.hostLocator?.controllerId === knownNavigation.controllerId));
    return matches.length === 1 ? matches[0] : undefined;
  }
  private withSharedNavigation(record: SessionFork): SessionFork {
    const relation = this.sharedFor(record);
    const stored = this.readNavigation(record);
    const navigation = relation && (!stored || (relation.revision ?? 0) >= stored.revision) ? relation : stored;
    return navigation ? { ...record, ...(relation ? { currentSource: relation.source, navigationSource: relation.navigationSource,
      hostLocator: relation.hostLocator, nativeSourceRef: relation.nativeSourceRef, sourceBinding: relation.sourceBinding,
      roleRevision: relation.roleRevision, relationOperation: relation.relationOperation, relationEditPending: relation.relationEditPending } : {}),
      relationId: navigation.relationId, linked: navigation.linked !== false, revision: navigation.revision ?? 0,
      ...(stored?.editedTarget ? { currentTarget: stored.editedTarget } : {}) } : record;
  }
  private withEditedNavigation(record: SessionFork): SessionFork {
    const editedTarget = this.readNavigation(record)?.editedTarget;
    return editedTarget ? { ...record, currentTarget: editedTarget } : record;
  }
  /** Follow a confirmed prompt-edit sibling without changing creation/input ownership. */
  followEditedSide(id: string, from: OpenedSession, target: OpenedSession): void {
    const record = this.get(id);
    const source = sideNavigationTarget(record);
    if (!source || sessionKey(source) !== sessionKey(from)) throw new Error('The side navigation changed. Refresh before following the edit.');
    if ((from.hostId ?? 'local') !== (target.hostId ?? 'local') || from.providerId !== target.providerId) throw new Error('The edited side must retain its Host and provider.');
    this.saveNavigation(record, record.linked !== false, record.revision ?? 0, target);
    for (const listener of this.listeners) listener();
  }
  private readNavigation(record: SessionFork): ForkNavigation | undefined {
    if (!record.target) return;
    try {
      const value = JSON.parse(this.storage?.getItem(this.navigationKey + sessionKey(record.target)) ?? 'null') as ForkNavigation | null;
      const identity = navigationIdentity(record);
      const sameScope = value?.identity !== undefined
        ? !!identity && sameNavigationIdentity(value.identity, identity) && value.controllerId === identity.controllerId && value.relationId === identity.relationId
        : value?.source === sessionKey(record.source) && (!record.hostLocator || value.controllerId === record.hostLocator.controllerId)
          && (!record.remote || value.relationId === record.relationId);
      if (value && typeof value.source === 'string' && sameScope && typeof value.linked === 'boolean'
        && Number.isSafeInteger(value.revision) && value.revision >= 0
        && (value.relationId === undefined || typeof value.relationId === 'string')
        && (value.editedTarget === undefined || validEditedTarget(value.editedTarget, record.target))) return value;
    } catch { /* Shared in-memory navigation remains available when persistence is denied. */ }
  }
  private saveNavigation(record: SessionFork, linked: boolean, revision: number, editedTarget = this.readNavigation(record)?.editedTarget): void {
    if (!record.target || !this.storage) throw new Error('The side link could not be saved. Free browser storage before continuing.');
    const key = this.navigationKey + sessionKey(record.target);
    const identity = record.remote ? navigationIdentity(record) : undefined;
    const value: ForkNavigation = { ...(identity ? { identity } : {}), source: sessionKey(record.source), ...(record.hostLocator?{controllerId:record.hostLocator.controllerId}:{}), linked, revision, relationId: record.relationId, ...(editedTarget ? { editedTarget } : {}) };
    try { if (this.storage.getItem(key) !== JSON.stringify(value)) this.storage.setItem(key, JSON.stringify(value)); }
    catch { throw new Error('The side link could not be saved. Free browser storage before continuing.'); }
  }
  setRelationEditPending(id: string, pending: boolean): void {
    const local = this.getLocal(id);
    const matches = [...this.shared.values()].filter(item => item.relationId === id);
    const record = local ? this.sharedFor(local) : this.shared.get(id) ?? (matches.length === 1 ? matches[0] : undefined);
    if (!record || !!record.relationEditPending === pending) return;
    this.shared.set(record.id,{...record,relationEditPending:pending});
    for (const listener of this.listeners) listener();
  }
  setLinked(id: string, linked: boolean, expectedRevision = 0): void {
    const record = this.get(id);
    if (record.remote) throw new Error('Shared side links must be changed through the server.');
    if ((record.revision ?? 0) !== expectedRevision) throw new Error('The side link changed. Refresh before trying again.');
    if ((record.linked !== false) === linked) return;
    this.saveNavigation(record, linked, expectedRevision + 1);
    for (const listener of this.listeners) listener();
  }
  find(session?: Pick<OpenedSession, 'hostId' | 'providerId' | 'nativeSessionId'>): SessionFork | undefined {
    return session ? this.all().find((record) => record.target && sessionKey(record.target) === sessionKey(session)) : undefined;
  }
  findNavigationTarget(session: Pick<OpenedSession, 'hostId' | 'providerId' | 'nativeSessionId'>): SessionFork | undefined {
    const matches = this.all().filter(record => sideNavigationTarget(record) && sessionKey(sideNavigationTarget(record)!) === sessionKey(session));
    return matches.length === 1 ? matches[0] : undefined;
  }
  prepare(context: ForkContext, options: CreateSessionOptions = {}, settings: SessionFork['settings'] = [], creationKey?: string): SessionFork {
    const record: SessionFork = { ...context, id: crypto.randomUUID(), delivery: 'pending', options, settings, creationKey };
    this.save(record);
    return record;
  }
  finishCreation(id: string): void { this.update(id, { creationKey: undefined }); }
  markConfigured(id: string, requireLocal = false): void { this.update(id, { configured: true }, requireLocal); }
  bind(id: string, target: OpenedSession): void {
    let record: SessionFork | undefined;
    try { record = this.getLocalForEffect(id); }
    catch (error) {
      const remote = this.shared.get(id);
      if (!remote?.remote || !id.startsWith('relation:') || !navigationIdentity(remote)) throw error;
      record = remote;
    }
    record ??= this.get(id);
    if (record.target && sessionKey(record.target) !== sessionKey(target)) throw new Error('The fork target changed. Open its original session before continuing.');
    if (!record.remote) { this.update(id, { target }, true); return; }
    this.shared.set(record.id, { ...record, target });
    for (const listener of this.listeners) listener();
  }
  private update(id: string, change: Partial<ForkDelivery>, requireLocal = false): void {
    const record = this.getLocalForEffect(id);
    if (record) this.save({ ...record, ...change });
    else if (requireLocal) throw new Error('The fork context is unavailable.');
    else this.get(id);
  }
  private save(record: SessionFork): void {
    try { if (!this.storage) throw new Error('Storage unavailable'); this.storage.setItem(this.key + record.id, JSON.stringify(record)); }
    catch { throw new Error('The fork context could not be saved. Free browser storage before continuing.'); }
    for (const listener of this.listeners) listener();
  }
  async send<T>(id: string, text: string, send: (input: string) => Promise<T>, delivered: () => Promise<boolean>, identity = text, requireLocal = false): Promise<T | undefined> {
    const record = this.getLocalForEffect(id);
    if (!record) {
      if (requireLocal || !this.get(id).remote) throw new Error('The fork context is unavailable.');
      return send(text);
    }
    const started = record.delivery;
    const run = () => {
      const latest = this.getLocalForEffect(id);
      if (!latest) throw new Error('The fork context is unavailable.');
      if (started !== 'sent' && latest.delivery === 'sent' && (latest.firstInputIdentity ?? latest.firstInput) === identity) return Promise.resolve(undefined);
      return this.sendInput(id, text, send, delivered, identity);
    };
    return globalThis.navigator?.locks ? navigator.locks.request(this.key + id, { signal: AbortSignal.timeout(30_000) }, run) : run();
  }
  private async sendInput<T>(id: string, text: string, send: (input: string) => Promise<T>, delivered: () => Promise<boolean>, identity = text): Promise<T | undefined> {
    let record = this.getLocalForEffect(id);
    if (!record) throw new Error('The fork context is unavailable.');
    if (record.delivery === 'uncertain') {
      if (!await delivered()) throw new Error('The first input has an unknown delivery status. Reconnect and check its native history before sending again.');
      const sameInput = (record.pendingInputIdentity ?? record.pendingInput) === identity;
      this.update(id, { delivery: 'sent', pendingInput: undefined }, true);
      if (sameInput) return undefined;
      record = this.getLocalForEffect(id);
      if (!record) throw new Error('The fork context is unavailable.');
    }
    if (record.delivery === 'sent') return send(text);
    this.update(id, { delivery: 'uncertain', pendingInput: text, firstInput: text, pendingInputIdentity: identity, firstInputIdentity: identity }, true);
    try {
      const result = await send(contextPrefix(record) + text);
      this.update(id, { delivery: 'sent', pendingInput: undefined }, true);
      return result;
    } catch (error) {
      if (error instanceof RemoteOperationError && ['session_changed', 'invalid_request', 'invalid_image_input', 'unsupported_capability', 'agent_busy', 'invalid_command', 'invalid_session_setting'].includes(error.code)) {
        this.update(id, { delivery: 'pending' }, true);
      }
      throw error;
    }
  }
}
function validRecord(value: unknown): value is SessionFork {
  if (!value || typeof value !== 'object') return false;
  const record = value as SessionFork;
  if (typeof record.id !== 'string' || typeof record.capturedAt !== 'string' || !record.source
    || typeof record.source.nativeSessionId !== 'string' || !record.options
    || !['pending', 'uncertain', 'sent'].includes(record.delivery) || !Array.isArray(record.settings)) return false;
  if (record.linked !== undefined && typeof record.linked !== 'boolean'
    || record.revision !== undefined && (!Number.isSafeInteger(record.revision) || record.revision < 0)) return false;
  if (record.mode === 'reference') return record.options.sourceNativeSessionId === record.source.nativeSessionId;
  if (record.mode !== undefined && record.mode !== 'snapshot') return false;
  if (typeof record.text !== 'string' || !record.boundary || typeof record.boundary.epoch !== 'string' || !Number.isSafeInteger(record.boundary.seq)) return false;
  try { return Array.isArray(JSON.parse(record.text)); } catch { return false; }
}

/** Local view identity never replaces the protocol relation or native delivery identity. */
function relationViewKey(relation: SessionRelation): string {
  return relation.hostLocator ? `relation:${JSON.stringify([relation.hostLocator.hostId,relation.hostLocator.controllerId,relation.target.providerId,relation.target.nativeSessionId,relation.id])}` : relation.id;
}
export function sideLinkPending(record: SessionFork): boolean {
  return !!record.relationEditPending || !!record.relationOperation && record.relationOperation.phase !== 'committed';
}
export function sideLinkVisible(record: SessionFork): boolean { return record.linked !== false || sideLinkPending(record); }

export function currentForkSource(record: SessionFork): OpenedSession { return record.currentSource ?? record.source; }
export function sideNavigationSource(record: SessionFork): OpenedSession { return record.navigationSource ?? currentForkSource(record); }

/** Product Host IDs and native installation IDs are independent identity evidence. */
function deliveryMatchesRelation(record: SessionFork, relation: SessionFork): boolean {
  if (!record.target || !relation.target || sessionKey(record.target) !== sessionKey(relation.target)) return false;
  if (relation.hostLocator && relation.hostLocator.hostId !== (record.target.hostId ?? 'local')) return false;
  if (record.hostLocator && (!relation.hostLocator || record.hostLocator.hostId !== relation.hostLocator.hostId
    || record.hostLocator.controllerId !== relation.hostLocator.controllerId)) return false;
  const original = relation.nativeSourceRef;
  if (original) {
    if (original.providerId !== record.source.providerId || original.nativeSessionId !== record.source.nativeSessionId) return false;
    if (!relation.hostLocator || relation.hostLocator.hostId !== (record.source.hostId ?? 'local')
      || relation.hostLocator.controllerId !== original.controllerId) return false;
    if (record.nativeSourceRef && nativeSessionRefKey(record.nativeSourceRef) !== nativeSessionRefKey(original)) return false;
    const relationBinding = relation.sourceBinding;
    if (relationBinding && nativeSessionRefKey(relationBinding.kind === 'fixed' ? relationBinding.source : relationBinding.origin) !== nativeSessionRefKey(original)) return false;
    const binding = record.sourceBinding;
    if (binding && nativeSessionRefKey(binding.kind === 'fixed' ? binding.source : binding.origin) !== nativeSessionRefKey(original)) return false;
    return !record.relationId || record.relationId === relation.relationId;
  }
  return !record.nativeSourceRef && !record.sourceBinding && sessionKey(record.source) === sessionKey(relation.source)
    && (!record.relationId || record.relationId === relation.relationId);
}

export function sideNavigationTarget(record: SessionFork): OpenedSession | undefined { return record.currentTarget ?? record.target; }
function validEditedTarget(value: OpenedSession, original: OpenedSession): boolean {
  return !!value && typeof value === 'object' && ['agentId', 'providerId', 'nativeSessionId', 'title'].every(key => typeof value[key as keyof OpenedSession] === 'string')
    && (value.hostId ?? 'local') === (original.hostId ?? 'local') && value.providerId === original.providerId;
}


/** Only complete immutable relation evidence can outlive a moving observed source. */
function navigationIdentity(record: SessionFork): ForkNavigationIdentity | undefined {
  const host = record.hostLocator;
  const origin = record.nativeSourceRef;
  const target = record.target;
  if (!host || !origin || !target || !record.relationId
    || ![host.hostId, host.controllerId, origin.controllerId, origin.providerId, origin.nativeSessionId, target.hostId, target.providerId, target.nativeSessionId]
      .every(value => typeof value === 'string' && value.length > 0)
    || host.hostId !== target.hostId || host.controllerId !== origin.controllerId) return;
  const binding = record.sourceBinding;
  if (binding && nativeSessionRefKey(binding.kind === 'fixed' ? binding.source : binding.origin) !== nativeSessionRefKey(origin)) return;
  return { hostId: host.hostId, controllerId: host.controllerId, target: sessionKey(target), relationId: record.relationId, originalSource: nativeSessionRefKey(origin) };
}
function sameNavigationIdentity(value: ForkNavigationIdentity, expected: ForkNavigationIdentity): boolean {
  return !!value && typeof value === 'object' && value.hostId === expected.hostId && value.controllerId === expected.controllerId
    && value.target === expected.target && value.relationId === expected.relationId && value.originalSource === expected.originalSource;
}
