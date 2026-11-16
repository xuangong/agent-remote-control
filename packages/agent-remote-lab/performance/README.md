# Conversation typing benchmark

Build the workspace first, then run from `packages/agent-remote-lab`:

```sh
pnpm exec vite build --config performance/vite.config.ts
node performance/measure.mjs > .tmp/typing-results.json
ARC_PERFORMANCE_RUNS=1 ARC_PERFORMANCE_COUNTERS=1 ARC_PERFORMANCE_RICH=1 node performance/measure.mjs > .tmp/typing-counters.json
```

The runner starts an ephemeral loopback HTTP server, launches installed Chrome, and closes both afterward. It has a four-minute outer deadline and thirty-second action deadlines. No real account or native session is used. Do not run other CPU-heavy tests concurrently.

It measures five runs at 100/500/1,000 **loaded entries**, a 390 x 844 touch viewport, and 4x CPU slowdown. Twenty characters are typed 70 ms apart. Report median cumulative TaskDuration, not per-keystroke latency or INP. Rich mode measures the image-capable editor with text only. Instrumented runs count entry geometry reads, database opens, and puts; measure timing separately without counters.

For a prebuilt baseline, pass its output directory and relative HTML entry as arguments. Preserve baseline and candidate JSON with browser version and commit hashes. The fixture retains the production App and uses an inert activity transport to exclude reconnect noise. This is a synthetic scaling comparison; real iPhone standalone keyboard/suspension and battery consumption still require device verification.

## Implementation results

Five-run medians with Chrome 153.0.8010.53 and the configuration above:

| Loaded entries | Baseline task time | Optimized task time | Reduction |
| --- | ---: | ---: | ---: |
| 100 | 303.314 ms | 144.508 ms | 52.4% |
| 500 | 826.227 ms | 205.975 ms | 75.1% |
| 1,000 | 1,383.858 ms | 231.265 ms | 83.3% |

The baseline is `db2df7974d0749ce4475008be3dc54a60f94f658`; the candidate is the implementation commit containing these results on `perf/frontend-interactions`. Raw samples are in `results/`. The uninstrumented timing run preceded final storage error hardening and the authentication font fix. A final rich-editor counter run confirms zero timeline-entry rectangle reads, zero repeated IndexedDB opens, and five metadata puts for twenty characters at every history size. Initial hydration/open is outside the measured window.

The 1,000/100-entry total-task ratio is 1.60, slightly above the aspirational 1.50 target. DOM count remains unchanged (21,760 nodes at 1,000 entries); the renderer does not truncate history or virtualize visible conversation content. This workload demonstrates lower main-thread work, not a measured battery-life improvement or real-device INP.

The authentication initial JavaScript decreased from about 1.07 MB to about 280 KB decoded; a browser regression enforces a 300 KB entry budget. The conversation renderer loads after authentication. This does not reduce total downloaded code after opening a conversation.

## Verification

- Web: 41 test files / 353 tests passed, followed by 9 focused persistence tests after adding transaction atomicity coverage (354 total tests covered).
- Lab: 90 files / 584 tests passed, with six existing skipped cases. The separately configured native Codex host-process test was excluded after its explicit missing-`BORGEE_CODEX_TEST_EXECUTABLE` failure; this frontend work does not claim native-runtime verification.
- Chromium desktop/mobile: image and authentication suites, 24 passed. Earlier real-transport pending-send, Ask/Side lifecycle, and Markdown reading regressions passed. Two old test expectations needed correction: sending during recovery is enabled by design, and the digit font must be a same-origin asset under the production CSP.
- WebKit mobile: image suite 8 passed; Markdown reading, late image layout, and viewport rotation suite 3 passed.
- Workspace build, typecheck, compatibility update/check, and whitespace checks passed.

The initial broad Lab run also caught a stale implementation digest; regenerating compatibility metadata resolved those assertions before the successful rerun. No real account, production session, controller, or daemon was changed for validation.

## Storage and rollback

