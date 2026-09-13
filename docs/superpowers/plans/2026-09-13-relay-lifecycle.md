# Hosted Relay Lifecycle Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for independent Gateway work and focused review; implement dependent Relay work inline.

**Goal:** Persistent, revocable workstation access and renewable browser sessions.
**Architecture:** Gateway authority leases, local Relay sessions, durable broker state; native provider and public session protocols unchanged.
**Tech Stack:** TypeScript, Hono/WebCrypto, Node HTTP/ws, atomic JSON files, React, Vitest, Bun SQLite tests, Chromium.
**Spec:** ../specs/2026-09-13-relay-lifecycle-design.md

## Global constraints

Work only in the existing dedicated worktrees. No push/merge/deploy. No real CLI calls. Tests have per-test and outer deadlines. No login secrets in logs. Preserve local standalone defaults.

- [x] Gateway task: add failing SQLite-backed tests for continuation renew, disabled/revoked sessions, service purpose/body/audience/expiry rejection; implement `control-plane/agent-remote/lifecycle.ts` and route mount; add dashboard entry and automatic challenge form submission; run focused tests and full CI.
- [x] Broker task: add failing real-transport restart/revoke/rotation tests; add serializable `RemoteHostBrokerState`, persistence callback, restore/recover behavior and per-request renewable lease callback to `remote-host-broker.ts`. Return a copyable hosted command; retain standalone defaults.
- [x] Relay task: add failing renewable cookie/lease/expiry/logout/restart tests; implement service proof client, atomic state store and server-side session manager in separate gateway modules. Persist before acknowledging device/session changes. Recheck Gateway on startup and periodically. Integrate CLI state dir and shutdown.
- [x] Client task: add failing test proving renewal preserves mounted controller; implement refresh retry bounded by lease, logout, device revoke and Host private saved connection configuration. Run affected client and Host tests.
- [x] Integration task: extend actual Gateway/Relay Chromium harness and transport tests for renew/restart/revoke; review cross-boundary semantics, update deployment documents; build then typecheck/test and compatibility checks; commit each repository without merging.

## Validation evidence

- ARC: 160 controller/auth/broker/transport tests passed, plus 20 Host configuration/management tests. Tests use per-test timeouts and process deadlines.
- ARC full workspace build and typecheck passed; compatibility metadata update/check passed.
- Gateway: final `ci:local` passed with 3581 tests passed, one skipped, zero failures; typecheck, lint, UI build and Cloudflare dry-run passed.
- Real cross-project Chromium test passed: SQLite-backed Gateway login, automatic handoff, two-user isolation, forwarded-link rejection, renewal, actual Relay process restart with stable device/binding identities, device revoke and logout. No native CLI agents or cloud inference were started.
- Independent review found four lifecycle issues (revoked pending socket registration, unavailable authority causing terminal rejection, browser wake-up state loss, stale-lock reclamation race); all were corrected. Revoked late registration and production-uplink outage behavior were verified red-to-green; client wake-up and ownership tests pass.
- Native provider behavior, real OAuth-provider login, cloud deployment and multi-replica operation are outside this validation. No merge, push or deployment is included.
