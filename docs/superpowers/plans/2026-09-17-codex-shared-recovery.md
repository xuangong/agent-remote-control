# Shared Codex Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Recover native shared connections automatically while preventing duplicate uncertain mutations.

**Architecture:** Stable provider sessions restore native subscriptions and authoritative history. A durable Host journal guards client mutation dispatch. Additive public state communicates recovery and unknown operation outcomes.

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

### Task 3: Durable mutation dispatch and integrated validation

**Files:** new packages/agent-host/src/operation-journal.ts and tests; host.ts, cli.ts; Relay session-wire.ts/transport option plumbing; protocol mutation schemas; web remote-session-client.ts and workbench message status; corresponding real transport tests and current docs.

**Interfaces:** Add a stable operationId distinct from transport requestId/native approval ID to every mutating client command and native create request. Relay forwards it unchanged. Host owns journal persistence under its configured state directory. Use a generic SessionWire operation execution hook supplied by Host to preserve provider-independent boundaries. Standalone non-Host uses may use in-memory execution, but configured production CLI must always enable durable records.

- [ ] Trace actual browser -> cloud Relay -> Host -> provider command path and preserve current request correlation. Use globally unique IDs for each new intent and reuse the same ID on retry. Same ID with changed canonical kind/target/parameters is rejected.
- [ ] Add failing journal tests: concurrent duplicates execute once; same ID different intent conflicts; restart recovers saved results; dispatching restart becomes unknown; persistence failure prevents dispatch; an effect followed by lost reply is never resubmitted.
- [ ] Implement atomic durable private records with file/data and directory sync as needed, serialized state transitions and exclusive writer ownership. Persist dispatching before invocation. Save successful results for duplicate replies. Conservatively mark ambiguous post-invocation failure unknown. Do not delete unknown records or silently reuse expired IDs; document retention bounds and fail closed when capacity is exhausted. Avoid storing plaintext sensitive arguments where fingerprints suffice.
- [ ] Guard send, steer, cancel, approval, setting/planning, execute-command and native creation at Host boundaries. Key on authenticated owner/Host plus provider/native identity; different transport sessions can bind the same native target. Keep native create's proposed identity durable. Validate stale approvals before dispatch; same public approval identity cannot be reused for a later socket generation.
- [ ] Expose unknown/conflict/persistence failure as explicit command errors and preserve unknown status in client UX. Never automatically retry an uncertain operation or label it definitively failed. Reconciliation uses available reliable native IDs only; lacking evidence, remain unknown.
- [ ] Exercise journal via real session/uplink transport, including operation acknowledgement loss and Host recreation. Run affected suites, build/typecheck and compatibility:update/check; update documentation, commit and report.