IndexedDB version 2 keeps the existing metadata document shape and moves bytes into an `images` object store. Readers accept old embedded bytes and new references. New records store ArrayBuffer bytes directly: WebKit testing reproduced an unfinished transaction after Blob preparation failed. Conversion is cached per Blob; normal caption edits use key lookup and never rewrite retained bytes. An aborted image write also aborts its metadata, and a subsequent retry is covered by a real IndexedDB-behavior unit test.

After deployment, rollback must preserve this version-2 reader/writer module. A version-1-only bundle cannot open the upgraded database. Do not delete drafts or downgrade the database. The migration test covers old embedded drafts and both readable representations; packaging a rollback build remains a release task.

Cache limits are soft: mounted Main/Side/Ask panes, uncertain/failed outgoing messages, and dirty or failed-to-save drafts take priority over eviction. Payload estimates are not heap measurements. Real iPhone home-screen keyboard behavior, suspension/resume, and energy impact remain device acceptance work.

## Long-conversation scrolling

The `e2e/timeline-scroll.browser.ts` regression renders 1,200 paragraphs with inline formatting and the production `useTimelineScroll` hook. At paragraph 1,000 in a 390px viewport, baseline `487cdfa` made 9,006 `Range.getClientRects()` calls for one `captureReadingText` operation in both Chromium and WebKit. The current path makes 5 calls and saves the same anchor in this fixture.

The intermediate implementation in `f5feb3a` used document-wide caret hit testing. Although that reduced geometry reads inside one long reply, full-App scroll traces showed hit-testing cost growing sharply with the number of loaded messages. The renderer now locates the visible Markdown block inside the already identified message, using binary search within vertical block containers, and measures the visible character locally. It never invokes document caret hit testing. Unrecognized layouts retain a text-walk fallback; saved anchor format, text selection, and resize/restore behavior remain compatible. Mobile entries only receive a transform while their timestamp action is revealed, avoiding an idle identity transform on every message.

Run the bounded browser regressions from the repository root:

```sh
pnpm test:preview-browser
```

The browser suite checks long paragraphs, nested lists, tables, width changes, earlier content growth, text selection, and independence from document hit-test APIs. Timestamp interaction tests verify that swipes still reveal actions and return to an untransformed state, while preserving native vertical and code scrolling.

### Full-App bidirectional benchmark

After building the workspace, run from `packages/agent-remote-lab`:

```sh
pnpm exec vite build --config performance/vite.config.ts
node performance/scroll.mjs > performance/results/scroll-optimized.json
# A separately preserved build can be measured with the same runner:
node performance/scroll.mjs .tmp/scroll-baseline-build > performance/results/scroll-baseline.json
```

The runner uses the production App with an inert transport, 100/1,000/3,000 loaded messages, a 390 x 844 touch viewport, and 4x CPU slowdown. Each of three fresh-page runs starts halfway through the conversation, then sends real touch scroll gestures 1,800px upward and downward at 1,400px/s. It rejects gestures that move less than 1,000px. Initial hydration is outside the measurement; no other CPU-heavy test should run concurrently. A five-minute process deadline and 45-second action deadlines bound each run.

Report per-direction median cumulative main-thread task and script time, and the median of each run's rAF interval p95. These are synthetic desktop Chromium comparisons, not input latency, real-iPhone FPS, or a guarantee that arbitrary history sizes remain smooth. The full history remains mounted; DOM and paint costs still grow with loaded content.

Three-run medians with Chromium 151.0.7922.34. Baseline: `f5feb3aa8fabb1b2d90f4728c0a9a30440a941e5`; candidate: the implementation commit containing these results on `perf/long-timeline-scroll`. Raw samples: `results/scroll-baseline.json` and `results/scroll-optimized.json`. Values below are baseline / optimized, in milliseconds.

