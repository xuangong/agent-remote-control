import { result, type InvariantResult, type PageReport, type Transcript, type Violation } from './types.js';
import { markers, received, sent, payloadOf, agentOf } from './wire.js';

const RECONNECT_LABEL = /reconnect|synchroniz|connecting/i;

/** M3: once the page showed a conversation it never shows an empty frame again without a loading or empty-state placeholder. */
export function noBlankFrame(page: PageReport): InvariantResult {
  const violations: Violation[] = [];
  let shown = false;
  let checked = 0;
  for (const sample of page.samples) {
    if (sample.messages > 0) shown = true;
    else if (shown) {
      checked += 1;
      if (sample.loading.length === 0 && sample.labels.length === 0) violations.push({ message: 'the conversation went blank with no placeholder and no status label', at: sample.t });
    }
    if (sample.messages > 0) checked += 1;
  }
  return result('no-blank-frame', checked, violations);
}

/**
 * M3 and M7: a status label such as "Reconnecting" or "Synchronizing" must clear within `graceMs` of the Relay answering on an
 * open connection. A label that stays after the connection is healthy is stale.
 */
export function noStaleLabel(transcript: Transcript, page: PageReport, graceMs = 5000): InvariantResult {
  const violations: Violation[] = [];
  const ready = received(transcript).filter(frame => ['negotiated', 'timeline_page', 'agent_snapshot', 'agent_stream'].includes(frame.message.type));
  const closes = markers(transcript, 'socket-close');
  let checked = 0;
  for (const sample of page.samples) {
    if (!sample.labels.some(label => RECONNECT_LABEL.test(label))) continue;
    checked += 1;
    const anchor = ready.filter(frame => frame.t <= sample.t).at(-1);
    if (!anchor) continue;
    const closedSince = closes.some(close => close.connection === anchor.connection && close.t > anchor.t && close.t <= sample.t);
    // The newest answer must be old enough, and no newer open or close may explain the label.
    const reopened = markers(transcript, 'socket-open').some(open => open.t > anchor.t && open.t <= sample.t);
    if (!closedSince && !reopened && sample.t - anchor.t > graceMs) {
      violations.push({ message: `"${sample.labels.join(', ')}" still shown ${sample.t - anchor.t} ms after the Relay answered`, at: sample.t });
    }
  }
  return result('no-stale-label', checked, violations);
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
