import { flushSync } from 'react-dom';
import { useEffect, useMemo, useReducer, useRef } from 'react';
import type { SessionSuccessionReplay } from '@orchardworks/agent-remote-protocol';
import { remoteSessionState, watchPageResume, type AgentReplica, type AgentReplicaState, type RemoteAgentTransport, type RemoteSessionClient, type RemoteSessionState } from '@orchardworks/agent-remote-web';
import type { ImageDraftRecipient } from '@orchardworks/agent-remote-web/browser';
import type { ControllerLocation } from '@orchardworks/agent-remote-hosted/controller-location';
import { SessionDirectoryClient, type OpenedSession } from '../directory-client.js';
import { sessionKey, type SessionEntry } from '../session-tree.js';
import { recoveryGeneration } from '../conversation-recovery.js';
import { flushRecoveryWrites } from '../recovery-writes.js';
import { adoptLegacySlot, applyCompositionTrack, compositionRoleKey, createCompositionDocument, createHistorySlot, readCompositionDocument, readTrackCompanion, retainCompositionDraftViews, saveCompositionDocument, SuccessionApplication, type CompositionApplicationContext, type CompositionDocument, type CompositionLocator, type CompositionParticipantResult, type CompositionSlot } from '../session-composition.js';
import type { ConversationConnections } from '../conversation-connections.js';
import type { DraftStore } from '../draft-store.js';
import type { TrackedSessionView, TrackedSessionViews } from '../tracked-session-views.js';
import type { SessionTracking } from './useSessionTracking.js';
import { isAskAttached, askParticipantKey, type useAskConversations } from './useAskConversations.js';
import type { SessionStars } from './useSessionStars.js';

type Selection = Pick<SessionEntry, 'hostId' | 'providerId' | 'nativeSessionId' | 'title'>;
interface NativeBinding {
  session: OpenedSession; client: RemoteSessionClient; replica: AgentReplica;
  isCurrent(): boolean; recipient?: ImageDraftRecipient; retireRecipient(): void; resumeRecipient(): void; stop(): void;
}
interface DesiredSelection {
  slot: CompositionSlot; target: CompositionLocator; revision: number; operationId?: string; roleKey?: string;
  title: string; sessionIntent?: 'history'; keepOriginal?: boolean;
}
interface SuccessionOptions {
  scope: string; transport: RemoteAgentTransport; enabled: boolean; initial?: ControllerLocation;
  connections: ConversationConnections; replicaFor(id: string): AgentReplica; views: TrackedSessionViews;
  textStore(scope: string): DraftStore; tracking(): SessionTracking; ask(): ReturnType<typeof useAskConversations>;
  known(): readonly OpenedSession[];
  legacyLayout?: { path: OpenedSession[]; focus?: string; anchor?: string; addressKey: string };
  layout(): { path: OpenedSession[]; selections: Record<string, string | null>; focus?: string; anchor?: string; address?: string; collapsed: string[] };
  retireNative(): void;
  bindNative(binding: NativeBinding): void;
  confirmed(session: OpenedSession): void;
}
const selectionFor = (slot: CompositionSlot): Omit<Selection, 'title'> => slot.intent.kind === 'legacy_fixed' ? slot.intent.target
  : { hostId: slot.intent.target.hostId, providerId: slot.intent.target.native.providerId, nativeSessionId: slot.intent.target.native.nativeSessionId };
const unavailable = (code: string): CompositionParticipantResult => ({ status: 'pending', retention: 'page', code });