| Loaded entries | Direction | Task time | Script time | rAF interval p95 |
| --- | --- | ---: | ---: | ---: |
| 100 | up | 64.9 / 29.6 | 41.9 / 15.1 | 35.4 / 35.4 |
| 100 | down | 29.1 / 18.4 | 16.0 / 5.3 | 34.5 / 36.5 |
| 1,000 | up | 226.1 / 72.1 | 143.6 / 12.9 | 41.8 / 40.1 |
| 1,000 | down | 190.9 / 49.6 | 125.5 / 7.3 | 36.5 / 35.0 |
| 3,000 | up | 909.6 / 180.0 | 685.3 / 21.7 | 106.9 / 35.0 |
| 3,000 | down | 738.7 / 159.2 | 511.6 / 15.8 | 50.5 / 37.7 |

Validation for this change: 16 scroll-hook unit cases, 8 Chromium/WebKit anchor cases, 8 Markdown reading cases, 12 timestamp interaction cases, and 24 mobile viewport cases passed (68 total; 7 platform-specific cases skipped). Workspace Relay build, Web/Lab typechecks, compatibility update/check, and whitespace checks passed. Real-device iPhone acceptance remains separate.


## Streaming long conversations

The next optimization keeps unchanged projected entries by reference, copies only the entry being coalesced, and memoizes the complete conversation row. History replacement still clones authoritative incoming data. Tests freeze prior snapshots and verify assistant, reasoning, tool, todo, append, and earlier-history behavior. Renderer extensions are still evaluated by the timeline so registry changes are not hidden by row memoization. Event-only callbacks retain stable identities and invoke the latest committed handler; callbacks retained across session-scope changes, removal, or unmount are rejected. Render-time link and child resolvers remain reactive on rows that use them. The row-isolation test recreates App-like callbacks during updates and checks that an unchanged row still invokes the latest action.

Timestamp gestures now share one set of native listeners per timeline, with one active reveal. Code/table scrolling, vertical gestures, selection, screen-edge navigation, and edit actions keep their existing behavior. Local Markdown images resolve/request Host resources only after approaching within 1,200px of their scroll viewport. Images share an intersection observer per scroll container; already loaded bytes and dimensions remain available when scrolling away. Browsers without IntersectionObserver keep eager loading. This does not evict resource bytes or virtualize conversation text.

After building the workspace, run from `packages/agent-remote-lab`:

```sh
pnpm exec vite build --config performance/vite.config.ts
node performance/streaming.mjs > performance/results/streaming-optimized.json
node performance/streaming.mjs .tmp/streaming-baseline-build > performance/results/streaming-baseline.json
```

This fixture uses the real AgentReplica and LabWorkbench, excluding the surrounding App/account/transport layers. It loads 100/1,000/3,000 messages and applies 40 assistant deltas at 75ms intervals while performing real touch gestures 1,800px up and down. Three fresh-page runs use a 390 x 844 viewport and 4x CPU slowdown. The runner waits for all deltas to render and rejects gestures moving less than 1,000px. It has a five-minute outer deadline and 45-second action deadlines. The baseline build is `db7b0aa79c135dfd36f14da14df3e1b59cd81935`; the candidate is the commit containing these results on `perf/streaming-timeline`.

Three-run medians with Chromium 151.0.7922.34 (milliseconds):

| Loaded entries | Task before / after | Script before / after | rAF interval p95 before / after |
| --- | ---: | ---: | ---: |
| 100 | 410.2 / 254.3 | 239.1 / 109.7 | 35.5 / 37.6 |
| 1,000 | 2,398.9 / 722.9 | 1,675.7 / 216.1 | 74.4 / 38.4 |
| 3,000 | 6,774.7 / 1,824.0 | 4,650.3 / 506.6 | 220.2 / 59.1 |

The 3,000-message workload uses 73.1% less cumulative main-thread task time and 89.1% less script time. Elapsed time decreases from 6,789ms to 3,349ms, close to the scheduled stream duration. These are synthetic scaling results, not iPhone frame rates or measured input latency. DOM size, layout, paint, and render-model traversal still grow with loaded history. One candidate run still recorded a 426ms maximum rAF interval; reduced work does not guarantee that every frame is smooth.

