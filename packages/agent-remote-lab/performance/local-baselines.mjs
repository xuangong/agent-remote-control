// P0 baselines of the browser experience on the `pnpm local` instance (see README.md and
// docs/superpowers/plans/2026-11-15-p0-baselines.md). Run from the repository root while the instance runs:
//   node packages/agent-remote-lab/performance/local-baselines.mjs --scenarios open-known,open-fresh --out .tmp/p0.json
// Options:
//   --origin URL          the instance origin (default: `pnpm --silent local status --json`, which signs in once)
//   --scenarios a,b,c     open-known, open-fresh, open-cold-context, open-released, hidden-short, hidden-long,
//                         send-resident, send-released, release-continuity, restart-continuity, provider-latency, switch,
//                         journal-open, journal-reopen-mix (the S3 journal measurements), replacement-absorbed, runtime-release
//                         (the S4a measurements; see README.md)
//   --provider P          copilot (default), claude or codex: the provider whose sessions the journal scenarios
//                         (journal-open, journal-reopen-mix) open; export ARC_LOCAL_JOURNALS=1 so a restart keeps journals on
//   --reps N              samples per session (default 3)
//   --throttle N          CPU slowdown factor (default 1)
//   --sessions A,B        session addresses (default: every session `session list` shows in the instance workspace)
//   --release-wait MS     how long to wait after a release before acting (default 1500; Codex unloads a released
//                         thread about a minute later, so 75000 measures a real wake; only Codex sessions run then)
//   --hidden-short MS / --hidden-long MS   hidden durations (default 30000 / 300000)
//   --deadline MS         outer deadline for the whole run (default 1500000)
//   --action MS           deadline of one action (default 30000)
//   --label TEXT          a name stored in the result, for example control, s4a or s4a-crude
//   --rtt MS              emulated round trip between the browser and the instance, through a delaying proxy that delays HTTP and
//                         WebSocket traffic (default 0: direct). The command line still talks to the instance directly. A run
//                         marked invalid when no WebSocket crossed the proxy.
//   --journal-signal S    how a sample is classified as served from the Relay's journal: `flag` (the stream echoed the item-key
//                         flag; S4 builds) or `meta` (the page's timeline epochs equal the epoch in journals.sqlite; the control
//                         build, which has no flag). Default `flag`.
// Every scenario uses one browser context (one sign-in; the open-cold-context scenario uses one per sample). Results are
// written as JSON after every scenario, so a run that hits the outer deadline keeps what it finished.
//
// Definitions. Every time is milliseconds on one clock (Date.now) in this process and in the page.
//   start   : the moment before page.goto / page.reload, the moment the page is shown again (hidden scenarios), or the
//             moment the Enter key is pressed (send scenarios).
//   content : the first moment a conversation message (.agent-message) is in the document.
//   ready   : the first moment after start at which the status label reads "Ready", the composer is enabled and no
//             loading placeholder is shown.
// A page-side observer records every change of the visible status labels, loading placeholder, session-control notice,
// composer state, message count and delivery state, so each blocking state has a first-seen time and a duration.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { answeredBy, composerUnchanged, controllerJournalEvents, holeCheck, journalServed, mixThresholds, parseJournalMeta, rowlessStates, stats, windowCounts } from './journal-measurement.mjs';
import { SESSION_CONNECTION_PATTERN } from '@orchardworks/agent-e2e/faults/connection-words.mjs';
import { startLatencyProxy } from '@orchardworks/agent-e2e/faults/latency-proxy.mjs';

const execFileAsync = promisify(execFile);
const root = process.cwd();
function parseOptions(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) parsed[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? 'true' : argv[++i];
  return parsed;
}
const options = parseOptions(process.argv.slice(2));
const actionMs = Number(options.action ?? 30_000);
const reps = Number(options.reps ?? 3);
const throttle = Number(options.throttle ?? 1);
const releaseWaitMs = Number(options['release-wait'] ?? 1500);
const hiddenShortMs = Number(options['hidden-short'] ?? 30_000);
const hiddenLongMs = Number(options['hidden-long'] ?? 300_000);
const outFile = resolve(options.out ?? '.tmp/local-baselines.json');
const label = options.label;
const journalProvider = options.provider ?? 'copilot';
if (!['copilot', 'claude', 'codex'].includes(journalProvider)) throw new Error('--provider must be copilot, claude or codex.');
const wanted = (options.scenarios ?? 'open-known,open-fresh,open-released,hidden-short,send-resident,send-released,release-continuity,provider-latency,switch').split(',');
const directOrigin = options.origin ?? JSON.parse(execFileSync('pnpm', ['--silent', 'local', 'status', '--json'], { cwd: root, encoding: 'utf8' })).origin;
const rttMs = Number(options.rtt ?? 0);
const journalSignal = options['journal-signal'] ?? 'flag';
// The browser goes through a proxy that delays every exchange, WebSocket frames included, when a round trip is asked for.
const proxy = rttMs > 0 ? await startLatencyProxy({ target: directOrigin, rttMs }) : undefined;
const origin = proxy?.origin ?? directOrigin;
const { chromium } = createRequire(join(root, 'packages/agent-remote-lab/package.json'))('@playwright/test');

const controller = (...args) => JSON.parse(execFileSync('agent-remote-controller-dev', args, { cwd: root, encoding: 'utf8', timeout: 180_000 }));
const sessions = (options.sessions ? options.sessions.split(',') : controller('session', 'list', '--limit', '50').sessions.map(item => item.address))
  .map(address => ({ address, provider: address.split('/')[1], url: controller('session', 'link', address).url.replace(directOrigin, origin) }));
if (proxy && sessions.some(item => !item.url.startsWith(origin))) throw new Error(`A session link does not start with the proxy origin ${origin}; the page would bypass the latency proxy.`);
if (!sessions.length) throw new Error('The instance has no sessions; create some with real model turns first.');
const byProvider = provider => sessions.filter(item => item.provider === provider);
// Sessions whose runtime a release can unload: Claude Code has none to release, and a long wait is only meaningful for Codex.
const releasable = () => releaseWaitMs > 5000 ? byProvider('codex') : sessions;
/** Loads the session's runtime with one tiny turn (Codex), so that a release has something to release. */
async function makeResident(session) {
  if (session.provider !== 'codex') return;
  controller('session', 'send', session.address, 'Reply with the single word OK.');
  await waitIdle(session.address);
}
/** Releases the runtime, then waits `releaseWaitMs`. Returns what the Controller answered. */
async function releaseRuntime(session) {
  await makeResident(session);
  const released = controller('session', 'release', session.address).released;
  await delay(releaseWaitMs);
  return released;
}

const result = { startedAt: new Date().toISOString(), origin, options: { reps, throttle, rttMs, journalSignal, hiddenShortMs, hiddenLongMs, scenarios: wanted, label: options.label ?? null },
  sessions: sessions.map(({ address, provider }) => ({ address, provider })), environment: undefined, scenarios: {} };
const save = () => { mkdirSync(dirname(outFile), { recursive: true }); writeFileSync(outFile, JSON.stringify(result, null, 2)); };
const outer = setTimeout(() => { result.outerDeadlineHit = true; save(); console.error('Outer deadline reached; partial results saved.'); process.exit(2); }, Number(options.deadline ?? 1_500_000));

const browser = await chromium.launch({ headless: true });
result.environment = {
  machine: `${cpus()[0]?.model ?? 'unknown'} x${cpus().length}, ${Math.round(totalmem() / 2 ** 30)} GiB, ${platform()} ${release()} ${arch()}`,
  chromium: browser.version(), node: process.version,
  build: controller('--build-info'),
};
save();

