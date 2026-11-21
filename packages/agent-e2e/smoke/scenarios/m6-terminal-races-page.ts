import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startLatencyProxy } from '../../faults/latency-proxy.mjs';
import { everyWriterSends, mergePageReports, messagesSettleOnce, noDuplicateItemKey, noLostOrDoubledMessage, noSessionConnectionLabel, pageDelivery, pageStaysLiveWhenCodexRefuses,
  stateAndPropertiesMatch, terminalRowsAppear, carrying, type InvariantResult, type RefusalRecord, type RoundRecord, type ViewRecord } from '../invariants/index.js';
import { positiveInteger } from '../lib/arguments.js';
import { PageProbe, withContext } from '../lib/probe.js';
import type { Provider } from '../lib/sessions.js';
import { terminalOutcome, TerminalDriver, type TerminalTurn } from '../lib/terminal.js';
import { mergeInvariantResults, type ScheduleStep } from '../report.js';
import type { RunContext, Scenario } from '../scenario.js';
import { TranscriptRecorder } from '../transcript.js';

/**
 * How long a terminal's turn may take to reach a page by itself. Codex: the page's session is another client of the shared daemon
 * and gets the turn's own events. Claude Code: the Controller reads the transcript again once it has been quiet for 30 s and a
 * listing asked (S6a measured 73 s).
 */
const TERMINAL_SHOWN_MS: Record<'claude' | 'codex', number> = { codex: 30_000, claude: 100_000 };
const SETTLE_MS = 120_000;
const QUIET_MS = 8000;
const ask = (word: string) => `Reply with the single word ${word} and nothing else.`;

/**
 * M6: writers race on one session. Inside our system there is no conflict: two pages on two browser contexts send to the same
 * session at once, and both are taken, nothing is lost or doubled, and both pages show the state and properties of the native
 * session. A terminal is outside our system and its CLI's rules decide: a Codex terminal joins the session through the shared
 * daemon and Codex orders its turns and the page's; a Claude Code terminal resumes the transcript, as S6a's did; a separate Codex
 * process is refused by Codex while the daemon has the thread, and while it writes the page must still show the session and Codex's
 * reason. The page only reports what happened, live, and never says a connection word. `--rounds` (50) sets the terminal rounds per
 * provider, `--page-rounds` (10) the rounds of two pages; both are 2 with `--quick`.
 */
