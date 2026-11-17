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
 * Which side answered an open: the Controller when one of its session attaches completed before the page had its first
 * message (`fromMs` to `toMs`, in `diagnostics --source controller`), the journal otherwise. A journal-served open shows its
 * rows without waiting for an attach; the page's Controller stream still opens and attaches after the rows are shown.
 */
export function answeredBy(controllerEntries, { fromMs, toMs }) {
  return controllerEntries.some(entry => entry.event === 'host_request_completed' && entry.operation === 'session_attach' && within(entry, fromMs, toMs)) ? 'controller' : 'journal';
}

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

// Markdown marks are not in the page's text: the page renders `code` and *emphasis* as elements.
const normalized = text => String(text).replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();

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
  // The S6a defect lines: a replacement on a settled reopen is a defect to fix in the adapter, any hole is one, and fewer than 30 counted opens repeats the run.
  const replaced = step => ['new', 'incomplete', 'open_item', 'changed'].reduce((sum, reason) => sum + (step.windows.byReason[reason] ?? 0), 0);
  const settledKinds = ['reload', 'release', 'restart', 'turn'];
  const served = steps.filter(step => step.sample?.journalServed === true).length;
  return {
    settledReplacements: steps.filter(step => settledKinds.includes(step.kind)).reduce((sum, step) => sum + replaced(step), 0),
    replacementsByKind: Object.fromEntries([...new Set(steps.map(step => step.kind))].map(kind => [kind, steps.filter(step => step.kind === kind).reduce((sum, step) => sum + replaced(step), 0)])),
    opensWithHoles: steps.filter(step => (step.holes?.missing.length ?? 0) > 0).length,
    servedOpens: served,
    needsRepeat: served < 30,
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

/** The timeline epoch and next sequence in a journal's `meta` record, from its chunks (hex of each chunk, in order); null when there is none. */
export function parseJournalMeta(chunkHexes) {
  if (!chunkHexes.length) return null;
  try {
    const meta = JSON.parse(Buffer.concat(chunkHexes.map(hex => Buffer.from(hex, 'hex'))).toString('utf8'));
    return typeof meta.epoch === 'string' ? { epoch: meta.epoch, nextSeq: meta.nextSeq } : null;
  } catch { return null; }
}

/**
 * Whether the page was served from the Relay's journal. With the item-key flag (S4 builds) the stream echoes it, and a
 * Controller-answered stream never does. The control build has no flag: its page's `timeline_page` epochs must equal the
 * journal's epoch both before and after the sample, because the journal can be replaced while the sample runs.
 */
export function journalServed({ signal, itemKeysEchoed, pageEpochs, metaBefore, metaAfter }) {
  if (signal === 'flag') return itemKeysEchoed === true;
  if (!metaBefore || !metaAfter || !pageEpochs.length) return false;
  return pageEpochs.every(epoch => epoch === metaBefore.epoch && epoch === metaAfter.epoch);
}

/** The states of the observer log in which the conversation had shown rows and then showed none. */
export function rowlessStates(states) {
  const first = states.findIndex(state => state.entries > 0);
  return first < 0 ? 0 : states.slice(first).filter(state => state.entries === 0).length;
}

/** The composer before and after an action: the same text, the same focus, the same selection, and never disabled. */
export function composerUnchanged(before, after, disabledStates = 0) {
  return before.text === after.text && before.focused === after.focused && before.selectionStart === after.selectionStart && before.selectionEnd === after.selectionEnd && disabledStates === 0;
}

/**
 * Whether a table cell may state a percentile. A condition with fewer samples than `minimum` states the maximum and the count.
 * The minimum is 20, or 10 for the conditions that restart the instance for every sample.
 */
export function reportable(values, minimum = 20) {
  const own = stats(values);
  return own.n >= minimum ? { n: own.n, p50: own.p50, p95: own.p95, max: own.max } : { n: own.n, p50: null, p95: null, max: own.max, belowMinimum: minimum };
}
