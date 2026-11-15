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

## Progress

| Plan | State | Evidence |
|---|---|---|
| P1-A Journal core | Done | `@orchardworks/agent-remote-journal`, 141 tests |
| P0 Baselines | Done | [baselines](2026-11-15-p0-baselines.md); targets revised in the design |
| P1-B1 Relay journal service | Done | uplink journal messages, `host-journals.ts`, `journal-uplink.ts` |
| P1-B2 Journal-served sessions | Done | hosted suite 790 tests; crude-mode guard suites unchanged; local instance verified (crude path, model turn) |
| P1-B3a Journal storage (Node) | Done | SQLite store (`node:sqlite`, benchmarked), bounded service with head index, quota fencing, incremental retention window, atomic fill and page, pulled index pages; smart-reading switch per Host and provider (off by default); durable deletion on revoke; `AGENT_REMOTE_JOURNALS=1` / `ARC_LOCAL_JOURNALS=1`. Suites: hosted 918, lab 2801, cloudflare 219, conformance 31, relay 396, controller 1469 (one pre-existing local-test failure, also on main). Local instance verified with journals on (store file 0600, switch round-trip across a restart, model turn on the crude path). |
| P1-B3b Cloudflare journal partition | Planned and reviewed | `2026-11-15-p1b3b-cloudflare-journal-partition.md` |
| P1-C Controller publisher | Planned and reviewed | `2026-11-15-p1c1-controller-publisher.md` (full), `-p1c2-` and `-p1c3-` (outlines) |
| P1-D Client device store | Planned and reviewed | `2026-11-15-p1d-client-device-store.md`, `2026-11-15-p1d2-client-measurement.md` |

## Notes carried to later plans

- **P1-D: measure under latency, against the same runner.**
  - P0's numbers are a loopback floor. P1-D re-runs `packages/agent-remote-lab/performance/local-baselines.mjs` at 4x CPU slowdown and with an emulated 100 ms round trip between the browser and the Relay. Both builds run under the same conditions: today's path is the control group.
  - The runner gains that latency option first, as a delaying proxy in front of the instance, so that WebSocket frames are delayed too, not only HTTP.
  - The counted budgets come from P0:
    - at most 2 HTTP requests on a return while sockets are alive (today 13 to 14);
    - no "Opening session" frame on an open or a return;
    - no re-keyed rows after a Controller restart.
- **P3: preemption skips streams that hold no Controller stream.** Stream preemption (`packages/agent-remote-hosted/src/stream-preemption.ts`) can pick a journal-served view as its victim, although pausing it frees no slot. This applies to views waiting for an offline Host, views refused for a reason retrying cannot change, and activity observers. An activity observer that opens also makes room (`gateway.ts` ~1040) although it never needs a slot. Preemption should count and pause only streams that hold a Controller stream; P3's retirement of the live budget for journal-served sessions supersedes it.
- **P1-C: paged index, quota and evicted bodies (from P1-B3a).** The publisher reads `journal_opened.indexAfter` and pulls pages with `journal_index_request` until a page has no `indexAfter`; only then is the journal open for it. On a `quota_exceeded` refusal, the Relay has already taken the session out of serving. The publisher reopens the journal and replaces it with a window that fits: fewer turns, still carrying its live-only items. If that also fails, it stops publishing that session. `journal_quota_exceeded` and `journal_live_only_dropped` reach only Controllers that advertise diagnostic version 4. A publication must not rely on bodies the Relay evicted: bodies outside the latest 50 turns are filled on demand.
- **P1-C: an incomplete journal takes a replacement before any head.** After a quota refusal, a journal is `incomplete` until the publisher reopens it and applies a replacement that fits. A head sent before that replacement is refused on its own (reason `incomplete`). The publisher sends the replacement first, then its head.
- **P1-C: a journal whose index is too large.** At 100,000 items, `open` refuses with `index_too_large` and takes the session out of serving, so the publisher can never open it to replace it. P1-C adds a way out: an open that asks for no index (`journal_open` with a reset option), whose first publication must be a `replace` that fits. Serving then resumes as it does after a quota refusal.
- **P3: use-based retention (from P1-B3a).** Today one rule applies at publish time: the latest 50 turns stay resident. With demand leases, P3 adds:
  - a larger resident window for sessions in use;
  - a 5-turn window for sessions nobody has used for a while;
  - a retention sweep for sessions that receive no publications;
  - retries of pending journal deletions on a timer;
  - eviction of prepended (older-history) bodies, which the incremental window never evicts because they were never inside it. Only a cap-driven shrink or a fill's trim removes them today.
  - a sweep of orphaned journals: list the store's Host prefixes and delete those of Hosts the Relay no longer knows. Pending deletions that overflowed their bound (1024, oldest dropped with a diagnostic) or failed for good are cleaned up this way.

  P0 measurements set the numbers.
- **P1-B2 and P1-D: no holes in a client's window.** The client loads older history from its first entry's `seqStart` (`packages/agent-remote-web/src/client/remote-session-client.ts:372`). A correction, or any update to an item older than what a subscriber holds, must not leave the client holding an isolated old entry. If it did, the next older page would skip everything in between. Two ways to avoid it:
  - the Relay sends such updates only to subscribers whose window covers the item;
  - the client folds them in without moving its older boundary.
- **P1-B3: bounds and deletion.**
  - Bound the Host journal cache.
  - Delete journals when a Host or a binding is revoked.
  - Decide journal-served gating from an in-memory index of sessions that have a head, so opening a crude stream never waits on the store or on the Host's journal queue.
  - Page the index in `journal_opened` once it no longer fits in one 8 MiB uplink message. Long item keys reach that point well before 30,000 items.
- **P1-C: chunk large rereads.** A single `replace` or `prepend` message is capped at 8 MiB, so the Controller chunks large rereads.
- **P1-C: advertise diagnostic delivery version 4.** Journal diagnostics (`journal_message_unencodable`, `journal_store_failed`, `journal_fanout_failed`) reach only Controllers that advertise version 4. Every Controller advertises 3 today (`packages/agent-host/src/host.ts`), and it already decodes these events through the shared module.
- **P1-C: amendments and runtime events for journal-served clients.**
  - The journal has no amendment path yet, so a resource-binding replacement (`timeline_resource_binding_replaced`) never reaches a journal-served client; neither do non-timeline `agent_stream` events.
  - The publisher and the journal core add both.
  - The head's `attention.cursor` must be stated in the journal's epoch and sequence, not the Controller's.
- **P1-C: forwarded frames and older heads.** A journal-served stream forwards the Controller's interaction frames (`interaction_requested` and the like) while heads come from the journal. A head published before the question can therefore arrive after it, and the client's reducer (`packages/agent-remote-web/src/replica/reducer.ts:56-77`) then drops the question. The publisher must publish the head that carries a pending interaction before, or together with, the frame that announces it. Otherwise the Relay holds such frames until the journal's head includes them.
- **P1-C: native owners of journal-served sessions.** When the native CLI owns a session, the Controller stream cannot attach (`native_session_owned`). The Relay then answers the client's acquire with the pending state and the native owner, so reads continue and the client shows who holds the session. Taking control from there (`resumeNative`, then `take_over`) needs the Relay to open the Controller stream again after the native resume. P1-C wires this up together with read-only observation.
- **P1-C: validate rows before batching.** The wire limits for a row are stricter than the journal's own types (`turnId` and `providerId` at most 512 characters, at most 256 `resources`, `sourceKey` at most 4096 characters, an integer `occurredAt` that is not negative). The Controller validates each row before it adds the row to a publication, because one invalid row makes the whole message unencodable.
