import { result, type InvariantResult, type PageReport, type Transcript, type Violation } from './types.js';
import { agentOf, frames, intervalsBetween, markers, payloadOf, received, sent } from './wire.js';

/**
 * M2: the sequences the page receives are contiguous within an epoch of one connection. A live entry continues the newest
 * sequence seen for its epoch from a tail page or an earlier entry; a repeat or a gap is a violation. A new epoch starts a new run of sequences.
 */
export function journalSequencesContiguous(transcript: Transcript): InvariantResult {
  const newest = new Map<string, number>();
  const violations: Violation[] = [];
  let checked = 0;
  for (const frame of received(transcript)) {
    const { message } = frame;
    const payload = payloadOf(message);
    if (message.type === 'timeline_page' && payload.endCursor) {
      const key = `${frame.connection}:${agentOf(message)}:${payload.endCursor.epoch}`;
      if (payload.direction === 'tail' || payload.hasNewer === false) newest.set(key, Math.max(newest.get(key) ?? 0, payload.endCursor.seq));
    } else if (message.type === 'agent_stream' && typeof payload.seq === 'number') {
      const key = `${frame.connection}:${agentOf(message)}:${payload.epoch}`;
      const last = newest.get(key);
      checked += 1;
      if (last !== undefined && payload.seq !== last + 1) {
        violations.push({ message: `epoch ${payload.epoch}: sequence ${payload.seq} followed ${last}`, at: frame.t });
      }
      newest.set(key, payload.seq);
    }
  }
  return result('journal-sequences-contiguous', checked, violations);
}

/** M2: between two restarts the page is told of at most one replacement per session. */
export function oneReplacementPerRestart(transcript: Transcript): InvariantResult {
  const restarts = [...markers(transcript, 'controller-restart'), ...markers(transcript, 'relay-restart')];
  const violations: Violation[] = [];
  intervalsBetween(transcript, restarts).forEach((interval, at) => {
    const perAgent = new Map<string, Set<string>>();
    for (const frame of interval) {
      if (frame.direction !== 'relay->browser' || frame.message.type !== 'timeline_replacement') continue;
      const epochs = perAgent.get(agentOf(frame.message)) ?? new Set<string>();
      epochs.add(String(payloadOf(frame.message).epoch));
      perAgent.set(agentOf(frame.message), epochs);
    }
    for (const [agent, epochs] of perAgent) if (epochs.size > 1) violations.push({ message: `${epochs.size} replacements of ${agent} in the interval after restart ${at}`, detail: [...epochs] });
  });
  return result('one-replacement-per-restart', restarts.length, violations);
}

/**
 * M2: after the last return, every turn the scenario sent shows its user message and, unless the turn was cut off on purpose
 * (`requireReply: false`), an assistant message before the next user message; no tool call is still running.
 */
export function turnRowsCompleteAfterReturn(page: PageReport, turns: Array<{ prompt: string; requireReply?: boolean }>): InvariantResult {
  const violations: Violation[] = [];
  const rows = page.finalRows;
  turns.forEach(({ prompt, requireReply = true }, at) => {
    const start = rows.findIndex(row => row.kind === 'user_message' && row.text.includes(prompt));
    if (start === -1) { violations.push({ message: `the user message of turn ${at + 1} is missing` }); return; }
    const next = rows.findIndex((row, index) => index > start && row.kind === 'user_message');
    const turnRows = rows.slice(start + 1, next === -1 ? undefined : next);
    if (requireReply && !turnRows.some(row => row.kind === 'assistant_message' && row.text.trim() !== '')) violations.push({ message: `turn ${at + 1} has no assistant reply` });
    const running = turnRows.find(row => row.kind === 'tool_call' && row.status === 'running');
    if (running) violations.push({ message: `turn ${at + 1} still shows a running tool call (${running.key})` });
  });
  return result('turn-rows-complete-after-return', turns.length, violations);
}

