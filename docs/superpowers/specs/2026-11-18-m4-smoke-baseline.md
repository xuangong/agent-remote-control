# M4: the smoke harness and its baseline

Companion of `2026-11-18-target-architecture-and-tests.md`, step M4 (sections 5.7 and 6.0). It records what exists, what was deferred and why, the first `pnpm smoke:quick` run that later steps compare with, and the findings with the tests they should become. Reports themselves (`.arc-local/smoke/<date>/`) are not committed.

## What exists

`packages/agent-e2e` (private) holds `faults/` and `smoke/`. Run `ARC_LOCAL_JOURNALS=1 pnpm local up`, then `pnpm smoke:quick` (M1, M2, M7) or `pnpm smoke [scenario ...] [--seed N] [--rounds N] [--condition provider:rttMs:loss]` (every scenario). Both wrappers (`scripts/run-smoke.mjs`) enforce an outer deadline (20 and 100 minutes); each scenario has its own (8 and 40 minutes). The unit tests of the package run in `pnpm test` (83 tests: 49 invariant tests, 24 other unit tests of the faults and the harness, all under 10 ms each, and 10 proxy tests over real loopback sockets); the scenarios are not tests and never run there.

| Part | Where | What it does |
|---|---|---|
| Invariants | `smoke/invariants/` | 23 pure functions over a transcript and a page report, each with a passing and a deliberately broken case. A result is `passed`, `failed` or `not_exercised` (nothing was examined, so silence cannot pass). |
| Transcript | `smoke/transcript.ts` | Decodes the session-channel frames the proxy tees into the `{n, direction, message}` shape of the M1 transcripts, adds `connection`, time and markers (restart, offline, hidden, fault). |
| Report | `smoke/report.ts` | `report.json` (`arc-smoke-report-1`: scenario, seed, schedule, measurements, invariant results, transcript path, findings), a one-page `summary.txt` and the transcripts. |
| Findings | `smoke/findings.ts` | One finding per failed invariant: seed, transcript, the integration test on its seam and the unit test in the owning module (the order of 5.7). |
| Latency proxy | `faults/latency-proxy.mjs` | Moved from `lab/performance`; adds jitter, TCP-style loss (retransmission timeouts that double and block the bytes behind), a bandwidth cap, half-open sockets, offline, changing conditions while running, a seeded generator and the WebSocket tap. Loss is drawn per socket read (up to 64 KiB), so a rate is harsher than the same packet loss rate. The tap strips `Sec-WebSocket-Extensions` so messages are readable, and records each message as the receiving side gets it. |
| Process faults | `faults/instance-process.mjs` | Stops the instance's own Controller by SIGKILL or SIGTERM (pid from `runtime.json`, command checked against this checkout), restarts the instance (`up --no-build`, journals on), optionally with an empty Relay journal store (only `journals.sqlite*` of the instance). |
| Quota profiles | `faults/quota.mjs` | Tiny session and Host limits and the big-tool-output prompt. |
| Many sessions | `faults/many-sessions.mjs` | A seeded plan of 200 sessions, a 50-bot group and open, fold, sleep and wake churn. |

## Scenarios

| # | v1 | Notes |
|---|---|---|
| M1 Bad network | Implemented | 50, 300 and 1,500 ms round trip with jitter and 2 and 10 percent loss; Claude, plus Codex at 300 ms. A revisit in the same browser context gives the page a device store to paint from. |
| M2 Controller restart | Implemented | SIGKILL and SIGTERM during streaming and during a tool call, alternating Claude and Codex; 20 rounds in `smoke`, 2 in `smoke:quick`. |
| M3 Relay restart | Implemented | Instance restart mid-turn with the journal kept and emptied. On demand and in `smoke`; not in the quick set. |
| M7 Hidden page and drops | Implemented | Hidden and offline for 10, 60 and 300 s (10 s in quick), then a half-open socket. |
| M4 Quota pressure | Deferred | The instance runs the default 64 MiB session limit and reads no limit from its environment; reaching it with real tool outputs costs more than the run is worth. The profiles and prompt exist; the scenario needs the Node Relay host (M12), which takes limits as an option. Its invariants (trim reported, live-only items survive, no hole) are implemented. |
| M5 Many sessions | Deferred | The plan says after the Node host: 200 real sessions are not creatable cheaply. Plan and invariants (subscription budget, unchanged rows, flat memory) exist. |
| M6 Terminal races page | Deferred | The plan says after the Node host; it also needs a terminal driver, and the instance refuses `session attach`. Invariants exist. |
| M8 Soak | Deferred | 30 minutes of streaming needs the Node host; the stable-series invariants exist. |

The runner stops the site when its Controller exits, so a Controller kill on `pnpm local` takes the Relay with it: M2 and M3 are the same event with different triggers here. Isolating the Controller needs the Node Relay host (M12).

## Baseline: `pnpm smoke:quick`, seed 100

Code commit `a9095c97323a` (the checkout), instance build `97053b4b87a3` (`pnpm local up` with `ARC_LOCAL_JOURNALS=1`; the commits in between touch only `agent-e2e`). Node 22.23, headless Chromium of the Lab package. 187 s in all; an earlier run of the same code took 210 s.

