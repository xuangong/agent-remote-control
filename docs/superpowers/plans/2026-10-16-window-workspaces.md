# Shared Window Workspaces Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to execute the bounded tasks below, with spec and code reviews before integration.

**Goal:** Let users and one authorized Agent session inspect, restore, and manage the same automatically persisted shared Window through the product and Controller CLI.

**Architecture:** A public Window document and pure operations describe presentation only. A site-owned service durably commits documents and operation receipts; browser adapters project them into existing Session Views, while Controller commands use the same HTTP API. Native session content, runtime ownership, and execution continue through existing APIs.

**Tech Stack:** TypeScript, TypeBox, React, Vitest, Playwright, existing Node and Cloudflare hosted persistence.

**Spec:** `docs/superpowers/specs/2026-10-15-window-workspaces-design.md`

## Global Constraints

- Window is the workspace; do not add a Client product, attach/detach lifecycle, or Agent-facing watch command.
- This delivery retains one primary session area for Track/Ask/navigation. Window identity is independent of its primary session. The second stage adds multiple primary session groups within one Window, retaining each group's attachments; do not implement a flat peer layout or multiple primary groups now.
- All pages opening a Window share its layout and selected view; narrow layout never rewrites shared state.
- A Window has one Agent manager at a time; users retain manual control.
- Closing presentation does not stop or archive native work.
- Reuse public session references, succession, cached opening, drafts, and connection reuse.
- Keep source, comments, and documentation English; progress and user reports Chinese.
- Work only in `.worktrees/window-workspaces`; preserve main, running services, and other worktrees.
- Per-test and outer process deadlines apply. No production operations, publication, push, or Controller installation in this task.

## Shared interfaces

Public schema: `packages/agent-remote-protocol/src/window-workspace.ts`.

```ts
interface WindowSessionBinding {
  hostId: string; providerId: string; nativeSessionId: string; title: string;
  parentNativeSessionId?: string;
  role?: { controllerId: string; roleId: string; revision: number };
}
interface WindowView {
  id: string; binding?: WindowSessionBinding;
  bindingPolicy?: 'replaceable' | 'managed';
  attachedTo?: string; closeWith?: string;
  feature?: { kind: string; id: string; metadata?: Record<string, string> };
  placement: 'primary' | 'dock' | 'float' | 'attached';
  width: number; collapsed: boolean;
  display: { mode: 'preview' | 'simple' | 'content'; lettersVisible: boolean };
  geometry?: { x: number; y: number; width: number; height: number };
}
interface WorkspaceWindow {
  schemaVersion: 1; id: string; title: string; revision: number;
  primaryViewId: string; selectedViewId: string; mainMinimized: boolean;
  views: WindowView[];
}
interface WindowMutation {
  operationId: string; issuedAt: number; baseRevision: number;
  operation: WindowOperation;
}
interface WindowOperationResult {
  operationId: string; status: 'committed' | 'rejected';
  revision: number; committedAt: number; expiresAt: number;
  code?: string; message?: string;
}
```

Operations are explicit setters: `rename`, `view.create`, `view.bind`, `view.close`,
`view.select`, `view.move`, `view.resize`, `view.place`, `view.collapse`,
`view.display`, `view.geometry`, `main.minimize`, `layout.apply`, and `batch`.
Exact properties live in the schema; all consumers import it instead of redefining it.
Feature associations are bounded application metadata. The layout reducer uses
explicit binding policy and structural relationships, never a feature name.

HTTP API:

- `GET /v1/windows`: `{ windows: WorkspaceWindow[] }`.
- `POST /v1/windows`: `{ operationId, issuedAt, window }` creates a caller-named document.
- `GET /v1/windows/:id`: `{ window, manager?: { session, generation } }`.
- `POST /v1/windows/:id/operations`: `WindowMutation` returns `{ result, window? }`.
- `GET /v1/windows/:id/operations/:operationId`: `{ result }`, with explicit unknown/expired errors.
- `DELETE /v1/windows/:id`: mutation envelope with `operation: { type: 'delete' }`.
- `POST /v1/windows/:id/manager`: user-authorized `{ session: WindowSessionBinding | null }`;
  assignment returns a Window-scoped grant, replacement/revoke invalidates the old grant.
- `GET /v1/windows/:id/changes?afterRevision=N`: bounded long-poll for internal page
  synchronization; returns latest snapshot or unchanged revision, including reconnect recovery.

Mutation responses include the current Window when it still exists. Replayed
receipts can accompany a snapshot newer than their committed revision; deleted
Windows retain receipts without a document snapshot.

Grant credentials are supplied from a private JSON file or environment, never URL
parameters. The grant identifies a verified assignment to a session; self-reported
session IDs and Host pairing credentials are not sufficient authorization. An existing
Window grant cannot create unrelated Windows or reassign its own manager.

## Task 1: Public document and pure operations

**Files:** create `window-workspace.ts`, `window-workspace-operations.ts`, their tests;
export from protocol `index.ts`.

