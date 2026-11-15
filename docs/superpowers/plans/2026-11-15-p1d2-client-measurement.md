# P1-D Client measurement and verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure T1, T2 and T6 of the IM session service against the P0 baselines under 4x CPU slowdown and a 100 ms emulated round trip, with today's path as the control group, and verify the device store on the local instance. The runner gains a delaying proxy in front of the instance (so WebSocket frames are delayed, not only HTTP), counted T1 and T6 measures, and a T2 measure that starts at the first `attach` request. While the Host is offline, the Relay answers the `attach` of a journal-served, already bound session from its binding, so such a conversation opens from its journal. Online opens still attach through the Controller, as today.

**Architecture:** `latency-proxy.mjs` is a small Node proxy that delays every HTTP exchange and every WebSocket byte by half a round trip each way and rewrites the origin so the instance's own checks still pass. `local-baselines.mjs` starts it when given `--rtt` and adds the counted measures to its open scenarios. `summarize-p1d.mjs` turns three arms (control, crude, smart) and four conditions into tables and a verdict per target. One hosted broker change (Task 3) lets a journal-served session open while its Host is offline.

**Tech Stack:** Node (the runner is plain `.mjs` and runs on the default Node), `node:test` for the proxy, Playwright Chromium through the lab package, TypeScript and Vitest for the Relay change, `pnpm local`.

**Design reference:** `docs/superpowers/specs/2026-11-15-im-session-service-design.md` (Experience targets, Measurement and testing) and `docs/superpowers/plans/2026-11-15-p0-baselines.md` ("Where the time goes", "Targets", "Re-running"). Roadmap notes: "P1-D: measure under latency, against the same runner". The first plan, `2026-11-15-p1d-client-device-store.md`, must have landed completely.

**Order and dependencies.**

- Tasks 1 and 2 need nothing else. Task 4 verifies the device store on the local instance's crude path and needs only the first plan.
- Task 3 changes the hosted broker's attach and **depends on P1-B3a Task 6** (the switch and the gate): it uses `journalSessions.serves(hostId, providerId, sessionKey)` as that task leaves it. Run it after that task has landed.
- Task 5, the final task, **depends on P1-B3a** (local journals with `ARC_LOCAL_JOURNALS=1`, the per-provider smart-reading switch) **and on P1-C2's first journal-capable provider** (P1-C1's publisher exists, and a provider declares `journal: { itemIdentity: 1 }`, so the development Controller publishes that provider's journals). It is last because the smart arm cannot exist before both. Until then the crude arm and the control arm can be measured with Tasks 1, 2 and 4.

**Commands.** Every command has a deadline: tests carry `--testTimeout` or `--test-timeout`, and each step names its outer deadline as the Bash tool `timeout`. Lab Vitest runs use Node 22 (`PATH=/opt/homebrew/opt/node@22/bin:$PATH`). All work happens in the worktree `/Users/xian/projects/agent-remote-control/.worktrees/im-session-service`. The local instance follows `.agents/skills/prepare-arc-local/SKILL.md`: this checkout's instance only, the headless Playwright of this repository, one browser context per script, never the user's browsers.

## Decisions made in this plan

1. **The control group is a build of the commit before P1-D**, run as its own instance in its own worktree (`.worktrees/p1d-control`), measured with the same runner file. The device-store contribution alone is the **crude** arm (P1-D build, journals off); the full path is the **smart** arm (P1-D build, `ARC_LOCAL_JOURNALS=1`, smart reading on for the journal-capable provider). Both arms use the same five-session layout as P0.
2. **Four conditions per arm:** no emulation (1x), 4x CPU, 100 ms round trip, and both. The round trip is half a round trip each way on every HTTP exchange and every WebSocket byte; connection setup (TCP, TLS) is not modelled, so a real network is slower still.
3. **Counted T1 and T6 measures replace the P0 marks.** The runner marks every timeline row node (P0 marked the first) and reports how many survive a restart. T1 is counted from the moment the conversation component mounts (its first label, placeholder or message appears in the observer), as the revised target says: states with an opening label (`Opening session`, `Loading conversation`, `Awaiting Agent`, `Start with a Provider`), and states without rows. Because the observer records changes, these are counts of observed states (frames at the observer's 8 ms resolution), never clock thresholds. T6 in P1-D counts rows and row-less frames; labels across restarts are counted in P2 (T5).
4. **T2 is measured from the first attach request**, as the revised target says, so client CPU before the request is not charged to the Relay, and also from navigation, because the attach request itself can start later on one arm than on the other. The control arm is the Controller-served open. In P1-D an online open still attaches through the Controller (decision 8), so the smart arm's T2 includes that one attach; the part the journal removes is the Controller's timeline and snapshot reads.
5. **The restart scenario restarts the whole instance** (the runner's existing `restart-continuity`), because the instance's runner ends the Relay with the Controller (P0 "Not measured"). T6 for the smart arm is therefore a Relay-and-Controller restart over journals that survive in `journals.sqlite`.
6. **Pass criteria**, from the revised design, are computed by the summarizer and reported as met or not met; a miss is recorded as it is and is not worked around:
   - T1: no opening-label state and no row-less state after mount, **maximum** over all samples (not p95), in every condition and both candidate arms; and, at 4x CPU, content within 100 ms (p95) of mount.
   - T2 (smart arm): content within 500 ms (p50) and 1,500 ms (p95) of the first attach request, at 4x CPU and at the 100 ms round trip; and no slower at p50 than the control arm, both since the first attach request and since navigation.
   - T6 (smart arm): every marked row node still in the document after the restart, and no row-less state.
7. **Smart-arm validity.** A run through the proxy fails when no WebSocket crossed it, so a page that bypassed the proxy cannot produce a latency result. A smart-arm sample is also invalid, and excluded from every statistic and verdict, when the page never received a `session_control` frame with revision `relay-pending`: that frame is what a journal-served stream sends, so its absence means the session was served by the Controller (the switch was off, or no journal existed). The summary states how many samples were used.
8. **Online attach is unchanged in P1-D.** The check-only attach of a native take-over (`resumeNative`, `App.tsx:396`) must still see `native_session_owned` from the Controller, and the Relay cannot know the native owner before P1-C3's owner work. The shortcut therefore answers only while the Host is offline and the session is journal-served; the full shortcut is recorded under "Notes for the roadmap".
9. **One instance at a time.** The idle instance of another arm is stopped while an arm is measured, so two instances never compete for the machine.

## File structure

| File | Responsibility |
|---|---|
| `packages/agent-remote-lab/performance/latency-proxy.mjs` | New: the delaying proxy. |
| `packages/agent-remote-lab/performance/latency-proxy.test.mjs` | New: `node:test` of the proxy over real HTTP and WebSocket. |
| `packages/agent-remote-lab/performance/local-baselines.mjs` | Modify: `--rtt`, `--label`, attach-relative T2, counted T1, row survival, proxy validity. |
| `packages/agent-remote-lab/performance/summarize-p1d.mjs`, `summarize-p1d.test.mjs` | New: tables and verdicts from the result files, and their test. |
| `packages/agent-remote-lab/performance/create-p1d-sessions.mjs` | New: the five sessions of the P0 layout in the current instance. |
| `packages/agent-remote-lab/performance/README.md` | Modify: how to run the P1-D measurement. |
| `packages/agent-remote-hosted/src/broker.ts` | Modify: attach of a journal-served, bound session from its binding while its Host is offline. |
| `packages/agent-remote-hosted/src/broker-attach-journal.test.ts` | New: tests of it. |
| `docs/superpowers/plans/2026-11-15-p1d-results.md` | New (Task 5): the measured results. |
| `packages/agent-remote-lab/compatibility.json` | Generated. |

---

### Task 1: The latency proxy

**Files:**
- Create: `packages/agent-remote-lab/performance/latency-proxy.mjs`
- Create: `packages/agent-remote-lab/performance/latency-proxy.test.mjs`

- [ ] **Step 1: Write the failing test.**

Create `packages/agent-remote-lab/performance/latency-proxy.test.mjs`:

```js
// Run from the repository root: node --test --test-timeout=60000 packages/agent-remote-lab/performance/latency-proxy.test.mjs
// The assertions are lower bounds on elapsed time, so a slow machine cannot make them fail.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { startLatencyProxy } from './latency-proxy.mjs';

const RTT = 200;
async function upstreamServer() {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ host: request.headers.host, origin: request.headers.origin });
    if (request.url === '/redirect') { response.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/next` }).end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ origin: request.headers.origin ?? null, host: request.headers.host }));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket, request) => {
    seen.push({ socketOrigin: request.headers.origin });
    socket.on('message', data => socket.send(`echo:${data}`));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, seen, origin: `http://127.0.0.1:${server.address().port}`, close: () => { sockets.close(); server.closeAllConnections(); server.close(); } };
}
function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('delays an HTTP exchange by a full round trip, rewrites the origin the instance sees and the redirect the page follows', async () => {
  const upstream = await upstreamServer();
  const proxy = await startLatencyProxy({ target: upstream.origin, rttMs: RTT });
  try {
    const started = performance.now();
    const response = await get(`${proxy.origin}/echo`, { origin: proxy.origin });
    const elapsed = performance.now() - started;
    assert.equal(response.status, 200);
    assert.ok(elapsed >= RTT * 0.9, `expected at least ${RTT * 0.9} ms, took ${elapsed}`);
    const seen = JSON.parse(response.body);
    assert.equal(seen.origin, upstream.origin);
    assert.equal(seen.host, new URL(upstream.origin).host);
    const redirect = await get(`${proxy.origin}/redirect`);
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.location, `${proxy.origin}/next`);
    assert.ok(proxy.stats().http >= 2);
  } finally { await proxy.close(); upstream.close(); }
});