// ---- statistics: see journal-measurement.mjs ----
const withDeadline = (promise, ms, label) => {
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Deadline of ${ms} ms passed: ${label}`)), ms); });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
};

// ---- page-side observer ----
const observerSource = `(() => {
  const log = [];
  const unique = list => [...new Set(list)];
  const texts = selector => unique([...document.querySelectorAll(selector)].map(node => node.textContent.trim()).filter(Boolean));
  const read = () => {
    const editor = document.querySelector('[data-testid="prompt-input"]');
    return {
      labels: texts('.lab-conversation-status'),
      loading: texts('.lab-empty-state h3'),
      control: texts('.lab-session-control-owner'),
      composer: !editor ? 'absent' : editor.getAttribute('aria-disabled') === 'true' || editor.getAttribute('contenteditable') === 'false' ? 'disabled' : 'enabled',
      messages: document.querySelectorAll('.agent-message').length,
      assistant: document.querySelectorAll('.agent-message-assistant').length,
      entries: document.querySelectorAll('.agent-timeline-entry').length,
      delivery: unique([...document.querySelectorAll('[data-delivery-state]')].map(node => node.getAttribute('data-delivery-state'))),
    };
  };
  let last = '', lastRun = 0, scheduled = false;
  const sample = () => {
    scheduled = false; lastRun = performance.now();
    const state = read(), key = JSON.stringify(state);
    if (key !== last) { last = key; log.push({ t: Date.now(), ...state }); }
  };
  const request = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(sample, Math.max(0, 8 - (performance.now() - lastRun)));
  };
  const start = () => {
    new MutationObserver(request).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    sample();
  };
  if (document.documentElement) start(); else document.addEventListener('readystatechange', start, { once: true });
  setInterval(request, 100);
  window.__baseline = {
    log,
    read,
    // Every row node is marked: a row that was re-keyed leaves the document, and its replacement node is not marked.
    mark: () => { const nodes = [...document.querySelectorAll('.agent-timeline-entry')]; window.__baselineMarks = nodes; return nodes.length > 0; },
    markAlive: () => !!window.__baselineMarks?.length && window.__baselineMarks.every(node => node.isConnected),
    survivors: () => ({ total: window.__baselineMarks?.length ?? 0, alive: (window.__baselineMarks ?? []).filter(node => node.isConnected).length }),
    scroller: () => {
      for (let at = document.querySelector('.agent-timeline-entry')?.parentElement; at; at = at.parentElement) if (at.scrollHeight > at.clientHeight && /auto|scroll/.test(getComputedStyle(at).overflowY)) return at;
      return document.scrollingElement;
    },
    // A reader scrolling up: the wheel says so, which is what stops the timeline from following the latest content.
    scrollToMiddle: () => {
      const scroller = window.__baseline.scroller();
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
      scroller.scrollTop = Math.max(0, (scroller.scrollHeight - scroller.clientHeight) / 2);
      scroller.dispatchEvent(new Event('scroll'));
      return scroller.scrollTop;
    },
    // The first row in view and its offset from the top of the scroller.
    anchor: () => {
      const scroller = window.__baseline.scroller(), top = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
      const row = [...document.querySelectorAll('.agent-timeline-entry')].find(node => node.getBoundingClientRect().bottom > top + 1);
      return row ? { key: row.getAttribute('data-entry-key'), offset: Math.round((row.getBoundingClientRect().top - top) * 10) / 10 } : null;
    },
    offsetOf: key => {
      const scroller = window.__baseline.scroller(), top = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
      const row = [...document.querySelectorAll('.agent-timeline-entry')].find(node => node.getAttribute('data-entry-key') === key);
      return row ? Math.round((row.getBoundingClientRect().top - top) * 10) / 10 : null;
    },
    composer: () => {
      const editor = document.querySelector('[data-testid="prompt-input"]');
      if (!editor) return null;
      const selection = window.getSelection(), inside = !!selection?.anchorNode && editor.contains(selection.anchorNode);
      return { text: editor.textContent ?? '', focused: editor.contains(document.activeElement) || document.activeElement === editor, selectionStart: inside ? selection.anchorOffset : -1, selectionEnd: inside ? selection.focusOffset : -1 };
    },
    setHidden: hidden => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event(hidden ? 'blur' : 'focus'));
    },
  };
})();`;

const normalizePath = url => {
  const { pathname } = new URL(url);
  return pathname.replace(/^\/u\/[0-9a-f]{20,}/, '/u/:user').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ':id').replace(/\/assets\/.*/, '/assets/*');
};
const messageKind = payload => {
  try {
    const frame = JSON.parse(payload);
    return frame.message?.type ? `${frame.type}:${frame.message.type}` : frame.type ?? 'unknown';
  } catch { return 'binary-or-text'; }
};

/** One page with its observer, request log and WebSocket log; `capture()` returns everything since `reset()`. */
async function instrument(context) {
  const page = await context.newPage();
  page.setDefaultTimeout(actionMs);
  await page.addInitScript(observerSource);
  const http = [], sockets = [], frames = [], consoleErrors = [], consoleAll = [];
  // What says the stream was served from the Relay's journal: the item-key flag the stream echoed, and the epochs of its pages.
  const served = { itemKeysEchoed: false, pageEpochs: [] };
  const pending = new Map();
  page.on('request', request => pending.set(request, { t: Date.now(), method: request.method(), path: normalizePath(request.url()), type: request.resourceType() }));
  page.on('requestfinished', request => { const entry = pending.get(request); if (entry) { entry.ms = Date.now() - entry.t; http.push(entry); pending.delete(request); } });
  page.on('requestfailed', request => { const entry = pending.get(request); if (entry) { entry.ms = Date.now() - entry.t; entry.failed = true; http.push(entry); pending.delete(request); } });
  page.on('console', message => { consoleAll.push(`${message.type()}: ${message.text().slice(0, 300)}`); if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200)); });
  page.on('pageerror', error => consoleAll.push(`pageerror: ${String(error.message).slice(0, 300)}`));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Performance.enable');
  if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  cdp.on('Network.webSocketCreated', event => sockets.push({ t: Date.now(), id: event.requestId, event: 'created', path: normalizePath(event.url.replace(/^ws/, 'http')) }));
  cdp.on('Network.webSocketClosed', event => sockets.push({ t: Date.now(), id: event.requestId, event: 'closed' }));
  cdp.on('Network.webSocketFrameSent', event => frames.push({ t: Date.now(), id: event.requestId, dir: 'out', kind: messageKind(event.response.payloadData), bytes: event.response.payloadData.length }));
  cdp.on('Network.webSocketFrameReceived', event => {
    const entry = { t: Date.now(), id: event.requestId, dir: 'in', kind: messageKind(event.response.payloadData), bytes: event.response.payloadData.length };
    if (entry.kind.endsWith('timeline_page')) { entry.rows = timelineRows(event.response.payloadData); const epoch = pageEpoch(event.response.payloadData); if (epoch) served.pageEpochs.push(epoch); }
    if (entry.kind.endsWith('negotiated') && negotiatedItemKeys(event.response.payloadData)) served.itemKeysEchoed = true;
    frames.push(entry);
  });
  // Bytes of the HTTP responses of the API (not scripts, styles, fonts or images), as the browser received them.
  const apiTypes = new Map();
  let apiBytes = 0;
  cdp.on('Network.requestWillBeSent', event => apiTypes.set(event.requestId, event.type));
  cdp.on('Network.loadingFinished', event => { const type = apiTypes.get(event.requestId); apiTypes.delete(event.requestId); if (type === 'XHR' || type === 'Fetch') apiBytes += event.encodedDataLength; });
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]));
  return {
    page, cdp, metrics,
    reset() { http.length = 0; sockets.length = 0; frames.length = 0; consoleErrors.length = 0; pending.clear(); apiBytes = 0; served.itemKeysEchoed = false; served.pageEpochs.length = 0; },
    /** Observer log, requests and sockets since the last reset, with times relative to `start`. */
    async capture(start) {
      const log = await page.evaluate(() => window.__baseline?.log.slice() ?? []).catch(() => []);
      return {
        states: log.map(item => ({ ...item, t: item.t - start })),
        requests: summarizeRequests(http, sockets, frames, start),
        timelineReads: timelineReads(frames, start),
        apiBytes,
        itemKeysEchoed: served.itemKeysEchoed, pageEpochs: [...served.pageEpochs],
        consoleErrors: consoleErrors.slice(0, 5),
      };
    },
    clearLog: () => page.evaluate(() => { window.__baseline.log.length = 0; }),
    /** What a stalled open has seen: requests still pending and finished, WebSocket events and frames, and the console. */
    dump: () => ({ pending: [...pending.values()].map(entry => ({ ...entry, ageMs: Date.now() - entry.t })), http: http.slice(-40), sockets: sockets.slice(-20), frames: frames.slice(-40), console: consoleAll.slice(-40) }),
  };
}

const parseMessage = payloadData => { try { return JSON.parse(payloadData).message; } catch { return undefined; } };
const pageEpoch = payloadData => parseMessage(payloadData)?.payload?.epoch;
const negotiatedItemKeys = payloadData => parseMessage(payloadData)?.itemKeys === true;

/** Sizes of the rows of one timeline page: bytes per item type. */
function timelineRows(payloadData) {
  try {
    const rows = [], visit = value => {
      if (Array.isArray(value)) { for (const item of value) visit(item); return; }
      if (value && typeof value === 'object') {
        if (value.item && typeof value.item.type === 'string') { rows.push({ type: value.item.type, bytes: JSON.stringify(value).length }); return; }
        for (const child of Object.values(value)) visit(child);
      }
    };
    visit(JSON.parse(payloadData).message?.payload);
    const byType = {};
    for (const row of rows) { byType[row.type] ??= { rows: 0, bytes: 0, maxBytes: 0 }; byType[row.type].rows++; byType[row.type].bytes += row.bytes; byType[row.type].maxBytes = Math.max(byType[row.type].maxBytes, row.bytes); }
    return { rows: rows.length, byType };
  } catch { return undefined; }
}

/** Time between a timeline_request frame going out and its timeline_page coming back, per socket. */
function timelineReads(frames, start) {
  const reads = [];
  for (const out of frames.filter(frame => frame.dir === 'out' && frame.kind.endsWith('timeline_request'))) {
    const back = frames.find(frame => frame.dir === 'in' && frame.id === out.id && frame.kind.endsWith('timeline_page') && frame.t >= out.t);
    if (back) reads.push({ requestedAt: out.t - start, ms: back.t - out.t, bytes: back.bytes, rows: back.rows });
  }
  return reads;
}

function summarizeRequests(http, sockets, frames, start) {
  const count = (items, keyOf) => { const out = {}; for (const item of items) { const key = keyOf(item); out[key] = (out[key] ?? 0) + 1; } return out; };
  const inFrames = frames.filter(frame => frame.dir === 'in'), outFrames = frames.filter(frame => frame.dir === 'out');
  // The attach: the page's first request to take the session (the session control request on the channel; an HTTP attach on older paths).
  const attachFrame = outFrames.find(frame => frame.kind.endsWith('session_control_request'));
  const attachHttp = http.find(item => item.method === 'POST' && /\/attach$/.test(item.path));
  const attachAt = attachFrame?.t ?? attachHttp?.t;
  const apiHttp = http.filter(item => item.type !== 'script' && item.type !== 'stylesheet' && item.type !== 'font' && item.type !== 'image' && item.type !== 'document');
  return {
    firstAttachMs: attachAt === undefined ? null : attachAt - start,
    httpTotal: http.length,
    httpAssets: http.length - apiHttp.length,
    httpApi: apiHttp.length,
    httpByEndpoint: count(apiHttp, item => `${item.method} ${item.path}`),
    httpSlowest: apiHttp.sort((a, b) => b.ms - a.ms).slice(0, 5).map(item => ({ endpoint: `${item.method} ${item.path}`, startMs: item.t - start, ms: item.ms })),
    webSocketsCreated: sockets.filter(item => item.event === 'created').length,
    webSocketPaths: count(sockets.filter(item => item.event === 'created'), item => item.path),
    framesIn: inFrames.length, framesOut: outFrames.length,
    bytesIn: inFrames.reduce((sum, frame) => sum + frame.bytes, 0), bytesOut: outFrames.reduce((sum, frame) => sum + frame.bytes, 0),
    framesInByKind: count(inFrames, frame => frame.kind), framesOutByKind: count(outFrames, frame => frame.kind),
  };
}

// ---- reading the observer log ----
const isBlockingLabel = label => label !== 'Ready' && label !== 'Working' && label !== 'Waiting for response' && label !== 'Starting';
const stateSummary = (states, from, until) => {
  // Duration of each distinct label / loading / control text and each composer state between `from` and `until`.
  const spans = {};
  const end = until ?? states.at(-1)?.t ?? from;
  for (const [index, state] of states.entries()) {
    const next = states[index + 1]?.t ?? end;
    const begin = Math.max(state.t, from), stop = Math.min(next, end);
    if (stop <= begin && index < states.length - 1) continue;
    const keys = [...state.labels.map(label => `label: ${label}`), ...state.loading.map(text => `placeholder: ${text}`),
      ...state.control.map(text => `control: ${text}`), `composer: ${state.composer}`];
    if (!state.messages) keys.push('no messages in view');
    for (const key of keys) {
      const span = spans[key] ??= { firstMs: Math.round(begin - from), totalMs: 0 };
      span.totalMs += Math.max(0, Math.round(stop - begin));
    }
  }
  return spans;
};
const firstAt = (states, predicate) => states.find(predicate)?.t;
// Ready: the composer takes text and nothing blocks it. Since I3b a tile shows no status label at all (its sentence is the
// assistant's), so a build that shows one must show Ready.
const isReady = state => state.labels.every(label => label === 'Ready') && state.composer === 'enabled' && !state.loading.length && !state.control.length && state.messages > 0;
const isBlocked = state => state.composer === 'disabled' || state.labels.some(isBlockingLabel) || state.loading.length > 0 || state.control.length > 0;

async function waitForState(handle, predicate, label, ms = actionMs) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    const state = await handle.page.evaluate(() => window.__baseline.read()).catch(() => undefined);
    if (state && predicate(state)) return state;
    last = state;
    await delay(40);
  }
  throw new Error(`Deadline of ${ms} ms passed: ${label}; last state ${JSON.stringify(last)}`);
}

// T1 counts observed states (the observer records every change at 8 ms resolution) from the moment the conversation mounts: its
// first label, placeholder or message. They are counts, never clock thresholds.
// T1 counts its own subset of the T5 list, so its counts compare with the P0 baselines.
const OPENING_LABELS = ['Opening session', 'Loading conversation', 'Awaiting Agent', 'Start with a Provider'];
const showsOpening = state => [...state.labels, ...state.loading].some(text => OPENING_LABELS.some(label => text.includes(label)));
// S4b also counts the other connection words: since I1 every word of the T5 list (agent-e2e's connection-words.mjs).
const showsOpeningWord = state => [...state.labels, ...state.loading, ...state.control].some(text => SESSION_CONNECTION_PATTERN.test(text));
const openSummary = (capture, start) => {
  const content = firstAt(capture.states, state => state.messages > 0);
  const ready = firstAt(capture.states, isReady);
  const settledAt = ready ?? capture.states.at(-1)?.t ?? 0;
  const mounted = firstAt(capture.states, state => state.labels.length > 0 || state.loading.length > 0 || state.messages > 0);
  const sinceMount = mounted === undefined ? [] : capture.states.filter(state => state.t >= mounted && (ready === undefined || state.t <= ready));
  const attachMs = capture.requests.firstAttachMs;
  return {
    contentMs: content, readyMs: ready,
    mountMs: mounted ?? null,
    contentSinceMountMs: content !== undefined && mounted !== undefined ? content - mounted : null,
    contentSinceAttachMs: content !== undefined && attachMs !== null && attachMs !== undefined ? content - attachMs : null,
    openingLabelFrames: sinceMount.filter(showsOpening).length,
    openingWordFrames: sinceMount.filter(showsOpeningWord).length,
    rowlessFramesSinceMount: sinceMount.filter(state => state.entries === 0).length,
    blockedUntilMs: capture.states.filter(isBlocked).at(-1) ? (capture.states.filter(isBlocked).at(-1).t) : 0,
    states: stateSummary(capture.states, 0, settledAt),
    requests: capture.requests, apiBytes: capture.apiBytes, timelineReads: capture.timelineReads, consoleErrors: capture.consoleErrors,
    itemKeysEchoed: capture.itemKeysEchoed, pageEpochs: capture.pageEpochs,
  };
};

const clearDeviceStorage = async handle => {
  // Clear while no page of the origin is open: a live page keeps its IndexedDB connection and rewrites what was cleared.
  await handle.page.goto('about:blank');
  await handle.cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'local_storage,indexeddb,cache_storage,service_workers' });
};

/** Runs `body(context)` in one browser context and signs the context out afterwards. */
async function inContext(body) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  try { return await body(context); }
  finally {
    for (const open of context.pages()) await open.close().catch(() => {});
    await context.request.post(origin + '/auth/logout', { headers: { origin, 'content-type': 'application/json' }, data: '{}', timeout: 10_000 }).catch(() => {});
    await context.close().catch(() => {});
  }
}

/** The epoch and next sequence of the session's journal in the instance's journal store; null without a journal or for another signal. */
function journalMeta(session) {
  if (journalSignal !== 'meta') return null;
  try {
    const key = session.address.replace(/\//g, ':');
    const file = join(result.environment.build.directory, 'relay/relay/journals.sqlite');
    const chunks = execFileSync('sqlite3', ['-readonly', `file:${file}?mode=ro`, `select hex(bytes) from journal_chunks where session_key='${key}' and part='m' order by ordinal`], { encoding: 'utf8', timeout: 10_000 });
    return parseJournalMeta(chunks.split('\n').filter(Boolean));
  } catch { return null; }
}

async function openSample(handle, session, how) {
  handle.reset();
  await handle.clearLog().catch(() => {});
  const metaBefore = journalMeta(session);
  const start = Date.now();
  if (how === 'reload') await handle.page.reload({ waitUntil: 'domcontentloaded' });
  else await handle.page.goto(session.url, { waitUntil: 'domcontentloaded' });
  try { await waitForState(handle, isReady, `ready after ${how} of ${session.address}`); }
  catch (error) {
    const file = join(dirname(outFile), `stall-${label ?? 'run'}-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify({ error: String(error.message), session: session.address, how, state: await handle.page.evaluate(() => ({ url: location.href, body: document.body.innerText.slice(0, 400), log: window.__baseline?.log.slice(-8) })).catch(() => null), ...handle.dump() }, null, 1));
    throw new Error(`${error.message} (dump: ${file})`);
  }
  await delay(600); // trailing requests and states that follow ready
  const capture = await handle.capture(start);
  const summary = openSummary(capture, start);
  const served = journalServed({ signal: journalSignal, itemKeysEchoed: summary.itemKeysEchoed, pageEpochs: summary.pageEpochs, metaBefore, metaAfter: journalMeta(session) });
  return { address: session.address, provider: session.provider, startMs: start, endMs: Date.now(), journalServed: served, ...summary };
}

