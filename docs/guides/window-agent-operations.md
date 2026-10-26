# Manage a shared Window

A Window stores shared presentation: views, session bindings, selection, order,
placement, dimensions, and display preferences. A successful command confirms a
committed Window revision. It does not confirm that every page has rendered it
or that a native session is connected, ready, or idle. Session execution,
messages, approvals, and lifecycle continue through their existing APIs.

The Window ID identifies the workspace, independently of its sessions. This
version supports multiple primary session groups plus independent docked and
floating views. A primary View ID identifies its group; `attachedTo` ancestry
determines its members. `closeWith` is a closure dependency, not membership.
Rebinding a primary keeps the same Window and preserves independent docks.
Attached Subagent views remain grouped with their source view.

The product restores an existing Window when opening or reopening the page.
An explicit Window URL takes precedence. Otherwise it restores the page's last
selection, the browser's last Window, or an available Window from the service.
It creates an ordinary shared Window only when none exists, or when the user
chooses **New Window**. No naming or save step is required. A session-only link
opens its target inside the restored Window, selecting an existing matching view
or binding the selected ordinary view. If that view has a managed binding, the
link opens a new ordinary dock instead.

Window layout snapshots are cached separately from session content. Reopening
a Window can show its cached bindings, order, widths, placement, and display
preferences before the service responds. Layout edits apply immediately to the
local Window, including while its initial inspection or a previous save is pending.
Saving and synchronization run in the background. Incoming snapshots are combined
with pending local edits; an older response cannot remove a newly opened view or
reopen one the user just closed. The shared layout becomes visible to other pages
when the service commits it. An explicit link to a deleted or missing Window stays
unavailable instead of silently creating a replacement.

The browser stores confirmed Window snapshots separately from its page-local
journal of pending edits. Normal refresh restores those edits and retries their
original operation identities, including edits to inactive Windows. The existing
**Clear cache on close** policy also applies to this journal. Storage failure does
not block live editing, but recovery then requires keeping the page open until
saving succeeds. Offline saves retry with backoff. A definitive rejection removes
the rejected edit; unrelated later edits remain. A lost receipt is not treated as
rejection or retried with a new identity. When a receipt cannot be recovered,
**Use saved layout** explicitly abandons pending local layout edits and adopts the
service's current layout. It does not undo changes already committed or stop any
native session. Full-layout replacement retains its revision/conflict checks.

Session reuse includes the live Remote client, canonical Replica, and state
subscriptions, as well as cached content. Within a page, Views of the same Session
share that connection across Windows. The page retains already connected Sessions by
when they were last shown, up to 24, without preconnecting unopened Sessions. Each
Window's Sessions form one unit, and a Session that left its pane, such as one opened
from Track and later replaced, is a unit of its own; the least recently shown units are
released whole, and the current Window is always kept. Closing one View does not
disconnect other consumers; an inactive retained Session continues receiving updates.
Team retention remains independent. A full page reload
creates a new browser network connection and restores cached content while native
session synchronization runs; layout restoration does not establish native readiness.
Retaining a connection does not retain a closed or rebound View's action authority.
Mutating callbacks verify their original View lease before sending or changing its
outbox. Other Views of the same Session keep their own valid action authority.

An unresolved creation is settled using its original operation identity before
the page considers another creation. Concurrent first opens in the same browser
use a browser lock when available; this is not a cross-device creation guarantee.

Each list row has a delete action; the current page's
active Window cannot be deleted. First switch to or create another Window, then
delete the inactive one. Other pages can still have that Window open: they show
**Window deleted** and wait for an explicit choice, without creating a replacement
or stopping native sessions. Deletion is disabled until the current page has a
confirmed active Window; an unavailable page must open or create one first.

Open the floating **Window** button to choose a workspace and select one of its
session views. The entry remembers its dragged position. **View → Window view**
only changes its visibility. Rename any Window, open or not, with the pencil on
its list row; renaming uses an explicit **Save** or **Cancel** (Enter or Escape),
not focus changes. The title shows at once and saves in the background like other
layout edits. Less frequent actions are under **Window options**. On narrow
screens the panel stays inside the viewport and its content scrolls.

## Select a session view

Select a session view directly by clicking its title, conversation, or composer.
A fine border and lightly tinted heading mark that exact pane, including an
empty pane. Opening global controls or the sidebar retains the selected target.
The Window can contain multiple top-level sessions; it has no unique main session.
Parent and feature-source relationships remain independent of pane selection.
On wide screens the mouse back and forward buttons select the previous or next
session view in on-screen order and scroll it into view, instead of navigating
browser history; pressing them over a pane does not select that pane first. A
horizontal mouse wheel scrolls the row of session views from anywhere over a
conversation, unless the pointer is over content that scrolls sideways itself.
There is no separate primary-group selector. **New session view** adds an
independent empty dock with the same selection and layout controls as a bound
view. Select it and choose a session from the sidebar. Every pane, including the
last primary or the last pane, can be closed. Closing the last pane leaves the
same empty Window; opening another pane is an explicit action.

