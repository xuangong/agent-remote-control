# Window Primary Groups Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax for progress.

**Goal:** Allow multiple primary session groups to coexist in a shared Window with an explicit operation target.

**Architecture:** Primary root View IDs identify groups; attached chains remain ordinary Session Views. Window authority owns selection and layout, while one composition coordinator and independently bound SessionFamily instances preserve native and feature boundaries.

**Tech Stack:** TypeScript, TypeBox, React, Vitest, Playwright, existing hosted HTTP/SQLite state and Controller CLI.

**Spec:** `docs/superpowers/specs/2026-10-16-window-primary-groups-design.md`

## Global Constraints

- English code, comments, and documentation; Chinese user communication.
- All changes remain in `.worktrees/window-workspaces` on `feat/window-primary-groups`.
- Preserve running services and native sessions. Publishing, pushing, deployment, and restarts require separate user authorization.
- Tests use per-test and outer process deadlines.
- Run compatibility update and check after reviewed implementation.

## Task 1: Shared contract, persistence, and CLI

Files: protocol `window-workspace.ts`, `window-workspace-operations.ts`, exports and tests; hosted Window/state/record codec and HTTP tests; web Window client; Controller `window-command.ts` and tests.

Interfaces: `WorkspaceWindow` v2 with `selectedPrimaryViewId`; `primaryWindowViews(window)` and `windowPrimaryViewId(window, viewId)` helpers; normalization of persisted v1 documents. Existing `applyWindowOperation` and operation receipts remain the single mutation path.

- [x] Add behavior tests that create primary B alongside A, select B's child, focus a dock without changing B, then close A while preserving the dock.
- [x] Implement v2 schema and deterministic v1 decode; test that original receipts and request fingerprints remain unchanged.
- [x] Extend existing explicit CLI view operations to primary creation/selection and per-view collapse.
- [x] Verify real HTTP sharing, persistence reload, and operation settlement with bounded test runs.
- [x] Add conditional `view.bind.expectedBinding` for delayed results, with atomic identity checks and real HTTP queue/receipt coverage.

Verification note: No retained baseline-red evidence is available for the original one-primary contract tests. The final behavior and later guarded-binding regressions are verified below; the initial red run is not claimed.

## Task 2: Composition and native presentation coordination

Files: Lab `window-composition.ts`, `hooks/useWindowSessionBridge.ts`, `hooks/useSessionSuccession.ts`, related composition tests.

Interfaces: retain `openPrimary(...)`, capturing the selected root at invocation; project the selected group's local presentation without deleting other mappings. Native settlement validates the operation's source role even when another group is selected.

- [x] Add tests for A/B slot ownership, delayed A attach after selecting B, and A Handoff settlement while B is displayed.
- [x] Scope adoption/history/projection keys to Window and root identity; keep one coordinator.
- [x] Preserve exact Ask source ownership for duplicate native sessions.
- [x] Run composition, bridge, and succession suites.
- [x] Keep shared child attachment in SessionFamily while preserving standalone coordinator restoration; verify failed explicit attachment and access replay behavior.
- [x] Register shared Side sessions even when metadata already exists, and skip persistence only when both runtime registration and metadata are unchanged.

Verification note: No retained baseline-red evidence is available for the initial composition tests. Final composition coverage and the later regression checks are recorded below.

## Task 3: Reusable primary-group rendering

Files: Lab `components/SessionFamily.tsx`, `components/SessionDock.tsx`, new primary-group controls and CSS, component tests.

Interfaces: each primary group provides stable ID, title, width, collapsed, selected, and content to the horizontal rail. SessionFamily exposes a presentation callback and footer callback with the exact session, slot, state, and operations; application features stay outside the carrier.

- [x] Add tests for stable mounts across selection, independent resize/collapse, and compact group selection.
- [x] Render primary groups in order before independent docks; retain subagent adjacency.
- [x] Add selected markers, new empty primary, select, and close controls, including an explicit disabled last-primary close.
- [x] Expose composition-safe SessionFamily presentation extension points for the application.
- [x] Verify component behavior and responsive layout.

