# Test gate retrospective: where the time goes

Date: 2026-11-26 local. Branch `feat/gate-resume`. Machine: the Mac mini (Apple silicon, 10 cores, 16 GiB), shared with the owner's apps and other
agents; it has 4 to 5 GiB of memory available (free + inactive + purgeable) when idle. Node 22.

Evidence: the logs of earlier gates (`/tmp/g37-*`, `/tmp/g38-*`, `/tmp/gm-*`, `/tmp/gate-merge.log`, `/tmp/gate-tc.log`) and one measured run of each
tier on its own, sampling the process tree every 2 s (resident memory, CPU) and `vm_stat`. Playwright timings come from its JSON reporter, the e2e flows
from Vitest's verbose reporter. Other agents were active on the machine during parts of the measurements (load average up to 22 during the WebKit
flows); the memory and CPU figures are therefore upper bounds for that tier, the times are not.

## 1. Per tier

| Tier | Wall time | Tests | Peak memory (process tree, + WebKit helpers) | Fall of available memory | CPU (peak / mean cores) |
|---|---|---|---|---|---|
| verify | 330 to 400 s (368 and 381 s in gates) | 13,800 unit tests in 28 packages | 3.1 GiB | 2.5 GiB | 8.2 / 2.3 |
| components | 1,133 s (18.9 min) | 1,567 runs: 1,287 passed, 280 skipped | 2.4 + 1.0 GiB | 1.6 GiB | 4.1 / 1.4 |
| preview-browser | 148 s | 73 tests, 19 files | 1.7 + 1.0 GiB | 1.1 GiB | 2.8 / 0.6 |
| e2e-chromium | 262 s | 80 flows, 22 files | 1.4 GiB | 0.7 GiB | 1.7 / 0.4 |
| e2e-webkit | 289 s | 80 flows (1 skipped) | 0.9 + 2.2 GiB | 1.0 GiB | 1.3 / 0.2 |
| smoke | 41 s `local up` + 256 s `smoke:quick` | 4 scenarios | 1.6 GiB | 0.6 GiB | 6.8 (build) / 0.3 |

Run one after another this is about 2,600 s (43 min) when nothing fails; the 55 min the owner sees includes reruns after a flake and waits. Two
facts shape everything below: the unit and browser tiers keep the CPU mostly idle (mean 0.2 to 2.3 of 10 cores), and no tier uses more than about
3.5 GiB, so the machine can do more at once than the serial gate asks of it.

### verify (about 6 to 6.5 min)

compatibility:check 1 s, arch:check 1 s, build 25 s (warm; a cold build is longer), typecheck 34 s, then the unit tests, one package at a time
(`--workspace-concurrency=1`), 333 s. Package durations: agent-remote-lab 77 s (343 files, 3,782 tests), agent-controller 56 s, agent-relay-cloudflare
47 s (pinned to one worker), agent-remote-debugger 25 s (files run one at a time), agent-provider-copilot 17 s, agent-relay-node 11 s,
agent-relay-core 8 s, everything else under 7 s. Slowest files:

| s | File |
|---|---|
| 43.4 | controller `opencode-server-supervisor.test.ts` (process project) |
| 20.2 | controller `cli-bootstrap.test.ts` (process) |
| 17.5 | controller `cli.process.test.ts` |
| 16.5 | controller `opencode-server.test.ts` (process) |
| 16.2 | `tests/native.test.ts` (provider-pi, process) |
| 15.7 | controller `cli-codex.test.ts` (process) |
| 13.6 | lab `App.succession.opening-and-refresh.test.tsx` |
| 12.4 | lab `App.succession.ask-and-reconnect.test.tsx` |
| 11.9 | controller `codex-daemon-runner.test.ts` (process) |
| 10.5 | lab `App.succession.owners-and-attachment.test.tsx` |

The process-project tests spawn real processes and wait in real time, which is why the mean CPU is 2.3 cores. They are also what fails first under
load (section 4).

### components (18.9 min; 1,113 s of it is test time)

One worker (`workers: 1`), ten projects. Every spec runs in `chromium-desktop` and `chromium-mobile` (Pixel 7), and a spec joins the phone and WebKit
projects by a `// Component projects:` line, so 87 spec files expand to 1,567 runs. Time per project: chromium-desktop 295 s (390 passed),
chromium-mobile 273 s (334), orchard-phone-webkit 179 s (175), orchard-phone-chromium 150 s (169), and six small WebKit projects 216 s in total. The
mean test takes 0.86 s, so the time is the count, not a few slow tests.

