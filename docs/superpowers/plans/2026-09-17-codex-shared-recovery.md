# Shared Codex Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Recover native shared connections automatically and suppress duplicate mutations within a bounded live-Host cache.

**Architecture:** Stable provider sessions restore native subscriptions and authoritative history. A bounded in-memory Host cache guards client mutation dispatch. Additive public state communicates recovery and unknown operation outcomes.

**Tech Stack:** TypeScript, Node 22, pnpm workspaces, ws, TypeBox, React, Vitest.

**Spec:** docs/superpowers/specs/2026-09-17-codex-shared-recovery.md

## Global Constraints

- Work only in the dedicated agent-remote-control worktree; preserve running services and unrelated worktrees.
- English code/comments/docs, Chinese user communication. Preserve SDK/protocol/Relay/adapter/renderer boundaries.
- No automatic replay of unknown mutations; no text-based deduplication; no automatic private-daemon fallback.
- Maintain session/native identity, live observation streams and read-only child capability during native recovery.
- Every test has runner and outer process deadlines. Use real transports for recovery behavior. Build workspace dependencies before dependent tests.
- Update compatibility metadata, fixtures and current docs. No push/deploy/service replacement.

### Task 1: Recovery state and interaction invalidation contracts

**Files:** SDK observation.ts and exports; protocol runtime/events/interactions schemas; Relay agent-manager.ts, agent-manager-events.ts, session-wire.ts; web replica reducers/client and existing workbench controls in agent-remote-lab; corresponding contract and render tests.

**Interfaces:** Produce optional `AgentRuntimeInfo.connection: { state: 'connected' | 'reconnecting' | 'restoring' | 'unavailable'; reason?: string; attempt?: number; nextRetryAt?: number }`. Produce SDK `interaction_invalidated` event carrying provider, requestId, reason and optional turnId; propagate as explicit public interaction invalidation without response fabrication. Other providers can omit connection.

- [ ] Add behavioral failing tests for schema roundtrip, pending request removal without a response timeline entry, reconnecting runtime propagation and disabled mutation controls.
- [ ] Add the connection contract to SDK/public strict schemas. Add invalidation handling to Relay and replica/client dispatch; ensure no exhaustive event switch silently drops it.
- [ ] Gate existing send/steer/cancel/settings/planning/command/approval controls during non-connected native state, displaying a compact explanatory status using existing styles. Keep mounted conversation/drafts/previews. Native hard guards arrive in Task 2.
- [ ] Run focused packages with testTimeout 10000, hookTimeout 30000, outer timeout 180 seconds; update compatibility; build/typecheck affected consumers.
- [ ] Commit the cohesive contract/client change and write report with commands, results, interfaces and concerns.

### Task 2: Stable shared runtime recovery

**Files:** packages/agent-provider-codex/src/app-server-transport.ts, runtime.ts, session.ts, provider.ts; new shared-recovery.ts if needed for backoff/generation coordination; new real Unix WebSocket recovery tests; shared-runtime.local.test.ts; docs/current/agent-remote/codex-shared-runtime.md.

**Interfaces:** Consume runtimeInfo.connection and interaction_invalidated from Task 1. Keep AgentSession objects and observe iterables stable. Publish timeline_replacement for restored already-observed history.

- [ ] Read existing transport/runtime/session bootstrap and native child routing. Add failing real Unix WebSocket tests for disconnect with a surviving daemon and daemon disappearance/reappearance, observe continuity, no repeated turn/start and disposal cancellation.
- [ ] Implement one root recovery task with cancellable jittered 500 ms to 30 second backoff, connection/restoration deadlines and bounded shared-root concurrency. Fence notifications, RPC outcomes and restoration tasks from old generations. Classify known permanent permission/protocol/missing-thread failures into unavailable.
- [ ] Restore initialize and existing root/children using authoritative native state and history; do not resend cached settings, start a thread or task, or treat task execution as automatically resumed. Reconcile item identities and buffer notifications across snapshot handoff. Use replacement after readiness, one history boundary only.
- [ ] Keep temporary failure out of terminal queue failure. Hard reject mutations while disconnected/restoring, preserve read-only child permissions and fresh public approval identities, invalidate old interactions without answers. Disposal cancels pending recovery and leaves the external daemon running.
- [ ] Expand tests to stale callbacks, repeated loss, child identity/read-only state, approval invalidation, permanent errors and final history consistency. Update isolated native integration expectations and run if a compatible executable exists without touching the user's daemon. Tests use per-test deadlines and outer 180/300 second limits.
- [ ] Update current documentation, build affected packages, run focused regression and commit. Report all tested/untested boundaries.

