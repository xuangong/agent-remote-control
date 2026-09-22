# Controller Updates Implementation Plan

**Goal:** Publish a versioned Controller to GitHub Releases and support owner-confirmed updates from the website.

**Architecture:** Typed release and Host identity contracts, trusted release discovery, a local installer and stable supervisor, and an account-scoped UI over existing Host RPC.

**Tech Stack:** TypeScript, Node 22, TypeBox, React, Vitest, real WebSocket transports, GitHub Releases, Cloudflare Workers.

**Spec:** `docs/controller-updates.md`

## Global constraints

- Work in `.worktrees/controller-updates`; preserve credentials and native daemons.
- Shared Codex may keep working during upgrade; other active runtimes and outstanding interactions block restart.
- No arbitrary URLs or shell commands; use published release identity and verified digest.
- Retain old package and rollback on failed registration.
- Keep standalone and hosted account boundaries intact.

## Tasks

- [x] Release identity and discovery: contract validation tests, trusted GitHub resolver/cache, package version and release manifest builder.
- [x] Controller upgrade lifecycle: installer tests, restart admission and status persistence, stable launcher and packed lifecycle tests including rollback.
- [x] Owner control: registration metadata, durable validation, authenticated RPC, transport tests proving shared users cannot upgrade.
- [x] Website: release coverage, explicit confirmation and per-Host status, refresh/reconnect handling, component/browser tests.
- [ ] Delivery: compatibility update/check, typecheck/build and focused integration tests, commit and merge, deploy Relay, publish release artifacts, bootstrap this local Controller, verify native daemon unchanged.
