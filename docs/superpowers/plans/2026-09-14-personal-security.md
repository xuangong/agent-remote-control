# Personal Security Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development for independent implementation tasks and fresh review. User approved the complete scope in conversation.

**Goal:** Harden personal remote access while preserving ordinary mobile use.
**Architecture:** Gateway issues limited continuation handles; Relay enforces login/Host control; local Host policy constrains native execution.
**Tech Stack:** TypeScript, Bun SQLite/D1, Node 22.23.2, pnpm, Workers Durable Objects, React.
**Spec:** docs/superpowers/specs/2026-09-14-personal-security-design.md

## Global Constraints
Dedicated worktrees; English sources/docs; Chinese user updates. No production mutations, push, merge or native CLI calls. Preserve unrelated services/files. Tests use per-test and process deadlines. Use Tencent npm registry.

- [x] Gateway task: implement opaque continuation storage in common SQL repositories with additive migration, actual OAuth freshness and safe return path, freshness enforcement on share additions, rate limits/audit as appropriate. Add regression tests including decryption non-disclosure, logout/expiry and CSRF. Run Gateway CI.
- [x] Host task: implement local execution policy, sanitized child environment, native sandbox defaults, locked settings, explicit cancel-all endpoint, credential persistence and uplink handshake. Add behavior tests and typecheck. Own agent-host, provider configuration changes, uplink protocol/client; coordinate wire messages with Relay.
- [x] Relay task: browser session management, recent-auth checks, durable redacted audit, bounded rate limits, credential enrollment/rotation, owner-only stop relay. Add real transport and persistence tests. Own hosted/Cloudflare server code.
- [x] Controller task: implement accessible mobile security settings, login list/revoke controls, audit list, credential rotation and stop actions with truthful results, safe reauthentication links. Add component/browser tests. Own lab client components and CSS.
- [x] Integration: run contract tests across both projects, full compatible typecheck/build, compatibility:update/check, selected browser and workerd regressions. Resolve findings from independent review before reporting.
- [x] Document rollout order, forced re-login boundary, unchanged durable storage secret, local opt-outs, emergency revocation and cancel limitations.

## Decisions and validation ledger
- Initial baseline: previously reviewed exact starting commits ARC 11a7ffd and Gateway 3dd3661c; 90 focused security regressions passed immediately before this task. Fresh worktree dependencies installed separately.
- Ruling: execution is already approved by the user; do not re-ask approval for reversible worktree implementation. Deployment/production credentials remain outside this task.

- Host implementation commits: 0dff64d, 3315476, 0ce3d5e. Native permission command bypass and management environment masking findings fixed; independent scoped review approved.
- Controller implementation commit: bb220dc. Thirty focused component/HTTP tests and four desktop/mobile browser cases passed.
- Gateway implementation commits: d82426a4 and 864a1f03. Final full CI: 3617 passed, one existing skip, zero failures; purity, typecheck, lint (warnings only), UI build and Wrangler deployment dry-run passed. Actual workerd/D1 verified migrations 0011/0012, absent legacy authentication provenance, continuation invalidation, device API authentication-time inheritance, launch/renew and revocation. Independent scoped review closed the device-flow authentication-time bypass.
- Relay transport coverage: thirteen Node lifecycle cases and twelve workerd cases, including browser revocation, audit restoration, oversized Host IDs, actual auth freshness, interruption/reconnect, renewal limits and cross-owner stream allowance.
- Integration: real Gateway SQLite -> Node Relay -> desktop/mobile Chromium passed, including shared session ACL/quota, process replacement, device rotation, explicit partial stop and other-browser revocation.
- Validation boundary: plain pnpm test attempted installed Codex local probes and failed because local CLI is 0.46.0 while those probes require 0.148.0. A subsequent run reached the Copilot native fixture using a fake local model server and encountered a startup timeout. No paid model service was used. Final offline acceptance excludes all three installed-native fixture patterns documented in security.md and was run after implementation completed.

- ARC final source commit 1a316f0: Relay implementation plus regressions; final independent static review found no new blockers, including invitation TTL preservation across interrupted enrollment.
- Final ARC offline test matrix: 1546 passed, six existing skipped. Installed CLI probes are explicitly excluded using three patterns documented in security.md; ordinary root test is not offline-only. All package typechecks, build, compatibility check and Workers deploy dry-run passed.
- Mobile/auth/session-link regression: 16 passed, eight platform-conditional skipped. New security UI: four browser cases passed. Final real Gateway SQLite -> Relay -> browser integration passed in both Node and Workers modes after the Gateway authentication-provenance correction. These integration tests start no native CLI agents.
- CLI packaging: built tarball and independent installation/start/pair/restart tests passed (two cases), using fake provider executables and paths containing spaces.
