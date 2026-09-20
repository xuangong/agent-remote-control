# Docker Host bootstrap Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for independent components, followed by integrated validation.

**Goal:** Start an enrolled Docker Codex Host with an automatically allocated account-owned Gateway LLM key.

**Architecture:** Device enrollment stays in Relay/Controller. Gateway owns LLM key identity, persistence and revocation. Signed internal service requests join those boundaries without shipping account sessions or service secrets to containers.

**Tech Stack:** TypeScript, Node, Bun SQLite/D1, Docker, Codex app-server.

**Spec:** ../specs/2026-09-21-docker-host-bootstrap.md

## Global Constraints

- Changes in dedicated worktrees in both repositories; no Google login, no production mutation.
- Credentials stay private; retry and restart preserve identity; tenant isolation enforced server-side.
- Source/comments/docs in English; user updates in Chinese.
- Per-test and outer deadlines; compatibility:update/check after final ARC changes.

## Tasks

- [x] Gateway: add durable atomic Host key binding and revocation migration, signed service routes, SQLite/route tests; preserve existing API key cache invalidation and key management.
- [x] Relay: resolve current device credentials to owner+Host; bounded signed bootstrap request and owner revocation; real transport tests.
- [x] Controller/Docker: opt-in managed Codex initialization, safe files/restart handling, non-root Docker and Compose, bootstrap tests.
- [x] Integration: simulate accounts using isolated SQLite and true HTTP/WebSocket; Docker creation/session/restart/revoke; inspect existing 41414 upstream and exercise only if available.
- [x] Review both diffs, run targeted suites/typechecks/builds and compatibility checks; record exact tested boundaries and usage instructions.

## Validation results

- Gateway: full `bun run ci:local` passed (3705 tests, one skip), including SQLite migrations, signing, tenant isolation, concurrent provisioning, rotation and tombstones.
- ARC: Host 176 tests, hosted Relay 132 tests, protocol 139 tests, real uplink/server transports and setup 29 tests passed; compatibility metadata verified.
- Real Docker Codex 0.155.1: simulated account login through real Gateway/Relay routes, automatic device enrollment and Host key provisioning, browser WebSocket message with real upstream response, CLI inference, restart with the same Host/key, original session restore, and Host/key revocation passed.
- The existing local Gateway Docker on port 41414 was updated with preserved account/upstream data, backed-up SQLite state and a persistent named volume. Its existing upstream returned a real Responses API completion. No Google login was used.
- Docker Desktop stalled on an additional Compose file-secret bind-mount check. The end-to-end run used a private Docker environment file and named volumes; entrypoint secret-file/restart behavior has a passing unit test. Compose file mounting is not claimed as verified on this machine.
- Work remains on feature branches; no main merge, remote push or cloud deployment was performed.
