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
