# Requirements against external dependencies

Status: analysis for the owner, 2026-11-21. No product code changed. It is the external dependency review that O53 leaves as a separate task, for the agent CLIs, Cloudflare, browsers and the network.

## Why

The places most likely to fail are where a requirement assumes something that an external dependency does not guarantee. This document lists each such assumption with its evidence, what the person sees when it fails, today's handling and the one targeted test that would prove the handling. Long runs found these gaps late and only in part: the full smoke run of seed 70621 took 4 h 26 min, and the same faults reproduce in seconds at the provider port or in a simulator.

Sources:
- the IM session service design: T1 to T6, Operation queue, Scheduling and Failure handling;
- the Orchard design: decisions 1 to 5, "Organised as an IM product" and Phone;
- the boundary rule: "M6's boundary" in section 5.7 of the target architecture;
- the limits table of section 5.7, and open items O44 to O53 of section 10;
- `docs/current/agent-remote/components.md`, whose clauses are cited as "Component Cn";
- the facts recorded in section 11 of the S6a plan (`docs/superpowers/plans/2026-11-17-s6a-claude-codex-journals.md:463-491`), cited as FC1 to FC9 and FL1 to FL9;
- the full smoke run `.arc-local/smoke/2026-11-21T03-50-21-934Z/` (`report.json`, and `M1.transcript.jsonl` to `M8.transcript.jsonl`; reports are not committed).

## How to read the matrix

**Evidence.** **D**: documented by the dependency. **R**: observed in our recordings or measurements. **A**: assumed without evidence. **F**: known to be false.

**Versions.** A recorded fact holds for the version it was recorded on, and a CLI update can change it:
- the S6a facts were recorded on Codex 0.169.0 and Claude Code 2.1.319;
- M6 measured Codex 0.171;
- the recordings carry no CLI version, although `docs/current/agent-remote/seams.md:23` says they do.

**Paths.** `claude/`, `codex/`, `copilot/` and `opencode/` are `packages/agent-provider-<name>/src/`. `sdk/` is `packages/agent-provider-sdk/src/`, `ctl/` is `packages/agent-controller/src/`, `core/` is `packages/agent-relay-core/src/`, `cf/` is `packages/agent-relay-cloudflare/`, `client/` is `packages/agent-client/src/`, `lab/` is `packages/agent-remote-lab/` and `e2e/` is `packages/agent-e2e/`.

## 1. The matrix

### R1 Instant open from the device store or the journal (T1, T2, T6)

| # | Assumption (dependency) | Guarantee and evidence | When it fails, the person sees | Handling today | Targeted test |
|---|---|---|---|---|---|
| 1.1 | Safari keeps the device store (IndexedDB) between visits (browser) | **F** under documented conditions: WebKit deletes all script-writable storage of a site after seven days of Safari use without interaction with it, and a home-screen app keeps its own count. Private browsing keeps nothing. Nothing calls `navigator.storage.persist()` | A conversation opened last week opens from the journal (T2, up to 1.5 s), not from the store (T1, 100 ms) | The store treats a missing or failing database as empty and keeps records in memory (`client/device-store.ts:59-63`); the journal serves the open | Component test on `webkit-mobile`: delete the database between two visits; the second open paints the journal's page with no blank frame and no label |
| 1.2 | A write that the store issues when the page hides or leaves completes (browser) | **A**. Writes go out after 50 ms and on `pagehide` or hidden (`client/device-store.ts:48,84-90`). No browser promises that a transaction started at `pagehide` commits, and iOS may suspend a hidden page with no further event | A conversation read for a moment before switching apps opens from the journal next time | Write-behind, and a flush on leave | Component test on Chromium and WebKit: close the page 0, 50 and 200 ms after its first page; the reopen paints a kept record or the journal's page, never a blank frame. O51 was this case, with a harness cause |
| 1.3 | A reread lists items in the order the live stream showed them (CLI) | **F** twice, fixed in the adapters: Codex history is in completion order (FC4) and is re-sorted by start time (`codex/history.ts:38-47`); Claude's SDK read follows the parent chain, which parallel tools leave, fixed by file order in Controller 0.3.1 (`claude/transcript-extras.ts:51-57`). **A** for the order of concurrent tool results within one run: recordings move them to the end before comparing (`claude/journal-recording.local.test.ts:120-121`, `sdk/journal-recording.ts:15-25`), as Copilot's do for its todo board. OpenCode replaces its whole timeline on any reorder (`opencode/timeline.ts:17-18`) | A reopen replaces the journal: the conversation swaps in one step and unchanged rows are rebuilt (T6). Before O40 the reader jumped to the first row | The Relay replaces on any doubt (design, "The Relay compares and decides"); per-adapter sorting | Conformance replay per adapter with no `late` exemption: reread keys equal the live keys, in order. The simulator's knob `rereadOrder: 'completion'` then shows one replacement and the reader's row unmoved |
| 1.4 | Item identity is stable live, on reread and across CLI versions (CLI) | **R** at the recorded versions: FC1, FC9, FL1 to FL8, and 19 Claude, 12 Codex and 8 Copilot recordings (`seams.md:40`). **A** after an update: the Controller accepts Claude Code 2.1.247 and later (`ctl/claude.ts:33-38`) and Copilot 1.0.83 and later (`ctl/copilot.ts:31-35`). Nothing re-checks identity on the installed version | Every reopen replaces the journal: T6 is lost, with a reset per open | The gate `journal: { itemIdentity: 1 }` (`sdk/item-identity.ts:6-12`) is a static declaration; the Relay replaces on doubt | Nightly native check: record `settled` and `restart` on the installed CLI and compare `recordingShape` with the committed fixture (section 4.4) |
| 1.5 | Reading native history at an open is cheap enough to repeat (CLI) | **A**. Claude reads the whole transcript, unpaged, in a worker with a deadline and a 32 MiB output cap (`claude/catalog.ts:36-38`); Copilot reads all of `getEvents()` unpaged; Codex pages 10 turns but not the items inside a turn (`packages/codex-daemon-client/src/history-page.ts:4,14-17`). Nothing is measured by session size | A long session opens slowly through the Controller, or its refresh fails | The journal serves what it holds; per-request deadlines | Boundary test with the simulator: a history at 32 MiB minus one entry, at the cap and over it; the open is served from the journal while the reread fails as `native_history_timeout` |
| 1.6 | A partition's reply fits one Workers RPC message, and its cache fits the object's memory (Cloudflare) | **D** by Cloudflare's limits, restated in `core/journal-partition.ts:9-14` (RPC 32 MiB, 128 MB memory). The memory figure appears only in comments, and a reset for memory is not handled | A page read fails; the object resets and every socket closes | A reply over 24 MiB is answered again with fewer entries (`core/journal-partition.ts:85,97`); the cache holds 2 journals or 20 MiB | workerd test through `JournalPartition.tuning()` at production values: a page of 24 MiB minus one entry, at it and over it (section 3.2) |

### R2 Sending never waits, and a message is delivered once (T4, Orchard decision 4, the operation queue)