const summarizeOpen = samples => ({
  n: samples.length,
  contentMs: stats(samples.map(sample => sample.contentMs)), readyMs: stats(samples.map(sample => sample.readyMs)),
  contentSinceMountMs: stats(samples.map(sample => sample.contentSinceMountMs)), contentSinceAttachMs: stats(samples.map(sample => sample.contentSinceAttachMs)),
  openingLabelFrames: stats(samples.map(sample => sample.openingLabelFrames)), rowlessFramesSinceMount: stats(samples.map(sample => sample.rowlessFramesSinceMount)),
  httpApi: stats(samples.map(sample => sample.requests.httpApi)), webSockets: stats(samples.map(sample => sample.requests.webSocketsCreated)),
  framesIn: stats(samples.map(sample => sample.requests.framesIn)), framesOut: stats(samples.map(sample => sample.requests.framesOut)),
  bytesIn: stats(samples.map(sample => sample.requests.bytesIn)),
  stateDurations: Object.fromEntries(
    [...new Set(samples.flatMap(sample => Object.keys(sample.states)))].sort().map(key => {
      const present = samples.filter(sample => sample.states[key]);
      return [key, { seenIn: `${present.length}/${samples.length}`, firstMs: stats(present.map(sample => sample.states[key].firstMs)), totalMs: stats(present.map(sample => sample.states[key].totalMs)) }];
    })),
  byProvider: Object.fromEntries([...new Set(samples.map(sample => sample.provider))].map(provider => {
    const own = samples.filter(sample => sample.provider === provider);
    return [provider, { n: own.length, contentMs: stats(own.map(sample => sample.contentMs)), readyMs: stats(own.map(sample => sample.readyMs)) }];
  })),
});

