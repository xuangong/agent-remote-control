# Local-first Window updates

Window layout changes must render immediately. Remote persistence and subscription recovery run in the background; neither owns the lifetime or authority of native sessions.

## Boundaries

- `WindowWorkspaceStore` owns a confirmed snapshot and pending local operations. Its visible snapshot overlays local intent on confirmed state. Remote revisions and receipt identities belong only to persistence.
- Pending operations survive tab reload and Window switching. Network failures retain local intent. Only a definitive rejection removes an operation. Unknown requests keep their original identity; a confirmed revision conflict may be rebased with a new identity.
- Incoming snapshots preserve pending local changes. Full layout replacements retain conflict checks; native target preconditions are not silently removed.
- The product hook owns persistence scope, Window selection and lifetime. Session views consume layout and existing native Session contracts.
- Session connections and replicas remain Session-scoped. Recently presented sessions have a bounded retention owner; closing one view does not retire a connection still in use elsewhere.

## Implementation and validation

1. Add deferred-response behavior tests before changing the store: immediate create/close/selection, remote echo, rebase, rejection, offline edits and receipt recovery.
2. Extract the store from layout import helpers. Add pending-state persistence and background retry; separate rendered revisions from confirmed subscription cursors.
3. Reuse stores across Window selection, restore pending operations before network inspection, and allow cached layout edits while synchronization runs.
4. Remove duplicate UI selection. Preserve stable Session View identities and add bounded Session connection retention.
5. Validate reload and delayed HTTP responses with real transports, run focused UI/connection regressions, build and typecheck, then update and check compatibility metadata.

No package publication, merge, deployment or Controller restart is included in this implementation task.

## Implemented behavior

The browser now uses the store's immediate projection for layout interaction and
the confirmed snapshot for network revisions and shared cache. A page-local journal
restores pending edits for active and inactive Windows. Native session bindings,
capabilities, and execution continue through the existing Session abstractions.

Verification covers deferred saves, refresh, window switches, stale bindings,
receipt recovery, manual recovery from blocked saves, and shared live HTTP/WebSocket
connections. Browser automation was unavailable in this macOS environment; no
manual mobile animation or real-browser latency claim is made from unit tests.
