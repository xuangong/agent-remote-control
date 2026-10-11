import { isSessionSuccessionReplay, isSessionSuccessionCurrent, isSessionSuccessionReplayPage, nativeSessionRefKey,
  type SessionSuccessionReplay, type SessionSuccessionCurrent, type SessionSuccessionReplayPage } from '@orchardworks/agent-remote-protocol';
import { recoveryGeneration } from './conversation-recovery.js';
import { flushRecoveryWrites } from './recovery-writes.js';
import { inspectImageDraft, type ImageDraftStorageHandle } from '@orchardworks/agent-remote-web/browser';
import type { DraftStore } from './draft-store.js';
import { inspectSessionDisplayPreferences, flushSessionDisplayPreferences } from './hooks/useSessionDisplayPreferences.js';
import { patchTrackedSessions, readTrackedSessionsChecked, trackingEditRevision, type TrackedSessionPatch } from './tracking-state.js';
import { sessionKey } from './session-tree.js';

import { canonicalJson, compositionRoleKey, createRoleCheckpoint, saveCompositionDocument,
  compositionMetadataKey,
  type CompositionDocument, type CompositionProgress, type CompositionSlot, type RoleCheckpoint } from './session-composition-model.js';

export interface CompositionAuthority { scope: string; hostId: string; controllerId: string; isCurrent(): boolean }
export interface CompositionApplicationContext {
  document: CompositionDocument; replay: SessionSuccessionReplay; checkpoint: RoleCheckpoint;
  slots: readonly CompositionSlot[]; retained: readonly CompositionSlot[]; editRevision: number;
  transitions: readonly SessionSuccessionReplay[];
  /** Includes live access/transport, this run, recovery generation and current document edits. */
  isCurrent(): boolean;
}
export type CompositionParticipantResult = Omit<CompositionProgress, 'revision'> & { retainedCurrent?(): boolean };
export interface CompositionApplications {
  track(context: CompositionApplicationContext): Promise<CompositionParticipantResult>;
  ask(context: CompositionApplicationContext): Promise<CompositionParticipantResult>;
  draftViews(context: CompositionApplicationContext): Promise<CompositionParticipantResult>;
}
export interface CompositionRecoveryTransport {
  fetchSessionSuccessionOperation(roleId: string, operationId: string): Promise<SessionSuccessionReplay | undefined>;
  fetchSessionSuccessionCurrent(roleId: string): Promise<SessionSuccessionCurrent | undefined>;
  fetchSessionSuccessions(query: { roleId: string; afterRevision: number; cursor?: string }): Promise<SessionSuccessionReplayPage>;
}
const pending = (code: string): CompositionParticipantResult => ({ status: 'pending', retention: 'page', code });
const failed = (code: string): CompositionParticipantResult => ({ status: 'failed', retention: 'page', code });
const conflict = (code: string): CompositionParticipantResult => ({ status: 'conflict', retention: 'page', code });
const weakest = (values: Array<'page' | 'session' | 'local' | undefined>): 'page' | 'session' | 'local' => values.includes(undefined) || values.includes('page') ? 'page' : values.includes('session') ? 'session' : 'local';

