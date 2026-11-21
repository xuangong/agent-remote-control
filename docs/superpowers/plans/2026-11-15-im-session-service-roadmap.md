# IM-grade session service: roadmap

This roadmap orders the plans that implement [the design](../specs/2026-11-15-im-session-service-design.md). Each plan ships on its own, keeps the repository green, and is written in detail only when the plans before it have landed.

| Order | Plan | Scope | Gate before the next plan |
|---|---|---|---|
| 1 | P1-A Journal core | A new `@orchardworks/agent-remote-journal` package. It holds stable epochs and sequences, the item index (skeleton), corrections, replacement, prepends, eviction and fill, pages, reconcile planning, item digests and a store port. The projector's row merge is exported from `agent-remote-relay` for reuse. | Package tests pass; `agent-remote-relay` tests unchanged and passing. |
| 2 | P0 Baselines | Local measurements on `pnpm local`: open to content, return to ready after hidden time and after a runtime release, switch time, request counts per open and per return. Results go into the plan. | Numbers recorded. Done: [baselines](2026-11-15-p0-baselines.md); the design's targets were revised from them. |
| 3 | P1-B Relay journals | The Host journal service in `agent-remote-hosted` behind the store port. Uplink publishing: claim, publish, acknowledge, index, fill and prepend. Journal-served session reads for smart Hosts behind opt-in flags. A Node SQLite store. A Cloudflare journal object reached by RPC from `primary`. | Real-transport tests against the in-process hosted Relay; conformance unchanged for crude Hosts. |
| 4 | P1-C Controller publisher | Item keys and digests from the Controller's rows; completion and sealing; claim and fencing; reconcile on every open; fills and older history; backfill through read-only history; read-only observation of terminal-driven sessions, provider by provider. | Continuity fixtures pass per provider; `pnpm local` shows no reset after a runtime release. |
| 5 | P1-D Client | The IndexedDB device store; journal-served reading; one-step replacement; local verification. | T1, T2 and T6 measured against the P0 baselines. |
| 6 | P2 Operation queue | The queue (requesters, preconditions, receipts, events, senders) in the Relay and the Controller; moving the outbox, Team and TPM queues; the composer always enabled; business states. | T4 and T5. The owner is told when every Controller must be updated. |
| 7 | P3 Scheduling | Demand leases from clients, aggregation in the Host journal service, Controller residency, safe release for Claude and Copilot, the live budget retired for journal-served sessions. | T3, with resident budgets respected. |
| 8 | P4 Partitioned Relay | Uplinks and sync channels moved to Host and account partitions on Cloudflare; the Node host keeps in-process partitions. | Isolation tests; production-like soak on `pnpm local`. |
| 9 | P5 Automation API | Events API, gateway rules, scheduled tasks and the webhook ingress for external systems. | API tests over real transports. |

Every plan follows the repository rules in `AGENTS.md`:

- The work happens in the worktree `.worktrees/im-session-service`.
- Tests run with per-test and outer deadlines.
- Contract changes update fixtures and compatibility metadata.
- `pnpm compatibility:update` runs after reviewed changes.
- Changes to the website, Relay or Controller are verified on `pnpm local`.

## Revised order after the simplification assessment (2026-11-16)

The owner approved the [simplification assessment](../specs/2026-11-16-journal-simplification.md) on 2026-11-16. The order below replaces rows 4 to 9 of the table above for the work still to do.

