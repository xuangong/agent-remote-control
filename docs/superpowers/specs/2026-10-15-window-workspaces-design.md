# Shared Window Workspaces

Status: first stage implemented and locally verified in the isolated window-workspaces branch; not committed or deployed.
Source baseline: `main@2e957ae`.

## Product decisions

A Window is the product workspace and owns its layout identity independently of
any session. This first delivery preserves one primary Session View area and its
additional Session Views. Rebinding that primary View does not replace the Window.
There is no additional Workspace layer above Window.

Delivery is deliberately split into two stages. The first establishes the shared
Window abstraction while retaining the current primary-area behavior used by Track,
Ask, and navigation. The second will let one Window contain multiple primary session
groups, each retaining its own attached Subagent, Ask, and other relationships. This
is not a flat collection of unrelated peer Views. Multiple primary groups are outside
this delivery; the single-primary constraint is the current product layout contract,
not the identity or fundamental meaning of a Window.

Multiple pages opening the same Window share its state. User and Agent operations
address the Window, not an individual browser client. Selected view, bindings,
ordering, presentation choices, and preferred dimensions belong to that state.
Responsive rendering adapts it to available space: wide screens display the
horizontal composition; narrow screens display the selected view without the
horizontal rail. Adaptation does not write a different layout back to the Window.

The application does not expose a Client management concept or attach/detach
commands. Pages read and subscribe to a Window through ordinary connection
management. Closing a page does not delete the Window. Closing a view or deleting
a Window does not stop a native session or archive a Team or TPM work item.

At most one Agent session is authorized to manage a Window at a time. Users retain
manual control. An Agent may manage more than one Window. The command layer must
enforce the management assignment; a prompt instruction alone is insufficient.
Agent-facing continuous `window watch` is outside the first implementation.

## Research conclusions

tmux contributes useful principles: addressable objects, shared authoritative
state, one command vocabulary for human and programmatic control, inspection, and
explicit command results. Its terminal lifecycle is not the ARC product model.

The tmux server holds state independently of attached terminal clients. Its object
IDs remain stable for their lifetime in that server; this is not a default promise
of disk persistence across server restarts. Control Mode shares normal tmux
commands and reports command outcomes plus asynchronous notifications.

References inspected during this discussion:

- [Getting Started](https://github.com/tmux/tmux/wiki/Getting-Started)
- [Control Mode](https://github.com/tmux/tmux/wiki/Control-Mode)
- [Manual](https://github.com/tmux/tmux/blob/master/tmux.1)

The agreed gap assessment is:

| Proposed gap | Decision |
| --- | --- |
| Explicit Client object | No product object or command target is needed. |
| Stable addressing | Keep stable Window/View IDs in a saved workspace structure. |
| Attach/detach lifecycle | No additional lifecycle; sessions and Windows are already intended to be shared. |
| Unified commands | Required; UI and CLI must use the same operations. |
| Execute/observe/confirm | Required implementation guarantee, not a new product concept. |
| Agent-readable scene | Required snapshot inspection; continuous watch is optional and deferred. |

## Current implementation and reuse

The code already separates a presentation identity from its native session binding:

- `packages/agent-remote-lab/src/composition-views.ts` supports empty view creation
  and later binding. Its `CompositionWindow` currently means one view and must be
  renamed or mapped explicitly to avoid collision with the new workspace meaning.
- `session-composition-model.ts` stores slots, session references, succession
  checkpoints, association edges, selections, Ask ownership, and Track references.
- `hooks/useSessionWindows.ts` opens, binds, groups, and closes additional views.
- `components/SessionDock.tsx` separately stores order, width, and minimization in
  browser session storage and moves stable view hosts between floating/docked
  placement without intentionally recreating their conversations.
- `team-layout.ts` treats Team opening as a layout preset.
- `session-view-navigation.ts` resolves relationships from the displayed session,
  independently of its container.
- ARDB already inspects and controls session protocol state through the shared
  Remote client and Replica. It does not currently manage a hosted Window layout.

The missing capability is a shared, persisted layout authority and common command
layer. Adding a remote handler to every existing React setter would preserve
multiple competing implementations and is not the intended approach.

## Window model

Use `Window` and `View` in the product and CLI. Pane is only the tmux analogy.

A Window document describes:

- Stable ID, title, schema version, and committed revision.
- Stable primary view ID and selected view ID.
- Views with stable IDs and optional session bindings.
- Attachment/group relationships, including each source view's subagent views.
- Ordered dock groups, floating placement, preferred widths, and collapsed state.
- Per-view presentation mode, including the existing communication visibility choice.

Management assignment and operation receipts are protected service metadata. A
layout export must not carry credentials or grant management to its importer.

The product automatically creates an ordinary Window when no Window is selected,
including when opening a Session directly. No explicit workspace setup or naming
step is required. Every Window uses the same durable service, committed revisions,
sharing, and scoped Agent management. Changes persist through ordinary operations;
there is no separate save action or temporary/saved lifecycle.

Refresh reuses the current Window identity. The Window list can delete an inactive
Window; deleting the current page's active Window requires switching to or creating
another Window first. This is a page interaction rule, not a cross-page ownership
lock. If another page or the CLI deletes the selected Window, the page transitions
to a deleted-state notice and explicit Window selection. Deletion also requires
a confirmed active Window on the current page: while unavailable, the page must
open or create one before deleting anything else. Deletion never allocates
a replacement, changes another selection, or stops native sessions. Late replies
must not replace a newer explicit selection. An unresolved operation remains
unresolved; an explicit link to an unavailable Window reports that error rather
than silently opening a different Window.

Bindings reuse existing session references and succession semantics. They do not
substitute a display title, array position, or temporary Relay Agent ID for the
native/session-role reference. The same native session may be displayed by more
than one view. View identity survives renaming, reordering, and rebinding.

An empty additional view remains supported. Binding `empty -> A` and `A -> B`
remains supported; adding `A -> empty` is not required by this work.

In this first delivery the primary view is structural, not simply whichever view
is selected. Switching the main session changes its main/subagent area and leaves
independent dock views intact. Succession updates the relevant session reference
without replacing Window or view identities. The current schema explicitly enforces
one primary area so clients cannot create layouts that the current renderer cannot
represent. A later version can expand primary groups without treating the primary
native session ID as a Window ID or flattening attachment relationships.

Do not copy Timeline content, native execution state, pending approvals, drafts,
resource bodies, or credentials into the layout document. Persisted layout is
not a native-session checkpoint. Restoring it opens the current authoritative
sessions; it does not rewind their execution or replay prior messages.

## Existing feature integration

Ask, Side, TPM, and Team remain business features that create or reference normal
Session Views. Their presentation uses the same Window operations.

- A Side/subagent stays attached immediately to its source view. The visible attachment is a selected descendant chain, with at most one directly attached child per source; opening a different child replaces that branch. Each source and
  its attached views form a layout group; moving a dock group preserves it.
- Unlinking a Side removes its attachment relationship while keeping the same View
  as an independent dock. Its local session slot and drafts remain owned by that
  View. Unlinking is not a close or a native-session operation.
- Ask and TPM views can float or dock without changing their native identity.
- A Team opens the existing primary/leader/member layout preset. Member management,
  archive, and execution remain in Team. Gather reopens missing member views.
- Preserve the existing Team leader/member close relationship as a business
  operation expressed through a validated layout batch.
- Track, Favorites, and Discover target the selected empty/rebindable view where
  appropriate, or replace the primary area under the existing navigation rules.
- Track and feature catalogs are not duplicated inside the Window document.

## State and responsibility boundaries

### Composition of abstractions

Each layer builds on the public capabilities of the layer below it. File placement
alone is not an abstraction boundary. The current product calls its addressable
presentation unit a `View`; `WindowView` is that pane carrier, while Session View
is the reusable session renderer it hosts. These are different responsibilities,
not two competing identities for the same pane.

| Layer | Consumes | Owns and exposes |
| --- | --- | --- |
| Remote session | Provider-neutral session protocol | Authoritative observed session state, capabilities, and operations |
| Session View | Session state/actions and injected presentation/navigation callbacks | Conversation rendering and session interaction, independent of Window layout |
| View carrier | A session binding and the Session View presentation contract | Stable presentation identity, display preferences, and placement settings |
| Window | Addressable views and explicit structural relationships | Validated layout operations, selection, ordering, and shared revisions |
| Product features and page shell | Window operations and session capabilities | Ask/TPM/Team presets, catalogs, navigation, management assignment, and URL choice |

The public layout reducer must not infer binding or closing behavior from an
Ask, TPM, or Team label. Features express their requirements with generic binding
policy and explicit relationships; application adapters interpret bounded feature
metadata. Native slots and draft owners belong to the application session bridge,
not to the layout authority. This bridge translates committed layout references
into existing session capabilities without becoming another writable layout store.
Adoption maps a View to an eligible existing local session slot; it does not rename
that slot or reconstruct its drafts, Ask ownership, recovery attempts, or active
connection. Additional views receive independent local ownership when needed.
The mapping is persisted locally and is committed only after Window creation has
settled. A View can retain distinct owners for its previous bindings so that A to B
to A restores A's draft. Two different Views cannot claim the same local slot.

An Ask association records its source session reference separately from the View
that contains that source. Rebinding the primary View from A to an unrelated B
does not relabel an open Ask of A as an Ask of B. A fresh page retains a local
reference for A without opening it or changing the primary binding. Verified
native-role succession can preserve the association; shared metadata alone cannot
establish native-role authority. Another page seeing an Ask before native creation
settles waits for its published binding instead of creating a second session.

Navigation to a named local View selects its exact presentation identity. Session
catalog, Favorites, and Track navigation continue to replace the primary binding
while preserving independent docks; a matching native session in a dock does not
silently change that navigation into a View selection.

Session View can be embedded without this product's Window, sidebar, catalogs, or
authentication UI. Its existing state/action and callback interfaces remain the
boundary; this work does not introduce a second renderer for shared layouts.
The Window store is instance-scoped. Choosing a Window from a URL is a responsibility
of the current product shell, not a property of every Window instance.

Other pane content types and pages hosting multiple Windows are examples for
checking these boundaries, not features in this delivery. Do not add a content
registry, a new pane hierarchy, or a multitasking UI speculatively. A later content
adapter must keep its behavior separate from the existing layout operations.

```text
Browser controls --------------------------+
                                           |
Agent -> agent-remote-controller CLI -> authenticated Window service
                                           |
                              shared validation and operations
                                           |
                         authoritative Window document + result
                                           |
                         all subscribed pages render that state
```

The service belongs to the application/site layer because a Window can contain
sessions from multiple Hosts. Controller supplies the CLI entry, local management
context, and authenticated routing; it is not the layout authority.

Keep the document schema, validation, and pure layout transitions reusable and
independent of React and Provider adapters. Node/Docker and Cloudflare use the same
semantics with their respective persistence adapters. Standalone composition must
remain usable without requiring hosted account services.

The browser owns rendering and connection recovery. Local caches accelerate opening
but are not a second writable authority. A stale cache must not overwrite a newer
Window revision. Cache rendering can begin before session connection checks finish.

Internal subscriptions distribute committed revisions to pages and recover through
a fresh snapshot or supported catch-up. They are not an Agent-facing watch product.

## Command surface

The following vocabulary guides the Window CLI; the operating guide documents the available commands and grant limitations.
Prefer explicit state-setting operations over toggles for safe scripted retries.

```text
agent-remote-controller window
  list
  inspect <window-id>
  rename <window-id> <title>
  delete <window-id>
  export <window-id>
  apply <window-id> --file <layout-file>
  operation <window-id> <operation-id>

  view create <window-id>
  view bind <window-id> <view-id> --session <session-reference>
  view close <window-id> <view-id>
  view select <window-id> <view-id>
  view move <window-id> <view-id> --after <other-view-id>
  view resize <window-id> <view-id> --width <preferred-width>
  view place <window-id> <view-id> --mode dock|float
  view collapse <window-id> <view-id> --value true|false
  view display <window-id> <view-id> --mode <existing-view-mode>
```

Structured `--json` output includes stable identifiers, the resulting revision,
and explicit errors. Inspection returns the workspace structure independently of
Host/session availability. Runtime observations remain available through the
existing session APIs; a layout snapshot does not establish native readiness.
This release creates Windows in the website. The CLI can create views within its
assigned Window, but its grant cannot create other Windows.

Session text, settings, interactions, and lifecycle commands reuse their current
public APIs and client implementations. A view-to-session resolver lets Agent
tools read the appropriate Timeline without copying content into Window storage.

## Management assignment

An authenticated user can assign, replace, or revoke the sole managing Agent
session. Reassignment invalidates the former manager's authorization for future
mutations; its already committed layout changes remain valid. A request ordered
after reassignment cannot commit under the previous assignment.

Creating a Window does not silently claim its management. Agent-initiated Window
creation requires explicit creation authority; a grant for an existing Window
does not authorize creating arbitrary additional workspaces.

CLI invocations must be bound to a verified management grant and its generation.
Supplying `--session` or a Window ID is not proof of authority. Do not expose a
user's broad site credential to the Agent. Implementation must validate the grant
delivery path for already-running native sessions and avoid changing global
Provider environment merely to associate a session with one particular view.

This is application-level authorization, not an OS sandbox against other processes
running as the same local user. Manager status does not elevate native permissions,
authorize unrelated Hosts, or turn layout commands into session-execution controls.

## Completion and retry contract

Each mutation has an operation ID and a base revision where it depends on an
observed layout. Commit only a validated next document; malformed imports and failed
layout batches leave the previous document intact. A successful result identifies
the operation and committed revision. Full-layout application is one layout
transaction, not a transaction over native Agent execution.

Use the same persistence boundary for a document change and its operation result.
Repeated operation IDs with identical input return the settled result within the
advertised retention scope; different input is a conflict. Explicitly bound result
retention and report expiry rather than promising unlimited deduplication. A missing
or expired result must not cause an uncertain operation to be blindly executed again.

Timeout or transport loss is not proof of rejection. The caller can query the
operation and inspect current state. Dependent commands wait for the prior committed
result instead of sleeping. Manager replacement and manual user edits are still
ordered by the service; the single-manager rule is not a substitute for revision
validation against stale input.

Normal command success means the shared Window state committed. It does not claim
that every page has rendered it, that a suspended phone is online, or that a native
session is ready. Session readiness can be awaited separately through existing
session APIs. Layout changes do not wait for the Agent to become idle. Do not add
an all-pages acknowledgement barrier to routine layout operations.

## Delivery sequence

1. Define and test the Window/View schema, references, invariants, operations,
   inspection result, management assignment, and settlement contract together.
   Prove the CLI management-grant path before claiming session-exclusive control.
2. Implement the common Window service and persistence adapters. Verify two clients,
   conflicts, identical retries, lost replies, restart recovery, and owner replacement
   over real transports.
3. Route product layout changes through those operations. Consolidate the existing
   composition/dock/Ask placement state; preserve common Session View rendering,
   cached opening, drafts, reference succession, and connection reuse.
4. Add Controller subcommands and machine-readable results through that same service.
   Provide a concise Agent operating guide: inspect, operate, resolve uncertain
   results, refresh after conflict, and continue with current identifiers.
5. Integrate all navigation and feature presets, then perform multi-page and
   responsive end-to-end acceptance. Do not call the work complete while one feature
   still has an independent authoritative layout setter.

For migration, explicitly import an existing browser layout into a newly identified
Window once. Do not silently merge unrelated tabs into one Window or allow a later
legacy cache read to overwrite it. Keep old URLs usable as entry points, and give
shared Window links their own identity. Retire old layout writers after the switch.
Native session references and histories remain unchanged by layout migration.

This work needs coordinated website and Controller delivery for the new command
surface. Update protocol fixtures, schemas, documentation, replay/compatibility
metadata affected by the contract, run `pnpm compatibility:update`, and verify
`pnpm compatibility:check`. Publishing, deployment, and installed Controller updates
are separate delivery actions, not part of this implementation task.

## Acceptance

- An Agent can inspect a Window, create an empty view, bind a session, select it,
  resize/reorder it, and receive verifiable results using independent CLI processes.
- Two pages opening one Window converge on the same layout and selected view after
  either human or Agent operations. A narrow page adapts without rewriting widths.
- Closing all pages leaves the Window intact; reopening restores the saved layout
  and reads current session state. Host unavailability does not hide layout facts.
- Main-session replacement and succession preserve the Window identity and
  independent dock views. Each view retains its own attached subagents.
- Ask, Side, Team, and TPM retain their business semantics while using the common
  layout commands. Closing their views does not implicitly archive or stop work.
- An unassigned Agent cannot mutate the Window. Replacing the manager invalidates
  old requests without requiring a native Agent process takeover.
- Identical retries do not create extra views; conflicts are explicit; lost replies
  are resolved without sleeps or fabricated success. Restart and expiry semantics
  match the published operation-retention contract.
- Invalid full-layout application leaves the previous layout intact. Reordering
  and floating preserve drafts, mounted view continuity, and connection reuse.
- Local cached opening stays fast; authoritative synchronization cannot restore a
  stale layout over a newer committed one.

## Deliberate limits

No new Client product, attach/detach lifecycle, additional Workspace hierarchy,
arbitrary terminal split tree, terminal keystroke injection, multi-Agent layout
collaboration, Agent-facing watch stream, layout-triggered native cancellation,
or native-history rollback. Browser-specific editing and pixel scroll offsets are
not duplicated as native session facts. Later additions must use the same Window
model rather than create another control path.
