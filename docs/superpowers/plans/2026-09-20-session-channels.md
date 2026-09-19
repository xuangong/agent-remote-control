# Persistent Session Channels Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement the independent transport tasks and review the integrated result.

**Goal:** Reuse two physical browser connections while preserving isolated full-session and activity subscriptions, side windows, and cached timeline recovery.
**Architecture:** A public framing layer multiplexes existing session wires. Browser logical connections continue implementing RemoteConnection. UI activity observes tracked plus open windows without becoming authoritative over a full-session replica.
**Tech Stack:** TypeScript, TypeBox, React, Vitest, Playwright, ws, Cloudflare Worker.
**Spec:** docs/superpowers/specs/2026-09-20-session-channels-design.md

## Global Constraints
- Work only in `.worktrees/session-channels`; source/docs English, user updates Chinese.
- Keep full session replicas and activity observations separate. No state-version machinery.
- Maintain access checks and expiry for every logical stream. No command replay on failure.
- Reuse existing timeline epoch/cursor synchronization and operation IDs.
- Tests use per-test and outer deadlines; build artifacts are not written concurrently.

## Task 1: Public framing and pure server adapter
Files: protocol/src/session-channel.ts, protocol/src/session-channel-wire.ts, protocol/src/index.ts and focused tests.
Interfaces: exported SessionChannelClientMessage/SessionChannelServerMessage schemas and codecs; SessionChannelSocket structurally matches RelaySocket; acceptSessionChannel(socket, mode, openSession) adapts existing per-session socket preparation. openSession(agentId) asynchronously returns { accept(socket) } or { code, reason }.
- [x] Write rejection/round-trip and lifecycle tests; run them failing before implementation.
- [x] Implement schemas, bounded framing lifecycle, mode enforcement, per-stream isolation, unsubscribe races, physical cleanup, ping/pong and backpressure limits.
- [x] Run focused tests with 10s per-test and 90s process deadline; document endpoint and frames.

## Task 2: Browser channel pool
Files: web/src/client/session-channel-transport.ts, http-websocket-transport.ts and tests.
Interfaces: add dependencies.sessionChannels?: boolean; connect(agentId, listener) remains unchanged. First negotiate chooses the full/activity pool. Channel frames follow Task 1. dispose() releases owned physical channels.
- [x] Test reuse across A/B, simultaneous A/B, activity separation, delayed frames, physical disconnect and disposal.
- [x] Implement one physical connection per mode, pending subscribe buffering with bounds, monotonic IDs, strict frame validation and fallback only before channel ready. Preserve transport observations.
- [x] Validate focused tests and typecheck after protocol build.

## Task 3: Relay integration and UI lifecycle
Files: hosted/src/gateway.ts, relay/src/transport/websocket-stream.ts, lab/src/App.tsx, hooks/useSessionTracking.tsx, components/SideConversation.tsx and tests.
- [x] Add authenticated channel endpoints which adapt existing per-session paths/wires and preserve per-session resource authorization, expiry, revocation and capacity limits.
- [x] Opt App into pooling; dispose only internally owned transports. Keep activity observers for tracked plus open windows with stable native identities and no reattach on mere focus changes. Continue excluding visible sessions from tracking UI.
- [x] Reuse cached replicas for side windows and preserve existing primary timeline recovery.
- [x] Add real WebSocket tests and UI tests for subscription changes, cache/cursor recovery and parallel windows. Run focused tests, typechecks, compatibility:update/check, build and browser acceptance.

## Ready gating
- [x] Require target-session Ready for send, retry, approval, cancellation, settings, and console operations, independently for each window.
- [x] Keep cached content and editable drafts while negotiating or catching up.
- [x] Test paused incremental history, per-window controls, StrictMode disposal, and actual browser WebSockets.

## Review and delivery
- [x] Review framing/client individually, then review all code for auth, races, resource cleanup, and user-approved behavior.
- [x] Record final verification evidence and environment limitations.

Delivery: commit the reviewed implementation, fast-forward main, push, deploy the Worker and browser assets, and verify public health plus asset hashes.

## Verification boundaries
The full Lab run passed 465 tests and skipped 6. Twelve environment-dependent tests could not pass on this machine: eleven require `/usr/bin/python3`, currently blocked by the unaccepted Xcode license, and one requires `BORGEE_CODEX_TEST_EXECUTABLE`. The UI suites, real channel transport suites, all 19 Cloudflare runtime tests, workspace typecheck, and builds passed. Browser coverage uses desktop/mobile emulation, including page-resume events; it does not measure real cellular-network reliability.

Desktop/mobile browser acceptance passed 18 tests across the final regression and resume-specific runs. The resume test observes two replacement physical channels, then verifies three subsequent session switches create no additional physical sockets.