| Step | Work | Gate |
|---|---|---|
| S0 | Freeze: no new journal mechanism. Adopt the rules below. | Done when this section lands. |
| S1 | Remove dead and duplicate pieces: the grant levels and capability wait, the head-index read discard, `quotaFenced` (once the `sequence_gap` test covers it), sequential idempotent deletion in place of the worker pool, the head lane and the open slots. Stop forwarding interaction frames on journal-served streams and remove the hold, if clients do not need the dedicated frames. | Suites green. The removed state is recorded. |
| S2 | Server side of "replace when in doubt". On every open the Controller sends its newest window. The Relay compares it with its tail: identical continues, an extension appends, anything else becomes one replacement that the Relay trims to fit its quota. Remove `correct`, `seal`, `expectedRevision`, index paging, the reset open, the quota ladder, per-item skip and renumbering, the replacement-loop guard, rebind re-sending, and live-only adoption by order. | Suites green. The publisher has at most about 20 mutable fields and about 5 recovery outcomes. |
| S3 | P1-C2 for one provider, under the relaxed contract: stable keys, completion marks and live-only marks. Content mismatches between live and reread are counted, not failed. Enable it on `pnpm local` and measure replacements per open, bytes per open and first-open misses. | Measurements recorded. |
| S4 | P1-D with the client side of S2. Item keys go on entries behind an opt-in flag, and rows are keyed by item key. The client absorbs a replacement by key; a replacement carries the window and prepends land below it, so the client keeps no safety rule for old updates beyond its own fold. The device store and the label and T1 work stay as planned. Measure T1, T2 and T6 at 4x CPU and 100 ms round trip against P0. | T1, T2 and T6 measured. |
| S5 | Relay-owned session control, as the first slice of P2. Remove the pending revision, held acquires, the offline-Host amendment, `hostReturned` and the `restoring` override. | Every Controller must be updated, with no window in which both paths run: an old Controller registers and updates but cannot open sessions. The Relay is deployed first. [Plan](2026-11-17-s5-relay-owned-session-control.md). |
| S6 | The remaining providers under the relaxed contract (Claude Code and Codex first, as S6a: [plan](2026-11-17-s6a-claude-codex-journals.md); OpenCode and the reduced P1-C3 follow as S6b). A reduced P1-C3: the read-only history capability and behind-marking first; backfill and observation wait until S3's measurements show first-open misses. Then the rest of P2, P3, P4 and P5. | As in the table above. |

**Owner decisions (2026-11-16):**
- T6 is met by "replace when in doubt" plus a client that keeps unchanged rows across a new epoch. The epoch no longer has to stay the same.
- An interrupted partial item that native history never recorded may disappear at the next replacement, as it does in crude mode today. `seal` is removed.
- Relay-owned session control comes before P1-C3 and the remaining providers.

**Rules for all further work:**
1. **State accounting.** Every plan decision and every fix states the change in state: fields +N/-M and recovery paths +N/-M. A change that only adds says why in one sentence.
2. **Invariant before guard.** For each failure a review names, first look for an invariant that makes it impossible, or for the universal fallback ("reopen and replace with the newest window that fits"). Add a guard only for a failure shown to be reachable by a log, a recorded fixture or a real-transport test.
3. **Complexity budgets.** `SessionPublication` has at most 20 mutable fields and 6 recovery outcomes. A change over budget deletes something else or goes to the owner.
4. **Measure before scale.** A bound, pool, lane, cache or ladder cites a measurement. Otherwise it is one hard cap with a refusal.
5. **Protocol surface.** A new message, entry type, refusal reason or flag replaces one, or the plan says why it cannot.
6. **Short plans.** Plans state interfaces, deletions and acceptance tests in under 1,000 lines. They do not carry the full code. A spike on real data comes before a plan where data decides the design.
7. **A deletion task in every plan.** It lists what earlier work made unnecessary and removes it.
8. **Reviews ask two questions:** what can go wrong, and what can this make unnecessary.

## Progress

