# Side conversation tree and stacked windows

## Design

The existing browser-local fork ledger supplies parent-to-child edges. A session can have multiple independent sides, and each side can have children. Native Provider lineage and the public protocol remain unchanged.

The workbench keeps one selected child per session. Following those selections from the main conversation produces the visible path. Choosing a sibling restores that sibling's previously selected descendants. Closing a side hides its incoming edge; it does not delete the edge, clear descendant choices, or stop native work.

Desktop shows two expanded conversations by default. Older ancestors collapse into bounded rails on the left. Expanding an ancestor shifts the visible pair without discarding descendants; later descendants remain accessible on the right. Compact layouts show one conversation with the same branch navigation. Each window lists its direct sides, labels them by their initial question when available, and marks the selected side.

Visited side views stay mounted while hidden, preserving connection state, scroll position, question drafts and composer drafts. The existing fork ledger persists the tree; selected paths and view focus are local to the current mounted workbench. A reload can reopen any saved fork through its parent.

## Implementation

- Add a pure selected-path model with identity, cycle, sibling-switch and close behavior tests.
- Replace the single side slot with cached session views and per-parent selections.
- Add collapsed window rails, focus restoration and selected-child markers.
- Exercise nested forks, sibling paths, draft retention, closing/reopening, and narrow layouts through the real browser/Relay fixture.
- Run Lab typecheck/tests, focused browser tests and compatibility update/check; review the live console layout.

## Verification

The original nested-side browser case failed because the single side slot replaced the prior window. The implemented selected-path model passes the nested/sibling route cases on desktop and mobile, including independent drafts, close/reopen, focus, page width, and out-of-order attachment responses. The affected browser suites passed 17 tests with one desktop-only scenario skipped on mobile. Lab build and typecheck passed. The Lab suite passed 260 tests with 6 skips using its required pinned Codex executable and Node webstorage setting. Compatibility metadata was regenerated and checked before the local commit. The existing test console at port 6177 serves the updated source; native Hosts were kept running.
