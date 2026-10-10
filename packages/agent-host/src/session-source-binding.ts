import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AgentHistoryPage, AgentHistoryQuery } from '@orchardworks/agent-provider-sdk';
import { nativeSessionRefKey, type NativeSessionRef } from '@orchardworks/agent-remote-protocol';
import type { SessionSuccessionStore } from './session-succession-store.js';
import type { SourceHistoryPage, SourceHistoryQuery } from './session-reference.js';

interface ResolvedSource { source: NativeSessionRef; roleId?: string; roleRevision?: number }
interface RoleSource extends ResolvedSource { lineage: Set<string> }
interface SourceCursor extends ResolvedSource {
  version: 1;
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
}

/** Role lookups are cached by committed store generation; pagination pins an authenticated source. */
export class SessionSourceBindings {
  private generation = -1;
  private readers = new Map<string, RoleSource>();
  private readonly key: Buffer;
  constructor(private readonly store: SessionSuccessionStore, private readonly controllerId: string,
    private readonly providerId: string, cursorKey: Uint8Array) {
    if (cursorKey.byteLength < 32) throw new Error('Source cursor authentication key must contain at least 32 bytes.');
    this.key = Buffer.from(cursorKey);
  }

  /** Cross-check relation metadata against durable native grants before reserving the role. */
  async enrollSources(roleId: string, expectedRevision: number, associationRevision: number,
    relations: readonly SourceRelationEnrollment[], grants: readonly { nativeSessionId: string; sourceNativeSessionId: string }[]) {
    const state = this.store.read(roleId);
    const ref = (nativeSessionId: string): NativeSessionRef => ({ controllerId: this.controllerId, providerId: this.providerId, nativeSessionId });
    if (state.role.current.controllerId !== this.controllerId || state.role.current.providerId !== this.providerId) throw new Error('Source enrollment is outside this local provider.');
    const lineage = new Set([nativeSessionRefKey(state.role.origin), ...state.operations.filter(op => op.phase === 'committed').map(op => nativeSessionRefKey(op.to!))]);
    const participants = state.participants.filter(item => item.kind === 'tpm');
    for (const grant of grants) {
      if (!lineage.has(nativeSessionRefKey(ref(grant.sourceNativeSessionId)))) continue;
      const matches = relations.filter(relation => relation.nativeSessionId === grant.nativeSessionId);
      if (matches.length !== 1) throw new Error('Source relationship enrollment is incomplete or ambiguous.');
      const relation = matches[0]!;
      if (relation.sourceNativeSessionId !== grant.sourceNativeSessionId) throw new Error('Source relationship does not match its native grant.');
      if (relation.linked) participants.push({ relationId: relation.relationId, kind: relation.kind, before: ref(grant.nativeSessionId), after: ref(grant.nativeSessionId) });
    }
    for (const relation of relations) {
      if (lineage.has(nativeSessionRefKey(ref(relation.sourceNativeSessionId))) && !grants.some(grant => grant.nativeSessionId === relation.nativeSessionId && grant.sourceNativeSessionId === relation.sourceNativeSessionId)) throw new Error('Source relationship has no matching native grant.');
    }
    return this.store.setParticipants(roleId, expectedRevision, associationRevision, participants);
  }

  async read(reader: string, originalSource: string, input: SourceHistoryQuery,
    read: (nativeSessionId: string, query: AgentHistoryQuery) => Promise<AgentHistoryPage>): Promise<SourceHistoryPage> {
    const resolved = this.resolveSource(reader, originalSource);
    const context = input.sourceContext ? this.decode(input.sourceContext, reader, originalSource, 'context') : undefined;
    const page = input.cursor ? this.decode(input.cursor, reader, originalSource, 'page') : undefined;
    if (context && page && (nativeSessionRefKey(context.source) !== nativeSessionRefKey(page.source) || context.roleRevision !== page.roleRevision)) throw new Error('Source context and page cursor disagree.');
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
    // The directory's read callback rechecks native workspace access on every request.
    const result = await read(selected.source.nativeSessionId, query);
    const base: SourceCursor = { version: 1, reader, originalSource, kind: 'context', source: selected.source,
      ...(selected.roleId ? { roleId: selected.roleId, roleRevision: selected.roleRevision } : {}) };
    const { nextCursor: nativeCursor, ...content } = result;
    return { ...content, sourceSessionId: selected.source.nativeSessionId,
      ...(selected.roleId ? { sourceRoleId: selected.roleId, sourceRoleRevision: selected.roleRevision } : {}),
      sourceContext: this.encode(base),
      ...(nativeCursor ? { nextCursor: this.encode({ ...base, kind: 'page', page: {
        ...(query.query !== undefined ? { query: query.query } : {}), ...(query.turnId !== undefined ? { turnId: query.turnId } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}), cursor: nativeCursor,
      } }) } : {}),
    };
  }

  resolveSource(reader: string, originalSource: string): RoleSource {
    this.refresh();
    const source = { controllerId: this.controllerId, providerId: this.providerId, nativeSessionId: originalSource };
    const role = this.readers.get(nativeSessionRefKey({ ...source, nativeSessionId: reader }));
    if (!role) return { source, lineage: new Set([nativeSessionRefKey(source)]) };
    if (!role.lineage.has(nativeSessionRefKey(source))) throw new Error('Source grant does not belong to the primary role.');
    return { ...role, source: { ...role.source }, lineage: new Set(role.lineage) };
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
  private authorizePinned(current: RoleSource, pinned: ResolvedSource): void {
    if (pinned.source.controllerId !== this.controllerId || pinned.source.providerId !== this.providerId
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
