import { afterEach, describe, expect, it } from 'vitest';

import type { AgentProviderBehaviour } from './behaviour.js';
import { readUnknownNativeEvent } from './native-events.js';
import {
  identityFindings, inputIdentityFindings, liveOnlyFindings, rereadOrderFindings, unknownEventFindings, usageLimitFindings, writerElsewhereFindings,
  type ProviderNativeLimit, type ProviderNativeTurn,
} from './conformance-checks.js';
import { journalObservation, type JournalRecording } from './journal-recording.js';
import type { AgentRuntimeInfo, AgentStreamEvent, ProviderObservation, ProviderStreamItem } from './observation.js';
import type { AgentSession } from './provider.js';

export * from './conformance-checks.js';

/**
 * The provider conformance kit: one suite that every journal-capable adapter passes, present and future, on mock data and in seconds
 * (step B3 of the provider boundary, section 4.3 of `docs/superpowers/specs/2026-11-21-requirements-vs-external-dependencies.md`).
 * Onboarding a CLI is: implement the adapter, declare its behaviour, pass this kit, add its native checks. The kit holds the adapter to
 * its declaration (`AgentProviderDescriptor.behaviour`); the rules it applies are the pure checks of `conformance-checks.ts` (K1 to K6).
 *
 * - Part 1, recorded sessions: every recording of the real CLI is read again in the declared order (K1), with usable identities and no
 *   item the live run lacked (K2); a Relay journal built from the live run meets each reread unchanged from the second read on, and a
 *   settled session (`settled`, `restart`) reopens unchanged.
 * - Part 2, faults through the port: the Controller beside the CLI simulator playing the declaration meets a slow resume, a hung resume,
 *   a usage limit, a crash and a hang in the middle of a turn, an item kind it does not know and a writer elsewhere, and each surfaces as
 *   the declared typed failure, the declared deadline, or no row.
 * - Part 3, the declared behaviour: the adapter, driven by a fake of its CLI, does what it declares (K3 to K6), and follows the one rule
 *   for events of a kind it does not know (K7), which every adapter follows, journal-capable or not (`runUnknownEventRule`).
 *
 * A subject names what the adapter brings: its declaration, its recordings and its native fake. The ports are what only the
 * Controller has: the journal's window decision and the Controller beside the simulator (`agent-controller`'s test support).
 */

/** The adapter, driven through its own native port by a fake of its CLI. */
export interface ProviderNativeFake {
  /**
   * Opens a native session whose history holds one finished turn, runs one more turn live for a message sent with `inputId`, and opens
   * the session again to read its history. With `unknown`, the CLI also sends an event of a kind the adapter does not know, once in the
   * history it holds and once in the live turn.
   */
  turn(options: { inputId: string; unknown: boolean }): Promise<ProviderNativeTurn>;
  /** A turn the CLI stops with its usage-limit signal; absent when the CLI signals none. */
  usageLimit?(): Promise<ProviderNativeLimit>;
  /** A resume while another process writes the session, which the CLI refuses: what the adapter raised. Absent when the CLI refuses none. */
  writerElsewhere?(): Promise<unknown>;
}

/** What an adapter brings to the kit. */
export interface ProviderConformanceSubject {
  /** Names the subject in test titles, such as `codex (shared daemon)`. */
  name: string;
  providerId: string;
  /** The declaration the kit holds the adapter to, as `resolveAgentProviderBehaviour` reads it. */
  behaviour: AgentProviderBehaviour;
  /** What the real CLI did, each recording made by the adapter's recorder (`./recordings`). */
  recordings: { names(): string[]; recording(name: string): JournalRecording };
  native: ProviderNativeFake;
}

/** What the Relay's journal did with a window: left it, appended to it, or replaced itself for a reason. */
export type ConformanceContinuityOutcome = { outcome: 'unchanged' | 'appended' } | { outcome: 'replaced'; reason: string };

/** The Controller's answer to a page's open of the session. */
export interface ConformanceOpenAnswer { status: number; code?: string; reason?: string; retryAfterMs?: number; resetsAt?: number }