export const terminalRacesPage: Scenario = {
  id: 'M6',
  title: 'Writers race on one session: two pages, and a terminal beside the page',
  quick: false,
  deadlineMinutes: { quick: 20, full: 180 },
  async run(context) {
    const rounds = positiveInteger('--rounds', context.quick ? 2 : 50);
    const pageRounds = positiveInteger('--page-rounds', context.quick ? 2 : 10);
    const reading = await smartReading(context);
    if (!reading.includes('claude') || !reading.includes('codex')) throw new Error(`M6 reads its sessions from the journal: turn smart reading on for Claude Code and Codex (now ${JSON.stringify(reading)}).`);
    const recorder = new TranscriptRecorder();
    const schedule: ScheduleStep[] = [];
    const records: RoundRecord[] = [];
    const conditions: Array<{ label: string; results: InvariantResult[] }> = [];
    const measurements: Record<string, unknown> = { rounds, pageRounds, smartReading: reading, providers: {} as Record<string, unknown> };
    const terminal = new TerminalDriver({ checkout: context.checkout, workspace: context.instance.workspace });
    const startedAt = new Date().toISOString();
    const proxy = await startLatencyProxy({ target: context.instance.origin, rttMs: 0, tap: recorder.tap, onSocket: recorder.socket });
    try {
      for (const provider of ['codex', 'claude'] as const) {
        const address = await context.pool.create(provider, ask('READY'));
        await context.pool.waitForReply(address, undefined);
        const url = (await context.pool.link(address)).replace(context.instance.origin, proxy.origin);
        const race = new Race(context, address, recorder, schedule);
        const pages = await withContext(context.browser, proxy.origin, first => race.open(first, url, 'page').then(async page => {
          const twoPages = await withContext(context.browser, proxy.origin, async second => {
            const other = await race.open(second, url, 'second page');
            const done: RoundRecord[] = [];
            for (let index = 1; index <= pageRounds; index += 1) done.push(await race.twoPages(provider, index, page, other));
            const report = await other.probe.report();
            await other.probe.close();
            return { done, report };
          });
          const withTerminal: RoundRecord[] = [];
          for (let index = 1; index <= rounds; index += 1) withTerminal.push(await race.withTerminal(provider, index, page, terminal));
          const report = await page.probe.report();
          await page.probe.close();
          return { twoPages: twoPages.done, withTerminal, reports: [report, twoPages.report] };
        }));
        records.push(...pages.twoPages, ...pages.withTerminal);
        const wire = recorder.transcript().filter(entry => entry.n > race.from);
        const page = mergePageReports(pages.reports);
        conditions.push({ label: `${provider}, two pages`, results: [noLostOrDoubledMessage(pages.twoPages), everyWriterSends(pages.twoPages), stateAndPropertiesMatch(pages.twoPages)] });
        conditions.push({ label: `${provider}, terminal`, results: [noLostOrDoubledMessage(pages.withTerminal), everyWriterSends(pages.withTerminal), terminalRowsAppear(pages.withTerminal), stateAndPropertiesMatch(pages.withTerminal)] });
        conditions.push({ label: `${provider}, every page`, results: [messagesSettleOnce(wire), noDuplicateItemKey(wire, page), noSessionConnectionLabel(page)] });
        (measurements.providers as Record<string, unknown>)[provider] = { address, ...race.summary(pages.withTerminal) };
        if (provider === 'codex') {
          // A separate Codex process beside the page: Codex refuses it while the thread is loaded, and refuses the Controller while it writes.
          const separate = await separateWriter(context, address, proxy.origin, recorder, schedule);
          conditions.push({ label: 'codex, separate process', results: [pageStaysLiveWhenCodexRefuses(separate.records)] });
          (measurements.providers as Record<string, Record<string, unknown>>).codex!.separateProcess = separate.measurements;
          // A Codex session stays loaded in the user's shared daemon until it is released.
          await context.pool.release(address);
        }
      }
    } finally { await proxy.close(); }
    measurements.codexResumeMs = await resumeTimings(context.instance.directory, startedAt);
    measurements.records = records;
    return { measurements, invariants: mergeInvariantResults(conditions), schedule, transcript: recorder };
  },
};

interface OpenPage { name: string; probe: PageProbe }

/** One session's rounds: the pages that show it, the words each writer sent, and what each place showed afterwards. */
class Race {
  readonly from: number;
  private readonly terminalTurns: TerminalTurn[] = [];
  constructor(private readonly context: RunContext, private readonly address: string, private readonly recorder: TranscriptRecorder, private readonly schedule: ScheduleStep[]) {
    this.from = recorder.transcript().at(-1)?.n ?? 0;
  }

  async open(browserContext: any, url: string, name: string): Promise<OpenPage> {
    const probe = await PageProbe.create(browserContext, this.recorder.origin);
    const paint = await probe.open(url, name, { rowsDeadlineMs: 90_000 });
    if (paint.timedOut) throw new Error(`The ${name} showed no rows of ${this.address} within 90 s.`);
    await probe.page.waitForFunction(() => (window as any).__smoke.read().composer === 'enabled', undefined, { timeout: 60_000 });
    return { name, probe };
  }

  private word(provider: Provider, kind: string, index: number): string {
    return `M6${provider === 'codex' ? 'X' : 'C'}${kind}${index}N${this.context.random.int(100, 999)}`;
  }

  private async send(page: OpenPage, word: string): Promise<void> {
    this.recorder.mark('turn-sent', { page: page.name, word });
    await page.probe.send(ask(word));
  }

  /** Two pages send at once, the second a seeded moment after the first. */
  async twoPages(provider: Provider, index: number, page: OpenPage, other: OpenPage): Promise<RoundRecord> {
    const label = `${provider} two pages ${index}`;
    const from = this.recorder.transcript().at(-1)?.n ?? 0;
    const words = { [page.name]: this.word(provider, 'A', index), [other.name]: this.word(provider, 'B', index) };
    const [lead, follow] = this.context.random.pick([[page, other], [other, page]] as const);
    const gapMs = this.context.random.int(0, 400);
    this.schedule.push({ t: this.recorder.clock(), action: 'two-pages-send', detail: { provider, index, lead: lead.name, gapMs } });
    await Promise.all([this.send(lead, words[lead.name]!), delay(gapMs).then(() => this.send(follow, words[follow.name]!))]);
    const native = await this.settle(Object.values(words));
    await Promise.all([page, other].map(shown => this.waitForWords(shown, Object.values(words), 30_000)));
    const wire = this.recorder.transcript().filter(entry => entry.n > from);
    return { label, writers: [page, other].map(writer => ({ writer: writer.name, word: words[writer.name]!, ...pageDelivery(wire, words[writer.name]!) })),
      native, pages: [await this.view(page), await this.view(other)] };
  }

