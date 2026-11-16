// The pure parts of the journal measurements of local-baselines.mjs: statistics, what the Relay's diagnostics say about the
// windows and requests of an open, which side answered an open, and the hole check. No I/O, so a test can run them.

/** The value at percentile `p` (0 to 1) of the finite values, to one decimal; null when there are none. */
export function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] * 10) / 10;
}

export const stats = values => ({ n: values.filter(Number.isFinite).length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: percentile(values, 1) });

const timeOf = entry => Date.parse(entry.timestamp ?? entry.time);
const within = (entry, fromMs, toMs) => { const at = timeOf(entry); return Number.isFinite(at) && at >= fromMs && at <= toMs; };

/**
 * What the Relay's diagnostics (`diagnostics --source server`) say between `fromMs` and `toMs`: the reasons of the windows the
 * Controller published and their sizes, the requests for bodies and older history, and the refusals. Metadata only.
 * `agentId` limits it to one session (the Relay names a journal's session key there).
 */
export function windowCounts(entries, { fromMs, toMs, agentId } = {}) {
  const own = entries.filter(entry => within(entry, fromMs ?? -Infinity, toMs ?? Infinity) && (agentId === undefined || entry.agentId === undefined || entry.agentId === agentId));
  const windows = own.filter(entry => entry.event === 'journal_window');
  const byReason = {};
  for (const { reason } of windows) byReason[reason] = (byReason[reason] ?? 0) + 1;
  const requests = { fill: 0, older: 0 };
  for (const entry of own) if (entry.event === 'journal_request' && entry.reason in requests) requests[entry.reason] += 1;
  return {
    windows: windows.length, byReason, bytes: windows.map(entry => entry.bytes).filter(Number.isFinite), requests,
    quotaRefusals: own.filter(entry => entry.event === 'journal_quota_exceeded').length,
  };
}

/**
 * Which side answered an open: the Controller when the Relay opened a Controller stream for the session (`stream_opening`
 * with the session's public agent id) during the open, the journal otherwise. A journal-served stream opens none to read.
 */
export function answeredBy(entries, { agentId, fromMs, toMs }) {
  return entries.some(entry => entry.event === 'stream_opening' && entry.agentId === agentId && within(entry, fromMs, toMs)) ? 'controller' : 'journal';
}

/** The public agent id a page's session socket names, from `/v1/sessions/<agentId>/events`. */
export const agentIdOfSocket = url => /\/v1\/sessions\/([^/]+)\/events/.exec(new URL(url).pathname)?.[1];

/** Controller log lines (`diagnostics --source controller`) of the journal events that say a session was stopped, unserved or refused. */
export function controllerJournalEvents(entries, { fromMs, toMs } = {}) {
  const names = ['journal_open_refused', 'journal_session_stopped', 'journal_session_unserved', 'journal_session_restarted'];
  const counts = Object.fromEntries(names.map(name => [name, 0]));
  for (const entry of entries) {
    const event = typeof entry.event === 'string' ? entry.event : undefined;
    if (event && event in counts && within(entry, fromMs ?? -Infinity, toMs ?? Infinity)) counts[event] += 1;
  }
  return counts;
}

const normalized = text => String(text).replace(/\s+/g, ' ').trim();

/**
 * The hole check: every user and assistant message of a full native read (`session read` entries) is among the texts a
 * journal-served read of the same session shows. A message missing from the journal-served read is a hole.
 */
export function holeCheck(nativeEntries, servedTexts) {
  const served = servedTexts.map(normalized);
  const messages = nativeEntries.filter(entry => (entry.role === 'user' || entry.role === 'assistant') && normalized(entry.text ?? '') !== '');
  const missing = messages.filter(entry => !served.some(candidate => candidate.includes(normalized(entry.text))));
  return { nativeMessages: messages.length, servedMessages: served.length, missing: missing.map(entry => ({ id: entry.id, role: entry.role, preview: normalized(entry.text).slice(0, 60) })) };
}

/**
 * The numbers of the thresholds of the S3 plan from the 30 opens of `journal-reopen-mix`. Each step is
 * `{ kind: 'reload' | 'release' | 'restart' | 'interruption', windows: windowCounts(), holes: holeCheck() | undefined }`.
 */
export function mixThresholds(steps) {
  const count = (kind, reason) => steps.filter(step => step.kind === kind).reduce((sum, step) => sum + (step.windows.byReason[reason] ?? 0), 0);
  const opens = steps.length;
  const openItem = steps.reduce((sum, step) => sum + (step.windows.byReason.open_item ?? 0), 0);
  const settledOpenItem = ['reload', 'release', 'restart'].reduce((sum, kind) => sum + count(kind, 'open_item'), 0);
  const interruptions = steps.filter(step => step.kind === 'interruption');
  return {
    opens,
    openItemReplacements: openItem,
    openItemShare: opens ? Math.round(openItem / opens * 1000) / 1000 : null,
    i2Triggered: opens > 0 && (openItem / opens > 0.05 || settledOpenItem > 0),
    changedReplacements: steps.reduce((sum, step) => sum + (step.windows.byReason.changed ?? 0), 0),
    interruptionsWithHoles: interruptions.filter(step => (step.holes?.missing.length ?? 0) > 0).length,
    m3Triggered: interruptions.filter(step => (step.holes?.missing.length ?? 0) > 0).length > 1,
    fillsPerOpenP50: percentile(steps.map(step => step.windows.requests.fill), 0.5),
    quotaRefusals: steps.reduce((sum, step) => sum + step.windows.quotaRefusals, 0),
    evictionTriggered: (percentile(steps.map(step => step.windows.requests.fill), 0.5) ?? 0) > 1 || steps.some(step => step.windows.quotaRefusals > 0),
  };
}
