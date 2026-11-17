# M3: where the Worker tests' rules went

Companion of `2026-11-18-target-architecture-and-tests.md`, step M3. Every Worker test that re-drove a Relay rule through a Worker socket was mapped to the test that owns the rule before it was deleted. Where no owner existed, the rule got a mock-data test in `agent-relay-core` first. The owner of a rule is checked by a mutation: break the rule in the source, see the owner's test fail, restore.

## The harness that makes the owners possible

`agent-relay-core/src/test-utils/relay-harness.ts` runs the real hosted Relay (`createHostedRelay`: routes, session channels, Host uplink) over a `MemoryRelayStateStore` and in-memory sockets, with the sign-in authority stubbed. It offers the calls of the old Worker fixture (`login`, `json`, `upgrade`, `host`, `control`, `restart`, `inspect`), so a rule test reads the same at either end. Each ported test runs in 5 to 60 ms. `restart()` starts the Relay again over the state it committed, and `inspect('fail-commit')` makes the store fail its writes.

## Deleted Worker tests and their owners

The owner column names `agent-relay-core/src/<file>`. Same-named tests are literal ports.

| Deleted Worker test (file: tests) | Rule owner | Mutation that the owner caught |
|---|---|---|
| `session-drafts`: 2 | `gateway-session-drafts.test.ts` (3 tests), `session-drafts.test.ts` | Every channel receives drafts |
| `session-reads`: 1 | `gateway-session-reads.test.ts`, `session-reads.test.ts` | A position moves back |
| `stars`: 1 | `gateway-stars.test.ts`, `session-stars.test.ts` | A list shows another account's stars |
| `favorites`: 2 | `gateway-favorites.test.ts` (the failed commit: memory store break), `favorites.test.ts`; Durable Object: store case "leaves the stored state as it was when a commit fails" | A stale revision is accepted |
| `session-rename`: 6 | `gateway-session-rename.test.ts` (6) | Titles are sent again on every refresh |
| `session-relations`: 2 | `gateway-session-relations.test.ts` (2), `session-relation-projection.test.ts` | Another account reads a Host's relations |
| `session-relations-unlink`: 4 | `gateway-session-relations-unlink.test.ts` (4) | An unlink ignores the expected revision |
| `session-migrations`: 2 | `gateway-session-migrations.test.ts` (2), `session-migrations.test.ts` | Another account's migrations reach a channel |
| `session-outbox`: 2 | `gateway-session-outbox.test.ts` (2), `session-outbox.test.ts` | A message is cancelled while delivering; every channel receives the outbox |
| `session-states`: 2 | `gateway-session-states.test.ts` (2), `session-states.test.ts` | Every channel receives session states |
| `tpm`: 1 of 2 (older Controller keeps its uplink) | `gateway-tpm.test.ts` | Not mutated; port of the same assertions |
| `codex-daemon`: 1 | `gateway-codex-daemon.test.ts` | Not mutated; port of the same assertions |
| `session-channels`: 1 of 2 (least recently used stream pause) | `gateway-session-channels.test.ts` | Not mutated; port of the same assertions |
| `journal-partition`: refuses growth over the session limit | S5 and S4 "refuses growth over the session limit", `host-journals-bounds.test.ts` | The quota refusal removed: 10 relay-core tests fail |
| `journal-partition`: answers a page past the reply bound with fewer entries | `journal-partition.test.ts`, S5 "answers a page that would pass the reply bound with fewer entries" | Halving removed |
| `journal-partition`: fills bodies and reads the page in one call (several MiB) | `journal-partition.test.ts` "fills bodies and reads the page in one step", S5 "fills bodies and reads the page in one call" | Covered by the fill step of the contract |
| `journal-partition`: keeps two journals in memory by default | `host-journals-bounds.test.ts`, S4 "keeps few journals in memory"; the default bounds stay asserted through `effectiveTuning` in the Worker | Existing owner |
| `journal-partition`: reports its capabilities | The contract replay through Durable Object RPC (new Worker test) and S5 | Version check removed: partition test fails |
| `journal-partition`: takes a session out of serving at the Controller's word | `journal-partition.test.ts`, `host-journals-amendments.test.ts` | A stale generation clears the head |

33 Worker tests are deleted. Heartbeat and registration deadlines: the rule owner is `broker-heartbeat.test.ts` (an acknowledgement of another nonce keeps the Host online: 2 tests fail), plus a new test for the registration deadline (removing the deadline fails it). The Worker keeps one test of each, with deadlines shortened through `hostLiveness`: heartbeat 40 s to 1 s, registration 10 s to 0.7 s.

## What stays in the Worker, and why

`feature-persistence.workers.test.ts`: one smoke per feature that keeps records (drafts, reads, stars, favorites, titles, relations with an unlink, migrations, outbox, session states): the feature reaches the Durable Object SQLite storage and returns after a restart. `store-conformance.workers.test.ts`: the journal and Relay state store suites in the Durable Object (34 cases). `journal-partition.workers.test.ts`: chunking at 256 KiB, one object per Host, the transaction rollback, the Worker wiring of journals, and the recorded contract through Durable Object RPC. The rest needs the Workers runtime itself: alarms and authority renewal, preview tunnels over real sockets, auth providers across cold starts, storage codec and accounting faults, the operating envelope, and the upgrade path.

Not ported, because the harness does not yet model them: `security` (6), `controller-updates` (8), `authority-renewal` (9, Durable Object alarms), `connection-diagnostics` (3). A later step can move `security` and `controller-updates` once the harness models the account authority and the release host.

## Numbers

| | Before M3 | After M3 |
|---|---:|---:|
| Cloudflare tests | 239 in 37 files | 238 in 28 files (81 `unit`, 157 `workers`, of which 34 are store conformance) |
| Cloudflare time | 185.7 s | 108 s |
| Store conformance cases | 8 (memory and SQLite) | 118: journal 24 cases on 4 targets (memory, SQLite, SQLite with 64-byte chunks, Durable Object), Relay state 11 on 2 (memory, Durable Object) |
| Partition contract in process | 1 test over a memory store | S5: 20 tests over the SQL-backed partition server |
| Tests a Relay rule change selects | `agent-relay-core`, Controller, debugger, fixtures, Workbench and Cloudflare (239 tests, 185.7 s) | The same without Cloudflare, plus the S4 and S5 seams (35 tests, under 0.1 s) |
