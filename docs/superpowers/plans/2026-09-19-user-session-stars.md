# User session stars implementation plan

**Goal:** Replace the visible opened-session history with deliberate, user-owned stars and a mobile title switcher.

**Architecture:** Gateway remains the identity authority. Relay stores stars per authenticated subject with native session identity, independent of transient Agent bindings. Browser history remains internal recovery state. Standalone workbenches remain account-free.

**UX:** Show the Gateway account name in the account controls, falling back to its user ID when using an older Gateway. Show Favorites above discovery, with explicit star buttons on sessions and the active conversation. On mobile, the current title opens a compact favorites list. Stars do not indicate readiness. Failed saves remain visible and retryable; unavailable favorites can still be removed. Do not automatically favorite old history.

**Tracking:** Favorites offer Track / Untrack. Selected native identities persist in localStorage under the authenticated namespace on this browser. A separate floating menu observes only selected sessions through an explicit activity-only negotiation on the public protocol, clears stale activity on disconnect, and badges live transitions. Initial hydration is not a change. Untracking closes the observation, never the native session or favorite. Logout and account changes dispose observers.

## Implementation and acceptance

- [x] Extend Gateway renewal with a minimal profile (name and optional email); retain service-proof authorization and exclude credentials. Verify with real SQLite route tests.
- [x] Add bounded Relay stars under authenticated user routes. Test identity validation, idempotence, ownership, denied cross-user requests, concurrent persistence, and unavailable removal. Add SQLite records without rewriting existing tables.
- [x] Verify stars survive a real workerd restart and are shared by two browser logins for the same user, while another user's stars remain separate.
- [x] Add a typed browser client and hook with cancellation, per-user state, visible failure, refresh on page resume, and no optimistic success for unconfirmed writes.
- [x] Remove the visible Opened section; keep navigation/recovery internals. Add Favorites list, star controls, and a focus-managed mobile title disclosure, preserving side-session navigation and drafts.
- [x] Run desktop/mobile browser scenarios for star, switch, remove, persisted reload, failed save, account display, keyboard dismissal, and narrow viewport overflow. Build before browser tests.
- [x] Run affected regressions, typecheck/build, compatibility:update, compatibility:check, and inspect screenshots. Keep both repositories in isolated worktrees; do not deploy this feature without a new release request.

## Validation notes

Favorites use authenticated Relay snapshots and a dedicated SQLite table. Workerd restart and shared-access revocation tests cover persistence and isolation. Activity-only subscriptions have strict schema coverage, real WebSocket delivery tests, reconnect tests, and no full-content fallback. UI fixtures exercise account-scoped favorites and local tracking in desktop and mobile browsers.

The native Codex process test requires its explicitly configured executable. Existing Node Relay advisory-lock tests require `/usr/bin/python3`, which is currently blocked by the machine's unaccepted Xcode license. These environment-dependent checks are not counted as passing. No production services, credentials, or main checkouts were changed.