| Scenario | Result | Time |
|---|---|---:|
| M1 | **failed**: `first-paint-from-device-store` (3,281 ms on Claude, 3,280 ms on Codex at 300 ms round trip); `message-settles-once` passed (2), `no-duplicate-item-key` passed (28 keys), `journal-sequences-contiguous` passed (4), `no-stale-label` not exercised | 60 s |
| M2 | passed: one replacement per restart (2), sequences contiguous (10), messages settle once (4), no duplicate key (41), no blank frame (45), no stale label (4), turn rows complete after return (4); the fault landed mid-turn and the page recovered and answered a follow-up in both rounds | 43 s |
| M7 | passed: catch-up costs one tail request (2), no stale label (15), draft and position kept (2; the reader was scrolled 1,632 px up), no blank frame (40), no duplicate key (30), half-open socket recovers (1: the session was served again after 37.2 s); `journal-sequences-contiguous` not exercised | 83 s |

Other runs of this code: M1 in full (7 conditions, 247 s): first rows on a revisit at 0.77 s (50 ms, 2%), 0.96 s (50 ms, 10%), 3.4 s (300 ms, 2%), 5.1 s (300 ms, 10%), 16.2 s (1,500 ms, 2%), 2.7 s (Codex, 300 ms), and no rows within 90 s at 1,500 ms and 10% loss; every message settled once. M3 in quick form (2 rounds, one with an empty store, 89 s) passed all seven invariants. Estimated `pnpm smoke`: about 30 minutes (M1 4, M2 9, M3 5, M7 9 from the measured per-round times); it was not run end to end because it spends about 60 real model turns.

## Findings and the tests they should become

Each finding keeps its seed and transcript, then gets the tests in the order of 5.7: the transcript in `agent-remote-fixtures`, a failing integration test on the seam, a failing unit test in the owning module.

1. **First paint scales with latency; the device store is not painted before the Relay answers.** Stored rows are shown only once the Relay confirms the lease (`device-store-start.ts`), which takes about three round trips: 3.3 s at 300 ms, 16 s at 1,500 ms, nothing in 90 s at 1,500 ms and 10% loss. The target is under 300 ms at any latency. Tests: S7 integration test "a restored record paints before any frame arrives" in `agent-remote-seams`; unit tests in `agent-client` (device store seeds the replica marked `restored`, before the connection) and the renderer. Owner: M8.
2. **A silent session channel is noticed after 37 s.** After a half-open socket the page reconnected its account channel in 1.2 s and its session channel in 37.2 s; it showed "Reconnecting" meanwhile, correctly. No invariant failed (limit 60 s); the number is the baseline to keep or improve. Tests: S3 integration test replaying the transcript with a swallowed server direction, asserting the client replaces the socket within its heartbeat deadline; unit test in `agent-client` (connection) on the deadline.
3. **Observation, not a defect of the product under test:** `agent-remote-controller-dev api` answered `signed_out` after an instance restart while `login status` said signed in; `pnpm local api` worked. Cause not investigated. Test candidate: a case in `scripts/local/command.test.mjs` for the command line's sign-in surviving a restart.

## What M5 and later need to know

- The page report relies on the Lab's selectors (`.lab-conversation-status`, `.agent-timeline-entry[data-entry-key]`, `.agent-message-user`, `[data-testid="prompt-input"]`). A markup change in M8 or M13 must keep them or update `smoke/lib/observer.ts`; a renamed selector shows as `not_exercised`, not as a pass.
- The timeline scroller is a reversed column: `scrollTop` is zero at the newest row and negative above it.
- M5 (journal window decision) changes what a replacement carries: `one-replacement-per-restart`, `trim-reported` and `no-refused-row-hole` are the checks to compare. `pnpm smoke:quick` after it must show M2 and M7 unchanged and M1's first-paint failure unchanged until M8.
- A restart scenario refuses to run while sessions it did not create are running or waiting. Release Codex sessions by letting the run finish; a run killed by its deadline leaves them loaded until you release them (`agent-remote-controller-dev session release <address>`).
- M12 should give `agent-relay-node` a `limits` option and a separately stoppable Controller; then M2 can kill the Controller alone and M4 and M5 can run.

## Finding 1 after M8

Resolved in M8 (see `2026-11-18-m5-m7-test-mapping.md`, "M8"). The revisit paints from the device store 80 to 114 ms after its document arrives at every condition (50 ms, 300 ms and 1,500 ms round trip, 2 and 10 percent loss), and every message settles once. The invariant `first-paint-from-device-store` now measures from the document's arrival (`ms`) and keeps the whole time from navigation (`totalMs`): a document cannot arrive faster than the network, so the 300 ms limit applies to what the page controls. The probe also waits until the first open's record is on disk before it leaves, as a person who read a conversation does. The lease rule is unchanged: rows show only while the lease is valid, so a person returning after the lease (about 120 s from the last confirmation) has lapsed sees rows after one `/auth/status` round trip, not at once. A longer display lease would change the privacy rule and is the owner's decision.