| Plan | State | Evidence |
|---|---|---|
| P1-A Journal core | Done | `@orchardworks/agent-remote-journal`, 141 tests |
| P0 Baselines | Done | [baselines](2026-11-15-p0-baselines.md); targets revised in the design |
| P1-B1 Relay journal service | Done | uplink journal messages, `host-journals.ts`, `journal-uplink.ts` |
| P1-B2 Journal-served sessions | Done | hosted suite 790 tests; crude-mode guard suites unchanged; local instance verified (crude path, model turn) |
| P1-B3a Journal storage (Node) | Done | SQLite store (`node:sqlite`, benchmarked), bounded service with head index, quota fencing, incremental retention window, atomic fill and page, pulled index pages; smart-reading switch per Host and provider (off by default); durable deletion on revoke; `AGENT_REMOTE_JOURNALS=1` / `ARC_LOCAL_JOURNALS=1`. Suites: hosted 918, lab 2801, cloudflare 219, conformance 31, relay 396, controller 1469 (one pre-existing local-test failure, also on main). Local instance verified with journals on (store file 0600, switch round-trip across a restart, model turn on the crude path). |
| P1-B3b Cloudflare journal partition | Done | A `JournalPartition` Durable Object per Host in a Worker of its own, reached from `primary` by RPC; contiguous sequences in the core (`sequence_gap`); version negotiation with the partitions Worker; default Relay configs unchanged, with journals enabled by an operator procedure (partitions Worker first). Hosted 947, Cloudflare 238, conformance 31; six wrangler dry runs; cross-Worker RPC driven under `wrangler dev`. Not deployed. |
| P1-C1 Controller publisher | Done | SDK item identity; protocol grant 2 (`outcome`, `rebind`, optional digests, `attentionItemKey`, `journal_unserve`, `journal_request_refused`, reset open); core amendments and type-checked appends to evicted items; Relay interaction hold, grant per connection with a partition capability check; agent manager tap; stable HMAC resource ids with a persisted index; items, reconcile (live-only order rule, empty and forced replacements, rebinds) and the publisher (per-session state machine, shared budget with head headroom, renumbering, quota/incomplete/reset recovery, prompt requests); host wiring and diagnostic delivery 4; a continuity fixture. Suites: sdk 97, protocol 437, journal 204, journal-sqlite 30, relay 441, hosted 989, Controller 1643, providers 225/485/150/190, cloudflare 240, conformance 31, lab 2801, web 892. Local instance verified (crude path; no provider is journal-capable yet). |
| P1-C2 / S3 First journal provider | Done with measured verdicts | [Plan](2026-11-16-s3-first-journal-provider.md): Copilot first, relaxed contract, enabled on `pnpm local`, measured (section 7). One session of about 24 items read journal-served in the page across release, restart and 5 cancelled turns: 0 replacements, 0 holes, 0 `open_item`, 0 fills, 0 quota refusals; each Controller restart appended 12,422 bytes. I2, M3 and drop-oldest not triggered; M6 not triggered on the evidence, but the runner has no reliable journal-versus-Controller signal per open. Supersedes the P1-C2 plan; its research stays. |
| Simplification S1 | Done | [Plan](2026-11-16-s1-s2-journal-simplification.md), Tasks 1 to 6: one journal version checked at the handshake, sequential idempotent deletion, no head lane, no interaction hold. Local instance verified with the S2 build (see the Task 12 record): crude path, model turn, smart-reading switch on and off, question frames. |
| Simplification S2 | Done | Plan Tasks 7 to 11: the core's `sync` (unchanged, appended or replaced, decided in one place), the `window` entry and the older-history anchor `beforeItemKey`, the Controller sending its window and reopening on any doubt (publisher mutable fields 33 to 19, recovery paths 14 to 4), and the deletion of `correct`, `seal`, `replace`, `expectedRevision`, index paging, the reset open, per-item refusals and `retiredEpochs`; a window fits the room whole or is refused. Suites at Gate S2: protocol 418, journal 186, journal-sqlite 30, relay 440, hosted 967, Controller 1607, web 893, cloudflare 239, conformance 31, lab 2801. `packages` diff against 33b1c80c: 2722 insertions, 4387 deletions; publisher mutable fields 19. Local instance verified with journals on (crude path, model turn, switch round-trip, question frames; no `journal_` diagnostics); journal-served paths not exercised, no provider is journal-capable until S3. |
| P1-C3 Current journals | Outline | `2026-11-15-p1c3-current-journals.md` |
| S4a Client absorbs replacements | Done with measured verdicts | [Plan](2026-11-16-s4-client-absorbs-replacements.md), section 11: item keys behind an opt-in flag that the Relay strips for Controllers, live-only items out of the positional comparison of `sync`, one row per key, absorption of a replacement by key, `failed` compaction, one `todo` item. Measured at 1x, 4x CPU, 100 ms and both against the control: a forced replacement re-keyed 1,101 of 1,101 rows in the control and 0 of 1,800 in S4a (draft and anchor row kept); a Controller restart re-keyed none in either (the journal keeps its epoch) and sent 39 `unchanged` windows against 11 `appended`; one `todo` item per session; the crude path never shows a row-less state. Departures: the control ran on this checkout's instance, the forced replacement is a restart during a tool, `retainedDisplay` stays until S4b. Rule 5 for S6: the flag, the old row key, `itemIdentity()`, `mergeAuthoritative`'s range-overlap rule, `coalesceEntry`'s type-based matching, `retiredEpochs` and the `stale_epoch` status go when the Controller's projector gives items keys. |
| S4b Device store, T1 and return budget | Done, measured (T1 and the return budget met; T2 p50 at 100 ms missed in both arms) | [Plan](2026-11-16-s4b-device-store.md), [results](2026-11-16-s4b-results.md): IndexedDB device store scoped by relay and principal, rows shown only while the access lease is confirmed, the localStorage display cache deleted (its keys are removed once at start; that removal is deleted one release later), labels that stay quiet while rows are held, list loaders that no longer refetch on visibility, and T1, T2 and the return budget measured at 1x, 4x CPU, 100 ms and both against the control. S4a and S4b supersede `2026-11-15-p1d-client-device-store.md` and `2026-11-15-p1d2-client-measurement.md`. |
| S5 Relay-owned session control | Implemented on `design/im-session-service`; not deployed | [Plan](2026-11-17-s5-relay-owned-session-control.md): the Relay owns the control lease, a negotiated `control` capability (no new message), session protocol stays 1.8.0; the pending revision, held acquires, the offline-Host amendment, `hostReturned` and the `restoring` override are deleted, and so are the Controller's lease on uplink streams and the registry fallback there. No transition window: the Relay deploys first, every Controller must be updated, and an old Controller can only register and be updated. |
| S6a Claude Code and Codex journals | Done — baseline `baseline/im-session-2026-11-18` | Both journal-served on `pnpm local` (Claude 37/37, Codex 35/35 opens; 0 holes with the wheel-scroll runner, `.tmp/s6a-codex-mix4.json`); terminal-driven turns appear without a send and the model sees them (Claude divergence release; Codex no fork); S5 Relay-owned control. Not deployed: the owner deploys after the test restructuring. |