| # | Assumption (dependency) | Guarantee and evidence | When it fails, the person sees | Handling today | Targeted test |
|---|---|---|---|---|---|
| 2.1 | A native send's outcome is known, even when the Controller stops right after it (CLI) | **F**. A resolved `sendMessage` "does not guarantee durable persistence", and a void result leaves the disposition unknown (`sdk/provider.ts:228-234`). M2 rounds 8 and 10: the send left the page at 190,581 ms, the Controller stopped at 190,587 ms, no acknowledgement came, and the text never reached Codex (`M2.transcript.jsonl`). A reread could prove the outcome where the CLI keeps our input id: Claude keeps the uuid the Controller gives (FL1), and Codex lists the `clientUserMessageId` given to `turn/start` as `clientId` (`codex/native-evidence.ts:308`), but ordinary sends pass it only on the native-evidence path (`codex/session.ts:875`). **A** for Copilot | "Check delivery", and each later message waits behind it until the person decides (Replica C6, C10) | No automatic replay; the send stays `unconfirmed` (`client/replica/send-state.ts:11-16`) | Simulator: stop after the native call and before its acknowledgement. An adapter that declares `input.identity: 'echoes_client_id'` settles it by reread as delivered or not delivered, with no replay; elsewhere it stays unknown |
| 2.2 | A resume answers or fails within a deadline (CLI) | **R** fast when healthy: Codex 51 ms in M6 (one sample), and one Codex open of 4.6 s in P0 (`docs/superpowers/plans/2026-11-15-p0-baselines.md:87`). **F** as a guarantee: Codex allows 90 s per request with no cap on the chain (`packages/codex-daemon-client/src/app-server-transport.ts:67`), and a hung resume holds the Controller's binding (`ctl/provider-faults.test.ts`, O53) | A message can wait as "sending" without end: pending sends have no bound and no timeout (limits table, Replica C15) | The Relay refuses the page's request at 30 s; nothing on the Controller gives the binding up | Simulator `hang` at resume, on a fake clock: the Controller gives up at the declared deadline and frees the binding, and the operation settles `rejected`, since no native call was made |
| 2.3 | A second input during a running turn is steered, queued natively or refused at once (CLI) | **R** for Codex: "remote thread already has an active turn" refused 179 of 229 terminal tries in M6, and a page message during a terminal turn steers into it (O46). **R** for Claude (`steer` and `queued` recordings). OpenCode steers every send (`opencode/session.ts:399`). **A** for Copilot | The message joins a turn the person did not start (a terminal's), or bounces | The `immediate` rule steers into an active turn (design, Delivery) | Seam ordering test: a page send, a terminal turn's start and its end, in every order, against the simulator's `shared_clients` model |
| 2.4 | A socket that looks open still carries frames (network, browser) | **F**: half-open connections and suspended pages; the client says so itself (`client/page-lifecycle.ts:27`) | A message shown as sending that never left | Pings every 30 s with 10 s to answer on a visible page, and a 4 s probe on return (`client/client/session-channel-transport.ts:76-79,100-118,417-426`); M7 `half-open-socket-recovers` passes | Network simulator in an e2e flow: make the socket half-open just after a `send_message` frame; the page reconnects within the probe, and the retry reuses the operation id |
| 2.5 | Pending sends survive a reload, or the OS ending the tab (browser) | **R** for a reload (`lab/e2e/session-recovery.browser.ts:72-86`). **A** for a tab the OS ends: the ledger is localStorage (`lab/src/message-recovery.ts:4-19`), which Safari's seven-day rule also clears | A message typed on the phone is gone after iOS ends the tab | The ledger restores messages as `unconfirmed` | Browser lifecycle simulator: end the page with no `pagehide`, then reopen; the message returns as `unconfirmed` |
| 2.6 | A session is open before the person types the first message (network) | **F** at a 300 ms round trip: O44, found by smoke M1 | Before the O44 fix, the message was held as "This session could not be opened" and never sent | A waiting message is delivered once its session is ready, however long it opens, and is held as Not sent only for a definite refusal (O44) | Exists: `SessionConversation.opening`, `AgentComposer.pending`, and E9 with a 2 s Relay delay. Missing: the same with the network simulator at 1,500 ms with loss, and an upper bound (2.2) |

### R3 No row lost, doubled or reordered across restart and replacement (T6, the journal)

| # | Assumption (dependency) | Guarantee and evidence | When it fails, the person sees | Handling today | Targeted test |
|---|---|---|---|---|---|
| 3.1 | A reread rebuilds every item not marked live-only, and adds nothing (CLI) | **R**, with exceptions that each cost one replacement: interrupted Codex text is not in history (FC3); a Claude compaction summary and a task notification appear only on reread (FL5, FL6); Codex start-up notices carry the thread id (FC8). **F** for new CLI events: `thread/readState/changed`, `configWarning` and `deprecationNotice` each became a visible "Unsupported Codex notification" row until added to a list (S6a section 12, departure 7; `codex/projector.ts:35-62,236`) | An error row the person cannot act on, and a replacement at the next open | Per-adapter lists and live-only marks (Adapter identity C12, C13) | Kit fault: the simulator sends an event kind the adapter does not know; no visible row, no replacement, one diagnostic |
| 3.2 | An unknown event can be dropped safely (CLI) | The adapters disagree. Codex makes a visible error row (`codex/projector.ts:236,475-478`); Claude and Copilot drop it silently (`claude/projector.ts:71`, `copilot/projector.ts:201`); OpenCode refreshes (`opencode/session.ts:195-196`). **A** that nothing dropped mattered: Claude's documented `rate_limit_event` is dropped this way (R7) | Noise (Codex) or a fact silently missing (Claude, Copilot) | Per adapter | One rule for every adapter, in the kit (section 4.2) |
| 3.3 | A Durable Object restart loses no acknowledged row (Cloudflare) | **D**: the output gate holds replies until writes are durable, and the objects are SQLite-backed (`cf/wrangler.jsonc:40`). Not tested on Workers. M3 passes on the Node Relay | A hole or a doubled row after a deploy | Publisher generations fence old writers; the Controller resumes from the acknowledged position | workerd test: publish, reset the partition object, then page from the last cursor; sequences stay contiguous (section 3.2) |
| 3.4 | A Worker and its Durable Object run the same code (Cloudflare) | **F**, documented (`docs/current/agent-remote/deployment.md:110-119`) and seen at each release since 2026-11-20: the object reported the new version 1 to 5 minutes after the deploy, and smart reading answered `journals_unavailable` for minutes (`docs/superpowers/plans/2026-11-15-im-session-service-roadmap.md:140,205`) | A new page meets an old Relay: a feature is refused or a frame rejected | The partitions Worker deploys first, and the Relay asks `capabilities()` before the first open (`core/journal-partition.ts:26-35`); a manual diagnostics check | Seam test: a new client against an old `ready` frame without the new flags degrades. The partition half exists (`olderPartition`, `cf/test/journal-partition.workers.test.ts:110`) |

### R4 Live state and properties (T5, Orchard decision 5)

| # | Assumption (dependency) | Guarantee and evidence | When it fails, the person sees | Handling today | Targeted test |
|---|---|---|---|---|---|
| 4.1 | The CLI reports the turns, state and settings of every client of a session (CLI) | **R** for the Codex shared daemon: every connection receives the other clients' notifications (`packages/codex-daemon-client/src/thread-router.ts:21-25`); a terminal's turn showed on the page in 633 ms p50 and 787 ms at most (M6). **F** for Claude: a resident session never sees a terminal's turn (`claude/terminal-fork.local.test.ts:20-38`). **A** for Copilot, which has no divergence signal (`ctl/stdio-directory.ts:263`) | The page says idle while a terminal works, and shows the turn late or never | Claude: divergence release (`ctl/transcript-divergence.ts:15-26`); Codex: the daemon's events; the terminal refresh after 30 s of quiet | Simulator `externalWriter` per concurrency model: the page's state follows within one event (shared clients) or within the refresh bound (fork on divergence) |
| 4.2 | A shown session stays attached, so its events keep flowing (CLI, with our scheduler) | **F** today: a journal-served page holds no demand, the Controller releases after 5 minutes, and Codex keeps a thread loaded 60 to 70 s after its last client (**R**, 0.171) | A terminal's turn reaches the page 30 s after it ended, and the page said idle meanwhile (O47) | The terminal refresh | Seam test on a fake clock: a session a page shows stays resident, and the release grace follows the declared unload time |

### R5 Multi-device consistency, inside our system (the boundary rule)

| # | Assumption (dependency) | Guarantee and evidence | When it fails, the person sees | Handling today | Targeted test |
|---|---|---|---|---|---|
| 5.1 | The Controller is the session's only native client, so the Relay's lease orders every writer (CLI) | **R**: two pages, 10 rounds per provider, 240 sends taken, none lost or doubled, the same state and settings on both (M6). It holds only while no terminal writes (R6) | — | S5 control lease; every ordering of four events (`core/domain/session-control/session-control.orderings.test.ts`) | Exists |
| 5.2 | Control leases survive a Relay restart, or every page learns that it lost its lease (Cloudflare) | **D** that a restarted object loses its memory. Each browser stream's lease, with the terminal owner it learned, lives in memory only (`core/stream-control.ts:36-38`). The Relay does not hibernate, so a restart closes every socket (`deployment.md:246-251`), and clients acquire again on reconnect (`client/client/remote-session-client.ts:206-208,635-649`). Not tested on Workers | A send during the reconnect is refused once as read-only; a terminal's ownership is known again only at the next refusal | A new stream starts read-only with a fresh revision (`core/domain/session-control/session-control.ts:9-10`) | workerd test: two pages hold control and one has seen a terminal owner; reset the Relay object; each page returns read-only and acquires again, and a send to the terminal's session is refused with the owner named |
| 5.3 | A call from the Relay object to the partitions Worker arrives, or fails visibly (Cloudflare) | **D** that Durable Object RPC can throw (overload, a reset during a code update). No retry: a failed `publish` closes the uplink with 1011 (`core/host-session.ts:387-392`), and the Controller reconnects with a 1 to 30 s backoff | Rows pause for a few seconds; nothing is lost | Fencing and the acknowledged position | Seam test: a partition stub throws once in the middle of a publish; the uplink returns and the journal stays contiguous |

### R6 Terminal coexistence, outside our system (the boundary rule)

| # | Assumption (dependency) | Guarantee and evidence | When it fails, the person sees | Handling today | Targeted test |
|---|---|---|---|---|---|
| 6.1 | Codex refuses a separate process while the daemon holds the thread, and says so recognisably (CLI) | **R** on 0.171: JSON-RPC `-32600` "thread <id> already has an active writer", and the thread unloads 60 to 70 s after its last client (O46; M6 `writableAfterReleaseMs` 65,178). Not documented by Codex, and matched by exact message text (`codex/session.ts:676-677`) | No rows, "Native CLI has control" and "Interrupt & take over", which would stop the other process; its turn did not reach the page within 90 s (O48) | The Controller turns the refusal into `native_session_owned` when it finds a writer lock (`ctl/directory.ts:231-236`); the journal-served stream refuses the page when the attach at open is refused | Simulator `single_writer` with the writer busy: the journal stays served, the page states Codex's reason and offers Retry after the declared unload time, and no take-over is offered. `ctl/provider-faults.test.ts` covers the Controller half |
| 6.2 | Codex's shared daemon orders the turns of several clients (CLI) | **R** on 0.171: 50 of 50 terminal turns delivered and shown in M6, with 179 refusals while a turn ran | — (M6 passes) | The daemon's events; the smoke terminal retries on the refusal (`e2e/smoke/lib/terminal.ts:21-22`) | Native check of the two refusal texts (section 4.4) |
| 6.3 | Two writers of a Claude Code session extend one history (CLI) | **F**. Claude Code coordinates no writers: there is "no public external-session lock probe" (`docs/current/agent-remote/claude-normalized-events.md:90`), and concurrent turns fork the transcript. M6 failed all 50 rounds: the page lost the terminal's message in 50, native history lost the terminal's in 26 and the page's in 21 (O49) | The page and the terminal disagree for good, and one side's turn is gone from what the model sees | Divergence release, which misses turns that end within 2,000 ms of each other (`ctl/transcript-divergence.ts:15-21`, Session core C10) | Simulator `fork_on_divergence`: two writes 0 to 2,000 ms apart fork; a content rule (the transcript's newest leaf against the resident session's last message) releases and rereads, and the page shows the branch that native history shows |
| 6.4 | Copilot reports another client of a session (CLI) | **D** for the moment of resume: the SDK's `sessions.checkInUse` (`copilot/provider.ts:108-112`). **A** afterwards: it is not asked again | A terminal that opens the session later writes beside the page unseen | Resume refused with `AgentSessionInUseError` | Simulator: another client takes the session after the resume; the page shows what the declared model says |
| 6.5 | OpenCode's server arbitrates its clients (CLI) | **D** for OpenCode's design: no lease, every send steers, and a busy session answers 409 (`docs/opencode.md:83`, `opencode/transport.ts:67`) | — | Not journal-capable, so read through the Controller | When OpenCode joins the kit (section 4.5) |

### R7 Quota and account behaviour

| # | Assumption (dependency) | Guarantee and evidence | When it fails, the person sees | Handling today | Targeted test |
|---|---|---|---|---|---|
| 7.1 | A usage or rate limit arrives in a recognisable shape (CLI) | **D** in every CLI, and dropped by every adapter. Claude's `rate_limit_event` carries a status and `resetsAt` (Agent SDK 0.3.247, `sdk.d.ts:4615-4629`), dropped at `claude/projector.ts:71`. Copilot's `session.error` carries `errorType` `rate_limit` or `quota` and a code (`@github/copilot-sdk` 1.0.11, `session-events.d.ts:1009-1019`), reduced to its message at `copilot/projector.ts:158`. Codex's `account/rateLimits/updated` is a non-timeline notification (`codex/projector.ts:36`). OpenCode's `session.retry.scheduled` only refreshes. The SDK has no error for it (`sdk/provider.ts:60-65`) | "Claude turn failed." or a generic attach failure, with no time to wait; a queued message wakes the runtime and fails again | Not handled; `ctl/provider-faults.test.ts` pins the gap | Simulator `rateLimit { retryAfterMs }`: a typed `native_usage_limited` with `resetsAt`; the page says when; the queue holds and wakes once after the reset |
| 7.2 | A CLI whose sign-in expired says so distinctly (CLI) | **A**: no adapter recognises it; the CLI's text arrives as a turn failure or an attach failure | A failure the person cannot act on from the phone | Not handled | Simulator `authMissing` at resume and mid-turn: a typed `native_auth_missing`, shown as "sign in again on <Host>" |
| 7.3 | The journal's quotas fit Cloudflare's per-object limits (Cloudflare) | **D**: 12 MiB per session and 1 GiB per Host on Cloudflare, 64 MiB per session on Node (`core/journal-partition.ts:11-12`, `core/host-journals.ts:11-17`) | — (M4 passes at small limits) | A window is refused whole and the session reads through the Controller (Journal C13, C18) | Run M4's limit checks through the same core at the production values (section 3.2) |

### R8 Phone and installed-app behaviour (Orchard: Phone, and the IM map's notifications)

| # | Assumption (dependency) | Guarantee and evidence | When it fails, the person sees | Handling today | Targeted test |
|---|---|---|---|---|---|
| 8.1 | Mobile Safari keeps a hidden page's WebSocket and timers (browser) | **F**: iOS suspends hidden pages, and a suspended browser may keep a socket whose connection died (`client/page-lifecycle.ts:27`). The hidden keepalive assumes a timer still runs about once a minute (`client/client/session-channel-transport.ts:78`) | On return, a moment of stale content; a message typed at once waits for the reconnect | On return, a closed socket reconnects and an open one is probed within 4 s (`session-channel-transport.ts:100-118`); a back-forward cache restore counts as a suspension (`client/page-lifecycle.ts:53-56`) | Browser lifecycle simulator on `webkit-mobile`: suspend with no timers, make the socket half-open, resume after 10 s and after 10 min; one tail request, no label, the draft kept (M7's invariants on WebKit, in seconds) |
| 8.2 | Real backgrounding and back-forward cache behave like the synthetic events the tests dispatch (browser) | **A**. Every test dispatches `visibilitychange`, `pagehide` and `pageshow` itself (`lab/e2e/session-recovery.browser.ts:64-67`, `e2e/specs/pending-send.spec.ts:31-52`, `e2e/smoke/lib/observer.ts:80-85`); no real device or simulator runs | A defect only a phone shows; O30, O31 and O32 were of this kind | — | Native check by hand on an iPhone before a release that changes the client's lifecycle (section 3.4) |
| 8.3 | A fetch that a page lifecycle aborts is retried quietly (browser) | **A**. WebKit logs an aborted `/v1/remote/hosts` fetch "due to access control checks" during reloads: the `session-recovery` flake, open since the baseline (target architecture 11.8); its cause is not established | An error, or a failed poll, on the phone | `lab/src/hooks/useRemoteHosts.ts:22-35` catches rejections | Component test on WebKit: abort the hosts request during a reload; no page error |
| 8.4 | An installed home-screen app learns that an assistant needs the person while it is in the background (browser) | **F** for a suspended page: there is no service worker and no push (`lab/src/session-notifications.ts:102-113`), so "needs you" reaches the person only while the page runs | An approval waits unseen on the phone | In-page notifications only | Not a test: a design step (IM gateway decision 3, server-side attention) |