/** M4: a page that starts above sequence 1 must say there is older history; a trim the page is not told about hides rows. */
export function trimReported(transcript: Transcript): InvariantResult {
  const violations: Violation[] = [];
  const pages = received(transcript, 'timeline_page').filter(frame => payloadOf(frame.message).direction === 'tail' || payloadOf(frame.message).direction === 'older');
  for (const frame of pages) {
    const { window, hasOlder } = payloadOf(frame.message);
    if (window && window.minSeq > 1 && hasOlder === false) violations.push({ message: `page starts at sequence ${window.minSeq} but reports no older history`, at: frame.t });
  }
  return result('trim-reported', pages.length, violations);
}

/** M4: the items that exist only live (a streaming message, a running tool call) the scenario named are still shown at the end. */
export function liveOnlyItemsSurvive(page: PageReport, expectedKeys: string[]): InvariantResult {
  const shown = new Set(page.finalRows.map(row => row.key));
  const violations = expectedKeys.filter(key => !shown.has(key)).map(key => ({ message: `live-only item ${key} is gone after the trim` }));
  return result('live-only-items-survive', expectedKeys.length, violations);
}

/** M4: no page leaves a hole between its entries: each entry starts at the sequence after the previous one ends. */
export function noRefusedRowHole(transcript: Transcript): InvariantResult {
  const violations: Violation[] = [];
  let checked = 0;
  for (const frame of received(transcript, 'timeline_page')) {
    const entries: Array<{ seqStart: number; seqEnd: number }> = payloadOf(frame.message).entries ?? [];
    for (let at = 1; at < entries.length; at += 1) {
      checked += 1;
      if (entries[at]!.seqStart > entries[at - 1]!.seqEnd + 1) {
        violations.push({ message: `hole between sequence ${entries[at - 1]!.seqEnd} and ${entries[at]!.seqStart}`, at: frame.t });
      }
    }
  }
  return result('no-refused-row-hole', checked, violations);
}


/**
 * M4: every window a Controller publishes is either taken (acknowledged up to its sequence) or refused by name at its sequence, never
 * dropped without an answer; and a window larger than `sessionBytes`, when given, is refused (`quota_exceeded`), not taken in part.
 */
export function quotaRefusalsReported(transcript: Transcript, { sessionBytes }: { sessionBytes?: number } = {}): InvariantResult {
  const violations: Violation[] = [];
  const answers = (key: string, generation: unknown, after: number) => frames(transcript).filter(frame => frame.n > after && frame.direction === 'relay->browser'
    && payloadOf(frame.message).sessionKey === key && payloadOf(frame.message).generation === generation);
  let checked = 0;
  for (const frame of sent(transcript, 'journal_publish')) {
    const { sessionKey, generation, entries = [] } = payloadOf(frame.message);
    for (const entry of entries as Array<{ sequence: number; op: string }>) {
      if (entry.op !== 'window') continue;
      checked += 1;
      const later = answers(sessionKey, generation, frame.n);
      const refused = later.find(item => item.message.type === 'journal_refused' && payloadOf(item.message).sequence === entry.sequence);
      const taken = later.some(item => item.message.type === 'journal_ack' && payloadOf(item.message).watermark >= entry.sequence);
      const bytes = new TextEncoder().encode(JSON.stringify(entry)).length;
      if (!refused && !taken) violations.push({ message: `the window at sequence ${entry.sequence} of ${sessionKey} got no answer`, at: frame.t });
      else if (refused && taken) violations.push({ message: `the window at sequence ${entry.sequence} of ${sessionKey} was refused and acknowledged`, at: frame.t });
      else if (sessionBytes !== undefined && bytes > sessionBytes && !refused) violations.push({ message: `a window of ${bytes} bytes was taken by a session limited to ${sessionBytes}`, at: frame.t });
      else if (refused && payloadOf(refused.message).reason !== 'quota_exceeded' && sessionBytes !== undefined && bytes > sessionBytes) violations.push({ message: `a window over the limit was refused as ${payloadOf(refused.message).reason}`, at: frame.t });
    }
  }
  return result('quota-refusals-reported', checked, violations);
}
