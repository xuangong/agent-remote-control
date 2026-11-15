# P0 baselines: today's browser experience on the local instance

These are the numbers the IM session service ([design](../specs/2026-11-15-im-session-service-design.md), targets T1 to T6) is held to. They come from `packages/agent-remote-lab/performance/local-baselines.mjs`, which a later phase re-runs unchanged against the new build.

## What these numbers are, and are not

- **Local loopback floor.** Browser, Relay and Controller run on one machine. There is no network latency, no Cloudflare hop and no real Relay storage. Every time below is therefore the client and server work plus local scheduling, a lower bound for what a user sees. Production adds one network round trip to every dependent step listed under "Where the time goes".
- **Tiny sessions.** Five sessions (3 Claude Code, 2 Codex), each with 2 to 3 real turns, 6 to 12 timeline rows and one tool output of 14 to 34 KB. Long conversations are covered by the earlier rendering benchmarks, not here.
- **Small n.** n is stated for each row. p95 over 10 to 15 samples is nearly the maximum; read it as "worst seen".
- Production pages were not touched.

## Environment

| Item | Value |
| --- | --- |
| Machine | Apple M4, 10 cores, 16 GiB, macOS 27.2.1 (Darwin 27.2.0), arm64 |
| Browser | Playwright Chromium 151.0.7922.34, headless, 1440 x 900, light scheme |
| Node | 26.8.1 for the script (the instance builds with its own toolchain) |
| Commit | `0aaefda99cd83472cc9ceb878f0b4deae3ca393a` (main), clean checkout; instance build the same, started 2026-11-15 12:55 UTC |
| Instance | `pnpm local up` in `.worktrees/p0-baselines`, instance `p0-baselines-a617dcb9`, one Host with providers Claude Code, Codex, Copilot (OpenCode unavailable) |
| Date | 2026-11-15 |

Raw data: `packages/agent-remote-lab/performance/results/p0-local-*.json`. Each sample keeps its observer log, request counts by endpoint, and WebSocket frames by kind.

| File | Content |
| --- | --- |
| `p0-local-1x-a.json` | open-known, open-cold-context, open-released (1.5 s), hidden-short. Its `open-fresh` failed once (one sample not ready within 30 s, cause not found; later runs of the same scenario passed 25 of 25). Its send, release and provider scenarios are superseded by `-b` (they ran before Codex runtimes were loaded first). |
| `p0-local-1x-b.json` | open-fresh, send-resident, send-released, release-continuity, provider-latency |
| `p0-local-4x.json` | open-known, open-fresh, open-cold-context, send-resident at 4x CPU slowdown (reps 2) |
| `p0-local-hidden-long.json` | hidden and frozen for 300 s (n=2) |
| `p0-local-restart.json` | Controller and Relay restart with the page open (n=2) |
| `p0-local-wake-75s.json` | Codex released, then 75 s wait before open, send and CLI send (n=2 to 4) |
| `p0-local-switch.json` | `local-switch.mjs`, 1x and 4x |

## Method

One clock (`Date.now`) in the script and in the page. A page-side observer (MutationObserver plus a 100 ms timer) logs every change of: the visible `.lab-conversation-status` label, `.lab-empty-state` placeholder title, session-control notice, composer state (`aria-disabled` / `contenteditable` of the editor, or absent), message count, and `data-delivery-state` values. CDP records every HTTP request and every WebSocket frame (kind from `type` and `message.type`, bytes).

Definitions:

- **start**: just before `page.goto` or `page.reload`; the moment the page is shown again (hidden scenarios); the Enter key press (send scenarios).
- **content**: first moment an `.agent-message` is in the document.
- **ready**: first moment the label reads "Ready", the composer is enabled, no placeholder or control notice is shown, and messages exist.
- **Blocking state**: any label other than Ready/Working/Waiting for response/Starting, any placeholder, any control notice, or a disabled or absent composer. Durations come from the observer log between start and ready.

Scenarios:

- **T1 open-known**: one context; each session opened once (discarded), then reloaded 3 times (n=15, 5 sessions); plus "navigations" to a session by URL from another session (n=5). The browser keeps its localStorage, IndexedDB and HTTP cache.
- **T2 open-fresh**: same context, but localStorage, IndexedDB and cache storage of the origin are cleared before each open (n=15). The sign-in cookie and the HTTP cache of scripts stay. **open-cold-context**: a brand-new context per sample, which also means a cold HTTP cache and a new sign-in (n=3). The Relay holds no journal today, so "never opened on this device" is also "never opened anywhere"; the Relay-journal part of T2 cannot be measured yet.
- **T3 hidden**: `document.visibilityState` is overridden to hidden and a `visibilitychange` plus `blur` is dispatched; for the long run the page lifecycle is also frozen through CDP `Page.setWebLifecycleState`. A tiny turn is sent from the command line while hidden. "Return" starts when the page is shown again. Headless Chromium does not hide a page by `bringToFront`, so a real tab switch could not be used.
- **T4 send**: type a tiny prompt, press Enter. Codex gets one tiny turn just before so its runtime is loaded; "released" runs call `session release` first (Codex only; it answers `released:false` for Claude Code, which has no resident runtime to unload).
- **Switch**: `local-switch.mjs` in Bot mode (5 sessions listed under "Other sessions", opened by the script), each clicked twice (cold, warm). It now opens that collapsed section; previously only bound bots were reachable.
- **Provider latency**: wall time of one `agent-remote-controller-dev` process, which includes 250 to 370 ms of process start (`floor` below is `session list`).

## T1: a session opened before in this profile

| Measurement | n | p50 | p95 |
| --- | ---: | ---: | ---: |
| Reload: start to first content | 15 | 79 ms | 82 ms |
| Reload: start to ready | 15 | 131 ms | 140 ms |
| Navigate by URL from another session: content | 5 | 51 ms | 54 ms |
| Navigate by URL: ready | 5 | 106 ms | 107 ms |
| Reload at 4x CPU: content | 10 | 133 ms | 149 ms |
| Reload at 4x CPU: ready | 10 | 359 ms | 396 ms |

States seen on every reload (15 of 15), in order:

| State | First seen | Duration p50 (p95) |
| --- | ---: | ---: |
| No messages in view, composer absent | 23 ms | 56 ms (59 ms) |
| Label "Opening session" with the composer already enabled and messages visible | 79 ms | 52 ms (58 ms) |
| Label "Ready" | 131 ms | |

There is no device store for conversation content: the browser's IndexedDB holds only image and resource drafts, and localStorage holds layout and recovery keys. A reload therefore shows nothing until the Relay answers. T1 as proposed (content within 100 ms of mounting, no blank state) is not met by design today; it is met numerically only because the loopback attach, subscribe and page read take about 50 ms.

## T2: a session never opened in this profile

| Measurement | n | p50 | p95 |
| --- | ---: | ---: | ---: |
| Storage cleared: start to content (= ready) | 15 | 121 ms | 216 ms |
| Claude Code only | 9 | 120 ms | 123 ms |
| Codex only | 6 | 124 ms | 216 ms |
| Brand-new context (cold HTTP cache): content | 3 | 198 ms | 4,596 ms |
| Storage cleared at 4x CPU: content | 10 | 304 ms | 540 ms |
| Brand-new context at 4x CPU: content | 3 | 559 ms | 581 ms |

- One of three cold-context samples (a Codex session) took 4.6 s, spent entirely in the placeholder "Opening session"; the other Codex open took 197 ms. This is a single observation; the cause is not established (the first Codex thread load after the session had been idle is the likely one). It is the only outlier of 60 opens.
- States before content on every open (15 of 15): "No messages in view" 18 ms to 120 ms (102 ms total), then placeholder "Start with a Provider" (26 ms, p95 40 ms), then placeholder and label "Opening session" (31 ms, p95 46 ms), then content, then Ready. The empty "Start with a Provider" screen is the app showing "no session selected" while the Window layout is being restored.
- The first open of a session in a context with warm scripts (`firstOpensInContext`, n=5) was 123 ms p50, 224 ms max.