## Task 4: Application navigation and feature sources

Files: Lab `App.tsx`, `hooks/useSessionWindows.ts`, `hooks/useWindowWorkspace.ts`, `window-workspace.ts`, feature hooks and Team/TPM menus, integration tests.

- [x] Add observable tests for Favorites, the session list, and New session targeting the focused ordinary view, and exact source labels for Team/TPM.
- [x] Normalize local cached/imported Windows to v2 and retire one-primary assumptions.
- [x] Preserve explicit legacy history intent during the first automatic Window import, without reusing ordinary draft owners or overriding an explicitly chosen Window.
- [x] Keep retained asynchronous Window readers current after selection changes and return no target on an unavailable route.
- [x] Fence delayed selection of an existing Team leader to its original Window, while allowing same-Window feature clones to gather missing members.
- [x] Open predecessor history and return to current through the captured ordinary dock or float, preserving the primary binding and selection.
- [x] Render all shared primary groups through stable SessionFamily components, preserving full composer, Ask/Side, share, title, Handoff, and history behavior.
- [x] Capture source identity and source view on feature creation; avoid native-ID first-match source inference.
- [x] Use one captured ordinary-view destination for Favorites, the session list, and New session; reject managed views and never redirect a delayed result after its destination changes or closes.
- [x] Aggregate connection retention and tracking across all mounted primary groups.

## Task 5: Integration, review, and verification

- [x] Run relevant unit and type checks; fix contract fixtures.
- [x] Run desktop/mobile browser scenarios against isolated local services on free ports.
- [x] Review protocol, state ownership, native settlement, and feature source isolation across the full diff.
- [x] Run `pnpm compatibility:update` and `pnpm compatibility:check`.
- [x] Record exact passed tests and any unverified production boundary before reporting completion.

## Focused verification record

This record covers bounded focused runs during implementation. Final verification is recorded separately below. Counts from overlapping runs are not additive. The original baseline-red runs noted above have no retained evidence and are not retroactive success claims.

- Protocol Window suite: 26 passed, including guarded binding identity and atomic rejection.
- Lab Window store, real HTTP binding queue, bridge, and shared succession suites: 41 passed. The queue and bridge guards failed before the reducer condition was implemented; both empty and bound destinations now retain the earlier committed binding, and rejected requests retain their original queryable receipt.
- Hosted Window HTTP suite: 13 passed; Controller Window command suite: 7 passed after the conditional binding addition.
- Window hook/store suites after legacy history import correction: 57 passed. Both same-root and Side history imports failed before the correction; an explicitly addressed Window remains authoritative. Four App history/prompt-edit cases passed with attachment, draft-owner, and intent assertions retained. The Lab TypeScript check passed after these changes.
- Window hook/store, real HTTP binding queue, and bridge suites after the current-Window reader correction: 79 passed. A retained callback failed before the correction by reading the prior Window; it now follows the current Window, including switching back and entering an unavailable route.
- Shared succession and App Team action suites: 13 passed. Side registration with existing metadata remains observable; identical callbacks do not save or increment the edit revision, while changed titles persist. Removing the Team post-selection guard made the destination Window gain two unwanted Team views; replacing semantic feature matching with object-reference matching rejected a valid same-Window gather. Both mutations were restored before the final passing run.
- Ordinary dock and float history navigation: both actual predecessor-link and return-link cases passed with real Window hooks, store, and reducer; only the already-verified history-navigation projection was supplied by a spy. Restoring the previous primary-only callback made both cases fail without changing their binding. The corrected path changes only the addressed view and its history intent.
- Existing physical hosted migration: 12 passed; Cloudflare codec handling: 3 passed; cached/imported Window plumbing: 71 passed.
- Team and TPM source suites: 48 passed. These establish feature source capture; App-level asynchronous presentation settlement is reviewed separately.
- Four primary-group and family component suites: 28 passed, followed by a focused Family heading-focus regression. Stable composer identity, history marking, and initial disconnected rendering have focused coverage.
- Browser: 14 passed across Chromium and WebKit for seven scenarios, including independent primary drafts, mobile attached views, ordinary dock creation destination capture, and directory rebinding. The browser suite does not cover every Favorites-by-placement combination; ordinary dock Ask and history navigation have application/component coverage.
- No production deployment, native Provider lifecycle acceptance, package publishing, or Controller restart is covered by these runs.