const scenarios = {
  // T1: sessions this browser profile opened before. The first open of a session is discarded from the statistics.
  async 'open-known'() {
    return inContext(async context => {
      const handle = await instrument(context);
      const samples = [], firstOpens = [];
      for (const session of sessions) {
        firstOpens.push(await openSample(handle, session, 'goto'));
        for (let i = 0; i < reps; i++) samples.push(await openSample(handle, session, 'reload'));
      }
      // Navigating back to a session opened before: another session first, then this one by URL.
      const navigations = [];
      for (const session of sessions) {
        await handle.page.goto(sessions[(sessions.indexOf(session) + 1) % sessions.length].url, { waitUntil: 'domcontentloaded' });
        await waitForState(handle, isReady, 'ready of the other session');
        navigations.push(await openSample(handle, session, 'goto'));
      }
      return { method: 'Same context. Each session is opened once (discarded), then reloaded; "navigations" go to the session by URL from another session.',
        reload: summarizeOpen(samples), navigations: summarizeOpen(navigations), firstOpensInContext: summarizeOpen(firstOpens), samples, navigationSamples: navigations };
    });
  },
  // T1 after the cached lease ended: the stored lease's expiry is set to the past before each reload (what 120 s of waiting does), so the rows wait for the
  // Relay's answer. One extra sample really waits 125 s to show the two are the same.
  async 'open-known-expired'() {
    return inContext(async context => {
      const handle = await instrument(context);
      const expire = () => handle.page.evaluate(() => {
        const key = 'agent-remote:workspace-access', saved = JSON.parse(localStorage.getItem(key) ?? 'null');
        if (saved?.lease) { saved.lease.expiresAt = Date.now() - 1; localStorage.setItem(key, JSON.stringify(saved)); }
        return !!saved?.lease;
      });
      const samples = [];
      for (const session of sessions) {
        await openSample(handle, session, 'goto');
        for (let i = 0; i < reps; i++) { if (!(await expire())) throw new Error('No stored lease to expire.'); samples.push({ ...(await openSample(handle, session, 'reload')), expiredBy: 'edit' }); }
      }
      const waited = sessions[0];
      await openSample(handle, waited, 'goto');
      await delay(125_000);
      samples.push({ ...(await openSample(handle, waited, 'reload')), expiredBy: 'waiting' });
      return { method: 'Same context. Each session is opened once, then reloaded with its cached lease expired by editing the stored expiry; one reload after really waiting 125 s.', summary: summarizeOpen(samples), samples };
    });
  },
  // T2: device storage of the origin cleared before each open; the sign-in and the HTTP cache stay.
  async 'open-fresh'() {
    return inContext(async context => {
      const handle = await instrument(context);
      await handle.page.goto(origin + '/?mode=bot', { waitUntil: 'domcontentloaded' });
      const samples = [];
      for (let i = 0; i < reps; i++) for (const session of sessions) {
        await clearDeviceStorage(handle);
        samples.push(await openSample(handle, session, 'goto'));
      }
      return { method: 'Same context; localStorage, IndexedDB and cache storage of the origin are cleared before each open (the HTTP cache of scripts stays warm).', summary: summarizeOpen(samples), samples };
    });
  },
  // A completely new browser profile: new context, empty HTTP cache, new sign-in.
  async 'open-cold-context'() {
    const samples = [];
    for (const session of sessions.slice(0, Math.max(3, reps))) {
      samples.push(await inContext(async context => openSample(await instrument(context), session, 'goto')));
      await delay(5000); // sign-in budget
    }
    return { method: 'One new context (cold HTTP cache, new sign-in) per sample.', summary: summarizeOpen(samples), samples };
  },
  // A session whose runtime was released first (Codex releases a loaded runtime; Claude has none to release).
  async 'open-released'() {
    return inContext(async context => {
      const handle = await instrument(context);
      const samples = [];
      for (const session of releasable()) for (let i = 0; i < Math.min(reps, 3); i++) {
        const released = await releaseRuntime(session);
        samples.push({ released, ...(await openSample(handle, session, 'goto')) });
      }
      return { method: `Codex: one tiny turn, session release, wait ${releaseWaitMs} ms, goto the session URL in the same context. released says whether the Controller had a runtime to release (always false for Claude Code).`, summary: summarizeOpen(samples), samples };
    });
  },
  // T3 short: hidden for the short duration, a turn started from the command line meanwhile.
  'hidden-short': () => hiddenScenario(hiddenShortMs, false),
  // The sockets die while the page is hidden (the proxy closes every WebSocket): the return reopens them and every list refetches once. Recorded without a budget.
  'hidden-dead': () => hiddenScenario(hiddenShortMs, false, true),
  // T3 long: hidden and frozen (as Chromium does to a long hidden tab) for the long duration.
  'hidden-long': () => hiddenScenario(hiddenLongMs, true),
  async 'send-resident'() { return sendScenario(false); },
  async 'send-released'() { return sendScenario(true); },
  // T6: the open conversation across a runtime release.
  async 'release-continuity'() { return releaseContinuity(sessions, false); },
  // T6 for the sessions that read from the Relay's journal: the same release, with the windows the Relay recorded.
  async 'runtime-release'() { return releaseContinuity(sessionsOf('copilot'), true); },
  // T6: the open conversation across a Controller (and Relay) restart, `pnpm local up --no-build`. One page per restart: pages of one
  // user share their Window, so a second session page would switch the first. `--reps` restarts, the sessions in turn.
  async 'restart-continuity'() {
    const samples = [], steps = [];
    for (let rep = 0; rep < reps; rep++) {
      const session = sessions[rep % sessions.length];
      const start = await inContext(async context => {
        const [item] = await openMarked(context, [session]);
        await item.handle.clearLog(); item.handle.reset();
        const begin = Date.now();
        await restartInstance();
        item.readyAgainMs = await waitForState(item.handle, isReady, `ready after restart of ${session.address}`, 90_000).then(() => Date.now() - begin, () => null);
        await delay(1000);
        samples.push({ rep, ...(await settledRows(item, begin)), restartCommandMs: Date.now() - begin });
        return begin;
      });
      steps.push({ rep, fromMs: start, toMs: Date.now() });
      await delay(5000);
    }
    return { method: 'One page open on a session, every row node marked, `pnpm local up --no-build` (restarts the Controller and the Relay together), watch until ready; the sessions in turn, one restart per sample. rows.alive of rows.total marked nodes remain in the document; rowlessStates counts observer states that showed no rows after the first rows. journalServed per the journal signal.',
      label: options.label ?? null, samples, windowSteps: steps };
  },
  // T6: a forced replacement. A turn with a long tool runs in the Copilot session when the instance restarts, so the Controller's
  // window differs from the journal's open item and the Relay replaces the journal (reason `open_item`). The page holds a draft in its
  // composer and a scroll position; every row node is marked. One page per restart (see restart-continuity).
  async 'replacement-absorbed'() {
    const own = sessionsOf('copilot');
    const samples = [], steps = [];
    for (let rep = 0; rep < reps; rep++) {
      const session = own[rep % own.length];
      startLongTool(session);
      await approveToolAndWait(session);
      const start = await inContext(async context => {
        const [item] = await openMarked(context, [session], state => state.entries > 0 && !state.loading.length);
        await item.handle.page.evaluate(() => window.__baseline.scrollToMiddle());
        await item.handle.page.locator('[data-testid="prompt-input"]').click();
        await item.handle.page.keyboard.type(`draft ${rep}`);
        await delay(400);
        item.anchor = await item.handle.page.evaluate(() => window.__baseline.anchor());
        item.composerBefore = await item.handle.page.evaluate(() => window.__baseline.composer());
        await item.handle.clearLog(); item.handle.reset();
        const begin = Date.now();
        await restartInstance();
        item.readyAgainMs = await waitForState(item.handle, isReady, `ready after restart of ${session.address}`, 90_000).then(() => Date.now() - begin, () => null);
        await delay(1000);
        const sample = await settledRows(item, begin);
        const composerAfter = await item.handle.page.evaluate(() => window.__baseline.composer()).catch(() => null);
        const anchorOffset = item.anchor ? await item.handle.page.evaluate(key => window.__baseline.offsetOf(key), item.anchor.key).catch(() => null) : null;
        samples.push({ rep, ...sample, wheelIntent: true,
          composerUnchanged: !!composerAfter && !!item.composerBefore && composerUnchanged(item.composerBefore, composerAfter),
          composerBefore: item.composerBefore, composerAfter,
          anchorKey: item.anchor?.key ?? null, anchorSurvived: anchorOffset !== null, anchorShiftPx: anchorOffset !== null && item.anchor ? Math.abs(anchorOffset - item.anchor.offset) : null });
        return begin;
      });
      steps.push({ rep, fromMs: start, toMs: Date.now() });
      await delay(5000);
    }
    return { method: 'Per rep: a Copilot session runs a turn whose shell command takes two minutes (the runner answers its tool approval); one page holds it with every row node marked, a draft typed in the composer and the timeline scrolled to its middle; `pnpm local up --no-build` restarts the instance during the tool, so the Relay replaces the journal. replacementForced says the Relay recorded a `changed` or `open_item` window for the session; only those samples count.',
      label: options.label ?? null, samples, windowSteps: steps };
  },
  // S3: the opens of Copilot sessions, journal or Controller. Run it with smart reading on and off (`--label`), at throttle 1 and 4.
  async 'journal-open'() {
    const own = sessionsOf(journalProvider);
    const known = [], fresh = [];
    const startedAt = Date.now();
    await inContext(async context => {
      const handle = await instrument(context);
      for (const session of own) {
        await openSample(handle, session, 'goto'); // the first open of this browser profile is not counted
        for (let i = 0; i < reps; i++) known.push(await openSample(handle, session, 'reload'));
      }
      await handle.page.goto(origin + '/?mode=bot', { waitUntil: 'domcontentloaded' });
      for (let i = 0; i < reps; i++) for (const session of own) { await clearDeviceStorage(handle); fresh.push(await openSample(handle, session, 'goto')); }
    });
    const relay = await relayDiagnostics(startedAt);
    const attaches = controllerLog(startedAt);
    const describe = samples => samples.map(sample => describeOpen(sample, relay, attaches));
    const knownOpens = describe(known), freshOpens = describe(fresh);
    return { method: `${providerName[journalProvider]} sessions only. open-known: the first open is discarded, then reloads in the same context; open-fresh: device storage cleared before each goto. answeredBy is "controller" when a Controller session attach completed before the page showed its first message, otherwise "journal".`,
      label: options.label ?? null, sessions: own.map(item => item.address), known: openStats(knownOpens), fresh: openStats(freshOpens),
      firstOpenMisses: freshOpens.filter(sample => sample.answeredBy === 'controller').length, controllerEvents: controllerJournalEvents(controllerLog(startedAt), { fromMs: startedAt }),
      knownSamples: knownOpens, freshSamples: freshOpens };
  },
  // S3: one Copilot session, 30 reopens in a fixed order, with the Relay's windows and the hole check after each.
  async 'journal-reopen-mix'() {
    const session = sessionsOf(journalProvider)[0];
    // Reloads, releases, Controller restarts, interruptions, and turns (one with a tool) each followed by a release and a reload; Claude Code adds a compaction.
    const plan = [...Array(10).fill('reload'), ...Array(10).fill('release'), ...Array(5).fill('restart'), ...Array(5).fill('interruption'), ...Array(5).fill('turn'), ...(journalProvider === 'claude' ? ['compaction', 'reload'] : [])];
    const startedAt = Date.now();
    const steps = [];
    await inContext(async context => {
      let handle = await instrument(context);
      await handle.page.goto(session.url, { waitUntil: 'domcontentloaded' });
      await waitForState(handle, isReady, `ready ${session.address}`);
      for (const kind of plan) {
        const fromMs = Date.now();
        const sample = await reopenStep(handle, session, kind);
        const native = readNative(session.address);
        const served = await readServed(handle);
        steps.push({ kind, fromMs, toMs: Date.now(), sample, holes: holeCheck(native, served) });
      }
    });
    const relay = await relayDiagnostics(startedAt);
    const attaches = controllerLog(startedAt);
    const described = steps.map(step => ({ ...step, windows: windowCounts(relay, { fromMs: step.fromMs - 1000, toMs: step.toMs + 2000, agentId: `${journalProvider}:${session.address.split('/').at(-1)}` }), sample: describeOpen(step.sample, relay, attaches) }));
    return { method: 'One session of `--provider` (default copilot): 10 reloads, 10 releases then a reload, 5 Controller restarts (pnpm local up --no-build, with ARC_LOCAL_JOURNALS=1 exported) then a reload, 5 interruptions (a turn cancelled through session cancel, then a release and a reload), 5 turns with a tool (then a release and a reload); Claude Code adds a compaction and the open after it. After each: the Relay windows since the previous step, and a full native read compared with the messages the page shows after scrolling to the start (the hole check).',
      label: options.label ?? null, address: session.address, thresholds: mixThresholds(described), controllerEvents: controllerJournalEvents(controllerLog(startedAt), { fromMs: startedAt }),
      steps: described.map(({ kind, windows, holes, sample }) => ({ kind, windows, holes, answeredBy: sample.answeredBy, pageBytes: sample.pageBytes, readyMs: sample.readyMs })) };
  },
  // CLI latencies per provider: a command line floor, a history read, and the first send after a release.
  async 'provider-latency'() {
    const time = (...args) => { const start = Date.now(); const out = controller(...args); return [Date.now() - start, out]; };
    const out = {};
    for (const provider of releaseWaitMs > 5000 ? ['codex'] : ['claude', 'codex']) {
      const own = byProvider(provider); if (!own.length) continue;
      const rows = { floorListMs: [], readLimit0Ms: [], readLimit10Ms: [], readAfterReleaseMs: [], sendResidentMs: [], sendAfterReleaseMs: [], releaseMs: [], released: [] };
      for (let i = 0; i < Math.min(own.length * 2, releaseWaitMs > 5000 ? 2 : 4); i++) {
        const { address } = own[i % own.length];
        rows.floorListMs.push(time('session', 'list', '--limit', '1')[0]);
        rows.readLimit0Ms.push(time('session', 'read', address, '--limit', '0')[0]);
        rows.readLimit10Ms.push(time('session', 'read', address, '--limit', '10')[0]);
        await makeResident({ address, provider });
        const [releaseMs, released] = time('session', 'release', address); rows.releaseMs.push(releaseMs); rows.released.push(released.released);
        await delay(releaseWaitMs);
        rows.readAfterReleaseMs.push(time('session', 'read', address, '--limit', '10')[0]);
        rows.sendAfterReleaseMs.push(time('session', 'send', address, 'Reply with the single word OK.')[0]);
        await waitIdle(address);
        rows.sendResidentMs.push(time('session', 'send', address, 'Reply with the single word OK.')[0]);
        await waitIdle(address);
      }
      out[provider] = { ...Object.fromEntries(Object.entries(rows).filter(([key]) => key !== 'released').map(([key, values]) => [key, { values, ...stats(values) }])), released: rows.released };
    }
    return { method: `Wall time of one agent-remote-controller-dev process (includes about 250 to 370 ms of process start; floorListMs is that floor). A send returns when the Controller accepted it. After a release the run waits ${releaseWaitMs} ms; the first send after it is the wake.`, providers: out };
  },
  // Window and Bot switches with the existing runner, cold and warm.
  async switch() {
    // Asynchronously: the latency proxy lives in this process and must keep serving the browser of the subprocess.
    const run = async rate => JSON.parse((await execFileAsync(process.execPath, [join(root, 'packages/agent-remote-lab/performance/local-switch.mjs'), `baseline-${rate}x`],
      { cwd: root, encoding: 'utf8', env: { ...process.env, ARC_ORIGIN: origin, ...(rate > 1 ? { THROTTLE: String(rate) } : {}) }, timeout: 240_000 })).stdout);
    return { method: 'local-switch.mjs: Bot mode, click a bot row until its conversation shows entries; each bot twice (cold, then warm), with the HTTP API requests and the opening-label and row-less states of each switch.', throttle, switch: await run(throttle) };
  },
};