/** Flush actual current owners, including independent duplicates, without native work. */
export async function retainCompositionDraftViews(context: CompositionApplicationContext, textStore: (scope: string) => DraftStore): Promise<CompositionParticipantResult> {
  const checks: Array<() => boolean> = [context.isCurrent];
  const retentions: Array<'page' | 'session' | 'local'> = [];
  const texts = new Set<string>(), images = new Set<string>(), displays = new Set<string>();
  const current = () => checks.every(check => check());
  const imageHandles: ImageDraftStorageHandle[] = [];
  try {
    for (const slot of [...context.slots, ...context.retained]) {
      const text = slot.owners.text, textKey = JSON.stringify(text);
      if (!texts.has(textKey)) {
        texts.add(textKey); const store = textStore(text.scope);
        if (store.inspect(text.key).status === 'failed') store.retryRead();
        const snapshot = store.inspect(text.key);
        if (snapshot.status !== 'ready') return failed('text_read');
        checks.push(() => store.inspect(text.key).status === 'ready' && store.snapshot(text.key).revision === snapshot.revision);
        const result = await store.flushCurrent(text.key, snapshot.revision, current);
        if (!current()) return pending('owner_edit');
        if (result.status !== 'saved') return result.status === 'failed' ? failed('text_write') : pending('text_cancelled');
        retentions.push(result.retention);
      }
      const image = slot.owners.image, imageKey = JSON.stringify(image);
      if (!images.has(imageKey)) {
        images.add(imageKey); const handle = await inspectImageDraft(image); imageHandles.push(handle);
        if (!current()) return pending('owner_edit');
        const snapshot = handle.snapshot();
        if (snapshot.status === 'cancelled') return pending('image_cancelled');
        checks.push(() => handle.snapshot().revision === snapshot.revision && handle.snapshot().status !== 'cancelled');
        const saved = await handle.flush(snapshot.revision, current);
        if (!current()) return pending('owner_edit');
        if (saved.status !== 'ready' || saved.savedRevision !== saved.revision) return saved.status === 'failed' ? failed('image_write') : pending('image_pending');
        retentions.push(saved.retention);
      }
      const display = slot.owners.display, displayKey = JSON.stringify(display);
      if (!displays.has(displayKey)) {
        displays.add(displayKey); const snapshot = inspectSessionDisplayPreferences(display);
        checks.push(() => inspectSessionDisplayPreferences(display).revision === snapshot.revision);
        const saved = flushSessionDisplayPreferences(display, snapshot.revision, current);
        if (saved.status !== 'ready') return saved.status === 'failed' ? failed('display_write') : pending('display_cancelled');
        retentions.push(saved.retention);
      }
    }
    if (!current() || imageHandles.some(handle => handle.snapshot().status !== 'ready')) return pending('owner_edit');
    return { status: 'applied', retention: weakest(retentions.length ? retentions : ['session']), retainedCurrent: () => checks.slice(1).every(check => check()) };
  } catch { return failed('draft_retention'); }
}

/** The outer Track list follows its explicit view reference; layout is unchanged. */
export async function applyCompositionTrack(context: CompositionApplicationContext): Promise<CompositionParticipantResult> {
  if (!context.isCurrent()) return pending('track_currentness');
  const scope = context.document.scope, read = readTrackedSessionsChecked(scope);
  if (read.status !== 'ready') return failed('track_read');
  const patches: TrackedSessionPatch[] = [], duplicates: string[] = [];
  for (const track of context.document.tracks) {
    const entry = read.sessions.find(entry => (entry.entryId ?? sessionKey(entry)) === track.entryId);
    if (!entry) continue;
    const slot = context.slots.find(slot => slot.id === track.slotId);
    if (slot?.intent.kind === 'role') patches.push({ entryId: track.entryId, from: entry,
      to: { hostId: slot.intent.target.hostId, providerId: slot.intent.target.native.providerId, nativeSessionId: slot.intent.target.native.nativeSessionId },
      successionRole: { controllerId: context.checkpoint.controllerId, roleId: context.checkpoint.roleId, revision: context.checkpoint.desired.committedRevision } });
    if (context.retained.some(slot => slot.id === track.slotId)) duplicates.push(track.entryId);
  }
  const result = patchTrackedSessions(scope, patches, read.revision, context.isCurrent, duplicates);
  if (result.status !== 'saved') return result.status === 'conflict' ? conflict('track_identity') : result.status === 'failed' ? failed('track_write') : pending('track_edit');
  return { status: 'applied', retention: result.retention, retainedCurrent: () => trackingEditRevision(scope) === result.revision };
}
function sameLineage(left: SessionSuccessionReplay, right: SessionSuccessionReplay): boolean {
  return left.to.hostId === right.from.hostId && left.projection.role.id === right.projection.role.id
    && left.projection.role.revision === right.projection.receipt.expectedRevision
    && nativeSessionRefKey(left.projection.role.current) === nativeSessionRefKey(right.projection.receipt.from)
    && canonicalJson(left.projection.role.origin) === canonicalJson(right.projection.role.origin)
    && canonicalJson(left.projection.role.workspace) === canonicalJson(right.projection.role.workspace);
}