test('delays WebSocket frames by half a round trip each way and keeps their order', async () => {
  const upstream = await upstreamServer();
  const proxy = await startLatencyProxy({ target: upstream.origin, rttMs: RTT });
  try {
    const socket = new WebSocket(proxy.origin.replace('http:', 'ws:') + '/socket', { origin: proxy.origin });
    await once(socket, 'open');
    const echoes = [];
    const done = new Promise(resolve => socket.on('message', data => { echoes.push(String(data)); if (echoes.length === 3) resolve(); }));
    const started = performance.now();
    for (const text of ['a', 'b', 'c']) socket.send(text);
    await done;
    const elapsed = performance.now() - started;
    assert.deepEqual(echoes, ['echo:a', 'echo:b', 'echo:c']);
    assert.ok(elapsed >= RTT * 0.9, `expected at least ${RTT * 0.9} ms, took ${elapsed}`);
    assert.ok(upstream.seen.some(item => item.socketOrigin === upstream.origin), 'the instance must see its own origin on the upgrade');
    assert.equal(proxy.stats().upgrades, 1);
    socket.close();
  } finally { await proxy.close(); upstream.close(); }
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `node --test --test-timeout=60000 packages/agent-remote-lab/performance/latency-proxy.test.mjs` (Bash timeout 120000)
Expected: FAIL, `Cannot find module './latency-proxy.mjs'`.

- [ ] **Step 3: Write the proxy.**

Create `packages/agent-remote-lab/performance/latency-proxy.mjs`:

```js
// A proxy in front of an instance that delays every exchange by `rttMs`: half before the request reaches the instance, half before
// the answer reaches the browser. HTTP is delayed per exchange and WebSocket per byte chunk, in order, so frames arrive late and
// never reordered. Browser network throttling delays HTTP only; this is what makes the page's WebSocket traffic slow too.
// The instance sees its own origin and host, so its same-origin and loopback checks pass. TCP and TLS setup are not modelled.
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const swap = (value, from, to) => typeof value === 'string' ? value.split(from).join(to) : value;

/** Copies `from` to `to` after `ms`, chunk by chunk and in order; ends and closes the other side later by the same delay. */
function delayedPipe(from, to, ms) {
  const queue = [];
  let timer;
  const release = () => {
    timer = undefined;
    const now = Date.now();
    while (queue.length && queue[0].at <= now) {
      const item = queue.shift();
      if (item.end) { to.end(); return; }
      if (!to.destroyed) to.write(item.chunk);
    }
    if (queue.length) timer = setTimeout(release, Math.max(0, queue[0].at - now));
  };
  const push = item => { queue.push({ at: Date.now() + ms, ...item }); timer ??= setTimeout(release, ms); };
  from.on('data', chunk => push({ chunk }));
  from.on('end', () => push({ end: true }));
  from.on('close', () => setTimeout(() => to.destroy(), ms + 20));
}

/** Starts the proxy on a free loopback port. `origin` is where the browser goes instead of `target`. */
export async function startLatencyProxy({ target, rttMs }) {
  const upstream = new URL(target);
  const upstreamOrigin = upstream.origin;
  const upstreamHost = upstream.hostname === 'localhost' ? '127.0.0.1' : upstream.hostname;
  const upstreamPort = Number(upstream.port || 80);
  const oneWay = rttMs / 2;
  const counts = { http: 0, upgrades: 0 };
  let proxyOrigin = '';
  const requestHeaders = headers => ({
    ...headers,
    host: upstream.host,
    ...(headers.origin ? { origin: swap(headers.origin, proxyOrigin, upstreamOrigin) } : {}),
    ...(headers.referer ? { referer: swap(headers.referer, proxyOrigin, upstreamOrigin) } : {}),
  });
  const server = createServer(async (request, response) => {
    counts.http += 1;
    request.pause();
    await wait(oneWay);
    const upstreamRequest = httpRequest({ host: upstreamHost, port: upstreamPort, method: request.method, path: request.url, headers: requestHeaders(request.headers) }, async upstreamResponse => {
      await wait(oneWay);
      const headers = { ...upstreamResponse.headers };
      if (headers.location) headers.location = swap(headers.location, upstreamOrigin, proxyOrigin);
      response.writeHead(upstreamResponse.statusCode ?? 502, headers);
      upstreamResponse.pipe(response);
    });
    upstreamRequest.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(upstreamRequest);
    request.resume();
  });
  server.on('upgrade', async (request, clientSocket, head) => {
    counts.upgrades += 1;
    clientSocket.pause();
    await wait(oneWay);
    const upstreamSocket = connect(upstreamPort, upstreamHost);
    upstreamSocket.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstreamSocket.destroy());
    upstreamSocket.on('connect', () => {
      const headers = requestHeaders(request.headers);
      const lines = [`${request.method} ${request.url} HTTP/1.1`,
        ...Object.entries(headers).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map(item => `${name}: ${item}`)), '', ''];
      upstreamSocket.write(lines.join('\r\n'));
      if (head.length) upstreamSocket.write(head);
      delayedPipe(upstreamSocket, clientSocket, oneWay);
      delayedPipe(clientSocket, upstreamSocket, oneWay);
      clientSocket.resume();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  proxyOrigin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin: proxyOrigin,
    /** How many HTTP exchanges and WebSocket upgrades crossed the proxy. */
    stats: () => ({ ...counts }),
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `node --test --test-timeout=60000 packages/agent-remote-lab/performance/latency-proxy.test.mjs` (Bash timeout 120000)
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-lab/performance/latency-proxy.mjs packages/agent-remote-lab/performance/latency-proxy.test.mjs
git commit -m "perf: a delaying proxy that delays WebSocket frames as well as HTTP" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: The runner: latency, counted T1 and T6, T2 from the attach request, and the summary

**Files:**
- Modify: `packages/agent-remote-lab/performance/local-baselines.mjs`
- Create: `packages/agent-remote-lab/performance/summarize-p1d.mjs`
- Create: `packages/agent-remote-lab/performance/create-p1d-sessions.mjs`
- Modify: `packages/agent-remote-lab/performance/README.md`

- [ ] **Step 1: Import the proxy and document the options.**

In `local-baselines.mjs`, after the line `import { setTimeout as delay } from 'node:timers/promises';` add:

```js
import { startLatencyProxy } from './latency-proxy.mjs';
```

In the options comment, after the line `//   --action MS           deadline of one action (default 30000)` add:

```js
//   --rtt MS              emulated round trip between the browser and the instance, through a delaying proxy that delays HTTP and
//                         WebSocket traffic (default 0: direct). The command line still talks to the instance directly.
//   --label NAME          names the arm in the result file (control, crude, smart)
```

- [ ] **Step 2: Start the proxy and point the browser at it.**

Replace

```js
const origin = options.origin ?? JSON.parse(execFileSync('pnpm', ['--silent', 'local', 'status', '--json'], { cwd: root, encoding: 'utf8' })).origin;
```

with

```js
const directOrigin = options.origin ?? JSON.parse(execFileSync('pnpm', ['--silent', 'local', 'status', '--json'], { cwd: root, encoding: 'utf8' })).origin;
const rttMs = Number(options.rtt ?? 0);
// The browser goes through a proxy that delays every exchange, WebSocket frames included, when a round trip is asked for.
const proxy = rttMs > 0 ? await startLatencyProxy({ target: directOrigin, rttMs }) : undefined;
const origin = proxy?.origin ?? directOrigin;
const label = options.label ?? 'unlabeled';
```

Replace

```js
  .map(address => ({ address, provider: address.split('/')[1], url: controller('session', 'link', address).url }));
```

with

```js
  .map(address => ({ address, provider: address.split('/')[1], url: controller('session', 'link', address).url.replace(directOrigin, origin) }));
if (proxy && sessions.some(item => !item.url.startsWith(origin))) throw new Error(`A session link does not start with the proxy origin ${origin}; the page would bypass the latency proxy.`);
```

In the `result` object, replace `options: { reps, throttle, hiddenShortMs, hiddenLongMs, scenarios: wanted },` with

```js
options: { reps, throttle, rttMs, label, hiddenShortMs, hiddenLongMs, scenarios: wanted },
```

- [ ] **Step 3: Mark every row node and count survivors.**

In `observerSource`, replace

```js
    mark: () => { const node = document.querySelector('.agent-timeline-entry'); window.__baselineMark = node; return !!node; },
    markAlive: () => !!window.__baselineMark && window.__baselineMark.isConnected,
```

with

```js
    // Every row node is marked (P0 marked the first one): a row that was re-keyed leaves the document.
    mark: () => { const nodes = [...document.querySelectorAll('.agent-timeline-entry')]; window.__baselineMarks = nodes; return nodes.length > 0; },
    markAlive: () => !!window.__baselineMarks?.length && window.__baselineMarks.every(node => node.isConnected),
    survivors: () => ({ total: window.__baselineMarks?.length ?? 0, alive: (window.__baselineMarks ?? []).filter(node => node.isConnected).length }),
```

In `instrument`, replace

```js
  const http = [], sockets = [], frames = [], consoleErrors = [];
```

with

```js
  const http = [], sockets = [], frames = [], consoleErrors = [];
  // A journal-served stream announces itself with a `session_control` of revision relay-pending; counted to prove the smart arm served from journals.
  let relayPending = 0;
```

replace

```js
    const entry = { t: Date.now(), id: event.requestId, dir: 'in', kind: messageKind(event.response.payloadData), bytes: event.response.payloadData.length };
```

with

```js
    if (event.response.payloadData.includes('relay-pending')) relayPending += 1;
    const entry = { t: Date.now(), id: event.requestId, dir: 'in', kind: messageKind(event.response.payloadData), bytes: event.response.payloadData.length };
```

replace

```js
    reset() { http.length = 0; sockets.length = 0; frames.length = 0; consoleErrors.length = 0; pending.clear(); },
```

with

```js
    reset() { http.length = 0; sockets.length = 0; frames.length = 0; consoleErrors.length = 0; pending.clear(); relayPending = 0; },
```

and replace

```js
        consoleErrors: consoleErrors.slice(0, 5),
```

with

```js
        consoleErrors: consoleErrors.slice(0, 5),
        relayPendingFrames: relayPending,
```

In the `release-continuity` scenario, replace

```js
        samples.push({ address: session.address, provider: session.provider, released, markedEntryStillInDocument: alive,
```

with

```js
        samples.push({ address: session.address, provider: session.provider, released, markedEntryStillInDocument: alive,
          rows: await handle.page.evaluate(() => window.__baseline.survivors()).catch(() => undefined),
```

In the `restart-continuity` scenario, replace

```js
          markedEntryStillInDocument: alive, minMessagesAfterRestart:
```

with

```js
          markedEntryStillInDocument: alive, rows: await handle.page.evaluate(() => window.__baseline.survivors()).catch(() => undefined), journalServed: (capture.relayPendingFrames ?? 0) > 0, minMessagesAfterRestart:
```

- [ ] **Step 4: Time the first attach request.**

In `summarizeRequests`, after the line starting `const apiHttp = http.filter(item => item.type !== 'script'` add:

```js
  const attach = http.find(item => item.method === 'POST' && /\/attach$/.test(item.path));
```

and in the returned object, replace `    httpTotal: http.length,` with

```js
    firstAttachMs: attach ? attach.t - start : null,
    httpTotal: http.length,
```

- [ ] **Step 5: Count the T1 states and time T2 from the attach request.**

Replace the whole `openSummary` function with:

```js
// T1 counts observed states (the observer records every change at 8 ms resolution), from the moment the conversation mounts:
// its first label, placeholder or message. These are counts, never clock thresholds.
const OPENING_LABELS = ['Opening session', 'Loading conversation', 'Awaiting Agent', 'Start with a Provider'];
const showsOpening = state => [...state.labels, ...state.loading].some(text => OPENING_LABELS.some(label => text.includes(label)));
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
    journalServed: (capture.relayPendingFrames ?? 0) > 0,
    openingLabelFrames: sinceMount.filter(showsOpening).length,
    blankFramesSinceMount: sinceMount.filter(state => state.messages === 0).length,
    blockedUntilMs: capture.states.filter(isBlocked).at(-1) ? (capture.states.filter(isBlocked).at(-1).t) : 0,
    states: stateSummary(capture.states, 0, settledAt),
    requests: capture.requests, timelineReads: capture.timelineReads, consoleErrors: capture.consoleErrors,
  };
};
```

In `summarizeOpen`, replace

```js
  contentMs: stats(samples.map(sample => sample.contentMs)), readyMs: stats(samples.map(sample => sample.readyMs)),
```

with

```js
  contentMs: stats(samples.map(sample => sample.contentMs)), readyMs: stats(samples.map(sample => sample.readyMs)),
  contentSinceMountMs: stats(samples.map(sample => sample.contentSinceMountMs)), contentSinceAttachMs: stats(samples.map(sample => sample.contentSinceAttachMs)),
  openingLabelFrames: stats(samples.map(sample => sample.openingLabelFrames)), blankFramesSinceMount: stats(samples.map(sample => sample.blankFramesSinceMount)),
```

- [ ] **Step 6: Refuse a latency result that never used the proxy.**

In the `finally` block at the end, replace

```js
  result.finishedAt = new Date().toISOString();
```

with

```js
  result.finishedAt = new Date().toISOString();
  if (proxy) {
    result.proxy = proxy.stats();
    // A page that bypassed the proxy would make every latency number a loopback number.
    if (!result.proxy.upgrades) result.invalid = 'No WebSocket crossed the latency proxy; these numbers are not latency numbers.';
    await proxy.close();
  }
```

- [ ] **Step 7: Write the session creator.**

Create `packages/agent-remote-lab/performance/create-p1d-sessions.mjs`. It reuses the repository's `cli-turn.mjs`, which already waits for a real reply and tolerates the first moments of a session when its native history does not exist yet (`history_unavailable`):

```js
// Creates the P0 layout in the current directory's instance: three Claude Code and two Codex sessions, each with two real turns,
// the first of which prints a long tool output. Run from the checkout whose instance should hold them:
//   node packages/agent-remote-lab/performance/create-p1d-sessions.mjs
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const turn = join(process.cwd(), '.agents/skills/prepare-arc-local/scripts/cli-turn.mjs');
/** Runs one real turn through cli-turn and returns what it printed last: `{ address, state, reply }`. */
const run = (...args) => JSON.parse(execFileSync(process.execPath, [turn, ...args], { cwd: process.cwd(), encoding: 'utf8', timeout: 300_000 }).trim().split('\n').at(-1));
for (const provider of ['claude', 'claude', 'claude', 'codex', 'codex']) {
  const { address } = run(provider, 'Run the shell command `seq 1 3000`, then reply with the single word OK.');
  run('--session', address, 'Reply with the single word OK.');
  console.log(`${provider}: ${address}`);
}
```

- [ ] **Step 8: Write the summary and its test.**

The summary recomputes every statistic from the raw samples of the result files, so it can exclude invalid smart-arm samples and use the maximum where a target says "no frame".

Create `packages/agent-remote-lab/performance/summarize-p1d.mjs`:

```js
// Turns the P1-D result files into tables and a verdict per target:
//   node packages/agent-remote-lab/performance/summarize-p1d.mjs .tmp/p1d
// It reads `<dir>/<arm>-<condition>.json` for the arms control, crude and smart and the conditions 1x, 4x, rtt100 and 4x-rtt100.
// A smart-arm sample without `journalServed` was not served from a journal and is excluded everywhere.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const arms = ['control', 'crude', 'smart'];
const conditions = [['1x', 'no emulation'], ['4x', '4x CPU'], ['rtt100', '100 ms round trip'], ['4x-rtt100', '4x CPU and 100 ms round trip']];
const cell = value => value === null || value === undefined ? 'n/a' : String(value);

export function stats(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const at = fraction => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] : null;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: at(1) };
}

export function summarize(dir) {
  const load = (arm, condition) => {
    const file = `${dir}/${arm}-${condition}.json`;
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
  };
  const usable = (arm, samples) => (samples ?? []).filter(sample => arm !== 'smart' || sample.journalServed === true);
  const lines = [];
  const table = (title, header, rows) => {
    lines.push(`### ${title}`, '', `| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.join(' | ')} |`), '');
  };
  const each = callback => arms.flatMap(arm => conditions.flatMap(([condition, name]) => {
    const run = load(arm, condition);
    return run && !run.invalid ? callback(arm, condition, name, run) : [];
  }));
  const invalid = arms.flatMap(arm => conditions.flatMap(([condition]) => { const run = load(arm, condition); return run?.invalid ? [`${arm}/${condition}: ${run.invalid}`] : []; }));
  if (invalid.length) lines.push(`**Invalid runs, excluded from every table and verdict:** ${invalid.join('; ')}`, '');
  const pair = value => value ? `${cell(value.p50)} / ${cell(value.p95)}` : 'n/a';
  const used = (arm, all, kept) => arm === 'smart' ? `${kept.length}/${all.length}` : String(all.length);
  const known = (arm, run) => { const all = run.scenarios?.['open-known']?.samples ?? []; return { all, kept: usable(arm, all) }; };
  const fresh = (arm, run) => { const all = run.scenarios?.['open-fresh']?.samples ?? []; return { all, kept: usable(arm, all) }; };

  table('T1: a conversation opened before (reload; p50 / p95, and the maximum of the counts)', ['Arm', 'Condition', 'Samples used', 'Content since mount, ms', 'Content since navigation, ms', 'Opening-label states (max)', 'Row-less states since mount (max)'],
    each((arm, _condition, name, run) => {
      const { all, kept } = known(arm, run);
      return all.length ? [[arm, name, used(arm, all, kept), pair(stats(kept.map(sample => sample.contentSinceMountMs))), pair(stats(kept.map(sample => sample.contentMs))),
        cell(stats(kept.map(sample => sample.openingLabelFrames)).max), cell(stats(kept.map(sample => sample.blankFramesSinceMount)).max)]] : [];
    }));
  table('T2: a conversation never opened on this device (storage cleared; p50 / p95)', ['Arm', 'Condition', 'Samples used', 'Content since the first attach request, ms', 'Content since navigation, ms'],
    each((arm, _condition, name, run) => {
      const { all, kept } = fresh(arm, run);
      return all.length ? [[arm, name, used(arm, all, kept), pair(stats(kept.map(sample => sample.contentSinceAttachMs))), pair(stats(kept.map(sample => sample.contentMs)))]] : [];
    }));
  table('T6: rows across an instance restart', ['Arm', 'Condition', 'Session', 'Row nodes marked', 'Still in the document', 'Row-less moments', 'Ready again, ms'],
    each((arm, _condition, name, run) => usable(arm, run.scenarios?.['restart-continuity']?.samples).map(sample =>
      [arm, name, sample.address, cell(sample.rows?.total), cell(sample.rows?.alive), cell(sample.blankMoments), cell(sample.readyAgainMs)])));

  const verdicts = [];
  for (const arm of ['crude', 'smart']) for (const [condition, name] of conditions) {
    const run = load(arm, condition);
    if (!run || run.invalid) continue;
    const { kept } = known(arm, run);
    if (!kept.length) continue;
    const opening = stats(kept.map(sample => sample.openingLabelFrames)).max, blank = stats(kept.map(sample => sample.blankFramesSinceMount)).max;
    verdicts.push(`T1 counted, ${arm}, ${name}: ${opening === 0 && blank === 0 ? 'met' : 'not met'} (opening-label states max ${cell(opening)}, row-less states max ${cell(blank)}, ${kept.length} samples)`);
    if (condition.startsWith('4x')) {
      const p95 = stats(kept.map(sample => sample.contentSinceMountMs)).p95;
      verdicts.push(`T1 content within 100 ms of mount (p95), ${arm}, ${name}: ${p95 !== null && p95 <= 100 ? 'met' : 'not met'} (${cell(p95)} ms)`);
    }
  }
  for (const [condition, name] of conditions) {
    if (condition !== '4x' && condition !== 'rtt100') continue;
    const run = load('smart', condition), control = load('control', condition);
    if (!run || run.invalid) continue;
    const kept = fresh('smart', run).kept;
    if (!kept.length) { verdicts.push(`T2 (smart), ${name}: not measured (no sample was served from a journal)`); continue; }
    const attach = stats(kept.map(sample => sample.contentSinceAttachMs)), navigation = stats(kept.map(sample => sample.contentMs));
    verdicts.push(`T2 (smart), ${name}: ${attach.p50 <= 500 && attach.p95 <= 1500 ? 'met' : 'not met'} (since the first attach request p50 ${cell(attach.p50)} ms, p95 ${cell(attach.p95)} ms, ${kept.length} samples)`);
    const reference = control && !control.invalid ? fresh('control', control).kept : [];
    if (reference.length) {
      const controlAttach = stats(reference.map(sample => sample.contentSinceAttachMs)).p50, controlNavigation = stats(reference.map(sample => sample.contentMs)).p50;
      verdicts.push(`T2 (smart) no slower at p50 than the control arm since the first attach request, ${name}: ${attach.p50 <= controlAttach ? 'met' : 'not met'} (smart ${cell(attach.p50)} ms, control ${cell(controlAttach)} ms)`);
      verdicts.push(`T2 (smart) no slower at p50 than the control arm since navigation, ${name}: ${navigation.p50 <= controlNavigation ? 'met' : 'not met'} (smart ${cell(navigation.p50)} ms, control ${cell(controlNavigation)} ms)`);
    }
  }
  for (const [condition, name] of conditions) {
    const run = load('smart', condition);
    const samples = run && !run.invalid ? usable('smart', run.scenarios?.['restart-continuity']?.samples) : [];
    if (!samples.length) continue;
    const kept = samples.every(sample => sample.rows?.total > 0 && sample.rows.alive === sample.rows.total) && samples.every(sample => sample.blankMoments === 0);
    verdicts.push(`T6 (smart), ${name}: ${kept ? 'met' : 'not met'} (${samples.map(sample => `${cell(sample.rows?.alive)}/${cell(sample.rows?.total)} rows kept, ${cell(sample.blankMoments)} row-less moments`).join('; ')})`);
  }
  lines.push('### Verdicts', '', ...verdicts.map(line => `- ${line}`), '');
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(summarize(process.argv[2] ?? '.tmp/p1d'));
```

Create `packages/agent-remote-lab/performance/summarize-p1d.test.mjs`:

```js
// node --test --test-timeout=60000 packages/agent-remote-lab/performance/summarize-p1d.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stats, summarize } from './summarize-p1d.mjs';

const known = (count, change = () => ({})) => Array.from({ length: count }, (_, index) => ({ contentSinceMountMs: 20, contentMs: 120, openingLabelFrames: 0, blankFramesSinceMount: 0, journalServed: true, ...change(index) }));
const fresh = (count, attach, navigation, served = true) => Array.from({ length: count }, () => ({ contentSinceAttachMs: attach, contentMs: navigation, journalServed: served }));
const write = (dir, arm, condition, scenarios, extra = {}) => writeFileSync(join(dir, `${arm}-${condition}.json`), JSON.stringify({ scenarios, ...extra }));

test('computes the percentiles and the maximum', () => {
  assert.deepEqual(stats([5, 1, 3, 2, 4]), { n: 5, p50: 3, p95: 5, max: 5 });
  assert.deepEqual(stats([]), { n: 0, p50: null, p95: null, max: null });
});

test('judges "no frame" by the maximum: one bad sample in 25 fails although p95 is clean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p1d-summary-'));
  write(dir, 'crude', '4x', { 'open-known': { samples: known(25, index => index === 3 ? { openingLabelFrames: 1 } : {}) } });
  const text = summarize(dir);
  assert.match(text, /T1 counted, crude, 4x CPU: not met \(opening-label states max 1/);
  assert.match(text, /T1 content within 100 ms of mount \(p95\), crude, 4x CPU: met/);
});