/** Product ownership and binding glue. Composition participants perform no native work. */
export function useSessionSuccession(options: SuccessionOptions) {
  const [, render] = useReducer(value => value + 1, 0);
  const latest = useRef(options); latest.current = options;
  const supported = !!options.transport.fetchSessionSuccessions && !!options.transport.fetchSessionSuccessionCurrent && !!options.transport.fetchSessionSuccessionOperation
    && options.transport.sessionSuccessionSupport !== 'disabled';
  const runtime = useMemo(() => {
    const read = readCompositionDocument(options.scope);
    return {
      document: read.status === 'ready' ? read.document : createCompositionDocument(options.scope),
      readable: read.status === 'ready' || read.status === 'missing', unsupported: false, generation: recoveryGeneration(options.scope),
      mounted: true, authority: { active: options.enabled }, applications: new Map<string, SuccessionApplication>(),
      discovered: !supported, discovering: false, viewsRestored: false, importLegacy: read.status === 'missing', layoutRevision: 0, active: supported && !!options.initial?.nativeSessionId,
      initialStarted: false, sequence: 0, selection: undefined as Selection | undefined,
      intent: options.initial?.sessionIntent, keepOriginal: options.initial?.keepOriginal,
      desired: undefined as DesiredSelection | undefined, binding: undefined as NativeBinding | undefined,
      result: undefined as CompositionParticipantResult | undefined, error: undefined as string | undefined,
      replays: [] as SessionSuccessionReplay[], attempted: new Set<string>(), activeAttempt: undefined as string | undefined,
      favoritesHints: new Map<string, { revision: number; operationId: string; status: string }>(),
      metadata: undefined as AbortController | undefined, attachment: undefined as AbortController | undefined,
      askRecipients: new Map<string, { targetKey: string; participant: string; connection: unknown; recipient?: ImageDraftRecipient; retire(): void; update(): void; stop(): void }>(),
      trackPublication: undefined as { revision: number; retainedCurrent(): boolean; context: CompositionApplicationContext } | undefined,
    };
  }, [options.scope, options.transport]);
  const currentRuntime = useRef(runtime); currentRuntime.current = runtime;
  if (runtime.authority.active !== options.enabled) {
    runtime.authority.active = false;
    runtime.authority = { active: options.enabled };
    runtime.applications.clear();
    runtime.discovered = !supported;
  }
  const live = () => currentRuntime.current === runtime && runtime.mounted && runtime.authority.active
    && latest.current.scope === options.scope && latest.current.transport === options.transport
    && latest.current.enabled && recoveryGeneration(options.scope) === runtime.generation;
  const publish = () => { if (currentRuntime.current === runtime && runtime.mounted) render(); };
  function retireBinding() {
    runtime.binding?.stop(); runtime.binding = undefined; runtime.attachment?.abort(); runtime.attachment = undefined; runtime.activeAttempt = undefined;
    latest.current.retireNative();
  }
  function slotFor(selection: Selection, history = false): CompositionSlot | undefined {
    return runtime.document.slots.find(slot => (slot.intent.kind === 'history') === history && sessionKey(selectionFor(slot)) === sessionKey(selection));
  }
  function adoptKnown() {
    const known = latest.current.known();
    for (const source of known) {
      if (slotFor(source) || runtime.document.slots.some(slot => slot.intent.kind !== 'history' && slot.owners.text.key === source.agentId)) continue;
      const entry = latest.current.tracking().sessions.find(entry => sessionKey(entry) === sessionKey(source));
      runtime.document.slots.push(adoptLegacySlot(entry?.entryId ?? sessionKey(source), source, options.scope, sessionKey(source)));
      runtime.document.editRevision++;
    }
  }
  function captureLayout(legacy = false) {
    if (!live() || !runtime.readable || runtime.intent === 'history') return;
    const saved = legacy ? latest.current.legacyLayout : undefined;
    const current = saved ? { ...saved, selections: Object.fromEntries(saved.path.slice(0, -1).map((source, index) => [sessionKey(source), sessionKey(saved.path[index + 1]!)])),
      address: saved.addressKey, collapsed: [] as string[] } : latest.current.layout();
    if (!current.path.length) return;
    const slotByKey = new Map(current.path.map(source => [sessionKey(source), slotFor(source) ?? runtime.document.slots.find(slot => slot.owners.text.key === source.agentId)]));
    if ([...slotByKey.values()].some(slot => !slot)) return;
    const idFor = (key: string | undefined) => key ? slotByKey.get(key)?.id : undefined;
    const ids = new Set([...slotByKey.values()].map(slot => slot!.id));
    const edges = runtime.document.edges.filter(edge => !ids.has(edge.source));
    for (const [source, target] of Object.entries(current.selections)) {
      const from = idFor(source), to = target ? idFor(target) : undefined;
      if (from && to && from !== to) edges.push({ source: from, target: to, selected: true });
    }
    const next = { edges, collapsed: current.collapsed.map(idFor).filter((id): id is string => !!id),
      focus: idFor(current.focus), anchor: idFor(current.anchor), address: idFor(current.address) ?? idFor(sessionKey(current.path[0]!)) };
    if (JSON.stringify(next) === JSON.stringify({ edges: runtime.document.edges, collapsed: runtime.document.collapsed, focus: runtime.document.focus, anchor: runtime.document.anchor, address: runtime.document.address })) return;
    Object.assign(runtime.document, next); runtime.document.editRevision++;
    if (!legacy) {
      const revision = runtime.document.editRevision;
      const write = saveCompositionDocument(runtime.document, () => live() && runtime.document.editRevision === revision);
      flushRecoveryWrites(`agent-remote:recovery:${options.scope}:composition-v1`);
      void write.completion.then(result => { if (live() && result.status !== 'saved') { runtime.error = 'The current session layout could not be saved.'; publish(); } });
    }
  }
  function layoutView(): (TrackedSessionView & { primary: OpenedSession; sides: OpenedSession[] }) | undefined {
    const desired = runtime.desired;
    if (!desired || runtime.intent === 'history') return;
    const known = latest.current.known();
    const resolve = (id: string | undefined): OpenedSession | undefined => {
      const slot = runtime.document.slots.find(slot => slot.id === id);
      if (!slot) return;
      if (id === desired.slot.id && runtime.binding?.isCurrent()) return runtime.binding.session;
      return known.find(source => sessionKey(source) === sessionKey(selectionFor(slot))) ?? known.find(source => source.agentId === slot.owners.text.key);
    };
    const primary = resolve(desired.slot.id);
    if (!primary) return;
    const selections: Record<string, string | null> = {}, sides: OpenedSession[] = [];
    for (const edge of runtime.document.edges) {
      const source = resolve(edge.source), target = resolve(edge.target);
      if (!source || !target || !edge.selected) continue;
      selections[sessionKey(source)] = sessionKey(target);
      if (target.agentId !== primary.agentId && !sides.some(side => sessionKey(side) === sessionKey(target))) sides.push(target);
    }
    const focus = resolve(runtime.document.focus), anchor = resolve(runtime.document.anchor);
    return { primary, sides, selections, ...(focus ? { focus: sessionKey(focus) } : {}), ...(anchor ? { anchor: sessionKey(anchor) } : {}) };
  }
  function selectDesired(slot: CompositionSlot, target: CompositionLocator, revision: number, operationId?: string, roleKey?: string) {
    if (!live()) return;
    const previous = runtime.desired;
    if (previous && previous.slot.id === slot.id && previous.revision > revision) return;
    const identity = JSON.stringify([slot.id, target, revision, runtime.intent]);
    const oldIdentity = previous && JSON.stringify([previous.slot.id, previous.target, previous.revision, previous.sessionIntent]);
    if (identity === oldIdentity) { previous!.keepOriginal = runtime.keepOriginal; return; }
    retireBinding();
    runtime.active = true; runtime.layoutRevision++;
    if (!runtime.document.address) { runtime.document.address = slot.id; runtime.document.editRevision++; }
    runtime.desired = { slot, target, revision, operationId, roleKey, title: runtime.selection?.title ?? latest.current.known().find(source => source.agentId === slot.owners.text.key)?.title ?? 'Session',
      sessionIntent: runtime.intent, keepOriginal: runtime.keepOriginal };
    runtime.error = undefined; runtime.result = unavailable('reconciling');
    publish();
  }
  function admitReplay(replay: SessionSuccessionReplay) {
    if (!live() || runtime.intent === 'history' || !runtime.selection) return;
    const key = compositionRoleKey({ scope: options.scope, hostId: replay.to.hostId, controllerId: replay.projection.role.current.controllerId, roleId: replay.projection.role.id });
    const roleSlot = runtime.document.slots.find(slot => slot.intent.kind === 'role' && slot.intent.roleKey === key);
    const related = runtime.replays.filter(item => compositionRoleKey({ scope: options.scope, hostId: item.to.hostId,
      controllerId: item.projection.role.current.controllerId, roleId: item.projection.role.id }) === key);
    const selectionMatches = related.some(item => [item.from, item.to].some(target => sessionKey(target) === sessionKey(runtime.selection!)));
    if (!selectionMatches && (!roleSlot || runtime.desired?.slot.id !== roleSlot.id)) return;
    let slot = runtime.desired?.slot.intent.kind === 'role' && runtime.desired.slot.intent.roleKey === key ? runtime.desired.slot : roleSlot;
    const origin = replay.projection.role.origin;
    slot ??= slotFor({ hostId: replay.from.hostId, providerId: origin.providerId, nativeSessionId: origin.nativeSessionId, title: runtime.selection.title });
    if (!slot) {
      const id = `primary:${crypto.randomUUID()}`, owner = `draft:${id}`;
      slot = { id, intent: { kind: 'fixed', target: { hostId: replay.from.hostId, native: replay.projection.role.origin } },
        owners: { text: { scope: options.scope, key: owner }, image: { scope: options.scope, key: JSON.stringify([options.scope, owner]) }, display: { scope: options.scope, key: owner } } };
      runtime.document.slots.push(slot); runtime.document.editRevision++;
    }
    selectDesired(slot, { hostId: replay.to.hostId, native: replay.projection.role.current }, replay.projection.role.revision, replay.projection.receipt.operationId, key);
  }
  async function retainAsk(context: CompositionApplicationContext): Promise<CompositionParticipantResult> {
    const ask = latest.current.ask();
    const affected = [...context.slots, ...context.retained];
    const records = ask.store.all();
    for (let index = 0; index < affected.length; index++) {
      const source = latest.current.known().find(source => source.agentId === affected[index]!.owners.text.key);
      if (!source) continue;
      for (const record of records.filter(record => sessionKey(record.source) === sessionKey(source))) {
        const target = record.target;
        if (!target || !records.some(nested => sessionKey(nested.source) === sessionKey(target))) continue;
        const slot = slotFor(target);
        if (slot && !affected.some(value => value.id === slot.id)) affected.push(slot);
      }
    }
    for (const slot of affected) {
      const existing = ask.ownerIndex().owners.find(owner => owner.sourceSlot === slot.id);
      if (existing || slot.intent.kind === 'history') continue;
      const source = latest.current.known().find(source => source.agentId === slot.owners.text.key);
      if (!source) continue;
      const key = sessionKey(source), entry = ask.entryFor(source), target = entry.record?.target;
      const descriptor = { id: `ask:${slot.id}`, sourceSlot: slot.id, stateScope: options.scope, legacySourceKey: key,
        geometryScope: JSON.stringify([options.scope, key]), text: { scope: `${options.scope}:ask`, key },
        ...(target ? { image: { scope: options.scope, key: JSON.stringify([options.scope, sessionKey(target)]) }, display: { scope: options.scope, key: sessionKey(target) } } : {}) };
      const adopted = await ask.adoptAssociationOwner(descriptor, source, context.isCurrent);
      if (adopted.status !== 'applied') return adopted;
    }
    return ask.retainAssociationOwners(ask.ownerIndex().owners.filter(owner => affected.some(slot => slot.id === owner.sourceSlot)).map(owner => owner.id), context.isCurrent);
  }
  function application(replay: SessionSuccessionReplay) {
    const hostId = replay.to.hostId, controllerId = replay.projection.role.current.controllerId;
    const key = JSON.stringify([hostId, controllerId]);
    let value = runtime.applications.get(key);
    if (!value) {
      const authority = runtime.authority;
      value = new SuccessionApplication(runtime.document, { scope: options.scope, hostId, controllerId, isCurrent: () => live() && runtime.authority === authority }, {
        draftViews: context => retainCompositionDraftViews(context, scope => latest.current.textStore(scope)),
        ask: retainAsk,
        track: async context => {
          const result = await applyCompositionTrack(context, latest.current.views);
          if (result.status === 'applied' && result.retainedCurrent?.() && context.isCurrent()) {
            runtime.trackPublication = { revision: latest.current.tracking().editRevision(), retainedCurrent: result.retainedCurrent, context };
          }
          return result;
        },
      });
      runtime.applications.set(key, value);
    }
    return value;
  }
  function restoreTrackViews(isCurrent: () => boolean): boolean {
    const read = readTrackCompanion(options.scope);
    if (read.status === 'missing') return true;
    if (read.status !== 'ready') return false;
    const views = latest.current.views, before = views.snapshot();
    const known = latest.current.known();
    const resolve = (id: string): SessionEntry | undefined => {
      const slot = runtime.document.slots.find(slot => slot.id === id);
      if (!slot) return undefined;
      const identity = selectionFor(slot);
      const actual = known.find(source => sessionKey(source) === sessionKey(identity));
      return { ...identity, title: actual?.title ?? 'Session', ...(actual ? { agentId: actual.agentId } : {}) };
    };
    const restored = read.document.views.map(entry => {
      const primary = resolve(entry.primarySlot);
      return primary ? { entryId: entry.entryId, view: { primary, selections: { ...entry.selections }, focus: entry.focus, anchor: entry.anchor } } : undefined;
    });
    const bindings = read.document.entries.map(entry => { const primary = resolve(entry.slotId); return primary ? { nativeKey: sessionKey(primary), entryId: entry.entryId } : undefined; });
    if (restored.some(entry => !entry) || bindings.some(entry => !entry)) return false;
    return views.restore({ editRevision: before.editRevision, selected: read.document.selected,
      views: restored.filter((entry): entry is NonNullable<typeof entry> => !!entry), bindings: bindings.filter((entry): entry is NonNullable<typeof entry> => !!entry) }, before.editRevision, isCurrent);
  }
  async function attachDesired(explicit = false): Promise<void> {
    const desired = runtime.desired;
    if (!live() || !desired || runtime.result?.status !== 'applied') return;
    const attempt = JSON.stringify([desired.slot.id, desired.target, desired.revision]);
    if (!explicit && runtime.attempted.has(attempt)) return;
    runtime.attempted.add(attempt); retireBinding(); runtime.activeAttempt = attempt;
    const authority = runtime.authority;
    const controller = new AbortController(); runtime.attachment = controller;
    const current = () => live() && runtime.authority === authority && runtime.desired === desired && runtime.attachment === controller && !controller.signal.aborted;
    runtime.error = undefined; publish();
    try {
      const identity = { hostId: desired.target.hostId, providerId: desired.target.native.providerId, nativeSessionId: desired.target.native.nativeSessionId };
      const cached = latest.current.connections.find(identity);
      const cachedAgent = cached?.replica.getState().agent;
      const reusable = cached && cachedAgent?.id === cached.agentId && cachedAgent.providerId === identity.providerId
        && cachedAgent.runtimeInfo.providerId === identity.providerId && cachedAgent.runtimeInfo.sessionId === identity.nativeSessionId;
      const response = reusable ? { agentId: cached.agentId } : await new SessionDirectoryClient(options.scope, undefined, identity.hostId)
        .attach(identity.providerId, identity.nativeSessionId, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
      if (!current()) return;
      if (response.nativeSessionId !== undefined && response.nativeSessionId !== identity.nativeSessionId) throw new Error('The Host returned a different native session.');
      const session: OpenedSession = { ...identity, agentId: response.agentId, title: desired.title };
      const lease = latest.current.connections.acquire(session.agentId, latest.current.replicaFor(session.agentId), session);
      let stopped = false, imageLifetime: { active: boolean } | undefined, imageEpoch: string | null | undefined;
      const exactIdentity = () => {
        const state = lease.replica.getState(), agent = state.agent;
        return current() && !stopped && agent?.id === session.agentId && agent.providerId === identity.providerId
          && agent.runtimeInfo.providerId === identity.providerId && agent.runtimeInfo.sessionId === identity.nativeSessionId;
      };
      let confirmed = false;
      const synchronized = () => {
        const state = lease.replica.getState(), native = lease.client.getSessionState();
        return exactIdentity() && state.timeline.initialized && !!state.timeline.epoch && native.synchronized
          && native.runtime?.state === 'connected' && !native.controlChecking && !native.recovering;
      };
      const viewCurrent = () => confirmed && exactIdentity();
      const imageCurrent = () => synchronized() && lease.client.getSessionState().operations.send_message.allowed && !lease.client.getSessionState().readOnly;
      const stops: Array<() => void> = [];
      const confirmationDeadline = setTimeout(() => {
        if (!current() || confirmed) return;
        runtime.error = 'The native session identity could not be confirmed.'; binding.stop(); publish();
      }, 15000);
      const binding: NativeBinding = { session, client: lease.client, replica: lease.replica, isCurrent: viewCurrent,
        resumeRecipient() { update(); },
        retireRecipient() { if (imageLifetime) imageLifetime.active = false; imageLifetime = undefined; binding.recipient = undefined; },
        stop() { if (stopped) return; stopped = true; clearTimeout(confirmationDeadline); if (imageLifetime) imageLifetime.active = false; for (const stop of stops) stop(); lease.release(); } };
      const update = () => {
        if (stopped || !current()) { if (imageLifetime) imageLifetime.active = false; return; }
        const state = lease.replica.getState(), epoch = state.timeline.epoch;
        if (imageLifetime && (!imageCurrent() || imageEpoch !== epoch)) { imageLifetime.active = false; imageLifetime = undefined; binding.recipient = undefined; }
        if (!imageLifetime && imageCurrent()) {
          const lifetime = { active: true }; imageLifetime = lifetime; imageEpoch = epoch;
          binding.recipient = { identity: JSON.stringify([options.scope, desired.slot.id, desired.revision, desired.target, session.agentId]), lifetime,
            isCurrent: () => lifetime.active && imageLifetime === lifetime && imageCurrent() && lease.replica.getState().timeline.epoch === epoch };
        }
        if (synchronized() && !confirmed) {
          confirmed = true; clearTimeout(confirmationDeadline); runtime.error = undefined;
          latest.current.bindNative(binding); latest.current.confirmed(session);
          const ask = latest.current.ask();
          for (const owner of ask.ownerIndex().owners.filter(owner => owner.sourceSlot === desired.slot.id)) {
            const revision = ask.ownerEditRevision(owner.id);
            ask.applySourceProjection(owner.id, session, revision, viewCurrent);
          }
        } else if (state.agent && !exactIdentity()) runtime.error = 'The native session identity could not be confirmed.';
        publish();
      };
      runtime.binding = binding;
      stops.push(lease.replica.subscribe(update));
      stops.push(lease.client.subscribeSessionState(update));
      update();
    } catch (error) {
      if (current()) { runtime.activeAttempt = undefined; runtime.error = error instanceof Error ? error.message : 'The session could not be opened.'; publish(); }
    }
  }
  async function discover(): Promise<void> {
    if (!live() || !supported || runtime.unsupported) return;
    const sequence = ++runtime.sequence, authority = runtime.authority;
    runtime.metadata?.abort(); const controller = new AbortController(); runtime.metadata = controller;
    const current = () => live() && runtime.authority === authority && runtime.sequence === sequence && !controller.signal.aborted;
    const request = { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) };
    runtime.discovering = true; runtime.discovered = false; publish();
    try {
      if (!runtime.readable) throw new Error('Saved session composition is unreadable or unsupported. Its original data has been preserved.');
      const all: SessionSuccessionReplay[] = [], cursors = new Set<string>(); let cursor: string | undefined;
      do {
        const page = await options.transport.fetchSessionSuccessions!({ limit: 64, ...(cursor ? { cursor } : {}) }, request);
        if (!current()) return;
        all.push(...page.successions);
        if (all.length > 1024) throw new Error('Session succession replay exceeded the retained limit.');
        cursor = page.nextCursor ?? undefined;
        if (cursor && cursors.has(cursor)) throw new Error('Session succession replay did not advance.');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      runtime.replays = all;
      adoptKnown();
      if (runtime.importLegacy) { captureLayout(true); runtime.importLegacy = false; }
      if (runtime.intent === 'history') {
        const selected = runtime.selection;
        const match = selected && all.find(replay => [replay.from, replay.to].some(endpoint => sessionKey(endpoint) === sessionKey(selected)));
        if (match && selected) {
          const target = { hostId: selected.hostId ?? match.from.hostId, native: sessionKey(match.from) === sessionKey(selected) ? match.projection.receipt.from : match.projection.role.current };
          let slot = slotFor(selected, true);
          if (!slot) { slot = createHistorySlot(crypto.randomUUID(), target, options.scope); runtime.document.slots.push(slot); runtime.document.editRevision++; }
          selectDesired(slot, target, 0);
          if (runtime.document.address !== slot.id) { runtime.document.address = slot.id; runtime.document.editRevision++; }
          const save = saveCompositionDocument(runtime.document, current); flushRecoveryWrites(`agent-remote:recovery:${options.scope}:composition-v1`);
          const result = await save.completion;
          if (!current()) return;
          runtime.result = result.status === 'saved' ? { status: 'applied', retention: result.retention } : unavailable('history_write');
        }
      } else {
        const latestByRole = new Map<string, SessionSuccessionReplay>();
        for (const replay of all) {
          const key = compositionRoleKey({ scope: options.scope, hostId: replay.to.hostId, controllerId: replay.projection.role.current.controllerId, roleId: replay.projection.role.id });
          if ((latestByRole.get(key)?.projection.role.revision ?? 0) < replay.projection.role.revision) latestByRole.set(key, replay);
        }
        for (const replay of latestByRole.values()) admitReplay(replay);
        if (!runtime.viewsRestored) {
          if (!restoreTrackViews(current)) throw new Error('Saved Track views could not be recovered.');
          runtime.viewsRestored = true;
        }
        for (const replay of latestByRole.values()) {
          if (!current()) return;
          runtime.trackPublication = undefined;
          const applicationInstance = application(replay);
          const result = await applicationInstance.recover(replay.projection.role.id, {
            fetchSessionSuccessionOperation: (roleId, operationId) => options.transport.fetchSessionSuccessionOperation!(roleId, operationId, request),
            fetchSessionSuccessionCurrent: async roleId => {
              const value = await options.transport.fetchSessionSuccessionCurrent!(roleId, request);
              if (current() && runtime.desired?.roleKey === compositionRoleKey({ scope: options.scope, hostId: value.locator.hostId, controllerId: value.role.current.controllerId, roleId }) && value.locator.hostId === replay.to.hostId && value.role.current.controllerId === replay.projection.role.current.controllerId) {
                selectDesired(runtime.desired.slot, { hostId: value.locator.hostId, native: value.role.current }, value.role.revision, undefined, runtime.desired.roleKey);
              }
              return value;
            },
            fetchSessionSuccessions: query => options.transport.fetchSessionSuccessions!(query, request),
          });
          if (!current()) return;
          const publication = runtime.trackPublication as { revision: number; retainedCurrent(): boolean; context: CompositionApplicationContext } | undefined;
          let accepted = result;
          if (result.status === 'applied' && publication) {
            const checkpoint = publication.context.checkpoint, documentRevision = runtime.document.editRevision;
            const guard = () => current() && runtime.applications.get(JSON.stringify([replay.to.hostId, replay.projection.role.current.controllerId])) === applicationInstance
              && runtime.trackPublication === publication && publication.retainedCurrent() && runtime.document.editRevision === documentRevision
              && runtime.document.roles.includes(checkpoint) && checkpoint.appliedRevision === checkpoint.desired.committedRevision;
            const refreshed = flushSync(() => latest.current.tracking().refresh(publication.revision, guard));
            if (refreshed.status !== 'ready') accepted = unavailable(`track_publish_${refreshed.code}`);
            else if (JSON.stringify(latest.current.tracking().sessions) !== JSON.stringify(refreshed.sessions)) accepted = unavailable('track_publish_uncommitted');
          }
          const roleKey = compositionRoleKey({ scope: options.scope, hostId: replay.to.hostId, controllerId: replay.projection.role.current.controllerId, roleId: replay.projection.role.id });
          if (runtime.desired?.slot.intent.kind === 'role' && runtime.desired.slot.intent.roleKey === roleKey) runtime.result = accepted;
        }
      }
      if (!current()) return;
      runtime.discovered = true;
      if (!runtime.desired) runtime.active = false;
      if (runtime.desired && runtime.result?.status !== 'applied') runtime.error = `Session composition needs synchronization (${runtime.result?.code ?? 'pending'}).`;
      if (runtime.desired && runtime.result?.status === 'applied') {
        runtime.layoutRevision++;
        void attachDesired();
      }
    } catch (error) {
      if (current()) {
        if (!runtime.desired && !runtime.document.roles.length && error && typeof error === 'object' && 'code' in error && ['http_404', 'route_not_found'].includes(String(error.code))) {
          runtime.unsupported = true; runtime.active = false; runtime.discovered = true; runtime.error = undefined;
        } else { runtime.error = error instanceof Error ? error.message : 'Session succession could not be recovered.'; runtime.result = unavailable('replay_unavailable'); }
      }
    } finally { if (current()) { runtime.discovering = false; publish(); } }
  }
  async function open(selection: Selection, intent?: 'history', keepOriginal?: boolean): Promise<boolean> {
    if (!live() || !supported || runtime.unsupported) return false;
    const desired = runtime.desired;
    const sameRole = intent !== 'history' && runtime.intent !== 'history' && desired?.roleKey && (
      sessionKey(selection) === sessionKey({ hostId: desired.target.hostId, ...desired.target.native })
      || runtime.replays.some(replay => compositionRoleKey({ scope: options.scope, hostId: replay.to.hostId,
        controllerId: replay.projection.role.current.controllerId, roleId: replay.projection.role.id }) === desired.roleKey
        && [replay.from, replay.to].some(target => sessionKey(target) === sessionKey(selection))));
    runtime.selection = selection; runtime.intent = intent; runtime.keepOriginal = keepOriginal;
    if (!sameRole) {
      runtime.desired = undefined; runtime.result = undefined; runtime.error = undefined; retireBinding();
    }
    runtime.active = true; publish();
    await discover();
    return runtime.active;
  }
  function leave() {
    runtime.sequence++; runtime.metadata?.abort(); retireBinding(); runtime.desired = undefined; runtime.active = false; publish();
  }
  function canPrune(favorites: SessionStars, session: Selection): boolean {
    if (!live() || !runtime.discovered || runtime.discovering || !favorites.ready || favorites.scope !== options.scope) return false;
    const roles = runtime.document.slots.filter(slot => slot.intent.kind === 'role' && sessionKey(selectionFor(slot)) === sessionKey(session));
    const lineage = runtime.replays.filter(replay => [replay.from, replay.to].some(target => sessionKey(target) === sessionKey(session)));
    const keys = new Set([...roles.map(slot => slot.intent.kind === 'role' ? slot.intent.roleKey : ''), ...lineage.map(replay => compositionRoleKey({ scope: options.scope, hostId: replay.to.hostId, controllerId: replay.projection.role.current.controllerId, roleId: replay.projection.role.id }))]);
    return [...keys].every(key => {
      const role = runtime.document.roles.find(role => compositionRoleKey(role) === key);
      return role && role.appliedRevision === role.desired.committedRevision && favorites.successionProgress?.roles.some(checkpoint => checkpoint.hostId === role.hostId
        && checkpoint.controllerId === role.controllerId && checkpoint.roleId === role.roleId && checkpoint.roleRevision === role.desired.committedRevision
        && checkpoint.operationId === role.desired.operationId && checkpoint.status === 'applied');
    });
  }
  function observeFavorites(favorites: SessionStars) {
    if (!live() || !supported || !runtime.discovered || runtime.discovering || !favorites.ready || favorites.scope !== options.scope) return;
    let newer = false;
    for (const progress of favorites.successionProgress?.roles ?? []) {
      const key = compositionRoleKey({ scope: options.scope, hostId: progress.hostId, controllerId: progress.controllerId, roleId: progress.roleId });
      const role = runtime.document.roles.find(role => compositionRoleKey(role) === key);
      if (!role || progress.roleRevision <= role.appliedRevision) continue;
      const previous = runtime.favoritesHints.get(key);
      if (previous && (previous.revision > progress.roleRevision || previous.revision === progress.roleRevision
        && previous.operationId === progress.operationId && previous.status === progress.status)) continue;
      runtime.favoritesHints.set(key, { revision: progress.roleRevision, operationId: progress.operationId, status: progress.status });
      newer = true;
    }
    if (newer) void discover();
  }
  function ownerFor(source: Selection) {
    const ask = latest.current.ask();
    const owner = ask.ownerIndex().owners.find(owner => owner.legacySourceKey === sessionKey(source));
    if (owner) return owner.id;
    const slot = slotFor(source) ?? (runtime.desired && sessionKey({ hostId: runtime.desired.target.hostId, ...runtime.desired.target.native }) === sessionKey(source) ? runtime.desired.slot : undefined);
    return slot && ask.ownerIndex().owners.find(owner => owner.sourceSlot === slot.id)?.id;
  }
  function reconcileAskRecipients() {
    const entries = latest.current.ask().entries;
    const targets = new Map([...entries].flatMap(([owner, entry]) => isAskAttached(entry) && entry.record?.target ? [[owner, { entry, target: entry.record.target }] as const] : []));
    for (const [owner, supplier] of runtime.askRecipients) {
      const next = targets.get(owner);
      if (!next || !live() || supplier.participant !== askParticipantKey(next.entry.record!)
        || supplier.connection !== latest.current.connections.find(next.target)) { supplier.stop(); runtime.askRecipients.delete(owner); }
    }
    if (!live()) return;
    for (const [owner, value] of targets) {
      if (runtime.askRecipients.has(owner)) continue;
      const connection = latest.current.connections.find(value.target);
      if (!connection || connection.agentId !== value.target.agentId) continue;
      const authority = runtime.authority, target = value.target, participant = value.entry.record!, key = sessionKey(target);
      let stopped = false, lifetime: { active: boolean } | undefined, epoch: string | null | undefined;
      const eligible = () => {
        const entry = latest.current.ask().entries.get(owner), state = connection.replica.getState(), native = connection.client.getSessionState(), agent = state.agent;
        return live() && runtime.authority === authority && !stopped && isAskAttached(entry) && entry?.record?.id === participant.id
          && entry.record.target?.agentId === target.agentId && sessionKey(entry.record.target) === key
          && latest.current.connections.find(target) === connection && agent?.id === target.agentId && agent.providerId === target.providerId
          && agent.runtimeInfo.providerId === target.providerId && agent.runtimeInfo.sessionId === target.nativeSessionId
          && state.timeline.initialized && !!state.timeline.epoch && native.synchronized && native.runtime?.state === 'connected'
          && !native.controlChecking && !native.recovering && !native.readOnly && native.operations.send_message.allowed;
      };
      const stops: Array<() => void> = [];
      const supplier = {
        targetKey: key, participant: askParticipantKey(participant), connection,
        recipient: undefined as ImageDraftRecipient | undefined,
        retire() { if (lifetime) lifetime.active = false; lifetime = undefined; supplier.recipient = undefined; },
        update() {
          const nextEpoch = connection.replica.getState().timeline.epoch;
          if (lifetime && (!eligible() || nextEpoch !== epoch)) supplier.retire();
          if (!lifetime && eligible()) {
            const captured = { active: true }; lifetime = captured; epoch = nextEpoch;
            supplier.recipient = { identity: JSON.stringify([options.scope, owner, participant.id, key, target.agentId]), lifetime: captured,
              isCurrent: () => captured.active && lifetime === captured && eligible() && connection.replica.getState().timeline.epoch === nextEpoch };
          }
          publish();
        },
        stop() { stopped = true; supplier.retire(); for (const stop of stops) stop(); },
      };
      runtime.askRecipients.set(owner, supplier);
      stops.push(connection.replica.subscribe(supplier.update), connection.client.subscribeSessionState(supplier.update));
      supplier.update();
    }
  }
  useEffect(() => { reconcileAskRecipients(); });
  useEffect(() => {
    runtime.mounted = true;
    if (live() && supported) {
      if (!runtime.initialStarted) {
        runtime.initialStarted = true;
        const target = options.initial;
        if (target?.providerId && target.nativeSessionId) runtime.selection = { hostId: target.hostId, providerId: target.providerId, nativeSessionId: target.nativeSessionId, title: latest.current.known().find(source => sessionKey(source) === sessionKey(target as Selection))?.title ?? 'Session' };
      }
      void discover();
    }
    const stopConnections = options.connections.subscribe(reconcileAskRecipients);
    const stop = options.transport.onSessionSuccession?.(() => {
      if (live() && supported) void discover();
    });
    const resume = watchPageResume(() => { if (live() && supported) { runtime.binding?.resumeRecipient(); for (const supplier of runtime.askRecipients.values()) supplier.update(); void discover(); } }, () => {
      runtime.binding?.retireRecipient(); for (const supplier of runtime.askRecipients.values()) supplier.retire();
    });
    return () => {
      runtime.mounted = false; runtime.sequence++; runtime.metadata?.abort(); runtime.attachment?.abort(); runtime.binding?.stop();
      if (runtime.activeAttempt) runtime.attempted.delete(runtime.activeAttempt);
      runtime.activeAttempt = undefined; runtime.binding = undefined; stop?.(); resume(); stopConnections();
      for (const supplier of runtime.askRecipients.values()) supplier.stop(); runtime.askRecipients.clear();
    };
  }, [runtime, options.enabled]);
  const bound = runtime.binding?.isCurrent() ? runtime.binding : undefined;
  const desired = runtime.desired, selection = runtime.selection;
  const selected: SessionEntry | undefined = desired ? { hostId: desired.target.hostId, providerId: desired.target.native.providerId, nativeSessionId: desired.target.native.nativeSessionId,
    title: desired.title, ...(bound ? { agentId: bound.session.agentId } : {}) } : undefined;
  return {
    active: supported && runtime.active && (options.enabled || !!desired), discovering: options.enabled && supported && (!runtime.discovered || runtime.discovering), document: runtime.document, desired, selected,
    state: bound?.replica.getState(), sessionState: bound?.client.getSessionState() ?? remoteSessionState(undefined, 'idle'),
    layoutView, layoutRevision: runtime.layoutRevision, captureLayout, binding: bound, imageRecipient: bound?.recipient, error: runtime.error, result: runtime.result,
    observerReady: !supported || live() && runtime.discovered && !runtime.discovering && (!runtime.active || !!bound),
    isCurrent: () => !!runtime.binding?.isCurrent(), open, leave, refresh: discover, canPrune, observeFavorites,
    retry: () => { if (!live()) return; if (runtime.result?.status === 'applied') void attachDesired(true); else void discover(); },
    ownerFor,
    recipientFor: (target: Selection, owner?: string) => {
      const supplier = owner ? runtime.askRecipients.get(owner) : [...runtime.askRecipients.values()].find(value => value.targetKey === sessionKey(target));
      return supplier?.targetKey === sessionKey(target) ? supplier.recipient : undefined;
    },
    sourceCurrent: (source: OpenedSession) => {
      if (!supported) return true;
      const primarySource = desired ? desired.slot.owners.text.key === source.agentId
        || bound?.session.agentId === source.agentId && sessionKey(bound.session) === sessionKey(source)
        : selection && sessionKey(selection) === sessionKey(source);
      if (primarySource) return live() && runtime.desired === desired && runtime.selection === selection && (desired
        ? !!runtime.binding?.isCurrent() && runtime.binding.session.agentId === source.agentId && sessionKey(runtime.binding.session) === sessionKey(source)
        : !runtime.active && runtime.discovered);
      return !runtime.active || live();
    },
  };
}