## Final verification

The following runs completed the initial implementation before the Track
selection follow-up below.

- All App suites plus SessionDock and SessionWindow: 277 tests passed across 15 files. This includes ordinary-view binding, feature source capture, cross-page title synchronization, mobile focused-view labels, and dock/float history navigation. Log: `/tmp/window-app-complete-final.log`.
- Public Window, composition, and feature modules: 190 tests passed across 15 files, including the real HTTP binding queue, store, bridge, shared succession, Ask, TPM, and Team. Log: `/tmp/window-lab-public-modules-final.log`.
- The final fresh website build passed, followed by 14 Chromium/WebKit browser tests. Logs: `/tmp/window-delivery-build.log` and `/tmp/window-delivery-browser14.log`.
- Workspace typecheck passed across 18 projects; later Lab changes also passed its typecheck and the final fresh build. Log: `/tmp/window-workspace-types-final.log`.
- Tracking: 35 tests passed, including reuse of a retained binding when the open-session list is empty. Web Session View and image suites: 71 tests passed, including the StrictMode image-writer restoration regression.
- Dock reorder tests cover interleaved primary/dock insertion with either primary selected, using keyboard and pointer actions. Ordinary-view Ask and history tests preserve exact view ownership and avoid primary rebinding.
- `pnpm compatibility:update` and `pnpm compatibility:check` passed with digest `sha256:489d92c966d37ab2bd79d21c0e397c4ff5f34ad6be884ceddb6abcee2ab45a13`. Final whitespace validation passed with `git diff --check`.
- Implementation and local verification are complete. Deployment is a separate release step. These runs do not establish production or native Provider acceptance.

## Decisions

- Primary root IDs are the group identity; an additional group ID collection would duplicate already established structure.
- Independent docks retain their lifecycle; Team/TPM business source remains explicit even when their presentation floats or docks.
- Last primary cannot close; this keeps a deterministic selected target without inventing implicit replacement views.

## Track selection follow-up

Track uses the same captured ordinary-view destination as Favorites, the session
list, and New session. A selected primary retains its Track layout restoration;
an attached, docked, floating, or empty view receives the clicked session without
changing another group's Track state. Managed views reject replacement. The
public binding condition remains authoritative when earlier queued edits change
the destination. Slow primary confirmation must retain its pending layout and
resolve the current native connection instead of trusting a persisted runtime ID.

Follow-up verification completed:

- Added nine App navigation regressions for empty/bound dock, attached, and float
  destinations, managed-view rejection, mobile selection, and a real HTTP queued
  binding conflict. The existing unlinked-Side test now explicitly selects the
  primary before navigating and retains its independent-owner assertions.
- Added two primary Track regressions. Both failed before their corrections:
  delayed native confirmation lost the pending Side layout, and persisted
  `agentId` was incorrectly passed as a confirmed attachment. Both now pass.
- All App suites plus SessionDock and SessionWindow: 288 passed across 15 files.
  Log: `/tmp/window-track-final-app.log`.
- Fresh website build and all 16 Chromium/WebKit Window scenarios passed,
  including an actual Favorites-to-Track action followed by opening a session
  into a selected empty dock at 390px. Logs: `/tmp/window-track-final-build.log`
  and `/tmp/window-track-final-browser16.log`.
- Lab typecheck and `git diff --check` passed. Compatibility was regenerated
  and verified with digest
  `sha256:3f018743c7cd85e4382bbb95c285ec0ff61fb170f173d251847ac1234e0bcc53`.
- This verification record excludes deployment, package publishing, and Controller updates.