**Produces:** strict validators `isWorkspaceWindow`, `isWindowMutation`,
`isWindowOperationResult`; `applyWindowOperation(window, operation): WorkspaceWindow`;
`createWindowView(id, binding?, placement?): WindowView`.

- [x] Write behavior tests for stable IDs, empty binding, attached groups, invalid
  cycles, main replacement preserving docks, atomic batches, export validation,
  and explicit per-view display/geometry.
- [x] Run focused tests with a 120-second outer deadline and 10-second test deadline;
  validate the exported contract.
- [x] Implement strict schemas and invariants; ensure failed transitions leave the
  source document unchanged and revisions advance once per committed operation.
- [x] Run tests and protocol typecheck; review the interface before downstream work.

Example invariant:
```ts
const before = structuredClone(window);
expect(() => applyWindowOperation(window, { type: 'view.move', viewId: child.id, afterId: dock.id })).toThrow();
expect(window).toEqual(before);
```

## Task 2: Shared durable service and transport

**Files:** create hosted `window-workspaces.ts`, `window-routes.ts`, tests; update
`state.ts`, `record-codec.ts`, `gateway.ts`, exports and Cloudflare storage tests.

**Consumes:** Task 1 schemas/operations and existing `RelayState.mutate`.
**Produces:** account-partitioned service, authenticated HTTP routes above, scoped
management grants, atomic document+receipt commits, bounded internal change waiters.

- [x] Write real HTTP tests for two users, two pages, revision conflicts, duplicate
  requests, mismatched operation reuse, lost response recovery, deletion, restart,
  assignment/replacement/revocation, and authorization at long-poll completion.
- [x] Store hashes of scoped grants, never plaintext grants; enforce access for all
  session references at creation/binding/apply and reject authority escalation.
- [x] Persist receipts with state, bound retention to 24 hours, reject expired
  issuedAt values rather than replaying unknown old operations. Keep deletion
  receipts sufficient to resolve repeated delete and avoid identity resurrection.
- [x] Make long-poll cancelable and bounded; on service teardown release waiters.
- [x] Round-trip Window state and receipts through Node and Cloudflare storage codecs.
- [x] Run focused service/HTTP tests and existing authentication/storage regressions.

## Task 3: Browser projection and all layout writers

**Files:** create web `client/window-client.ts` and tests; Lab `window-workspace.ts`,
`hooks/useWindowWorkspace.ts`, `components/WindowWorkspaces.tsx`, tests. Modify
`App.tsx`, `useSessionWindows`, `useSessionSuccession`, `SessionDock`, `SessionFamily`,
Ask/TPM placement and display-preference integration, controller location parsing.

**Consumes:** shared schemas, HTTP API, existing session resolvers/connection pool.
**Produces:** `WindowWorkspaceClient`; a shared Window store with serialized local
operations and snapshot recovery; controlled renderer seams and a Window selector.

- [x] Test snapshot projection without native connections and cached first render.
- [x] Add Window list/create/open/share/delete and manager assignment controls.
- [x] One-time import current composition, dock, Ask, TPM, family, and display
  presentation into a distinct Window; keep local drafts outside the document.
- [x] Replace shared-mode layout setters with explicit operations. Preserve local
  pointer previews, committing dimensions on gesture completion. Add no DOM-focus
  feedback loop between pages.
- [x] Project remote snapshots into stable mounted views. Keep empty placeholders,
  offline sessions, feature references, selected view, and native-role succession.
- [x] Team presets always produce the same full layout, irrespective of screen width.
- [x] Keep legacy/standalone embedding functional via the same local model adapter,
  without hosted account dependencies. Legacy storage is import-only after adoption.
- [x] Test all navigation sources and ensure stale cache cannot overwrite a remote revision.

## Task 4: Controller commands and operating guide

**Files:** create `packages/agent-host/src/window-command.ts`, tests; update `cli.ts`
and Controller package builds if required; create `docs/guides/window-agent-operations.md`.

**Consumes:** public schemas and Window HTTP API; `--grant-file` JSON containing
`{ serverUrl, windowId, token }` or explicit environment configuration.
**Produces:** the operating guide's Window/View subcommands, JSON output, exit
codes, bounded request deadlines and operation lookup for uncertain results.
Window creation remains in the website; CLI `view create` uses an existing grant.

- [x] Test built/real HTTP CLI calls for inspect, view create/bind/move/resize/select,
  full-layout export/apply, unknown outcomes, permission denial, and malformed input.
- [x] Generate stable operation IDs and issuedAt once; never blindly retry a new mutation.
- [x] Validate returned identities and result envelopes. Do not print grant secrets.
- [x] Document the Agent loop: inspect, act, confirm, query on uncertainty, re-read
  after conflict. Clarify assignment scope and native session operations remain separate.

## Task 5: Integration, review and compatibility

**Files:** add Lab E2E Window fixture/specs and Cloudflare tests; update current
architecture docs, README command links, compatibility metadata/fixtures as needed.