### Task 3: Bounded mutation deduplication and integrated validation

**Files:** new packages/agent-host/src/operation-cache.ts and tests; host.ts; Relay session-wire.ts/transport option plumbing; protocol mutation schemas; web remote-session-client.ts and workbench message status; hosted native create/stop routes and their clients; corresponding real transport tests and current docs.

**Interfaces:** Stable operationId distinct from transport requestId/native approval ID on client mutations and native create/stop requests. SessionWire mutations and owner create requests preserve it through Relay to Host. Shared-recipient create uses the existing quota namespace boundary to derive the Host UUID from stable Host, subject, Provider and client operation identities. A generic SessionWire operation hook supplies Host-owned in-memory deduplication without introducing disk persistence or changing the Node requirement.

- [ ] Preserve operation IDs across explicit retries; generate new IDs for new intents. Scope canonical kind/target/parameters to the authenticated owner and Host. Concurrent duplicates execute once; conflicts reject; duplicate successes use saved business results with the current request envelope.
- [ ] Bound cache record count, retained bytes and retention time. Register before dispatch; keep in-flight entries pinned, expire settled entries automatically and fail new mutations closed at capacity. Unknown entries suppress re-dispatch while retained. Host restart clears the cache by design.
- [ ] Guard send, steer, cancel, approval, settings/planning, execute-command, native creation and Host batch stop. Freeze scope per authenticated uplink. Check duplicate approval before now-absent pending validation and return a submission acknowledgement without inventing interaction_resolved.
- [ ] Keep native create identity authoritative and preserve operation identity through hosted body filtering and quota reservation. For a shared recipient, derive the Host operation UUID from the stable Host ID, subject, Provider and client operation ID so retries, reconnects and credential rotation retain the same Host identity. Never include proposedAgentId/requestId in the native creation fingerprint.
- [ ] Clearly display unknown outcomes without automatic retry or a false definitive failure. Add behavior tests for concurrent duplicate, conflict, retention, capacity, unknown result, cache reset and real session/uplink lost acknowledgements. Update browser fixture assertions as needed.
- [ ] Remove only this task's abandoned SQLite draft files, retain unrelated user material, update current docs/spec/compatibility, build/typecheck affected packages, run covering tests with deadlines, commit and report. Do not change diagnostic rotation in this task.

### Task 4: Bounded daemon diagnostic logs

**Files:** new packages/agent-host/src/diagnostic-log.ts and tests; cli.ts, launchd.ts if required for descriptor ownership; corresponding CLI/launchd tests and current Host runbook.

**Interfaces:** The local daemon owns automatic diagnostic cleanup independent of operation-cache cleanup. Preserve current safe diagnostic content and agent-host.log location.

- [ ] Add behavior tests with small byte thresholds for rotation while a writer remains open, archive count limits, startup over-limit cleanup, cleanup errors and shutdown timer cancellation.
- [ ] Implement a default 5 MiB log threshold and three archives. Account for inherited stdout/stderr descriptors in both launchd and manually detached daemon modes: renaming a file alone does not redirect an open descriptor. Enforce bounded retained output during runtime and startup, without unbounded buffering or recursive error logging.
- [ ] Integrate clean shutdown, restrictive permissions and existing CLI diagnostic sanitization. Do not change operation-cache state as part of diagnostic rotation or change user autostart preferences.
- [ ] Run focused diagnostic/CLI/launchd tests with runner and outer deadlines, build/typecheck Host and document actual retention/overshoot bounds. Commit and report.