## Notes carried to later plans

- **P1-D: measure under latency, against the same runner.**
  - P0's numbers are a loopback floor. P1-D re-runs `packages/agent-remote-lab/performance/local-baselines.mjs` at 4x CPU slowdown and with an emulated 100 ms round trip between the browser and the Relay. Both builds run under the same conditions: today's path is the control group.
  - The runner gains that latency option first, as a delaying proxy in front of the instance, so that WebSocket frames are delayed too, not only HTTP.
  - The counted budgets come from P0:
    - at most 2 HTTP requests on a return while sockets are alive (today 13 to 14);
    - no "Opening session" frame on an open or a return;
    - no re-keyed rows after a Controller restart.
- **P3: preemption skips streams that hold no Controller stream.** Stream preemption (`packages/agent-remote-hosted/src/stream-preemption.ts`) can pick a journal-served view as its victim, although pausing it frees no slot. S5 met the first two cases (a journal-served view opens its Controller stream at its first message and never waits for the Host or holds one while refused); this still applies to journal-served views that only read, and to activity observers. An activity observer that opens also makes room (`gateway.ts` ~1040) although it never needs a slot. Preemption should count and pause only streams that hold a Controller stream; P3's retirement of the live budget for journal-served sessions supersedes it.
- **P1-C: evicted bodies (from P1-B3a).** A publication must not rely on bodies the Relay evicted: bodies outside the latest 50 turns are filled on demand. `journal_quota_exceeded` and `journal_live_only_dropped` reach only Controllers that advertise diagnostic version 4.
- **P1-C: an incomplete journal takes a window before any head.** After a refused live `append`, or a window that did not fit, a journal is `incomplete` and out of serving until the next open's window replaces it. A head sent before that window is refused on its own (reason `incomplete`). The Controller sends the window first, then its head.
- **P1-C: contiguous sequences and refusals (from P1-B3b).** The journal core accepts a publication only when its sequence is exactly one more than the watermark. A refused entry never consumes its sequence. Every later entry of that generation is therefore refused as `sequence_gap`, or `incomplete` if it sends the refused sequence again, until the Controller acts, and this holds across a partition reset. A refusal names no item; the Controller opens again with a backoff and sends its window again. A refused older-history prepend is the one exception: it leaves the journal whole and ends older history for the session.
- **P3: use-based retention (from P1-B3a).** Today one rule applies at publish time: the latest 50 turns stay resident. With demand leases, P3 adds:
  - a larger resident window for sessions in use;
  - a 5-turn window for sessions nobody has used for a while;
  - a retention sweep for sessions that receive no publications;
  - retries of pending journal deletions on a timer (the loop of S1 Task 4);
  - Host-level reclamation when a Host's journals fill its budget: evict the bodies of other sessions, least recently used first, so a full Host recovers and a refused window can fit (today a refused window evicts only its own journal's bodies);
  - eviction of prepended (older-history) bodies, which the incremental window never evicts because they were never inside it. Only a cap-driven shrink or a fill's trim removes them today.
  - a sweep of orphaned journals: list the store's Host prefixes and delete those of Hosts the Relay no longer knows. Pending deletions that overflowed their bound (1024, oldest dropped with a diagnostic) or failed for good are cleaned up this way.

  P0 measurements set the numbers.
