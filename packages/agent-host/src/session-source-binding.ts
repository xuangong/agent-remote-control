import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AgentHistoryPage, AgentHistoryQuery } from '@orchardworks/agent-provider-sdk';
import { nativeSessionRefKey, type NativeSessionRef, type SourceBinding } from '@orchardworks/agent-remote-protocol';
import type { SessionSuccessionContextStore, SuccessionContextRecord } from './session-succession-context.js';
import type { SessionExecutionRouting } from './session-succession-service.js';
import type { SessionSuccessionStore } from './session-succession-store.js';
import type { SourceHistoryPage, SourceHistoryQuery } from './session-reference.js';

const sameRef = (a: NativeSessionRef, b: NativeSessionRef) => nativeSessionRefKey(a) === nativeSessionRefKey(b);

interface ResolvedSource { source: NativeSessionRef; roleId?: string; roleRevision?: number }
interface RoleSource extends ResolvedSource { lineage: Set<string> }
interface SourceCursor extends ResolvedSource {
  version: 1;
  representation?: 'native' | 'attachment';
  attachmentId?: string;
  reader: string;
  originalSource: string;
  kind: 'context' | 'page';
  page?: AgentHistoryQuery;
}
export interface SourceRelationEnrollment {
  relationId: string;
  kind: 'side' | 'ask';
  nativeSessionId: string;
  sourceNativeSessionId: string;
  linked: boolean;
  readerRef?: NativeSessionRef;
  sourceRef?: NativeSessionRef;
}
export interface SourceGrantEnrollment { nativeSessionId: string; sourceNativeSessionId: string; readerRef?: NativeSessionRef; sourceRef?: NativeSessionRef }

export interface SourceBindingOptions {
  /** Must resolve the full address and recheck native workspace access on each call. */
  readRouted?: (source: NativeSessionRef, query: AgentHistoryQuery) => Promise<AgentHistoryPage>;
  /** Required for stored attachment reads, which cannot rely on a native read callback. */
  authorizeRead?: (reader: NativeSessionRef, source: NativeSessionRef) => Promise<void>;
  contexts?: SessionSuccessionContextStore;
  executionRouting?: SessionExecutionRouting;
}

/** Role lookups are cached by committed store generation; pagination pins an authenticated source. */
export class SessionSourceBindings {
  private generation = -1;
  private readers = new Map<string, RoleSource>();
  private readonly key: Buffer;
  constructor(private readonly store: SessionSuccessionStore, private readonly controllerId: string,
    private readonly providerId: string, cursorKey: Uint8Array, private readonly options: SourceBindingOptions = {}) {
    if (cursorKey.byteLength < 32) throw new Error('Source cursor authentication key must contain at least 32 bytes.');
    this.key = Buffer.from(cursorKey);
  }

  /** Cross-check relation metadata against durable native grants before reserving the role. */
  async enrollSources(roleId: string, expectedRevision: number, associationRevision: number,
    relations: readonly SourceRelationEnrollment[], grants: readonly SourceGrantEnrollment[]) {
    const participants = this.sourceParticipants(roleId, relations, grants);
    return this.store.setParticipants(roleId, expectedRevision, associationRevision, participants);
  }
  sourceParticipants(roleId: string, relations: readonly SourceRelationEnrollment[], grants: readonly SourceGrantEnrollment[]) {
    const state = this.store.read(roleId);
    const ref = (nativeSessionId: string): NativeSessionRef => ({ controllerId: this.controllerId, providerId: this.providerId, nativeSessionId });
    if (state.role.current.controllerId !== this.controllerId) throw new Error('Source enrollment is outside this Controller.');
    const reader = (item: SourceGrantEnrollment | SourceRelationEnrollment) => item.readerRef ? this.ref(item.readerRef) : ref(item.nativeSessionId);
    const source = (item: SourceGrantEnrollment | SourceRelationEnrollment) => item.sourceRef ? this.ref(item.sourceRef) : ref(item.sourceNativeSessionId);
    const lineage = new Set([nativeSessionRefKey(state.role.origin), ...state.operations.filter(op => op.phase === 'committed').map(op => nativeSessionRefKey(op.to!))]);
    const participants = state.participants.filter(item => item.kind === 'tpm');
    for (const grant of grants) {
      if (!lineage.has(nativeSessionRefKey(source(grant)))) continue;
      const matches = relations.filter(relation => sameRef(reader(relation), reader(grant)));
      if (matches.length !== 1) throw new Error('Source relationship enrollment is incomplete or ambiguous.');
      const relation = matches[0]!;
      if (!sameRef(source(relation), source(grant))) throw new Error('Source relationship does not match its native grant.');
      if (relation.linked) participants.push({ relationId: relation.relationId, kind: relation.kind, before: reader(grant), after: reader(grant) });
    }
    for (const relation of relations) {
      if (lineage.has(nativeSessionRefKey(source(relation))) && !grants.some(grant => sameRef(reader(grant), reader(relation)) && sameRef(source(grant), source(relation)))) throw new Error('Source relationship has no matching native grant.');
    }
    return participants;
  }

