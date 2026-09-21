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