test('excludes smart-arm samples that were not served from a journal and says how many were used', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p1d-summary-'));
  write(dir, 'smart', 'rtt100', { 'open-fresh': { samples: [...fresh(8, 300, 700), ...fresh(2, 9000, 9500, false)] } });
  write(dir, 'control', 'rtt100', { 'open-fresh': { samples: fresh(10, 800, 1200) } });
  const text = summarize(dir);
  assert.match(text, /\| smart \| 100 ms round trip \| 8\/10 \|/);
  assert.match(text, /T2 \(smart\), 100 ms round trip: met \(since the first attach request p50 300 ms, p95 300 ms, 8 samples\)/);
  assert.match(text, /no slower at p50 than the control arm since navigation, 100 ms round trip: met/);
});

test('fails T2 against the control arm when only the navigation time is worse', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p1d-summary-'));
  write(dir, 'smart', '4x', { 'open-fresh': { samples: fresh(5, 300, 2000) } });
  write(dir, 'control', '4x', { 'open-fresh': { samples: fresh(5, 800, 1200) } });
  const text = summarize(dir);
  assert.match(text, /no slower at p50 than the control arm since the first attach request, 4x CPU: met/);
  assert.match(text, /no slower at p50 than the control arm since navigation, 4x CPU: not met/);
});