- **P1-B3: bounds and deletion.**
  - Bound the Host journal cache.
  - Delete journals when a Host or a binding is revoked.
  - Decide journal-served gating from an in-memory index of sessions that have a head, so opening a crude stream never waits on the store or on the Host's journal queue.
- **P1-C: chunk large rereads.** A single `window` or `prepend` message is capped at 8 MiB, so the Controller sends the newest window that fits one message and chunks older history, one prepend to a message.
- **P1-C: advertise diagnostic delivery version 4.** Journal diagnostics (`journal_message_unencodable`, `journal_store_failed`, `journal_fanout_failed`) reach only Controllers that advertise version 4. Every Controller advertises 3 today (`packages/agent-host/src/host.ts`), and it already decodes these events through the shared module.
- **P1-C: amendments and runtime events for journal-served clients.**
  - The journal has no amendment path yet, so a resource-binding replacement (`timeline_resource_binding_replaced`) never reaches a journal-served client; neither do non-timeline `agent_stream` events.
  - The publisher and the journal core add both.
  - The head's `attention.cursor` must be stated in the journal's epoch and sequence, not the Controller's.
- **P1-C: native owners of journal-served sessions.** When the native CLI owns a session, the Controller stream cannot attach (`native_session_owned`). The Relay then answers the client's acquire with the pending state and the native owner, so reads continue and the client shows who holds the session. Taking control from there (`resumeNative`, then `take_over`) needs the Relay to open the Controller stream again after the native resume. P1-C wires this up together with read-only observation.
- **P1-C: validate rows before batching.** The wire limits for a row are stricter than the journal's own types (`turnId` and `providerId` at most 512 characters, at most 256 `resources`, `sourceKey` at most 4096 characters, an integer `occurredAt` that is not negative). The Controller validates each row before it adds the row to a publication, because one invalid row makes the whole message unencodable.


## Release 2026-11-19

Shipped from main `e144b5a6`: the IM session service through S6a (journals, Relay-owned session control, the client device store and absorption, Claude Code, Codex and Copilot journals) together with the test and architecture restructuring (see section 11 of `docs/superpowers/specs/2026-11-18-target-architecture-and-tests.md`).

- Worker `1701a6e0` deployed with the default `wrangler.jsonc` (journals off in production); previous Worker `8162e064`. Rolling the Relay back below this release stops sessions on updated Controllers.
- Controller 0.3.0 released on GitHub as latest (`controller-v0.3.0`, sha256 `b8c6f4c9…`). Every Controller must update: older ones register and can be updated from the website but cannot open sessions.
- Next iteration: enabling journals in production (deploy the partitions Worker, then the journals-enabled configuration) is proposed to the owner first.

## Next: Orchard, the IM experience (2026-11-20)

