# Multiple Primary Session Groups in a Window

Status: Implemented and locally verified. Protocol/HTTP, application, and Chromium/WebKit coverage passed. Deployment is a separate release step; these tests do not establish native Provider acceptance.

## Product behavior

A Window is a shared workspace containing multiple primary session groups and independent docked or floating views. A primary group consists of one primary Session View and its attached descendant chain. The primary view ID is the stable group identity. Selecting a different group never replaces or closes the previous group.

The Window records the selected view and the primary group used for family layout and history. Users select a Session View directly; there is no separate primary-group selector. Selecting a primary view or one of its attached views selects that primary group. Focusing an independent dock or float preserves that family metadata, but makes the dock or float the operation target. The selection is shared across pages, as are other Window layout operations.

Favorites, the session list, Track, and New session bind the focused ordinary view, whether it is primary, attached, docked, or floating and whether it is empty or already bound. Managed Ask, Team, and TPM views reject ordinary rebinding. Creation captures the destination view and its binding before the native request; a changed or closed destination never redirects the result. Track retains its remembered composition layout when the destination is a primary view. Other ordinary destinations receive the clicked session without modifying the primary group's Track memory. New session view creates and selects an ordinary empty dock, allowing the user to bind a session through the sidebar. Empty and bound views share selection and layout controls. Every pane can be closed, including the last primary or last pane. Closure removes presentation and explicitly dependent views, never native sessions. Closing the last pane retains the same empty Window without creating a replacement pane or promoting an independent dock.

New Team and New TPM use the session bound to the selected view and show its name before creation. Empty views cannot supply a session source. Pane operations act on the selected view; session operations act on its binding. These are secondary sessions with a persisted business source. Ask and Side initiated inside a Session View use that exact source view. Creation captures the source at invocation; changing selection while it is pending cannot redirect the operation. Rebinding a primary view does not reparent existing Team, TPM, or Ask records. Feature business identity and presentation ownership are separate.

Opening an existing Team selects its leader and gathers missing members only if the same Window still contains that Team leader after selection commits. Feature identity is compared by meaning, so cloned reducer results remain valid.

History links inside an ordinary dock or float replace that same view's binding and history intent. Returning to the current session clears its history intent while preserving primary-group selection and other views.

Wide screens show primary groups side by side, with each group's subagents immediately after its primary view and independent docks after the primary groups. Groups retain their widths and collapsed states. Narrow screens use the foreground Session View as the current selection without another selector; the same shared Window document is used on both screen sizes. Selecting a view must not wait for native attachment or synchronization. Global controls embedded in a view header do not change selection.

## Boundaries and data model

Provider SDK and Remote client remain authoritative for native session state. SessionFamily and Session View render ordinary independently bound conversations. Application adapters provide Ask, Side, Team, TPM, and Handoff actions. Window owns references, selection, and presentation only.

Window schema version 3 has `selectedPrimaryViewId`, `selectedViewId`, and `views`; it removes the single-primary `primaryViewId` and global `mainMinimized` fields. Empty Windows use `views: []` and explicit `null` for both required selection fields. Nonempty Windows require a valid exact selection, and the primary selection is null exactly when no primary exists. Multiple views may have `placement: primary`. Each primary view's existing `collapsed` and `width` fields describe its presentation. `attachedTo` represents the descendant chain; `closeWith` separately describes close dependencies. Neither feature identity nor native session identity is used to infer a primary group.

Closing an unrelated pane preserves exact selection. If the selected pane is removed, selection first falls back to a surviving attached ancestor, then the closest surviving preceding pane in the previous `views` document order, then the next surviving pane, and finally null when empty. This is document order, independent of viewport geometry. The replacement and all its attached ancestors expand, including dock and float ancestors. Explicit selection follows the same expansion rule. Primary selection follows the exact selection's primary ancestry, otherwise retains its surviving previous primary, otherwise uses the first remaining primary or null. The first pane created in an empty Window selects itself. Each batch edit must independently leave a valid state, including a close-last followed by creation.

The existing view operation vocabulary handles creation, selection, closing, ordering, sizing, and collapse. Browser and CLI use the same reducer and queryable settlement. Selecting an attached view resolves its primary ancestor, while selecting an independent view keeps the selected primary unchanged. An explicitly addressed operation never silently falls back to another primary if its target was closed. Delayed directory bindings include an optional `expectedBinding` condition checked by the reducer at commit, including after earlier queued operations. `null` requires an empty view; an object matches Host, Provider, native session, parent native session, and history intent. Titles and role metadata are not operation identity. Unconditional explicit CLI binding remains available when the field is omitted.

The local composition document retains slots, owners, roles, and replay state. One coordinator projects the selected primary group's presentation; all groups keep stable view-to-slot mappings. Each displayed group uses its own SessionFamily binding. Native attachment, drafts, Ask sources, errors, and Handoff gating must not leak across group selection. A background group's settled Handoff is resolved from its own role evidence rather than the selected group's binding.

SessionFamily callbacks register Side sessions independently of previously projected metadata. Repeated callbacks with unchanged runtime data and metadata do not rewrite the composition document.

## Recovery and compatibility

Valid persisted version 1 and 2 Window documents deterministically decode into version 3. Version 1's old primary becomes the selected primary, and its `mainMinimized` value becomes the primary's `collapsed` value. Migration validates the original version's nonempty-primary requirements before accepting the new document. View IDs, Window ID, revision, bindings, manager, and receipts are preserved. Migration does not rewrite operation fingerprints or historical receipts. The native Remote session protocol is unchanged. Older strict Window CLIs need updating before Window operations; a mutation may have committed even if the older CLI cannot decode its version 3 reply. There is no second mutable layout authority.

Local cached documents and import candidates use the same normalization boundary. A legacy session URL without an explicit Window preserves its requested native session and history intent during the first automatic import; history bindings never claim ordinary composition owners. An explicit Window URL keeps the Window selection authoritative. Selection and widths survive reload and back/forward navigation. Late asynchronous work verifies its captured Window, view, and native identity before applying UI effects.

## Validation

- Protocol: multiple primary groups, focused view and family metadata, attached selection, empty Window closure and recreation, deterministic selection fallback, target disappearance, width/collapse isolation, invalid references, v1/v2 normalization.
- Real HTTP: two clients sharing selection and layout, revision conflicts, lost-reply receipt lookup, persisted restart, unchanged historical receipts.
- Composition: independent same-native-session slots and drafts, selection during delayed attach, nonselected Handoff settlement, preserved Ask source and independent docks.
- Browser: two groups with visible conversations, sidebar/Track targeting, Team and TPM source labels, subagent adjacency, foreground view switching on mobile, refresh persistence, group close, no duplicate native observation caused by selection.

No native Provider lifecycle changes, publishing, deployment, or Controller restarts are included in this implementation task.
