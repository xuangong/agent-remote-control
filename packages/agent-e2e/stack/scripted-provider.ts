/**
 * A scripted provider for the e2e stack: sessions whose history and replies a flow decides.
 *
 * Contract. `scriptedProvider()` returns the Controller registration and a handle per session. A session starts with its `history`
 * (completed rows, then the history boundary). A message sent to it is echoed as a user row and answered by `answer(text)` as an
 * assistant row, after the optional `replyDelayMs`; a flow can also `write` live rows as a terminal would write them. Item keys are
 * stable per session, so a reload shows the same rows. The provider reads nothing outside this process.
 */
import type { AgentProviderAdapter, ProviderObservation, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import type { AgentHostDirectory, AgentHostProviderRegistration } from '@orchardworks/agent-remote-controller';
import { ScriptedSession } from '@orchardworks/agent-remote-fixtures';

export const SCRIPTED_PROVIDER = 'scripted';

export interface ScriptedRow { role: 'user' | 'assistant'; text: string }

/** A timeline observation of one completed or live item of a scripted session. */
export function row(delivery: 'history' | 'live', key: string, row: ScriptedRow, sequence: number): ProviderObservation {
  return {
    type: 'observation', sourceKey: `${delivery}:${key}`, occurredAt: 1_725_000_000_000 + sequence, delivery,
    event: { type: 'timeline', provider: SCRIPTED_PROVIDER, turnId: `turn-${Math.ceil(sequence / 2)}`,
      item: { type: row.role === 'user' ? 'user_message' : 'assistant_message', text: row.text, messageId: key } },
    itemIdentity: { key, completes: true },
  };
}

export interface ScriptedSessionHandle {
  readonly nativeSessionId: string;
  readonly title: string;
  readonly sent: string[];
  /** A row the way a terminal writing to the same session would add it. */
  write(role: ScriptedRow['role'], text: string): void;
}

export interface ScriptedProviderOptions {
  /** Sessions that exist when the Controller starts, with their history. */
  sessions?: Record<string, { title: string; history: ScriptedRow[] }>;
  answer?(text: string): string;
  replyDelayMs?: number;
}

export function scriptedProvider(options: ScriptedProviderOptions = {}) {
  const answer = options.answer ?? (text => `Echo: ${text}`);
  const known = new Map<string, { title: string; history: ScriptedRow[]; createdAt: string }>();
  for (const [id, session] of Object.entries(options.sessions ?? {})) known.set(id, { ...session, createdAt: '2026-11-18T00:00:00.000Z' });
  const live = new Map<string, ScriptedSessionHandle & ScriptedSession>();
  let created = 0;

  const open = (nativeSessionId: string): ScriptedSession => {
    const saved = known.get(nativeSessionId);
    if (!saved) throw new Error(`No scripted session ${nativeSessionId}.`);
    let sequence = 0;
    const items: ProviderStreamItem[] = [...saved.history.map(entry => row('history', `${nativeSessionId}:h${++sequence}`, entry, sequence)), { type: 'history_boundary' }];
    const base = new ScriptedSession(SCRIPTED_PROVIDER, nativeSessionId, items);
    const sent: string[] = [];
    const write = (role: ScriptedRow['role'], text: string) => { saved.history.push({ role, text }); base.push(row('live', `${nativeSessionId}:h${++sequence}`, { role, text }, sequence)); };
    const session = Object.assign(base, {
      title: saved.title, sent, write,
      // The runtime hands the text over; a scripted provider echoes it and answers.
      sendMessage: (async (text: string) => {
        sent.push(text); write('user', text);
        const reply = () => write('assistant', answer(text));
        if (options.replyDelayMs) setTimeout(reply, options.replyDelayMs); else reply();
      }) as unknown as ScriptedSession['sendMessage'],
    });
    live.set(nativeSessionId, session);
    return session;
  };

  const adapter: AgentProviderAdapter = {
    descriptor: { providerId: SCRIPTED_PROVIDER, displayName: 'Scripted' },
    journal: { itemIdentity: 1 as const },
    async createSession() { throw new Error('The Host supplies directory sessions.'); },
    async resumeSession() { throw new Error('The Host supplies directory sessions.'); },
  };
  const directory: AgentHostDirectory = {
    providerId: SCRIPTED_PROVIDER,
    list: async () => [...known].map(([nativeSessionId, saved]) => ({ nativeSessionId, providerId: SCRIPTED_PROVIDER, title: saved.title, createdAt: saved.createdAt, updatedAt: saved.createdAt, state: 'idle' as const })),
    workspaces: async () => [],
    create: async () => { const id = `scripted-new-${++created}`; known.set(id, { title: 'New session', history: [], createdAt: new Date().toISOString() }); return id; },
    canReleaseSession: () => true,
    async open(nativeSessionId) { return open(nativeSessionId); },
    async close() { await Promise.all([...live.values()].map(session => session.dispose())); },
  } as AgentHostDirectory;
  const registration: AgentHostProviderRegistration = { adapter, directory };
  return { registration, session: (nativeSessionId: string) => live.get(nativeSessionId), known: () => [...known.keys()] };
}