The owner judged the released page a diagnostic tool rather than an IM product and approved [the Orchard design](../specs/2026-11-20-orchard-im-experience-design.md): assistants as the visual centre, layered disclosure (L0 glance, L1 conversation, L2 detail, L3 diagnosis), three process modes, a composer never blocked by connection state, and the product name Orchard. The I steps come before the rest of P2 to P5; each ships on its own and is reviewed by the owner on `pnpm local`.

| Step | Work | Gate |
|---|---|---|
| I1 Quiet open | T4 and T5 on the current page: no per-session connection label, composer enabled during open and sync with sends queued until ready, control check alongside the timeline subscription. | No connection label in any frame and a typed message shows as sending within 100 ms, at 4x CPU and 100 ms round trip. |
| J Production journals | Deploy the partitions Worker, then the journals-enabled configuration; smart reading per provider. | Owner approves the deploy. T2 measured in production-like conditions on `pnpm local`. |
| I2 Design system | Tokens, light and dark themes, primitives, avatar generation, the Orchard logo. | Component pages for every primitive in both themes; WCAG AA contrast. |
| I3 Assistant view and workbench | Bot mode and Window mode designed and built together (tiles are assistant conversations from the same primitives); Bot mode in the three-panel layout: assistant sidebar, bubbles, work-summary line with L2, inline approvals, session-change line, process modes, details panel (agent, machine, sessions, settings). | Every item visible today is reachable in L2 or L3; one e2e flow for the main path. |
| I4 Brand and polish | The Orchard brand across the site (access page, icons, installed web app) and the remaining screens. The phone layout ships with I2 and I3, not here. | Component and e2e suites at desktop and phone widths. |

After I4: the rest of P2 (operation queue and business states), S6b, P3, P4 and P5 as above.

## Release 2026-11-20: journals on in production (step J)

- Built from main `da280c5b`, the same code as Worker `1701a6e0`.
- Partitions Worker `agent-remote-control-journals` version `99170f75`, deployed first.
- Relay deployed with `wrangler.journals-enabled.jsonc` as version `974938b1`. The rollback target is `1701a6e0`, which turns journals off.
- `/health` returned 200, and tailing the Relay showed no configuration error.
- For a few minutes after the deploy, `PUT …/smart-reading` answered `journals_unavailable`. The running Durable Object was still on the previous version: Cloudflare propagates Worker and Durable Object code independently, as `docs/current/agent-remote/deployment.md` notes.
- After that, the owner turned smart reading on for `claude`, `codex` and `copilot` on all 4 Hosts.

## Release 2026-11-20: I1 quiet open and Controller 0.3.1

Shipped from main `8ac70385`.
- **Relay.** Worker `3d63810e` deployed with `wrangler.journals-enabled.jsonc`. The rollback target is `974938b1`. The partitions Worker is unchanged at `99170f75`. `/health` returns 200.
- **Controller.** 0.3.1 is the latest GitHub release (`controller-v0.3.1`, sha256 `cf94e142…`). It fixes the Claude parallel-tool reread order. The I1 client changes ship with the Relay's web bundle.
- **I1 measured against the control.** At 4x CPU and 100 ms:
  - opens showing a connection word: 10 of 10 → 0;
  - key to "Sending": 106/181 → 49/55 ms (p50/p95);
  - focus and text kept: 0 → 10.
- **Seen on `pnpm local`.** The access page still shows "Checking access" for about 60 ms before the workspace mounts. The I4 brand pass rewords it.
- **Open phone defect.** On the phone, the floating launchers (activity, TPM, Window, Team) cover the conversation. This is O30 again, with more launchers, and it is fixed next.

## Release 2026-11-20: I2 design system and phone launchers

Shipped from main `ac075f9d`.
- **Relay and website:** Worker `14c7416e`, deployed with `wrangler.journals-enabled.jsonc`. The rollback target is `3d63810e`. No Controller change.
- **What shipped:**
  - Orchard tokens with light, dark and system themes;
  - the primitives;
  - generated avatars, with four shapes and a gaze stored on the bot picture (a new Relay field);
  - the Orchard mark, wordmark, icons and web-app manifest. The production page title is now "Orchard".
- **Phone fixes:**
  - launchers and the session toolbar take reserved rows on screens up to 1180 px;
  - the composer reserves room for its hide tab;
  - a generic component test fails when any fixed or absolute control overlaps conversation text at 390x844.
