import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentReplicaState, RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { SessionDirectoryClient, type CreateSessionOptions, type OpenedSession } from '../directory-client.js';
import { ForkStore, referenceForkContext, type SessionFork } from '../session-forks.js';
import { configureFork } from '../fork-actions.js';
import { readDrafts, saveDrafts } from '../conversation-recovery.js';
import { sessionKey } from '../session-tree.js';

export type AskInputSender = (text: string, operationId: string) => Promise<unknown>;
export interface AskInput { id: string; text: string }
export interface AskEntry { attached?: boolean; inputs?: AskInput[]; source: OpenedSession; record?: SessionFork; pending?: SessionFork; busy?: boolean; error?: string }

export function useAskConversations(baseUrl: string, transport: RemoteAgentTransport, directory?: SessionDirectoryClient, selectedHostId = 'local', onCreated?: () => void) {
  const [enabled, setEnabledState] = useState(() => {
    try { return localStorage.getItem('agent-remote-ask-enabled') === 'true'; } catch { return false; }
  });
  const enabledRef = useRef(enabled);
  const preparations = useRef(new Map<string, AbortController>());
  const resumeRequested = useRef(new Set<string>());
  const openKeyRef = useRef<string>();
  useEffect(() => () => {
    resumeRequested.current.clear();
    for (const preparation of preparations.current.values()) preparation.abort();
  }, []);
  function setEnabled(next: boolean) {
    enabledRef.current = next;
    setEnabledState(next);
    try { localStorage.setItem('agent-remote-ask-enabled', String(next)); } catch { /* Keep the preference for this page. */ }
    if (!next) {
      setOpenKey(undefined);
      resumeRequested.current.clear();
      for (const preparation of preparations.current.values()) preparation.abort();
    }
  }
  function toggle() {
    const next = !enabledRef.current;
    setEnabled(next);
  }
  // A tab-local ledger keeps retries idempotent without populating the normal fork list.
  const storage = useMemo(() => {
    try { return window.sessionStorage; } catch { return undefined; }
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
  const [openKey, setOpenKeyState] = useState<string>();
  function setOpenKey(key: string | undefined) { openKeyRef.current = key; setOpenKeyState(key); }
  const [drafts, setDrafts] = useState(() => readDrafts(`${baseUrl}:ask`));
  const draftsRef = useRef(drafts); draftsRef.current = drafts;
  useEffect(() => saveDrafts(`${baseUrl}:ask`, drafts), [baseUrl, drafts]);
  useEffect(() => store.subscribe(() => refresh(value => value + 1)), [store]);
  function update(key: string, change: Partial<AskEntry>) {
    entries.set(key, { ...entries.get(key)!, ...change });
    refresh(value => value + 1);
  }
  function setDraft(key: string, text: string) {
    draftsRef.current = { ...draftsRef.current, [key]: text };
    setDrafts(draftsRef.current);
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
      entry = { source, inputs: savedInputs(key), record: saved.find(record => record.target && !record.creationKey), pending: saved.find(record => !!record.creationKey) };
      entries.set(key, entry);
    }
    return entry;
  }
  async function open(sourceState: AgentReplicaState, source: OpenedSession, args = '', clean = false) {
    setEnabled(true);
    const key = sessionKey(source);
    setOpenKey(key);
    const entry = entryFor(source);
    if (entry.busy) {
      if (preparations.current.get(key)?.signal.aborted && !args.trim() && !clean) {
        resumeRequested.current.add(key);
        return {};
      }
      throw new Error('Ask is already opening.');
    }
    if (clean && entry.inputs?.length) throw new Error('Wait for the saved Ask question to send before clearing.');
    const agent = sourceState.agent;
    if (!directory || !agent?.runtimeInfo.sessionId) throw new Error('Open the source session before starting Ask.');
    const replacing = clean || !!(entry.pending && entry.record && entry.pending.id !== entry.record.id);
    const draftAtStart = draftsRef.current[key];
    const target = (source.hostId ?? 'local') === selectedHostId ? directory : new SessionDirectoryClient(baseUrl, undefined, source.hostId);
    update(key, { busy: true, error: undefined });
    const queueQuestion = () => {
      if (!args.trim()) return;
      const inputs = [...(entries.get(key)?.inputs ?? []), { id: crypto.randomUUID(), text: args.trim() }];
      saveInputs(key, inputs);
      update(key, { inputs });
    };
    const preparation = new AbortController();
    preparations.current.set(key, preparation);
    try {
      let record = entry.pending ?? (!clean ? entry.record : undefined);
      if (!record) {
        const options: CreateSessionOptions = { sourceNativeSessionId: source.nativeSessionId,
          ...(agent.cwd ? { cwd: agent.cwd } : {}), ...(agent.model ? { model: agent.model } : {}),
          ...(agent.capabilities.planning ? { planning: agent.runtimeInfo.planning?.active === true } : {}) };
        const settings = (agent.runtimeInfo.settings ?? []).filter(setting => setting.mutable && setting.scope === 'session' && setting.value !== null).map(({ id, value }) => ({ id, value }));
        record = store.prepare(referenceForkContext(source), options, settings, key);
        update(key, { pending: record });
      }
      const result = record.target ? await target.attach(source.providerId, record.target.nativeSessionId)
        : await target.create(source.providerId, record.id, record.options);
      store.bind(record.id, { agentId: result.agentId, nativeSessionId: result.nativeSessionId ?? record.target?.nativeSessionId ?? result.agentId,
        providerId: source.providerId, hostId: source.hostId ?? 'local', title: 'Ask', createdAt: record.capturedAt });
      update(key, { pending: store.get(record.id) });
      preparation.signal.throwIfAborted();
      await configureFork(transport, store, store.get(record.id), preparation.signal);
      store.finishCreation(record.id);
      update(key, { record: store.get(record.id), pending: undefined, attached: true });
      if (replacing && draftsRef.current[key] === draftAtStart) setDraft(key, '');
      onCreated?.();
      queueQuestion();
      return {};
    } catch (error) {
      if (preparation.signal.aborted) { queueQuestion(); return {}; }
      update(key, { error: error instanceof Error ? error.message : 'Ask could not open. Retry to reconnect.' });
      throw error;
    } finally {
      preparations.current.delete(key);
      update(key, { busy: false });
      if (resumeRequested.current.delete(key) && enabledRef.current && openKeyRef.current === key) {
        void open(sourceState, source).catch(() => {});
      }
    }
  }
  return { enabled, toggle, store, entries, entryFor, openKey, drafts, setDraft, sendInput, open, close: () => setOpenKey(undefined) };
}