test('reports T6 from the surviving row nodes and excludes an invalid run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p1d-summary-'));
  write(dir, 'smart', '1x', { 'restart-continuity': { samples: [{ address: 'a/codex/1', rows: { total: 6, alive: 6 }, blankMoments: 0, journalServed: true }] } });
  write(dir, 'smart', 'rtt100', { 'restart-continuity': { samples: [{ address: 'a/codex/1', rows: { total: 6, alive: 2 }, blankMoments: 0, journalServed: true }] } }, { invalid: 'No WebSocket crossed the latency proxy.' });
  const text = summarize(dir);
  assert.match(text, /T6 \(smart\), no emulation: met/);
  assert.match(text, /Invalid runs, excluded from every table and verdict:\*\* smart\/rtt100/);
  assert.doesNotMatch(text, /T6 \(smart\), 100 ms round trip/);
});
```

- [ ] **Step 9: Document the runs.**

Append to `packages/agent-remote-lab/performance/README.md`:

````markdown

## Latency, the device store and the P1-D runs

`local-baselines.mjs --rtt MS` puts a delaying proxy (`latency-proxy.mjs`) in front of the instance: every HTTP exchange and every WebSocket byte is delayed by half a round trip each way, which browser network throttling does not do for WebSockets. The command line talks to the instance directly. A run through the proxy is marked invalid when no WebSocket crossed it. `--label` names the arm in the result. The proxy has its own test: `node --test --test-timeout=60000 packages/agent-remote-lab/performance/latency-proxy.test.mjs`.

The open scenarios report, per sample, `contentSinceMountMs` (first message after the conversation component mounted), `contentSinceAttachMs` (first message after the first `attach` request, the revised T2 measure), and counted observer states since mount: `openingLabelFrames` (states showing Opening session, Loading conversation, Awaiting Agent or Start with a Provider) and `blankFramesSinceMount` (states without rows). The continuity scenarios mark every timeline row node and report how many are still in the document (`rows`).

```sh
node packages/agent-remote-lab/performance/local-baselines.mjs --label crude --rtt 100 --throttle 4 --scenarios open-known,open-fresh,restart-continuity --reps 3 --out .tmp/p1d/crude-4x-rtt100.json
node packages/agent-remote-lab/performance/summarize-p1d.mjs .tmp/p1d
```
````

- [ ] **Step 10: Check the syntax of the scripts and run the proxy and summary tests.**

Run: `node --check packages/agent-remote-lab/performance/local-baselines.mjs && node --check packages/agent-remote-lab/performance/create-p1d-sessions.mjs && node --test --test-timeout=60000 packages/agent-remote-lab/performance/latency-proxy.test.mjs packages/agent-remote-lab/performance/summarize-p1d.test.mjs` (Bash timeout 180000)
Expected: exit code 0; 7 tests pass (2 of the proxy, 5 of the summary).

Run: `node packages/agent-remote-lab/performance/summarize-p1d.mjs /tmp/p1d-empty` (Bash timeout 60000)
Expected: prints the three empty tables (header and separator rows only) and `### Verdicts` with no lines; exit code 0.