async function waitIdle(address, ms = 120_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const state = controller('session', 'read', address, '--limit', '0').session?.state;
    if (state === 'idle') return;
    // A turn that waits for a tool approval is answered, as the other scenarios answer theirs.
    if (state === 'waiting') {
      const request = controller('session', 'inspect', address).pendingInteractions?.[0];
      if (request?.kind === 'tool_approval') controller('session', 'answer', address, request.requestId, '--response', JSON.stringify({ kind: 'tool_approval', decision: 'allow', scope: request.allowScopes?.includes('session') ? 'session' : 'once' }));
    }
    await delay(1500);
  }
  throw new Error(`Deadline of ${ms} ms passed: ${address} did not become idle`);
}

// ---- journal measurements (S3) ----
/** What the Relay's diagnostics, delivered to the Controller's log, say since `sinceMs`; they arrive in batches about a second apart. */
async function relayDiagnostics(sinceMs) {
  await delay(4000);
  return controller('diagnostics', '--source', 'server', '--since', new Date(sinceMs).toISOString(), '--limit', '1000').server ?? [];
}
const controllerLog = sinceMs => controller('diagnostics', '--source', 'controller', '--since', new Date(sinceMs).toISOString(), '--limit', '1000').controller ?? [];

/** The newest-first entries of a full native read of the session, all pages. */
function readNative(address) {
  const entries = [];
  let cursor;
  for (let page = 0; page < 40; page++) {
    const read = controller('session', 'read', address, '--limit', '10', ...(cursor ? ['--cursor', cursor] : []));
    entries.push(...(read.entries ?? []));
    cursor = read.nextCursor;
    if (!cursor) break;
  }
  return entries;
}

