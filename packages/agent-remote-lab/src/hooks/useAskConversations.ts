import { clearCacheOnClose, conversationSessionStorage } from '../conversation-storage.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentReplicaState, RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { SessionDirectoryClient, type CreateSessionOptions, type OpenedSession } from '../directory-client.js';
import { ForkStore, currentForkSource, referenceForkContext, type SessionFork } from '../session-forks.js';
import { configureFork } from '../fork-actions.js';
import { DraftStore } from '../draft-store.js';
import { sessionKey } from '../session-tree.js';
import { compositionMetadataKey, compositionRoleKey, compositionSelection, saveCompositionAskEnabled, saveCompositionDocument, type CompositionDocument } from '../session-composition-model.js';
import { flushRecoveryWrites } from '../recovery-writes.js';
import { recoveryGeneration } from '../conversation-recovery.js';
import { inspectAskDock, flushAskDock } from './useAskDock.js';
import { inspectAskPosition, flushAskPosition } from './useAskPosition.js';
import { inspectSessionDisplayPreferences, flushSessionDisplayPreferences } from './useSessionDisplayPreferences.js';
import { inspectImageDraft } from '@orchardworks/agent-remote-web/browser';
import type { CompositionParticipantResult } from '../session-composition-application.js';

export type AskInputSender = (text: string, operationId: string) => Promise<unknown>;
interface AskInputOwner { recordId: string; target?: string; creation?: string }
export interface AskInput { id: string; text: string; owner?: AskInputOwner }
export interface AskEntry { attached?: boolean; attachedParticipant?: string; restoring?: boolean; restoreOnly?: boolean; inputs?: AskInput[]; source: OpenedSession; record?: SessionFork; pending?: SessionFork; busy?: boolean; error?: string }
/** Scoped ledger/relation identity and concrete native recipient, independent of navigation. */
export function askParticipantKey(record: SessionFork): string {
  return JSON.stringify([record.id, record.target ? sessionKey(record.target) : null]);
}
export function isAskAttached(entry?: AskEntry): boolean {
  return !!entry?.attached && !!entry.record?.target && entry.attachedParticipant === askParticipantKey(entry.record);
}
interface AskOpenOptions { synchronize?: () => Promise<void>; restoring?: AbortController; associationOwner: string }