  read(reader: string | NativeSessionRef, originalSource: string | NativeSessionRef, input: SourceHistoryQuery,
    read: (nativeSessionId: string, query: AgentHistoryQuery) => Promise<AgentHistoryPage>, canonicalReader: string | NativeSessionRef = reader): Promise<SourceHistoryPage> {
    return this.readSource(reader, originalSource, input, read, undefined, canonicalReader);
  }

  /** Trusted Host consumers already hold a durable role binding; public source tools use enrolled readers. */
  readRole(binding: SourceBinding, input: SourceHistoryQuery): Promise<SourceHistoryPage> {
    const unavailable = async (): Promise<AgentHistoryPage> => { throw new Error('Role history requires a routed native reader.'); };
    if (binding.kind === 'fixed') return this.readSource(binding.source, binding.source, input, unavailable, {
      source: this.ref(binding.source), lineage: new Set([nativeSessionRefKey(binding.source)]),
    });
    const state = this.store.read(binding.roleId);
    if (!sameRef(binding.origin, state.role.origin)) throw new Error('Primary role origin changed.');
    const lineage = new Set([nativeSessionRefKey(state.role.origin), ...state.operations.filter(operation => operation.phase === 'committed').map(operation => nativeSessionRefKey(operation.to!))]);
    return this.readSource(binding.origin, binding.origin, input, unavailable, {
      source: state.role.current, roleId: state.role.id, roleRevision: state.role.revision, lineage,
    });
  }

