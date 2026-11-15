// P0 baselines of the browser experience on the `pnpm local` instance (see README.md and
// docs/superpowers/plans/2026-11-15-p0-baselines.md). Run from the repository root while the instance runs:
//   node packages/agent-remote-lab/performance/local-baselines.mjs --scenarios open-known,open-fresh --out .tmp/p0.json
// Options:
//   --origin URL          the instance origin (default: `pnpm --silent local status --json`, which signs in once)
//   --scenarios a,b,c     open-known, open-fresh, open-cold-context, open-released, hidden-short, hidden-long,
//                         send-resident, send-released, release-continuity, restart-continuity, provider-latency, switch
//   --reps N              samples per session (default 3)
//   --throttle N          CPU slowdown factor (default 1)
//   --sessions A,B        session addresses (default: every session `session list` shows in the instance workspace)
//   --release-wait MS     how long to wait after a release before acting (default 1500; Codex unloads a released
//                         thread about a minute later, so 75000 measures a real wake; only Codex sessions run then)
//   --hidden-short MS / --hidden-long MS   hidden durations (default 30000 / 300000)
//   --deadline MS         outer deadline for the whole run (default 1500000)
//   --action MS           deadline of one action (default 30000)
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
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

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
const wanted = (options.scenarios ?? 'open-known,open-fresh,open-released,hidden-short,send-resident,send-released,release-continuity,provider-latency,switch').split(',');
const origin = options.origin ?? JSON.parse(execFileSync('pnpm', ['--silent', 'local', 'status', '--json'], { cwd: root, encoding: 'utf8' })).origin;
const { chromium } = createRequire(join(root, 'packages/agent-remote-lab/package.json'))('@playwright/test');

const controller = (...args) => JSON.parse(execFileSync('agent-remote-controller-dev', args, { cwd: root, encoding: 'utf8', timeout: 180_000 }));
const sessions = (options.sessions ? options.sessions.split(',') : controller('session', 'list', '--limit', '50').sessions.map(item => item.address))
  .map(address => ({ address, provider: address.split('/')[1], url: controller('session', 'link', address).url }));
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

