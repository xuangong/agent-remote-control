# Favorites Tree Implementation Plan

> Execute in the dedicated worktree, with isolated backend work and local frontend work. Follow test-driven-development and verification-before-completion.

**Goal:** Organize account favorites in nested renameable folders with accessible move and drag operations.
**Architecture:** Durable Relay organization metadata extends existing session stars. One revision-checked HTTP API feeds both sidebar and title menu. Tracking and native session lifecycle remain separate.
**Tech Stack:** TypeScript, React, existing Relay state, Vitest, Playwright Chromium/WebKit.
**Spec:** `docs/superpowers/specs/2026-09-24-favorites-tree-design.md`

## Global constraints

- Keep native/session identity and local Track semantics unchanged.
- Preserve old favorites and fork replacement placement.
- Root is represented by null; mixed sibling order is authoritative on Relay.
- All tests have per-test and outer process deadlines.

## Tasks

- [x] Backend: extend `session-stars.ts`, add `favorites.ts`, validate state, integrate gateway and migrations. Add tests first for snapshot migration, create/rename/move/delete, cycles, account isolation, stale revision and durable failure. Use the exact spec snapshot/command interfaces. Run hosted tests and typecheck.
- [x] Client: extend `session-stars-client.ts` with snapshot and command methods; update `useSessionStars.ts` to store folders/revision and manage pending/conflict recovery. Preserve generation guards for account switching. Test failed changes and stale account responses.
- [x] UI: add folder picker/editor and reusable tree with context actions, rename, delete confirmation, move-to, pointer drag, hover expansion, scrolling and keyboard alternatives. Integrate `SessionFavorites.tsx` and top-level sidebar tabs in `App.tsx`; retain title shortcut and independent Track.
- [x] Acceptance: test real authenticated endpoints and persisted Worker state; exercise UI at phone/desktop widths in Chromium and WebKit. Verify drag-to-folder, reorder, keyboard move, rename, nested creation, starred editing and unstar.
- [x] Finish: document behavior; run affected tests/typechecks/build; run `pnpm compatibility:update` and `pnpm compatibility:check`; review diff and report without deploying.

## Verification record

- Hosted suite: 157 tests passed; hosted build and typecheck passed.
- Cloudflare suite: 33 tests passed across 10 files, including authenticated requests, durable restart, and rejected SQL persistence. Build and typecheck passed.
- Lab suite: 612 passed, 6 skipped. Native Codex process integration was excluded because it requires an explicit test executable; the running daemon was not changed.
- Final affected Lab tests: 15 passed across 4 files; frontend and browser test typechecks passed.
- Chromium and WebKit browser acceptance passed at 390px and 1440px. Chromium additionally verified real touch hold, hover expansion, edge scrolling, cancellation, and keyboard scrolling. Both engines verified rename and focus recovery after deletion.
- Production build, compatibility update/check, and diff whitespace checks passed. Existing bundle-size warnings remain.
- Implementation stays on `feat/favorites-tree`; no merge, push, deployment, or Controller restart was performed.