The full-App static scroll runner was also repeated. At 3,000 entries, contemporary baseline / candidate median task times were 191.3 / 190.5ms upward and 171.9 / 189.0ms downward; script times were 24.3 / 18.0ms and 14.3 / 13.1ms. Downward total-task samples overlap (baseline 150.9-194.3ms, candidate 170.4-192.1ms); rAF p95 stayed around 35-37ms. These static samples preceded final event-handler identity hardening. This change primarily improves streaming work, and does not claim an additional static-scroll speedup. Raw data are `results/scroll-streaming-baseline.json` and `results/scroll-streaming-optimized.json`.

### Containment experiment: not enabled

`node performance/containment.mjs` compares the existing renderer with an experimental per-entry `content-visibility: auto; contain-intrinsic-size: auto 360px` rule injected before page startup. With 1,000 entries it reads the midpoint, rotates the viewport twice, and records the same paragraph's position. A three-minute outer deadline and 30-second action deadlines bound the probe. No production stylesheet uses this rule.

The initial Chromium probe showed 0px drift without containment and -1px with it. WebKit 26.5 showed 21px without containment and 64px with it; estimated document height also changed from about 316,500px to 367,000px. This is an exploratory paragraph-position sample, not a complete character-anchor acceptance test. It demonstrates that enabling containment is not a proven drop-in change for this layout. Grouped containment, dynamic height estimates, selection, browser find, and restoration would need separate design and validation. The experiment remains disabled; raw results are in `results/containment-experiment.json`.

### Validation

- Web: 46 files / 385 tests passed, including reference preservation, row update isolation, existing-row actions, observer identity changes, cleanup, and no-observer fallback.
- Real Relay image and browser reading-anchor tests: 12 passed across Chromium/WebKit, including distant resources staying unrequested until approached.
- Timestamp interaction tests: 13 passed, 7 platform-specific skips; listener count stays one per timeline.
- Markdown reading: 8 passed, 1 platform-specific skip. The delayed-image fixture first approaches the image to start its request, then reads below it before metadata arrives, matching lazy request behavior.
- Mobile viewport: 24 passed across Chromium/WebKit, covering keyboard recovery and orientation changes.
- Relay build, Web/Lab typechecks, compatibility metadata update/check, and whitespace checks passed. No production service, Controller, or daemon was changed.

## Bot and Window workbench (stage 6)

Stage 6 ([plan](../../../docs/superpowers/plans/2026-11-14-stage-6-performance.md)) measured the workbench as it grows and removed the waste it found. Budgets that guard it run with the suite: `src/App.render-budget.test.tsx` (render counts with 12 groups of 10 bots), `src/storage-keys.test.ts` (one storage inventory per scan), `src/components/TeamMenu.test.tsx` and `src/hooks/useTpmWork.test.tsx` (requests per minute), `src/bundle-budget.test.ts` with the build's gzip budget, and the Relay's `record-cache.test.ts` (records encoded per commit).

Timings come from two runners, neither part of the suite:

```sh
# jsdom, from packages/agent-remote-lab: shared states frames and bot switches with 120 bots
pnpm exec vitest run src/workbench-cost.local.test.tsx   # appends to .tmp/workbench-cost.log (ARC_PERFORMANCE_OUTPUT)
# the pnpm local instance, from the repository root, Chromium 1440 x 900
node packages/agent-remote-lab/performance/local-switch.mjs after
THROTTLE=4 node packages/agent-remote-lab/performance/local-switch.mjs after-4x
```

Results, before (main 8babb2b9) and after stage 6:

| Measurement | Before | After |
| --- | ---: | ---: |
| jsdom, a state frame of a bot not on screen | ~850 ms, 20 conversation renders | 6-30 ms, none |
| jsdom, switching bots | 3.3-4.0 s, 76-90 conversation renders | 100-125 ms, 5-6 |
| jsdom, Window mode, a change in one of 10 panes | 40 conversation renders | each visible pane once |
| Local instance, switch until shown (cold / warm) | 101 / 79 ms | 71 / 77 ms |
| Local instance with 4x CPU slowdown | 116 / 125 ms, task 143 / 137 ms | 98 / 109 ms, task 119 / 106 ms |
| Local instance, idle main-thread task per 10 s | 35 ms (4x: 39 ms) | 5 ms (4x: 5 ms) |
| Workbench chunk after sign-in | 1.99 MB, 600 KB gzip | 1.84 MB, 544 KB gzip |

