# Multiple Primary Session Groups in a Window

Status: Implemented and locally verified. Protocol/HTTP, application, and Chromium/WebKit coverage passed. Deployment is a separate release step; these tests do not establish native Provider acceptance.

## Product behavior

A Window is a shared workspace containing multiple primary session groups and independent docked or floating views. A primary group consists of one primary Session View and its attached descendant chain. The primary view ID is the stable group identity. Selecting a different group never replaces or closes the previous group.

The Window records both the selected primary group and the focused view. Selecting a primary view or one of its attached views selects that primary group. Focusing an independent dock or float leaves the selected primary group unchanged. The selection is shared across pages, as are other Window layout operations.

Favorites, the session list, Track, and New session bind the focused ordinary view, whether it is primary, attached, docked, or floating and whether it is empty or already bound. Managed Ask, Team, and TPM views reject ordinary rebinding. Creation captures the destination view and its binding before the native request; a changed or closed destination never redirects the result. Track retains its remembered composition layout when the destination is a primary view. Other ordinary destinations receive the clicked session without modifying the primary group's Track memory. New primary group creates an empty view, selects it, and allows the user to bind a session through the sidebar. Closing a primary group removes its presentation and attached dependents, never its native sessions. The last primary group cannot be closed; it remains an available operation target.

New Team and New TPM use the selected primary session and show its name before creation. These are secondary sessions with a persisted business source. Ask and Side initiated inside a Session View use that exact source view. Creation captures the source at invocation; changing selection while it is pending cannot redirect the operation. Rebinding a primary view does not reparent existing Team, TPM, or Ask records. Feature business identity and presentation ownership are separate.

Opening an existing Team selects its leader and gathers missing members only if the same Window still contains that Team leader after selection commits. Feature identity is compared by meaning, so cloned reducer results remain valid.

History links inside an ordinary dock or float replace that same view's binding and history intent. Returning to the current session clears its history intent while preserving primary-group selection and other views.

Wide screens show primary groups side by side, with each group's subagents immediately after its primary view and independent docks after the primary groups. Groups retain their widths and collapsed states. Narrow screens expose a primary-group selector and show the selected group's conversation; the same shared Window document is used on both screen sizes. Selecting a group must not wait for native attachment or synchronization.

## Boundaries and data model

Provider SDK and Remote client remain authoritative for native session state. SessionFamily and Session View render ordinary independently bound conversations. Application adapters provide Ask, Side, Team, TPM, and Handoff actions. Window owns references, selection, and presentation only.

Window schema version 2 has `selectedPrimaryViewId`, `selectedViewId`, and `views`; it removes the single-primary `primaryViewId` and global `mainMinimized` fields. Multiple views may have `placement: primary`. Each primary view's existing `collapsed` and `width` fields describe its presentation. `attachedTo` represents the descendant chain; `closeWith` separately describes close dependencies. Neither feature identity nor native session identity is used to infer a primary group.

The existing view operation vocabulary handles creation, selection, closing, ordering, sizing, and collapse. Browser and CLI use the same reducer and queryable settlement. Selecting an attached view resolves its primary ancestor, while selecting an independent view keeps the selected primary unchanged. An explicitly addressed operation never silently falls back to another primary if its target was closed. Delayed directory bindings include an optional `expectedBinding` condition checked by the reducer at commit, including after earlier queued operations. `null` requires an empty view; an object matches Host, Provider, native session, parent native session, and history intent. Titles and role metadata are not operation identity. Unconditional explicit CLI binding remains available when the field is omitted.

The local composition document retains slots, owners, roles, and replay state. One coordinator projects the selected primary group's presentation; all groups keep stable view-to-slot mappings. Each displayed group uses its own SessionFamily binding. Native attachment, drafts, Ask sources, errors, and Handoff gating must not leak across group selection. A background group's settled Handoff is resolved from its own role evidence rather than the selected group's binding.

SessionFamily callbacks register Side sessions independently of previously projected metadata. Repeated callbacks with unchanged runtime data and metadata do not rewrite the composition document.

## Recovery and compatibility

Persisted version 1 Window documents deterministically decode into version 2: the old primary becomes the selected primary, and its `mainMinimized` value becomes the primary's `collapsed` value. View IDs, Window ID, revision, bindings, manager, and receipts are preserved. Migration does not rewrite operation fingerprints or historical receipts. Unsupported new operations on old clients fail explicitly; there is no second mutable layout authority.

Local cached documents and import candidates use the same normalization boundary. A legacy session URL without an explicit Window preserves its requested native session and history intent during the first automatic import; history bindings never claim ordinary composition owners. An explicit Window URL keeps the Window selection authoritative. Selection and widths survive reload and back/forward navigation. Late asynchronous work verifies its captured Window, view, and native identity before applying UI effects.

## Validation

- Protocol: multiple primary groups, separate focus and selection, attached selection, closure, target disappearance, width/collapse isolation, invalid references, v1 normalization.
- Real HTTP: two clients sharing selection and layout, revision conflicts, lost-reply receipt lookup, persisted restart, unchanged historical receipts.
- Composition: independent same-native-session slots and drafts, selection during delayed attach, nonselected Handoff settlement, preserved Ask source and independent docks.
- Browser: two groups with visible conversations, sidebar/Track targeting, Team and TPM source labels, subagent adjacency, primary-group switching on mobile, refresh persistence, group close, no duplicate native observation caused by selection.

No native Provider lifecycle changes, publishing, deployment, or Controller restarts are included in this implementation task.