/** Four fixed local participants. Native work is deliberately absent from this boundary. */
export class SuccessionApplication {
  private run = 0;
  private readonly generation: number;
  private readonly authorized = new Map<string, SessionSuccessionReplay>();
  private readonly unfinishedTransitions = new Map<string, readonly SessionSuccessionReplay[]>();
  constructor(readonly document: CompositionDocument, private readonly authority: CompositionAuthority, private readonly applications: CompositionApplications) {
    this.generation = recoveryGeneration(authority.scope);
  }
  private current(): boolean { return this.document.scope === this.authority.scope && this.authority.isCurrent() && this.generation === recoveryGeneration(this.authority.scope); }
  private allowed(replay: unknown): replay is SessionSuccessionReplay {
    return this.current() && isSessionSuccessionReplay(replay) && replay.from.hostId === this.authority.hostId
      && replay.projection.role.current.controllerId === this.authority.controllerId
      && replay.projection.role.origin.controllerId === this.authority.controllerId;
  }
  private async persist(isCurrent: () => boolean): Promise<CompositionParticipantResult> {
    const editRevision = this.document.editRevision;
    const current = () => isCurrent() && this.document.editRevision === editRevision;
    const handle = saveCompositionDocument(this.document, current);
    flushRecoveryWrites(compositionMetadataKey(this.document.scope));
    const result = await handle.completion;
    if (!current()) return pending('retired');
    return result.status === 'saved' ? { status: 'applied', retention: result.retention } : result.status === 'failed' ? failed('checkpoint_write') : pending('checkpoint_cancelled');
  }
  apply(replay: SessionSuccessionReplay): Promise<CompositionParticipantResult> { return this.applyCommit(replay, [replay]); }
  private async applyCommit(replay: SessionSuccessionReplay, transitions: readonly SessionSuccessionReplay[], navigation?: { selectedSlot?: string; isCurrent(): boolean }): Promise<CompositionParticipantResult> {
    if (!this.allowed(replay)) return pending('authorization');
    if (navigation?.selectedSlot && !this.document.slots.some(slot => slot.id === navigation.selectedSlot)) return pending('invalid_view');
    const key = compositionRoleKey({ scope: this.authority.scope, hostId: replay.to.hostId, controllerId: replay.projection.role.current.controllerId, roleId: replay.projection.role.id });
    const previous = this.document.roles.find(role => compositionRoleKey(role) === key);
    const revision = replay.projection.role.revision;
    if (previous && revision < previous.desired.committedRevision) return pending('older_revision');
    const unfinished = this.unfinishedTransitions.get(key);
    if (previous && revision === previous.desired.committedRevision && !this.authorized.has(key) && transitions[0]!.projection.receipt.expectedRevision !== 1) return pending('replay_gap');
    if (transitions.length === 1 && previous && previous.appliedRevision < previous.desired.committedRevision && unfinished?.length) {
      if (revision === previous.desired.committedRevision) transitions = unfinished;
      else if (sameLineage(unfinished.at(-1)!, replay)) transitions = [...unfinished, replay];
    }
    const run = ++this.run, startingEditRevision = this.document.editRevision;
    const active = () => this.current() && this.run === run && (!navigation || navigation.isCurrent());
    let incoming: RoleCheckpoint;
    try { incoming = await createRoleCheckpoint(this.authority.scope, replay); } catch { return failed('invalid_replay'); }
    if (!active()) return pending('retired');
    if (this.document.editRevision !== startingEditRevision) return pending('local_edit');
    if (previous && revision === previous.desired.committedRevision && canonicalJson(previous.desired) !== canonicalJson(incoming.desired)) return conflict('receipt_identity');
    if (previous && revision > previous.desired.committedRevision) {
      const authorized = this.authorized.get(key);
      const recovered = transitions[0]?.projection.receipt.expectedRevision === 1 && transitions.at(-1) === replay;
      if (!recovered && (!authorized || !sameLineage(authorized, replay))) return pending('replay_gap');
      incoming.appliedRevision = previous.appliedRevision;
    } else if (!previous && (transitions[0]!.projection.receipt.expectedRevision !== 1 || nativeSessionRefKey(transitions[0]!.projection.receipt.from) !== nativeSessionRefKey(replay.projection.role.origin))) return pending('replay_gap');
    const checkpoint = previous && revision === previous.desired.committedRevision ? previous : incoming;
    // Revalidation is incomplete until every current owner has been checked again.
    checkpoint.appliedRevision = Math.min(checkpoint.appliedRevision, revision - 1);
    checkpoint.documents = incoming.documents;
    this.authorized.set(key, replay);
    this.unfinishedTransitions.set(key, transitions);
    if (checkpoint !== previous) {
      if (previous) this.document.roles.splice(this.document.roles.indexOf(previous), 1, checkpoint); else this.document.roles.push(checkpoint);
    }
    const affected: CompositionSlot[] = [];
    for (const slot of this.document.slots) {
      const { intent } = slot;
      const enrolled = intent.kind === 'role' && intent.roleKey === key;
      const origin = replay.projection.role.origin;
      const matches = intent.kind === 'fixed' && intent.target.hostId === replay.from.hostId
        && intent.target.native.providerId === origin.providerId && intent.target.native.nativeSessionId === origin.nativeSessionId
        && (!intent.target.native.controllerId || intent.target.native.controllerId === origin.controllerId);
      if (!enrolled && !matches) continue;
      slot.intent = { kind: 'role', roleKey: key, revision, target: { hostId: replay.to.hostId, native: { ...replay.projection.role.current } } };
      affected.push(slot);
    }
    for (const activeSlot of affected) for (const slot of this.document.slots) {
      const intent = slot.intent;
      const collision = intent.kind === 'fixed' && transitions.some(transition => intent.target.hostId === transition.to.hostId
        && intent.target.native.providerId === transition.to.providerId && intent.target.native.nativeSessionId === transition.to.nativeSessionId
        && (!intent.target.native.controllerId || intent.target.native.controllerId === transition.projection.role.current.controllerId));
      if (slot.id === activeSlot.id || !collision) continue;
      if (!this.document.retained.some(entry => entry.slot === slot.id && entry.against === activeSlot.id)) this.document.retained.push({ slot: slot.id, against: activeSlot.id });
    }
    // Desired intent survives failure without restoring a stale executor.
    let expectedEditRevision = ++this.document.editRevision;
    const retentionChecks: Array<() => boolean> = [];
    const ownsCheckpoint = () => this.run === run && (!navigation || navigation.isCurrent()) && this.document.roles.includes(checkpoint) && checkpoint.desired.committedRevision === revision;
    const currentDocument = () => active() && this.document.editRevision === expectedEditRevision && retentionChecks.every(check => check()) && ownsCheckpoint();
    let persisted = await this.persist(currentDocument);
    if (persisted.status !== 'applied') return persisted;
    for (const name of ['draftViews', 'ask', 'track'] as const) {
      if (!currentDocument()) return pending('retired');
      const editRevision = this.document.editRevision;
      const isCurrent = () => currentDocument() && this.document.editRevision === editRevision;
      const retained = this.document.retained.filter(entry => affected.some(slot => slot.id === entry.against)).flatMap(entry => this.document.slots.filter(slot => slot.id === entry.slot));
      let result: CompositionParticipantResult;
      try { result = await this.applications[name]({ document: this.document, replay, checkpoint, slots: affected, retained, transitions, editRevision, isCurrent }); }
      catch { result = failed(`${name}_write`); }
      if (!isCurrent()) return pending('local_edit');
      if (result.status === 'applied' && !result.retention) result = failed(`${name}_retention`);
      const { retainedCurrent, ...progress } = result;
      if (result.status === 'applied' && retainedCurrent) retentionChecks.push(retainedCurrent);
      if (!currentDocument()) return pending('owner_edit');
      checkpoint.documents[name] = { ...progress, revision };
      expectedEditRevision = ++this.document.editRevision;
      persisted = await this.persist(currentDocument);
      if (!currentDocument()) return pending('local_edit');
      if (persisted.status !== 'applied') return persisted;
      if (result.status !== 'applied') return result;
    }
    if (!currentDocument()) return pending('local_edit');
    // Only checked owner retention can permit removal of duplicate navigation edges.
    for (const retained of this.document.retained.filter(entry => affected.some(slot => slot.id === entry.against))) {
      if (retained.slot === navigation?.selectedSlot) continue;
      this.document.edges = this.document.edges.filter(edge => edge.source !== retained.slot && edge.target !== retained.slot);
      this.document.collapsed = this.document.collapsed.filter(slot => slot !== retained.slot);
      for (const field of ['primary', 'address', 'focus', 'anchor'] as const) if (this.document[field] === retained.slot) this.document[field] = retained.against;
    }
    checkpoint.documents.composition = { revision, status: 'applied', retention: persisted.retention };
    const priorApplied = checkpoint.appliedRevision;
    checkpoint.appliedRevision = revision; expectedEditRevision = ++this.document.editRevision;
    persisted = await this.persist(currentDocument);
    if (!currentDocument()) persisted = pending('local_edit');
    if (persisted.status !== 'applied') {
      if (ownsCheckpoint()) {
        checkpoint.appliedRevision = priorApplied; checkpoint.documents.composition = { revision, ...persisted };
        const incompleteRevision = ++this.document.editRevision;
        // Correct only this run's marker, preserving current edits without resetting a newer checkpoint.
        await this.persist(() => this.current() && ownsCheckpoint() && this.document.editRevision === incompleteRevision);
      }
      return persisted;
    }
    this.unfinishedTransitions.delete(key);
    return { status: 'applied', retention: weakest([persisted.retention, ...Object.values(checkpoint.documents).map(result => result.retention)]) };
  }