### Our own documents that disagree with the code

Each is an assumption a reader would take as documented:
- `docs/current/agent-remote/seams.md:23` says recordings carry the CLI version in their header; none does. (Closed 2026-11-22: every recording names it, and `pnpm fixtures:check` requires it.)
- `seams.md:105` promises a partition capability retry every 30 s; the code asks again at the next open (`core/journal-partition.ts:126-134`).
- `docs/current/agent-remote/providers.md:83` says a Codex open hydrates `thread/read` history; it reads `thread/turns/list` and falls back to `thread/read` only on `-32601`. The same file's `historyMode: "paginated"` (`:139`) appears nowhere in the code.
- `docs/current/agent-remote/copilot-normalized-events.md:38` keys Copilot's todo board `todo:<uuid>`; the code uses one key, `todo`.

## 2. What explains the smoke failures of seed 70621

| Failure | Explained by | How |
|---|---|---|
| M6, Claude terminal: `no-lost-or-doubled-message` (97) and `terminal-rows-appear` (50 of 50) | 6.3 (**F**) and 4.1 (**F**) | Not a harness fault and not a defect inside our system: the native session forked. No terminal turn reached the page in any round (`terminalShownMs.count` 0), even in the 24 rounds where native history kept it. The resident session continues its own branch, and the 2,000 ms rule never fires when both turns end close together |
| M6, separate Codex process: `page-stays-live-when-codex-refuses` (5 of 5) | 6.1 (**R**, undocumented) and 4.2 (**F**) | Codex's single writer meets our take-over model: the refusal becomes `native_session_owned`, the journal-served stream refuses reads that need no Controller, and nothing observes the session read-only (O48) |
| M6, everything else | 5.1 and 6.2 (**R**) | Two pages: 240 sends, none lost or doubled. A Codex terminal through the shared daemon: 50 of 50 turns shown, in 633 ms p50 |
| M2, rounds 8 and 10: `message-settles-once`, `turn-rows-complete-after-return` | A harness fault (O52) that lands on 2.1 (**F**) | The Controller stopped 6 ms after the send left the page, and the text never reached Codex. The product kept its contract: `unconfirmed`, and the next message held behind it (Replica C6, C10). The person would have had to check it: the send carried no input id, so nothing could ask Codex whether it arrived. Six of the ten graceful stops (rounds 6 to 16, all Codex) took 2.1 to 2.7 s and the others 0.1 s, which is consistent with the Codex transport's 2,000 ms graceful shutdown (`packages/codex-daemon-client/src/app-server-transport.ts:68,209`) |
| M1, 1,500 ms: `first-paint-from-device-store` | A harness fault (O51) that lands on 1.2 (**A**) | The probe closed the page 0.8 s after the opened session's first page, before its record was kept. On a phone, someone who opens a conversation on a slow network and switches apps at once meets the same thing; no WebKit test covers it |

