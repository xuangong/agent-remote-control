// M6: writers racing on one session. Inside our system (any number of pages on one session) there is no conflict: every page can
// send, no message is lost or doubled, and every page shows the same state and properties as the native session. A terminal is
// outside our system and its CLI's own rules decide (Codex orders the turns of its shared daemon's clients; Claude Code resumes its
// transcript): the page reports what happened, live. Each invariant reads the rounds a run recorded (`RoundRecord`).
import { result, type InvariantResult, type PageReport, type RefusalRecord, type RoundRecord, type Transcript, type Violation } from './types.js';
import { payloadOf, received, sent } from './wire.js';

/** How many of the person's messages carry `word` as a word of their own. */
export const carrying = (texts: readonly string[], word: string): number =>
  texts.filter(text => new RegExp(`(^|[^A-Za-z0-9])${word}([^A-Za-z0-9]|$)`).test(text)).length;

/**
 * Every message is shown once by every place that shows the session: the native session and each page. A message whose writer was
 * told it was taken and that a place does not show is lost there; one shown twice is doubled; one shown although its writer was told
 * it was refused was delivered behind the writer's back.
 */
export function noLostOrDoubledMessage(rounds: readonly RoundRecord[]): InvariantResult {
  const violations: Violation[] = [];
  let checked = 0;
  for (const round of rounds) {
    for (const view of [round.native, ...round.pages]) {
      for (const writer of round.writers) {
        checked += 1;
        const count = carrying(view.userTexts, writer.word);
        if (writer.delivered && count === 0) violations.push({ message: `[${round.label}] ${view.name} lost the ${writer.writer}'s message ${writer.word}` });
        if (count > 1) violations.push({ message: `[${round.label}] ${view.name} shows the ${writer.writer}'s message ${writer.word} ${count} times` });
        if (!writer.delivered && count > 0) violations.push({ message: `[${round.label}] ${view.name} shows the ${writer.writer}'s message ${writer.word}, which its writer was told was refused (${writer.refusal ?? 'no reason'})` });
      }
    }
  }
  return result('no-lost-or-doubled-message', checked, violations);
}

/** Every writer's message is taken, after the tries its CLI's rules allow (Codex takes a terminal's turn once another client's turn ends). */
export function everyWriterSends(rounds: readonly RoundRecord[]): InvariantResult {
  const violations: Violation[] = [];
  let checked = 0;
  for (const round of rounds) {
    for (const writer of round.writers) {
      checked += 1;
      if (!writer.delivered) violations.push({ message: `[${round.label}] the ${writer.writer} could not send ${writer.word} in ${writer.tries} tries: ${writer.refusal ?? 'no reason given'}` });
    }
  }
  return result('every-writer-sends', checked, violations);
}

/** A terminal's turn reaches every page by itself, with no send from the page after it, within the round's bound. */
export function terminalRowsAppear(rounds: readonly RoundRecord[]): InvariantResult {
  const violations: Violation[] = [];
  let checked = 0;
  for (const round of rounds) {
    if (!round.terminalShown) continue;
    round.terminalShown.afterMs.forEach((ms, page) => {
      checked += 1;
      if (ms === null) violations.push({ message: `[${round.label}] the terminal's turn did not appear on ${round.pages[page]?.name ?? `page ${page + 1}`} within ${round.terminalShown!.boundMs} ms` });
    });
  }
  return result('terminal-rows-appear', checked, violations);
}

/**
 * Every page shows what the native session says: the same activity and the same settings, and so the same as every other page. A
 * page that joins the session's live events also says the session is working while a terminal's turn runs in it.
 */