- [ ] **Step 11: Commit.**

```bash
git add packages/agent-remote-lab/performance/local-baselines.mjs packages/agent-remote-lab/performance/summarize-p1d.mjs packages/agent-remote-lab/performance/summarize-p1d.test.mjs packages/agent-remote-lab/performance/create-p1d-sessions.mjs packages/agent-remote-lab/performance/README.md
git commit -m "perf: measure under latency with counted T1 and T6 and T2 from the attach request" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: A journal-served session opens while its Host is offline

**Depends on P1-B3a Task 6** (it uses `journalSessions.serves(hostId, providerId, sessionKey)` as that task leaves it). `POST /v1/remote/hosts/:id/attach` goes through `requireHost`, which refuses an offline Host (`host_offline`) before anything else, so a conversation whose journal the Relay holds cannot be opened while its Host is away, although every page of it could be served.

The shortcut is deliberately narrow. Online, the attach still goes through the Controller: the check-only attach of a native take-over (`resumeNative`, `App.tsx:396`) must still see `native_session_owned`, and the Relay cannot know the native owner before P1-C3. So the Relay answers from the binding only when the Host is offline, the session is bound and journal-served, and the caller may see it. The full shortcut is recorded under "Notes for the roadmap".

**Files:**
- Modify: `packages/agent-remote-hosted/src/broker.ts`
- Create: `packages/agent-remote-hosted/src/broker-attach-journal.test.ts`
- Modify: `packages/agent-remote-lab/compatibility.json` (generated)

- [ ] **Step 1: Write the failing tests.**

Create `packages/agent-remote-hosted/src/broker-attach-journal.test.ts`:

```ts
import { expect, it } from 'vitest';
import { HOST_ID, PUBLIC_ID, seedJournal, startRelay } from './test-utils/journal-session-fixture.js';

const session = { providerId: 'codex', nativeSessionId: 'native-session' };
const attach = (body: Record<string, unknown>) => new Request(`https://relay.example/v1/remote/hosts/${HOST_ID}/attach`, {
  method: 'POST', headers: { origin: 'https://relay.example', 'content-type': 'application/json' }, body: JSON.stringify(body) });
const shared = (creatorSubject: string) => ({
  broker: { ownerSubject: 'alice' },
  state: (saved: any) => ({ ...saved,
    bindings: saved.bindings.map((binding: any) => ({ ...binding, creatorSubject })),
    sharing: { grants: [{ hostId: 'host', subject: 'bob', label: 'Bob', sessionLimit: 1, revoked: false }], reservations: [] } }),
});

it('answers the attach of a journal-served, bound session from its binding while the Host is offline', async () => {
  const r = await startRelay({ seed: store => seedJournal(store) });
  try {
    const response = await r.broker.handleRequest(attach(session));
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ agentId: PUBLIC_ID, nativeSessionId: 'native-session' });
  } finally { await r.dispose(); }
});

it('still attaches through the Controller while the Host is online, so a native owner is seen', async () => {
  const nativeOwner = { kind: 'native_cli', generation: '11111111-1111-4111-8111-111111111111' };
  const r = await startRelay({ seed: store => seedJournal(store) });
  try {
    const controller = await r.connectController({ attach: { status: 409, body: { code: 'native_session_owned', nativeOwner } } });
    const response = await r.broker.handleRequest(attach(session));
    expect(response?.status).toBe(409);
    expect(await response!.json()).toMatchObject({ code: 'native_session_owned', nativeOwner });
    expect(controller.attaches).toHaveLength(1);
  } finally { await r.dispose(); }
  const open = await startRelay({ seed: store => seedJournal(store) });
  try {
    const controller = await open.connectController();
    const response = await open.broker.handleRequest(attach(session));
    expect(response?.status).toBe(200);
    expect(controller.attaches).toHaveLength(1);
  } finally { await open.dispose(); }
});

it('still goes through the Controller when the journal has no head, for a take-over, and for a session nobody bound', async () => {
  const r = await startRelay({ seed: store => seedJournal(store, { head: false }) });
  try {
    const withoutHead = await r.broker.handleRequest(attach(session));
    expect(withoutHead?.status).toBe(503);
    expect(await withoutHead!.json()).toMatchObject({ code: 'host_offline' });
  } finally { await r.dispose(); }
  const served = await startRelay({ seed: store => seedJournal(store) });
  try {
    const takeOver = await served.broker.handleRequest(attach({ ...session, takeOver: true }));
    expect(takeOver?.status).toBe(503);
    const unbound = await served.broker.handleRequest(attach({ providerId: 'codex', nativeSessionId: 'never-bound' }));
    expect(unbound?.status).toBe(503);
  } finally { await served.dispose(); }
});

it('answers a share recipient only for a session they created, and nobody without a grant', async () => {
  const own = await startRelay({ seed: store => seedJournal(store), ...shared('bob') });
  try {
    const response = await own.broker.handleRequest(attach(session), { principalSubject: () => 'bob' });
    expect(response?.status).toBe(200);
  } finally { await own.dispose(); }
  const other = await startRelay({ seed: store => seedJournal(store), ...shared('carol') });
  try {
    const response = await other.broker.handleRequest(attach(session), { principalSubject: () => 'bob' });
    expect(response?.status).toBe(503);
    expect(await response!.json()).toMatchObject({ code: 'host_offline' });
  } finally { await other.dispose(); }
  const stranger = await startRelay({ seed: store => seedJournal(store), ...shared('bob') });
  try {
    const response = await stranger.broker.handleRequest(attach(session), { principalSubject: () => 'mallory' });
    expect(response?.status).toBeGreaterThanOrEqual(400);
    expect(response?.status).not.toBe(503);
  } finally { await stranger.dispose(); }
});
```

The share-recipient test pins the order of the two checks: `requireAccess` (a grant for the Host) runs first and refuses a stranger before anything is answered; `sessionAllowed` (the recipient created the session) then decides, and a recipient who did not create it falls through to the ordinary path.

- [ ] **Step 2: Run them to verify they fail.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/broker-attach-journal.test.ts --testTimeout=10000` (Bash timeout 120000)
Expected: FAIL: the first test gets 503 `host_offline`, and the recipient's own session too. The online, take-over, no-head, other-creator and stranger cases pass already; they pin behaviour.