The two M6 failures are known-false CLI assumptions that our design does not yet meet. M1 and M2 failed on harness timing, but each lands on an assumption that no test checks.

## 3. Simulators for every external dependency (recommendation, first part)

Every gap in the matrix must be reproducible under our control before a fix or a design change is chosen: deterministically, with exact timing, in seconds. That evidence then decides between a fix and a change of the design. A real dependency that surprises us becomes first a simulator behaviour, then a failing test, then a decision. The provider contract of section 4 builds on this: the CLI simulator is driven by the same declared behaviour that an adapter exports.

### 3.1 CLI simulator: one controllable simulator at the provider port

**Exists.**
- **The e2e scripted provider** (`e2e/stack/scripted-provider.ts:86`), behind a real Controller and the Node Relay (`e2e/stack/stack.ts:57`). It scripts:
  - turns with tools and approvals, and two-piece streaming;
  - `hold()`;
  - `terminalWrite`, which marks divergence;
  - `terminalTakes`, an owner refusal;
  - `fork`;
  - `replaceHistory`, so the next reopen reads changed or reordered rows.
- **The fault provider** (`ctl/test-utils/faulty-provider.ts`, with `ctl/provider-faults.test.ts`): `writer-busy`, `rate-limited`, `slow`, `hang` and `unknown-event`, all at open, and `heal()`. Step B2 replaced it with the CLI simulator (`ctl/test-utils/simulated-cli.ts`, clauses in `components/cli-simulator.md`), driven by the declared behaviour.
- **Session doubles:** `ctl/test-utils/journal-scripted-session.ts` (older pages, a read gate, a clock), and `packages/agent-remote-fixtures/src/scripted-session.ts` and `recorded-rows.ts`.
- **Fake model APIs behind the real CLIs,** which produce the recordings: `codex/test-utils/native-responses-fixture.ts`, `codex/test-utils/scripted-app-server.ts` and `claude/test-utils/native-fixture.ts`.

**Missing.**
- **A behaviour profile.** The knobs are per-test functions. None declares a concurrency model, a reread order, a resume cost, a limit signal or a failure taxonomy.
- **Faults in the middle of a turn:** a crash or exit at a chosen step, a hang after the native call, `turn_failed` with a code, questions and plan approvals.
- **A fake clock:** everything runs on real timers.
- **Replay of a recording's live side with its timing:** `recordedHistory()` loads only the reread.
- **A place in `pnpm local`:** the runner starts real CLIs only (`scripts/local/runner.mjs:74`), and the smoke's scripted second Host (`e2e/smoke/lib/scripted-host.ts:23`) is not exposed.

**Proposal.**
- **One simulator.** `simulatedProvider(profile, { overrides, script, clock })` lives in a `./simulator` entry of the Provider SDK, which is the boundary; it depends on nothing else.
- **The profile is the adapter's declared behaviour** (section 4.1). For example, "Codex with a single writer and a 4 s resume" is `simulatedProvider(codex.behaviour, { overrides: { concurrency: 'single_writer', resumeMs: 4000 } })`.
- **Fault knobs carry exact timing**, such as `{ at: 'delta', n: 3, fault: 'crash' }`:
  - `slowResume(ms)`, `hang(at)`, `crash(at)`;
  - `rateLimit({ retryAfterMs })`, `authMissing(at)`;
  - `unknownEvent(kind)`, `schemaDrift(field)`;
  - `writerBusy(untilMs)`;
  - `externalWriter({ at, text })`, whose effect follows the concurrency model: live events for shared clients, a refusal for a single writer, a second branch on reread for fork on divergence;
  - `rereadOrder('completion' | 'permute-siblings')`.
- **Seeding.** Default shapes and timings come from the committed recordings: live observations with their `occurredAt`, then the reread.
- **Where it runs:**
  - unit and seam tests, with an injected clock;
  - the e2e stack, where it replaces the scripted provider's ad hoc knobs;
  - `pnpm local`, as an extra registration of the development Controller under its own provider id (for example `ARC_LOCAL_SIMULATED=codex:single_writer,resumeMs=4000`), so the person's real sessions are untouched.

**Size.** L in all, in three M steps:
1. the profile, timing and the fake clock;
2. the mid-turn faults and the concurrency models;
3. the `pnpm local` registration.

### 3.2 Relay platform: reuse workerd, add thin knobs

**Rule.** We write no Durable Object emulator. Cloudflare's local runtime models objects faithfully: workerd through Miniflare 4, which the package's Workers tests already start directly (`cf/test/fixture.ts:141-201`; they do not use `@cloudflare/vitest-pool-workers`). We add only knobs that belong to our system.

**Knobs.**
- **Production limits as configuration.**
  - *Exists.* `JournalPartition.tuning()` (`cf/src/journal-partition.ts:37-40`) and `serveJournalPartition(..., { replyMaxBytes })`. `createHostJournals` takes `limits`, `cache` and `retention`. The S5 seam builds the Cloudflare values in Node (`packages/agent-remote-seams/tests/S5/partition-server.ts:18`). The Node Relay takes `journalLimits`, and `pnpm local` takes `ARC_LOCAL_JOURNAL_LIMITS` (`scripts/local/environment.mjs:42-55`).
  - *Missing.* One exported production profile: the reply bound is a private constant (`core/journal-partition.ts:14`). The Node Relay has no `cache` or `retention` option, so `pnpm local` and M4 run Node defaults (64 MiB per session; 64 journals and 128 MiB of cache, `core/host-journals.ts:11-17`) instead of Cloudflare's.
  - *Size* S.