  /** The page sends while a terminal writes one turn; a seeded choice says which one starts first, and by how much. */
  async withTerminal(provider: 'claude' | 'codex', index: number, page: OpenPage, terminal: TerminalDriver): Promise<RoundRecord> {
    const label = `${provider} terminal ${index}`;
    const from = this.recorder.transcript().at(-1)?.n ?? 0;
    const pageWord = this.word(provider, 'P', index), terminalWord = this.word(provider, 'T', index);
    const lead = this.context.random.pick(['page', 'terminal'] as const);
    // A terminal needs a second or two to start its CLI: leading, it is given that start before the page sends.
    const gapMs = lead === 'page' ? this.context.random.int(0, 600) : this.context.random.int(1500, 3000);
    this.schedule.push({ t: this.recorder.clock(), action: 'terminal-race', detail: { provider, index, lead, gapMs } });
    const nativeId = this.address.split('/').slice(2).join('/');
    const samples: Array<{ at: number; status?: string }> = [];
    let running = true;
    const sampling = (async () => { while (running) { samples.push({ at: Date.now(), status: await page.probe.sessionStatus().catch(() => undefined) }); await delay(250); } })();
    const writeInTerminal = async () => {
      const turn = await terminal.turn(provider, nativeId, ask(terminalWord));
      this.recorder.mark('terminal-write', { provider, word: terminalWord, delivered: turn.delivered, tries: turn.tries.map(item => ({ outcome: item.outcome, ms: item.ms, ...(item.reason ? { reason: item.reason } : {}) })) });
      return turn;
    };
    const [turn] = lead === 'page'
      ? await Promise.all([delay(gapMs).then(writeInTerminal), this.send(page, pageWord)])
      : await Promise.all([writeInTerminal(), delay(gapMs).then(() => this.send(page, pageWord))]);
    running = false;
    await sampling;
    this.terminalTurns.push(turn);
    const last = turn.tries.at(-1)!;
    const native = await this.settle(turn.delivered ? [pageWord, terminalWord] : [pageWord]);
    // The terminal's turn must reach the page by itself; one the native session does not show either is not waited for.
    const bound = TERMINAL_SHOWN_MS[provider];
    const shownAfterMs = turn.delivered ? await this.waitForWords(page, [terminalWord], carrying(native.userTexts, terminalWord) > 0 ? bound : 5000).then(at => at === null ? null : Math.max(0, at - turn.endedAt)) : null;
    const wire = this.recorder.transcript().filter(entry => entry.n > from);
    const record: RoundRecord = {
      label,
      writers: [{ writer: 'page', word: pageWord, ...pageDelivery(wire, pageWord) },
        { writer: 'terminal', word: terminalWord, delivered: turn.delivered, tries: turn.tries.length, ...(last.reason ? { refusal: last.reason } : {}) }],
      native, pages: [await this.view(page)],
      ...(turn.delivered ? { terminalShown: { boundMs: bound, afterMs: [shownAfterMs] } } : {}),
    };
    // Through the shared daemon the page's session gets the terminal's turn as it runs: it says the session is working meanwhile.
    if (provider === 'codex' && turn.delivered) {
      const during = samples.filter(sample => sample.at >= last.t && sample.at <= last.t + last.ms);
      record.liveState = { seenWorking: [during.some(sample => sample.status === 'running')] };
    }
    return record;
  }