const result = { startedAt: new Date().toISOString(), origin, options: { reps, throttle, hiddenShortMs, hiddenLongMs, scenarios: wanted },
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

// ---- statistics ----
const pct = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] * 10) / 10;
};
const stats = values => ({ n: values.filter(Number.isFinite).length, p50: pct(values, 0.5), p95: pct(values, 0.95), max: pct(values, 1) });
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
    mark: () => { const node = document.querySelector('.agent-timeline-entry'); window.__baselineMark = node; return !!node; },
    markAlive: () => !!window.__baselineMark && window.__baselineMark.isConnected,
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
  const http = [], sockets = [], frames = [], consoleErrors = [];
  const pending = new Map();
  page.on('request', request => pending.set(request, { t: Date.now(), method: request.method(), path: normalizePath(request.url()), type: request.resourceType() }));
  page.on('requestfinished', request => { const entry = pending.get(request); if (entry) { entry.ms = Date.now() - entry.t; http.push(entry); pending.delete(request); } });
  page.on('requestfailed', request => { const entry = pending.get(request); if (entry) { entry.ms = Date.now() - entry.t; entry.failed = true; http.push(entry); pending.delete(request); } });
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200)); });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Performance.enable');
  if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  cdp.on('Network.webSocketCreated', event => sockets.push({ t: Date.now(), id: event.requestId, event: 'created', path: normalizePath(event.url.replace(/^ws/, 'http')) }));
  cdp.on('Network.webSocketClosed', event => sockets.push({ t: Date.now(), id: event.requestId, event: 'closed' }));
  cdp.on('Network.webSocketFrameSent', event => frames.push({ t: Date.now(), id: event.requestId, dir: 'out', kind: messageKind(event.response.payloadData), bytes: event.response.payloadData.length }));
  cdp.on('Network.webSocketFrameReceived', event => {
    const entry = { t: Date.now(), id: event.requestId, dir: 'in', kind: messageKind(event.response.payloadData), bytes: event.response.payloadData.length };
    if (entry.kind.endsWith('timeline_page')) entry.rows = timelineRows(event.response.payloadData);
    frames.push(entry);
  });
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]));
  return {
    page, cdp, metrics,
    reset() { http.length = 0; sockets.length = 0; frames.length = 0; consoleErrors.length = 0; pending.clear(); },
    /** Observer log, requests and sockets since the last reset, with times relative to `start`. */
    async capture(start) {
      const log = await page.evaluate(() => window.__baseline?.log.slice() ?? []).catch(() => []);
      return {
        states: log.map(item => ({ ...item, t: item.t - start })),
        requests: summarizeRequests(http, sockets, frames, start),
        timelineReads: timelineReads(frames, start),
        consoleErrors: consoleErrors.slice(0, 5),
      };
    },
    clearLog: () => page.evaluate(() => { window.__baseline.log.length = 0; }),
  };
}

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
  const apiHttp = http.filter(item => item.type !== 'script' && item.type !== 'stylesheet' && item.type !== 'font' && item.type !== 'image' && item.type !== 'document');
  return {
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
const isReady = state => state.labels.includes('Ready') && state.composer === 'enabled' && !state.loading.length && !state.control.length && state.messages > 0;
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

const openSummary = (capture, start) => {
  const content = firstAt(capture.states, state => state.messages > 0);
  const ready = firstAt(capture.states, isReady);
  const settledAt = ready ?? capture.states.at(-1)?.t ?? 0;
  return {
    contentMs: content, readyMs: ready,
    blockedUntilMs: capture.states.filter(isBlocked).at(-1) ? (capture.states.filter(isBlocked).at(-1).t) : 0,
    states: stateSummary(capture.states, 0, settledAt),
    requests: capture.requests, timelineReads: capture.timelineReads, consoleErrors: capture.consoleErrors,
  };
};

const clearDeviceStorage = async handle => {
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

async function openSample(handle, session, how) {
  handle.reset();
  await handle.clearLog().catch(() => {});
  const start = Date.now();
  if (how === 'reload') await handle.page.reload({ waitUntil: 'domcontentloaded' });
  else await handle.page.goto(session.url, { waitUntil: 'domcontentloaded' });
  await waitForState(handle, isReady, `ready after ${how} of ${session.address}`);
  await delay(600); // trailing requests and states that follow ready
  const capture = await handle.capture(start);
  return { address: session.address, provider: session.provider, ...openSummary(capture, start) };
}

const summarizeOpen = samples => ({
  n: samples.length,
  contentMs: stats(samples.map(sample => sample.contentMs)), readyMs: stats(samples.map(sample => sample.readyMs)),
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
  // T3 long: hidden and frozen (as Chromium does to a long hidden tab) for the long duration.
  'hidden-long': () => hiddenScenario(hiddenLongMs, true),
  async 'send-resident'() { return sendScenario(false); },
  async 'send-released'() { return sendScenario(true); },
  // T6: the open conversation across a runtime release.
  async 'release-continuity'() {
    return inContext(async context => {
      const samples = [];
      for (const session of sessions) {
        await makeResident(session);
        const handle = await instrument(context);
        await handle.page.goto(session.url, { waitUntil: 'domcontentloaded' });
        await waitForState(handle, isReady, `ready ${session.address}`);
        await handle.page.evaluate(() => window.__baseline.mark());
        await handle.clearLog(); handle.reset();
        const start = Date.now();
        const released = controller('session', 'release', session.address).released;
        await delay(Math.max(15_000, releaseWaitMs + 15_000));
        const alive = await handle.page.evaluate(() => window.__baseline.markAlive());
        const capture = await handle.capture(start);
        samples.push({ address: session.address, provider: session.provider, released, markedEntryStillInDocument: alive,
          minMessagesAfterRelease: capture.states.length ? Math.min(...capture.states.map(state => state.messages)) : (await handle.page.evaluate(() => window.__baseline.read())).messages, blankMoments: capture.states.filter(state => !state.messages).length,
          stateChanges: capture.states.length, states: stateSummary(capture.states, 0, 15_000), stateLog: capture.states.slice(0, 40), requests: capture.requests });
        await handle.page.close();
      }
      return { method: 'Open the conversation, mark its first entry node, release the runtime, watch at least 15 s (release wait plus 15 s) without acting. Codex gets one tiny turn first, so there is a runtime to release.', samples };
    });
  },
  // T6: the open conversation across a Controller (and Relay) restart, `pnpm local up --no-build`.
  async 'restart-continuity'() {
    const samples = [];
    for (const session of [byProvider('claude')[0], byProvider('codex')[0]].filter(Boolean)) {
      samples.push(await inContext(async context => {
        const handle = await instrument(context);
        await handle.page.goto(session.url, { waitUntil: 'domcontentloaded' });
        await waitForState(handle, isReady, `ready ${session.address}`);
        await handle.page.evaluate(() => window.__baseline.mark());
        await handle.clearLog(); handle.reset();
        const start = Date.now();
        await new Promise((resolveRestart, reject) => {
          const child = spawn('pnpm', ['--silent', 'local', 'up', '--no-build'], { cwd: root, stdio: 'ignore' });
          const timer = setTimeout(() => { child.kill(); reject(new Error('Restart took longer than 180 s')); }, 180_000);
          child.on('exit', code => { clearTimeout(timer); code === 0 ? resolveRestart() : reject(new Error(`up exited with ${code}`)); });
        });
        const restartedMs = Date.now() - start;
        let readyAgainMs;
        try { await waitForState(handle, isReady, 'ready after restart', 90_000); readyAgainMs = Date.now() - start; } catch { /* reported as null */ }
        await delay(1000);
        const alive = await handle.page.evaluate(() => window.__baseline.markAlive()).catch(() => undefined);
        const capture = await handle.capture(start);
        return { address: session.address, provider: session.provider, restartCommandMs: restartedMs, readyAgainMs: readyAgainMs ?? null,
          markedEntryStillInDocument: alive, minMessagesAfterRestart: capture.states.length ? Math.min(...capture.states.map(state => state.messages)) : null,
          blankMoments: capture.states.filter(state => !state.messages).length, states: stateSummary(capture.states, 0), requests: capture.requests, stateLog: capture.states.slice(0, 60) };
      }));
      await delay(5000);
    }
    return { method: 'Open the conversation, mark its first entry node, run `pnpm local up --no-build` (restarts the Controller and the Relay together), watch until ready.', samples };
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
    const run = rate => JSON.parse(execFileSync(process.execPath, [join(root, 'packages/agent-remote-lab/performance/local-switch.mjs'), `baseline-${rate}x`],
      { cwd: root, encoding: 'utf8', env: { ...process.env, ...(rate > 1 ? { THROTTLE: String(rate) } : {}) }, timeout: 240_000 }));
    return { method: 'local-switch.mjs: Bot mode, click a bot row until its conversation shows entries; each bot twice (cold, then warm).', normal: run(1), throttled4x: run(4) };
  },
};

async function waitIdle(address, ms = 120_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const state = controller('session', 'read', address, '--limit', '0').session?.state;
    if (state === 'idle') return;
    await delay(1500);
  }
  throw new Error(`Deadline of ${ms} ms passed: ${address} did not become idle`);
}

async function hiddenScenario(hiddenMs, freeze) {
  return inContext(async context => {
    const samples = [];
    const targets = [byProvider('claude')[0], byProvider('codex')[0]].filter(Boolean);
    for (let i = 0; i < Math.max(1, reps - (freeze ? 1 : 0)); i++) for (const session of targets) {
      const handle = await instrument(context);
      await handle.page.goto(session.url, { waitUntil: 'domcontentloaded' });
      await waitForState(handle, isReady, `ready ${session.address}`);
      const before = (await handle.page.evaluate(() => window.__baseline.read())).assistant;
      await handle.page.evaluate(() => window.__baseline.setHidden(true));
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
      samples.push({ address: session.address, provider: session.provider, hiddenMs, frozen: freeze, alreadyCurrentOnReturn: alreadyCurrent,
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
} finally {
  clearTimeout(outer);
  result.finishedAt = new Date().toISOString();
  save();
  await browser.close();
}
console.log(outFile);
process.exit(0);