- **Induced restart or eviction.**
  - *Exists.* `restart()` disposes and starts the whole runtime with storage kept (`cf/test/fixture.ts:277`).
  - *Missing.* Losing one object's memory while the Worker and the other objects live. The fixture already compiles test-only object classes (`OlderJournalPartition`, `cf/test/fixture.ts:133`) and reaches `primary` through `/_fixture/` paths (`:276`). A test-only subclass or fixture path that calls `this.ctx.abort()`, workerd's own reset of an object, suffices; the next call constructs the object again from its storage.
  - *Size* S.
- **Independent Worker and Durable Object versions,** emulated at our seam, not in the platform.
  - *Exists.* `capabilities()` before the first open (`core/journal-partition.ts:26-35`), the call record `journal-partition.contract.json`, and the `olderPartition` refusal (`cf/test/journal-partition.workers.test.ts:110`).
  - *Missing.* The client half: a new client against an old Relay's `ready` frame without the new flags. The Relay half: a new Worker in front of a Relay object still on the previous version, which was the `journals_unavailable` of 2026-11-20. Both are seam tests over recorded frames.
  - *Size* S.

**The cheapest faithful check for each Cloudflare behaviour of the matrix:**

| Behaviour (matrix row) | Check | Cost |
|---|---|---|
| Reply and cache bounds (1.6) | workerd test through `tuning()` at production values: bound minus one entry, at and over it | S, half a day |
| Acknowledged rows survive a restart (3.3) | workerd test: publish, `ctx.abort()` on the partition, page from the cursor | S |
| Worker and object on different versions (3.4) | Seam tests over recorded frames, plus a post-deploy script that requires fresh `workerVersionId` entries from `agent-remote-controller diagnostics --source server` (`deployment.md:110-119`) | S |
| Leases after a Relay restart (5.2) | workerd test: two pages hold control, `ctx.abort()` on `primary` | S |
| An RPC between objects fails (5.3) | Seam test with a partition stub that throws once | S |
| Journal quotas at production values (7.3) | The same core in Node with the production profile, as the S5 seam does | S |
| A late or repeated alarm | Seam test with a fake scheduler (`core/test-utils/relay-world.ts:90-95` already runs a refresh "as a Durable Object alarm would") | S |
| Frame and message size (16 MiB, 32 MiB) | workerd test with a frame at the bound; today only a fake socket checks it (`cf/test/socket.test.ts:33-43`) | S |

**Not worth it:**
- **An emulator of eviction policy, isolate memory accounting or CPU limits.** workerd does not model eviction timing, and a bound in our code (cache size, reply size) is cheaper and deterministic.
- **Emulating how Cloudflare rolls code out across locations.** It is not deterministic; the version seam and the post-deploy check cover what we control.
- **The network between a Worker and its object.** It surfaces as an RPC error, which the seam test injects.
- **Load and latency profiles of the edge.** Production diagnostics measure them.

### 3.3 Network simulator

**Exists.**
- **The latency proxy** (`e2e/faults/latency-proxy.mjs:77`), seeded: round trip, jitter, TCP-like loss and a bandwidth cap, plus `closeWebSockets`, `halfOpenWebSockets({ direction })` and `setOffline` (`:179-197`). Smoke M1 and M4 to M8 use it.
- **In the e2e flows:** `watchSockets`, with `drop()` and a hold until the first page or Snapshot (`e2e/flows/page.ts:123-148`), and `relayDelay` (`e2e/flows/browser.ts:37,45`).
- **In the seams:** a socket tap that drops one chosen frame (`packages/agent-session-runtime/src/relay-connection.ts:22-33,55-56`).

**Missing.**
- Acting on a chosen frame, by type and ordinal: delay, drop, duplicate or reorder it.
- A half-open connection after N frames, and a fault on one connection only.
- The proxy in the e2e flows.
- A virtual clock in the seams.

**Proposal.** One fault script, such as `[{ when: { dir: 'browser->relay', type: 'send_message', n: 1 }, then: 'half-open' }]`, applied alike by the proxy (flows and smoke) and by the seam tap. **Size** M.

### 3.4 Browser lifecycle simulator

**Exists.**
- The `PageLifecycle` port with `stubBrowserPage` (`client/page-lifecycle.ts:6-24`, `client/testing/page.ts:12,22`).
- `fake-indexeddb`, and `failWrites` (`client/testing/device-database.ts:3-25`).
- In browsers: synthetic page events (8.2), `context.setOffline`, and WebKit projects under Playwright emulation.

**Missing.**
- A suspension that stops timers and kills or half-opens the sockets together, as iOS does, run the same way on WebKit and Chromium.
- A real back-forward navigation.
- Deleting IndexedDB and localStorage between visits, or under a running page.
- Ending a page with no `pagehide`.
- An installed-app context beyond the faked `navigator.standalone` for layout (`lab/e2e/components/installed-app.spec.ts:9-27`).

**Proposal.**
- `suspend({ timers: false, sockets: 'half-open' | 'closed' })`, `resume()`, `evictStorage()`, `kill()` and `standalone()` in the e2e page helpers. They use the network simulator for sockets and Playwright's clock for timers.
- A five-step check on a real iPhone, before a release that changes the client's lifecycle:
  1. background the page for 10 s;
  2. background it for 10 min;
  3. lock the phone during a send;
  4. return from another app;
  5. open from the home screen after a week.

**Size.** M; the iPhone check S.

### 3.4b Push service simulator (I5c)

The browsers' push services (Apple's, Google's, Mozilla's, Microsoft's) became a dependency with push reminders, and got their simulator before the sender: `@orchardworks/agent-remote-fixtures/push-service`, in memory (its `fetch` is the sender's port) or at a loopback port. It states what it models as data (`PUSH_SERVICE_MODELLED`): accept (201) after a real service's checks (TTL, Urgency, Topic, `aes128gcm`, and a VAPID token signed by its key, for its origin, valid for at most 24 hours, with a `mailto:` or `https:` subject and the subscription's key); an expired subscription (404 or 410); rate limiting (429 with `Retry-After`); the 4096-byte payload limit (413); and delivery to the browser: pushes held while it is offline, a newer push of the same `Topic` replacing the held one, TTL expiry, drops and reordering. It plays the browser too, so a test reads each push decrypted. Seam S8, the Relay's unit tests and the flow E14b use it. Its fidelity check is a real device: the installed app on a locked iPhone, and desktop Chrome with no Orchard window open.

### 3.5 Fidelity checks

- **Each simulator states what it models, as data:** the CLI simulator its profile, the platform knobs their production values, the network script its fault kinds, and the lifecycle simulator its events.
- **Native-tier checks compare that statement with the real dependency:** for a CLI, the installed version (section 4.4); for Cloudflare, a deployed Worker's diagnostics and a dry run; for browsers, the iPhone check.
- **A surprise is handled in this order:** add the behaviour to the simulator; reproduce it there with a seed; then fix, or change the design. This is the smoke rule of section 5.7, applied to dependencies.

### 3.6 Order: reproduce the riskiest gaps first

1. **CLI concurrency models and refusals:** fork on divergence, a single writer with an unload time, and shared clients. They reproduce M6's two failures (O48, O49) in seconds.
2. **CLI limits and the failure taxonomy (7.1, 7.2, 2.2):** a rate limit, a lost sign-in, a hang mid-turn, a crash after a send.
3. **Reread order and identity drift (1.3, 1.4),** seeded from recordings with their timing.
4. **The browser lifecycle on WebKit (8.1, 2.5, 1.1, 1.2).**
5. **Network frame scripts in the flows (2.4, 2.1).**
6. **The platform knobs (5.2, 3.3, 3.4, 1.6),** S each.

## 4. A designed provider boundary (recommendation, main part)

More CLIs will be integrated, so robustness at the CLI boundary is designed once and not patched per CLI. The Provider SDK is the stable boundary.

Today, knowledge of how each CLI behaves is spread over 98 places outside the adapters that branch on a provider id: 58 in the Controller, 19 in the Workbench, 11 in Relay core, 6 in the Node Relay, 3 in the protocol and 1 in the session runtime. Six more groups of behaviour sit behind hooks that only one or two adapters implement. Not one branch handles usage limits or live-only items. Two precedents show the shape the boundary should take, each in the wrong place:
- the Node Relay's `requiredDegradations` declares each provider's degraded capabilities, as a release check (`packages/agent-relay-node/src/compatibility.ts:8-51`);
- the Controller's directory type declares `preservesWorkOnDisconnect` (`ctl/session-core/types.ts:82`), which Codex and OpenCode set (`ctl/codex.ts:29`, `ctl/opencode.ts:25`) and no production code reads.