/** The Controller beside the CLI simulator playing a declaration, on a fake clock; one per test. */
export interface ProviderFaultHarness {
  /** Opens the session as a page's open does, and answers as the Controller answers the page. */
  open(): Promise<ConformanceOpenAnswer>;
  /** Sends a message on the open session, as a page's send does. */
  send(text: string): Promise<void>;
  /** The events the open session emitted so far, and its runtime now. */
  events(): AgentStreamEvent[];
  runtime(): AgentRuntimeInfo | undefined;
  /** The texts of the rows the Controller holds for the session, which its journal and its pages follow. */
  shown(): Promise<string[]>;
  /** What the CLI holds: the texts of the history a reread shows, and how many clients of this process the session has. */
  history(): string[];
  nativeClients(): number;
  /** The diagnostic lines the simulated adapter reported. */
  diagnostics(): string[];
  /** Moves the fake clock. */
  advance(ms: number): Promise<void>;
  /** The simulator's knobs (S6 to S8 of `simulated-cli.ts`). */
  faults: {
    slowResume(ms: number): void; hangResume(options?: { once?: true }): void; usageLimit(limit: { resetsAt: number; at?: 'resume' | 'turn' }): void;
    crash(): void; hang(): void; unknownEvent(kind: string): void; heal(): void;
  };
  /** Another process writes a turn of the session, with the effect the declared concurrency model gives it. */
  writeElsewhere(options: { text: string; turnMs: number; retryAfterMs?: number }): Promise<'refused' | 'written'>;
  /** How long a turn of the simulator runs. */
  readonly turnMs: number;
  /** How long the Controller holds a failed native start before it starts the session again. */
  readonly failedStartHoldMs: number;
  /** How long a turn of an adapter that declares no heartbeat may stay silent before the Controller ends it. */
  readonly silenceMs: number;
  close(): Promise<void>;
}

export interface ProviderConformancePorts {
  /** A Relay journal built from the recording's live run meets the window of its reread `opens` times; each outcome, in order. */
  continuity(recording: JournalRecording, opens: number): Promise<ConformanceContinuityOutcome[]>;
  /** The Controller beside the CLI simulator playing `behaviour`, with a session whose history holds one finished turn. */
  faults(behaviour: AgentProviderBehaviour): Promise<ProviderFaultHarness>;
}

/** The host's timers: the SDK names no runtime, and a native fake waits on real time. */
const timers = globalThis as unknown as { setTimeout(callback: () => void, delayMs: number): unknown };

/**
 * Follows a session's stream in the background, for a native fake: the journal observations it emitted before its history boundary and
 * in all, and a wait, on real time and within `timeoutMs`, for what the fake expects next.
 */
export function followSession(session: AgentSession) {
  const items: ProviderStreamItem[] = [];
  const done = (async () => { for await (const item of session.observe()) items.push(item); })().catch(() => undefined);
  const observations = (to?: number) => items.slice(0, to).filter((item): item is ProviderObservation => item.type === 'observation');
  const boundary = () => items.findIndex(item => item.type === 'history_boundary');
  return {
    done,
    /** The journal observations of the history, before the boundary. */
    history: () => boundary() < 0 ? [] : observations(boundary()).filter(journalObservation),
    /** Every journal observation so far, history and live. */
    journal: () => observations().filter(journalObservation),
    events: () => observations().map(({ event }) => event),
    /** The events that came live, after the history. */
    liveEvents: () => observations().filter(({ delivery }) => delivery === 'live').map(({ event }) => event),
    async until(condition: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!condition()) {
        if (Date.now() > deadline) throw new Error(`The native fake waited in vain for ${what}.`);
        await new Promise<void>(resolve => { timers.setTimeout(resolve, 1); });
      }
    },
    boundary(): Promise<void> { return this.until(() => boundary() >= 0, 'the history boundary'); },
  };
}