When the selected pane closes, selection returns to a surviving attached ancestor,
then the closest surviving preceding pane in the previous `views` document order,
or the next surviving pane if none precedes it. This is document order, independent
of viewport geometry. The selected replacement and all its attached ancestors expand. Closing an
unselected pane preserves the exact current selection. Independent docks are
never promoted to primary views automatically.

The browser tab uses the title of the leftmost bound top-level Session View in
the horizontal layout, skipping empty roots. Changing selection does not change
the tab title; reordering or closing that leftmost pane does. With no bound
horizontal root, it uses the first bound floating root, then the Window title.

Click a conversation to focus its view, then use Favorites, Discover sessions,
Track, or New session. These actions bind that exact ordinary view, including an empty
one. A pending creation keeps its original destination when focus changes; a
closed or rebound destination cannot silently receive the result elsewhere.
Ask, Team, and TPM views have managed bindings and cannot be replaced this way.

The selected view is the target for pane operations and its current session is
the source for session operations, including creation of Team or TPM work.
An empty view has no session source. Creation captures the source view and session;
later selection changes do not change that relationship. Track restores its remembered family
layout when the selected destination is a primary view; an independent or attached
destination receives the clicked session without changing the primary group's
Track memory. Ask and Side actions also belong to their source view. On narrow
screens, the foreground conversation is the selected view, with no additional
selection control. The same shared selection and layout are used on every page.
Opening a Side places it beside its source Pane even if another Pane already
shows that Session. Reopening the same Side selects the existing attached Pane.
If the source Pane closes or changes binding while opening, the delayed result
cannot attach to its replacement.

## Deployment and upgrades

The website and Relay implement the shared Window service. Existing Controllers
can keep serving sessions without an upgrade because the native session protocol
is unchanged. Using the new `agent-remote-controller window` commands requires a
CLI build that includes them; those commands contact the service directly and do
not require restarting the running Host daemon.

Window schema version 3 requires matching service, browser assets, and Window CLI
builds. It is separate from the native Remote session protocol. The service
automatically migrates valid persisted version 1 and 2 Windows, preserving
Window/View IDs, revisions, bindings, and operation receipts. Migration does not
rewrite historical request fingerprints. Older strict Window CLIs cannot read
version 3 responses; an older CLI can report an uncertain mutation after the
service has committed it. Upgrade the CLI before using Window commands and
resolve such a receipt using its original operation ID. Rollback builds must
retain the version 3 reader.

Controller 0.2.52 reads both version 2 and version 3 Window responses, so the CLI
can be upgraded before the service. Publish this compatible Controller before
deploying version 3 website and Relay artifacts together. Reload open browser
pages after deployment; an already running older page does not acquire the new
decoder automatically. Existing Host daemons may continue serving native sessions.

Version 3 permits `views: []` and requires explicit `null` values for both
selection fields in an empty Window. A nonempty Window always has a valid
`selectedViewId`; `selectedPrimaryViewId` is `null` exactly when no primary exists.
Creating the first pane selects it. Adding the first primary establishes the
primary selection without replacing the current exact pane selection. Version 1
imports use `selectedPrimaryViewId` instead of `primaryViewId`, and each primary's
`collapsed` value instead of `mainMinimized`. Replace the retired `minimize`
command with `view collapse WINDOW_ID PRIMARY_VIEW_ID`.

The new Relay reads existing state that has no Windows. Once it stores a Window,
the state contains `workspaceWindow` records that earlier Relay versions cannot
read. Deleting a Window retains its settlement records and does not restore
backward compatibility. Any rollback build must retain the new record reader;
do not directly roll back to a pre-Window Worker or clear durable state. Preserve
the existing storage namespace, origins, and signing secret during deployment.

## Obtain a scoped grant

In the hosted website, open the Window and select the session that will manage
it. Open **Window options → Agent control → Use current session**, then **Save private manager
grant**. Assignment does not automatically deliver a credential into an already
running native session. Explicitly make the downloaded file available to the
intended Agent through your local workflow.

The file contains `serverUrl`, `windowId`, and `token`. Store it outside the
repository, restrict access, and pass its path to the Controller:

```sh
chmod 600 /private/path/window-grant.json
agent-remote-controller window inspect WINDOW_ID --grant-file /private/path/window-grant.json
```

On Unix, the CLI rejects a grant file readable or writable by other users.
Alternatively set `AGENT_WINDOW_GRANT_FILE`, or provide `AGENT_WINDOW_SERVER`,
`AGENT_WINDOW_ID`, and `AGENT_WINDOW_TOKEN` in the intended process environment.
Use HTTPS; HTTP is accepted only on loopback. Do not expose the token in prompts,
logs, source files, or command arguments, and do not substitute Host pairing or
broad website credentials.

