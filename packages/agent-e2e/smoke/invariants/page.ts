import { result, type InvariantResult, type PageReport, type Transcript, type Violation } from './types.js';
import { sessionConnectionWordsIn } from '../../faults/connection-words.mjs';
import { markers, sent, received, payloadOf, agentOf } from './wire.js';

/** M3: once the page showed a conversation it never shows an empty frame again without a loading or empty-state placeholder. */
export function noBlankFrame(page: PageReport): InvariantResult {
  const violations: Violation[] = [];
  let shown = false;
  let checked = 0;
  for (const sample of page.samples) {
    if (sample.messages > 0) shown = true;
    else if (shown) {
      checked += 1;
      if (sample.loading.length === 0) violations.push({ message: 'the conversation went blank with no placeholder or held rows', at: sample.t });
    }
    if (sample.messages > 0) checked += 1;
  }
  return result('no-blank-frame', checked, violations);
}

/** T5: no sample of the page shows a per-session connection word. A business label such as Ready, Working or Host offline is fine. */
export function noSessionConnectionLabel(page: PageReport): InvariantResult {
  const violations: Violation[] = [];
  for (const sample of page.samples) {
    const words = sessionConnectionWordsIn(sample.labels.join('\n'));
    if (words.length > 0) violations.push({ message: `the page said ${words.map(word => `"${word}"`).join(', ')} at ${sample.t} ms`, at: sample.t, detail: sample.labels });
  }
  return result('no-session-connection-label', page.samples.length, violations);
}

/**
 * M7: after the page is visible or online again, catching up costs one tail request per session. Counts `timeline_request`
 * frames with direction `tail` in the interval after each `page-visible` or `online` marker, up to the next marker.
 */
export function catchUpCostsOneTailRequest(transcript: Transcript): InvariantResult {
  const returns = [...markers(transcript, 'page-visible'), ...markers(transcript, 'online')].sort((a, b) => a.n - b.n);
  const boundaries = [...returns, ...markers(transcript, 'page-hidden'), ...markers(transcript, 'offline')].sort((a, b) => a.n - b.n);
  const violations: Violation[] = [];
  for (const marker of returns) {
    const next = boundaries.find(candidate => candidate.n > marker.n);
    const requests = sent(transcript, 'timeline_request').filter(frame => frame.n > marker.n && (!next || frame.n < next.n) && payloadOf(frame.message).direction === 'tail');
    const perAgent = new Map<string, number>();
    for (const request of requests) perAgent.set(agentOf(request.message), (perAgent.get(agentOf(request.message)) ?? 0) + 1);
    for (const [agent, count] of perAgent) if (count > 1) violations.push({ message: `${count} tail requests for ${agent} after the page returned`, at: marker.t });
  }
  return result('catch-up-costs-one-tail-request', returns.length, violations);
}

/** M7: the draft text and the reader's position are what they were before the page was hidden or offline. */
export function draftAndPositionKept(page: PageReport): InvariantResult {
  const violations: Violation[] = [];
  let checked = 0;
  if (page.composer) {
    checked += 1;
    if (page.composer.before.text !== page.composer.after.text) violations.push({ message: 'the draft changed', detail: page.composer });
  }
  if (page.anchor?.before && page.anchor.after) {
    checked += 1;
    if (page.anchor.before.key !== page.anchor.after.key || Math.abs(page.anchor.before.offset - page.anchor.after.offset) > 2) {
      violations.push({ message: 'the reader lost the position', detail: page.anchor });
    }
  } else if (page.anchor?.before && !page.anchor.after) {
    checked += 1;
    violations.push({ message: 'the row the reader was at is gone', detail: page.anchor });
  }
  return result('draft-and-position-kept', checked, violations);
}

/**
 * M7: a socket that went half-open (open, but swallowing traffic) is noticed and its session is served again: the Relay answers a
 * new negotiation within `withinMs` of the fault marker whose detail says `kind: 'half-open'`. Another channel reopening sooner
 * (the account channel) does not count.
 */
export function halfOpenSocketRecovers(transcript: Transcript, withinMs = 60_000): InvariantResult {
  const faults = markers(transcript, 'fault').filter(marker => marker.detail?.kind === 'half-open');
  const violations: Violation[] = [];
  for (const fault of faults) {
    const served = received(transcript, 'negotiated').find(frame => frame.t > fault.t);
    if (!served) violations.push({ message: 'the session was never served again after the half-open socket', at: fault.t });
    else if (served.t - fault.t > withinMs) violations.push({ message: `the page took ${Math.round(served.t - fault.t)} ms to get its session served again`, at: fault.t });
  }
  return result('half-open-socket-recovers', faults.length, violations);
}