/** Every journal-capable adapter records these two: a settled session, and the same session read by a new process. */
export const REQUIRED_RECORDINGS: readonly string[] = ['settled', 'restart'];
/** A client's input id, a UUID, as an operation id is. */
export const CONFORMANCE_INPUT_ID = '6f1b8a62-3c2e-4b8f-9a51-0c4d2e7f9b13';

const UNCHANGED = { outcome: 'unchanged' } as const;

export function runProviderConformance(subject: ProviderConformanceSubject, ports: ProviderConformancePorts): void {
  const { behaviour } = subject;
  describe(`provider conformance: ${subject.name}`, () => {
    describe('part 1: sessions the real CLI recorded', () => {
      const names = subject.recordings.names();
      const recording = (name: string) => subject.recordings.recording(name);

      it(`has the recordings every journal-capable adapter makes: ${REQUIRED_RECORDINGS.join(' and ')}`, () => {
        expect(REQUIRED_RECORDINGS.filter(name => !names.includes(name))).toEqual([]);
      });

      it.each(names)(`%s: is read again in the declared order (reread.order '${behaviour.reread.order}', K1)`, name => {
        expect(rereadOrderFindings(name, recording(name), behaviour.reread.order)).toEqual([]);
      });

      it.each(names)('%s: gives every row a usable identity, and a reread names no item the live run lacked (K2)', name => {
        expect(identityFindings(name, recording(name))).toEqual([]);
      });

      it.each(names)('%s: a journal of the live run meets five more rereads unchanged, and a settled session reopens unchanged', async name => {
        const outcomes = await ports.continuity(recording(name), 6);
        if (REQUIRED_RECORDINGS.includes(name)) expect(outcomes[0], `${name}, reopened`).toEqual(UNCHANGED);
        expect(outcomes.slice(1), `${name}, read again after the first reopen`).toEqual(Array.from({ length: 5 }, () => UNCHANGED));
      });
    });

    describe('part 3: the declared behaviour, through a fake of the CLI', () => {
      it(`marks live-only only items of the declared kinds (liveOnly [${behaviour.liveOnly.join(', ')}], K3)`, () => {
        const names = subject.recordings.names();
        expect(liveOnlyFindings(names.map(name => [name, subject.recordings.recording(name)] as const), behaviour.liveOnly)).toEqual([]);
      });

      it.runIf(behaviour.input.identity === 'echoes_client_id')("reports the client's input id with the user row, live and when read again (input.identity 'echoes_client_id', K4)", async () => {
        const turn = await subject.native.turn({ inputId: CONFORMANCE_INPUT_ID, unknown: false });
        expect(inputIdentityFindings(turn, CONFORMANCE_INPUT_ID, behaviour.input.identity)).toEqual([]);
      });

      it.runIf(behaviour.limits.signal !== 'none')(`fails the turn the CLI's limit signal stops as declared (limits.signal '${behaviour.limits.signal}', K5)`, async () => {
        expect(usageLimitFindings(await subject.native.usageLimit?.(), behaviour)).toEqual([]);
      });

      it.runIf(behaviour.failures.inUse.includes('writer_elsewhere'))("raises the CLI's refusal of a second writer typed (failures.inUse writer_elsewhere, K6)", async () => {
        if (!subject.native.writerElsewhere) throw new Error('The native fake does not play the CLI refusing a second writer.');
        expect(writerElsewhereFindings(await subject.native.writerElsewhere(), behaviour)).toEqual([]);
      });

      unknownEventRule(subject);
    });

    describe('part 2: faults through the port, played by the CLI simulator from the declaration', () => {
      runFaults(behaviour, ports);
    });
  });
}

/** The rule for events of a kind the adapter does not know (K7), for an adapter that is not journal-capable too. */
export function runUnknownEventRule(subject: Pick<ProviderConformanceSubject, 'name' | 'providerId' | 'native'>): void {
  describe(`provider conformance: ${subject.name}`, () => { unknownEventRule(subject); });
}