- **Checks:**
  - full `pnpm verify` passed;
  - components passed (509); one known load flake passed on a 3-of-3 rerun alone;
  - WCAG AA contrast held in both themes;
  - touch targets are at least 44 px on the phone.

## Release 2026-11-20: I3a, the conversation

Shipped from main `9574eddd`. Worker `739de574`, with `wrangler.journals-enabled.jsonc`; the rollback target is `14c7416e`. The Durable Object reported `739de574` in fresh diagnostics within about a minute.

**What changed:**
- turns render as bubbles, with one work line that expands in place;
- inline approvals;
- a live status line and a session-change line;
- three process modes, stored per assistant (`WindowBotDetails.process`, a new Relay field) and per device;
- English and Chinese, following the browser;
- avatars of equal visual weight, with a clearer gaze.

**Checks:**
- full `pnpm verify`: 11,974 tests;
- E10 on desktop and phone, Chromium and WebKit;
- every element shown before is reachable: 35 inventory rows, each with a test.

**Send latency** at 4x CPU and 100 ms, against the control:
- first send p50: 130 → 116 ms;
- second send: 50/63 → 48/61 ms;
- typed during open: 69/74 → 43/65 ms.

**Known issues, handed to I3b:**
- a plain session's prompt title used as the assistant name;
- floating launchers over the third tile of a full-width Window on desktop.

`session-recovery` (WebKit) fails intermittently on the base commit too, so this release did not cause it.

## Release 2026-11-20: I3b and I3c, the layout

Shipped from main `b270a227`.
- **Worker** `bfd082d8`, deployed with `wrangler.journals-enabled.jsonc`. Rollback target `739de574`. The Durable Object reported `bfd082d8` about 5 minutes after the deploy.
- **Changes:**
  - Bot mode in three floating panels.
  - Assistants have their own name, a new `name` field on the bot details. A soft default is generated and is never the prompt. The name is renamed on the details card.
  - The details panel has one visible action and a "…" menu, plus where it works, process modes, notifications, sessions as a compact list and the model.
  - Window mode uses the same visual language: floating panels, tiles with avatar, name, status and a "…" menu.
  - Moving between modes keeps your place.
  - Phone: the assistant list is home, the conversation is full screen with Back, details open as a sheet, and a window is a stack of tiles.
  - On a coarse pointer, Return makes a new line.
  - No floating control covers conversation text, at any width.
- **Measured** at 4x CPU and 100 ms against the I3a release: mount to content 135 → 112 ms. Sends within a few milliseconds of the I3a release.
- **Full `pnpm verify`** after the merge failed only in `agent-controller` `opencode-server.test.ts`, a process-tier test of a real OpenCode server that I3 does not touch. It passed 3 of 3 alone, so it was load, not a regression. This should have been confirmed before `main` was pushed: the push ran in the same command chain as the verification.
- **Left for I4:**
  - the composer is still the old style;
  - production CSS is +59 lines net, from legacy rules still used by compact, TPM and Ask views;
  - a few expanded-detail strings are English only.

## Release 2026-11-21: I4, brand and polish (the Orchard push complete)

Shipped from main `896943fb`. Worker `61702401` with `wrangler.journals-enabled.jsonc`; the rollback target is `bfd082d8`. The Durable Object reported `61702401` within about a minute.

**What shipped:**
- The composer is the mockup's capsule, with a "+" menu and a round send button.
- An IM-style navigation:
  - desktop: a rail with Chats, Assistants, Windows, Search and Settings, plus the avatar and its link dot;
  - phone: a tab bar with Chats, Assistants, Windows and Me.
- One Settings page with the groups General, Assistants, Computers (including smart reading per provider), Privacy and data, Advanced, and Account and about. The old settings panel is gone.
- Orchard access pages, in business words.
- 2,981 catalogue keys in English and Chinese, following the browser or the user's choice. No stray English remains on the main screens in Chinese.
- The installed web app opens on the theme's ground.
- CSS is net 0 against the I2 release.