  private async readSource(reader: string | NativeSessionRef, originalSource: string | NativeSessionRef, input: SourceHistoryQuery,
    read: (nativeSessionId: string, query: AgentHistoryQuery) => Promise<AgentHistoryPage>, role?: RoleSource, canonicalReader: string | NativeSessionRef = reader): Promise<SourceHistoryPage> {
    const canonicalRef = this.ref(canonicalReader);
    const assertReader = () => { if (!role) this.options.executionRouting?.assertCurrent(canonicalRef, this.ref(reader)); };
    assertReader();
    const readerRef = this.ref(reader), originalRef = this.ref(originalSource);
    if (!role) this.assertReaderOpen(readerRef);
    const readerKey = typeof canonicalReader === 'string' ? canonicalReader : nativeSessionRefKey(canonicalRef);
    const originalKey = typeof originalSource === 'string' ? originalSource : nativeSessionRefKey(originalRef);
    const resolved = role ?? this.resolveSource(canonicalRef, originalRef);
    const context = input.sourceContext ? this.decode(input.sourceContext, readerKey, originalKey, 'context') : undefined;
    const page = input.cursor ? this.decode(input.cursor, readerKey, originalKey, 'page') : undefined;
    if (context && page && (nativeSessionRefKey(context.source) !== nativeSessionRefKey(page.source) || context.roleRevision !== page.roleRevision || context.representation !== page.representation || context.attachmentId !== page.attachmentId)) throw new Error('Source context and page cursor disagree.');
    const pinned = page ?? context;
    const selected: ResolvedSource = pinned ?? resolved;
    this.authorizePinned(resolved, selected);
    if (!pinned && resolved.roleId && (input.turnId !== undefined || (input.textOffset ?? 0) > 0)) throw new Error('Use the source context from the earlier read for a turn or text offset.');
    const query: AgentHistoryQuery = {};
    if (page) {
      if (!page.page) throw new Error('Source page cursor is incomplete.');
      for (const field of ['query', 'turnId', 'limit'] as const) {
        if (input[field] !== undefined && input[field] !== page.page[field]) throw new Error('Source cursor query cannot change.');
      }
      Object.assign(query, page.page);
    } else {
      for (const field of ['query', 'turnId', 'limit'] as const) if (input[field] !== undefined) Object.assign(query, { [field]: input[field] });
    }
    if (input.textOffset !== undefined) query.textOffset = input.textOffset;
    await this.options.authorizeRead?.(readerRef, selected.source);
    assertReader();
    this.checkSelected(canonicalRef, originalRef, selected, role);
    const candidate = this.options.contexts?.forTarget(selected.source);
    const attachment = pinned?.representation === 'attachment'
      ? this.options.contexts?.read(pinned.attachmentId!)
      : !pinned && candidate?.state !== 'materialized' ? candidate : undefined;
    if (pinned?.representation === 'attachment' && !attachment) throw new Error('Pinned source attachment is unavailable.');
    if (attachment && (!this.options.authorizeRead || !sameRef(attachment.target, selected.source)
      || selected.roleId !== undefined && (attachment.roleId !== selected.roleId || attachment.roleRevision !== selected.roleRevision))) throw new Error('Source attachment requires authorized matching routing.');
    if (attachment) {
      const provenance = this.store.read(attachment.roleId);
      if (!provenance.operations.some(operation => operation.phase === 'committed' && operation.operationId === attachment.operationId
        && operation.committedRevision === attachment.roleRevision && sameRef(operation.to!, attachment.target) && sameRef(operation.from, attachment.source))) throw new Error('Source attachment has no matching durable succession provenance.');
    }
    let result: AgentHistoryPage;
    if (attachment) result = this.readAttachment(attachment, query);
    else if (this.options.readRouted) result = await this.options.readRouted(selected.source, query);
    else {
      if (selected.source.providerId !== this.providerId) throw new Error('Cross-provider source reads require a routed reader.');
      result = await read(selected.source.nativeSessionId, query);
    }
    assertReader();
    this.checkSelected(canonicalRef, originalRef, selected, role);
    await this.options.authorizeRead?.(readerRef, selected.source);
    assertReader();
    this.checkSelected(canonicalRef, originalRef, selected, role);
    const base: SourceCursor = { version: 1, reader: readerKey, originalSource: originalKey, kind: 'context', source: selected.source,
      representation: attachment ? 'attachment' : 'native', ...(attachment ? { attachmentId: attachment.operationId } : {}),
      ...(attachment ? { roleId: attachment.roleId, roleRevision: attachment.roleRevision } : selected.roleId ? { roleId: selected.roleId, roleRevision: selected.roleRevision } : {}) };
    const { nextCursor: nativeCursor, ...content } = result;
    return { ...content, sourceRef: selected.source, sourceRepresentation: base.representation,
      ...(attachment ? { sourceProvenance: { operationId: attachment.operationId, source: attachment.source, capturedAt: attachment.capturedAt, boundary: attachment.boundary, ...(attachment.inheritedFrom ? { inheritedFrom: attachment.inheritedFrom } : {}) } } : {}), sourceSessionId: selected.source.nativeSessionId,
      ...(selected.roleId ? { sourceRoleId: selected.roleId, sourceRoleRevision: selected.roleRevision } : {}),
      sourceContext: this.encode(base),
      ...(nativeCursor ? { nextCursor: this.encode({ ...base, kind: 'page', page: {
        ...(query.query !== undefined ? { query: query.query } : {}), ...(query.turnId !== undefined ? { turnId: query.turnId } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}), cursor: nativeCursor,
      } }) } : {}),
    };
  }

  private ref(value: string | NativeSessionRef): NativeSessionRef {
    const ref = typeof value === 'string' ? { controllerId: this.controllerId, providerId: this.providerId, nativeSessionId: value } : value;
    if (ref.controllerId !== this.controllerId || !ref.providerId || !ref.nativeSessionId) throw new Error('Source address is outside this Controller.');
    return { ...ref };
  }
  resolveSource(reader: string | NativeSessionRef, originalSource: string | NativeSessionRef): RoleSource {
    this.assertReaderOpen(this.ref(reader));
    this.refresh();
    const source = this.ref(originalSource), readerRef = this.ref(reader);
    const role = this.readers.get(nativeSessionRefKey(readerRef));
    if (!role) return { source, lineage: new Set([nativeSessionRefKey(source)]) };
    if (!role.lineage.has(nativeSessionRefKey(source))) throw new Error('Source grant does not belong to the primary role.');
    return { ...role, source: { ...role.source }, lineage: new Set(role.lineage) };
  }
  private readAttachment(record: SuccessionContextRecord, query: AgentHistoryQuery): AgentHistoryPage {
    if (query.query !== undefined && query.turnId !== undefined) throw new Error('Search query and turnId cannot be combined.');
    const limit = query.limit ?? 10, offset = query.textOffset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid attachment history query.');
    const rows = JSON.parse(record.text) as Array<{ role: string; text: string }>;
    const entries = rows.map((row, index) => ({ id: `${record.operationId}:${index}`, turnId: `${record.operationId}:${index}`, role: row.role, text: row.text, textOffset: offset, totalChars: row.text.length }));
    let selected = query.query !== undefined ? entries.filter(item => item.role !== 'tool' && item.text.toLowerCase().includes(query.query!.toLowerCase()))
      : query.turnId !== undefined ? entries.filter(item => item.turnId === query.turnId) : entries.reverse();
    const start = query.cursor === undefined ? 0 : Number(query.cursor);
    if (!Number.isSafeInteger(start) || start < 0) throw new Error('Invalid attachment page cursor.');
    const end = start + limit;
    return { entries: selected.slice(start, end).map(item => ({ ...item, text: item.text.slice(offset, offset + 6000) })), ...(end < selected.length ? { nextCursor: String(end) } : {}) };
  }
  private refresh(): void {
    if (this.generation === this.store.generation) return;
    const readers = new Map<string, RoleSource>();
    for (const item of this.store.all()) {
      const committed = item.operations.filter(op => op.phase === 'committed');
      const latest = committed.at(-1);
      if (!latest?.prepared) continue;
      const lineage = new Set([nativeSessionRefKey(item.role.origin), ...committed.map(op => nativeSessionRefKey(op.to!))]);
      for (const participant of item.participants) {
        if (participant.kind === 'tpm') continue;
        const key = nativeSessionRefKey(participant.after);
        if (readers.has(key)) throw new Error('Source session belongs to more than one primary role.');
        readers.set(key, { source: item.role.current, roleId: item.role.id, roleRevision: item.role.revision, lineage });
      }
    }
    this.readers = readers; this.generation = this.store.generation;
  }
  private assertReaderOpen(reader: NativeSessionRef): void {
    if (this.store.readerAssociationState(reader).pending) throw new Error('Source relationship update is pending; reader is reserved.');
  }
  private checkSelected(reader: NativeSessionRef, original: NativeSessionRef, selected: ResolvedSource, role?: RoleSource): void {
    if (role) {
      const state = role.roleId && this.store.read(role.roleId);
      const current = state ? { source: state.role.current, roleId: state.role.id, roleRevision: state.role.revision, lineage: new Set(this.store.lineage(state).map(nativeSessionRefKey)) } : role;
      this.authorizePinned(current, selected); return;
    }
    this.assertReaderOpen(reader);
    this.authorizePinned(this.resolveSource(reader, original), selected);
  }
  private authorizePinned(current: RoleSource, pinned: ResolvedSource & { representation?: string }): void {
    if (!current.roleId && sameRef(current.source, pinned.source)) return;
    if (pinned.source.controllerId !== this.controllerId
      || !current.lineage.has(nativeSessionRefKey(pinned.source))
      || pinned.roleId !== undefined && (pinned.roleId !== current.roleId || pinned.roleRevision! > current.roleRevision!)) throw new Error('Source cursor is outside the current authorized relationship.');
  }
  private encode(value: SourceCursor): string {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `sr1.${body}.${createHmac('sha256', this.key).update(body).digest('base64url')}`;
    if (token.length > 16384) throw new Error('Source cursor exceeds the supported size.');
    return token;
  }
  private decode(token: string, reader: string, originalSource: string, kind: SourceCursor['kind']): SourceCursor {
    const [prefix, body, signature, extra] = token.split('.');
    if (token.length > 16384 || prefix !== 'sr1' || !body || !signature || extra !== undefined) throw new Error('Invalid source cursor/context.');
    const expected = createHmac('sha256', this.key).update(body).digest('base64url');
    if (expected.length !== signature.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error('Invalid source cursor/context signature.');
    const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SourceCursor;
    if (value.version !== 1 || value.reader !== reader || value.originalSource !== originalSource || value.kind !== kind) throw new Error('Source cursor/context belongs to another read.');
    return value;
  }
}
