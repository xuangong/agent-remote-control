/**
 * A scripted provider for the e2e stack: sessions whose history and replies a flow decides.
 *
 * Contract. `scriptedProvider()` returns the Controller registration and a handle per session. A session starts with its native
 * `history`: plain rows, or the observations of a recording (`recordedHistory`). A message sent to it is echoed as a user row and
 * answered by `answer(text)` as an assistant row, immediately, after `replyDelayMs`, or streamed in pieces; a flow can hold the echo
 * (`hold`) to look at a message while it is pending. Native history is what a terminal and a reopened session read: `write` adds a row the
 * running session sees live, `terminalWrite` adds rows only to the native history, as a terminal does while the Controller's session
 * follows its own last message (the provider then reports the divergence, as the Claude one does, and the Controller reads it again).
 * `terminalTakes` makes a terminal the native owner of a session (the Controller lets the session go and refuses sends until a person takes it
 * back). `fork` adds a session whose history is a copy of another's, as a terminal fork does. Item keys are stable per session and position,
 * so a reload shows the same rows. The provider reads nothing outside this process.
 */
import type { AgentProviderAdapter, ProviderObservation, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import type { AgentHostDirectory, AgentHostProviderRegistration } from '@orchardworks/agent-remote-controller';
import { NativeSessionOwnerError, type NativeOwnerIdentity } from '@orchardworks/agent-remote-controller/testing';
import { ScriptedSession } from '@orchardworks/agent-remote-fixtures';

export const SCRIPTED_PROVIDER = 'scripted';

/** `key` names the row for good: it keeps its item key when the rows before it change. Without one the key is the row's position. */
export interface ScriptedRow { role: 'user' | 'assistant'; text: string; key?: string }
/** One entry of a native history: a plain row, or an observation a real CLI produced (see `recordedHistory`). */
export type HistoryEntry = ScriptedRow | { observation: ProviderObservation };

/** The history of a recording: the observations of the session read again, in the order the provider gave them. */
export function recordedHistory(recording: { reread: ProviderObservation[] }): HistoryEntry[] {
  return recording.reread.map(observation => ({ observation: { ...observation, delivery: 'history' as const } }));
}

/** A timeline observation of one completed item of a scripted session. `completes` false gives a piece of a streamed item. */
export function row(providerId: string, delivery: 'history' | 'live', key: string, entry: ScriptedRow, sequence: number, completes = true, piece = 0): ProviderObservation {
  return {
    type: 'observation', sourceKey: `${delivery}:${key}:${piece}`, occurredAt: 1_725_000_000_000 + sequence, delivery,
    event: { type: 'timeline', provider: providerId, turnId: `turn-${Math.ceil(sequence / 2)}`,
      item: { type: entry.role === 'user' ? 'user_message' : 'assistant_message', text: entry.text, messageId: key } },
    itemIdentity: completes ? { key, completes: true } : { key },
  };
}

export interface ScriptedSessionHandle {
  readonly nativeSessionId: string;
  readonly title: string;
  readonly sent: string[];
  /** A row the way the running session adds it: the page sees it live and the native history keeps it. */
  write(role: ScriptedRow['role'], text: string): void;
}

export interface ScriptedProviderOptions {
  /** Sessions that exist when the Controller starts, with their history. */
  sessions?: Record<string, { title: string; history: HistoryEntry[] }>;
  providerId?: string;
  displayName?: string;
  answer?(text: string): string;
  replyDelayMs?: number;
  /** Answer in two pieces, as a model streams: the page shows the first before the second arrives. */
  stream?: boolean;
}

export function scriptedProvider(options: ScriptedProviderOptions = {}) {
  const providerId = options.providerId ?? SCRIPTED_PROVIDER;
  const answer = options.answer ?? (text => `Echo: ${text}`);
  interface Native { title: string; history: HistoryEntry[]; createdAt: string; updatedAt: string; diverged: boolean }
  const known = new Map<string, Native>();
  const startedAt = Date.parse('2026-11-18T00:00:00.000Z');
  for (const [id, session] of Object.entries(options.sessions ?? {})) known.set(id, { ...session, history: [...session.history], createdAt: new Date(startedAt).toISOString(), updatedAt: new Date(startedAt).toISOString(), diverged: false });
  const live = new Map<string, ScriptedSessionHandle & ScriptedSession>();
  let created = 0;
  let held: Promise<void> | undefined;
  const owners = new Map<string, NativeOwnerIdentity>();
  let handoff: ((nativeSessionId: string, next: NativeOwnerIdentity) => Promise<void>) | undefined;

  const observation = (id: string, entry: HistoryEntry, at: number, delivery: 'history' | 'live'): ProviderObservation =>
    'observation' in entry ? { ...entry.observation, delivery } : row(providerId, delivery, `${id}:${entry.key ?? `h${at}`}`, entry, at);

  const open = (nativeSessionId: string): ScriptedSession => {
    const saved = known.get(nativeSessionId);
    if (!saved) throw new Error(`No scripted session ${nativeSessionId}.`);
    saved.diverged = false;
    const items: ProviderStreamItem[] = [...saved.history.map((entry, at) => observation(nativeSessionId, entry, at + 1, 'history')), { type: 'history_boundary' }];
    const base = new ScriptedSession(providerId, nativeSessionId, items);
    const sent: string[] = [];
    const write = (role: ScriptedRow['role'], text: string) => {
      saved.history.push({ role, text });
      saved.updatedAt = new Date().toISOString();
      base.push(row(providerId, 'live', `${nativeSessionId}:h${saved.history.length}`, { role, text }, saved.history.length));
    };
    /** The answer as a model streams it: two pieces under one item key, then the completed item. */
    const writeStreamed = (text: string) => {
      const at = saved.history.length + 1;
      const half = Math.ceil(text.length / 2);
      const key = `${nativeSessionId}:h${at}`;
      base.push(row(providerId, 'live', key, { role: 'assistant', text: text.slice(0, half) }, at, false, 1));
      setTimeout(() => {
        base.push(row(providerId, 'live', key, { role: 'assistant', text: text.slice(half) }, at, false, 2));
        saved.history.push({ role: 'assistant', text }); saved.updatedAt = new Date().toISOString();
        base.push(row(providerId, 'live', key, { role: 'assistant', text: '' }, at, true, 3));
      }, options.replyDelayMs ?? 300);
    };
    const session = Object.assign(base, {
      title: saved.title, sent, write,
      sendMessage: (async (text: string) => {
        await held;
        sent.push(text); write('user', text);
        if (options.stream) writeStreamed(answer(text));
        else if (options.replyDelayMs) setTimeout(() => write('assistant', answer(text)), options.replyDelayMs);
        else write('assistant', answer(text));
      }) as unknown as ScriptedSession['sendMessage'],
    });
    live.set(nativeSessionId, session);
    return session;
  };

  const adapter: AgentProviderAdapter = {
    descriptor: { providerId, displayName: options.displayName ?? 'Scripted' },
    journal: { itemIdentity: 1 as const },
    async createSession() { throw new Error('The Host supplies directory sessions.'); },
    async resumeSession() { throw new Error('The Host supplies directory sessions.'); },
  };
  const directory: AgentHostDirectory = {
    providerId,
    list: async () => [...known].map(([nativeSessionId, saved]) => ({ nativeSessionId, providerId, title: saved.title, createdAt: saved.createdAt, updatedAt: saved.updatedAt, state: 'idle' as const })),
    workspaces: async () => [],
    create: async () => { const id = `${providerId}-new-${++created}`; known.set(id, { title: 'New session', history: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), diverged: false }); return id; },
    canReleaseSession: () => true,
    // A session that something else wrote to continues from its own last message; the Controller releases it and reads it again.
    divergedAt: (nativeSessionId: string) => known.get(nativeSessionId)?.diverged ? 1 : undefined,
    checkDivergence: async (nativeSessionId: string) => known.get(nativeSessionId)?.diverged ?? false,
    setSessionHandoffHandler(handler: (nativeSessionId: string, next: NativeOwnerIdentity) => Promise<void>) { handoff = handler; },
    async open(nativeSessionId, openOptions) {
      const owner = owners.get(nativeSessionId);
      if (owner) {
        if (openOptions?.takeOver === undefined) throw new NativeSessionOwnerError('native_session_owned', 'A terminal holds this session.', owner);
        if (openOptions.takeOver !== owner.generation) throw new NativeSessionOwnerError('native_owner_changed', 'The owner changed.', owner);
        owners.delete(nativeSessionId);
      }
      return open(nativeSessionId);
    },
    async close() { await Promise.all([...live.values()].map(session => session.dispose())); },
  } as AgentHostDirectory;
  const registration: AgentHostProviderRegistration = { adapter, directory };
  return {
    registration, providerId,
    /** The running session of this provider, once something has opened it. */
    session: (nativeSessionId: string) => live.get(nativeSessionId),
    known: () => [...known.keys()],
    /** Rows a terminal appends to the native history while the Controller's session does not see them; the provider reports the divergence. */
    terminalWrite(nativeSessionId: string, ...rows: ScriptedRow[]) {
      const saved = known.get(nativeSessionId);
      if (!saved) throw new Error(`No scripted session ${nativeSessionId}.`);
      saved.history.push(...rows); saved.updatedAt = new Date().toISOString(); saved.diverged = true;
    },
    /** A terminal takes the session: the Controller records the owner and lets the session go. */
    async terminalTakes(nativeSessionId: string, generation = 'terminal-1') {
      const owner: NativeOwnerIdentity = { kind: 'native_cli', generation };
      owners.set(nativeSessionId, owner);
      await handoff!(nativeSessionId, owner);
    },
    /** A session whose history is a copy of another's, as `claude --fork-session` in a terminal makes one. */
    fork(sourceId: string, nativeSessionId: string, title: string) {
      const source = known.get(sourceId);
      if (!source) throw new Error(`No scripted session ${sourceId}.`);
      known.set(nativeSessionId, { title, history: [...source.history], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), diverged: false });
    },
    /** What the native history holds now; the next reopen reads this. */
    replaceHistory(nativeSessionId: string, history: HistoryEntry[]) {
      const saved = known.get(nativeSessionId);
      if (!saved) throw new Error(`No scripted session ${nativeSessionId}.`);
      saved.history = [...history]; saved.updatedAt = new Date().toISOString();
    },
    /** Holds every send before the provider echoes it; the returned function lets them through. */
    hold(): () => void {
      let release!: () => void;
      held = new Promise<void>(resolve => { release = resolve; });
      return () => { release(); held = undefined; };
    },
  };
}