- [ ] **Step 3: Answer from the binding while the Host is offline.**

The route resolves the Host with `requireHost` before the attach is looked at, so the shortcut runs before it, from the Host record alone.

In `packages/agent-remote-hosted/src/broker.ts`, in the directory route, replace

```ts
      const host = requireHost(directory[1]!);
      if (action === 'models' && request.method === 'GET' && host.legacyDsh) return json(200, { models: [] });
```

with

```ts
      // A session read from its journal opens while its Host is offline; an online Host still attaches it (see attachedFromJournal).
      const attachBody = action === 'attach' && request.method === 'POST' ? await readBody(request) : undefined;
      const bound = attachBody && await attachedFromJournal(directory[1]!, attachBody, subject);
      if (bound) return json(200, bound);
      const host = requireHost(directory[1]!);
      if (action === 'models' && request.method === 'GET' && host.legacyDsh) return json(200, { models: [] });
```

and, further down the same branch, replace

```ts
        const operation = userMutation(host, action, await readBody(request), subject);
```

with

```ts
        const operation = userMutation(host, action, attachBody ?? await readBody(request), subject);
```

Add this function directly above the comment block that begins `* Makes the Controller know the session before a stream opens.` (the doc comment of `recoverForJournalStream`; place the new function and its own comment before that comment's opening `/**`):

```ts
  /**
   * The attach of a session whose reads come from its journal, while its Host is offline: its binding answers, so the conversation
   * opens from the journal. An online Host still attaches through its Controller, which is the only one that knows a native owner
   * (the check-only attach of a take-over must see `native_session_owned`). A take-over, a child, an unbound session, a session
   * without a journal head and a caller who may not see the session attach through the ordinary path.
   */
  async function attachedFromJournal(hostId: string, body: Record<string, unknown>, subject: string | undefined): Promise<{ agentId: string; nativeSessionId: string } | undefined> {
    const host = hosts.get(hostId);
    if (!journalSessions || !host || host.legacyDsh || body.takeOver !== undefined || body.parentNativeSessionId !== undefined) return undefined;
    if (host.ready && host.socket?.readyState === RELAY_SOCKET_OPEN) return undefined;
    const { providerId, nativeSessionId } = body;
    if (typeof providerId !== 'string' || typeof nativeSessionId !== 'string' || !host.providers.some(provider => provider.providerId === providerId)) return undefined;
    const binding = nativeBindings.get(JSON.stringify([host.id, providerId, nativeSessionId]));
    if (!binding || binding.parentNativeSessionId !== undefined || !sessionAllowed(binding, subject)) return undefined;
    const served = await journalSessions.serves(host.id, providerId, journalSessionKey(providerId, nativeSessionId)).catch(() => false);
    return served ? { agentId: binding.agentId, nativeSessionId } : undefined;
  }
```

- [ ] **Step 4: Run the tests and the hosted suite.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/broker-attach-journal.test.ts --testTimeout=10000` (Bash timeout 120000)
Expected: PASS, 4 tests.

Run: `pnpm --filter @orchardworks/agent-remote-hosted run build && pnpm --filter @orchardworks/agent-remote-hosted exec vitest run --testTimeout=10000` (Bash timeout 300000)
Expected: exit code 0 and PASS. If the outer deadline is hit, run `src/[a-i]*.test.ts` and then `src/[j-z]*.test.ts` separately.

- [ ] **Step 5: Run the real-transport suites that use the hosted broker.**

Run: `PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm --filter @orchardworks/agent-remote-lab exec vitest run src/server/session-channel-routing.test.ts src/server/gateway-relay.test.ts src/components/SessionConversation.journal.test.tsx --testTimeout=90000` (Bash timeout 400000)
Expected: PASS. (The journal test of the first plan opens through `attachmentManaged`, so it is unchanged; the other two prove crude attach is unchanged end to end.)

- [ ] **Step 6: Update and check the compatibility digest.**

Run: `pnpm compatibility:update && pnpm compatibility:check` (Bash timeout 300000)
Expected: exit code 0 for both. The digest changes because the hosted source changed.

- [ ] **Step 7: Commit.**

```bash
git add packages/agent-remote-hosted/src/broker.ts packages/agent-remote-hosted/src/broker-attach-journal.test.ts packages/agent-remote-lab/compatibility.json
git commit -m "feat(hosted): open a journal-served session while its Host is offline" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Verify the device store on the local instance (crude path)

This task needs only the first plan. It shows, on this checkout's instance and through the latency proxy, that a conversation opened before appears from the device store before the network chain completes, with no opening label.

**Files:** a scratch script under `.tmp/local/` (ignored by git); nothing is committed.

- [ ] **Step 1: Start this checkout's instance.**

Follow `.agents/skills/prepare-arc-local/SKILL.md`. If an instance of this checkout is running, read "Before restarting a running instance" in its lifecycle reference first.

Run: `pnpm local up` (Bash timeout 600000)
Expected: prints the instance status with its `http://localhost:<port>` origin. If `up` reports that the environment does not allow listening on local ports or starting background processes, or Chromium cannot start, stop and report that the check was not exercised.

- [ ] **Step 2: Write the script.**

Create `.tmp/local/p1d-first-frame.mjs` (the directory `.tmp/local` is ignored by git; create it with `mkdir -p .tmp/local`):

```js
// Creates one session, opens it through a 300 ms round trip, reloads, and records what the page shows from the commit of the
// reload until it is ready (rows, status Ready and an enabled editor, as the runner defines it). Environment: P1D_PROVIDER (default
// claude), P1D_OUT (screenshot path).
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startLatencyProxy } from '../../packages/agent-remote-lab/performance/latency-proxy.mjs';

const root = process.cwd();
const provider = process.env.P1D_PROVIDER ?? 'claude';
const out = process.env.P1D_OUT ?? '.tmp/local/p1d-first-frame.png';
const run = (...args) => JSON.parse(execFileSync('agent-remote-controller-dev', args, { cwd: root, encoding: 'utf8', timeout: 180_000 }));
const { origin: direct } = JSON.parse(execFileSync('pnpm', ['--silent', 'local', 'status', '--json'], { cwd: root, encoding: 'utf8' }));

// One real turn through the repository's own helper, which waits for the reply and tolerates the first moments of a new session.
const turn = join(root, '.agents/skills/prepare-arc-local/scripts/cli-turn.mjs');
const { address } = JSON.parse(execFileSync(process.execPath, [turn, provider, 'Reply with the single word OK.'], { cwd: root, encoding: 'utf8', timeout: 300_000 }).trim().split('\n').at(-1));
const link = run('session', 'link', address).url;

const proxy = await startLatencyProxy({ target: direct, rttMs: 300 });
const recorder = `(() => {
  const log = []; let last = '';
  const read = () => ({ t: Date.now(), rows: document.querySelectorAll('.agent-timeline-entry').length,
    label: document.querySelector('.lab-conversation-status')?.textContent ?? '',
    placeholder: [...document.querySelectorAll('.lab-empty-state h3')].map(node => node.textContent).join('|'),
    composer: (editor => !editor ? 'absent' : editor.getAttribute('aria-disabled') === 'true' || editor.getAttribute('contenteditable') === 'false' ? 'disabled' : 'enabled')(document.querySelector('[data-testid="prompt-input"]')) });
  const sample = () => { const state = read(); const key = JSON.stringify({ ...state, t: 0 }); if (key !== last) { last = key; log.push(state); } };
  new MutationObserver(sample).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  setInterval(sample, 20);
  window.__p1d = { log, read };
})();`;
const { chromium } = createRequire(join(root, 'packages/agent-remote-lab/package.json'))('@playwright/test');
const browser = await chromium.launch({ headless: true });
let failure;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await page.addInitScript(recorder);
    await page.goto(link.replace(direct, proxy.origin), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const isReady = state => state.rows > 0 && state.label === 'Ready' && state.composer === 'enabled';
    const poll = async predicate => { for (let attempt = 0; attempt < 2400; attempt++) { const state = await page.evaluate(() => window.__p1d.read()).catch(() => undefined); if (state && predicate(state)) return state; await delay(25); } throw new Error('The page never reached the expected state.'); };
    await poll(isReady);
    await delay(3000); // the display observer saves after two seconds; the store writes behind it
    await page.reload({ waitUntil: 'commit' });
    const start = Date.now();
    let contentAt, shot = false;
    for (let attempt = 0; attempt < 2400; attempt++) {
      const state = await page.evaluate(() => window.__p1d.read()).catch(() => undefined);
      if (state && state.rows > 0 && contentAt === undefined) { contentAt = Date.now() - start; if (!shot) { await page.screenshot({ path: out }); shot = true; } }
      if (state && isReady(state)) break;
      await delay(25);
    }
    const readyAt = Date.now() - start;
    const log = await page.evaluate(() => window.__p1d.log);
    const opening = ['Opening session', 'Loading conversation', 'Awaiting Agent', 'Start with a Provider'];
    const mounted = log.findIndex(state => state.label || state.placeholder || state.rows > 0);
    const since = log.slice(Math.max(0, mounted));
    const openingStates = since.filter(state => opening.some(text => state.label.includes(text) || state.placeholder.includes(text)));
    const blankStates = since.filter(state => state.rows === 0);
    const summary = { address, contentAtMs: contentAt, readyAtMs: readyAt, openingStates: openingStates.length, blankStatesSinceMount: blankStates.length, proxy: proxy.stats(), screenshot: out };
    console.log(JSON.stringify(summary, null, 2));
    if (contentAt === undefined) failure = 'No row was ever shown after the reload.';
    else if (openingStates.length) failure = `An opening label was shown: ${JSON.stringify(openingStates[0])}`;
    else if (blankStates.length) failure = 'A state without rows was shown after mount.';
    else if (!(readyAt - contentAt >= 150)) failure = 'The rows were not shown clearly before the page was ready: the device store did not provide the first frame.';
    else if (!proxy.stats().upgrades) failure = 'No WebSocket crossed the latency proxy.';
  } finally {
    await context.request.post(proxy.origin + '/auth/logout', { headers: { origin: proxy.origin, 'content-type': 'application/json' }, data: '{}', timeout: 10_000 }).catch(() => {});
    await context.close().catch(() => {});
  }
} finally { await browser.close(); await proxy.close(); }
if (failure) { console.error(failure); process.exit(1); }
```

- [ ] **Step 3: Run it.**

Run: `node .tmp/local/p1d-first-frame.mjs` (Bash timeout 400000)
Expected: prints a JSON summary with `openingStates: 0`, `blankStatesSinceMount: 0`, `contentAtMs` at least 150 ms smaller than `readyAtMs`, and `proxy.upgrades` of at least 1; exit code 0. A real model turn creates the session, which can take a minute.

- [ ] **Step 4: Look at the screenshot and say what it shows.**

Open `.tmp/local/p1d-first-frame.png`. It was taken the moment the first row appeared after the reload, while the network chain (300 ms round trip) was still in progress. Expected: the conversation's rows are on screen, the heading status reads Ready (or Working), and neither Opening session nor an empty placeholder is visible. Report what the image shows, in those terms; the file is evidence of one frame, not of the counts.

- [ ] **Step 5: Stop the instance when nobody needs it.**

Run: `pnpm local down` (Bash timeout 120000)
Expected: the instance stops; state is kept.

---

### Task 5 (final, depends on P1-B3a and on P1-C2's first journal-capable provider): Measure the three arms under latency

**This task cannot start until both have landed.** P1-B3a provides local journals (`ARC_LOCAL_JOURNALS=1`) and the per-provider smart-reading switch; P1-C2 provides a development Controller that publishes a provider's journals. It is last because the smart arm needs both. Task 3 of this plan must also have landed.

**Files:**
- Create: `docs/superpowers/plans/2026-11-15-p1d-results.md`
- Modify: `packages/agent-remote-lab/compatibility.json` (generated)

- [ ] **Step 1: Check the preconditions and name the provider.**

Run:

```bash
grep -rl "ARC_LOCAL_JOURNALS" scripts docs/local-development.md
grep -n "smart-reading" packages/agent-remote-hosted/src/broker.ts | head -3
grep -rl "journal_open" packages/agent-host/src --include='*.ts' | grep -v "\.test\." | head -3
grep -rln "itemIdentity: 1" packages --include='*.ts' | grep -v "\.test\." | grep -v node_modules | head -5
```

Expected: each command prints at least one file (the Controller's publisher from P1-C1, and the provider adapter that declares `journal: { itemIdentity: 1 }` in P1-C2). If any prints nothing, P1-B3a or P1-C2 has not landed: stop and report that the smart arm cannot be measured yet. (The control and crude arms do not need them: Steps 2 to 4 measure those two, and the summarizer of Step 6 reports whatever files exist.)

Set the provider that P1-C2 made journal-capable (its plan names it; it is the provider whose development-Controller journals exist) for the rest of this task:

```bash
export SMART_PROVIDER=<provider id named by P1-C2, for example codex>
export REPO=/Users/xian/projects/agent-remote-control/.worktrees/im-session-service
export RUNNER=$REPO/packages/agent-remote-lab/performance/local-baselines.mjs
cd $REPO && mkdir -p .tmp/p1d
```

- [ ] **Step 2: Record the two builds.**

Run:

```bash
cd $REPO
export CANDIDATE=$(git rev-parse HEAD)
export BASE=$(git rev-parse "$(git log --format=%H --grep='^feat(web): move the browser database to version 3 for the device store' -n 1)^")
echo "candidate $CANDIDATE"; echo "control   $BASE"
```

Expected: two different commit ids. `BASE` is the commit before the first P1-D commit, the build today's path comes from.

- [ ] **Step 3: Start the control instance.**

Run:

```bash
cd $REPO
git worktree add .worktrees/p1d-control "$BASE"
cd .worktrees/p1d-control && pnpm install --offline --ignore-scripts && unset ARC_LOCAL_JOURNALS && pnpm local up
```

(Bash timeout 600000.) Expected: the control instance starts on its own port. Create its sessions, then list the ones of the measured provider:

```bash
cd $REPO/.worktrees/p1d-control && node $REPO/packages/agent-remote-lab/performance/create-p1d-sessions.mjs
export CONTROL_ORIGIN=$(cd $REPO/.worktrees/p1d-control && pnpm --silent local status --json | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).origin)")
export CONTROL_SESSIONS=$(cd $REPO/.worktrees/p1d-control && agent-remote-controller-dev session list --limit 50 | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).sessions.map(item => item.address).filter(address => address.split('/')[1] === process.argv[1]).join(','))" "$SMART_PROVIDER")
echo "$CONTROL_ORIGIN $CONTROL_SESSIONS"
```

(Bash timeout 600000; the session creator runs real model turns.) Expected: an origin and at least two session addresses of the provider.

- [ ] **Step 4: Define the run function and measure the control and crude arms.**

Run:

```bash
cd $REPO
run_arm() { # arm, directory of the instance's checkout, sessions
  local arm="$1" dir="$2" sessions="$3"
  for condition in 1x 4x rtt100 4x-rtt100; do
    local throttle=1 rtt=0
    case "$condition" in 4x) throttle=4;; rtt100) rtt=100;; 4x-rtt100) throttle=4; rtt=100;; esac
    (cd "$dir" && node "$RUNNER" --label "$arm" --throttle "$throttle" --rtt "$rtt" --sessions "$sessions" --scenarios open-known,open-fresh,restart-continuity --reps 3 --out "$REPO/.tmp/p1d/$arm-$condition.json") || return 1
  done
}
run_arm control "$REPO/.worktrees/p1d-control" "$CONTROL_SESSIONS"
(cd "$REPO/.worktrees/p1d-control" && pnpm local down)
```

(Bash timeout 600000 per call; run each condition as its own call if the outer deadline would be exceeded: copy the body of the loop for one `condition` at a time.) Expected: four files `.tmp/p1d/control-<condition>.json`, each with `scenarios` for the three scenarios and, for latency conditions, `proxy.upgrades` greater than 0 and no `invalid`.

The control instance is stopped (last line above): only one instance runs while an arm is measured, so two never compete for the machine. Now the crude arm on this checkout (journals off, as the control but with the P1-D build):

```bash
cd $REPO && unset ARC_LOCAL_JOURNALS && pnpm local up
node packages/agent-remote-lab/performance/create-p1d-sessions.mjs
export SESSIONS=$(agent-remote-controller-dev session list --limit 50 | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).sessions.map(item => item.address).filter(address => address.split('/')[1] === process.argv[1]).join(','))" "$SMART_PROVIDER")
run_arm crude "$REPO" "$SESSIONS"
pnpm local down
```

(Bash timeout 600000 per call, split by condition as above.) Expected: four files `.tmp/p1d/crude-<condition>.json`.

- [ ] **Step 5: Turn smart reading on and measure the smart arm.**

Run:

```bash
cd $REPO && export ARC_LOCAL_JOURNALS=1 && pnpm local up --no-build
HOST=$(pnpm --silent local api v1/remote/hosts | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).hosts[0].id)")
pnpm --silent local api "v1/remote/hosts/$HOST/smart-reading" --method PUT --data "{\"providerId\":\"$SMART_PROVIDER\",\"enabled\":true}"
```

(Bash timeout 600000.) Expected: the last command prints `{"providers":["<provider>"]}`. Every session of that provider must have a journal before it is measured, so open each once in a browser context (the runner's first open of each session does this and discards it) and send each a tiny turn so the Controller publishes:

```bash
for address in $(echo "$SESSIONS" | tr ',' ' '); do agent-remote-controller-dev session send "$address" "Reply with the single word OK."; done
sleep 20
run_arm smart "$REPO" "$SESSIONS"
```

(Bash timeout 600000 per call, split by condition.) Expected: four files `.tmp/p1d/smart-<condition>.json`, whose samples carry `journalServed: true`. A sample without it saw no `session_control` of revision `relay-pending`, was served by the Controller, and the summary excludes it and reports `used/total`; if every sample is excluded the smart arm is not measured: check the switch (`GET v1/remote/hosts`) and that the sessions have journals before repeating. The restart scenario restarts the instance with `pnpm local up --no-build`, which keeps `ARC_LOCAL_JOURNALS=1` because it is exported in this shell.

- [ ] **Step 6: Write the results.**

Run:

```bash
cd $REPO
{
cat <<EOF
# P1-D results: T1, T2 and T6 under 4x CPU and a 100 ms round trip

These numbers hold the IM session service's client work to the revised targets ([design](../specs/2026-11-15-im-session-service-design.md), T1, T2 and T6). They come from \`packages/agent-remote-lab/performance/local-baselines.mjs\` with \`--rtt\` and \`--throttle\`, the same runner for every arm; the P0 loopback floor is in [the baselines](2026-11-15-p0-baselines.md).

## What these numbers are, and are not

- **Three arms.** \`control\` is the build before P1-D (\`$BASE\`), today's path. \`crude\` is the P1-D build (\`$CANDIDATE\`) with journals off: the device store alone. \`smart\` is the P1-D build with \`ARC_LOCAL_JOURNALS=1\` and smart reading on for \`$SMART_PROVIDER\`: the device store, journal-served reads and the Relay's attach shortcut. Only sessions of \`$SMART_PROVIDER\` are measured in every arm.
- **Four conditions.** No emulation, 4x CPU slowdown, a 100 ms emulated round trip, and both. The round trip is half a round trip each way on every HTTP exchange and WebSocket byte through a delaying proxy; connection setup is not modelled, and there is no Cloudflare hop or real Relay storage, so a real network is slower still.
- **Counted measures.** T1 counts observed states (the observer records every change at 8 ms resolution) from the moment the conversation component mounts: states with an opening label and states without rows. T2 is timed from the first \`attach\` request. T6 marks every row node and counts those still in the document after the instance restart (the Relay and the Controller restart together; journals survive in \`journals.sqlite\`).
- **Tiny sessions, small n.** Sessions have 2 to 3 real turns and one long tool output (P0 layout); n is stated in each table, and p95 over 10 to 15 samples is nearly the maximum.
- T3, T4 and T5 are not measured here. Production pages, a real Edge browser and real tab switching are not measured.
- Raw data: \`.tmp/p1d/*.json\` (not committed; each sample keeps its observer log and request counts).

EOF
node packages/agent-remote-lab/performance/summarize-p1d.mjs .tmp/p1d
} > docs/superpowers/plans/2026-11-15-p1d-results.md
tail -n 30 docs/superpowers/plans/2026-11-15-p1d-results.md
```

(Bash timeout 120000.) Expected: the results document exists with three tables and a `### Verdicts` list; each verdict reads `met` or `not met` with its numbers. Read the document. A target that is `not met` stays in the document as measured; add one sentence under the verdicts naming it and the arm and condition it failed in, and tell the owner. Do not change a target or a threshold to make a verdict pass.

- [ ] **Step 7: Stop the instances and remove the control worktree.**

Run:

```bash
cd $REPO && unset ARC_LOCAL_JOURNALS && pnpm local down
cd $REPO && git worktree remove --force .worktrees/p1d-control
```

(Bash timeout 300000.) Expected: this checkout's instance stops (the control and crude instances were stopped after their arms); the control worktree is removed (its instance state under `~/.agent-remote-control-dev/instances/` is kept; `pnpm local remove --yes` would delete it and needs the user's say-so).

- [ ] **Step 8: Update and check the compatibility digest.**

Run: `pnpm compatibility:update && pnpm compatibility:check` (Bash timeout 300000)
Expected: exit code 0 for both. The digest changes because the lab's performance scripts and the hosted broker changed; no protocol contract did.

- [ ] **Step 9: Verify on the local instance, smart path, with a headless screenshot.**

Follow `.agents/skills/prepare-arc-local/SKILL.md` again: this checkout's instance only.

Run: `export ARC_LOCAL_JOURNALS=1 && pnpm local up && P1D_PROVIDER=$SMART_PROVIDER P1D_OUT=.tmp/local/p1d-first-frame-smart.png node .tmp/local/p1d-first-frame.mjs` (Bash timeout 700000; if `.tmp/local/p1d-first-frame.mjs` is missing, Task 4 Step 2 creates it)
Expected: the summary of Task 4 Step 3 (`openingStates: 0`, `blankStatesSinceMount: 0`, content at least 150 ms before ready, WebSockets through the proxy); exit code 0.

Open `.tmp/local/p1d-first-frame-smart.png` and say what it shows, as in Task 4 Step 4. Then: `unset ARC_LOCAL_JOURNALS && pnpm local down` (Bash timeout 120000).

- [ ] **Step 10: Commit.**

```bash
git add docs/superpowers/plans/2026-11-15-p1d-results.md packages/agent-remote-lab/compatibility.json
git commit -m "docs: measure T1, T2 and T6 under latency against today's path" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-review

**Brief coverage.**

- Latency option in `local-baselines.mjs` as a delaying proxy so WebSocket frames are delayed too: Task 1 (proxy, its test over real HTTP and WebSocket) and Task 2 (`--rtt`, the validity guard).
- Re-measure T1, T2 and T6 at 4x CPU and with a 100 ms round trip, today's path as the control group, same runner: Task 5 (three arms by four conditions, one runner file run from each instance's checkout).
- Counted conditions (labels, blank states, rows re-keyed) and clock thresholds only in the runner: Task 2 Step 5 and the summarizer; the deterministic tests are in the first plan.
- The final task depends on P1-B3a and on P1-C2's first journal-capable provider and is last: stated at the top and in Task 5.
- Compatibility update, check, then the local-instance check with a headless screenshot: Task 5 Steps 8 and 9 (and Task 4 for the crude path, which needs neither dependency).
- The gap between the design and the code found while planning (the `attach` route always asks the Controller, so T2 is unreachable and an offline Host refuses the open of a journal-served conversation): Task 3.

**Placeholder scan.** Every code step shows its code. The only values the executor supplies are `SMART_PROVIDER` (the provider P1-C2 enabled, named by that plan) and the two build ids, which Step 2 computes.

**Type and name consistency.** `startLatencyProxy({ target, rttMs })` returns `{ origin, stats, close }` (Task 1) and is used with exactly those names by the runner (Task 2 Steps 2 and 6) and by the verification script (Task 4). The result fields `contentSinceMountMs`, `contentSinceAttachMs`, `openingLabelFrames`, `blankFramesSinceMount` (runner, Task 2 Step 5) are the names `summarize-p1d.mjs` reads (Step 8). `rows` (`{ total, alive }`, Step 3) is what the summarizer reads for T6. `journalSessions.serves(hostId, providerId, sessionKey)` in Task 3 is B3a's signature.

**Risks the implementer should watch.**

- The proxy rewrites the origin and host headers and the redirect `Location`; any absolute URL the instance puts in a JSON body would still name the instance directly. The validity guard (no WebSocket crossed the proxy) and the session-link check catch the two ways a run could bypass it; Task 4 exercises it on the real page before Task 5 relies on it.
- Tasks 3 and 5 depend on landed plans whose code this worktree does not contain yet (P1-B3a, P1-C2). Task 3 was written against B3a's plan text (`serves` with three arguments); if B3a changed that signature in review, change the one call in `attachedFromJournal`, nothing else depends on it.
- T6 is measured over a whole-instance restart (P0's limit), not a Controller-only restart; the first plan's real-transport test covers the Controller-only case.

## Notes for the roadmap

- **P1-C3: the full attach shortcut.** While its Host is online, a journal-served session still attaches through the Controller, because the check-only attach of a native take-over (`resumeNative`, `App.tsx:396`) must see `native_session_owned` and only the Controller knows the native owner. Once P1-C3's native-owner work lets the Relay answer that from the journal's head (it answers the client's acquire with the pending state and the owner), the Relay can answer every `attach` of a bound, journal-served session from its binding, and T2's first request no longer waits for the Controller. Until then the smart arm's T2 includes one Controller attach.
- **P2: the echo sync.** `watchMessageEchoes` still reads pages over HTTP, which the Relay forwards to the Controller; it moves with the operation queue.
- **P2 (T5): labels across restarts.** The runner counts opening-label states; the connection labels `Reconnecting`, `Synchronizing` and `Checking access` after the first ready are counted when P2 removes them.