/** The messages a page shows after it scrolled the conversation to its start until no older ones appeared. */
function readServed(handle) {
  return handle.page.evaluate(async () => {
    const scrollerOf = node => { for (let at = node?.parentElement; at; at = at.parentElement) if (at.scrollHeight > at.clientHeight && /auto|scroll/.test(getComputedStyle(at).overflowY)) return at; return document.scrollingElement; };
    const scroller = scrollerOf(document.querySelector('.agent-timeline-entry'));
    let last = -1;
    for (let round = 0; round < 60; round++) {
      // The page loads older history for a reader scrolling up, which only the wheel says; assigning scrollTop alone shows the window.
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
      scroller.scrollTop = 0;
      await new Promise(resolve => setTimeout(resolve, 400));
      const count = document.querySelectorAll('.agent-message').length;
      if (count === last) break;
      last = count;
    }
    return [...document.querySelectorAll('.agent-message')].map(node => node.textContent ?? '');
  });
}

const openStats = samples => ({
  n: samples.length, readyMs: stats(samples.map(sample => sample.readyMs)), contentMs: stats(samples.map(sample => sample.contentMs)),
  pageBytes: stats(samples.map(sample => sample.pageBytes)), windowBytes: stats(samples.flatMap(sample => sample.windows.bytes)),
  answeredBy: samples.reduce((counts, sample) => ({ ...counts, [sample.answeredBy]: (counts[sample.answeredBy] ?? 0) + 1 }), {}),
  windowReasons: samples.reduce((counts, sample) => { for (const [reason, count] of Object.entries(sample.windows.byReason)) counts[reason] = (counts[reason] ?? 0) + count; return counts; }, {}),
  requests: { fill: samples.reduce((sum, sample) => sum + sample.windows.requests.fill, 0), older: samples.reduce((sum, sample) => sum + sample.windows.requests.older, 0) },
});

/** An open with what the Relay did for it: which side answered, the windows of its session, and the bytes the page received. */
function describeOpen(sample, relay, controllerEntries) {
  const range = { fromMs: sample.startMs - 1000, toMs: sample.endMs + 2000 };
  const sessionKey = `${sample.provider}:${sample.address.split('/').at(-1)}`;
  return { ...sample, answeredBy: answeredBy(controllerEntries, { fromMs: sample.startMs, toMs: sample.startMs + (sample.contentMs ?? sample.endMs - sample.startMs) }),
    pageBytes: sample.requests.bytesIn + (sample.apiBytes ?? 0), windows: windowCounts(relay, { ...range, agentId: sessionKey }) };
}

