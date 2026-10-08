import { conversationSessionStorage } from '../conversation-storage.js';
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
  const [enabled, setEnabledState] = useState(() => {
    try { return localStorage.getItem('agent-remote-ask-enabled') === 'true'; } catch { return false; }
  });
  const [hiddenByPreference, setHiddenByPreference] = useState(() => {
    try { return localStorage.getItem('agent-remote-ask-enabled') === 'false'; } catch { return false; }
  });
  const enabledRef = useRef(enabled);
  const preparations = useRef(new Map<string, AbortController>());
  const preparationSettlements = useRef(new Map<string, Promise<void>>());
  const resumeRequested = useRef(new Set<string>());
  const openKeyRef = useRef<string>();
  useEffect(() => () => {
    resumeRequested.current.clear();
    for (const preparation of preparations.current.values()) preparation.abort();
  }, []);
  function setEnabled(next: boolean) {
    enabledRef.current = next;
    setEnabledState(next);
    setHiddenByPreference(!next);
    try { localStorage.setItem('agent-remote-ask-enabled', String(next)); } catch { /* Keep the preference for this page. */ }
    if (!next) {
      setOpenKey(undefined);
      resumeRequested.current.clear();
      for (const preparation of preparations.current.values()) preparation.abort();
    }
  }
  function toggle(hasRelated = false) {
    const next = !(enabledRef.current || !hiddenByPreference && hasRelated === true);
    setEnabled(next);
  }
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
  const [, refresh] = useState(0);
  const windowKey = `agent-remote-ask:${baseUrl}:open`;
  const savedWindow = useMemo(() => {
    let key: string | undefined;
    try { key = storage?.getItem(windowKey) ?? undefined; } catch { /* Keep Ask usable without window-state persistence. */ }
    return { scope: baseUrl, key };
  }, [baseUrl, storage]);
  const [windowSelection, setWindowSelection] = useState(savedWindow);
  const openKey = windowSelection.scope === baseUrl ? windowSelection.key : savedWindow.key;
  openKeyRef.current = openKey;
  const restoration = useMemo<{ key?: string; controller?: AbortController }>(() => ({ key: savedWindow.key }), [savedWindow]);
  useEffect(() => () => restoration.controller?.abort(), [restoration]);
  function setOpenKey(key: string | undefined) {
    restoration.controller?.abort();
    restoration.key = undefined;
    openKeyRef.current = key;
    setWindowSelection({ scope: baseUrl, key });
    try { if (key) storage?.setItem(windowKey, key); else storage?.removeItem(windowKey); }
    catch { /* The current window remains usable when browser storage is unavailable. */ }
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
      entry = { source, restoring: restoration.key === key, restoreOnly: restoration.key === key, inputs: savedInputs(key), record: saved.find(record => record.target && !record.creationKey), pending: saved.find(record => !!record.creationKey) };
      entries.set(key, entry);
    }
    if (!entry.busy && (!entry.attached || openKeyRef.current !== key) && !entry.pending) {
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
    if (!enabledRef.current || restoration.key !== key || restoration.controller && !restoration.controller.signal.aborted || openKeyRef.current !== key || !directory) return;
    const preparation = new AbortController();
    restoration.controller = preparation;
    entryFor(source);
    update(key, { restoring: true, restoreOnly: true, error: undefined });
    void synchronize().then(async () => {
      if (preparation.signal.aborted || openKeyRef.current !== key || !enabledRef.current) return;
      await open(undefined, source, '', false, preparation);
    }).catch(error => {
      if (!preparation.signal.aborted) update(key, { error: error instanceof Error ? error.message : 'Ask could not restore. Retry to reconnect.' });
    }).finally(() => {
      if (restoration.controller !== preparation) return;
      restoration.controller = undefined;
      if (!preparation.signal.aborted) restoration.key = undefined;
      update(key, { restoring: false });
    });
    return () => preparation.abort();
  }
  async function open(sourceState: AgentReplicaState | undefined, source: OpenedSession, args = '', clean = false, restoring?: AbortController) {
    if (!restoring) setEnabled(true);
    const key = sessionKey(source);
    const entry = entryFor(source);
    if (!restoring) setOpenKey(key);
    if (entry.busy) {
      if (preparations.current.get(key)?.signal.aborted && !args.trim() && !clean) {
        if (restoring) {
          await preparationSettlements.current.get(key);
          if (restoring.signal.aborted || !enabledRef.current || openKeyRef.current !== key) return {};
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
      if (resumeRequested.current.delete(key) && enabledRef.current && openKeyRef.current === key) {
        void open(sourceState, source).catch(() => {});
      }
    }
  }
  return { enabled, hiddenByPreference, toggle, store, entries, entryFor, openKey, drafts, setDraft, sendInput, restore, open, close: () => setOpenKey(undefined) };
}