The local instance has six bots and short conversations, so it shows the per-switch floor; the jsdom runner shows how the cost grows with the number of bots and panes. A switch spent most of its time listing browser storage (a quadratic scan through `ConversationStorage`); a frame of the shared states channel spent it re-rendering every mounted conversation.

## Bot and Window workbench (stage 7)

Stage 7 ([plan](../../../docs/superpowers/plans/2026-11-14-stage-7-stability.md)) made the workbench hold up when things fail and over time. Its guards run with the suite: `src/session-restoration.test.ts` (backoff), `src/unavailable-sessions.test.ts` and `src/App.attach-budget.test.tsx` (a missing session is asked once), and the e2e specs `e2e/bot-mode.spec.ts` and `e2e/cross-host.spec.ts` (two Hosts, an offline Host, a handoff across providers).

Attaches before (main 0ba5350c) and after, counted with fake timers:

| Measurement | Before | After |
| --- | ---: | ---: |
| A conversation whose Host answers 503 for 30 minutes | 361 attaches | 33 (at most 41 with jitter) |
| Loading a page with a session its Host reports missing (404) | 6 attaches | at most 2 |
| That session across a mode switch, an access refresh, ten state frames, three bot switches and a page resume | asked again on each remount | not asked until Retry, the Host's return or 10 minutes |
| A conversation of a Host the page knows is offline | asked, 503 `host_offline` | waits; opens when the Host is back |

Growth over time comes from two runners, neither part of the suite:

```sh
# from packages/agent-remote-lab: two in-process Controllers (fake natives, no model), headless Chromium 1280 x 720
ARC_SOAK_MINUTES=60 npx playwright test e2e/soak.spec.ts --project=chromium-desktop   # .tmp/soak.json (ARC_PERFORMANCE_OUTPUT)
# from the repository root: read-only on the pnpm local instance, with its real sessions; sends nothing
MINUTES=20 node packages/agent-remote-lab/performance/local-soak.mjs                  # .tmp/local-soak.json
```

The cross-Host soak holds 12 bots in three groups, each group with two bots on each Host, and each conversation starts with 20 turns. Every 5 s it opens the next bot. In the first half, every fourth switch sends a message, which the bot's Host answers. Every 24 switches (about two minutes) it goes to Window mode and back, and the Laptop leaves for one minute in every ten. Every minute it returns to the first bot, forces a garbage collection, and records the JS heap, DOM nodes, event listeners, open WebSockets, requests and console errors. `ARC_SOAK_SNAPSHOTS=35,60` also writes heap snapshots at those minutes.

Budgets, checked by the spec: once sends stop, the heap and DOM nodes at the end stay within 10% of five minutes into the quiet half; requests per minute in the last ten minutes stay within a quarter of the quiet half's first ten; at most 12 WebSockets; no console errors.

Results of the hour-long run on the stage 7 build (78 sends, Laptop away at minutes 10, 20, 30, 40 and 50):

| Minute | JS heap | DOM nodes | Event listeners | WebSockets |
| ---: | ---: | ---: | ---: | ---: |
| 10, sending | 22.45 MB | 11,809 | 2,566 | 2 |
| 30, sends stop | 25.20 MB | 18,267 | 3,117 | 2 |
| 35 | 25.81 MB | 18,259 | 3,117 | 2 |
| 60 | 26.16 MB | 18,256 | 3,117 | 2 |