export function useAskConversations(document: CompositionDocument, transport: RemoteAgentTransport, directory?: SessionDirectoryClient, selectedHostId = 'local', onCreated?: () => void) {
  const baseUrl = document.scope;
  const preparations = useRef(new Map<string, AbortController>());
  const preparationSettlements = useRef(new Map<string, Promise<void>>());
  const resumeRequested = useRef(new Set<string>());
  // A tab-local ledger keeps retries idempotent without populating the normal fork list.
  const storage = useMemo(() => {
    try { return conversationSessionStorage; } catch { return undefined; }
  }, [baseUrl]);
  const store = useMemo(() => new ForkStore(`ask:${baseUrl}`, storage), [baseUrl, storage]);
  const association = useMemo(() => ({ edits: new Map<string, number>(), epochs: new Map<string, number>(), generation: recoveryGeneration(baseUrl), saved: true }), [document]);
  const associationOwner = (key: string) => document.asks.find(owner => owner.id === key);
  const ownerEditRevision = (key: string) => association.edits.get(key) ?? 0;
  const edited = (key: string) => association.edits.set(key, ownerEditRevision(key) + 1);
  const keyFor = (_source: OpenedSession, owner: string): string => {
    if (!owner || !associationOwner(owner)) throw new Error('The Ask association owner is unavailable.');
    return owner;
  };
  const matchesSource = (record: SessionFork, key: string) => associationOwner(key)?.records?.some(reference => reference.id === record.id
    && (reference.target === undefined ? !record.remote : !!record.target && sessionKey(record.target) === reference.target)) === true;
  function persist(isCurrent: () => boolean) {
    const handle = saveCompositionDocument(document, () => association.generation === recoveryGeneration(baseUrl) && isCurrent());
    flushRecoveryWrites(compositionMetadataKey(baseUrl));
    association.saved = handle.result?.status === 'saved';
    return handle;
  }
  const owners = useMemo(() => ({ current: { active: true } }), [store, transport]);
  useEffect(() => {
    const owner = { active: true };
    owners.current = owner;
    return () => {
      owner.active = false;
      resumeRequested.current.clear();
      for (const preparation of preparations.current.values()) preparation.abort();
      for (const entry of entries.values()) entry.busy = false;
    };
  }, [owners]);
  const inputsKey = (key: string) => { const owner = associationOwner(key); if (!owner) throw new Error('Ask owner unavailable.'); return owner.input.key; };
  const inputFailures = useMemo(() => new Set<string>(), [store]);
  function savedInputs(key: string): AskInput[] {
    try {
      const saved: unknown = JSON.parse(storage?.getItem(inputsKey(key)) ?? '[]');
      if (!Array.isArray(saved) || !saved.every(input => input && typeof input.id === 'string' && typeof input.text === 'string')) throw new Error('Invalid saved Ask questions.');
      inputFailures.delete(key); return saved;
    } catch { inputFailures.add(key); return []; }
  }
  function saveInputs(key: string, inputs: AskInput[]) {
    if (!storage) throw new Error('Ask could not save the question. Enable browser storage before sending.');
    if (inputFailures.has(key)) throw new Error('The original Ask questions could not be read. Restore browser storage before changing this queue.');
    if (inputs.length) storage.setItem(inputsKey(key), JSON.stringify(inputs));
    else storage.removeItem(inputsKey(key));
  }
  const entries = useMemo(() => new Map<string, AskEntry>(), [store]);
  const [revision, refresh] = useState(0);
  const windows = useMemo(() => {
    const expanded = document.asks.filter(owner => owner.open).map(owner => owner.id);
    return { restoring: new Set(expanded), revision: 0, controllers: new Map<string, AbortController>() };
  }, [document]);
  useEffect(() => () => { for (const controller of windows.controllers.values()) controller.abort(); }, [windows]);
  const expanded = (key: string) => associationOwner(key)?.open === true;
  function isOpen(source: OpenedSession, associationOwner: string) { return expanded(keyFor(source, associationOwner)); }
  function isEnabled(source: OpenedSession, associationOwnerId: string): boolean {
    const key = keyFor(source, associationOwnerId);
    return associationOwner(key)?.enabled ?? !!entryFor(source, key).record?.remote;
  }
  function setOpen(key: string, expanded: boolean) {
    const owner = associationOwner(key); if (!owner) throw new Error('Ask owner unavailable.');
    edited(key); windows.revision++;
    windows.controllers.get(key)?.abort(); windows.controllers.delete(key); windows.restoring.delete(key);
    owner.open = expanded; document.editRevision++; persist(() => owners.current.active);
    refresh(value => value + 1);
  }
  function setEnabled(source: OpenedSession, enabled: boolean, associationOwnerId: string) {
    const key = keyFor(source, associationOwnerId), owner = associationOwner(key)!;
    try { saveCompositionAskEnabled(document, key, enabled, () => owners.current.active && association.generation === recoveryGeneration(baseUrl)); }
    catch { update(key, { error: 'Ask could not save this preference. Restore browser storage and retry.' }); return false; }
    edited(key); owner.enabled = enabled; document.editRevision++; persist(() => owners.current.active);
    if (!enabled) { setOpen(key, false); resumeRequested.current.delete(key); preparations.current.get(key)?.abort(); }
    refresh(value => value + 1);
    return true;
  }
  function toggle(source: OpenedSession, associationOwner: string) { setEnabled(source, !isEnabled(source, associationOwner), associationOwner); }
  function close(source: OpenedSession, associationOwner: string) {
    const key = keyFor(source, associationOwner);
    setOpen(key, false);
    resumeRequested.current.delete(key);
    preparations.current.get(key)?.abort();
  }
  const drafts = useMemo(() => new DraftStore(`${baseUrl}:ask`), [baseUrl]);
  const draftStores = useMemo(() => new Map([[`${baseUrl}:ask`, drafts]]), [drafts, baseUrl]);
  function draftBinding(key: string) {
    const binding = associationOwner(key)?.text; if (!binding) throw new Error('Ask draft owner unavailable.');
    let store = draftStores.get(binding.scope);
    if (!store) { store = new DraftStore(binding.scope); draftStores.set(binding.scope, store); }
    return { store, key: binding.key };
  }
  function registerSharedRecords() {
    let changed = false;
    const records = store.all().filter(record => record.remote && record.target);
    for (const owner of document.asks) {
      const slot = document.slots.find(slot => slot.id === owner.sourceSlot);
      if (!slot || slot.intent.kind === 'history') continue;
      for (const record of records) {
        const binding = record.sourceBinding;
        const matches = binding?.kind === 'primary_role'
          ? slot.intent.kind === 'role' && !!record.hostLocator && slot.intent.roleKey === compositionRoleKey({ scope: baseUrl,
            hostId: record.hostLocator.hostId, controllerId: record.hostLocator.controllerId, roleId: binding.roleId })
          : slot.intent.kind === 'fixed' && sessionKey(compositionSelection(slot)) === sessionKey(currentForkSource(record))
            && (!slot.intent.target.native.controllerId || record.hostLocator?.controllerId === slot.intent.target.native.controllerId);
        if (!matches || owner.records?.some(reference => reference.id === record.id && reference.target === sessionKey(record.target!))) continue;
        owner.records = [...(owner.records ?? []), { id: record.id, target: sessionKey(record.target!) }];
        edited(owner.id); changed = true;
      }
    }
    if (changed) { document.editRevision++; persist(() => owners.current.active); }
  }
  useEffect(() => {
    const changed = () => { registerSharedRecords(); refresh(value => value + 1); };
    changed(); return store.subscribe(changed);
  }, [store, document]);
  function update(key: string, change: Partial<AskEntry>) {
    edited(key);
    entries.set(key, { ...entries.get(key)!, ...change });
    const owner = associationOwner(key);
    if (owner) {
      let changed = false;
      for (const record of [change.record, change.pending]) if (record) {
        const reference = { id: record.id, ...(record.target ? { target: sessionKey(record.target) } : {}) };
        if (!owner.records?.some(existing => existing.id === reference.id && existing.target === reference.target)) {
          owner.records = [...(owner.records ?? []).filter(existing => reference.target === undefined || existing.id !== reference.id || existing.target !== undefined), reference];
          changed = true;
        }
      }
      if (changed) { document.editRevision++; persist(() => owners.current.active); }
    }
    refresh(value => value + 1);
  }
  function setDraft(key: string, text: string) {
    edited(key);
    const binding = draftBinding(key); binding.store.set(binding.key, text);
  }
  function sendInput(key: string, id: string, send: AskInputSender, participant?: string) {
    const entry = entries.get(key);
    if (!isAskAttached(entry) || !entry?.record || participant && askParticipantKey(entry.record) !== participant) return;
    const input = entry?.inputs?.find(input => input.id === id);
    if (!input) return;
    if (input.owner?.recordId !== entry.record.id || input.owner?.target !== sessionKey(entry.record.target!)) {
      update(key, { error: 'The saved question belongs to an unconfirmed or different Ask recipient. Restore the original Ask or discard this saved question.' });
      return;
    }
    // The visible conversation owns the outbox and its recovery subscription.
    // Once handed off, uncertain delivery is retried explicitly in that outbox.
    const remaining = entry!.inputs!.filter(input => input.id !== id);
    try { saveInputs(key, remaining); }
    catch { update(key, { error: 'Ask could not hand off the saved question. Free browser storage and retry.' }); return; }
    const sent = send(input.text, input.id);
    update(key, { inputs: remaining });
    void sent.catch(() => {});
  }
  function discardInput(key: string, id: string) {
    const entry = entries.get(key);
    if (!entry?.inputs?.some(input => input.id === id)) return;
    const remaining = entry.inputs.filter(input => input.id !== id);
    try { saveInputs(key, remaining); }
    catch { update(key, { error: 'Ask could not discard the saved question. Free browser storage and retry.' }); return; }
    update(key, { inputs: remaining });
  }
  function confirmInputOwners(key: string, record: SessionFork) {
    if (record.remote || !record.target || !record.creationKey) return;
    const creation = askCreationEvidence(checkedAskOperation(store, record));
    let changed = false;
    const inputs = (entries.get(key)?.inputs ?? []).map(input => {
      if (input.owner?.recordId !== record.id || input.owner.target !== undefined || input.owner.creation !== creation) return input;
      changed = true;
      return { ...input, owner: { recordId: record.id, target: sessionKey(record.target!) } };
    });
    if (changed) { saveInputs(key, inputs); update(key, { inputs }); }
  }
  function entryFor(source: OpenedSession, associationOwner: string) {
    const key = keyFor(source, associationOwner);
    let entry = entries.get(key);
    if (!entry) {
      const saved = store.all().filter(record => matchesSource(record, key)).reverse();
      entry = { source, restoring: windows.restoring.has(key), restoreOnly: windows.restoring.has(key), inputs: savedInputs(key), record: saved.find(record => record.target && !record.creationKey), pending: saved.find(record => !!record.creationKey) };
      entries.set(key, entry);
    }
    if (!entry.busy && !entry.pending) {
      entry = withLatestRecord(key, entry);
      entries.set(key, entry);
    }
    return entry;
  }
  function withLatestRecord(key: string, entry: AskEntry): AskEntry {
    if (entry.pending) return entry;
    const records = store.all().filter(record => record.target && !record.creationKey);
    const retained = entry.record && records.find(record => askParticipantKey(record) === askParticipantKey(entry.record!));
    const candidates = records.filter(record => matchesSource(record, key));
    const latest = isAskAttached(entry) && expanded(key)
      ? retained ?? records.find(record => record.id === entry.record!.id) : candidates.at(-1) ?? retained;
    if (latest) {
      const same = !!entry.record && askParticipantKey(entry.record) === askParticipantKey(latest);
      const record = same && isAskAttached(entry) ? { ...latest, target: { ...latest.target!, agentId: entry.record!.target!.agentId } } : latest;
      return { ...entry, record, attached: same ? entry.attached : false, attachedParticipant: same ? entry.attachedParticipant : undefined };
    }
    return entry.record?.remote ? { ...entry, record: undefined, attached: false } : entry;
  }
  function restore(source: OpenedSession, synchronize: () => Promise<void>, associationOwner: string) {
    const key = keyFor(source, associationOwner);
    const epoch = association.epochs.get(key);
    const previous = windows.controllers.get(key);
    if (!isEnabled(source, associationOwner) || !windows.restoring.has(key) || previous && !previous.signal.aborted || !expanded(key) || !directory) return;
    const owner = owners.current;
    const preparation = new AbortController();
    windows.controllers.set(key, preparation);
    const retained = entryFor(source, associationOwner);
    let participant = askOwnerKey(retained);
    const ownsRestore = () => owner.active && association.epochs.get(key) === epoch && windows.controllers.get(key) === preparation && askOwnerKey(entries.get(key)) === participant;
    update(key, { restoring: true, restoreOnly: true, error: undefined });
    void synchronize().then(async () => {
      if (!ownsRestore() || preparation.signal.aborted || !expanded(key) || !isEnabled(source, associationOwner)) return;
      const latest = withLatestRecord(key, entries.get(key)!);
      update(key, latest);
      participant = askOwnerKey(latest);
      await open(undefined, source, '', false, { restoring: preparation, associationOwner });
    }).catch(error => {
      if (ownsRestore() && !preparation.signal.aborted) update(key, { error: error instanceof Error ? error.message : 'Ask could not restore. Retry to reconnect.' });
    }).finally(() => {
      if (windows.controllers.get(key) !== preparation) return;
      const current = ownsRestore();
      windows.controllers.delete(key);
      if (!current) return;
      if (!preparation.signal.aborted) windows.restoring.delete(key);
      update(key, { restoring: false });
    });
    return () => preparation.abort();
  }
  async function open(sourceState: AgentReplicaState | undefined, source: OpenedSession, args: string, clean: boolean, { synchronize, restoring, associationOwner }: AskOpenOptions) {
    if (!restoring && !setEnabled(source, true, associationOwner)) throw new Error('Ask could not save this preference. Restore browser storage and retry.');
    const key = keyFor(source, associationOwner);
    const epoch = association.epochs.get(key);
    let entry = entryFor(source, associationOwner);
    if (!restoring) setOpen(key, true);
    if (entry.busy) {
      if (associationOwner && preparations.current.get(key)?.signal.aborted) {
        await preparationSettlements.current.get(key);
        if (association.epochs.get(key) !== epoch || !owners.current.active || !expanded(key)) return {};
        return open(sourceState, source, args, clean, { synchronize, restoring, associationOwner });
      }
      if (preparations.current.get(key)?.signal.aborted && !args.trim() && !clean) {
        if (restoring) {
          await preparationSettlements.current.get(key);
          if (restoring.signal.aborted || !isEnabled(source, associationOwner) || !expanded(key)) return {};
          return open(sourceState, source, '', false, { synchronize, restoring, associationOwner });
        }
        resumeRequested.current.add(key);
        return {};
      }
      throw new Error('Ask is already opening.');
    }
    if (clean && entry.inputs?.length) throw new Error('Wait for the saved Ask question to send before clearing.');
    if (!directory) throw new Error('Open the source session before starting Ask.');
    const textBinding = draftBinding(key);
    const draftAtStart = textBinding.store.get(textBinding.key);
    update(key, { busy: true, restoring: !!restoring, error: undefined });
    const owner = owners.current;
    const preparation = restoring ?? new AbortController();
    let participant = entry.pending ?? entry.record;
    const ownsEntry = () => owner.active && association.epochs.get(key) === epoch && preparations.current.get(key) === preparation
      && askOwnerKey(entries.get(key)) === askOwnerKey({ record: participant });
    const requireCurrent = () => {
      preparation.signal.throwIfAborted();
      if (!ownsEntry()) throw new Error('The Ask participant changed. Retry the current Ask.');
      if (associationOwner && !association.saved) throw new Error('Ask could not retain its association owner. Free browser storage and retry.');
    };
    const question: AskInput | undefined = args.trim() ? { id: crypto.randomUUID(), text: args.trim() } : undefined;
    let queued = false;
    const queueQuestion = (record: SessionFork) => {
      if (!question || queued) return;
      requireCurrent();
      question.owner = record.target ? { recordId: record.id, target: sessionKey(record.target) }
        : { recordId: record.id, creation: askCreationEvidence(record) };
      const inputs = [...(entries.get(key)?.inputs ?? []), question];
      saveInputs(key, inputs);
      update(key, { inputs });
      queued = true;
    };
    const settleRetired = () => {
      if (question && !queued) throw new Error('Ask could not retain the submitted question. Retry from the submitting draft.');
      return {};
    };
    let finishPreparation!: () => void;
    const settlement = new Promise<void>(resolve => { finishPreparation = resolve; });
    preparationSettlements.current.set(key, settlement);
    preparations.current.set(key, preparation);
    let restoringCurrent = false;
    try {
      if (synchronize) {
        await waitForAskRelations(synchronize, preparation.signal);
        requireCurrent();
        entry = withLatestRecord(key, entries.get(key)!);
        update(key, entry);
        participant = entry.pending ?? entry.record;
      }
      const replacing = clean || !!(entry.pending && entry.record && entry.pending.id !== entry.record.id);
      let record = entry.pending ?? (!clean ? entry.record : undefined);
      if (restoring && !record?.target || entry.restoreOnly && !clean && !record) throw new Error('The saved Ask session is not available yet. Retry to reconnect.');
      if (!record) {
        const agent = sourceState?.agent;
        if (!agent?.runtimeInfo.sessionId) throw new Error('Open the source session before starting Ask.');
        const options: CreateSessionOptions = { conversationKind: 'ask', sourceNativeSessionId: source.nativeSessionId,
          ...(agent.cwd ? { cwd: agent.cwd } : {}), ...(agent.model ? { model: agent.model } : {}),
          ...(agent.capabilities.planning ? { planning: agent.runtimeInfo.planning?.active === true } : {}) };
        const settings = (agent.runtimeInfo.settings ?? []).filter(setting => setting.mutable && setting.scope === 'session' && setting.value !== null).map(({ id, value }) => ({ id, value }));
        requireCurrent();
        record = store.prepare(referenceForkContext(source), options, settings, key);
        update(key, { pending: record });
        participant = record;
      }
      requireCurrent();
      // Raw original operations own creation/options/settings; a view owns navigation only.
      restoringCurrent = !!entry.record && askParticipantKey(record) === askParticipantKey(entry.record);
      record = record.remote ? record : checkedAskOperation(store, record);
      if (restoringCurrent) update(key, { attached: false, attachedParticipant: undefined });
      const savedTarget = record.target;
      const locator = savedTarget ?? record.source;
      if (!locator.providerId || !locator.nativeSessionId) throw new Error('The saved Ask native locator is unavailable. Retry after restoring its identity.');
      const hostId = locator.hostId ?? 'local';
      const target = hostId === selectedHostId ? directory : new SessionDirectoryClient(baseUrl, undefined, hostId);
      const operation = record;
      queueQuestion(operation);
      const result = savedTarget ? await target.attach(savedTarget.providerId, savedTarget.nativeSessionId, preparation.signal)
        : await target.create(operation.source.providerId, operation.id, operation.options);
      if (savedTarget) {
        requireCurrent();
        if (!operation.remote) checkedAskOperation(store, operation);
        if (result.nativeSessionId !== undefined && result.nativeSessionId !== savedTarget.nativeSessionId) {
          throw new Error('The attached Ask native identity does not match its saved target. Retry the original Ask.');
        }
      } else {
        // A late successful create may retain evidence on its original pending operation.
        if (!owner.active) return settleRetired();
        checkedAskCreation(store, operation);
      }
      const bound = savedTarget ? { ...savedTarget, agentId: result.agentId }
        : { agentId: result.agentId, nativeSessionId: result.nativeSessionId ?? result.agentId,
          providerId: operation.source.providerId, hostId: operation.source.hostId ?? 'local', title: 'Ask', createdAt: operation.capturedAt };
      if (!bound.agentId || !bound.nativeSessionId) throw new Error('The Ask attachment identity could not be confirmed. Retry the original Ask.');
      store.bind(operation.id, bound);
      // Retention above is independent of permission to configure or mutate the current window.
      if (!ownsEntry()) return settleRetired();
      record = operation.remote ? store.get(operation.id) : checkedAskOperation(store, { ...operation, target: bound });
      participant = record;
      update(key, { pending: record });
      confirmInputOwners(key, record);
      requireCurrent();
      await configureFork(transport, store, record, preparation.signal);
      requireCurrent();
      if (!record.remote) checkedAskOperation(store, record);
      store.finishCreation(record.id);
      record = store.get(record.id);
      if (askParticipantKey(record) !== askParticipantKey(participant)) throw new Error('The Ask participant changed. Retry the current Ask.');
      update(key, { record, pending: undefined, attached: true, attachedParticipant: askParticipantKey(record), restoreOnly: false });
      participant = record;
      if (replacing && textBinding.store.get(textBinding.key) === draftAtStart) setDraft(key, '');
      onCreated?.();
      return {};
    } catch (error) {
      if (!ownsEntry()) return settleRetired();
      if (preparation.signal.aborted) {
        if (!(error instanceof Error && error.name === 'AbortError')) update(key, { error: error instanceof Error ? error.message : 'Ask could not retain its creation result. Retry to reconnect.' });
        return settleRetired();
      }
      update(key, { ...(restoringCurrent ? { attached: false, attachedParticipant: undefined } : {}), error: error instanceof Error ? error.message : 'Ask could not open. Retry to reconnect.' });
      if (queued) return {};
      throw error;
    } finally {
      const current = ownsEntry();
      if (preparations.current.get(key) === preparation) preparations.current.delete(key);
      if (preparationSettlements.current.get(key) === settlement) preparationSettlements.current.delete(key);
      if (current) update(key, { busy: false });
      finishPreparation();
      if (current && resumeRequested.current.delete(key) && isEnabled(source, associationOwner) && expanded(key)) {
        void open(sourceState, source, '', false, { synchronize, associationOwner }).catch(() => {});
      }
    }
  }

  function applySourceProjection(key: string, source: OpenedSession, expectedRevision: number, isCurrent: () => boolean) {
    if (!associationOwner(key) || !association.saved || !owners.current.active || association.generation !== recoveryGeneration(baseUrl) || !isCurrent() || ownerEditRevision(key) !== expectedRevision) return { status: 'pending' as const, retention: 'page' as const };
    const entry = entryFor(source, key);
    association.epochs.set(key, (association.epochs.get(key) ?? 0) + 1);
    preparations.current.get(key)?.abort(); windows.controllers.get(key)?.abort();
    resumeRequested.current.delete(key);
    update(key, { ...entry, source, busy: false, restoring: false });
    return { status: 'applied' as const, retention: 'page' as const };
  }
  async function retainAssociationOwners(keys: readonly string[], isCurrent: () => boolean): Promise<CompositionParticipantResult> {
    const edits = keys.map(key => [key, ownerEditRevision(key)] as const), windowRevision = windows.revision;
    const checks: Array<() => boolean> = [];
    const retainedCurrent = () => owners.current.active && association.generation === recoveryGeneration(baseUrl)
      && windows.revision === windowRevision && edits.every(([key, revision]) => ownerEditRevision(key) === revision) && checks.every(check => check());
    const current = () => isCurrent() && retainedCurrent();
    const retentions: Array<'page' | 'session' | 'local'> = [];
    if (!current()) return { status: 'pending', retention: 'page', code: 'ask_owner_currentness' };
    try {
      if (!storage) throw new Error('Storage unavailable.');
      // A checked enumeration proves no-record owners, without the forgiving ledger view.
      const prefix = `agent-remote-forks:ask:${baseUrl}:record:`;
      for (let index = 0; index < storage.length; index++) { const key = storage.key(index); if (key?.startsWith(prefix)) store.getLocalForEffect(key.slice(prefix.length)); }
      for (const key of keys) {
        const owner = associationOwner(key); if (!owner) throw new Error('Ask owner unavailable.');
        const unread = inputFailures.has(key);
        const saved = savedInputs(key); if (inputFailures.has(key)) throw new Error('Ask question read failed.');
        const entry = entries.get(key);
        if (unread) {
          // Failed reads never made the empty placeholder an authoritative queue.
          if (entry) update(key, { inputs: saved });
          return { status: 'pending', retention: 'page', code: 'ask_questions_recovered' };
        }
        if (entry?.inputs) saveInputs(key, entry.inputs); else saveInputs(key, saved);
        for (const reference of owner.records ?? []) {
          const record = store.getLocalForEffect(reference.id);
          if (!record) {
            const remote = store.all().find(record => record.remote && record.id === reference.id && record.target && sessionKey(record.target) === reference.target);
            if (!remote) throw new Error('Ask ledger reference unavailable.');
          } else if (reference.target !== undefined && (!record.target || sessionKey(record.target) !== reference.target)) throw new Error('Ask ledger reference changed.');
        }
        const text = draftBinding(key);
        if (text.store.inspect(text.key).status === 'failed') text.store.retryRead();
        const textSnapshot = text.store.inspect(text.key);
        if (textSnapshot.status !== 'ready') throw new Error('Ask draft read failed.');
        checks.push(() => text.store.inspect(text.key).status === 'ready' && text.store.snapshot(text.key).revision === textSnapshot.revision);
        const textResult = await text.store.flushCurrent(text.key, textSnapshot.revision, current);
        if (!current()) return { status: 'pending', retention: 'page', code: 'ask_owner_edit' };
        if (textResult.status !== 'saved') throw new Error('Ask draft write failed.');
        retentions.push(textResult.retention);
        const dock = inspectAskDock(owner.geometryScope), position = inspectAskPosition(owner.geometryScope);
        checks.push(() => inspectAskDock(owner.geometryScope).revision === dock.revision && inspectAskPosition(owner.geometryScope).revision === position.revision);
        const dockResult = flushAskDock(owner.geometryScope, dock.revision, current), positionResult = flushAskPosition(owner.geometryScope, position.revision, current);
        if (dockResult.status !== 'ready' || positionResult.status !== 'ready') throw new Error('Ask geometry retention incomplete.');
        retentions.push(dockResult.retention, positionResult.retention);
        if (owner.display) {
          const display = inspectSessionDisplayPreferences(owner.display), result = flushSessionDisplayPreferences(owner.display, display.revision, current);
          if (result.status !== 'ready') throw new Error('Ask display retention incomplete.');
          checks.push(() => inspectSessionDisplayPreferences(owner.display!).revision === display.revision); retentions.push(result.retention);
        }
        if (owner.image) {
          const image = await inspectImageDraft(owner.image), snapshot = image.snapshot();
          if (!current()) return { status: 'pending', retention: 'page', code: 'ask_owner_edit' };
          checks.push(() => image.snapshot().revision === snapshot.revision && image.snapshot().status !== 'cancelled');
          const result = await image.flush(snapshot.revision, current);
          if (!current()) return { status: 'pending', retention: 'page', code: 'ask_owner_edit' };
          if (result.status !== 'ready' || result.savedRevision !== result.revision) throw new Error('Ask image retention incomplete.'); retentions.push(result.retention);
        }
      }
      if (!current()) return { status: 'pending', retention: 'page', code: 'ask_owner_edit' };
      const result = await persist(current).completion;
      if (!current()) return { status: 'pending', retention: 'page', code: 'ask_owner_edit' };
      if (result.status !== 'saved') throw new Error('Ask composition write failed.');
      retentions.push(result.retention, clearCacheOnClose() ? 'page' : 'session');
      return { status: 'applied', retention: retentions.includes('page') ? 'page' : retentions.includes('session') ? 'session' : 'local', retainedCurrent };
    } catch { return { status: 'failed', retention: 'page', code: 'ask_retention' }; }
  }
  return { revision, isEnabled, isOpen, toggle, store, entries, entryFor, drafts, draftBinding, setDraft, sendInput, discardInput, restore, open, close,
    associationOwner, ownerEditRevision, applySourceProjection, retainAssociationOwners };
}

