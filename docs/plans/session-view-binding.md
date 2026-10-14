# Independent Session View binding

Status: implemented.

## Purpose

A Session View exists independently of the session it displays. Users can create
an empty view, place and focus it, and then choose a session from the sidebar.
Docking is a placement of an ordinary Session View.

## Ownership and boundaries

- A stable view ID owns placement, size, ordering, display preferences, and its
  selected session reference, which may be absent.
- The bound session owns runtime state, timeline, pending messages, attachments,
  and drafts through the existing stores and connection infrastructure.
- An empty view has no provider, native session, connection lease, or agent state.
  It does not create a native session or display a working chat composer.
- Extend the existing composition document with presentation windows: an empty
  window has no slot reference; a bound window references an existing slot. Do not invent an empty native session ID or maintain a second
  dock-only binding registry. Reuse existing fixed, history, and role references.
- Separate the focused view used for commands from the business main session.
  The latter continues to determine the browser title and explicit main navigation.

## Interaction

1. At wide layout widths, `View > New session view` creates a dock at the right,
   using the existing default width. A plus button at the end of the dock rail
   exposes the same action. The new view is activated and scrolled into view.
2. Its title is `Select session`. Its body says `Choose a session from the sidebar`
   and provides an `Open sidebar` button. Creating it opens the sidebar if hidden.
   Resize, reorder, and close work before any session is selected.
3. Clicking or keyboard-focusing an eligible view makes it the sidebar's open
   target. A quiet active outline and a sidebar `Open in: ...` label identify it.
4. Focusing the sidebar, changing Host/provider, searching, or opening a menu
   preserves that target. Target selection is explicit application state, not a
   read of `document.activeElement` when a session row is clicked.
5. Selecting a session from the list, favorites, or related-session directory
   captures the target view ID and changes that view's binding. It does not move
   or resize the view or replace the business main session when targeting a dock.
6. Bound ordinary views remain selectable targets. `Change session` activates the
   view and opens the sidebar. `Close view` removes the view without ending the
   native session. Empty is an initial state; bound views have no clear action.
7. A narrower viewport stops offering new docks. It preserves their saved layout
   and bindings using the existing narrow presentation behavior.

## Binding transition

One application-level binding operation accepts a stable view ID and a required
destination session reference. The previous binding may be absent. It supports
empty-to-session and session-to-session transitions. Choosing the current
reference is a no-op. Returning a bound view to empty is outside this feature.

Selection is synchronous: the view immediately identifies the selected session,
uses its available cache, and shows its actual connection state. Network readiness
is not a prerequisite for changing a view's selected session.

Connection failure leaves the selected target visible with a specific error,
Retry, and Change session. It never silently restores an unrelated previous
session. Disconnection of an already bound session keeps its content and drafts.

The transition releases only the old view's observation lease. Shared observations
remain available to other views and the existing retention pool. Old session
drafts and queued messages stay attached to that old session and never follow the
view to its next binding. Empty views cannot send messages.

Each mounted binding owns its asynchronous attachment attempt. The outer view ID
stays stable, while changing the target remounts the session family and aborts the
previous attachment. Switching again or closing invalidates that attempt.
Late results cannot replace a newer binding or resurrect a closed view. Existing
attachment deadlines settle stalled attempts into a retryable error.

## Relationship to handoff

Initial binding is succession from an empty view. Ordinary rebinding and native
handoff share the final view-binding application primitive.

Native handoff still owns context transfer, role commitment, operation settlement,
and its existing execution restrictions. Its confirmed result applies to matching
role-bound views, preserving the existing draft/ownership transfer rules. Merely
choosing a different session does not perform a native handoff or require an idle
agent. An empty source needs no native transfer transaction.

## Navigation policy

- Sidebar list and favorites use the captured active eligible view.
- Explicit main links, Track restoration, Team opening, and browser main-session
  navigation retain their existing main/layout destinations.
- Subagent and envelope navigation retains the owning session-family behavior.
  Switching a family's root detaches its visible descendants and restores the new
  target's saved family; children from the previous target must not carry across.
- Ask, TPM, and Team-member bindings belong to their feature. They use the same
  view/placement capability but reject arbitrary sidebar rebinding. While one is
  focused, the sidebar explicitly targets Main instead of silently replacing it.
- Repeated native session identities can be displayed through shared connections;
  native identity must not substitute for view identity or move an unrelated view.

## Persistence and implementation scope

Persist empty views, stable IDs, bindings, order, widths, and the active eligible
view in the existing bounded browser layout storage. Restore placeholders without
network requests; restore bound views with cache before connection checks. A
missing active view falls back to Main. A failed attachment is not an empty view.

Import legacy window targets once as composition slot references. Retain their
explicit dock IDs so existing order, widths, and Team close-with references remain
valid; newly created views use independent UUIDs. Keep one active representation;
do not keep dual selection paths after conversion.

Implement in this order: extend the shared view/binding model; adapt ordinary
window/dock identity and persistence; route sidebar selection through explicit
destinations; connect empty-view controls and existing handoff projection; verify
the complete user paths. Keep provider adapters and public Remote schemas unchanged.

## Acceptance

- Create, resize, reorder, close, and reload an empty dock without attaching an agent.
- Bind from session list and favorites, including a different Host/provider.
- Preserve the target across sidebar focus; preserve main and other docks.
- Switch before attachment finishes; close during attachment; reject late results.
- Show cached content immediately and useful retryable failures under weak connectivity.
- Keep drafts, queued messages, and child views associated with the correct session.
- Preserve handoff application, Team grouping, Ask/TPM ownership, Track behavior,
  reload/history recovery, narrow layouts, and connection sharing.


## Implementation boundaries

`CompositionDocument.windows` contains presentation identities and optional slot
references. It contains no copied native target. `bindCompositionView` accepts an
existing destination slot; both ordinary selection and main succession selection
use this operation. Native role projection continues to update the shared slots.

Ordinary views use their slot's existing text and image owners, so another view of
the same session shares those drafts. Rebinding selects the destination's owners;
role succession keeps its established ownership. Existing managed Team windows
retain their feature's draft behavior and cannot be rebound from the sidebar.

Recent content uses the existing bounded workspace display cache. Main and dock
views share one cache-writing hook. Cached snapshots authorize no operations and
supply no transport cursor or pending interactions. Failure keeps the selected
session visible with Retry; cache recovery is bounded and may show only the recent
tail of a previously viewed conversation.

Verification uses the recorded provider over actual local HTTP/WebSocket channels,
Chromium and WebKit browsers, and bounded composition/cache unit tests. No native
provider process, Controller installation, public protocol, or production service
was changed.
