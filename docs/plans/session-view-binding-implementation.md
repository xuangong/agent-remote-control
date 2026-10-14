# Session View binding implementation plan

Goal: create an empty ordinary view and select or replace its session through the sidebar.
Spec: [Session View binding](session-view-binding.md).
Execution: inline, using existing React, composition persistence, and connection leases.

## 1. Composition and binding

- [x] Add `CompositionWindow` presentation references to `CompositionDocument`, including optional `slotId`, stable `id`, and managed-group ownership.
- [x] Add `bindCompositionView(document, viewId, slotId)` with required existing destination, absent previous binding, managed-view protection, and main-view support.
- [x] Test empty creation, rebinding without changing native slots/owners, restoration, and preservation of role projections.
- [x] Convert legacy session-window storage once into composition references, preserving explicit legacy IDs and dock/group references.

## 2. Window lifecycle

- [x] Adapt `useSessionWindows` to the shared document and remove its separate persisted native-target records.
- [x] Keep Team open/gather/close grouping; retain independent user views of the same session.
- [x] Add empty rendering and stable placement to `SessionWindow`; key the bound family by reference identity to invalidate old attachments and descendants.
- [x] Retain view display preferences and session-specific drafts when changing targets.

## 3. Interaction

- [x] Add New session view to View options and the dock rail; activate it and reveal the sidebar.
- [x] Store an explicit sidebar target, preserve it through sidebar focus/Host selection, and show it in the sidebar.
- [x] Route only ordinary list/favorite selection through that target; keep Track, Team, main links, and family navigation explicit.
- [x] Support Change session, Close, active indication, width/order persistence, and narrow-screen preservation.

## 4. Verification

- [x] Use bounded Vitest runs for composition/window state and existing succession behavior.
- [x] Use real browser tests for empty creation without attachment, favorites/list binding, rebinding while attaching, close while attaching, reload, independent main navigation, and Team grouping.
- [x] Check cached rendering, useful errors, shared observations, drafts, and independent display preferences.
- [x] Run typecheck/build, compatibility:update, compatibility:check, and diff review. Do not publish or deploy in this implementation task.

## Verification results

- 103 bounded unit tests passed across composition, window binding, succession,
  display cache, and dock behavior.
- 10 focused binding browser cases passed across Chromium and WebKit desktop.
- Existing Team and workspace-layout browser cases passed on both desktop engines;
  mobile Team, navigation, safe-area, and pending-send checks passed as well.
- Pending-send checks now wait for visible disconnection and read both composer
  input implementations; they verify delivery exactly once after reconnect.
- TypeScript checks, the Lab production build, compatibility update/check, and
  whitespace review passed. The main checkout remains clean.
- All provider interaction checks used isolated recorded-provider transports.
  Real provider processes and production services were not changed.