## T3: return after hidden

| Hidden | n | New content visible after return | Ready after return | HTTP requests on return | New sockets |
| --- | ---: | ---: | ---: | ---: | ---: |
| 30 s | 6 | 13 ms p50 (21 ms p95) | 40 ms p50 (41 ms p95) | 14 | 0 |
| 300 s, lifecycle frozen | 2 | 20 ms, 21 ms | 20 ms, 21 ms | 13 | 0 |

- In every case the page had already received the turn sent while hidden (`alreadyCurrentOnReturn`); the "current" time is the observer reading, not a fetch. The WebSocket survived 5 minutes frozen with only ping/pong traffic, so this machine could not reproduce the reconnect that users report after long idle. Mobile suspension, laptop sleep and real Relay idle timeouts remain unmeasured.
- Blocking state on return: the label flips to "Opening session" for 7 to 16 ms (6 of 6 at 30 s, 2 of 2 at 300 s). There is no longer blocking state.
- On every return the page re-fetches 13 to 14 list endpoints (see Requests) even though the sockets survived.
- After a Controller restart (see T6) the same label shows for seconds.

## T4: composer and sending

| Measurement | n | p50 | p95 |
| --- | ---: | ---: | ---: |
| Composer disabled while connecting, restoring or synchronizing | all opens and restarts | never: absent (not mounted) for the first 56 ms of an open, then enabled while the label still says "Opening session" or "Reconnecting" | |
| Composer disabled after Enter | 20 | 25 to 50 ms, every send | |
| Enter to "sending" shown (resident) | 10 | 25 ms | 48 ms |
| Enter to accepted (resident) | 10 | 53 ms | 75 ms |
| Enter to "sending" shown (released Codex, 1.5 s) | 4 | 28 ms | 28 ms |
| Enter to accepted (released) | 4 | 74 ms | 79 ms |
| Enter to accepted, Codex released 75 s earlier | 4 | 56 ms | 79 ms |
| Enter to accepted at 4x CPU (resident) | 10 | 98 ms | 114 ms |
| Enter to "sending" shown at 4x CPU | 10 | 39 ms | 47 ms |
| Enter to "Working" label | 10 | 50 ms | 75 ms |
| Turn finished (reply shown, Ready), tiny turn | 10 | 5.5 s | 6.8 s |