function unknownEventRule(subject: Pick<ProviderConformanceSubject, 'providerId' | 'native'>): void {
  it('reports an event of a kind it does not know as one diagnostic, never a row and never a silent drop (gap 10, K7)', async () => {
    const without = await subject.native.turn({ inputId: CONFORMANCE_INPUT_ID, unknown: false });
    const withUnknown = await subject.native.turn({ inputId: CONFORMANCE_INPUT_ID, unknown: true });
    expect(unknownEventFindings(subject.providerId, withUnknown, without)).toEqual([]);
  });
}

function runFaults(behaviour: AgentProviderBehaviour, ports: ProviderConformancePorts): void {
  const { resume, failures, concurrency } = behaviour;
  let open: ProviderFaultHarness | undefined;
  afterEach(async () => { await open?.close(); open = undefined; });
  const start = async () => (open = await ports.faults(behaviour));
  const typedLimit = failures.runtime.includes('native_usage_limited');

  it(`opens a session whose resume answers 1 ms inside the declared deadline (resume.deadlineMs ${resume.deadlineMs})`, async () => {
    const h = await start();
    h.faults.slowResume(resume.deadlineMs - 1);
    const opening = h.open();
    await h.advance(resume.deadlineMs - 1);
    expect(await opening).toMatchObject({ status: 200 });
  });

  it('gives a hung resume up at the declared deadline as native_unresponsive, and opens the session again once it is free', async () => {
    const h = await start();
    h.faults.hangResume({ once: true });
    let first: ConformanceOpenAnswer | undefined;
    void h.open().then(answer => { first = answer; });
    await h.advance(resume.deadlineMs - 1);
    expect(first).toBeUndefined();
    await h.advance(1);
    expect(first).toMatchObject({ status: 503, code: 'native_unresponsive' });
    await h.advance(h.failedStartHoldMs);
    const second = h.open();
    await h.advance(0);
    expect(await second).toMatchObject({ status: 200 });
    // The CLI answers the hung resume at last: nobody holds what it hands over, so it is closed, and the session keeps the one client.
    h.faults.heal();
    await h.advance(0);
    expect(h.nativeClients()).toBe(1);
  });

  it(`refuses an open while the account is limited ${typedLimit ? 'as native_usage_limited, with when the limit resets' : 'without a typed reason it cannot vouch for'}`, async () => {
    const h = await start();
    const resetsAt = Date.now() + 60_000;
    h.faults.usageLimit({ resetsAt });
    const answer = await h.open();
    if (typedLimit) expect(answer).toMatchObject({ status: 503, code: 'native_usage_limited', resetsAt });
    else expect(answer.code).not.toBe('native_usage_limited');
  });

  it.runIf(typedLimit)('fails a turn the account limit stops as native_usage_limited, and says when the limit resets until a turn runs again', async () => {
    const h = await start();
    expect(await h.open()).toMatchObject({ status: 200 });
    const resetsAt = Date.now() + 3_600_000;
    h.faults.usageLimit({ resetsAt, at: 'turn' });
    await h.send('Over the limit');
    await h.advance(0);
    expect(h.events().find(event => event.type === 'turn_failed')).toMatchObject({ code: 'native_usage_limited' });
    expect(h.runtime()?.usageLimit).toEqual({ resetsAt });
    await h.advance(3_600_000);
    await h.send('After the reset');
    await h.advance(h.turnMs);
    expect(h.runtime()?.usageLimit).toBeUndefined();
    expect(h.history().slice(-2)).toEqual(['After the reset', 'Reply to After the reset']);
  });

  it('fails a turn whose CLI exits as native_exited', async () => {
    const h = await start();
    expect(await h.open()).toMatchObject({ status: 200 });
    h.faults.crash();
    await h.send('Crashes');
    await h.advance(h.turnMs);
    expect(h.events().find(event => event.type === 'turn_failed')).toMatchObject({ code: 'native_exited' });
  });

  // Open: after its CLI exits, a session keeps its failed runtime ("Provider observation stream failed"), and nothing starts the CLI again;
  // the watchdog releases a silent turn's runtime, an exit is not released.
  it.fails('reaches the CLI again when the page opens the session after its CLI exited (open: an exited CLI is not started again)', async () => {
    const h = await start();
    expect(await h.open()).toMatchObject({ status: 200 });
    h.faults.crash();
    await h.send('Crashes');
    await h.advance(h.turnMs);
    expect(await h.open()).toMatchObject({ status: 200 });
    await h.send('Again');
    await h.advance(h.turnMs);
    expect(h.history().slice(-2)).toEqual(['Again', 'Reply to Again']);
  });

  const heartbeat = behaviour.turn?.heartbeatMs;
  it(heartbeat === undefined
    ? 'ends a turn whose CLI falls silent as native_unresponsive once the Controller has watched it long enough (no turn.heartbeatMs)'
    : `leaves a silent turn to the adapter, which declares a heartbeat (turn.heartbeatMs ${heartbeat})`, async () => {
    const h = await start();
    expect(await h.open()).toMatchObject({ status: 200 });
    h.faults.hang();
    await h.send('Stuck');
    await h.advance(h.silenceMs - 1);
    expect(h.events().map(event => event.type)).not.toContain('turn_failed');
    await h.advance(heartbeat === undefined ? 1 : h.silenceMs);
    if (heartbeat !== undefined) { expect(h.events().map(event => event.type)).not.toContain('turn_failed'); return; }
    expect(h.events().find(event => event.type === 'turn_failed')).toMatchObject({ code: 'native_unresponsive' });
    // The runtime of the silent turn is released, so the next send attaches the session again from native history.
    await h.advance(0);
    expect(h.nativeClients()).toBe(0);
    await h.send('Again');
    await h.advance(h.turnMs);
    expect(h.history().slice(-2)).toEqual(['Again', 'Reply to Again']);
  });

  it('keeps the rows it knows when the CLI sends an event of a kind the adapter does not know, shows none for it, and has it reported (gap 10)', async () => {
    const h = await start();
    h.faults.unknownEvent('hologram');
    expect(await h.open()).toMatchObject({ status: 200 });
    await h.send('Next');
    await h.advance(h.turnMs);
    expect(await h.shown()).toEqual(['Hello', 'Hi', 'Next', 'Reply to Next']);
    expect(h.diagnostics().map(line => readUnknownNativeEvent(line)?.delivery)).toEqual(['history', 'live']);
  });

  const refusesWriters = concurrency.model === 'single_writer' || concurrency.model === 'shared_clients' && concurrency.probe === 'lock_file';
  if (refusesWriters) {
    const typed = failures.inUse.includes('writer_elsewhere');
    it(`refuses the open while another process holds the session's writer${typed ? ', with the reason writer_elsewhere and the wait the CLI gives,' : ''} and opens once it has finished (concurrency.model '${concurrency.model}')`, async () => {
      const h = await start();
      const writing = h.writeElsewhere({ text: 'From another process', turnMs: 30_000, retryAfterMs: 5000 });
      const refused = await h.open();
      expect(refused).toMatchObject({ status: 409, code: 'session_in_use' });
      if (typed) expect(refused).toMatchObject({ reason: 'writer_elsewhere', retryAfterMs: 5000 });
      await h.advance(30_000);
      expect(await writing).toBe('written');
      expect(await h.open()).toMatchObject({ status: 200 });
      expect(await h.shown()).toEqual(['Hello', 'Hi', 'From another process', 'Reply to From another process']);
    });
  }
  if (concurrency.model === 'fork_on_divergence') {
    it("opens the session while another process writes it, which the CLI does not refuse (concurrency.model 'fork_on_divergence')", async () => {
      const h = await start();
      const terminal = h.writeElsewhere({ text: 'TERM', turnMs: h.turnMs });
      expect(await h.open()).toMatchObject({ status: 200 });
      await h.advance(h.turnMs);
      expect(await terminal).toBe('written');
      expect(h.history()).toEqual(['Hello', 'Hi', 'TERM', 'Reply to TERM']);
    });
  }
}
