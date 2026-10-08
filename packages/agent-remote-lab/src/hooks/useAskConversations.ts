import { conversationLocalStorage, conversationSessionStorage } from '../conversation-storage.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentReplicaState, RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { SessionDirectoryClient, type CreateSessionOptions, type OpenedSession } from '../directory-client.js';
import { ForkStore, referenceForkContext, type SessionFork } from '../session-forks.js';
import { configureFork } from '../fork-actions.js';
import { DraftStore } from '../draft-store.js';
import { sessionKey } from '../session-tree.js';

export type AskInputSender = (text: string, operationId: string) => Promise<unknown>;
export interface AskInput { id: string; text: string }
export interface AskEntry { attached?: boolean; restoring?: boolean; restoreOnly?: boolean; inputs?: AskInput[]; source: OpenedSession; record?: SessionFork; pending?: SessionFork; busy?: boolean; error?: string }

export function useAskConversations(baseUrl: string, transport: RemoteAgentTransport, directory?: SessionDirectoryClient, selectedHostId = 'local', onCreated?: () => void) {
  const preparations = useRef(new Map<string, AbortController>());
  const preparationSettlements = useRef(new Map<string, Promise<void>>());
  const resumeRequested = useRef(new Set<string>());
  useEffect(() => () => {
    resumeRequested.current.clear();
    for (const preparation of preparations.current.values()) preparation.abort();
  }, []);
  // A tab-local ledger keeps retries idempotent without populating the normal fork list.
  const storage = useMemo(() => {
    try { return conversationSessionStorage; } catch { return undefined; }
  }, [baseUrl]);
  const store = useMemo(() => new ForkStore(`ask:${baseUrl}`, storage), [baseUrl, storage]);
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
  function sendInput(key: string, id: string, send: AskInputSender) {
    const entry = entries.get(key);
    const input = entry?.inputs?.find(input => input.id === id);
    if (!input) return;
    // The visible conversation owns the outbox and its recovery subscription.
    // Once handed off, uncertain delivery is retried explicitly in that outbox.
    const remaining = entry!.inputs!.filter(input => input.id !== id);
    try { saveInputs(key, remaining); }
    catch { update(key, { error: 'Ask could not hand off the saved question. Free browser storage and retry.' }); return; }
    const sent = send(input.text, input.id);
    update(key, { inputs: remaining });
    void sent.catch(() => {});
  }
  function entryFor(source: OpenedSession) {
    const key = sessionKey(source);
    let entry = entries.get(key);
    if (!entry) {
      const saved = store.all().filter(record => sessionKey(record.source) === key).reverse();
      entry = { source, restoring: windows.restoring.has(key), restoreOnly: windows.restoring.has(key), inputs: savedInputs(key), record: saved.find(record => record.target && !record.creationKey), pending: saved.find(record => !!record.creationKey) };
      entries.set(key, entry);
    }
    if (!entry.busy && (!entry.attached || !windows.expanded.has(key)) && !entry.pending) {
      const latest = store.all().filter(record => record.target && !record.creationKey && sessionKey(record.source) === key).at(-1);
      if (latest) {
        if (entry.record?.id !== latest.id) entry.attached = false;
        entry.record = latest;
      }
      else if (entry.record?.remote) entry.record = undefined;
    }
    return entry;
  }
  function restore(source: OpenedSession, synchronize: () => Promise<void>) {
    const key = sessionKey(source);
    const previous = windows.controllers.get(key);
    if (!isEnabled(source) || !windows.restoring.has(key) || previous && !previous.signal.aborted || !windows.expanded.has(key) || !directory) return;
    const preparation = new AbortController();
    windows.controllers.set(key, preparation);
    entryFor(source);
    update(key, { restoring: true, restoreOnly: true, error: undefined });
    void synchronize().then(async () => {
      if (preparation.signal.aborted || !windows.expanded.has(key) || !isEnabled(source)) return;
      await open(undefined, source, '', false, preparation);
    }).catch(error => {
      if (!preparation.signal.aborted) update(key, { error: error instanceof Error ? error.message : 'Ask could not restore. Retry to reconnect.' });
    }).finally(() => {
      if (windows.controllers.get(key) !== preparation) return;
      windows.controllers.delete(key);
      if (!preparation.signal.aborted) windows.restoring.delete(key);
      update(key, { restoring: false });
    });
    return () => preparation.abort();
  }
  async function open(sourceState: AgentReplicaState | undefined, source: OpenedSession, args = '', clean = false, restoring?: AbortController) {
    if (!restoring) setEnabled(source, true);
    const key = sessionKey(source);
    const entry = entryFor(source);
    if (!restoring) setOpen(key, true);
    if (entry.busy) {
      if (preparations.current.get(key)?.signal.aborted && !args.trim() && !clean) {
        if (restoring) {
          await preparationSettlements.current.get(key);
          if (restoring.signal.aborted || !isEnabled(source) || !windows.expanded.has(key)) return {};
          return open(sourceState, source, '', false, restoring);
        }
        resumeRequested.current.add(key);
        return {};
      }
      throw new Error('Ask is already opening.');
    }
    if (clean && entry.inputs?.length) throw new Error('Wait for the saved Ask question to send before clearing.');
    if (!directory) throw new Error('Open the source session before starting Ask.');
    const replacing = clean || !!(entry.pending && entry.record && entry.pending.id !== entry.record.id);
    const draftAtStart = drafts.get(key);
    const target = (source.hostId ?? 'local') === selectedHostId ? directory : new SessionDirectoryClient(baseUrl, undefined, source.hostId);
    update(key, { busy: true, restoring: !!restoring, error: undefined });
    const queueQuestion = () => {
      if (!args.trim()) return;
      const inputs = [...(entries.get(key)?.inputs ?? []), { id: crypto.randomUUID(), text: args.trim() }];
      saveInputs(key, inputs);
      update(key, { inputs });
    };
    const preparation = restoring ?? new AbortController();
    let finishPreparation!: () => void;
    preparationSettlements.current.set(key, new Promise<void>(resolve => { finishPreparation = resolve; }));
    preparations.current.set(key, preparation);
    try {
      let record = entry.pending ?? (!clean ? entry.record : undefined);
      if (restoring && !record?.target || entry.restoreOnly && !clean && !record) throw new Error('The saved Ask session is not available yet. Retry to reconnect.');
      if (!record) {
        const agent = sourceState?.agent;
        if (!agent?.runtimeInfo.sessionId) throw new Error('Open the source session before starting Ask.');
        const options: CreateSessionOptions = { conversationKind: 'ask', sourceNativeSessionId: source.nativeSessionId,
          ...(agent.cwd ? { cwd: agent.cwd } : {}), ...(agent.model ? { model: agent.model } : {}),
          ...(agent.capabilities.planning ? { planning: agent.runtimeInfo.planning?.active === true } : {}) };
        const settings = (agent.runtimeInfo.settings ?? []).filter(setting => setting.mutable && setting.scope === 'session' && setting.value !== null).map(({ id, value }) => ({ id, value }));
        record = store.prepare(referenceForkContext(source), options, settings, key);
        update(key, { pending: record });
      }
      const result = record.target ? await target.attach(source.providerId, record.target.nativeSessionId, preparation.signal)
        : await target.create(source.providerId, record.id, record.options);
      store.bind(record.id, { agentId: result.agentId, nativeSessionId: result.nativeSessionId ?? record.target?.nativeSessionId ?? result.agentId,
        providerId: source.providerId, hostId: source.hostId ?? 'local', title: 'Ask', createdAt: record.capturedAt });
      update(key, { pending: store.get(record.id) });
      preparation.signal.throwIfAborted();
      await configureFork(transport, store, store.get(record.id), preparation.signal);
      store.finishCreation(record.id);
      update(key, { record: store.get(record.id), pending: undefined, attached: true, restoreOnly: false });
      if (replacing && drafts.get(key) === draftAtStart) setDraft(key, '');
      onCreated?.();
      queueQuestion();
      return {};
    } catch (error) {
      if (preparation.signal.aborted) { queueQuestion(); return {}; }
      update(key, { error: error instanceof Error ? error.message : 'Ask could not open. Retry to reconnect.' });
      throw error;
    } finally {
      preparations.current.delete(key);
      preparationSettlements.current.delete(key);
      update(key, { busy: false });
      finishPreparation();
      if (resumeRequested.current.delete(key) && isEnabled(source) && windows.expanded.has(key)) {
        void open(sourceState, source).catch(() => {});
      }
    }
  }
  return { revision, isEnabled, isOpen, toggle, store, entries, entryFor, drafts, setDraft, sendInput, restore, open, close };
}