A grant permits access to one existing Window. It cannot create another Window
or assign its manager. Use the website to create Windows. Reassignment or
**Revoke manager** invalidates the previous grant for future requests, including
requests queued after the reassignment. Previously committed changes remain.
The grant is a bearer credential; session assignment does not provide an OS
sandbox against other processes running as the same local user.

## Inspect, change, confirm

Commands output JSON. Set `AGENT_WINDOW_GRANT_FILE` below, or add `--grant-file`
to each command. Use stable IDs from inspection rather than titles or positions.

```sh
agent-remote-controller window list
agent-remote-controller window inspect WINDOW_ID
agent-remote-controller window view create WINDOW_ID --view-id notes
agent-remote-controller window view bind WINDOW_ID notes --session '{"hostId":"HOST_ID","providerId":"codex","nativeSessionId":"SESSION_ID","title":"Notes"}'
agent-remote-controller window view select WINDOW_ID notes
agent-remote-controller window view resize WINDOW_ID notes --width 620
agent-remote-controller window view move WINDOW_ID notes --after OTHER_VIEW_ID
agent-remote-controller window view place WINDOW_ID notes --mode float
agent-remote-controller window view collapse WINDOW_ID notes --value false
agent-remote-controller window view display WINDOW_ID notes --mode content --letters true
agent-remote-controller window rename WINDOW_ID 'Project review'
```

Additional commands include `view geometry --geometry JSON`, `view close`, and
`delete`. Display modes are `preview`, `simple`,
and `content`; placement modes are `dock` and `float`. `view create` accepts
`--session JSON` and `--mode primary|dock|float`. Create a primary to add a group,
then use the existing select, move, collapse, bind, and close commands on its ID.
Selecting a primary or attached child selects its group; selecting an independent
dock or float preserves the primary group used for family layout and history.
This grouping metadata does not override the selected view as the operation target.
Moving a primary moves
its attached chain together. Closing a primary closes dependent views but keeps
independent docks. An empty Window retains its identity, manager grant, revision,
and operation receipts; it can be inspected, exported, or populated again using
the same commands. Only `delete` deletes the Window. Closing a view or deleting a
Window does not stop or archive native work.

Wait for each committed result before issuing dependent commands. Mutations
normally inspect the latest revision first; use `--base-revision N` to require
the exact revision you inspected. After `revision_conflict`, inspect again and
reconsider the intended change rather than automatically overriding newer work.

Export and apply operate on presentation only:

```sh
agent-remote-controller window export WINDOW_ID > layout.json
agent-remote-controller window apply WINDOW_ID --file layout.json --base-revision 12
```

Export excludes Window identity, revision, management credentials, and receipts.
Apply validates the complete layout atomically. Invalid layouts leave the prior
layout intact; applying a layout never replays native messages or execution.

## Resolve an uncertain outcome

Exit codes are `0` for a committed mutation or successful read, `1` for input or
request errors, `2` for a settled rejected operation, and `3` for an uncertain
mutation. `--timeout-ms` accepts 100–60000 milliseconds and defaults to 15000.
A timeout or lost reply does not prove rejection.

When a mutation returns `status: "unknown"`, preserve its `operationId`,
`issuedAt`, `baseRevision`, and `windowId`, then query:

```sh
agent-remote-controller window operation WINDOW_ID OPERATION_ID
agent-remote-controller window inspect WINDOW_ID
```

Do not issue a fresh mutation ID to retry an uncertain command. A missing result
is `operation_unknown`; an expired result is `operation_expired`. Neither proves
that the original command did not commit. Inspect and reconcile the desired
state before further changes. If the grant was revoked, the user must resolve
the outcome with current authorization.

Receipts are retained for 24 hours, survive service restart, and commit together
with the document. Within retention, an identical operation ID and request
returns its original result; different input returns `operation_conflict`.
After a schema upgrade, preserve the original request payload for receipt
recovery, including version 1 creation or layout fields. Existing exact payloads
can recover their receipts; new legacy mutations are rejected. Do not rewrite
an uncertain request into version 2 before retrying it.
Receipts contain result metadata, not historical layout snapshots. A mutation
response includes the current Window when it still exists. Its revision may
therefore be newer than the original result revision on a retry.
Operations issued outside retention are rejected. Retention capacity is bounded
at 4096 live receipts per Window; reaching it rejects additional operations
instead of silently dropping live deduplication records.

For an intentionally replayable command, preserve its complete input and supply
all three identity options: `--operation-id ID --issued-at EPOCH_MS
--base-revision N`. For `view create`, an omitted `--view-id` defaults to that
explicit operation ID, so replay uses the same view identity. If the original
command supplied a view ID, preserve it too. Prefer operation lookup when
resolving uncertainty; do not reconstruct a different request from current state.
