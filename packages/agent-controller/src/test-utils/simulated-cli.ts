import {
  AgentRuntimeError, AgentSessionInUseError, type AgentPersistenceHandle, type AgentProviderAdapter, type AgentProviderBehaviour, type AgentRuntimeInfo,
  type ProviderObservation, type ProviderStreamItem,
} from '@orchardworks/agent-provider-sdk';
import type { RemoteSessionSummary } from '@orchardworks/agent-session-runtime';

import { createManagedStdioDirectory, type ManagedStdioProvider } from '../stdio-directory.js';
import type { AgentHostDirectory, AgentHostProviderRegistration } from '../host.js';
import { ScriptedSession } from './journal-scripted-session.js';

/**
 * A native CLI at the provider port, played from the behaviour its adapter declares (`AgentProviderBehaviour`), with the faults real CLIs
 * show as knobs (section 3.1 of `docs/superpowers/specs/2026-11-21-requirements-vs-external-dependencies.md`). A test names a declared
 * behaviour, overrides the fields it varies, and turns knobs with exact timing; the Controller is tested against it with mock data.
 *
 * Clauses (`simulated-cli.test.ts`):
 * - S1 Clients. Each resume makes this process one client of the session until that session is disposed. A session is loaded while it
 *   has a client, and for the declared `unloadAfterLastClientMs` after its last client leaves.
 * - S2 Turns. A send runs a turn: the user message and `turn_started` at once, the reply and `turn_completed` after `turnMs`; the turn's
 *   items reach history when it ends.
 * - S3 Another client (`shared_clients`). `externalWriter` runs a turn of another client of the CLI: attached clients see it live when
 *   `othersVisible` is `live`, and it reaches history. It loads the session while it runs.
 * - S4 A writer elsewhere (`single_writer`, or `separate: true` beside shared clients: a process outside the CLI's clients). It is refused
 *   while the session is loaded; otherwise it holds the writer for its turn, and a resume meanwhile is refused with `AgentSessionInUseError`
 *   reason `writer_elsewhere`, with `retryAfterMs` when the test gives one.
 * - S5 Fork on divergence. A write elsewhere continues the newest branch of the transcript as it was when the write began; a reread shows the
 *   branch with the newest write; a resident client keeps continuing its own branch and never sees the other one.
 * - S6 Faults at resume: `slowResume(ms)`, `hangResume()` (answers once healed; `{ once: true }` hangs only the next resume),
 *   `usageLimit({ resetsAt })` (typed `native_usage_limited` with `resetsAt` until that time).
 * - S7 Faults mid-turn, on the next turn: `crash()` fails it with `native_exited` and ends the session's stream; `hang()` stops it after its
 *   user message.
 * - S8 `unknownEvent(kind)`: until healed, every history read and every turn carries an item of a kind the adapter does not know.
 * - S9 Time runs only on the injected clock, so fake timers drive every delay.
 */

export interface SimulatorClock { now(): number; setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(timer: unknown): void }
/** The global timers, so `vi.useFakeTimers()` drives a simulator built without a clock. */
const globalClock: SimulatorClock = { now: () => Date.now(), setTimeout: (callback, delayMs) => setTimeout(callback, delayMs), clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) };

interface Item { key: string; type: 'user_message' | 'assistant_message'; text: string; turnId: string }
interface Branch { items: Item[]; writtenAt: number }

export interface SimulatedCliOptions {
  behaviour: AgentProviderBehaviour;
  providerId?: string;
  displayName?: string;
  /** Native sessions and the texts of their history, alternating a person's message and a reply. */
  sessions?: Record<string, string[]>;
  /** How long a turn runs, from its user message to its reply. */
  turnMs?: number;
  clock?: SimulatorClock;
}

export type SimulatedCli = ReturnType<typeof simulatedCli>;

