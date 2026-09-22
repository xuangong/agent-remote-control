# Host-local Connection Diagnostics Implementation Plan

> Use superpowers:subagent-driven-development for independently scoped Controller and storage work; the root implements the journal and broker integration. All tests use explicit inner and outer deadlines.

**Goal:** Collect timestamped Server stability events on their corresponding Host, alongside existing Controller logs.
**Architecture:** Bounded independent Server journal, authenticated existing RPC delivery, separate rotated Controller log. Storage failure is diagnostic-only and never fails session/authorization state.
**Tech Stack:** TypeScript, existing Host WebSocket RPC, Node files, SQLite Durable Objects, Vitest.
**Spec:** `docs/superpowers/specs/2026-09-24-connection-diagnostics.md`

## Global constraints

- Work only in `.worktrees/connection-diagnostics`.
- Event occurrence timestamp is authoritative; no merged timeline or time synchronization.
- Limits: 256 events/Host, 4096 total, 24h TTL, 32 records/batch, 30s retry.
- No native daemon restarts or changes to provider/session semantics.
- Log no credentials, message content, raw errors, titles or workspace paths.

## Task 1: Contract, journal and broker (root)

Files: new `packages/agent-remote-hosted/src/relay-diagnostics.ts`, `diagnostic-journal.ts`, corresponding tests; modify `broker.ts`, `gateway.ts`.

Contract: `RelayDiagnosticStore { initial?: unknown; save(entries: RelayDiagnostic[]): Promise<void> }`. Export `parseRelayDiagnosticBatch(value: unknown): RelayDiagnostic[] | undefined` and `RELAY_DIAGNOSTIC_PATH = '/remote/diagnostics/relay'` from `relay-diagnostics.ts`. Batch envelope `{entries}` (1..32). Journal records stable IDs and original ISO timestamps, admits allowlisted fields only, prunes before save, isolates storage failures. Journal connects a sender per Host; successful delivery removes exactly that batch; failed delivery retains it. 404 disables sender until new registration.

- [x] Write failing journal tests for host isolation, retention, 204 ack, failed delivery and storage failure.
- [x] Implement journal and strict contract. Test schema rejects unknown fields and bodies over limits.
- [x] Wire broker lifecycle, heartbeat failures, RPC timeout/failure and stream events into journal. Never log delivery RPC failures recursively. Record per-connection random identity and per-Relay instance identity.
- [x] Validate real transports and integration, including replay, legacy capability discovery, busy transport deferral, and updater-status failure.

## Task 2: Host sink and command (implementer)

Files: new `packages/agent-host/src/relay-diagnostics.ts`, tests and `diagnostics-command.ts`; modify `host.ts`, `cli.ts`. Imports use hosted subpath `/relay-diagnostics`.

Interfaces: Host option `onRelayDiagnostics?(entries: RelayDiagnostic[]): void | Promise<void>`. Intercept only `POST /remote/diagnostics/relay`, parse body through shared validator, await sink, return 204. Missing sink => 404; invalid batch => 400; failed write => 503. Acknowledge only on append success. Use standalone sink backed by private bounded `relay-diagnostics.log`; preserve original timestamps. `diagnostics` CLI shows paths or selected recent entries, supports `--source controller|server|all`, `--since <ISO>` and `--limit <1..1000>`. Foreground logs must also remain on disk.

- [x] Write and run failing sink/CLI tests.
- [x] Implement strict sink, bounded rotation and CLI wiring.
- [x] Verify actual Host RPC behavior, append failure, validation, source filters and archives.

## Task 3: Persistence adapters (implementer)

Files: new `packages/agent-remote-cloudflare/src/diagnostic-storage.ts`, new `packages/agent-remote-lab/src/server/gateway-diagnostics.ts`, tests; modify `relay-object.ts` and `gateway-relay.ts` only for wiring.

Interfaces: `HostedRelayOptions.diagnosticStorage?: RelayDiagnosticStore`. Adapters return `{initial, save(entries)}`. Cloudflare table `relay_connection_diagnostics`, independent of main Relay tables. Node file `${stateFile}.diagnostics.json`, private atomic writes; failure cannot block regular startup/requests. Shared validator exported as `isRelayDiagnostic(value: unknown): value is RelayDiagnostic`. Store data must be bounded and validated on load; malformed diagnostics may be discarded without affecting business state.

- [x] Test save/load/restart, malformed records, bounded input and write failure independently of core state.
- [x] Implement and wire both adapters.
- [x] Verify Cloudflare runtime and Node builds.

## Task 4: Acceptance, docs and review (root)

- [x] Document local diagnostic-session usage, sources, retention, at-least-once duplicates, and restart coverage limitations.
- [x] Review each implementer's diff against spec and add missing tests.
- [x] Run complete affected suites, typechecks and builds; compatibility:update and compatibility:check.
- [x] Final independent review and local commit. No merge/deploy/install.

## Verification record

- Real WebSocket coverage: disconnect/reconnect, Server restart replay with original timestamp, Host isolation, local file append, RPC timeout redaction, stream opening/readiness/closure, legacy capability gating, and failed updater status with independent diagnostic delivery.
- Reviewed and fixed journal persistence completion races and diagnostic traffic competing with heartbeat/business buffers. Regression tests verify both the initial probe and delivery recheck.
- Protocol: 150 tests passed. Hosted: 172 passed. Controller: 345 passed, 8 skipped. Lab: 622 passed, 6 skipped; the native `codex-host-process.test.ts` requires an external executable and was excluded. Cloudflare: 37 passed.
- Relevant package builds and typechecks passed. Compatibility source digest updated and checked. Existing Vite large-chunk warning remains unchanged.
- One combined regression run observed the existing `controller-update.test.ts` immediate retry race: in-memory `failed` can be visible while the failure status write still keeps `work` occupied. The unchanged updater returns the same operation without starting the retry during that interval. An independent complete Controller run passed; this pre-existing updater issue is not fixed or hidden by this diagnostic change.
- Review confirmed no remaining known blocking issue in the diagnostic delivery changes. No production deployment, merge, push, Controller installation, or native daemon restart performed.