/** The instance's sessions of one provider; the journal scenarios need at least one, made with a real model turn first. */
const sessionsOf = provider => {
  const own = byProvider(provider);
  if (!own.length) throw new Error(`The journal scenarios need a ${provider} session in the instance workspace; create one with a real model turn first.`);
  return own;
};
const providerName = { copilot: 'Copilot', claude: 'Claude Code', codex: 'Codex' };

async function restartInstance() {
  await new Promise((resolveRestart, reject) => {
    const child = spawn('pnpm', ['--silent', 'local', 'up', '--no-build'], { cwd: root, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Restart took longer than 180 s')); }, 180_000);
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolveRestart() : reject(new Error(`up exited with ${code}`)); });
  });
}

/** One step of the mix: what makes the Controller open the session's journal again, then a reload that reads it. */
async function reopenStep(handle, session, kind) {
  if (kind === 'release') { controller('session', 'release', session.address); await delay(releaseWaitMs); }
  if (kind === 'restart') { await restartInstance(); await waitForState(handle, isReady, 'ready after restart', 90_000).catch(() => undefined); }
  if (kind === 'interruption') {
    controller('session', 'send', session.address, 'Write the numbers from 1 to 400, one per line, with a sentence about each.');
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && controller('session', 'read', session.address, '--limit', '0').session?.state !== 'running') await delay(500);
    await delay(1500);
    controller('session', 'cancel', session.address);
    await waitIdle(session.address);
    controller('session', 'release', session.address); await delay(releaseWaitMs);
  }
  if (kind === 'turn') {
    controller('session', 'send', session.address, 'Run the shell command `echo journal-mix` and then reply with the single word OK.');
    await waitIdle(session.address);
    controller('session', 'release', session.address); await delay(releaseWaitMs);
  }
  if (kind === 'compaction') {
    controller('session', 'send', session.address, '/compact');
    await waitIdle(session.address);
    controller('session', 'release', session.address); await delay(releaseWaitMs);
  }
  return openSample(handle, session, 'reload');
}

/** Opens each session in its own page of one context, waits until it shows rows, marks every row node and records how it was served. */
async function openMarked(context, list, ready = isReady) {
  const opened = [];
  for (const session of list) {
    const handle = await instrument(context);
    const metaBefore = journalMeta(session);
    await handle.page.goto(session.url, { waitUntil: 'domcontentloaded' });
    await waitForState(handle, ready, `ready ${session.address}`);
    await delay(600);
    const capture = await handle.capture(Date.now());
    const served = journalServed({ signal: journalSignal, itemKeysEchoed: capture.itemKeysEchoed, pageEpochs: capture.pageEpochs, metaBefore, metaAfter: journalMeta(session) });
    await handle.page.evaluate(() => window.__baseline.mark());
    opened.push({ session, handle, served });
  }
  return opened;
}

/** What an opened page shows after the action that began at `start`: survivors of the marked rows, states without rows, composer states. */
async function settledRows(item, start) {
  const capture = await item.handle.capture(start);
  return { address: item.session.address, provider: item.session.provider, journalServed: item.served, readyAgainMs: item.readyAgainMs ?? null,
    rows: await item.handle.page.evaluate(() => window.__baseline.survivors()).catch(() => undefined),
    rowlessStates: rowlessStates(capture.states), composerDisabledStates: capture.states.filter(state => state.composer === 'disabled').length,
    minEntries: capture.states.length ? Math.min(...capture.states.map(state => state.entries)) : null,
    states: stateSummary(capture.states, 0), requests: capture.requests, consoleErrors: capture.consoleErrors };
}

/**
 * Adds the Relay's windows to the samples of the scenarios that recorded `windowSteps` (`{ rep, fromMs, toMs }` per sample), once for
 * the whole run: the Relay's diagnostics reach the Controller's log in batches, so they are read after the last scenario. A sample
 * gets the windows of its session by reason, and `replacementForced` when the Relay replaced its journal.
 */
async function attachWindows() {
  const withSteps = Object.values(result.scenarios).filter(scenario => scenario.windowSteps);
  if (!withSteps.length) return;
  const relay = await relayDiagnostics(Date.parse(result.startedAt));
  for (const scenario of withSteps) {
    for (const sample of scenario.samples ?? []) {
      const step = scenario.windowSteps.find(item => item.rep === sample.rep);
      if (!step) continue;
      sample.windows = windowCounts(relay, { fromMs: step.fromMs - 1000, toMs: step.toMs + 5000, agentId: `${sample.provider}:${sample.address.split('/').at(-1)}` });
      sample.replacementForced = (sample.windows.byReason.open_item ?? 0) + (sample.windows.byReason.changed ?? 0) > 0;
    }
  }
}

/** T6: every session open in its own page with its rows marked, its runtime released, and what the pages kept. */
async function releaseContinuity(list, withWindows) {
  const samples = [], steps = [];
  await inContext(async context => {
    for (const session of list) {
      await makeResident(session);
      const [item] = await openMarked(context, [session]);
      await item.handle.clearLog(); item.handle.reset();
      const start = Date.now();
      const released = controller('session', 'release', session.address).released;
      await delay(Math.max(15_000, releaseWaitMs + 15_000));
      const alive = await item.handle.page.evaluate(() => window.__baseline.markAlive());
      const sample = await settledRows(item, start);
      samples.push({ rep: samples.length, ...sample, released, markedEntryStillInDocument: alive, stateLog: (await item.handle.capture(start)).states.slice(0, 40) });
      steps.push({ rep: samples.length - 1, fromMs: start, toMs: Date.now() });
      await item.handle.page.close();
    }
  });
  return { method: 'Open the conversation, mark every row node, release the runtime, watch at least 15 s (release wait plus 15 s) without acting. Codex gets one tiny turn first, so there is a runtime to release. released says whether the Controller had one (always false for Claude Code and Copilot).',
    label: options.label ?? null, samples, ...(withWindows ? { windowSteps: steps } : {}) };
}

const LONG_TOOL_PROMPT = 'Run this exact shell command and wait for it to finish: for i in $(seq 1 12); do echo line-$i; sleep 5; done. Then reply with the single word DONE.';
const startLongTool = session => { controller('session', 'send', session.address, LONG_TOOL_PROMPT); };
/** Answers the tool approval of a session that was just sent the long-tool prompt, then waits until the tool runs. */
async function approveToolAndWait(session) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const inspected = controller('session', 'inspect', session.address);
    const request = inspected.pendingInteractions?.find(item => item.kind === 'tool_approval');
    if (request) { controller('session', 'answer', session.address, request.requestId, '--response', JSON.stringify({ kind: 'tool_approval', decision: 'allow', scope: 'once' })); break; }
    await delay(1000);
  }
  while (Date.now() < deadline) {
    if (controller('session', 'read', session.address, '--limit', '0').session?.state === 'running') { await delay(2000); return; }
    await delay(1000);
  }
  throw new Error(`The long tool of ${session.address} did not start`);
}

