# Gateway Relay Implementation Plan

**Goal:** Add optional user-authenticated hosting while preserving standalone behavior.
**Architecture:** Gateway issues short relay-only grants; an independent Relay verifies them and dispatches to user-owned brokers.
**Spec:** `../specs/2026-09-13-gateway-relay-design.md`
**Execution:** Inline with test-driven-development; dedicated worktrees; no deployment or push.

- [x] Gateway: add SQLite-backed route tests for session-only launch, then implement `control-plane/agent-remote/routes.ts` and mount before general auth prewarming. Configure issuer, target and secret using platform env. Add launch page and form.
- [x] Relay: add signed grant validation tests and real transport tenant isolation tests, then implement `server/gateway-auth.ts` and `server/gateway-relay.ts`. Extend broker with explicit access/mutation policies, pairing notification, public URL and socket expiry without changing local defaults.
- [x] Controller: test auth gate states and per-user base URL, then add `GatewayController.tsx`. Serve built assets and callback from standalone Relay CLI with `start:gateway-relay`; local mode stays unchanged.
- [x] Integration: exercise gateway real SQLite login -> grant -> cookie -> two tenant brokers -> scripted Host registration, control HTTP and WebSocket forwarding. Document commands and finite grant/restart boundaries.
- [x] Validation: run focused suites with per-test and process deadlines, build/typecheck and compatibility update/check; run gateway ci:local. Inspect final diffs and preserve both worktrees for review.

## Verified results

- ARC: 138 focused controller/auth/broker tests and 180 Relay package tests passed.
- ARC: full workspace build and typecheck passed; compatibility update/check passed.
- Gateway: `ci:local` passed with 3569 tests passed, one skipped, and no failures; typecheck, lint (no errors), UI build and Cloudflare dry-run passed.
- Cross-project Chromium test passed with the real SQLite-backed gateway, actual Relay entrypoint, scripted Host, two isolated users and forwarded-login rejection. No CLI agents were started.
- Independent security review identified login CSRF; the browser verifier/challenge binding was added, demonstrated red-to-green, and re-reviewed.
- A test run concurrent with a build failed because package exports target the build directory, which the build cleans. Running the same suite after build completion passed all 138 tests. Build and dependent tests must run sequentially.
- Cloudflare deployment, real OAuth-provider login and native CLI execution were not exercised. Both worktrees remain isolated; no merge, push or deployment is included.