export function stateAndPropertiesMatch(rounds: readonly RoundRecord[]): InvariantResult {
  const violations: Violation[] = [];
  let checked = 0;
  for (const round of rounds) {
    for (const page of round.pages) {
      if (round.native.status !== undefined && page.status !== undefined) {
        checked += 1;
        if (page.status !== round.native.status) violations.push({ message: `[${round.label}] ${page.name} says ${page.status}, the native session ${round.native.status}` });
      } else if (round.native.status !== undefined) {
        checked += 1;
        violations.push({ message: `[${round.label}] ${page.name} shows no activity` });
      }
      for (const [label, value] of Object.entries(round.native.settings ?? {})) {
        checked += 1;
        const shown = page.settings?.[label];
        if (shown !== value) violations.push({ message: `[${round.label}] ${page.name} shows ${label} ${shown === undefined ? 'nowhere' : `"${shown}"`}, the native session "${value}"` });
      }
    }
    round.liveState?.seenWorking.forEach((seen, page) => {
      checked += 1;
      if (!seen) violations.push({ message: `[${round.label}] ${round.pages[page]?.name ?? `page ${page + 1}`} never said the session was working while the terminal's turn ran` });
    });
  }
  return result('state-and-properties-match', checked, violations);
}

/**
 * A page's message as its writer was told: taken when the Relay acknowledged its send, refused when it answered with an error, and in
 * how many sends (a retry keeps the operation). The message is found by the word its text carries.
 */
export function pageDelivery(transcript: Transcript, word: string): { delivered: boolean; tries: number; refusal?: string } {
  const sends = sent(transcript, 'send_message').filter(frame => carrying([String(payloadOf(frame.message).text ?? '')], word) > 0);
  // A request id is the page's own counter: the answer is the one on the same socket.
  const answers = sends.map(frame => {
    const requestId = payloadOf(frame.message).requestId;
    return received(transcript).find(answer => answer.connection === frame.connection && payloadOf(answer.message).requestId === requestId && ['command_acknowledged', 'protocol_error'].includes(answer.message.type));
  });
  const taken = answers.some(answer => answer?.message.type === 'command_acknowledged');
  const refused = [...answers].reverse().find(answer => answer?.message.type === 'protocol_error');
  return { delivered: taken, tries: sends.length, ...(!taken && refused ? { refusal: `${payloadOf(refused.message).code}: ${payloadOf(refused.message).message ?? ''}`.trim() } : {}) };
}

/** The page reports of one condition merged, so a page-wide invariant reads every page of it. */
export function mergePageReports(pages: readonly PageReport[]): PageReport {
  return { samples: pages.flatMap(page => page.samples).sort((a, b) => a.t - b.t), paints: pages.flatMap(page => page.paints),
    rowKeys: pages.flatMap(page => page.rowKeys), finalRows: pages.flatMap(page => page.finalRows) };
}

/** The words a page uses for Codex's own reason when it refuses the Controller: another Codex process writes the session. */
const CODEX_WRITER_REASON = /active writer|another Codex process/i;

/**
 * When Codex refuses the Controller because a separate process writes the session, the page still shows the session's content and
 * activity, says Codex's reason and offers a Retry; once the process has ended, its turn reaches the page.
 */
export function pageStaysLiveWhenCodexRefuses(records: readonly RefusalRecord[]): InvariantResult {
  const violations: Violation[] = [];
  let checked = 0;
  for (const record of records) {
    checked += 5;
    if (record.shown.rows === 0) violations.push({ message: `[${record.label}] the page showed none of the session's rows while Codex refused it` });
    if (record.shown.status === undefined) violations.push({ message: `[${record.label}] the page showed no activity while Codex refused it` });
    if (!CODEX_WRITER_REASON.test(record.shown.notice)) violations.push({ message: `[${record.label}] the page did not say Codex's reason; it said "${record.shown.notice.replace(/\s+/g, ' ').trim().slice(0, 160)}"` });
    if (!record.shown.retry) violations.push({ message: `[${record.label}] the page offered no Retry` });
    if (record.caughtUpMs === null) violations.push({ message: `[${record.label}] the separate process's turn did not reach the page within ${record.boundMs} ms of its end` });
  }
  return result('page-stays-live-when-codex-refuses', checked, violations);
}