Skipped (280): not a defect. Specs that apply to one form factor call `test.skip(isMobile, ...)` or `test.skip(!phone(page), ...)`, so a spec that
runs in every project skips itself where it does not apply (chromium-mobile 102, chromium-desktop 46, the two phone projects 77, WebKit projects 49;
`ask-window` 48, `launcher-layout` 33, `desktop-panels` 19, `assistant-view` 18, `installed-desktop` 18, `session-family-resize` 18). Skipping costs 15 s
in all.

Slowest spec files (sum of their runs): assistant-inventory 92 s (188 runs), phone-settings 65 s (4 runs), image-viewer 60 s, ask-window 45 s,
image-input 44 s, session-view-responsive 43 s, assistant-conversation 40 s, view-overflow 38 s, assistant-groups 35 s, settings 33 s. Slowest tests:
phone-settings "a computer with a long unbroken name" 21.4 s in each phone project, timeline-time "reveals local timestamps" 11.7 s, phone-settings
"Computers and its pairing key" 11.2 s in each phone project, pairing-keys (two tests) 11.1 s, timeline-time "double clicking a tool title" 7.3 s,
assistant-groups 5.9 s in two projects.

Flake: `standalone-layout.spec.ts:10` in `chromium-mobile` failed once (the 06:24 gate): `bar.isVisible()` is true, then `bar.boundingBox()` is null
because the tab bar re-renders while the viewport rotates (line 49 reads it twice). It passed in every other run. The tier has no retries, so the
one flake cost a 19-minute rerun. In this task's runs one more failed under three workers and a load average of 16:
`chat-scroll-memory.spec.ts` in `orchard-phone-webkit` (a 5 s `expect` timed out); it passes alone in 1.6 s.

### preview-browser (148 s)

19 `.browser.ts` files, one Vitest worker, each starting its own Vite server on port 0. 73 tests; nothing skipped. Mean CPU 0.6 cores. Nothing to cut
that does not drop a test.

### e2e flows (262 s Chromium, 289 s WebKit; 22 files, 80 flows)

`fileParallelism: false, maxWorkers: 1`: one flow file at a time, one stack per file (free port, temporary directory). Time per file: e15b-bot-thresholds
38 s (two flows, one of them 30.9 s), e15-bots 38 s (9), e3-reconnect-and-return 29 s (9), e15d-session-becomes-bot 20 s, e9-quiet-open 13 s,
e11-settings 13 s, e6-groups-and-modes 11 s, e10-assistant-conversation 10 s, e7-share-and-team 9 s, e5-succession 8 s. The CPU is mostly idle (0.2 to
0.4 cores): the flows wait for real events. Measured here, `--fileParallelism --maxWorkers=2` runs the same 80 flows in 134 s (Chromium) and 142 s
(WebKit), all passing, with 0.7 and 1.1 GiB less memory than the sum of two runs. The harness is safe for it: every stack takes a free port and its own
`mkdtemp` directory (`packages/agent-e2e/stack/stack.ts`). The WebKit run skips one flow.

### smoke (297 s)

`pnpm local up` (41 s warm, 6.8 cores while it builds the Relay, devbox and Workbench) then `smoke:quick`: M1 71 s, M2 66 s, M4 27 s, M7 91 s. The
scenarios run in real time (network emulation, restarts, hidden pages), mean CPU 0.3 cores. They share one local instance, so they cannot overlap each
other; `local up` rewrites `dist` for the instance, so nothing else may read the outputs while it runs.

Two things seen in the other gate on this machine, not investigated: one `smoke:quick` reported "1 failed or errored" of 4 scenarios, and a
`run-smoke.mjs` process stayed alive about five minutes after it had written its report.

## 2. Duplicated coverage

By topic (names of files, not a comparison of assertions): the same behaviour is asserted in more than one tier.