  /**
   * Waits until the native session is idle and shows `words`, or is idle and has not changed for `QUIET_MS` (a turn the native
   * session dropped never comes), or `SETTLE_MS`; returns what it shows then.
   */
  private async settle(words: string[]): Promise<ViewRecord> {
    const until = Date.now() + SETTLE_MS;
    let seen = '', since = Date.now();
    for (;;) {
      const { state, entries } = await this.context.pool.read(this.address, 10);
      const userTexts = entries.filter(entry => entry.role === 'user').map(entry => entry.text).reverse();
      const now = JSON.stringify([state, userTexts]);
      if (now !== seen) { seen = now; since = Date.now(); }
      const quiet = state === 'idle' && Date.now() - since >= QUIET_MS;
      if ((state === 'idle' && words.every(word => carrying(userTexts, word) > 0)) || quiet || Date.now() > until) {
        const inspected = await this.context.pool.command('session', 'inspect', this.address);
        const settings = Object.fromEntries((inspected.settings as Array<{ label: string; value: string | null; options: Array<{ value: string; label: string }> }>)
          .map(setting => [setting.label, setting.options.find(option => option.value === setting.value)?.label ?? setting.value ?? '']));
        return { name: 'native', userTexts, ...(inspected.status ? { status: String(inspected.status) } : state ? { status: state } : {}), settings };
      }
      await delay(1500);
    }
  }

  /** Waits until the page shows a message carrying each word; returns when, or `null` after `deadlineMs`. */
  private async waitForWords(page: OpenPage, words: string[], deadlineMs: number): Promise<number | null> {
    const until = Date.now() + deadlineMs;
    for (;;) {
      const shown = await page.probe.userTexts().catch(() => []);
      if (words.every(word => carrying(shown, word) > 0)) return Date.now();
      if (Date.now() > until) return null;
      await delay(500);
    }
  }

  private async view(page: OpenPage): Promise<ViewRecord> {
    const status = await page.probe.sessionStatus();
    const facts = await page.probe.sessionFacts().catch(() => undefined);
    return { name: page.name, userTexts: await page.probe.userTexts(), ...(status ? { status } : {}), ...(facts ? { settings: facts } : {}) };
  }

  summary(rounds: readonly RoundRecord[]): Record<string, unknown> {
    const shown = rounds.flatMap(round => round.terminalShown?.afterMs ?? []).filter((ms): ms is number => ms !== null).sort((a, b) => a - b);
    const tries = this.terminalTurns.flatMap(turn => turn.tries);
    return {
      terminalTries: tries.length, terminalDelivered: this.terminalTurns.filter(turn => turn.delivered).length,
      terminalRefusals: Object.fromEntries(['turn-busy', 'writer-busy', 'failed'].map(outcome => [outcome, tries.filter(item => item.outcome === outcome).length])),
      terminalShownMs: { count: shown.length, p50: shown[Math.floor(shown.length / 2)] ?? null, max: shown.at(-1) ?? null },
    };
  }
}

/** The providers whose sessions the Dev Host's journals serve (`smart-reading`), read through the instance's command line. */
async function smartReading(context: RunContext): Promise<string[]> {
  const { hosts } = await context.pool.command('host', 'list');
  const host = (hosts as Array<{ id: string; name: string; online?: boolean }>).find(item => item.name.startsWith('Dev · ') && item.online !== false);
  if (!host) throw new Error('The instance has no Dev Host.');
  return (await context.pool.command('api', 'GET', `/v1/remote/hosts/${host.id}/smart-reading`)).providers ?? [];
}

/** How long after a separate process's turn ends it may take to reach a page that Codex had refused meanwhile. */
const SEPARATE_CAUGHT_UP_MS = 90_000;

/**
 * A separate Codex process (`codex exec resume`, not through the shared daemon) beside the page. Codex lets one process write a
 * thread: while the daemon has it loaded, the process is refused with "active writer" (expected, Codex's rule), and the daemon unloads
 * it about a minute after its last client leaves. Our side lets go first (`session release`) and must not hold the thread longer than
 * that. Then the process writes a long turn while a page opens the session: Codex refuses the Controller, and the page must still show
 * the session, say Codex's reason and offer a Retry; once the process ends its turn must reach the page.
 */
