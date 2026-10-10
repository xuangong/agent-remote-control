import { conversationLocalStorage, conversationSessionStorage } from '../conversation-storage.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentReplicaState, RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { SessionDirectoryClient, type CreateSessionOptions, type OpenedSession } from '../directory-client.js';
import { ForkStore, currentForkSource, referenceForkContext, type SessionFork } from '../session-forks.js';
import { configureFork } from '../fork-actions.js';
import { DraftStore } from '../draft-store.js';
import { sessionKey } from '../session-tree.js';

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
interface AskOpenOptions { synchronize?: () => Promise<void>; restoring?: AbortController }

export function useAskConversations(baseUrl: string, transport: RemoteAgentTransport, directory?: SessionDirectoryClient, selectedHostId = 'local', onCreated?: () => void) {
  const preparations = useRef(new Map<string, AbortController>());
  const preparationSettlements = useRef(new Map<string, Promise<void>>());
  const resumeRequested = useRef(new Set<string>());
  // A tab-local ledger keeps retries idempotent without populating the normal fork list.
  const storage = useMemo(() => {
    try { return conversationSessionStorage; } catch { return undefined; }
  }, [baseUrl]);
  const store = useMemo(() => new ForkStore(`ask:${baseUrl}`, storage), [baseUrl, storage]);
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
  const inputsKey = (key: string) => `agent-remote-ask:${baseUrl}:inputs:${key}`;
  function savedInputs(key: string): AskInput[] {
    try {
      const saved: unknown = JSON.parse(storage?.getItem(inputsKey(key)) ?? '[]');
      return Array.isArray(saved) ? saved.filter((input): input is AskInput => input && typeof input.id === 'string' && typeof input.text === 'string') : [];
    } catch { return []; }
  }
  function saveInputs(key: string, inputs: AskInput[]) {
    if (!storage) throw new Error('Ask could not save the question. Enable browser storage before sending.');
    if (inputs.length) storage.setItem(inputsKey(key), JSON.stringify(inputs));
    else storage.removeItem(inputsKey(key));
  }
  const entries = useMemo(() => new Map<string, AskEntry>(), [store]);
  const [revision, refresh] = useState(0);
  const windowKey = `agent-remote-ask:${baseUrl}:open-windows`;
  const windows = useMemo(() => {
    let expanded: string[] = [];
    try {
      const saved: unknown = JSON.parse(storage?.getItem(windowKey) ?? 'null');
      if (Array.isArray(saved)) expanded = saved.filter((key): key is string => typeof key === 'string');
      else {
        const previous = storage?.getItem(`agent-remote-ask:${baseUrl}:open`);
        if (previous) expanded = [previous];
      }
    } catch { /* Keep Ask usable without window-state persistence. */ }
    return { expanded: new Set(expanded), restoring: new Set(expanded), controllers: new Map<string, AbortController>(), preferences: new Map<string, boolean>() };
  }, [baseUrl, storage]);
  useEffect(() => () => { for (const controller of windows.controllers.values()) controller.abort(); }, [windows]);
  function isOpen(source: OpenedSession) { return windows.expanded.has(sessionKey(source)); }
  function isEnabled(source: OpenedSession): boolean {
    const key = sessionKey(source);
    if (windows.preferences.has(key)) return windows.preferences.get(key)!;
    let saved: string | null = null;
    try { saved = conversationLocalStorage.getItem(`agent-remote-ask:${baseUrl}:enabled:${key}`) ?? localStorage.getItem('agent-remote-ask-enabled'); }
    catch { /* The current source remains usable without preferences. */ }
    return saved !== null ? saved === 'true' : !!entryFor(source).record?.remote;
  }
  function setOpen(key: string, expanded: boolean) {
    windows.controllers.get(key)?.abort();
    windows.controllers.delete(key);
    windows.restoring.delete(key);
    if (expanded) windows.expanded.add(key); else windows.expanded.delete(key);
    try {
      storage?.setItem(windowKey, JSON.stringify([...windows.expanded]));
      storage?.removeItem(`agent-remote-ask:${baseUrl}:open`);
    } catch { /* Keep the current window usable when storage is unavailable. */ }
    refresh(value => value + 1);
  }
  function setEnabled(source: OpenedSession, enabled: boolean) {
    const key = sessionKey(source);
    windows.preferences.set(key, enabled);
    try { conversationLocalStorage.setItem(`agent-remote-ask:${baseUrl}:enabled:${key}`, String(enabled)); }
    catch { /* Keep this source preference for the current page. */ }
    if (!enabled) {
      setOpen(key, false);
      resumeRequested.current.delete(key);
      preparations.current.get(key)?.abort();
    }
    refresh(value => value + 1);
  }
  function toggle(source: OpenedSession) { setEnabled(source, !isEnabled(source)); }
  function close(source: OpenedSession) {
    const key = sessionKey(source);
    setOpen(key, false);
    resumeRequested.current.delete(key);
    preparations.current.get(key)?.abort();
  }
  const drafts = useMemo(() => new DraftStore(`${baseUrl}:ask`), [baseUrl]);
  useEffect(() => store.subscribe(() => refresh(value => value + 1)), [store]);
  function update(key: string, change: Partial<AskEntry>) {
    entries.set(key, { ...entries.get(key)!, ...change });
    refresh(value => value + 1);
  }
  function setDraft(key: string, text: string) {
    drafts.set(key, text);
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
  function entryFor(source: OpenedSession) {
    const key = sessionKey(source);
    let entry = entries.get(key);
    if (!entry) {
      const saved = store.all().filter(record => sessionKey(currentForkSource(record)) === key).reverse();
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
    const candidates = records.filter(record => sessionKey(currentForkSource(record)) === key);
    const latest = isAskAttached(entry) && windows.expanded.has(key)
      ? retained ?? records.find(record => record.id === entry.record!.id) : candidates.at(-1) ?? retained;
    if (latest) {
      const same = !!entry.record && askParticipantKey(entry.record) === askParticipantKey(latest);
      const record = same && isAskAttached(entry) ? { ...latest, target: { ...latest.target!, agentId: entry.record!.target!.agentId } } : latest;
      return { ...entry, record, attached: same ? entry.attached : false, attachedParticipant: same ? entry.attachedParticipant : undefined };
    }
    return entry.record?.remote ? { ...entry, record: undefined, attached: false } : entry;
  }
  function restore(source: OpenedSession, synchronize: () => Promise<void>) {
    const key = sessionKey(source);
    const previous = windows.controllers.get(key);
    if (!isEnabled(source) || !windows.restoring.has(key) || previous && !previous.signal.aborted || !windows.expanded.has(key) || !directory) return;
    const owner = owners.current;
    const preparation = new AbortController();
    windows.controllers.set(key, preparation);
    const retained = entryFor(source);
    let participant = askOwnerKey(retained);
    const ownsRestore = () => owner.active && windows.controllers.get(key) === preparation && askOwnerKey(entries.get(key)) === participant;
    update(key, { restoring: true, restoreOnly: true, error: undefined });
    void synchronize().then(async () => {
      if (!ownsRestore() || preparation.signal.aborted || !windows.expanded.has(key) || !isEnabled(source)) return;
      const latest = withLatestRecord(key, entries.get(key)!);
      update(key, latest);
      participant = askOwnerKey(latest);
      await open(undefined, source, '', false, { restoring: preparation });
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
  async function open(sourceState: AgentReplicaState | undefined, source: OpenedSession, args = '', clean = false, { synchronize, restoring }: AskOpenOptions = {}) {
    if (!restoring) setEnabled(source, true);
    const key = sessionKey(source);
    let entry = entryFor(source);
    if (!restoring) setOpen(key, true);
    if (entry.busy) {
      if (preparations.current.get(key)?.signal.aborted && !args.trim() && !clean) {
        if (restoring) {
          await preparationSettlements.current.get(key);
          if (restoring.signal.aborted || !isEnabled(source) || !windows.expanded.has(key)) return {};
          return open(sourceState, source, '', false, { synchronize, restoring });
        }
        resumeRequested.current.add(key);
        return {};
      }
      throw new Error('Ask is already opening.');
    }
    if (clean && entry.inputs?.length) throw new Error('Wait for the saved Ask question to send before clearing.');
    if (!directory) throw new Error('Open the source session before starting Ask.');
    const draftAtStart = drafts.get(key);
    update(key, { busy: true, restoring: !!restoring, error: undefined });
    const owner = owners.current;
    const preparation = restoring ?? new AbortController();
    let participant = entry.pending ?? entry.record;
    const ownsEntry = () => owner.active && preparations.current.get(key) === preparation
      && askOwnerKey(entries.get(key)) === askOwnerKey({ record: participant });
    const requireCurrent = () => {
      preparation.signal.throwIfAborted();
      if (!ownsEntry()) throw new Error('The Ask participant changed. Retry the current Ask.');
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
      if (replacing && drafts.get(key) === draftAtStart) setDraft(key, '');
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
      if (current && resumeRequested.current.delete(key) && isEnabled(source) && windows.expanded.has(key)) {
        void open(sourceState, source, '', false, { synchronize }).catch(() => {});
      }
    }
  }

  return { revision, isEnabled, isOpen, toggle, store, entries, entryFor, drafts, setDraft, sendInput, discardInput, restore, open, close };
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