### 4.1 The behaviour contract in the Provider SDK

Each adapter declares how its CLI behaves, as data. The contract extends what the SDK has:
- `AgentProviderAdapter.journal` (`sdk/provider.ts:184`, `sdk/item-identity.ts:6-12`) gains the history semantics;
- `AgentProviderDescriptor` (`sdk/provider.ts:30-43`) gains `behaviour`, which replaces the deprecated `AgentCapabilities.sessionControl` (`sdk/provider.ts:7-8`);
- the typed errors (`sdk/provider.ts:51-73`) gain codes and reasons;
- `ProviderItemIdentity.liveOnly` (`sdk/observation.ts:140-145`) stays the mark on an item, and the declaration lists the kinds that carry it.

```ts
interface AgentJournalCapability {                 // sdk/item-identity.ts, extended
  readonly itemIdentity: 1;
  readonly order: 'live' | 'siblings_unordered';   // a reread may permute the complete siblings of one turn
  readonly liveOnly: readonly ('interaction' | 'todo' | 'error' | 'startup_notice' | 'reasoning' | 'synthetic_output')[];
  readonly history: { paging: 'turns' | 'messages' | 'none'; withoutAttach: boolean; cost: 'page' | 'whole_session' };
}
interface AgentProviderBehaviour {                 // AgentProviderDescriptor.behaviour
  readonly concurrency: {
    model: 'single_writer' | 'shared_clients' | 'fork_on_divergence' | 'none';
    probe: 'native' | 'lock_file' | 'none';        // how another writer is detected
    othersVisible: 'live' | 'on_reread' | 'never'; // whether another client's turns reach this attachment
    unloadAfterLastClientMs?: number;
  };
  readonly resume: { cost: 'subscription' | 'shared_process' | 'process'; deadlineMs: number };
  readonly input: { identity: 'echoes_client_id' | 'none'; whileBusy: 'steer' | 'queue' | 'refuse' };
  readonly limits: { signal: 'event' | 'error' | 'none' };
  readonly verifiedVersion: string;                // what the native checks last confirmed
}
// AgentRuntimeError codes, extended: 'native_usage_limited' (with resetsAt), 'native_auth_missing', 'native_exited', 'native_unresponsive'.
// AgentSessionInUseError, extended: { reason: 'writer_elsewhere' | 'turn_running'; retryAfterMs?: number }.
// An unknown event or a schema drift is a diagnostic: counted and reported, never a timeline row.
```

What each adapter would declare today. **A** marks a value that only a native check can settle.

| Field | Codex | Claude Code | Copilot | OpenCode |
|---|---|---|---|---|
| `concurrency.model` | `shared_clients` through the daemon; a separate process meets a single writer | `fork_on_divergence` | `single_writer` | `shared_clients` |
| `probe` | `lock_file` (`thread-writer-locks`) | `none` | `native` (`checkInUse`) | `none` |
| `othersVisible` | `live` | `on_reread` | `never` (**A**) | `live` |
| `unloadAfterLastClientMs` | 70,000 (0.171) | — | — | — |
| `resume` | `subscription`; 90 s per request, no cap | `process`; 15 s start-up | `shared_process`; 15 s per call | `subscription`; 15 s |
| `input.identity` | `echoes_client_id` (`clientUserMessageId`) | `echoes_client_id` (uuid, FL1) | `none` (**A**) | `none` (**A**) |
| `input.whileBusy` | `steer` | `steer` or `queue` | **A** | `steer` |
| `limits.signal` | `event` (`account/rateLimits/updated` every turn; its shape at the limit: **A**) | `event` (`rate_limit_event`) | `error` (`errorType`) | `event` (`session.retry.scheduled`) |
| `journal.order` | `live`, after the start-order sort | `siblings_unordered` (tool results) | `siblings_unordered` (todo) | not journal-capable |
| `journal.liveOnly` | interaction, todo, error, startup_notice | interaction, synthetic_output | interaction, reasoning, todo, error | none declared |
| `history.withoutAttach` | **A**: `thread/turns/list` on an unloaded thread (O47) | yes: the transcript | no | yes: the server |

### 4.2 Generic policies, keyed on the declared behaviour

| Policy (Controller or session runtime) | Keyed on | Replaces |
|---|---|---|
| A deadline for each resume and history read; a hung resume is given up and its binding freed | `resume.deadlineMs`, `history.cost` | 90 s per Codex request with no cap; a binding held until the CLI answers (O53) |
| Retry with backoff, for opens and wakes only, never for a send | `retryAfterMs`, `resetsAt` | No retry |
| An unknown send is settled by a reread of the echoed id, never by a replay | `input.identity` | Unknown until the person checks (2.1) |
| Degraded read-only mode: keep serving the journal, observe read-only, and state the native reason | `concurrency`, `history.withoutAttach` | Reads refused and a take-over offered (O48) |
| Divergence decided by content | `fork_on_divergence` | The 2,000 ms rule on a hook only Claude implements (O49) |
| Release grace and residency | `unloadAfterLastClientMs`, `resume.cost` | A fixed 5 minutes; a Claude session never idle-released unless it diverged (`ctl/stdio-directory.ts:263-265`) |
| Reread comparison | `journal.order` | Any permutation is a replacement |
| A refusal in business words | the typed error and its reason | Provider prose in the Controller and the Workbench |
| Unknown events | diagnostics only | A visible Codex row; a silent drop elsewhere |

**Every provider branch, and what replaces it** (inventory of 2026-11-21; production code only):