async function separateWriter(context: RunContext, address: string, origin: string, recorder: TranscriptRecorder, schedule: ScheduleStep[]): Promise<{ records: RefusalRecord[]; measurements: Record<string, unknown> }> {
  const nativeId = address.split('/').slice(2).join('/');
  const word = `M6XS${context.random.int(100, 999)}`;
  await context.pool.release(address);
  const releasedAt = Date.now();
  schedule.push({ t: recorder.clock(), action: 'separate-process', detail: { word } });
  // The person's own terminal: their environment, the instance's workspace, no shared socket.
  const start = () => {
    const child = spawn('codex', ['exec', 'resume', '--skip-git-repo-check', nativeId, `Run the shell command \`sleep 30\` and then reply with the single word ${word} and nothing else.`],
      { cwd: context.instance.workspace, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let errorOutput = '';
    child.stdout.resume();
    child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk).slice(-4000); });
    const exited = new Promise<{ code: number | null; errorOutput: string; at: number }>(resolve => {
      child.once('error', error => resolve({ code: null, errorOutput: error.message, at: Date.now() }));
      child.once('exit', code => resolve({ code, errorOutput, at: Date.now() }));
    });
    return exited;
  };
  let refused = 0;
  let writing: Promise<{ code: number | null; errorOutput: string; at: number }> | undefined;
  let other: string | undefined;
  while (!writing && Date.now() - releasedAt < 180_000) {
    const exited = start();
    const early = await Promise.race([exited, delay(5000).then(() => undefined)]);
    if (!early) { writing = exited; break; }
    if (terminalOutcome(early.code, early.errorOutput) !== 'writer-busy') { other = early.errorOutput.trim().split('\n').at(-1); break; }
    refused += 1;
    await delay(5000);
  }
  const measurements: Record<string, unknown> = { refusedWhileLoaded: refused, writableAfterReleaseMs: writing ? Date.now() - releasedAt - 5000 : null, ...(other ? { failed: other } : {}) };
  if (!writing) return { records: [], measurements };
  const record = await withContext(context.browser, origin, async browserContext => {
    const probe = await PageProbe.create(browserContext, recorder.origin);
    await probe.open((await context.pool.link(address)).replace(context.instance.origin, origin), 'page beside a separate process', { rowsDeadlineMs: 20_000 });
    await probe.page.waitForTimeout(5000);
    const pane = `[data-native-session=${JSON.stringify(`codex/${nativeId}`)}]`;
    const shown = await probe.page.evaluate((selector: string) => {
      const root = document.querySelector(selector);
      const buttons = [...(root?.querySelectorAll('button') ?? [])].map(button => `${button.getAttribute('aria-label') ?? ''} ${button.textContent ?? ''}`);
      return { rows: root?.querySelectorAll('.agent-timeline-entry').length ?? 0, status: root?.querySelector('.agent-session-title[data-session-status]')?.getAttribute('data-session-status') ?? undefined,
        notice: [...(root?.querySelectorAll('.lab-session-control, [role="alert"], [role="status"]') ?? [])].map(node => (node as HTMLElement).innerText).join(' | '),
        retry: buttons.some(text => /retry|try again/i.test(text)), takeOver: buttons.some(text => /take over|take control/i.test(text)) };
    }, pane);
    const ended = await writing!;
    measurements.separateTurn = { code: ended.code, ranMs: ended.at - releasedAt };
    const retry = probe.page.locator(`${pane} button`, { hasText: /Retry|Try again/ }).first();
    if (await retry.count()) await retry.click().catch(() => undefined);
    const caughtUp = await probe.waitForText(word, SEPARATE_CAUGHT_UP_MS);
    await probe.close();
    return { label: 'codex separate process', shown: { ...shown, status: shown.status ?? undefined }, caughtUpMs: caughtUp ? Date.now() - ended.at : null, boundMs: SEPARATE_CAUGHT_UP_MS } as RefusalRecord;
  });
  return { records: [record], measurements };
}

/** What each `thread/resume` of the run cost the Controller, from the instance's own diagnostics: what attaching a Codex session takes. */
async function resumeTimings(instanceDirectory: string, since: string): Promise<{ count: number; p50: number | null; max: number | null }> {
  const lines = await readFile(join(instanceDirectory, 'logs', 'controller.log'), 'utf8').then(text => text.split('\n'), () => []);
  const ms = lines.flatMap(line => {
    if (!line.includes('"thread/resume"') || !line.includes('"completed"')) return [];
    try { const event = JSON.parse(line); return event.timestamp >= since && typeof event.elapsedMs === 'number' ? [event.elapsedMs as number] : []; } catch { return []; }
  }).sort((a, b) => a - b);
  return { count: ms.length, p50: ms[Math.floor(ms.length / 2)] ?? null, max: ms.at(-1) ?? null };
}