- From minute 35 to 60 the heap grew 1.4% and the DOM not at all.
- Requests averaged 52 a minute in minutes 35-45 and 53 in minutes 50-60.
- The page never held more than two WebSockets.
- There were no console errors and no failed requests.
- Heap snapshots at minutes 35 and 60 show the page's own data did not grow: objects -62 KB, closures -70 KB, strings unchanged, detached DOM nodes 1,832 to 1,829. The difference is compiled code, which V8 was still optimizing (+428 KB), and DevTools' records of network requests (+376 KB). Those records exist only while a debugger, such as the test's, is attached.

What the soak found:
- **Sends grow conversations.** A first run that sent throughout grew from 23.5 to 26.2 MB between minutes 10 and 25, over 66 sends. That is about 60 KB a send: content, not a leak. Growth is judged after sends stop.
- **An offline Host was asked anyway.** That run also logged nine console errors, `attach` 503 `host_offline`, while the Laptop was away. A conversation of a Host the page knows is offline now waits, and opens when the Host is back.
- **Samples must show the same screen.** Which bot was on screen changed the DOM by up to 6,500 nodes (12,776 to 19,235), so every sample returns to the first bot first.
- **The fixture had limits of its own:**
  - Without the Relay's timer, the owner's one-minute grant lapsed, and the Hosts went offline at minute 1 or 2.
  - Its identity server crashed on a request body the Relay aborted under load.
  - Its sign-in lasted exactly an hour.

The local instance run (six bots with real sessions, 20 minutes, Chromium 1440 x 900, read-only):
- The heap went from 18.8 MB at minute 5 to 20.8 MB at minute 10, then stayed there (20.3 and 20.5 MB).
- DOM nodes went from 2,836 to 2,621, and listeners from 2,640 to 2,285.
- The page held at most two WebSockets.
- It made 45-76 requests a minute (mean 62).
- There were no console errors and no failed requests.


## Browser baselines on the local instance

`local-baselines.mjs` measures the browser experience of `pnpm local` (open to content, return after hidden, send, release and restart continuity, request counts, provider latencies) and writes JSON; its header lists the options and the definitions of start, content and ready. Results and the method are in `docs/superpowers/plans/2026-11-15-p0-baselines.md`, raw data in `results/p0-*.json`. The sessions it uses must exist in the instance workspace.

## Journal measurements (S3)

`local-baselines.mjs` measures the opens of Copilot sessions on the `pnpm local` instance, with the Relay's journals and the Host's smart-reading switch for `copilot` on or off (`--label journals-on`, `--label journals-off`). Run it from the repository root while the instance runs; it never starts or stops the instance itself, except that `journal-reopen-mix` runs `pnpm local up --no-build` for its Controller restarts.

```sh
node packages/agent-remote-lab/performance/local-baselines.mjs --scenarios journal-open --label journals-on --throttle 1 --out .tmp/s3-journal-open.json
node packages/agent-remote-lab/performance/local-baselines.mjs --scenarios journal-reopen-mix --label journals-on --sessions HOST/copilot/SESSION --out .tmp/s3-journal-reopen-mix.json
```

- `journal-open`: for each Copilot session, `open-known` (a first open that is discarded, then `--reps` reloads) and `open-fresh` (device storage cleared before each open). Per open it records which side answered, the Relay's windows for the session, and the bytes the page received (WebSocket frames plus API responses).
- `journal-reopen-mix`: one Copilot session, 30 reopens in a fixed order: 10 page reloads, 10 session releases then a reload, 5 Controller restarts then a reload, 5 interruptions (a turn cancelled through `session cancel`, then a release and a reload). After each it records the Relay's windows since the previous step and runs the hole check. `thresholds` applies the S3 plan's thresholds to the 30 opens.

Where the numbers come from, all metadata and no content:

- Which side answered an open: the Relay opens a Controller stream for a forwarded session (a `stream_opening` diagnostic naming the session's public agent id) and none to read a journal-served one. The runner reads the diagnostics with `agent-remote-controller-dev diagnostics --source server` after the scenario, because the Relay delivers them in batches about a second apart.
- Windows, their reasons and sizes, and the requests for bodies and older history: the Relay's `journal_window` and `journal_request` diagnostics (`agentId` is the journal's session key, `copilot:<native session id>`). Refusals and stops: `journal_quota_exceeded` and the Controller log's `journal_open_refused`, `journal_session_stopped`, `journal_session_unserved`.
- Page bytes: Chrome DevTools Protocol `Network.webSocketFrameReceived` payloads plus `Network.loadingFinished` for XHR and fetch responses. Scripts, styles, fonts and images are not counted.
- The hole check compares every user and assistant message of a full native read (`session read`, all pages) with the messages the page shows after it scrolled the conversation to its start. It compares message texts, not tool rows, and depends on the page's scroll container; treat a reported hole as a lead to confirm by reading the session.

The pure parts (statistics, diagnostics into counts, the open's side, the hole check, the thresholds) are in `journal-measurement.mjs` and tested by `src/journal-measurement.test.ts`. There is no large-session scenario: scale is covered by `packages/agent-remote-lab/scripts/journal-benchmark.mjs`.

## Measurements under latency (S4)

`--rtt MS` puts a delaying proxy (`latency-proxy.mjs`) between the headless browser and the instance. It delays every HTTP exchange and every WebSocket byte by half a round trip in each direction, rewrites the browser's origin to the instance's, and counts the WebSocket upgrades that crossed it; a run in which none crossed is marked `invalid`. The command line (`session`, `diagnostics`) talks to the instance directly. `--throttle 4` is the 4x CPU slowdown; the four conditions of the S4 plans are no emulation, `--throttle 4`, `--rtt 100` and both.

```sh
export ARC_LOCAL_JOURNALS=1   # the runner restarts the instance with `pnpm local up --no-build`; without it journals turn off
node packages/agent-remote-lab/performance/local-baselines.mjs --scenarios restart-continuity,replacement-absorbed,runtime-release,switch \
  --sessions HOST/copilot/A,HOST/copilot/B --rtt 100 --throttle 4 --reps 5 --label s4a --journal-signal flag --out .tmp/s4/s4a-4x-rtt100.json
node packages/agent-remote-lab/performance/summarize-p1d.mjs .tmp/s4
```

- **Journal-served signal.** A sample counts only when its stream was served from the Relay's journal. `--journal-signal flag`: the `negotiated` frame echoed the item-key flag (a Controller-answered stream never does). `--journal-signal meta`: the control build has no flag, so the page's `timeline_page` epochs must equal the epoch in the instance's `journals.sqlite` before and after the sample.
- **`restart-continuity`.** Every given session is open in its own page, every row node is marked, the instance restarts, and the runner counts the marked nodes still in the document and the states without rows. `--reps` restarts give `reps` samples per session.
- **`replacement-absorbed`.** Every Copilot session runs a turn whose shell command takes two minutes (the runner answers its tool approval), a draft is typed in the composer, the timeline is scrolled to its middle and every row node is marked; the instance restarts during the tool, which makes the Controller's window differ from the journal's open item, and the Relay replaces the journal (`open_item`). A sample counts only when the Relay's `journal_window` diagnostics show a `changed` or `open_item` replacement for the session. The runner reports marked nodes, composer text, focus and selection, and the offset of the first visible row.
- **`runtime-release`.** `release-continuity` for the Copilot sessions, with the Relay's windows. Copilot has no runtime to release (`released: false`), so it shows that rows are kept while nothing happens.
- **`switch`.** `local-switch.mjs` for the one `--throttle` rate, through the proxy (`ARC_ORIGIN`), with the HTTP API requests, the states that showed an opening label and the states without rows of each switch.
- **Counted T1 fields** of every open (`open-known`, `open-fresh`): `contentSinceMountMs`, `contentSinceAttachMs` (from the page's first session control request), `openingLabelFrames` and `rowlessFramesSinceMount`.
- **Sample counts.** A percentile is stated from 20 samples (10 for the conditions that restart the instance for each sample); with fewer the summary prints the maximum and the count.

`summarize-p1d.mjs` is tested by `src/summarize-p1d.test.ts`; the proxy by `src/latency-proxy.test.ts` over real HTTP and WebSocket.