"Sending shown" is the first message in the page or `data-delivery-state`; "accepted" is the message present with no pending delivery state (the Controller's `command_acknowledged` frame). Released Claude Code sessions are the same as resident ones, because Claude Code has no resident runtime to release (`released:false` in all 8 samples).

CLI view of the same operations (wall time of one process, n=2 to 4, `floor` = `session list` 340 ms):

| Operation | Claude Code | Codex |
| --- | ---: | ---: |
| `session read --limit 0` | 340 ms | 229 ms |
| `session read --limit 10` | 437 ms | 228 ms |
| `session read` after release | 470 ms | 257 ms |
| `session send`, resident | 353 ms | 244 ms |
| `session send` 1.5 s after release | 348 ms | 275 ms |
| `session send` 75 s after release | | 274 ms |

The send returns on acceptance. Codex's measured wake cost at the acceptance point is about 30 ms. Whether the daemon had actually unloaded the thread after 75 s could not be confirmed; the turn itself finished in the same time (5.9 s) as for a resident one. T4's "wake time plus 1 s" for released sessions is therefore not constraining on this machine: the provider's wake is not visible before acceptance.

## T5: per-session connection labels

Labels seen, with their frequency and duration. All durations are within the window from start to ready.

| Situation | Label or placeholder | Seen in | Duration |
| --- | --- | ---: | ---: |
| Every open or reload | "Opening session" (label and placeholder) | every open measured (15 reloads, 15 cleared-storage opens, 5 navigations, 3 cold contexts, 15 after release) | 23 to 52 ms p50, 68 ms max |
| Open in a fresh window layout | "Start with a Provider" placeholder, label "Awaiting Agent" | 100% of storage-cleared opens | 26 ms p50, 43 ms max |
| Every return after hidden | "Opening session" | 8 of 8 | 7 to 16 ms |
| Restart, Claude Code session | "Reconnecting" (3 times), "Opening session" (3 times), "Checking access" | 1 of 1 | 1.4 s and 0.8 s of the 2.5 s; "Checking access" 24 ms |
| Restart, Codex session | "Reconnecting", "Opening session", "Checking access", "Synchronizing" | 1 of 1 | "Reconnecting" 3.2 s of 3.8 s; "Checking access" 10 ms; "Synchronizing" 12 ms |
| Open or return | "Restoring" | 0 | never seen |

So on a healthy local instance the labels are brief flashes (tens of milliseconds) but they appear on every open and every return, and they last seconds whenever the Controller or Relay restarts. T5's "no label in smart mode" is measurable as zero flashes; today's baseline is one flash per open and per return.

## T6: continuity

| Event | n | Conversation reset? | Details |
| --- | ---: | --- | --- |
| Controller and Relay restart (`pnpm local up --no-build`) with the page open | 2 (Claude Code, Codex) | Rows replaced, content not blank | Message count never dropped (34 and 20 messages stayed); the marked first timeline entry node was no longer in the document afterwards in both runs, so the timeline was re-rendered from a new snapshot. Label cycled between "Reconnecting" and "Opening session" for 2.5 s (Claude Code) and 3.8 s (Codex) before Ready; the composer stayed enabled. |
| Runtime release while the page has the session open | 5 | not exercised | `session release` answered `released:false` for all five sessions (Codex 2 of 2, Claude Code 3 of 3): a runtime that a page watches is not released. The page showed no state change at all in 15 s (0 blank moments, no label change, marked node kept). |
| Open after a release (Codex), 1.5 s and 75 s | 6 | Fresh open | Content in 63 to 240 ms, same labels as any open. |

The restart also stops the Relay: the runner ends the site when the Controller exits, so a Controller-only restart could not be isolated on this instance. The restart numbers combine both. A real runtime release that a client is attached to could not be forced through the command line; the instance cannot show that case.

## Switch time (Bot mode, 5 sessions already loaded)

| CPU | Cold: shown | Cold: task | Warm: shown | Warm: task | Idle task per 10 s |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1x | 67 ms | 57 ms | 100 ms | 62 ms | 4 ms |
| 4x | 88 ms | 104 ms | 110 ms | 111 ms | 2 ms |

Medians over 10 clicks (5 cold, 5 warm). "Shown" is the click until the selected row is current and its conversation shows entries. Warm is not faster than cold; a switch re-attaches each time (see Requests).

## Requests

Per open or return, the page's own requests (script and style assets excluded). Medians.

| Event | HTTP API | WebSocket created | Frames in | Frames out | Bytes in |
| --- | ---: | ---: | ---: | ---: | ---: |
| Reload of a known session | 24 | 2 | 14 | 6 | 46 KB |
| Open with storage cleared | 27 | 2 | 12 | 4 | 51 KB |
| Return after hidden (30 s and 300 s) | 13 to 14 | 0 | 2 to 3 | 3 | small |

An open makes 24 to 27 HTTP calls: `auth/status`, teams, favorites, successions, relations, migrations, windows (twice), hosts (twice), providers, controller-release, and per Host catalog, catalog listing, workspaces, previews, vscode tunnel, tpm, session refs, `POST attach`, `POST session/call`. It creates two session-channel WebSockets (one for shared feeds, one for the conversation), receives `ready`, `session_states`, `session_reads`, `session_drafts`, `session_outbox`, `negotiated`, `agent_snapshot`, `agent_activity`, `session_control` (twice), `timeline_subscribed` and one `timeline_page`, and sends `subscribe`/`negotiate`, `timeline_subscription`, `session_control_request`, `timeline_request` and an unsubscribe. A return after hidden repeats 13 of those list requests and one `POST session-reads`, with no new sockets.

Timeline read: from `timeline_request` out to `timeline_page` in, 3 to 15 ms (n=15); the page was 22 KB (Codex) to 38 KB (Claude Code) for 10 to 11 rows.

## Provider numbers

| Item | Claude Code | Codex |
| --- | --- | --- |
| Wake (first send after release, accepted) | no resident runtime: `released:false` always; send is 353 ms vs 348 ms | 275 ms vs 244 ms resident (+30 ms); 274 ms at 75 s |
| Native history read, request to page over the socket | 3 to 6 ms (`timeline_page`) | 3 to 15 ms |
| History read by CLI, 10 entries | +97 ms over the 340 ms floor | no cost over its 229 ms |
| Row bytes, `user_message` | 391 B | 390 B |
| Row bytes, `assistant_message` (max) | 1.2 KB | 835 B |
| Row bytes, `tool_call` (max, `seq 1 3000` output) | 34 KB | 17 KB |
| Row bytes, `error` | none | 550 B |
| Streaming a 5 s tiny turn: frames in | 26 (14 `agent_stream`, 8 `agent_update`), 4.6 to 5.3 per s | the same |
| Streaming: bytes in per turn | 60 KB | 60 KB |
| Main-thread task during one turn at 1x | 167 to 249 ms | 213 to 270 ms |

Row and frame rates here describe a 5 s turn answering one short sentence; they say nothing about long tool-heavy turns. Provider internals (daemon thread resume, Claude Code transcript reads) are not instrumented in the Controller; the numbers above are what the browser and the CLI can see.

## Where the time goes

- **Loopback hides the real cost.** Open to content is about 80 ms reload and 120 ms with cleared storage here, of which the first 20 ms is the page booting (no messages in view), and about 50 ms from the first label to Ready is the attach, subscribe and page-read chain (the page read itself takes 3 to 15 ms). The split of the rest between script work and HTTP was not profiled. In production every step of that chain that depends on the previous one costs a Relay round trip.
- **The dependent chain of an open** (from the traces): document and scripts, then `auth/status`, then session-channel WebSocket, then `POST attach`, then second WebSocket and `subscribe`/`negotiate`, then `timeline_subscription` plus `timeline_request`, then `timeline_page`. That is at least six sequential round trips before the first row. A design that serves the journal from the Relay removes the Controller leg; the client store removes the rest.
- **Nothing is cached on the device.** Reload, navigation back and a return after hours all take the same path. T1 has no mechanism today.
- **A return re-fetches the world.** Every return after hidden issues 13 to 14 HTTP requests although both sockets are alive, and flashes "Opening session".
- **Switching re-attaches.** Warm switches (100 ms) are no faster than cold ones (67 ms).
- **A restart replaces the rows.** The conversation stays visible but is rebuilt; labels cycle for 2.5 to 3.8 s. Content was never blank, which is already better than the design assumed.
- **The page is quiet at rest.** Idle task time is 2 to 4 ms per 10 s.
- **CPU slowdown triples ready time** (131 to 359 ms for a reload, 121 to 304 ms for cleared storage), so on a slow Edge machine most of the time will be client work, not network.

## Targets

- **T1** (content within 100 ms of mounting, p95, no blank or loading state). Today's reload is 79 ms p50 and 82 ms p95 on a fast machine because the loopback chain is short; at 4x CPU it is 133 ms p50 and 149 ms p95, and the loading state ("no messages in view" plus "Opening session") is always present. The target as stated is reachable only with a device store, and 100 ms is a fair bar there. Change: say "from mounting the conversation component, measured at 4x CPU slowdown", and require zero frames of "Opening session" or a blank timeline (count states, not clocks).
- **T2** (journal content within 500 ms p50 and 1.5 s p95 without reaching the Controller). Today's p50 is 121 ms and p95 216 ms, but at 4x CPU 304 ms and 540 ms, and one Codex open in 60 took 4.6 s. The proposed bar is realistic for the server leg, but the local floor already uses a large share of 500 ms at 4x CPU. Change: define the target as the time from the first `attach` request, so client CPU is not charged to the Relay, and keep the 1.5 s p95; add that a Controller-served open (today's path) is the control group. The outlier says the journal must not be read through a Codex thread load.
- **T3** (no blocking state on return; content current within 1 s p95). Return is already 13 to 40 ms here with a 7 to 16 ms label flash, because the sockets survive the hidden period in headless Chromium. The target is right in direction but this baseline cannot judge the 1 s bar. Change: measure it on production-like conditions (real tab switching, laptop sleep, a 60 to 100 ms RTT) before accepting 1 s; keep "no blocking state" as the testable part, and count the 13 to 14 list requests on return as a budget (target: at most 2).
- **T4** (the composer is never disabled by connection state; sending shows within 50 ms; resident within 1 s p95; released within wake plus 1 s). Connection state never disabled the composer today, but it is absent for 56 ms during open and disabled for 25 to 50 ms after each send. Sending is shown in 25 ms (48 ms p95, 39 and 47 ms at 4x) and accepted in 53 ms (p95 75 ms), so 50 ms for "shown" is tight at 4x CPU and the acceptance bar of 1 s is easy here. Change: "shown within 100 ms at 4x CPU slowdown, and the editor never loses focus or content while sending"; keep the 1 s acceptance but test it with a real Relay RTT; measure wake with a Codex thread that the daemon really unloaded (the wake did not show up at all here).
- **T5** (no per-session connection label in smart mode). Valid. The baseline is one flash per open and per return (all of 45 opens, all 8 returns) and seconds-long cycles on restart. "Restoring" never appeared, so removing it costs nothing. Change: none; add "Awaiting Agent" and "Start with a Provider" to the forbidden list, since they appear on every cleared-storage open.
- **T6** (no reset on a Controller restart or runtime release). Today's restart already keeps the content visible but rebuilds all rows (node identity lost) and cycles labels for 2.5 to 3.8 s. The target should say what "reset" means so that it can be tested: no frame without rows, no re-keyed rows (same DOM nodes for unchanged items), no label. A runtime release with a page attached could not be provoked here (the Controller refuses), so the target has nothing to improve upon for that case; keep it for terminal-driven sessions and for reopening after a release.