| Behaviour | jsdom unit | Component tier (runs) | e2e flow | Other |
|---|---|---|---|---|
| Settings and Computers page | 10 lab test files | `settings` 44, `phone-settings` 4 (65 s), `pairing-keys` 4 | E11 (x2 browsers), E1 pairing | relay-core pairing tests |
| Push and notifications | 1 | `push-notifications`, `session-notifications` | E14b (x2) | relay push tests |
| Installed app / standalone | 1 | `installed-app`, `installed-desktop`, `standalone-layout` (3 specs x projects) | E14 (x2) | |
| Groups | 1 | `assistant-groups` 20 (35 s) | E6, E6b (x2) | |
| Navigation and layout | 8 + 5 | `navigation`, `workbench`, `phone-layout`, `desktop-panels` | | |
| Bots | many | `bot-audit`, `temporary-bots`, `bot-scroll` | E15, E15b, E15c, E15d, E7 (x2) | bots scenarios |

Inside the component tier the structural overlap is larger: `chromium-mobile` (Pixel 7, 412 x 915) and `orchard-phone-chromium` (390 x 844, touch) are two
mobile Chromium runs of mostly the same specs (423 s together), `orchard-phone-webkit` repeats the phone run in WebKit (179 s), and five more WebKit
projects exist for a few specs each. The e2e flows run every flow in both browsers although the bot flows (E15*) exercise the same client code in
both. Component runs and flows are not the same check, but where a flow and a component spec assert the same words on the same screen the cheaper
one (jsdom, then component) is enough and the flow only needs the journey.

## 3. Recommendations

Safe (no protection lost); sorted by saving:

1. **Run independent tiers together under resource control** (done in this branch). Wall time of a full gate from about 43 min to the figure in
   section 5.
2. **Give the e2e tiers two workers** (`--fileParallelism --maxWorkers=2`; done in the scheduler): minus about 130 s per browser, measured, all
   flows pass.
3. **Give the component tier two workers** (`--workers 2`; done in the scheduler, only when memory and cores allow): about minus 9 min. With three
   workers the run took 552 s but one WebKit phone spec failed under a load of 16, so the gate asks for at most two.
4. **Fix the `standalone-layout` race** (read `boundingBox()` once and branch on null) and set `retries: 1` for the component tier in the gate: a
   single flake currently costs a 19-minute rerun for no information.
5. **Run the unit packages that cannot use many cores beside the others** in `scripts/run-tests.mjs unit` (`--workspace-concurrency=1` today): the
   cloudflare package is pinned to one worker (47 s), the debugger runs files one at a time (25 s), copilot 17 s; with a mean of 2.3 cores in use
   the verify test phase could drop by about 1.5 to 2 minutes. Not done: the serial order was chosen against load-induced timeouts (section 4),
   so it needs a trial.
6. **Replace the in-body `test.skip` calls by project selection** (`testMatch`): about 15 s and a clearer report; low value.
7. **Make the slowest tests faster without removing them**: `phone-settings` (2 x 21 s and 2 x 11 s for four runs), `timeline-time` (11.7 s, 7.3 s),
   `pairing-keys` (2 x 11 s). About 90 s of the component run are in tests that mostly wait.

Trade-offs for the owner to decide (each loses some protection):

A. **Drop one of the two mobile Chromium component projects** (`chromium-mobile` Pixel 7 or `orchard-phone-chromium`): minus 150 to 270 s of the
   component run (13 to 23 %); loses one viewport and device profile. The phone-width and touch specs would stay in the other.
B. **Run `assistant-inventory` (188 runs, 92 s) in `chromium-desktop` and one phone project only**: minus about 45 s; loses its coverage in the
   other two projects.
C. **Run the bot flows E15, E15b, E15c, E15d in Chromium only**: minus about 50 s of the WebKit tier (about 25 s with two workers); loses WebKit on
   those four flows.
D. **Run smoke only when the client or the Relay changed** (already so in the plan) and `--only smoke` after a flake: nothing to add. Its 4.3 minutes
   of scenarios cannot overlap; they could only shrink by shorter scenario times.

I did not delete or change a test in this task.

### Applied (branch feat/test-speed)

- Item 4: the `standalone-layout` assertions now measure the shell in one page evaluation and poll until it is inside the safe area. Under 20 busy
  loops and 10 workers the old spec failed 1 of 120 runs in `chromium-mobile` (tab bar bottom 326, expected 402; the failure was the
  unpolled `toBeCloseTo`, not only the null `boundingBox`); the new one passed 240 of 240. The component config has `retries: 1`, because the
  same document records other load flakes (`chat-scroll-memory`, `navigation:96`).
