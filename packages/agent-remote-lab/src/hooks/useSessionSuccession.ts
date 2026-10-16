import { bindWindowCompositionSlot, ensureWindowCompositionSlot, projectWindowComposition } from '../window-composition.js';
import type { WindowSessionBinding, WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { applyConversationLayout, type ConversationLayout } from '../conversation-layout.js';
import { flushSync } from 'react-dom';
import { useEffect, useMemo, useReducer, useRef } from 'react';
import { isSessionSuccessionCurrent, isSessionSuccessionReplay, nativeSessionRefKey, resolveNativePrefix, type SessionSuccessionCurrent, type SessionSuccessionReplay } from '@orchardworks/agent-remote-protocol';
import { remoteSessionState, watchPageResume, type AgentReplica, type AgentReplicaState, type RemoteAgentTransport, type RemoteSessionClient, type RemoteSessionState } from '@orchardworks/agent-remote-web';
import type { ImageDraftRecipient } from '@orchardworks/agent-remote-web/browser';
import type { ControllerLocation } from '@orchardworks/agent-remote-hosted/controller-location';
import { SessionDirectoryClient, type OpenedSession, type SuccessionActionResult } from '../directory-client.js';
import { restoreSession } from '../session-restoration.js';
import { sessionKey, type SessionEntry } from '../session-tree.js';
import { recoveryGeneration } from '../conversation-recovery.js';
import { flushRecoveryWrites } from '../recovery-writes.js';
import { bindCompositionView, applyCompositionTrack, compositionOriginId, compositionRoleKey, createCompositionDocument, createHistorySlot, initializeCompositionDocument, compositionMetadataKey, compositionSelection, compositionSession, compositionSessionMetadata, createCompositionSlot, createAskOwner, retainCompositionDraftViews, saveCompositionDocument, SuccessionApplication, type CompositionApplicationContext, type CompositionDocument, type CompositionLocator, type CompositionParticipantResult, type CompositionSlot } from '../session-composition.js';
import type { ConversationConnections } from '../conversation-connections.js';
import type { DraftStore } from '../draft-store.js';
import type { TrackedSessionView } from '../tracked-session-views.js';
import type { SessionTracking } from './useSessionTracking.js';
import { isAskAttached, askParticipantKey, type useAskConversations } from './useAskConversations.js';
import type { SessionStars } from './useSessionStars.js';
import { canonicalJson } from '../session-composition.js';
import { readWorkspaceSnapshot, saveWorkspaceSnapshot, workspaceDisplayState } from '../workspace-cache.js';

type Selection = Pick<SessionEntry, 'hostId' | 'providerId' | 'nativeSessionId' | 'title'> & Partial<Pick<OpenedSession, 'agentId' | 'parentAgentId' | 'parentNativeSessionId' | 'createdAt'>> & { viewId?: string };
interface NativeBinding {
  session: OpenedSession & { viewId: string }; client: RemoteSessionClient; replica: AgentReplica;
  getSessionState(): RemoteSessionState;
  isCurrent(): boolean; isSynchronized(): boolean; recipient?: ImageDraftRecipient; retireRecipient(): void; resumeRecipient(): void; stop(): void;
}
interface DesiredSelection {
  slot: CompositionSlot; target: CompositionLocator; revision: number; operationId?: string; roleKey?: string;
  title: string; sessionIntent?: 'history'; keepOriginal?: boolean;
}
interface SuccessionOptions {
  scope: string; transport: RemoteAgentTransport; enabled: boolean; initial?: ControllerLocation;
  initialDisplayState?: AgentReplicaState;
  initialLayout?: ConversationLayout;
  connections: ConversationConnections; replicaFor(id: string): AgentReplica;
  validateTarget?(selection: SessionEntry, viewId: string, document: CompositionDocument): void;
  targetRevision?: string;
  cachedReplicaFor?(selection: Selection): AgentReplica | undefined;
  directory(hostId: string): SessionDirectoryClient;
  textStore(scope: string): DraftStore; tracking(): SessionTracking; ask(): ReturnType<typeof useAskConversations>;
  layout(): { path: OpenedSession[]; selections: Record<string, string | null>; focus?: string; anchor?: string; address?: string; collapsed: string[] };
  retireNative(): void;
  bindNative(binding: NativeBinding): void;
  confirmed(session: OpenedSession & { viewId: string }): void;
  failed(error: unknown, selection: Selection, retrying?: boolean): void;
}
const selectionFor = compositionSelection;
const identityConfirmationError = 'The native session identity could not be confirmed.';
const unavailable = (code: string): CompositionParticipantResult => ({ status: 'pending', retention: 'page', code });

export interface SessionSuccessionHistoryNavigation {
  roleKey: string; history: boolean; session: SessionEntry; current: SessionEntry;
  predecessor?: SessionEntry; ancestors: SessionEntry[];
}
/** Historical addresses require a complete, authorized chain through its confirmed current role. */
export function sessionSuccessionHistory({ scope, replays, current, selected, intent, titles }: {
  scope: string; replays: readonly SessionSuccessionReplay[]; current?: SessionSuccessionCurrent;
  selected: SessionEntry; intent?: 'history'; titles?: ReadonlyMap<string, string>;
}): SessionSuccessionHistoryNavigation | undefined {
  if (!isSessionSuccessionCurrent(current)) return;
  const chain = replays.filter(replay => replay.projection.role.id === current.role.id && replay.to.hostId === current.locator.hostId
    && replay.projection.role.current.controllerId === current.role.current.controllerId).sort((left, right) => left.projection.role.revision - right.projection.role.revision);
  if (!chain.length || !chain.every(isSessionSuccessionReplay)) return;
  for (let index = 0; index < chain.length; index++) {
    const replay = chain[index]!, previous = chain[index - 1];
    if (canonicalJson(replay.projection.role.origin) !== canonicalJson(current.role.origin)
      || canonicalJson(replay.projection.role.workspace) !== canonicalJson(current.role.workspace)) return;
    if (previous ? previous.projection.role.revision !== replay.projection.receipt.expectedRevision
      || nativeSessionRefKey(previous.projection.role.current) !== nativeSessionRefKey(replay.projection.receipt.from)
      : replay.projection.receipt.expectedRevision !== 1 || nativeSessionRefKey(replay.projection.receipt.from) !== nativeSessionRefKey(current.role.origin)) return;
  }
  if (canonicalJson(chain.at(-1)!.projection.role) !== canonicalJson(current.role)) return;
  const targets = [chain[0]!.from, ...chain.map(replay => replay.to)];
  const keys = targets.map(sessionKey), index = keys.indexOf(sessionKey(selected));
  if (new Set(keys).size !== keys.length || index < 0 || intent !== 'history' && index !== targets.length - 1) return;
  const resolve = (target: typeof targets[number]): SessionEntry => ({ ...target, title: titles?.get(sessionKey(target))?.trim() || target.nativeSessionId });
  return { roleKey: compositionRoleKey({ scope, hostId: current.locator.hostId, controllerId: current.role.current.controllerId, roleId: current.role.id }),
    history: intent === 'history' && index < targets.length - 1, session: resolve(targets[index]!), current: resolve(current.locator),
    predecessor: index > 0 ? resolve(targets[index - 1]!) : undefined, ancestors: targets.slice(0, Math.max(0, index - 1)).reverse().map(resolve) };
}

/** Product ownership and binding glue. Composition participants perform no native work. */
export function useSessionSuccession(options: SuccessionOptions) {
  const [, render] = useReducer(value => value + 1, 0);
  const latest = useRef(options); latest.current = options;
  const supported = !!options.transport.fetchSessionSuccessions && !!options.transport.fetchSessionSuccessionCurrent && !!options.transport.fetchSessionSuccessionOperation
    && options.transport.sessionSuccessionSupport !== 'disabled';
  const runtime = useMemo(() => {
    const read = initializeCompositionDocument(options.scope);
    return {
      document: read.status === 'ready' ? read.document : createCompositionDocument(options.scope),
      readable: read.status === 'ready' || read.status === 'missing', unsupported: false, generation: recoveryGeneration(options.scope),
      sharedWindow: undefined as WorkspaceWindow | undefined, windowProjectionRevision: -1, mounted: true, authority: { active: options.enabled }, applications: new Map<string, SuccessionApplication>(),
      discovered: false, discovering: false, layoutRevision: 0, active: !!options.initial?.nativeSessionId,
      initialStarted: false, sequence: 0, settledDiscoverySequence: 0, selection: undefined as Selection | undefined,
      selectedSlot: undefined as string | undefined, navigationAttempt: false,
      navigationLease: undefined as { key: string; release(): void } | undefined,
      intent: options.initial?.sessionIntent, keepOriginal: options.initial?.keepOriginal,
      desired: undefined as DesiredSelection | undefined, binding: undefined as NativeBinding | undefined,
      display: undefined as { key: string; state?: AgentReplicaState; diskRead: boolean } | undefined,
      takeover: undefined as { generation?: string; restored?: () => void } | undefined,
      attached: undefined as OpenedSession | undefined,
      result: undefined as CompositionParticipantResult | undefined, error: undefined as string | undefined,
      discoveryError: undefined as string | undefined,
      replays: [] as SessionSuccessionReplay[], attempted: new Set<string>(), activeAttempt: undefined as string | undefined, targetUnavailable: false,
      historyEvidence: new Map<string, { replays: SessionSuccessionReplay[]; current: SessionSuccessionCurrent }>(),
      historyTitles: new Map<string, string>(),
      refreshObservers: new Set<() => void>(),
      favoritesHints: new Map<string, { revision: number; operationId: string; status: string }>(),
      metadata: undefined as AbortController | undefined, attachment: undefined as AbortController | undefined,
      navigation: undefined as AbortController | undefined,
      askRecipients: new Map<string, { targetKey: string; participant: string; connection: unknown; recipient?: ImageDraftRecipient; retire(): void; update(): void; stop(): void }>(),
      sides: new Map<string, OpenedSession & { viewId: string }>(), sideRequests: new Map<string, AbortController>(), sideAttempted: new Set<string>(),
      trackPublication: undefined as { revision: number; retainedCurrent(): boolean; context: CompositionApplicationContext } | undefined,
    };
  }, [options.scope, options.transport]);
  const currentRuntime = useRef(runtime); currentRuntime.current = runtime;
  if (runtime.authority.active !== options.enabled) {
    runtime.authority.active = false;
    runtime.authority = { active: options.enabled };
    runtime.applications.clear();
    runtime.discovered = false;
  }
  const live = () => currentRuntime.current === runtime && runtime.mounted && runtime.authority.active
    && latest.current.scope === options.scope && latest.current.transport === options.transport
    && latest.current.enabled && recoveryGeneration(options.scope) === runtime.generation;
  const publish = () => {
    for (const observer of runtime.refreshObservers) observer();
    if (currentRuntime.current === runtime && runtime.mounted) render();
  };
  function retireBinding(next?: Selection) {
    const key = next && sessionKey(next), previous = runtime.binding;
    if (live() && previous?.isCurrent()) {
      const state = previous.replica.getState();
      setTimeout(() => {
        if (recoveryGeneration(options.scope) === runtime.generation) saveWorkspaceSnapshot(options.scope, previous.session, state);
      }, 0);
    }
    if (runtime.navigationLease?.key !== key) { runtime.navigationLease?.release(); runtime.navigationLease = undefined; }
    if (key && previous?.isCurrent() && sessionKey(previous.session) === key && !runtime.navigationLease) {
      const lease = latest.current.connections.acquire(previous.session.agentId, previous.replica, previous.session);
      const held = { key, release() { clearTimeout(deadline); lease.release(); if (runtime.navigationLease === held) runtime.navigationLease = undefined; } };
      const deadline = setTimeout(() => held.release(), 20000);
      runtime.navigationLease = held;
    }
    runtime.binding?.stop(); runtime.binding = undefined; runtime.attachment?.abort(); runtime.attachment = undefined; runtime.activeAttempt = undefined;
    latest.current.retireNative();
  }
  function slotFor(selection: Selection, history = false): CompositionSlot | undefined {
    return runtime.document.slots.find(slot => (slot.intent.kind === 'history') === history && sessionKey(selectionFor(slot)) === sessionKey(selection));
  }
  function explicitSlot(selection: Selection, id: string): CompositionSlot | undefined {
    return runtime.document.scope === options.scope ? runtime.document.slots.find(slot => slot.id === id
      && sessionKey(selectionFor(slot)) === sessionKey(selection)) : undefined;
  }
  function ensureView(selection: Selection, explicitId = selection.viewId): CompositionSlot {
    if (explicitId) {
      const existing = explicitSlot(selection, explicitId);
      if (!existing) throw new Error('The selected session view no longer matches this session.');
      return existing;
    }
    const lineage = runtime.replays.find(replay => [replay.from, replay.to].some(target => sessionKey(target) === sessionKey(selection)));
    if (lineage) {
      const key = compositionRoleKey({ scope: options.scope, hostId: lineage.to.hostId, controllerId: lineage.projection.role.current.controllerId, roleId: lineage.projection.role.id });
      const role = runtime.document.slots.find(slot => slot.intent.kind === 'role' && slot.intent.roleKey === key);
      if (role) return role;
      const origin = { hostId: lineage.from.hostId, ...lineage.projection.role.origin, title: selection.title };
      const original = slotFor(origin);
      if (original) return original;
      const slot = createCompositionSlot(compositionOriginId(origin), origin, options.scope);
      runtime.document.slots.push(slot); runtime.document.asks.push(createAskOwner(slot, options.scope)); runtime.document.editRevision++;
      return slot;
    }
    const existing = slotFor(selection);
    if (existing) return existing;
    const slot = createCompositionSlot(compositionOriginId(selection), selection, options.scope);
    runtime.document.slots.push(slot); runtime.document.asks.push(createAskOwner(slot, options.scope)); runtime.document.editRevision++;
    return slot;
  }
  function save(presentation = false) {
    const current = () => live() || presentation && currentRuntime.current === runtime && runtime.mounted
      && recoveryGeneration(options.scope) === runtime.generation;
    if (!current() || !runtime.readable) return;
    const revision = runtime.document.editRevision;
    const write = saveCompositionDocument(runtime.document, () => current() && runtime.document.editRevision === revision);
    flushRecoveryWrites(compositionMetadataKey(options.scope));
    publish();
    void write.completion.then(result => {
      if (current() && runtime.document.editRevision === revision && !runtime.error && result.status !== 'saved' && result.status !== 'cancelled') {
        runtime.error = 'The current session layout could not be saved.'; publish();
      }
    });
    return write.completion;
  }
  function slotTitle(slot: CompositionSlot): string { return slot.metadata?.title ?? 'Session'; }
  function rememberHistoryTitles(sessions: readonly SessionEntry[]): boolean {
    let changed = false;
    for (const session of sessions) {
      const title = session.title.trim(), key = sessionKey(session);
      if (!title || title === 'Session' || runtime.historyTitles.get(key) === title) continue;
      runtime.historyTitles.set(key, title); changed = true;
    }
    return changed;
  }
  function captureLayout() {
    if (runtime.sharedWindow || !live() || !runtime.readable || runtime.intent === 'history' || runtime.result?.status !== 'applied') return;
    if (sideSlots().some(slot => !runtime.sides.has(slot.id))) return;
    const current = latest.current.layout();
    if (!current.path.length) return;
    const path = current.path as Array<OpenedSession & { viewId?: string }>;
    if (path.some(source => !source.viewId || !runtime.document.slots.some(slot => slot.id === source.viewId))) return;
    const ids = new Set(path.map(source => source.viewId!));
    const next = { collapsed: current.collapsed.filter(id => ids.has(id)), primary: path[0]!.viewId,
      focus: current.focus, anchor: current.anchor, address: current.address ?? path[0]!.viewId };
    if (JSON.stringify(next) === JSON.stringify({ collapsed: runtime.document.collapsed, primary: runtime.document.primary,
      focus: runtime.document.focus, anchor: runtime.document.anchor, address: runtime.document.address })) return;
    Object.assign(runtime.document, next); runtime.document.editRevision++; save();
  }
  function layoutView(): (TrackedSessionView & { primary: OpenedSession & { viewId: string }; sides: Array<OpenedSession & { viewId: string }> }) | undefined {
    const desired = runtime.desired;
    if (!desired || runtime.intent === 'history') return;
    const primary = runtime.binding?.isCurrent() ? runtime.binding.session : compositionSession(desired.slot);
    if (!primary) return;
    const selections: Record<string, string | null> = {};
    for (const edge of runtime.document.edges) if (edge.selected) selections[edge.source] = edge.target;
    const sides = sideSlots().flatMap(slot => {
      const session = runtime.sides.get(slot.id);
      return session && sessionKey(session) === sessionKey(selectionFor(slot)) ? [session] : [];
    });
    return { primary, primarySlot: desired.slot.id, sides, selections, focus: runtime.document.focus, anchor: runtime.document.anchor };
  }
  function sideSlots(): CompositionSlot[] {
    const visited = new Set<string>(), result: CompositionSlot[] = [];
    let source = runtime.desired?.slot.id;
    while (source && !visited.has(source)) {
      visited.add(source);
      const target = runtime.document.edges.find(edge => edge.source === source && edge.selected)?.target;
      const slot = target ? runtime.document.slots.find(slot => slot.id === target) : undefined;
      if (!slot || visited.has(slot.id)) break;
      result.push(slot); source = slot.id;
    }
    return result;
  }
  async function resolveNative(slot: CompositionSlot, title: string, signal: AbortSignal, takeOver?: string): Promise<OpenedSession & { viewId: string }> {
    const identity = selectionFor(slot);
    runtime.targetUnavailable = false;
    if (slot.intent.kind !== 'history') {
      try { latest.current.validateTarget?.(identity, slot.id, runtime.document); }
      catch (error) { runtime.targetUnavailable = true; throw error; }
    }
    const cached = latest.current.connections.find(identity), agent = cached?.replica.getState().agent;
    const externallyOwned = !!cached?.replica.getState().sessionControl?.nativeOwner;
    const reusable = cached && !externallyOwned && agent?.id === cached.agentId && agent.providerId === identity.providerId
      && agent.runtimeInfo.providerId === identity.providerId && agent.runtimeInfo.sessionId === identity.nativeSessionId;
    const directory = latest.current.directory(identity.hostId ?? 'local');
    const attached = runtime.attached && sessionKey(runtime.attached) === sessionKey(identity) ? runtime.attached : undefined;
    const activity = latest.current.tracking().observations[sessionKey(identity)];
    const observed = !externallyOwned && activity?.connection === 'ready' && !activity.error ? activity.agentId : undefined;
    const response = attached && !takeOver ? { agentId: attached.agentId } : reusable && !takeOver ? { agentId: cached.agentId }
      : observed && !takeOver ? { agentId: observed } : slot.metadata?.parentNativeSessionId
      ? await directory.attachChild(identity.providerId, slot.metadata.parentNativeSessionId, identity.nativeSessionId, signal)
      : await directory.attach(identity.providerId, identity.nativeSessionId, signal, takeOver);
    signal.throwIfAborted();
    if (response.nativeSessionId !== undefined && response.nativeSessionId !== identity.nativeSessionId) throw new Error('The Host returned a different native session.');
    const currentSlot = runtime.document.slots.find(candidate => candidate.id === slot.id && sessionKey(selectionFor(candidate)) === sessionKey(identity));
    return { ...slot.metadata, ...identity, agentId: response.agentId, title: currentSlot?.metadata?.title ?? title, viewId: slot.id };
  }
  function restoreSides() {
    if (runtime.sharedWindow) {
      for (const [id, request] of runtime.sideRequests) {
        request.abort();
        const slot = runtime.document.slots.find(slot => slot.id === id);
        if (slot) runtime.sideAttempted.delete(JSON.stringify([slot.id, slot.intent.target]));
      }
      runtime.sideRequests.clear();
      return;
    }
    if (!live() || runtime.result?.status !== 'applied') return;
    const required = sideSlots();
    for (const [id, request] of runtime.sideRequests) if (!required.some(slot => slot.id === id)) { request.abort(); runtime.sideRequests.delete(id); }
    for (const slot of required) {
      const attempt = JSON.stringify([slot.id, slot.intent.target]);
      if (runtime.sideAttempted.has(attempt) || runtime.sideRequests.has(slot.id) || runtime.sides.get(slot.id) && sessionKey(runtime.sides.get(slot.id)!) === sessionKey(selectionFor(slot))) continue;
      runtime.sideAttempted.add(attempt);
      const request = new AbortController(), target = JSON.stringify(slot.intent.target);
      runtime.sideRequests.set(slot.id, request);
      void resolveNative(slot, slotTitle(slot), AbortSignal.any([request.signal, AbortSignal.timeout(15000)])).then(session => {
        if (!live() || request.signal.aborted || JSON.stringify(slot.intent.target) !== target) return;
        runtime.sides.set(slot.id, session); slot.metadata = compositionSessionMetadata(session);
        runtime.document.editRevision++; save();
      }).catch(error => { if (live() && !request.signal.aborted) { runtime.error = error instanceof Error ? error.message : 'The side session could not be opened.'; publish(); } })
        .finally(() => { if (runtime.sideRequests.get(slot.id) === request) runtime.sideRequests.delete(slot.id); });
    }
  }
  function selectDesired(slot: CompositionSlot, target: CompositionLocator, revision: number, operationId?: string, roleKey?: string) {
    if (!live()) return;
    const previous = runtime.desired;
    if (previous && previous.slot.id === slot.id && previous.revision > revision) return;
    const identity = JSON.stringify([slot.id, target, revision, runtime.intent]);
    const oldIdentity = previous && JSON.stringify([previous.slot.id, previous.target, previous.revision, previous.sessionIntent]);
    if (identity === oldIdentity) { previous!.keepOriginal = runtime.keepOriginal; return; }
    retireBinding({ hostId: target.hostId, ...target.native, title: slotTitle(slot) });
    runtime.active = true; runtime.layoutRevision++;
    if (runtime.navigationAttempt) { runtime.attempted.delete(JSON.stringify([slot.id, target, revision])); runtime.navigationAttempt = false; }
    if (!runtime.document.address) { runtime.document.address = slot.id; runtime.document.editRevision++; }
    if (!runtime.document.primary) {
      runtime.document.primary = slot.id; runtime.document.focus = slot.id; runtime.document.anchor = slot.id; runtime.document.editRevision++;
    }
    runtime.desired = { slot, target, revision, operationId, roleKey, title: runtime.selectedSlot ? slotTitle(slot) : runtime.selection?.title ?? slotTitle(slot),
      sessionIntent: runtime.intent, keepOriginal: runtime.keepOriginal };
    runtime.error = undefined; runtime.result = unavailable('reconciling');
    publish();
  }
  function admitReplay(replay: SessionSuccessionReplay) {
    if (!live() || runtime.intent === 'history' || !runtime.selection) return;
    const key = compositionRoleKey({ scope: options.scope, hostId: replay.to.hostId, controllerId: replay.projection.role.current.controllerId, roleId: replay.projection.role.id });
    const selected = runtime.document.slots.find(slot => slot.id === runtime.selectedSlot);
    const originSelection = { hostId: replay.from.hostId, ...replay.projection.role.origin, title: runtime.selection.title };
    const selectedRole = selected?.intent.kind === 'role' && selected.intent.roleKey === key ? selected : undefined;
    const selectedOrigin = selected?.intent.kind === 'fixed' && sessionKey(selectionFor(selected)) === sessionKey(originSelection) ? selected : undefined;
    const roleSlot = selectedRole ?? runtime.document.slots.find(slot => slot.intent.kind === 'role' && slot.intent.roleKey === key);
    const originSlot = selectedRole ?? selectedOrigin ?? roleSlot ?? slotFor(originSelection);
    if (runtime.selectedSlot && runtime.selectedSlot !== originSlot?.id) return;
    const related = runtime.replays.filter(item => compositionRoleKey({ scope: options.scope, hostId: item.to.hostId,
      controllerId: item.projection.role.current.controllerId, roleId: item.projection.role.id }) === key);
    const selectionMatches = related.some(item => [item.from, item.to].some(target => sessionKey(target) === sessionKey(runtime.selection!)));
    if (!selectionMatches && (!roleSlot || runtime.desired?.slot.id !== roleSlot.id)) return;
    let slot = selectedRole ?? selectedOrigin ?? (runtime.desired?.slot.intent.kind === 'role' && runtime.desired.slot.intent.roleKey === key ? runtime.desired.slot : roleSlot);
    const origin = replay.projection.role.origin;
    slot ??= slotFor({ hostId: replay.from.hostId, providerId: origin.providerId, nativeSessionId: origin.nativeSessionId, title: runtime.selection.title });
    if (!slot) {
      const source = { hostId: replay.from.hostId, ...replay.projection.role.origin, title: runtime.selection.title };
      slot = createCompositionSlot(compositionOriginId(source), source, options.scope);
      runtime.document.slots.push(slot); runtime.document.asks.push(createAskOwner(slot, options.scope)); runtime.document.editRevision++;
    }
    selectDesired(slot, { hostId: replay.to.hostId, native: replay.projection.role.current }, replay.projection.role.revision, replay.projection.receipt.operationId, key);
  }
  async function retainAsk(context: CompositionApplicationContext): Promise<CompositionParticipantResult> {
    const ids = new Set([...context.slots, ...context.retained].map(slot => slot.id));
    return latest.current.ask().retainAssociationOwners(runtime.document.asks.filter(owner => ids.has(owner.sourceSlot)).map(owner => owner.id), context.isCurrent);
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
          const result = await applyCompositionTrack(context);
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
  async function attachDesired(explicit = false): Promise<void> {
    const desired = runtime.desired;
    if (!live() || !desired || runtime.result?.status !== 'applied') return;
    const attempt = JSON.stringify([desired.slot.id, desired.target, desired.revision]);
    if (!explicit && runtime.attempted.has(attempt)) return;
    runtime.attempted.add(attempt); retireBinding({ hostId: desired.target.hostId, ...desired.target.native, title: desired.title }); runtime.activeAttempt = attempt;
    const navigationLease = runtime.navigationLease;
    const authority = runtime.authority;
    const controller = new AbortController(); runtime.attachment = controller;
    const current = () => live() && runtime.authority === authority && runtime.desired === desired && runtime.attachment === controller && !controller.signal.aborted;
    runtime.error = undefined; publish();
    try {
      const identity = { hostId: desired.target.hostId, providerId: desired.target.native.providerId, nativeSessionId: desired.target.native.nativeSessionId };
      const takeover = runtime.takeover;
      const targetSlot = { ...desired.slot, intent: { kind: desired.sessionIntent ?? 'fixed', target: desired.target } } as CompositionSlot;
      const resolve = (signal: AbortSignal) => resolveNative(targetSlot, desired.title, signal, takeover?.generation);
      const session = desired.roleKey || desired.sessionIntent === 'history' || takeover
        ? await resolve(AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]))
        : await new Promise<OpenedSession & { viewId: string }>((accept, reject) => {
          let stop = () => {};
          const finish = (settle: () => void) => { controller.signal.removeEventListener('abort', abort); stop(); settle(); };
          const abort = () => finish(() => reject(controller.signal.reason));
          controller.signal.addEventListener('abort', abort, { once: true });
          stop = restoreSession({ active: current,
            open: signal => resolve(AbortSignal.any([signal, controller.signal])),
            restored: value => finish(() => accept(value)),
            failed: (error, retrying) => {
              if (!retrying) finish(() => reject(error));
              else if (current()) latest.current.failed(error, { ...identity, title: desired.title }, true);
            },
          });
        });
      if (!current()) return;
      const lease = latest.current.connections.acquire(session.agentId, latest.current.replicaFor(session.agentId), session);
      navigationLease?.release();
      let stopped = false, imageLifetime: { active: boolean } | undefined, imageEpoch: string | null | undefined;
      const exactIdentity = () => {
        const state = lease.replica.getState(), agent = state.agent;
        let available = true;
        try { if (desired.sessionIntent !== 'history') latest.current.validateTarget?.(session, desired.slot.id, runtime.document); } catch { available = false; }
        return available && current() && !stopped && agent?.id === session.agentId && agent.providerId === identity.providerId
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
      // The public client owns synchronization deadlines and reconnects. A slow
      // history or control response is not evidence of a native identity mismatch.
      const binding: NativeBinding = { session, client: lease.client, replica: lease.replica, isCurrent: viewCurrent, isSynchronized: synchronized,
        getSessionState() {
          const native = lease.client.getSessionState();
          const pending = remoteSessionState(undefined, native.connection);
          if (!exactIdentity()) return pending;
          // Expose authoritative progress before composition admission, without
          // granting operations until replay and the initial synchronization settle.
          return viewCurrent() ? native : { ...native, synchronized: false, operations: pending.operations };
        },
        resumeRecipient() { update(); },
        retireRecipient() { if (imageLifetime) imageLifetime.active = false; imageLifetime = undefined; binding.recipient = undefined; },
        stop() { if (stopped) return; stopped = true; if (imageLifetime) imageLifetime.active = false; for (const stop of stops) stop(); lease.release(); } };
      const update = () => {
        if (stopped || !current()) { if (imageLifetime) imageLifetime.active = false; return; }
        const state = lease.replica.getState(), epoch = state.timeline.epoch;
        if (exactIdentity()) {
          if (runtime.error === identityConfirmationError) runtime.error = undefined;
        } else if (state.agent) runtime.error = identityConfirmationError;
        if (imageLifetime && (!imageCurrent() || imageEpoch !== epoch)) { imageLifetime.active = false; imageLifetime = undefined; binding.recipient = undefined; }
        if (!imageLifetime && imageCurrent()) {
          const lifetime = { active: true }; imageLifetime = lifetime; imageEpoch = epoch;
          binding.recipient = { identity: JSON.stringify([options.scope, desired.slot.id, desired.revision, desired.target, session.agentId]), lifetime,
            isCurrent: () => lifetime.active && imageLifetime === lifetime && imageCurrent() && lease.replica.getState().timeline.epoch === epoch };
        }
        const nativeReady = synchronized();
        // Replay owns the composition until its participants settle. An earlier native
        // attachment must not invalidate that read by publishing its binding metadata.
        if (nativeReady && !confirmed && !runtime.discovering && runtime.result?.status === 'applied') {
          confirmed = true; runtime.error = undefined;
          desired.slot.metadata = compositionSessionMetadata(session);
          runtime.document.editRevision++; save();
          latest.current.bindNative(binding); latest.current.confirmed(session);
          restoreSides();
          const ask = latest.current.ask();
          for (const owner of runtime.document.asks.filter(owner => owner.sourceSlot === desired.slot.id)) {
            const revision = ask.ownerEditRevision(owner.id);
            ask.applySourceProjection(owner.id, session, revision, viewCurrent);
          }
        }
        publish();
      };
      runtime.binding = binding;
      stops.push(lease.replica.subscribe(update));
      stops.push(lease.client.subscribeSessionState(update));
      update();
      if (takeover && current()) {
        takeover.restored?.();
        await latest.current.connections.takeControlAfterNativeResume(session.agentId);
        if (runtime.takeover === takeover) { runtime.takeover = undefined; publish(); }
      }
    } catch (error) {
      navigationLease?.release();
      if (current()) { runtime.activeAttempt = undefined; runtime.error = error instanceof Error ? error.message : 'The session could not be opened.';
        latest.current.failed(error, { hostId: desired.target.hostId, ...desired.target.native, title: desired.title }); publish(); }
    }
  }
  async function discover(attachExplicit = false): Promise<void> {
    if (!live()) return;
    const sequence = ++runtime.sequence, authority = runtime.authority;
    runtime.metadata?.abort(); const controller = new AbortController(); runtime.metadata = controller;
    const current = () => live() && runtime.authority === authority && runtime.sequence === sequence && !controller.signal.aborted;
    const request = { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) };
    runtime.discovering = true; runtime.discovered = false; runtime.historyEvidence.clear();
    rememberHistoryTitles(runtime.document.slots.map(selectionFor)); publish();
    try {
      if (!runtime.readable) throw new Error('Saved session composition is unreadable or unsupported. Its original data has been preserved.');
      if (runtime.result && 'code' in runtime.result && runtime.result.code === 'invalid_view') throw new Error('The selected session view no longer matches this session.');
      const all: SessionSuccessionReplay[] = [], cursors = new Set<string>(); let cursor: string | undefined;
      if (supported && !runtime.unsupported) do {
        const page = await options.transport.fetchSessionSuccessions!({ limit: 64, ...(cursor ? { cursor } : {}) }, request);
        if (!current()) return;
        all.push(...page.successions);
        if (all.length > 1024) throw new Error('Session succession replay exceeded the retained limit.');
        cursor = page.nextCursor ?? undefined;
        if (cursor && cursors.has(cursor)) throw new Error('Session succession replay did not advance.');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      runtime.replays = all;
      if (runtime.selection && runtime.intent !== 'history' && !runtime.selectedSlot) runtime.selectedSlot = ensureView(runtime.selection).id;
      if (runtime.selectedSlot && !runtime.document.slots.some(slot => slot.id === runtime.selectedSlot)) throw new Error('The selected session view is no longer available.');
      const latestByRole = new Map<string, SessionSuccessionReplay>();
      const windowSlots = new Set(runtime.document.windowBindings?.map(binding => binding.slotId));
      for (const replay of all) {
        const key = compositionRoleKey({ scope: options.scope, hostId: replay.to.hostId, controllerId: replay.projection.role.current.controllerId, roleId: replay.projection.role.id });
        if (runtime.intent === 'history' && !runtime.document.slots.some(slot => {
          if (!windowSlots.has(slot.id)) return false;
          const intent = slot.intent, origin = replay.projection.role.origin;
          return intent.kind === 'role' && intent.roleKey === key || intent.kind === 'fixed' && intent.target.hostId === replay.from.hostId
            && intent.target.native.providerId === origin.providerId && intent.target.native.nativeSessionId === origin.nativeSessionId
            && (!intent.target.native.controllerId || intent.target.native.controllerId === origin.controllerId);
        })) continue;
        if ((latestByRole.get(key)?.projection.role.revision ?? 0) < replay.projection.role.revision) latestByRole.set(key, replay);
      }
      for (const replay of latestByRole.values()) admitReplay(replay);
      const local = runtime.intent !== 'history' && runtime.selectedSlot ? runtime.document.slots.find(slot => slot.id === runtime.selectedSlot) : undefined;
      if (local?.intent.kind === 'role' && runtime.desired?.slot.id !== local.id) throw new Error('The selected session view could not be recovered from the current role.');
      if (local && local.intent.kind !== 'role' && runtime.desired?.slot.id !== local.id) {
        const target = local.intent.target;
        selectDesired(local, target, 0);
      }
      let localResult: CompositionParticipantResult | undefined;
      for (const replay of latestByRole.values()) {
        if (!current()) return;
        runtime.trackPublication = undefined;
        const applicationInstance = application(replay);
        let verifiedCurrent: SessionSuccessionCurrent | undefined;
        const verifiedChain: SessionSuccessionReplay[] = [];
        const result = await applicationInstance.recover(replay.projection.role.id, {
          fetchSessionSuccessionOperation: (roleId, operationId) => options.transport.fetchSessionSuccessionOperation!(roleId, operationId, request),
          fetchSessionSuccessionCurrent: async roleId => {
            const value = await options.transport.fetchSessionSuccessionCurrent!(roleId, request);
            verifiedCurrent = value;
            if (current() && runtime.desired?.roleKey === compositionRoleKey({ scope: options.scope, hostId: value.locator.hostId, controllerId: value.role.current.controllerId, roleId }) && value.locator.hostId === replay.to.hostId && value.role.current.controllerId === replay.projection.role.current.controllerId) {
              selectDesired(runtime.desired.slot, { hostId: value.locator.hostId, native: value.role.current }, value.role.revision, undefined, runtime.desired.roleKey);
            }
            return value;
          },
          fetchSessionSuccessions: async query => {
            const page = await options.transport.fetchSessionSuccessions!(query, request);
            verifiedChain.push(...page.successions); return page;
          },
        }, { selectedSlot: runtime.selectedSlot, isCurrent: current });
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
        if (accepted.status === 'applied' && verifiedCurrent) runtime.historyEvidence.set(roleKey, { replays: verifiedChain, current: verifiedCurrent });
        if (runtime.desired?.slot.intent.kind === 'role' && runtime.desired.slot.intent.roleKey === roleKey) runtime.result = accepted;
        if (accepted.status !== 'applied') localResult = accepted;
      }
      if (runtime.intent === 'history' && runtime.selection) {
        const roles = new Map(all.filter(replay => [replay.from, replay.to].some(target => sessionKey(target) === sessionKey(runtime.selection!))).map(replay => [
          compositionRoleKey({ scope: options.scope, hostId: replay.to.hostId, controllerId: replay.projection.role.current.controllerId, roleId: replay.projection.role.id }), replay,
        ]));
        for (const [key, replay] of roles) {
          try {
            const role = await options.transport.fetchSessionSuccessionCurrent!(replay.projection.role.id, request);
            if (!current()) return;
            const navigation = sessionSuccessionHistory({ scope: options.scope, replays: all, current: role, selected: runtime.selection, intent: 'history' });
            if (navigation?.roleKey === key) {
              const replays = all.filter(item => compositionRoleKey({ scope: options.scope, hostId: item.to.hostId,
                controllerId: item.projection.role.current.controllerId, roleId: item.projection.role.id }) === key);
              runtime.historyEvidence.set(key, { replays, current: role });
            }
          } catch { if (!current()) return; }
        }
        let slot = runtime.selectedSlot ? explicitSlot(runtime.selection, runtime.selectedSlot) : slotFor(runtime.selection, true);
        if (!slot) { slot = createHistorySlot(compositionOriginId(runtime.selection, true), { hostId: runtime.selection.hostId ?? 'local', native: { providerId: runtime.selection.providerId, nativeSessionId: runtime.selection.nativeSessionId } }, options.scope);
          slot.metadata = compositionSessionMetadata(runtime.selection);
          runtime.document.slots.push(slot); runtime.document.asks.push(createAskOwner(slot, options.scope)); runtime.document.editRevision++; }
        runtime.selectedSlot = slot.id; selectDesired(slot, slot.intent.target, 0);
        runtime.document.address = slot.id; runtime.document.primary = slot.id; runtime.document.editRevision++;
        const write = saveCompositionDocument(runtime.document, current); flushRecoveryWrites(compositionMetadataKey(options.scope));
        const result = await write.completion;
        if (!current()) return;
        runtime.result = result.status === 'saved' ? { status: 'applied', retention: result.retention } : unavailable('history_write');
      } else {
        if (local && local.intent.kind !== 'role' && runtime.desired?.slot.id === local.id) {
          if (localResult) runtime.result = localResult;
          else {
            const save = saveCompositionDocument(runtime.document, current); flushRecoveryWrites(compositionMetadataKey(options.scope));
            const result = await save.completion;
            if (!current()) return;
            runtime.result = result.status === 'saved' ? { status: 'applied', retention: result.retention } : unavailable('view_write');
          }
        }
      }
      if (!current()) return;
      runtime.discovered = true;
      if (!runtime.desired) runtime.active = false;
      if (runtime.desired && runtime.result?.status !== 'applied') runtime.error = runtime.discoveryError = `Session composition needs synchronization (${runtime.result?.code ?? 'pending'}).`;
      else {
        if (runtime.error === runtime.discoveryError) runtime.error = undefined;
        runtime.discoveryError = undefined;
      }
      if (runtime.desired && runtime.result?.status === 'applied') {
        runtime.layoutRevision++;
        void attachDesired(attachExplicit);
      }
    } catch (error) {
      if (current()) {
        if (!runtime.desired && !runtime.document.roles.length && error && typeof error === 'object' && 'code' in error && ['http_404', 'route_not_found'].includes(String(error.code))) {
          runtime.unsupported = true;
          queueMicrotask(() => { if (current()) void discover(); });
        } else {
          runtime.error = runtime.discoveryError = error instanceof Error ? error.message : 'Session succession could not be recovered.';
          if (runtime.result && 'code' in runtime.result && runtime.result.code === 'invalid_view') runtime.discovered = true;
          else runtime.result = unavailable('replay_unavailable');
        }
      }
    } finally {
      if (current()) {
        if (runtime.result?.status !== 'applied') runtime.navigationLease?.release();
        runtime.discovering = false;
        runtime.settledDiscoverySequence = sequence;
        runtime.binding?.resumeRecipient();
        publish();
      }
    }
  }
  async function open(selection: Selection, intent?: 'history', keepOriginal?: boolean, slotId?: string, takeOver?: string, onRestoring?: () => void, attached?: OpenedSession, restoreLayout = false): Promise<boolean> {
    if (!live()) return false;
    rememberHistoryTitles([selection]);
    runtime.navigation?.abort(); runtime.navigation = undefined;
    const requestedSlot = slotId ? explicitSlot(selection, slotId) : undefined;
    if (slotId && (!requestedSlot || (requestedSlot.intent.kind === 'history') !== (intent === 'history'))) {
      runtime.sequence++; runtime.metadata?.abort(); retireBinding(); runtime.desired = undefined; runtime.selectedSlot = slotId;
      runtime.selection = selection; runtime.intent = undefined; runtime.active = true; runtime.discovering = false;
      runtime.result = unavailable('invalid_view'); runtime.error = 'The selected session view no longer matches this session.'; publish(); return true;
    }
    if (intent === 'history') {
      const request = new AbortController(), sequence = runtime.sequence;
      runtime.navigation = request;
      const current = () => live() && !request.signal.aborted && runtime.sequence === sequence;
      const candidate = requestedSlot ?? slotFor(selection, true) ?? createHistorySlot(compositionOriginId(selection, true), {
        hostId: selection.hostId ?? 'local', native: { providerId: selection.providerId, nativeSessionId: selection.nativeSessionId },
      }, options.scope);
      try {
        attached = await resolveNative({ ...candidate, metadata: compositionSessionMetadata(selection) }, selection.title,
          AbortSignal.any([request.signal, AbortSignal.timeout(15000)]));
        if (!current()) return false;
        selection = { ...selection, agentId: attached.agentId };
      } catch (error) {
        if (current()) latest.current.failed(error, selection);
        return false;
      } finally { if (runtime.navigation === request) runtime.navigation = undefined; }
    }
    runtime.attached = attached;
    const takeover = takeOver || onRestoring ? { generation: takeOver, restored: onRestoring } : undefined;
    runtime.takeover = takeover;
    const desired = runtime.desired;
    const sameRole = !slotId && intent !== 'history' && runtime.intent !== 'history' && desired?.roleKey && (
      sessionKey(selection) === sessionKey({ hostId: desired.target.hostId, ...desired.target.native })
      || runtime.replays.some(replay => compositionRoleKey({ scope: options.scope, hostId: replay.to.hostId,
        controllerId: replay.projection.role.current.controllerId, roleId: replay.projection.role.id }) === desired.roleKey
        && [replay.from, replay.to].some(target => sessionKey(target) === sessionKey(selection))));
    const sameView = slotId && desired?.slot.id === slotId;
    const slot = intent === 'history' ? requestedSlot : ensureView(selection, slotId);
    const restorePrimary = restoreLayout && slot?.id === runtime.document.primary;
    if (slot && attached) slot.metadata = compositionSessionMetadata(attached);
    runtime.selection = selection; runtime.intent = intent; runtime.keepOriginal = keepOriginal; runtime.selectedSlot = slot?.id;
    if (slot) bindCompositionView(runtime.document, 'main', slot.id);
    if (!sameRole && !sameView) {
      if (slot && !restorePrimary) { runtime.document.focus = slot.id; runtime.document.anchor = slot.id; }
      runtime.navigationAttempt = true;
      retireBinding(selection); runtime.desired = undefined; runtime.result = undefined; runtime.error = undefined;
    }
    runtime.active = true; publish();
    await discover(!!takeover);
    if (takeover) await confirmRestoredBinding(target => sessionKey(target) === sessionKey(selection), {
      mustRemain: true, settled: () => runtime.takeover !== takeover,
    });
    return runtime.active;
  }
  async function refreshComposition(): Promise<void> {
    const deadline = Date.now() + 20000;
    await discover();
    while (live() && runtime.settledDiscoverySequence !== runtime.sequence) {
      if (Date.now() >= deadline) throw new Error('Session composition is still changing. Retry synchronization.');
      if (!runtime.discovering) { await discover(); continue; }
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer); runtime.refreshObservers.delete(check);
          if (error) reject(error); else resolve();
        };
        const check = () => { if (!live() || !runtime.discovering) finish(); };
        const timer = setTimeout(() => finish(new Error('Session composition is still changing. Retry synchronization.')), Math.max(1, deadline - Date.now()));
        runtime.refreshObservers.add(check); check();
      });
    }
  }
  async function refreshCommitted(operationId: string): Promise<void> {
    if (!live()) throw new Error('Workspace access is required to refresh this Handoff.');
    await refreshComposition();
    if (!live()) throw new Error('Workspace access changed while refreshing this Handoff.');
    const matches = [...runtime.historyEvidence.entries()].filter(([, evidence]) => evidence.replays.some(replay => replay.projection.receipt.operationId === operationId));
    if (matches.length !== 1) throw new Error(runtime.error ?? 'The committed Handoff could not be verified. Refresh its current role again.');
    const [roleKey, evidence] = matches[0]!;
    const checkpoint = runtime.document.roles.find(role => compositionRoleKey(role) === roleKey);
    if (!checkpoint || checkpoint.appliedRevision !== evidence.current.role.revision || checkpoint.desired.committedRevision !== evidence.current.role.revision) {
      throw new Error(runtime.error ?? 'The committed Handoff still needs local synchronization.');
    }
    await confirmRestoredBinding(target => runtime.desired?.roleKey === roleKey
      || evidence.replays.some(replay => [replay.from, replay.to].some(locator => sessionKey(locator) === sessionKey(target))));
  }
  async function refreshSettled(result: SuccessionActionResult, source: OpenedSession): Promise<void> {
    if (result.record.phase === 'committed') return refreshCommitted(result.record.operationId);
    if (!['cancelled', 'rejected'].includes(result.record.phase)
      || sessionKey({ hostId: source.hostId, ...result.record.from }) !== sessionKey(source)) {
      throw new Error('The Handoff outcome does not confirm the original conversation.');
    }
    if (!live()) throw new Error('Workspace access is required to restore this conversation.');
    await refreshComposition();
    if (!live()) throw new Error('Workspace access changed while restoring this conversation.');
    const roleKey = compositionRoleKey({ scope: options.scope, hostId: source.hostId ?? 'local', controllerId: result.role.current.controllerId, roleId: result.role.id });
    const evidence = runtime.historyEvidence.get(roleKey);
    if (nativeSessionRefKey(result.role.current) !== nativeSessionRefKey(result.record.from) && !evidence) {
      throw new Error('The original conversation has moved. Refresh its current role before continuing.');
    }
    await confirmRestoredBinding(target => runtime.desired?.roleKey === roleKey || sessionKey(target) === sessionKey(source)
      || sessionKey(target) === sessionKey({ hostId: source.hostId, ...result.role.current }));
  }
  function confirmRestoredBinding(related: (target: Pick<SessionEntry, 'hostId' | 'providerId' | 'nativeSessionId'>) => boolean,
    options: { mustRemain?: boolean; settled?(): boolean } = {}): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(deadline); runtime.refreshObservers.delete(check);
        if (error) reject(error); else resolve();
      };
      const check = () => {
        if (!live()) { finish(new Error('Workspace access changed while refreshing this Handoff.')); return; }
        const desired = runtime.desired;
        const target = desired && { hostId: desired.target.hostId, ...desired.target.native };
        if (!target || !related(target)) { finish(options.mustRemain ? new Error('Session navigation changed before native restoration was confirmed.') : undefined); return; }
        if (runtime.discovering) return;
        if (runtime.error) { finish(new Error(runtime.error)); return; }
        if (runtime.result?.status !== 'applied') { finish(new Error('The conversation layout still needs synchronization.')); return; }
        if (runtime.binding?.isCurrent() && runtime.binding.isSynchronized() && sessionKey(runtime.binding.session) === sessionKey(target) && (options.settled?.() ?? true)) finish();
      };
      const deadline = setTimeout(() => finish(new Error('The current native session has not been confirmed. Retry the session connection.')), 16000);
      runtime.refreshObservers.add(check); check();
    });
  }
  function leave() {
    runtime.navigation?.abort(); runtime.navigation = undefined;
    runtime.sequence++; runtime.metadata?.abort(); retireBinding(); runtime.desired = undefined; runtime.selectedSlot = undefined; runtime.active = false; publish();
  }
  function clearPresentation() {
    runtime.navigation?.abort(); runtime.navigation = undefined;
    runtime.sequence++; runtime.metadata?.abort(); retireBinding();
    runtime.selection = undefined; runtime.desired = undefined; runtime.selectedSlot = undefined;
    runtime.attached = undefined; runtime.intent = undefined; runtime.keepOriginal = undefined;
    runtime.active = false; runtime.discovering = false; runtime.navigationAttempt = false;
    runtime.result = undefined; runtime.error = undefined;
    for (const request of runtime.sideRequests.values()) request.abort();
    runtime.sideRequests.clear(); runtime.sides.clear(); publish();
  }
  function restoreSelection(requested: Selection) {
    const address = runtime.document.slots.find(slot => slot.id === runtime.document.address);
    const primary = runtime.intent !== 'history' && address && address.intent.kind !== 'history' && sessionKey(compositionSelection(address)) === sessionKey(requested)
      ? runtime.document.slots.find(slot => slot.id === runtime.document.primary) : undefined;
    runtime.selection = primary ? compositionSelection(primary) : requested;
    runtime.selectedSlot = primary?.id ?? (runtime.readable && runtime.intent !== 'history' ? ensureView(requested).id : undefined);
  }
  function retry() {
    if (!live()) return;
    if (!runtime.readable) {
      const read = initializeCompositionDocument(options.scope);
      if (read.status === 'ready') {
        runtime.document = read.document; runtime.readable = true;
        runtime.applications.clear(); runtime.desired = undefined; runtime.result = undefined; runtime.error = undefined;
        if (runtime.selection) restoreSelection(runtime.selection);
        // Ask and Track must consume the verified document before recovery applies participants.
        flushSync(publish);
      }
    }
    runtime.attached = undefined; runtime.sideAttempted.clear();
    if (runtime.result?.status === 'applied') void attachDesired(true); else void discover();
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
  function ownerFor(viewId: string): string {
    const owner = runtime.document.asks.find(owner => owner.sourceSlot === viewId);
    if (!owner) throw new Error('The session view has no Ask owner.');
    return owner.id;
  }
  function resolveTarget(selection: Selection, requested: { nativePrefixOnly?: boolean; viewId?: string } = {}) {
    if (!live() || !runtime.discovered || runtime.discovering) throw new Error('The current session locator is still synchronizing.');
    if (selection.parentNativeSessionId) return { target: selection };
    const slot = requested.viewId ? runtime.document.slots.find(slot => slot.id === requested.viewId) : undefined;
    const matches = [...runtime.historyEvidence.values()].filter(evidence => evidence.replays.some(replay =>
      [replay.from, replay.to].some(target => sessionKey(target) === sessionKey(selection))));
    if (!matches.length) {
      if (runtime.replays.some(replay => [replay.from, replay.to].some(target => sessionKey(target) === sessionKey(selection)))) {
        throw new Error('The current session locator could not be verified. The original history is preserved.');
      }
      return { target: selection };
    }
    if (matches.length !== 1) throw new Error('The session has conflicting current role identities.');
    const evidence = matches[0]!;
    if (slot?.intent.kind === 'history') return { target: selection, historyRoleId: evidence.current.role.id };
    if (requested.nativePrefixOnly) {
      const anchor = evidence.replays.flatMap(replay => [replay.projection.receipt.from, replay.projection.receipt.to!])
        .find(ref => ref.providerId === selection.providerId && ref.nativeSessionId === selection.nativeSessionId)!;
      const resolved = resolveNativePrefix(anchor, evidence.replays.map(replay => replay.projection.receipt));
      if (nativeSessionRefKey(resolved.target) !== nativeSessionRefKey(evidence.current.role.current)) throw new Error('Native prefix execution routing is unavailable.');
    }
    return { target: { ...selection, ...evidence.current.locator } };
  }
  useEffect(() => {
    if (!live()) return;
    if (runtime.binding) {
      if (!runtime.binding.isCurrent()) {
        runtime.binding.retireRecipient();
        try { latest.current.validateTarget?.(runtime.binding.session, runtime.binding.session.viewId, runtime.document); }
        catch (error) { runtime.error = error instanceof Error ? error.message : 'The current execution locator is unavailable.'; publish(); }
      }
      else runtime.binding.resumeRecipient();
    } else if (runtime.discovered && !runtime.discovering && runtime.desired && !runtime.activeAttempt && runtime.targetUnavailable) void attachDesired(true);
  }, [options.targetRevision]);
  function reconcileAskRecipients() {
    const entries = latest.current.ask().entries;
    const targets = new Map([...entries].flatMap(([owner, entry]) => {
      if (!isAskAttached(entry) || !entry.record?.target) return [];
      try { return [[owner, { entry, anchor: entry.record.target, target: resolveTarget(entry.record.target, { nativePrefixOnly: true }).target }] as const]; }
      catch { return []; }
    }));
    for (const [owner, supplier] of runtime.askRecipients) {
      const next = targets.get(owner);
      if (!next || !live() || supplier.participant !== askParticipantKey(next.entry.record!)
        || supplier.connection !== latest.current.connections.find(next.target)) { supplier.stop(); runtime.askRecipients.delete(owner); }
    }
    if (!live()) return;
    for (const [owner, value] of targets) {
      if (runtime.askRecipients.has(owner)) continue;
      const connection = latest.current.connections.find(value.target);
      if (!connection) continue;
      const authority = runtime.authority, target = { ...value.target, agentId: connection.agentId }, anchor = value.anchor, participant = value.entry.record!, key = sessionKey(anchor);
      let stopped = false, lifetime: { active: boolean } | undefined, epoch: string | null | undefined;
      const eligible = () => {
        const entry = latest.current.ask().entries.get(owner), state = connection.replica.getState(), native = connection.client.getSessionState(), agent = state.agent;
        return live() && runtime.authority === authority && !stopped && isAskAttached(entry) && entry?.record?.id === participant.id
          && entry.record.target?.agentId === anchor.agentId && sessionKey(entry.record.target) === key
          && (() => { try { return sessionKey(resolveTarget(anchor, { nativePrefixOnly: true }).target) === sessionKey(target); } catch { return false; } })()
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
  useEffect(() => { reconcileAskRecipients(); restoreSides(); });
  useEffect(() => {
    runtime.mounted = true;
    if (live()) {
      if (!runtime.initialStarted) {
        runtime.initialStarted = true;
        const target = options.initial;
        if (target?.providerId && target.nativeSessionId) {
          const requested = { hostId: target.hostId ?? 'local', providerId: target.providerId, nativeSessionId: target.nativeSessionId, title: 'Session', parentNativeSessionId: target.parentNativeSessionId };
          if (runtime.readable && runtime.intent !== 'history' && options.initialLayout) applyConversationLayout(runtime.document, options.initialLayout);
          restoreSelection(requested);
        }
      }
      void discover();
    }
    const stopConnections = options.connections.subscribe(reconcileAskRecipients);
    const stop = options.transport.onSessionSuccession?.(() => {
      if (live() && supported) void discover();
    });
    const resume = watchPageResume(() => { if (live()) { runtime.binding?.resumeRecipient(); for (const supplier of runtime.askRecipients.values()) supplier.update(); void discover(); } }, () => {
      runtime.binding?.retireRecipient(); for (const supplier of runtime.askRecipients.values()) supplier.retire();
    });
    return () => {
      runtime.mounted = false; runtime.sequence++; runtime.navigation?.abort(); runtime.metadata?.abort(); runtime.attachment?.abort(); runtime.binding?.stop();
      for (const observer of runtime.refreshObservers) observer();
      runtime.navigationLease?.release();
      if (runtime.activeAttempt) runtime.attempted.delete(runtime.activeAttempt);
      runtime.activeAttempt = undefined; runtime.binding = undefined; stop?.(); resume(); stopConnections();
      for (const supplier of runtime.askRecipients.values()) supplier.stop(); runtime.askRecipients.clear();
      for (const request of runtime.sideRequests.values()) request.abort(); runtime.sideRequests.clear();
    };
  }, [runtime, options.enabled]);
  const bound = runtime.binding?.isCurrent() ? runtime.binding : undefined;
  const desired = runtime.desired, selection = runtime.selection;
  const initial = options.initial?.providerId && options.initial.nativeSessionId
    ? { ...options.initial, providerId: options.initial.providerId, nativeSessionId: options.initial.nativeSessionId, title: 'Session' } : undefined;
  const selected: SessionEntry | undefined = desired ? { hostId: desired.target.hostId, providerId: desired.target.native.providerId, nativeSessionId: desired.target.native.nativeSessionId,
    title: desired.title, ...(bound ? { agentId: bound.session.agentId } : {}) } : selection
      ? { hostId: selection.hostId, providerId: selection.providerId, nativeSessionId: selection.nativeSessionId, title: selection.title }
      : runtime.active ? initial : undefined;
  // Local view ownership is available before native discovery or control checks.
  // It may restore display preferences and drafts, but grants no native authority.
  const displaySlot = runtime.active && runtime.readable && recoveryGeneration(options.scope) === runtime.generation
    ? desired?.slot ?? runtime.document.slots.find(slot => slot.id === runtime.selectedSlot)
      ?? (!runtime.initialStarted && initial && runtime.intent !== 'history' ? ensureView(initial) : undefined)
    : undefined;
  function displayState(): AgentReplicaState | undefined {
    if (!runtime.active || !selected || recoveryGeneration(options.scope) !== runtime.generation) return;
    const key = sessionKey(selected);
    const matches = (state?: AgentReplicaState) => !!state?.agent && state.timeline.initialized
      && state.agent.providerId === selected.providerId && state.agent.runtimeInfo.providerId === selected.providerId
      && state.agent.runtimeInfo.sessionId === selected.nativeSessionId;
    const binding = runtime.binding;
    const connection = latest.current.connections.find(selected);
    const observed = binding && sessionKey(binding.session) === key && binding.replica.getState().agent?.id === binding.session.agentId
      ? binding.replica.getState() : connection && connection.replica.getState().agent?.id === connection.agentId ? connection.replica.getState()
      : latest.current.cachedReplicaFor?.(selected)?.getState();
    if (matches(observed)) runtime.display = { key, state: workspaceDisplayState(observed!), diskRead: true };
    if (runtime.display?.key !== key) {
      const initialDisplay = initial && sessionKey(initial) === key && matches(options.initialDisplayState) ? options.initialDisplayState : undefined;
      runtime.display = { key, state: initialDisplay && workspaceDisplayState(initialDisplay), diskRead: false };
    }
    if (!runtime.display.diskRead && live()) {
      runtime.display.state ??= readWorkspaceSnapshot(options.scope, selected);
      runtime.display.diskRead = true;
    }
    return runtime.display.state;
  }
  const preview = displayState();
  const visibleState = bound?.replica.getState() ?? preview;
  const historyCandidates = live() && runtime.discovered && !runtime.discovering && runtime.result?.status === 'applied' && selected
    ? [...runtime.historyEvidence.entries()].filter(([key]) => !desired?.roleKey || desired.roleKey === key).flatMap(([, evidence]) => {
      const navigation = sessionSuccessionHistory({ scope: options.scope, ...evidence, selected, intent: runtime.intent, titles: runtime.historyTitles });
      return navigation ? [navigation] : [];
    }) : [];
  const historyNavigation = historyCandidates.length === 1 ? historyCandidates[0] : undefined;
  function successionContextFor(slotId: string | undefined) {
    if (!live() || !runtime.discovered || runtime.discovering) return;
    const slot = runtime.document.slots.find(slot => slot.id === slotId);
    if (slot?.intent.kind !== 'role') return;
    const intent = slot.intent, checkpoint = runtime.document.roles.find(role => compositionRoleKey(role) === intent.roleKey);
    const evidence = runtime.historyEvidence.get(intent.roleKey);
    if (!checkpoint || !evidence || evidence.current.role.revision !== intent.revision
      || checkpoint.appliedRevision !== intent.revision || checkpoint.desired.committedRevision !== intent.revision
      || sessionKey(evidence.current.locator) !== sessionKey(selectionFor(slot))
      || nativeSessionRefKey(checkpoint.desired.to) !== nativeSessionRefKey(intent.target.native)) return;
    return { operationId: checkpoint.desired.operationId, target: checkpoint.desired.to };
  }
  function historyNavigationFor(source: SessionEntry & { viewId?: string }): SessionSuccessionHistoryNavigation | undefined {
    if (!live() || !runtime.discovered || runtime.discovering) return;
    const slot = runtime.document.slots.find(slot => slot.id === source.viewId);
    if (!slot || sessionKey(selectionFor(slot)) !== sessionKey(source)) return;
    const roleKey = slot.intent.kind === 'role' ? slot.intent.roleKey : undefined;
    if (roleKey && !successionContextFor(slot.id)) return;
    const candidates = [...runtime.historyEvidence.entries()].filter(([key]) => !roleKey || key === roleKey).flatMap(([, evidence]) => {
      const navigation = sessionSuccessionHistory({ scope: options.scope, ...evidence, selected: source,
        intent: slot.intent.kind === 'history' ? 'history' : undefined, titles: runtime.historyTitles });
      return navigation ? [navigation] : [];
    });
    return candidates.length === 1 ? candidates[0] : undefined;
  }
  function localViews() {
    const localIds = new Set(desired && runtime.intent !== 'history' ? [desired.slot.id] : []);
    for (let size = -1; size !== localIds.size;) {
      size = localIds.size;
      for (const retained of runtime.document.retained) if (localIds.has(retained.slot) || localIds.has(retained.against)) { localIds.add(retained.slot); localIds.add(retained.against); }
    }
    return localIds.size > 1 ? runtime.document.slots.filter(slot => localIds.has(slot.id)).map(slot => ({ slotId: slot.id, session: { ...selectionFor(slot), title: slotTitle(slot) } })) : [];
  }
  return {
    active: runtime.active && (options.enabled || !!desired), discovering: options.enabled && (!runtime.discovered || runtime.discovering), document: runtime.document, desired, selected, displaySlot,
    state: visibleState, sessionState: runtime.binding?.getSessionState() ?? remoteSessionState(undefined, runtime.active ? 'connecting' : 'idle'),
    layoutView, layoutRevision: runtime.layoutRevision, captureLayout, binding: bound, imageRecipient: bound?.recipient, error: runtime.error, result: runtime.result,
    observerReady: live() && runtime.discovered && !runtime.discovering && (!runtime.active || !!bound),
    isCurrent: () => !!runtime.binding?.isCurrent(), open,
    restore: (session: OpenedSession) => open(session, undefined, undefined, undefined, undefined, undefined, undefined, true),
    openAttached: (session: OpenedSession, restoreLayout = false) => open(session, undefined, undefined, undefined, undefined, undefined, session, restoreLayout),
    leave, clearPresentation, refresh: discover, refreshCommitted, refreshSettled, canPrune, observeFavorites,
    retry,
    ownerFor, localViews, ensureView, save, resolveTarget,
    bindWindowView: (windowId: string, viewId: string, binding: WindowSessionBinding, slotId: string) => {
      const slot = bindWindowCompositionSlot(runtime.document, windowId, viewId, binding, slotId);
      save(true);
      return slot;
    },
    ensureWindowView: (windowId: string, viewId: string, binding: WindowSessionBinding) => ensureWindowCompositionSlot(runtime.document, windowId, viewId, binding),
    projectWindow: (window: WorkspaceWindow | undefined) => {
      runtime.sharedWindow = window;
      if (!window) return;
      const changed = projectWindowComposition(runtime.document, window);
      if (changed) { runtime.layoutRevision++; restoreSides(); }
      if (runtime.windowProjectionRevision !== runtime.document.editRevision) {
        runtime.windowProjectionRevision = runtime.document.editRevision;
        save(true);
      }
    },
    navigationIntent: { sessionIntent: runtime.intent, keepOriginal: runtime.keepOriginal }, historyNavigation, historyNavigationFor, successionContextFor,
    observeHistoryTitles: (sessions: readonly SessionEntry[]) => { if (live() && runtime.readable && rememberHistoryTitles(sessions)) publish(); },
    updateTitles: (sessions: readonly SessionEntry[]) => {
      if (!live() || !runtime.readable) return;
      const historyChanged = rememberHistoryTitles(sessions);
      const titles = new Map(sessions.map(session => [sessionKey(session), session.title]));
      let changed = false;
      for (const slot of runtime.document.slots) {
        const title = titles.get(sessionKey(selectionFor(slot)));
        if (title === undefined || slot.metadata?.title === title) continue;
        slot.metadata = { ...slot.metadata, title }; changed = true;
        if (runtime.desired?.slot === slot) runtime.desired.title = title;
        if (runtime.binding?.session.viewId === slot.id) runtime.binding.session.title = title;
        const side = runtime.sides.get(slot.id); if (side) side.title = title;
      }
      if (changed) { runtime.document.editRevision++; save(); }
      else if (historyChanged) publish();
    },
    rememberSide: (session: OpenedSession & { viewId: string }) => {
      const slot = explicitSlot(session, session.viewId);
      if (!slot) throw new Error('The side view no longer matches this session.');
      const metadata = compositionSessionMetadata(session), previous = runtime.sides.get(slot.id);
      if (previous && canonicalJson(previous) === canonicalJson(session) && canonicalJson(slot.metadata) === canonicalJson(metadata)) return;
      runtime.sides.set(slot.id, session); slot.metadata = metadata;
      runtime.document.editRevision++; save();
    },
    recipientFor: (target: Selection, owner: string) => {
      const supplier = runtime.askRecipients.get(owner);
      return supplier?.targetKey === sessionKey(target) ? supplier.recipient : undefined;
    },
    sourceCurrent: (source: OpenedSession & { viewId?: string }) => {
      const id = source.viewId, slot = runtime.document.slots.find(slot => slot.id === id);
      if (!live() || !slot || sessionKey(selectionFor(slot)) !== sessionKey(source)) return false;
      if (id === desired?.slot.id && runtime.binding?.isCurrent() && runtime.binding.session.agentId === source.agentId) return true;
      const connection = latest.current.connections.find(source), agent = connection?.replica.getState().agent;
      return agent?.id === source.agentId && agent.providerId === source.providerId
        && agent.runtimeInfo.providerId === source.providerId && agent.runtimeInfo.sessionId === source.nativeSessionId;
    },
  };
}
