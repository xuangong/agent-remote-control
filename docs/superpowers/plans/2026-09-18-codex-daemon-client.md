# Codex Daemon Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Make the existing Codex daemon connection and recovery reusable without the application Remote protocol.

**Architecture:** A native client package owns transport and recovery; the Codex Provider maps native events and restoration snapshots to the existing SDK. Keep one production implementation of recovery and preserve observable behavior.

**Tech Stack:** TypeScript, Node 22+, ws, pnpm workspace, Vitest with real Unix WebSocket fixtures.

**Spec:** docs/superpowers/specs/2026-09-18-codex-daemon-client.md

## Global Constraints

- No SDK, Remote protocol, Relay, Web or Host runtime dependency in the new package.
- Preserve current wire semantics, private transport behavior, native identity and uncertain-operation rules.
- Preserve retry/deadline/concurrency defaults from the spec.
- Source, comments and docs are English; progress is Chinese.
- Work only in this worktree. No merge, push, publish, deployment, live daemon changes or launchctl tests.

### Task 1: Extract and integrate the native client

**Files:**
- Create `packages/codex-daemon-client/package.json`, `tsconfig.json`, `README.md`, license/notice and focused `src` transport, initialization, recovery and client modules with tests.
- Refactor `packages/agent-provider-codex/src/app-server-transport.ts`, `initialize.ts`, `shared-recovery.ts`, `runtime.ts`, `session.ts`, `provider.ts`, native history helpers and imports according to ownership.
- Update Provider dependencies, `pnpm-lock.yaml`, relevant build/test scripts only where required, and `docs/current/agent-remote/codex-shared-runtime.md` and Provider docs.
- Keep application integration cases in `packages/agent-provider-codex/src/shared-recovery.test.ts`; place native-only regressions with the new package.

**Interfaces:**
- Consumes Codex JSON-RPC transport/payloads and callbacks for native events, requests and snapshot handoff.
- Produces an exported native client API and its connection/recovery contracts; it must be usable by a consumer with no Agent SDK types. Preserve Provider transport exports via re-exports.

- [ ] Inspect native routing and session recovery call order; settle minimal public native interfaces before editing and report their names/contracts to the coordinator.
- [ ] Add an independent-consumer real Unix test that imports only the new package. Its consumer projects an arbitrary record, verifies a recovered original thread and ordered snapshot/delta notifications, rejects stale-generation responses and never sends a new thread/start or repeats a turn mutation. Capture failure before the package exists.
- [ ] Move protocol transport and initialization, exposing consumer-supplied initialization identity with the Provider passing its existing values. Keep native object helpers separate from application projection.
- [ ] Extract lifecycle/recovery and native snapshot reconciliation into focused modules. Keep application descriptors, observation queues and event projection in the Provider. Move native-only child routing if required for correctness, without importing SDK-shaped sinks.
- [ ] Replace Provider orchestration with the new client callbacks, preserving the same external state transitions and timeline/interaction output. Do not maintain a second recovery implementation.
- [ ] Migrate existing native tests where natural and run package tests plus Provider non-local suites once after focused cases pass; include the existing Provider-to-Manager/Wire recovery regressions. Commands use `vitest run --testTimeout=10000 --hookTimeout=15000` and Python subprocess outer deadlines.
- [ ] Write README with minimal usage, mapping to another application protocol, snapshot handoff and cancellation/outcome responsibilities. Typecheck the example or use it as the independent test consumer.
- [ ] Pack and install the built new package in a temporary directory outside the worktree and run the independent consumer against a temporary Unix fixture. Do not publish to a registry. Verify no workspace runtime dependencies or application types leak.
- [ ] Run affected build/typecheck, compatibility update/check, documentation gate and diff whitespace check; record commands, output and remaining boundaries. Commit implementation with `refactor: extract reusable Codex daemon client`.

The coordinator performs the final workspace build/typecheck and standalone Host packaging after the implementer finishes production edits, then dispatches review. No second repo implementation is included.