- Item 5: with 8 or more cores, `scripts/run-tests.mjs unit` runs the cloudflare, debugger and copilot packages in a lane beside the recursive run of the
  others. `pnpm verify` took 370 s before and 292 s after (one run each, idle machine; minus 78 s, below the estimated 90 to 120 s). The first
  parallel run failed the load-sensitive controller test `opencode-server-supervisor` (`unreaped` was 0, not 3), the one section 4 names; the next
  three runs passed. That is a flake risk of this change to watch.
- Trade-off A: `orchard-phone-chromium` now holds only the Chromium-only touch specs (`phone-touch`, `phone-keyboard`, `ask-window`): 29 runs, 21 s
  measured against 150 s. `chromium-mobile` stays because it runs every spec at a phone width (about 25 spec files branch on `isMobile`), while the
  phone-exact specs still run in `orchard-phone-webkit`. Loses: Chromium runs of the phone-exact specs other than those three.
- Trade-off B: with A applied, `assistant-inventory` runs in `chromium-desktop`, `chromium-mobile` and `orchard-phone-webkit` (141 runs instead of 188),
  which is one desktop and one phone project per engine; no separate change was needed.
- Trade-off C: E15, E15b, E15c and E15d run in Chromium only (`scripts/lib/chromium-only-flows.mjs`; excluded under `E2E_BROWSER=webkit`, and the gate
  has no WebKit tier when a selection holds only them). Measured: the four files took 107 s in WebKit on one worker.

## 4. Why verify runs alone

The scheduler first overlapped verify with the browser tiers (they only need verify's build). Two runs of that, both with one browser tier beside
verify's unit tests: (1) the slow-test reporter failed `hosted-runtime.test.ts > refuses a near-ceiling handoff` (1,325 ms, then 1,049 ms alone,
over the 1 s limit); (2) the controller's `opencode-server-supervisor.test.ts` failed (`unreaped` was not 3). Both passed in every serial run before.
Unit tests that spawn processes and measure time are load-sensitive, as the comment on `--workspace-concurrency=1` says; so verify runs alone, and
the other tiers start when it has passed.

## 5. The resource-aware gate

See `docs/controller-npm-release.md` ("Tiers that run together") and `scripts/lib/gate-scheduler.mjs` for the rules. The measured table above is
the `TIER_PROFILES` table in the code (memory as the fall of available memory plus a quarter, CPU as the peak). On this machine the available memory
is 4 to 8 GiB when idle and macOS reported memory pressure `warn` at times, so the default reserve is 2 GiB (3 GiB would never let a second tier
start) and a tier that is alone waits at most two minutes for the pressure to fall.

Experiments that set the rules (verify and the tiers beside each other, all on this machine):

| Run | Beside each other | Result |
|---|---|---|
| 1, 2 | verify's unit tests + e2e-chromium | verify failed twice: the one-second speed rule (1,325 ms) and the opencode supervisor test; so verify runs alone |
| 3 | components (2 workers) + preview + e2e-chromium, cores ceiling 100 % | 9 of 10 cores busy; E15 timed out at 25 s (9 s alone); components failed `standalone-layout` and `navigation:96` (both pass alone) |
| 4 | same, with one retry | e2e E14 (installed app, service worker timing) failed on both attempts; passes alone |
| 5 | components + e2e-chromium + e2e-webkit | E14 and E15b failed; so the ceiling is 60 % of the cores and tiers retry once |
| 6 | 60 % ceiling | the machine thrashed from outside the gate (load 32, pressure critical); components hit its 25 min deadline; the scheduler held every other tier back, as designed. No result |
| 7 | 60 % ceiling, restarted machine | **passed**, below |

Final run, `pnpm gate:release --full` (7), machine otherwise idle, all tiers green on the first attempt:

| Tier | Time | Peak memory (tree) | Workers |
|---|---|---|---|
| verify | 352 s | 3.2 GiB | |
| components | 633 s | 3.6 GiB | 2 |
| e2e-chromium | 136 s | 2.2 GiB | 2 |
| preview-browser | 149 s | 2.4 GiB | |
| e2e-webkit | 140 s | 4.9 GiB (includes WebKit helpers) | 2 |
| smoke | 258 s | 1.8 GiB | |

Wall time **1,522 s (25.4 min)**; lowest available memory 6.0 GiB; worst pressure normal. The same tiers run one after another measured about 2,480 s
(41 min), and the owner's figure is about 55 min with reruns. The saving (about 40 % against the measured serial run) comes from two-worker
component and flow runs, and from preview overlapping e2e-chromium and webkit; verify (352 s) and smoke (258 s) stay serial by design.