async function waitForAskRelations(synchronize: () => Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  // Closing this window releases its wait without cancelling the shared query.
  try { await Promise.race([synchronize(), cancelled]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

function askOwnerKey(entry?: Pick<AskEntry, 'pending' | 'record'>): string | undefined {
  const record = entry?.pending ?? entry?.record;
  return record ? askParticipantKey(record) : undefined;
}
function checkedAskOperation(store: ForkStore, expected: SessionFork): SessionFork {
  const raw = store.getLocalForEffect(expected.id);
  if (!raw || expected.target && (!raw.target || sessionKey(raw.target) !== sessionKey(expected.target))) {
    throw new Error('The original Ask context is unavailable. Retry after restoring browser storage.');
  }
  return raw;
}
function checkedAskCreation(store: ForkStore, expected: SessionFork): void {
  const raw = checkedAskOperation(store, expected);
  if (!expected.creationKey || askCreationEvidence(raw) !== askCreationEvidence(expected)) {
    throw new Error('The original Ask creation changed. Retry after restoring its saved operation.');
  }
}
function askCreationEvidence(record: SessionFork): string {
  return JSON.stringify([record.id, record.mode, record.source, record.capturedAt, record.options, record.settings,
    record.creationKey, record.mode === 'reference' ? null : [record.boundary, record.text, record.itemCount]]);
}
