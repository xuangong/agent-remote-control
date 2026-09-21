# Frontend Performance Implementation Plan

> Execute inline with superpowers:executing-plans; no delegation.

**Goal:** Remove history-dependent input work and unnecessary persistence/idle activity while preserving recovery and reading continuity.

**Architecture:** Lab owns keyed draft subscriptions and bounded replica retention. The reusable renderer owns scroll indexing, image persistence, and editor behavior. Existing transport and operation semantics remain unchanged.

**Tech Stack:** React 18, TypeScript, IndexedDB, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-22-frontend-performance-design.md`

## Global constraints

- Dedicated worktree; no merge, push, deployment, or native service restart.
- Main, Side, and Ask must retain independent editing and existing pending-send behavior.
- Preserve text anchors, image recovery, scope generations, and permission boundaries.
- Tests use explicit per-test and outer process deadlines.
- Build before browser tests; regenerate and check compatibility metadata.

## Task 1: Draft subscriptions

Files: `src/draft-store.ts`, `src/components/DraftComposer.tsx`, `src/App.tsx`, `src/components/SideConversation.tsx`, `src/components/AskConversation.tsx`, `src/hooks/useAskConversations.ts` in Lab.

Interface: `DraftStore.get(key): string`, `set(key, text): void`, `subscribe(key, listener): () => void`; component binding `{ store, key }` is passed to the leaf composer. Keep controlled composer props available.

- [x] Add a real App input regression that counts timeline text reads and verifies entered draft restoration.
- [x] Run the regression against the unchanged implementation; verify input still traverses history.
- [x] Move Main/Side and Ask text persistence into keyed stores. Subscribe only in composer leaves and the opening Ask textarea. Preserve Ask clean snapshot guards.
- [x] Run App, Side, composer, and recovery tests; verify session switching and late completion.

## Task 2: Scroll work

Files: web `src/react/useTimelineScroll.ts`, new `timeline-entry-index.ts`, and hook tests; Lab `LabWorkbench.tsx`.

Interface: entry index `refresh(viewport)`, `get(key)`, `at(top)`; scroll hook accepts an optional content revision while retaining existing callers.

- [x] Add geometry-count regression for 1,000 entries, large jumps, and unchanged-content renders.
- [x] Verify old code exceeds the bound.
- [x] Cache ordered elements/key lookup, use local checks then binary search, and invalidate on structure changes. Preserve synchronous before-paint corrections and existing text anchors.
- [x] Separate the timeline pane from composer state and pass explicit content invalidation.
- [x] Run scroll unit tests and Markdown reading browser scenarios.

## Task 3: Persistence scheduling

Files: web `src/react/useImageDraft.ts`, `src/image-drafts.ts`, their tests.

Interface: keep `readImageDraft`/`writeImageDraft`; schedule dirty metadata after a fixed 250 ms window, one write per draft in flight, immediate image/clear boundaries.

- [x] Add timer tests for batching, continuous edits, unmount flush, and failed-write retry.
- [x] Verify old code writes once per key.
- [x] Implement bounded scheduling and shared database connection with close/versionchange recovery.
- [x] Run image draft, composer pending, storage failure, and upload tests.

## Task 4: Bounded retention and image bytes

Files: Lab `replica-cache.ts`, App and conversation hooks; web `image-drafts.ts` and image-draft lifecycle.

Interface: replica cache acquire/release ownership, peek, and trim; pin pending/uncertain operations. Initial soft limits: six inactive replicas, 24 MiB estimated replica payload, 32 MiB evictable image blobs.

- [x] Add cache tests for LRU, protected operations, and reopening; add metadata-only byte-write regression.
- [x] Implement image metadata/byte separation with durable backwards reading, scope cleanup, and portable binary image storage. Test upgrade/rollback constraints before accepting schema changes.
- [x] Implement cache integration with explicit mounted/operation ownership; keep drafts and reading positions independent.
- [x] Exercise fifty-session retention and draft/send protection. Document any correctness-driven departures from soft budgets.

## Task 5: Idle work and entry loading

Files: Lab `hooks/useRemoteHosts.ts`, `components/AgentActivityStatus.tsx`, `main.tsx` and focused tests.

- [x] Test hidden clock pause and host poll cadence transitions.
- [x] Share a visible clock, poll 5 seconds for discovery and 30 seconds otherwise, refresh on reveal/foreground.
- [x] Lazy-load App behind authentication without changing standalone behavior.
- [x] Build and inspect entry chunks; run authentication and host tests.

## Task 6: Performance and final verification

- [x] Preserve production fixture and measurement tooling under Lab performance tests; compare five-run medians at 100/500/1,000 entries.
- [x] Verify no geometry reads for fixed-height typing and at least 60% reduction in 1,000-entry typing task time; report actual results.
- [x] Run relevant web/Lab unit suites, real-transport pending-send/browser tests, typecheck, build, compatibility update/check.
- [x] Review the diff for recovery races, stale callbacks, and scope cleanup. Record validation limits including unavailable real iPhone hardware.
- [x] Commit reviewed changes locally and report evidence and outstanding limitations.

## Completion evidence and release boundaries

See `packages/agent-remote-lab/performance/README.md` and the checked-in raw results for measured gains and verification. The 1,000/100-entry ratio was 1.60 against the aspirational 1.50 target. No virtualization or history truncation was added.

Entry indexing retains synchronous scroll capture instead of adding a delayed frame; real reading-position regression tests pass. New image records use ArrayBuffer bytes directly because a WebKit Blob preparation failure could leave the multi-store write unfinished. Conversion is memoized per Blob and caption changes write only metadata.

This is a local implementation delivery. Real iPhone standalone keyboard/suspension and battery measurements are not available. The native Codex host-process test requires `BORGEE_CODEX_TEST_EXECUTABLE` and was not run successfully; no native services were restarted. Deployment must retain the version-2 storage reader for rollback; an old version-1-only bundle is not a safe rollback target.