**Checks:**
- `pnpm verify` passed.
- Components: 916 passed. Three failed in the full run: `pairing-keys` (a helper defect, fixed) and `assistant-phone` WebKit (load). All passed rerun on the final tree, 25 of 25.
- preview-browser 73.
- Flows E1 to E11 (41), plus WebKit E9 to E11.

**Speed** at 4x CPU and 100 ms against `b270a227`:
- open to content p95: 401 → 362 ms;
- first send: 82/86 ms;
- typed during open: 45/53 ms.

**With I4, steps I1 to I4 and J are all in production.**

## Release 2026-11-21: O44, sends during a slow open

- **Shipped:** main `55c09b36`, Worker `8257f97b`, deployed with `wrangler.journals-enabled.jsonc`. Rollback target: `61702401`. The Durable Object reported `8257f97b` within a minute.
- **The fix:** a message typed while a session opens over a slow network (a 300 ms round trip) is delivered once the session is ready. It is no longer held as "could not be opened". `smoke:quick` found the defect after its harness was fixed to read the session it opened.
- **Checks:**
  - `pnpm verify` exit 0 (12,329 tests);
  - e2e flows 43/43, including E9 with a 2 s Relay delay;
  - `smoke:quick` seed 68421: M1, M2, M4 and M7, with every invariant exercised.
- **Process change:** `smoke:quick` now runs before every release that changes the client or the Relay. A component test checks the smoke harness's selectors in each step's gate.

## Release 2026-11-21: provider boundary step 1, O47 and O48, Controller 0.3.2

Shipped from main `dc1d9bf8`.
- **Partitions Worker `0a5212c3`.** Deployed first.
- **Relay `59fece62`.** Deployed with `wrangler.journals-enabled.jsonc`. The rollback target is `8257f97b`. The Durable Object reported `59fece62` within about a minute.
- **Controller 0.3.2** (`controller-v0.3.2`, sha256 `f65142b9…`). Every Controller must update. An old Controller keeps working, but without visibility-driven residency.

**Shipped:**
- **B1.** A behaviour declaration and typed errors in the Provider SDK. Every adapter declares its behaviour.
- **B2.** A CLI simulator driven by the declaration. O49 and gap 4 remain expected failures in it.
- **O47.** Residency follows visibility. The Relay tells the Controller which sessions a page shows (`journal_shown`), and those sessions stay resident and live. When no page shows a session, it is released after the adapter's declared grace. For Codex the grace is 10 s, followed by Codex's own 70 s unload.
- **O48.** `writer_elsewhere` is a generic policy. The page stays journal-readable and shows the CLI's reason and Retry, and no take-over is offered.

**Checks:**
- `pnpm verify` exit 0: 12,850 tests, 2 expected failures.
- `smoke:quick` seed 29348 (M1, M2, M4, M7): all passed.

## Release 2026-11-22: O49 and gaps 3 to 5, Controller 0.3.3

Shipped from main `388205b7`.
- **Partitions Worker:** `e63babd4`.
- **Relay:** `15f8edd8`, rollback target `59fece62`. The Durable Object reported `15f8edd8` within about a minute.
- **Controller:** 0.3.3 (`controller-v0.3.3`, sha256 `6b9a0810…`). Every Controller must update. After the update, each Claude session's journal is replaced once, at its first open.

**Fixes:**
- **O49.** Divergence is decided by the transcript's content for `fork_on_divergence` adapters.
- **Gap 4.** Declared deadlines: a hung resume frees its binding with `native_unresponsive`; a silent turn is given up after 15 minutes when the adapter declares no heartbeat; pending sends are bounded at 20 and time out after 60 s.
- **Gap 3.** Usage limits:
  - Every adapter maps its CLI's documented signal to `usageLimit { resetsAt }` and `native_usage_limited`.
  - Sends wait for the reset and go once.
  - The time is stated in both locales.
- **Gap 5.** Every send carries its input id. After a restart, an unknown send is settled from native history as delivered or not delivered. It is never replayed.
- **O57.** Closed: an e2e scripted-provider key collision.

No expected failures remain in the simulator suite.

**Gates:**
- `pnpm verify` exit 0 (12,941 tests);
- flows 55 of 55;
- `smoke:quick` M1, M2, M4 and M7 passed.