  /** Revalidate hints and complete the entire authorized chain before changing enrollment. */
  async recover(roleId: string, transport: CompositionRecoveryTransport, navigation?: { selectedSlot?: string; isCurrent(): boolean }): Promise<CompositionParticipantResult> {
    if (!this.current()) return pending('authorization');
    const run = ++this.run, editRevision = this.document.editRevision;
    const active = () => this.current() && this.run === run && this.document.editRevision === editRevision && (!navigation || navigation.isCurrent());
    const checkpoint = this.document.roles.find(role => role.roleId === roleId && role.hostId === this.authority.hostId && role.controllerId === this.authority.controllerId);
    try {
      let pinned: SessionSuccessionReplay | undefined;
      if (checkpoint) {
        pinned = await transport.fetchSessionSuccessionOperation(roleId, checkpoint.desired.operationId);
        if (!active()) return pending('retired');
        if (!this.allowed(pinned)) return pending('operation_unavailable');
        const verified = await createRoleCheckpoint(this.authority.scope, pinned);
        if (!active()) return pending('retired');
        if (compositionRoleKey(verified) !== compositionRoleKey(checkpoint) || canonicalJson(verified.desired) !== canonicalJson(checkpoint.desired)) return conflict('receipt_identity');
      }
      const current = await transport.fetchSessionSuccessionCurrent(roleId);
      if (!active()) return pending('retired');
      if (!current || !isSessionSuccessionCurrent(current) || current.role.id !== roleId || current.locator.hostId !== this.authority.hostId || current.role.current.controllerId !== this.authority.controllerId) return pending('current_unavailable');
      const chain: SessionSuccessionReplay[] = []; const cursors = new Set<string>(); let cursor: string | undefined;
      // Transient replay starts at origin because stored compact hints cannot prove lineage.
      do {
        const page = await transport.fetchSessionSuccessions({ roleId, afterRevision: 0, ...(cursor ? { cursor } : {}) });
        if (!active()) return pending('retired');
        if (!isSessionSuccessionReplayPage(page)) return conflict('invalid_replay');
        for (const replay of page.successions) {
          if (!this.allowed(replay) || replay.projection.role.id !== roleId) return conflict('replay_scope');
          const previous = chain.at(-1);
          if (previous ? !sameLineage(previous, replay) : replay.projection.receipt.expectedRevision !== 1 || nativeSessionRefKey(replay.projection.receipt.from) !== nativeSessionRefKey(replay.projection.role.origin)) return pending('replay_gap');
          chain.push(replay);
        }
        cursor = page.nextCursor ?? undefined;
        if (cursor) { if (cursors.has(cursor)) return pending('replay_gap'); cursors.add(cursor); }
      } while (cursor);
      const last = chain.at(-1);
      if (!last || canonicalJson(last.projection.role) !== canonicalJson(current.role)) return pending('replay_gap');
      if (pinned && !chain.some(replay => canonicalJson(replay) === canonicalJson(pinned))) return conflict('pinned_replay');
      // Latest desired intent must survive failure in any earlier participant's retention.
      return this.applyCommit(last, chain, navigation);
    } catch { return pending('replay_unavailable'); }
  }
}
