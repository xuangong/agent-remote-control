# Session Attributions Implementation Plan

> **For agentic workers:** Implement the independently reviewable parts below in the dedicated session-attributions worktree. Keep presentation, projection and navigation responsibilities separate.

**Goal:** Expose session relationships through a public description and a compact expandable title property table.

**Architecture:** The browser package owns framework-neutral description types and a reusable React renderer. The product projects its existing relationship records and resolves navigation through its existing Window composition. No new relationship persistence, native provider behavior or wire fields are introduced.

**Tech Stack:** TypeScript, React, Vitest, Playwright, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-16-session-attributions-design.md`

## Global constraints

- Source, comments and documentation are English; user communication is Chinese.
- Changes stay in `.worktrees/session-attributions`.
- Relationship truth stays in each existing owning module.
- The title defaults to the existing compact presentation. Expanded attributions form a borderless table in normal document flow, never a popup.
- Disclosure state belongs to a rendered view, not the shared session or Window protocol.
- The implementation stage excluded deployment and release actions. The subsequent user request authorizes committing, integrating into local main and deploying the website; no package publication or Controller update is needed.
- Every test command has per-test and outer process deadlines.

## Task 1: Description and product projections

Files: `agent-remote-web/src/session-description.ts`, `headless.ts`; `agent-remote-lab/src/session-description.ts` and its test.

The public contract exposes `SessionDescriptionIdentity`, `SessionAttributionTarget`, `SessionAttribution`, and `SessionDescription`. A row contains `id`, `kind`, `label`, `value`, optional `detail`, and optional `target`. Session targets contain `kind: 'session'` and the full session identity. Group targets contain `kind: 'group'`, `groupType`, and `groupId`.

`describeSession({ session, sessions, forks, asks, tpmWorks, teams })` projects existing records, including native parent metadata from known session entries. It returns a public description. All collection inputs are optional. It never queries, mutates or infers relationships from Window layout.

- [x] Write behavior tests for host-specific identity, Ask/source changes, TPM current main, Team roles, parent evidence and multiple relationships.
- [x] Implement the public contract and pure product projection.
- [x] Verify the projection cases and review semantic boundaries.

## Task 2: Reusable disclosure and property table

Files: `agent-remote-web/src/react/SessionAttributions.tsx`, its test, `react.ts`, `styles.css`; `agent-remote-lab/src/components/SessionWorkbench.tsx`.

`SessionAttributions` consumes `description?: SessionDescription`, `onNavigate?(attribution: SessionAttribution): void | Promise<void>` and a render child receiving `{ toggle, details }`. It owns only local disclosure/navigation-feedback state. The containing heading chooses placement. SessionWorkbench accepts these same optional description/navigation props and hosts the component in inline and toolbar variants.

- [x] Test default collapse, explicit toggle, independent instances, unknown kinds, target navigation, failed navigation and target updates.
- [x] Implement accessible disclosure, semantic table, constrained wrapping and restrained styling.
- [x] Integrate with the standard workbench without remounting its timeline/composer.

## Task 3: Product wiring and container navigation

Files: product description context, `LabWorkbench.tsx`, `SessionFamily.tsx`, `TpmWorkspace.tsx`, `App.tsx`, and navigation tests.

- [x] Provide the description resolver using existing directory, Ask/Side stores, TPM works and Team roster.
- [x] Pass the displayed identity even before native attachment succeeds; preserve standalone optional use.
- [x] Resolve session targets by exact binding: focus existing pane, otherwise create/present according to current viewport. Keep unrelated docks.
- [x] Give TPM's existing shell heading the same attribution component, replacing its duplicate Main-only presentation once a native identity exists; retain Main on an uncreated work shell.
- [x] Verify all ordinary and composed Session View paths, including toolbar/mobile and Team sessions opened from the directory.

## Task 4: Review and validation

- [x] Run focused regression tests with process deadlines and relevant type checks.
- [ ] Inspect desktop and narrow browser-rendered states, long names, multiple panes and collapsed layout stability. Browser startup is blocked in this environment; the DOM integration and responsive paths are covered by tests.
- [x] Review the whole diff against the spec; address material findings.
- [x] Run `pnpm compatibility:update`, then `pnpm compatibility:check`.
- [x] Record verification evidence and remaining limitations in the delivery response.

## Verification notes

- Public renderer: 7 tests passed. Projection, navigation, Team menu, standard workbench, docking and TPM focus suite: 71 tests passed.
- App attribution integration: 5 tests passed, covering existing target selection, a new dock, Team menu reveal, offline narrow-screen cache navigation and local completion while saving is pending.
- The pending-save regression failed before the navigation fix and passed afterward; the real Window store applies locally while its commit remains held.
- Lab and Debugger type checks passed. Public Web and final Lab production builds passed.
- Compatibility was regenerated and verified: `sha256:98f67c09681420a88a22097cdf27c7cfe4e01c49b2c41fcfdc9d876a114e6795`.
- Existing `App.children.test.tsx` has 5 Ask failures on unchanged `main@b5ddaf9` as well (27 pass, 5 fail); these are outside this change. Other checked App, Window, SessionFamily and Side regressions passed.
- Browser verification did not reach the page: Chromium failed at MachPortRendezvous startup and WebKit aborted at launch. CUA/DevTools had no available surface. The desktop/mobile Playwright scenario is included but remains unverified in a live browser.
- No Provider, Host runtime or wire-protocol change. The implementation verification above predates the separate commit and website deployment request.