| Branches | They decide | Replaced by |
|---|---|---|
| **Concurrency, 10.** `ctl/registrations.ts:37-40`; `ctl/cli.ts:107-117`; `ctl/directory.ts:229-244`; `ctl/opencode-directory.ts:185`; `ctl/claude.ts:46`, `ctl/copilot.ts:39`; `ctl/stdio-command.ts:15-53`, `ctl/claude-command.ts:13-24`, `ctl/copilot-command.ts:15-27`; `ctl/codex-command.ts:50-61`; `ctl/opencode-command.ts:27-45`; the directory each provider gets (`ctl/codex.ts:31`, `ctl/claude-directory.ts:9`, `ctl/copilot-directory.ts:8`, `ctl/opencode.ts:24`); `lab/src/components/NativeSessionCommands.tsx:22-27,46` | Who may write; take-over or share; what the terminal wrapper does | `concurrency.model` and `probe`. The terminal command and the Workbench note read them |
| **Hooks one or two adapters implement, 6 groups.** `sessionState` and `sessionNativeUpdatedAt` (Claude; `ctl/stdio-directory.ts:263-272`); `listing`, `reconcileIdleSession`, `canReleaseSession`, `inspectSessionOwner`, `releaseSessionOwner` and `readSessionSummary` (Codex; `ctl/directory.ts:84-88,140-142,229-244`); `releaseSession` (Claude, Copilot); `cleanupFailedSession` (Claude); `sessionRenameRequiresOpen` (Copilot) | Divergence, listing, idle release, take-over | They stay hooks, but the declaration says which must exist, and the kit checks that they do |
| **History and listing, 4.** `ctl/directory.ts:47,83-88`; `ctl/opencode-directory.ts:119-144`; `core/session-bindings.ts:499-505`; `lab/src/components/SessionDirectory.tsx:103-104` | Listing cost and read path | `history.cost` and `history.withoutAttach`. The Workbench reads the Controller's `directory.listing` flag instead of `providerId === 'codex'` |
| **Resume and release, 5.** `ctl/directory.ts:140-142,207-223`; `ctl/opencode-directory.ts:126-127`; `ctl/claude.ts:48-49`; `ctl/codex.ts:29` | Idle release, wake, empty sessions | `resume.cost` and `unloadAfterLastClientMs` |
| **Failure mapping, 5.** `ctl/provider-discovery.ts:77`; `ctl/codex-daemon-restart-error.ts:1-17`; `lab/src/components/NativeSessionCommands.tsx:54-63`, `lab/src/components/SessionConnectionNotice.tsx:32,52`; `lab/src/state/agent-creation.ts:12-16`; `native_file_limit` naming the Codex daemon (`packages/agent-remote-protocol/src/model/session-errors.ts:5`) | Which failure gets words | The typed failure taxonomy |
| **Capabilities, 16.** `ctl/provider-discovery.ts:58-60`; `ctl/gateway-setup.ts:37-38`; `ctl/directory.ts:96,157-174`; `ctl/opencode.ts:19-20`; `nativePermissionControl` (`ctl/codex.ts:30`, `ctl/claude.ts:44,50`); `packages/agent-relay-node/src/compatibility.ts:8-51`; the Workbench's DSH gates (under `lab/src/`: `components/SessionDirectory.tsx:233`, `components/WorkspaceSelect.tsx:51`, `app/useViewModel.tsx:182`, `state/fork-plan.ts:10-12,56-57`, `state/quote-flow.ts:10,30`); `lab/src/components/favorites/RenameSessionDialog.tsx:44`; `lab/src/components/NativeSessionCommands.tsx:20-21`; old-style DSH in Relay core (`core/session-bindings.ts:161-164`, `core/session-directory-routes.ts:94-122`) | Which features are offered | `AgentCapabilities` and descriptor fields, which exist; the Workbench reads them instead of the id. The old DSH register path goes with crude mode |
| **Process and daemon management, 23.** `ctl/provider-discovery.ts:46,49-61`; `ctl/host.ts:66,118,125,145`; `ctl/cli.ts:72-88,197-221`; `ctl/codex-shared-startup.ts`; `ctl/codex-daemon-*.ts`; `ctl/opencode-server*.ts`; `core/host-service-routes.ts:101`; `core/gateway.ts:992`; `packages/agent-remote-protocol/src/codex-daemon.ts`; `lab/src/components/HostCodexDaemon.tsx:7-13` | Starting and supervising a CLI's server | It stays specific to the CLI, behind one registration hook (`prepare`, `supervise`), so the Controller core and the Relay no longer name it |
| **Presentation, 6.** `ctl/provider-discovery.ts:12`; `ctl/directory.ts:53`; `ctl/opencode-directory.ts:138`; `packages/agent-relay-node/src/compatibility.ts:209-210`; `lab/src/components/SessionSuccessionDialog.tsx:13`, `lab/src/components/favorites/RenameSessionDialog.tsx:11` | Names | `descriptor.displayName`, which exists |
| **Other, 29.** Old-style DSH register and binding (9); the closed provider list and its defaults (6: `ctl/registrations.ts:8-32`, `ctl/session-reference.ts:38`, `lab/src/hooks/useSessionMigrations.tsx:36`, `lab/src/components/SessionSuccessionDialog.tsx:16-17`, `lab/src/app/useSendingAndSuccession.tsx:184`); Gateway credentials (4); version pins (4: `ctl/controller-health.ts:2`, `ctl/codex.ts:23-28`, `ctl/claude.ts:33-38`, `ctl/copilot.ts:31-35`); structural imports (3); title arrival (`lab/src/hooks/useNativeTitles.ts:6-15`) | Defaults, versions, packaging | Version pins become `verifiedVersion`, kept by the native checks. The closed list becomes the registrations present. DSH's old path goes with crude mode |

### 4.3 The provider conformance kit

**Today.** `pnpm test:conformance` has 31 tests of the Node Relay's protocol and broker: the session directory (5), the standalone client (1), the remote-host broker (13) and the debugger's local prefix (12).

**Proposal.** It gains a provider part that every adapter, present and future, must pass: `runProviderConformance(adapter, { recordings, nativeFakes })`, from a `./conformance` entry of the SDK. All of it runs on mock data, in seconds per adapter.
1. **Recorded-session replays.** They exist in part: 41 S1 seam tests, and `ctl/journal-continuity.recordings.test.ts` for Claude and Codex. Three checks:
   - live order against reread order, with no `late` exemption unless the adapter declares `siblings_unordered`;
   - identity stability: reread keys equal live keys, and five rereads add nothing;
   - continuity across a restart: reopening a settled session gives `unchanged`.
2. **Fault injection through the port:** slow resume, rate limit, crash, hang, unknown event and active writer.
   - At the adapter, through its native fake (`codex/test-utils/scripted-app-server.ts`, `claude/test-utils/native-fixture.ts`).
   - At the Controller, through the simulator.
   - Each fault surfaces as the declared typed error or as a diagnostic.
3. **Declared-behaviour checks:** the adapter really behaves as it declares. For example:
   - `echoes_client_id`: the reread holds the id;
   - `limits.signal`: the recorded signal maps to `native_usage_limited`;
   - `liveOnly`: exactly the declared kinds carry the mark;
   - `withoutAttach`: the read makes no attach call.

### 4.4 Native assumption checks for each CLI

They run nightly in the native tier (`*.local.test.ts`, beside `pnpm test:claude` and `pnpm test:codex-shared`), for each installed CLI:
- **Versions.** Write the CLI version into each recording's header, as `seams.md:23` already requires. Fail when the installed version differs until `pnpm record:provider` refreshes the recordings.
- **Shapes.** Record `settled`, `restart` and `parallel-tools` again, and compare their `recordingShape`.
- **Every declared field, against the real CLI:**
  - two writers: Codex's two refusal texts and its unload time, Claude's fork, Copilot's `checkInUse`;
  - the resume time against its cost class;
  - the limit signal, from a scripted 429 of the fake model API;
  - every error text the adapter matches as a string, such as `thread <id> already has an active writer` (`codex/session.ts:676-677`);
  - the notifications of a normal turn that no list knows.
- **Verified versions.** `verifiedNativeVersions` (`ctl/controller-health.ts:2`: Claude 2.1.296, Codex 0.162.0) is replaced by the declaration's `verifiedVersion`.

A difference fails loudly and names the declared field it contradicts.

### 4.5 Onboarding a CLI, and what OpenCode and Copilot still need

Onboarding a CLI is four steps: implement the adapter, declare its behaviour, pass the kit, and add its native checks. It needs no change in the Controller, the Relay or the client. OpenCode and Copilot test whether that holds:

| | OpenCode | Copilot |
|---|---|---|
| Identity | No `journal`. Version 2 text parts have no id, so keys use content indexes (`part:<msgId>:<index>`), and a recording must show that a reread reproduces them. There are no recordings | Declared. The todo key differs between the code (`todo`) and the docs (`todo:<uuid>`) |
| Live-only | Interaction receipts live only in process memory; they must be declared and marked | Declared and recorded |
| Concurrency | `shared_clients` with no probe; its terminal already attaches to the server | `single_writer` with a native probe asked once; it needs a declared policy after the resume |
| Limits and failures | `session.retry.scheduled` becomes `native_usage_limited`; a 45 s stream watchdog exists | `errorType` becomes a typed error; nothing handles the CLI process exiting |
| Residency | Released freely today | No release path |
| Branches that still name it | `ctl/provider-discovery.ts:49-61,77`, `ctl/opencode-directory.ts:185`, `ctl/opencode-command.ts`, `ctl/gateway-setup.ts:37` | `ctl/stdio-directory.ts:280`, `lab/src/components/favorites/RenameSessionDialog.tsx:44`, `ctl/gateway-setup.ts:38` |
| Verdict | The boundary generalises if its keys are stable; one recording decides it | It generalises with the declaration and a release path |

### 4.6 Sizes and order

Each step ships on its own:

| Step | Work | Size |
|---|---|---|
| B1 | The SDK gains `behaviour`, the extended `journal`, and the typed error codes and reasons. Each adapter declares its values; no behaviour changes | S |
| B2 | The CLI simulator, driven by the declaration (the first two steps of 3.1) | M |
| B3 | Kit parts 1 and 3 for every journal-capable adapter, run by `test:conformance` | M |
| B4 | The policies, one per release, each deleting its branches: the refusal words and the degraded read-only mode (O48); limits and sign-in; deadlines and the hung resume; divergence by content (O49); release grace (O47) | M each |
| B5 | Kit part 2 (faults through the port), and the nightly native checks with versioned recordings | M |
| B6 | The Workbench reads capabilities from the declaration; process management moves behind one registration hook | M |
| B7 | OpenCode is onboarded through the kit alone, as the acceptance test of the boundary | L |