## Not measured

- Production pages, real network latency, a real Edge browser on Windows, and real tab backgrounding (headless Chromium has no tab switch; the visibility emulation does not throttle timers or close sockets, and the frozen run did not either).
- Laptop sleep, mobile suspension, Relay idle timeouts and long reconnect storms.
- A Relay journal, a Relay-served open and a second device (they do not exist yet).
- A Controller restart without the Relay restarting (the instance's runner ends the site with the Controller).
- A runtime release while a page is attached (refused by the Controller).
- Conversations of hundreds of rows, large images and the cost of long tool output on first paint (see the earlier scroll and streaming benchmarks).
- Provider internals: Codex daemon thread resume, Claude Code transcript read time, and Copilot, which was not used.
- How far back people scroll: there is no telemetry for it. The nearest data are the page sizes above (10 to 11 rows per first page, 22 to 38 KB).
- Whether Codex had unloaded a thread at 75 s (the daemon unload delay is documented as about a minute but cannot be observed from here).
- The cause of the single failed `open-fresh` sample and of the 4.6 s Codex open (one observation each).

## Re-running

```sh
pnpm local up
node packages/agent-remote-lab/performance/local-baselines.mjs --out packages/agent-remote-lab/performance/results/p0-NEXT.json
node packages/agent-remote-lab/performance/local-baselines.mjs --throttle 4 --scenarios open-known,open-fresh,send-resident --reps 2 --out .tmp/4x.json
node packages/agent-remote-lab/performance/local-baselines.mjs --scenarios open-released,send-released,provider-latency --release-wait 75000 --reps 2 --out .tmp/wake.json
node packages/agent-remote-lab/performance/local-baselines.mjs --scenarios hidden-long,restart-continuity --reps 2 --out .tmp/long.json
```

The sessions must exist (created with real model turns in the instance workspace); the script lists them with `session list`. `restart-continuity` runs `pnpm local up --no-build` and so restarts the instance.