async function hiddenScenario(hiddenMs, freeze, closeSockets = false) {
  if (closeSockets && !proxy) throw new Error('hidden-dead needs the latency proxy: pass --rtt.');
  return inContext(async context => {
    const samples = [];
    // One session of each provider the instance has.
    const targets = [...new Set(sessions.map(item => item.provider))].map(provider => byProvider(provider)[0]);
    for (let i = 0; i < Math.max(1, reps - (freeze ? 1 : 0)); i++) for (const session of targets) {
      const handle = await instrument(context);
      const metaBefore = journalMeta(session);
      await handle.page.goto(session.url, { waitUntil: 'domcontentloaded' });
      await waitForState(handle, isReady, `ready ${session.address}`);
      // Whether the session is read from the Relay's journal is known from this open: a return opens no new stream.
      const opened = await handle.capture(Date.now());
      const served = journalServed({ signal: journalSignal, itemKeysEchoed: opened.itemKeysEchoed, pageEpochs: opened.pageEpochs, metaBefore, metaAfter: journalMeta(session) });
      // The page finishes its own start (attach, lists) a few round trips after it is ready; hiding earlier leaves that work to run on return.
      await delay(1500 + 12 * rttMs);
      const before = (await handle.page.evaluate(() => window.__baseline.read())).assistant;
      await handle.page.evaluate(() => window.__baseline.setHidden(true));
      if (closeSockets) proxy.closeWebSockets();
      const cdp = freeze ? handle.cdp : undefined;
      if (cdp) await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
      await delay(Math.min(3000, hiddenMs / 4));
      controller('session', 'send', session.address, 'Reply with the single word OK.');
      await delay(hiddenMs - Math.min(3000, hiddenMs / 4));
      await waitIdle(session.address);
      handle.reset(); await handle.clearLog().catch(() => {});
      const start = Date.now();
      if (cdp) await cdp.send('Page.setWebLifecycleState', { state: 'active' });
      await handle.page.evaluate(() => window.__baseline.setHidden(false));
      const afterRead = await handle.page.evaluate(() => window.__baseline.read());
      const alreadyCurrent = afterRead.assistant > before;
      let currentMs = null, readyMs = null;
      const deadline = Date.now() + actionMs;
      while (Date.now() < deadline && (currentMs === null || readyMs === null)) {
        const state = await handle.page.evaluate(() => window.__baseline.read());
        if (currentMs === null && state.assistant > before) currentMs = Date.now() - start;
        if (readyMs === null && isReady(state)) readyMs = Date.now() - start;
        await delay(25);
      }
      await delay(600);
      const capture = await handle.capture(start);
      const blocking = stateSummary(capture.states, 0, Math.max(readyMs ?? 0, currentMs ?? 0, 1));
      samples.push({ address: session.address, provider: session.provider, hiddenMs, frozen: freeze, socketsClosed: closeSockets, alreadyCurrentOnReturn: alreadyCurrent,
        journalServed: served,
        openingLabelFrames: capture.states.filter(showsOpening).length, openingWordFrames: capture.states.filter(showsOpeningWord).length,
        rowlessFrames: capture.states.filter(state => state.entries === 0).length,
        currentMs, readyMs, blockingStates: Object.fromEntries(Object.entries(blocking).filter(([key]) => /placeholder|control|composer: disabled|no messages|label: (?!Ready|Working)/.test(key))),
        requests: capture.requests, consoleErrors: capture.consoleErrors });
      await handle.page.close();
    }
    return { method: `The page's visibility is set to hidden${freeze ? ' and its lifecycle frozen' : ''} for ${hiddenMs} ms; a turn is sent from the command line meanwhile; "return" starts when it is shown again. currentMs: new assistant message in the page; readyMs: label Ready and composer enabled.`,
      summary: { n: samples.length, currentMs: stats(samples.map(sample => sample.currentMs)), readyMs: stats(samples.map(sample => sample.readyMs)),
        httpApi: stats(samples.map(sample => sample.requests.httpApi)), webSockets: stats(samples.map(sample => sample.requests.webSocketsCreated)) }, samples };
  });
}

async function sendScenario(released) {
  return inContext(async context => {
    const samples = [];
    for (const session of released ? releasable() : sessions) for (let i = 0; i < Math.min(reps, 2); i++) {
      let wasReleased = null;
      if (released) wasReleased = await releaseRuntime(session); else await makeResident(session);
      const handle = await instrument(context);
      await handle.page.goto(session.url, { waitUntil: 'domcontentloaded' });
      await waitForState(handle, isReady, `ready ${session.address}`);
      const marker = `OK-${Date.now() % 100000}`;
      const editor = handle.page.locator('[data-testid="prompt-input"]');
      await editor.click();
      await handle.page.keyboard.type(`Reply with the single word ${marker} and nothing else.`);
      handle.reset(); await handle.clearLog();
      const before = await handle.page.evaluate(() => window.__baseline.read());
      const processBefore = await handle.metrics();
      const start = Date.now();
      await handle.page.keyboard.press('Enter');
      // Accepted: the message is in the conversation with no pending delivery state and the session works or is ready.
      let acceptedMs = null, finishedMs = null;
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline && finishedMs === null) {
        const state = await handle.page.evaluate(() => window.__baseline.read());
        const pending = state.delivery.some(value => value !== 'confirmed' && value !== 'delivered');
        if (acceptedMs === null && state.messages > before.messages && !pending) acceptedMs = Date.now() - start;
        if (state.assistant > before.assistant && state.labels.includes('Ready') && Date.now() - start > 1500) finishedMs = Date.now() - start;
        await delay(20);
      }
      const capture = await handle.capture(start);
      const sendingShown = firstAt(capture.states, state => state.delivery.length > 0 || state.messages > before.messages);
      const disabled = capture.states.filter(state => state.composer === 'disabled');
      const working = firstAt(capture.states, state => state.labels.some(label => label === 'Working' || label === 'Waiting for response'));
      samples.push({ address: session.address, provider: session.provider, released: released ? wasReleased : false, composerBeforeEnter: before.composer,
        sendingShownMs: sendingShown ?? null, acceptedMs, workingLabelMs: working ?? null, turnFinishedMs: finishedMs,
        composerDisabledStates: disabled.length, deliveryStatesSeen: [...new Set(capture.states.flatMap(state => state.delivery))],
        states: stateSummary(capture.states, 0, finishedMs ?? undefined), requests: capture.requests, streamingFrames: streamRates(capture, start, finishedMs),
        taskMsDuringTurn: Math.round(((await handle.metrics()).TaskDuration - processBefore.TaskDuration) * 1000), consoleErrors: capture.consoleErrors });
      await handle.page.close();
    }
    return { method: 'Type a tiny prompt, press Enter. start = Enter. sendingShownMs: first delivery state or new message in the page; acceptedMs: the new message with no pending delivery state; turnFinishedMs: assistant reply and Ready.' + (released ? ` The runtime is released ${releaseWaitMs} ms before the page opens (Codex only; Claude Code has none to release).` : ' Codex gets one tiny turn just before, so its runtime is loaded.'),
      summary: { n: samples.length, sendingShownMs: stats(samples.map(sample => sample.sendingShownMs)), acceptedMs: stats(samples.map(sample => sample.acceptedMs)), turnFinishedMs: stats(samples.map(sample => sample.turnFinishedMs)),
        byProvider: Object.fromEntries([...new Set(samples.map(sample => sample.provider))].map(provider => { const own = samples.filter(sample => sample.provider === provider); return [provider, { n: own.length, acceptedMs: stats(own.map(sample => sample.acceptedMs)) }]; })) }, samples };
  });
}

/** Frames per second while a turn streams, by kind. */
function streamRates(capture, start, finishedMs) {
  const seconds = Math.max(0.001, (finishedMs ?? 1000) / 1000);
  return { seconds: Math.round(seconds * 10) / 10, framesIn: capture.requests.framesIn, framesInPerSecond: Math.round(capture.requests.framesIn / seconds * 10) / 10, byKind: capture.requests.framesInByKind, bytesIn: capture.requests.bytesIn };
}

try {
  for (const name of wanted) {
    if (!scenarios[name]) throw new Error(`Unknown scenario ${name}`);
    console.error(`scenario ${name} ...`);
    const started = Date.now();
    try { result.scenarios[name] = { ranMs: 0, ...(await withDeadline(scenarios[name](), name === 'hidden-long' ? hiddenLongMs * 4 + 600_000 : 900_000, `scenario ${name}`)) }; }
    catch (error) { result.scenarios[name] = { error: String(error.message ?? error).slice(0, 500) }; console.error(`  failed: ${error.message}`); }
    result.scenarios[name].ranMs = Date.now() - started;
    save();
    await delay(3000); // sign-in budget between scenarios
  }
  await attachWindows();
} finally {
  clearTimeout(outer);
  result.finishedAt = new Date().toISOString();
  if (proxy) {
    result.proxy = { rttMs, ...proxy.counts };
    // A page that bypassed the proxy would make every latency number a loopback number.
    if (!proxy.counts.webSocketsCrossed) result.invalid = 'No WebSocket crossed the latency proxy; these numbers are not latency numbers.';
    await proxy.close();
  }
  save();
  await browser.close();
}
console.log(outFile);
process.exit(0);