export function simulatedCli(options: SimulatedCliOptions) {
  const { behaviour } = options;
  const providerId = options.providerId ?? 'simulated';
  const clock = options.clock ?? globalClock;
  const turnMs = options.turnMs ?? 1000;
  interface Native { id: string; branches: Branch[]; clients: Set<SimulatedSession>; unload?: unknown; loadedByOthers: number; writer?: { retryAfterMs?: number }; resumes: number }
  const natives = new Map<string, Native>();
  let turns = 0;
  let observations = 0;
  const resumeFaults: { slowMs?: number; hang?: 'always' | 'once'; hung: Array<() => void>; resetsAt?: number } = { hung: [] };
  const turnFaults: { next?: 'crash' | 'hang'; unknownKind?: string } = {};

  const nativeOf = (id: string): Native => {
    let native = natives.get(id);
    if (!native) { native = { id, branches: [{ items: [], writtenAt: 0 }], clients: new Set(), loadedByOthers: 0, resumes: 0 }; natives.set(id, native); }
    return native;
  };
  for (const [id, texts] of Object.entries(options.sessions ?? {})) {
    const turn = (at: number) => `history-${at >> 1}`;
    nativeOf(id).branches = [{ items: texts.map((text, at) => ({ key: `${id}:${at}`, type: at % 2 === 0 ? 'user_message' : 'assistant_message', text, turnId: turn(at) })), writtenAt: 0 }];
  }
  /** The branch a reread shows: the one written last (S5); with one writer there is one branch. */
  const history = (native: Native): Item[] => native.branches.reduce((newest, branch) => branch.writtenAt > newest.writtenAt ? branch : newest).items;
  const updatedAt = (native: Native): number => Math.max(...native.branches.map(branch => branch.writtenAt));
  const loaded = (native: Native): boolean => native.clients.size > 0 || native.loadedByOthers > 0 || native.unload !== undefined;
  const othersSeeLive = behaviour.concurrency.othersVisible === 'live';

  const observation = (delivery: 'history' | 'live', event: ProviderObservation['event'], item?: Item, completes = true): ProviderObservation => ({
    type: 'observation', sourceKey: `${providerId}:${++observations}`, occurredAt: clock.now(), delivery, event,
    ...(item ? { itemIdentity: { key: item.key, ...(completes ? { completes: true as const } : {}) } } : {}),
  });
  const timeline = (delivery: 'history' | 'live', item: Item): ProviderObservation => observation(delivery,
    { type: 'timeline', provider: providerId, turnId: item.turnId, item: { type: item.type, text: item.text, messageId: item.key } }, item);
  /** A well-formed observation of an item kind the adapter does not know, as a CLI update could add one (S8). */
  const unknown = (delivery: 'history' | 'live', kind: string, turnId: string): ProviderObservation => ({
    ...observation(delivery, { type: 'timeline', provider: providerId, turnId, item: { type: kind, text: 'from a newer CLI' } as never }), itemIdentity: { key: `${turnId}:${kind}`, completes: true } });

  /** Leaves a session that lost its last client loaded for the declared unload time (S1). */
  function left(native: Native): void {
    if (native.clients.size || native.loadedByOthers) return;
    const unloadMs = behaviour.concurrency.unloadAfterLastClientMs;
    if (!unloadMs) return;
    if (native.unload !== undefined) clock.clearTimeout(native.unload);
    native.unload = clock.setTimeout(() => { native.unload = undefined; }, unloadMs);
  }
  function joined(native: Native): void {
    if (native.unload !== undefined) { clock.clearTimeout(native.unload); native.unload = undefined; }
  }

  class SimulatedSession extends ScriptedSession {
    /** The branch of the transcript this client continues from (S5), and the branch its own writes made, once it wrote. */
    branch: Item[];
    ownBranch: Branch | undefined;
    running: string | undefined;
    writtenAt = 0;
    closed = false;
    constructor(readonly native: Native) {
      const items = history(native);
      const newer = turnFaults.unknownKind ? [unknown('history', turnFaults.unknownKind, 'history-newer')] : [];
      super(providerId, native.id, [...items.map(item => timeline('history', item)), ...newer, { type: 'history_boundary' }]);
      this.branch = [...items];
    }
    override async runtimeInfo(): Promise<AgentRuntimeInfo> {
      return { providerId, sessionId: this.native.id, status: this.closed ? 'closed' : this.running ? 'running' : 'idle', persistence: { providerId, sessionId: this.native.id, opaque: '{}' } };
    }
    override async sendMessage(text: string): Promise<void> {
      if (this.closed) throw new Error('The simulated session is closed.');
      this.sent.push(text);
      const turnId = `turn-${++turns}`;
      const ask: Item = { key: `${turnId}:user`, type: 'user_message', text, turnId };
      this.running = turnId;
      this.push(observation('live', { type: 'turn_started', provider: providerId, turnId }));
      this.push(timeline('live', ask));
      const fault = turnFaults.next;
      turnFaults.next = undefined;
      if (fault === 'hang') return;
      if (fault === 'crash') {
        clock.setTimeout(() => { this.push(observation('live', { type: 'turn_failed', provider: providerId, turnId, error: 'The CLI exited.', code: 'native_exited' })); void this.end(); }, turnMs);
        return;
      }
      const unknownKind = turnFaults.unknownKind;
      clock.setTimeout(() => {
        if (this.closed) return;
        const reply: Item = { key: `${turnId}:reply`, type: 'assistant_message', text: `Reply to ${text}`, turnId };
        if (unknownKind) this.push(unknown('live', unknownKind, turnId));
        this.push(timeline('live', reply));
        this.push(observation('live', { type: 'turn_completed', provider: providerId, turnId }));
        this.running = undefined;
        this.writtenAt = clock.now();
        write(this.native, this, [ask, reply]);
      }, turnMs);
    }
    /** The CLI's process ended under this client. */
    async end(): Promise<void> { this.closed = true; this.running = undefined; this.native.clients.delete(this); left(this.native); await super.dispose(); }
    override async dispose(): Promise<void> {
      if (!this.closed) { this.closed = true; this.native.clients.delete(this); left(this.native); }
      await super.dispose();
    }
  }

  /** A turn's items reach the transcript (S2, S3, S5): one writer extends the one branch; a client of a forked transcript extends its own. */
  function write(native: Native, client: SimulatedSession | undefined, items: Item[]): void {
    if (behaviour.concurrency.model === 'fork_on_divergence' && client) {
      client.branch = [...client.branch, ...items];
      if (client.ownBranch) { client.ownBranch.items = client.branch; client.ownBranch.writtenAt = clock.now(); }
      else { client.ownBranch = { items: client.branch, writtenAt: clock.now() }; native.branches.push(client.ownBranch); }
      return;
    }
    const branch = native.branches.reduce((newest, candidate) => candidate.writtenAt > newest.writtenAt ? candidate : newest);
    native.branches = [{ items: [...branch.items, ...items], writtenAt: clock.now() }];
    for (const other of native.clients) if (other !== client) other.branch = history(native);
  }

  async function resume(id: string): Promise<SimulatedSession> {
    const native = nativeOf(id);
    native.resumes += 1;
    if (resumeFaults.hang) {
      if (resumeFaults.hang === 'once') resumeFaults.hang = undefined;
      await new Promise<void>(resolve => { resumeFaults.hung.push(resolve); });
    }
    if (resumeFaults.slowMs) await new Promise<void>(resolve => { clock.setTimeout(resolve, resumeFaults.slowMs!); });
    if (resumeFaults.resetsAt !== undefined && clock.now() < resumeFaults.resetsAt) {
      throw new AgentRuntimeError('native_usage_limited', 'The CLI reached its usage limit.', { resetsAt: resumeFaults.resetsAt });
    }
    if (native.writer) throw new AgentSessionInUseError('Another process writes this session.', { reason: 'writer_elsewhere', ...(native.writer.retryAfterMs === undefined ? {} : { retryAfterMs: native.writer.retryAfterMs }) });
    const session = new SimulatedSession(native);
    native.clients.add(session);
    joined(native);
    return session;
  }

  const summary = (native: Native): RemoteSessionSummary => ({ nativeSessionId: native.id, providerId, title: native.id, createdAt: new Date(0).toISOString(),
    updatedAt: new Date(updatedAt(native)).toISOString(), state: [...native.clients].some(client => client.running) ? 'running' : 'idle' });

  const adapter: AgentProviderAdapter = {
    descriptor: { providerId, displayName: options.displayName ?? 'Simulated CLI', behaviour },
    journal: { itemIdentity: 1 as const },
    async createSession(config) { nativeOf(config.sessionId); return resume(config.sessionId); },
    async resumeSession(handle: AgentPersistenceHandle) { return resume(handle.sessionId); },
  };

  return {
    adapter,
    clock,
    /** A registration whose directory opens a session by resuming it, as the generic Controller path does. */
    registration(): AgentHostProviderRegistration {
      const opened = new Set<SimulatedSession>();
      const directory: AgentHostDirectory = {
        providerId, workspaces: async () => [], create: async () => { const id = `session-${natives.size + 1}`; nativeOf(id); return id; },
        canReleaseSession: () => true,
        list: async () => [...natives.values()].map(summary),
        async open(nativeSessionId) { const session = await resume(nativeSessionId); opened.add(session); return session; },
        async close() { await Promise.all([...opened].map(session => session.dispose())); },
      };
      return { adapter, directory };
    },
    /** A registration through the managed stdio directory, which applies the transcript divergence rule as it does for Claude Code. */
    stdioRegistration(): AgentHostProviderRegistration {
      const provider: ManagedStdioProvider = {
        createSession: adapter.createSession, resumeSession: adapter.resumeSession,
        async listSessions() { return [...natives.values()].map(summary); },
        sessionState(id) {
          const client = [...nativeOf(id).clients].at(-1);
          return client ? { quiet: !client.running, writtenAt: client.writtenAt } : undefined;
        },
        async sessionNativeUpdatedAt(id) { return updatedAt(nativeOf(id)); },
      };
      return { adapter, directory: createManagedStdioDirectory(providerId, options.displayName ?? 'Simulated CLI', provider, []) };
    },
    /** What the CLI holds of a session now. */
    native(id: string) {
      const native = nativeOf(id);
      return { loaded: loaded(native), clients: native.clients.size, resumes: native.resumes, writerElsewhere: !!native.writer, updatedAt: updatedAt(native),
        history: history(native).map(item => item.text) };
    },
    /**
     * Something other than this process writes a turn (S3, S4, S5), with the effect its concurrency model gives: another client of shared
     * clients, a separate process against a single writer (`separate` beside shared clients), or a second branch of a forked transcript.
     * Resolves `refused` when a single writer refuses it, and `written` once its turn ended.
     */
    async externalWriter(id: string, write_: { text: string; turnMs?: number; separate?: boolean; retryAfterMs?: number }): Promise<'refused' | 'written'> {
      const native = nativeOf(id);
      const duration = write_.turnMs ?? turnMs;
      const model = behaviour.concurrency.model;
      if (model === 'none') throw new Error('A CLI whose sessions have no other client takes no writer elsewhere.');
      const turnId = `external-${++turns}`;
      const items: Item[] = [{ key: `${turnId}:user`, type: 'user_message', text: write_.text, turnId }, { key: `${turnId}:reply`, type: 'assistant_message', text: `Reply to ${write_.text}`, turnId }];
      const elapse = () => new Promise<void>(resolve => { clock.setTimeout(resolve, duration); });
      if (model === 'single_writer' || write_.separate) {
        if (loaded(native) || native.writer) return 'refused';
        native.writer = { ...(write_.retryAfterMs === undefined ? {} : { retryAfterMs: write_.retryAfterMs }) };
        await elapse();
        native.writer = undefined;
        write(native, undefined, items);
        return 'written';
      }
      if (model === 'fork_on_divergence') {
        const base = history(native);
        await elapse();
        native.branches.push({ items: [...base, ...items], writtenAt: clock.now() });
        return 'written';
      }
      native.loadedByOthers += 1;
      joined(native);
      const live = othersSeeLive ? [...native.clients] : [];
      for (const client of live) { client.push(observation('live', { type: 'turn_started', provider: providerId, turnId })); client.push(timeline('live', items[0]!)); }
      await elapse();
      for (const client of live) if (!client.closed) { client.push(timeline('live', items[1]!)); client.push(observation('live', { type: 'turn_completed', provider: providerId, turnId })); }
      write(native, undefined, items);
      native.loadedByOthers -= 1;
      left(native);
      return 'written';
    },
    /** Knobs for the faults of S6 to S8; `heal` clears them and lets a hung resume answer. */
    faults: {
      slowResume(ms: number) { resumeFaults.slowMs = ms; },
      hangResume(options: { once?: true } = {}) { resumeFaults.hang = options.once ? 'once' : 'always'; },
      usageLimit(limit: { resetsAt: number }) { resumeFaults.resetsAt = limit.resetsAt; },
      crash() { turnFaults.next = 'crash'; },
      hang() { turnFaults.next = 'hang'; },
      unknownEvent(kind: string) { turnFaults.unknownKind = kind; },
      heal() {
        delete resumeFaults.slowMs; delete resumeFaults.hang; delete resumeFaults.resetsAt;
        turnFaults.next = undefined; turnFaults.unknownKind = undefined;
        for (const release of resumeFaults.hung.splice(0)) release();
      },
    },
  };
}

/** The observations a simulated session emitted, for a test that reads them without a Controller. */
export async function observed(session: { observe(): AsyncIterable<ProviderStreamItem> }, count: number): Promise<ProviderStreamItem[]> {
  const seen: ProviderStreamItem[] = [];
  for await (const item of session.observe()) { seen.push(item); if (seen.length >= count) break; }
  return seen;
}