Status, 2026-11-22: B3 and B5 are built. The kit (`@orchardworks/agent-provider-sdk/conformance`, `pnpm test:providers`) holds Codex, Claude Code and Copilot to their declarations with recordings, a fake of each CLI and the CLI simulator; each CLI has a native check (`pnpm test:native:<cli>`); recordings name their CLI version. Gaps 6, 10 and 11 are closed by them: an unknown native event is a diagnostic for all four adapters, and a window of a `siblings_unordered` provider has a turn's siblings compared as a set. The clauses, the matrix and this machine's native results are in `docs/current/agent-remote/components/provider-conformance-kit.md` and `native-assumption-checks.md`.

## 5. The riskiest gaps, ranked

Ranked by how wrong the assumption is (**F** before **A**), how weak today's handling is, and how much the person loses. Each gap is first reproduced in a simulator of section 3, then closed by its change.

| # | Gap (matrix rows) | Evidence | Handling today | Design change or test | Size |
|---|---|---|---|---|---|
| 1 | Claude Code forks a session that two writers use, and the page and native history then disagree for good (6.3, 4.1) | **F**; M6 failed 50 of 50 | The 2,000 ms divergence rule misses turns that end close together | Decide divergence by content: the transcript holds a record this process did not write, or its newest leaf is not the resident session's last message. Simulator test with writes 0, 1,999 and 2,001 ms apart | M |
| 2 | Codex's single writer takes the page's reads down, and the page offers a take-over that would stop the other process (6.1, 4.2) | **R** on 0.171, undocumented; M6 | `native_session_owned`; journal reads refused; nothing observes | `AgentSessionInUseError` with `reason: 'writer_elsewhere'` and `retryAfterMs`. The journal-served stream stays open. A read-only refresh through `thread/turns/list`, if a native check shows that it takes no writer lock. The page states Codex's reason and offers Retry | M |
| 3 | Usage limits go unrecognised, although every CLI signals them (7.1) | **D** in all four SDKs; dropped by all four adapters | A generic failure with no time to wait | `native_usage_limited` with `resetsAt` in each adapter. The queue holds until the reset and wakes once; the page states the time | M |
| 4 | Hangs go undetected: a hung resume holds the binding; Claude has no watchdog during a turn and Codex has no heartbeat (2.2) | **F**; `ctl/provider-faults.test.ts` | The Relay refuses at 30 s; the binding stays held; pending sends have no bound | A Controller deadline for each declared cost class, which frees the binding; a bound and a timeout on pending sends (Replica C15) | S |
| 5 | An interrupted send stays unknown and holds later messages back, although Claude and Codex can prove its outcome by reread (2.1) | **F**; M2 rounds 8 and 10 | Unknown until the person checks | Pass the input id on every send (Codex `clientUserMessageId`, Claude uuid). After a restart, settle the send by reread as delivered or not delivered, and never replay it | M |
| 6 | CLI updates go unchecked: recordings carry no version, the facts date from Codex 0.169 and Claude Code 2.1.319, and errors are matched by their exact text (1.4, 6.1) | **A** after an update | The static `itemIdentity: 1` | Nightly native checks against the declaration, and versioned recordings (4.4) | M |
| 7 | On the phone, the lifecycle is only simulated, and the device store and pending sends can vanish: Safari's seven-day rule, a tab that iOS ends; there is no push (8.1, 8.2, 8.4, 1.1, 1.2, 2.5) | **F** and **A** | Reconnect and probe on return | The lifecycle simulator on WebKit, with suspension and storage eviction; the iPhone check; `navigator.storage.persist()` for the installed app; a decision on push | M |
| 8 | After a deploy, the Worker and the Relay object can run different code for minutes (3.4) | **F**: documented and seen | Deploy order, `capabilities()`, a manual diagnostics check | Seam tests for an old Relay object and an old `ready` frame, and a post-deploy readiness script | S |
| 9 | A Relay object reset loses the control leases and heartbeats, and this is untested on Workers (5.2) | **D** | Reconnect and acquire again | workerd test with `ctx.abort()` and two pages | S |
| 10 | Four adapters follow three policies for unknown events (3.1, 3.2) | **F** and **A** | Codex rows; silent drops elsewhere | One diagnostics-only rule, checked by the kit | S |
| 11 | The reread order of concurrent tool results is never verified: the `late` exemption hides it (1.3) | **A** | The Relay replaces the journal | Declare `siblings_unordered`; for such adapters the Relay compares a turn's siblings as a set; the kit runs without the exemption | M |
| 12 | The first Codex create failure | No record found: `thread/start` is sent once, with no retry, and a test asserts it (`codex/provider.ts:169-181`, `codex/provider.test.ts:35-45`) | A generic creation error | Keep the native error in the failure taxonomy (B1), then reproduce it in the simulator | S |

## 6. Status after the phone and platform step (2026-11-22)

**Gap 7, the phone (8.1, 8.2, 8.4, 1.1, 1.2, 2.5).**
- **The browser lifecycle simulator** is `@orchardworks/agent-e2e/lifecycle`, used by the flows E13 and E13b and by the component specs `installed-app` and `orchard-primitives`, the same way in WebKit and Chromium. It uses Playwright's own controls: its clock for frozen timers (a resume moves the timers, not the wall clock, which stays the Relay's), the page's WebSocket route for closed and half-open sockets, the page's own lifecycle events for hidden, the back-forward cache and an ended page, and an origin-wide deletion for eviction. Playwright turns the browsers' own back-forward cache off, so the cache is simulated by its events.
- **1.2 was false in both engines (the M1 finding).** WebKit aborts an IndexedDB write that a leaving page starts or has not committed, on close and on navigation alike; Chromium aborts one started at `pagehide` of a closing tab. The device store now starts a record's write in the task that keeps it, and what has not reached the disk when the page hides or leaves goes synchronously to localStorage (`keepWhileLeaving`), for the next open to write to IndexedDB. E13b closes the page 0, 50 and 200 ms after its first page; the old store failed at 0 ms in both engines.
- **2.5 holds.** A message sent into a socket that died unnoticed comes back as Delivery not confirmed (the scripted provider cannot prove it by reread) and is never sent behind the person's back; one the Host had not answered, or one waiting for an offline Host, when the operating system ended the page, comes back with the page and is delivered once.
- **1.1 holds.** A conversation whose stored copy was evicted opens from the journal, with no connection word and no frame that loses its rows.
- **The installed app** asks `navigator.storage.persist()` once per start; a browser tab does not ask.
- **8.2** still needs the five-step check on a real iPhone before a release that changes the client's lifecycle (`docs/current/agent-remote/web.md`, "The page lifecycle of a phone").
- **8.4** is answered by push reminders (I5c, [decision](2026-11-22-push-notifications-decision.md)): the Relay pushes "needs you" and "finished while no page showed it" to the installed app and desktop browsers, with the push service simulator (3.4b) under seam S8 and flow E14b. Delivery through Apple's and Google's services is checked by hand on a real iPhone and in desktop Chrome before the release.
- **New, found by the simulator:** a device clock ahead of the Relay's by more than the lease's life makes every access answer look expired (O59).

**Gap 8, deploy readiness (3.4).**
- The seam test `agent-remote-seams/tests/S3/release-skew.integration.test.ts` plays the decoders of the release in production (main `388205b7`, Relay `15f8edd8`) against this tree, both ways: every frame this tree's client sends is one production's Relay decodes, and every `ready` frame this tree's Relay sends is one production's client decodes.
- **Finding:** both sides decode strictly. The Relay closes the whole channel (1008) on a client frame with a field it does not know, and the client fails the channel on a server frame with one. The release before `388205b7` could not decode `settle`. The rule, written in the S3 contract: a release adds a field or frame to the session wire only when the other side of the previous release already decodes it. The fixture is recorded again from each release once it is in production.
- `scripts/deploy-readiness.mjs` waits, reading the installed CLI's server diagnostics, for a fresh entry naming the deployed `workerVersionId` (`deployment.md`).

**Gap 9, a Relay object reset (5.2, 3.3).** `agent-relay-cloudflare/test/relay-reset.workers.test.ts` resets the Relay object with `ctx.abort()` under two pages that hold control. Every socket closes, the Host reconnects and its heartbeats run again, each page returns read-only and acquires again with a new token, a stale token is refused, one send arrives once, and the terminal-owned session is refused with its owner named. Nothing needed fixing. The owner of a terminal is learned again at the next refusal, as row 5.2 says.
