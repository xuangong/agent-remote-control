# IM-grade session service: roadmap

This roadmap orders the plans that implement [the design](../specs/2026-11-15-im-session-service-design.md). Each plan ships on its own, keeps the repository green, and is written in detail only when the plans before it have landed.

| Order | Plan | Scope | Gate before the next plan |
|---|---|---|---|
| 1 | P1-A Journal core | A new `@orchardworks/agent-remote-journal` package. It holds stable epochs and sequences, the item index (skeleton), corrections, replacement, prepends, eviction and fill, pages, reconcile planning, item digests and a store port. The projector's row merge is exported from `agent-remote-relay` for reuse. | Package tests pass; `agent-remote-relay` tests unchanged and passing. |
| 2 | P0 Baselines | Local measurements on `pnpm local`: open to content, return to ready after hidden time and after a runtime release, switch time, request counts per open and per return. Results go into the plan. | Numbers recorded. |
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

## Notes carried to later plans

- **P1-B2 and P1-D: no holes in a client's window.** The client loads older history from its first entry's `seqStart` (`packages/agent-remote-web/src/client/remote-session-client.ts:372`). A correction, or any update to an item older than what a subscriber holds, must not leave the client holding an isolated old entry. If it did, the next older page would skip everything in between. Two ways to avoid it:
  - the Relay sends such updates only to subscribers whose window covers the item;
  - the client folds them in without moving its older boundary.
- **P1-B3: bounds and deletion.**
  - Bound the Host journal cache.
  - Delete journals when a Host or a binding is revoked.
  - Page the index in `journal_opened` once it no longer fits in one 8 MiB uplink message. Long item keys reach that point well before 30,000 items.
- **P1-C: chunk large rereads.** A single `replace` or `prepend` message is capped at 8 MiB, so the Controller chunks large rereads.
- **P1-C: validate rows before batching.** The wire limits for a row are stricter than the journal's own types (`turnId` and `providerId` at most 512 characters, at most 256 `resources`, `sourceKey` at most 4096 characters, an integer `occurredAt` that is not negative). The Controller validates each row before it adds the row to a publication, because one invalid row makes the whole message unencodable.
