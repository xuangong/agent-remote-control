# Claude Provider Implementation Plan

**Goal:** Manage Claude Code and Codex concurrently through one Agent Host.

**Architecture:** A dedicated SDK-backed Claude adapter owns native sessions, history, event projection, and permission callbacks. Host selects registrations and reuses its provider-scoped routing.

**Tech Stack:** TypeScript, Claude Agent SDK 0.3.247, Claude Code 2.1.247, Vitest, real HTTP/WebSocket transports.

**Spec:** `docs/superpowers/specs/2026-09-11-claude-provider.md`

## Constraints

- Work only in `.worktrees/claude-provider`; no public protocol changes.
- Use pnpm 10.34.5, per-test timeouts and an outer deadline for every suite.
- Credentials stay in the inherited native environment, outside tracked files.

## Tasks

1. Add `packages/agent-provider-claude` with `projector.ts`, `interactions.ts`, `session.ts`, `provider.ts`, and isolated catalog helpers. Write failing observable projection and session tests, then implement the SDK bridge. Verify streamed/final deduplication, root/child separation, approval validation and cancellation, cold history, and native session identity.
2. Add `packages/agent-host/src/claude.ts` and `registrations.ts`. Extend CLI and exports. Test provider selection, unknown/duplicate provider input, independent provider catalogs/identity, and re-pair over a real WebSocket. Keep Codex default behavior and cleanup on partial registration failure.
3. Add native Claude local-process tests using an isolated home/workspace and loopback Messages server. Exercise initialization, multiple turns, tools/approval, persisted catalog/history/resume, cancellation and cleanup. Run Codex regression with 0.148.0 and full typecheck/build/conformance as appropriate.
4. Document dual-provider and Claude-only startup, supported capabilities and limitations. Update compatibility metadata, run `pnpm compatibility:update` and `pnpm compatibility:check`, review the final diff, and leave the feature in its worktree.