- [x] Real transport: CLI changes a Window opened in two pages; both converge.
- [x] Chromium and WebKit: desktop rail + narrow selected view; shared selection,
  empty binding, child grouping, floating/docking, resizing, main replacement.
- [x] Reload/close/reopen preserves layout; offline Host does not block inspection.
- [x] Native-session controls and draft/connection continuity regressions remain green.
- [x] Review each task and whole branch for competing authorities, stale operations,
  credential leakage, orphaned feature state, and re-mount regressions.
- [x] Run required typechecks/builds, `pnpm compatibility:update`,
  `pnpm compatibility:check`, and `git diff --check`.
- [x] Report verified scope and remaining limitations; do not merge/deploy/push until requested.


## Completed first-stage verification

Implementation and local integration verification are complete. The delivery
still retains one primary session group; multiple primary groups are the next
stage. No commit, merge, push, deployment, package publication, or installed
Controller update was performed in this task.

| Gate | Result |
| --- | --- |
| Lab suite excluding the explicitly configured native Codex process test | 175 files passed; 1675 tests passed, 6 existing skips |
| Chromium and WebKit shared Window E2E | 4 passed |
| Protocol Window contract | 14 passed |
| Hosted Window service and controller-location | 37 passed |
| Hosted authentication and storage regressions | 63 passed |
| Cloudflare SQLite persistence | 3 passed |
| Web client operation settlement | 19 passed |
| Controller Window CLI over HTTP | 5 passed |
| Final compatibility-dependent Lab regression | 67 passed |
| Website, Controller, Cloudflare and their dependency builds | Passed |
| Six affected package typechecks, including Lab E2E | Passed |
| Compatibility update/check and whitespace check | Passed |

The browser tests use a real loopback hosted service, Host uplink, a recorded
Provider, two authenticated pages, and the Controller command implementation.
They verify shared browser/CLI edits, empty-view binding, resize, primary
replacement preserving docks, attached-child selection on narrow screens, and
Ask creation/restore across different local source owners without duplicate native
creation. They are not production or real native Provider acceptance.

The first complete Lab run caught an Ask explicit-recipient forwarding regression;
the fix preserves the root recipient guard without inheriting it into child views.
The final Lab suite passes. The native Codex process test was excluded because
`BORGEE_CODEX_TEST_EXECUTABLE` was not configured. No native process was upgraded
or restarted for this validation. The final E2E-only fixture change was followed
by another typecheck, all four browser cases, compatibility update/check, and all
67 compatibility-dependent Lab cases; production source was unchanged afterward.

## Task 6: Default Window

Approved follow-up: opening the product should not require explicit Window
management. Automatically create an ordinary Window when none is selected;
use the same durable service and shared operations throughout. Changes persist
when committed. No temporary/saved state or save command is needed.

- [x] Remove the unused retention/save extension from protocol, clients, UI, fixtures, and documentation.
- [x] Create ordinary Windows by default and reuse the current identity after refresh.
- [x] Keep the chooser current after rename and permit returning to other Windows.
- [x] Recover an empty ordinary Window after confirmed current deletion without overriding a newer selection or replaying unknown outcomes.
- [x] Verify refresh, two-page updates, drafts/owners, and no duplicate native creation.
- [x] Review, run focused protocol/service/client/CLI/UI tests and builds, then refresh/check compatibility.

Interface review: no new public lifecycle contract is required. The existing
service list/receipt/long-poll APIs and common Window document serve all paths.
Default creation is a product-shell responsibility; the reusable Window and
Session View layers remain independent of how the page chooses its first Window.
Pending creation requests retain their original fingerprints.

### Default Window verification

The ordinary-Window follow-up passed the full Lab suite: 175 files, 1691 tests,
and 6 existing skipped tests. The native Codex process test still requires an
explicit executable and was excluded. Chromium and WebKit passed all four
real-transport cases, including refresh with independent drafts, shared rename,
confirmed deletion yielding empty replacement Windows, and no duplicate native
session creation. The only final E2E fixture correction reopened View options
after its normal blur dismissal; all behavior assertions were retained.

Protocol (14), hosted service (10), client (19), Controller CLI (6), and
Cloudflare SQLite (3) focused tests passed. Final dependency/Lab builds,
affected typechecks, the compatibility-dependent Lab regression (67), and
whitespace checks passed. Final compatibility digest:
`sha256:79e68c2b65472cccbae4286d9c9b769135d4bf7b7ac0f613716b23f8aa97da90`.

Release verification also corrected an image-draft test's React scheduling:
each readiness poll flushes pending updates before inspecting the button,
instead of waiting for the DOM inside the outer `act`. The original one-second
poll deadline and all image/ACK/rejection assertions remain unchanged. All 1691
Lab tests passed afterward; production behavior was unchanged by this correction.

Cached layouts remain visible before hosted inspection. Only confirmed stores
start deletion recovery; explicit missing links remain errors. Replacement
does not replay an unresolved creation or override later navigation, and late
results after unmount cannot change the selected Window.

No commit, merge, push, deployment, package publication, or Controller installation
was performed.
