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

The product automatically creates a Window when none is selected. It is an
ordinary shared Window, with no naming or save step required. Each committed
change persists; refresh and shared links reuse its identity. **New Window**
creates another Window. Each list row has a delete action; the current page's
active Window cannot be deleted. First switch to or create another Window, then
delete the inactive one. Other pages can still have that Window open: they show
**Window deleted** and wait for an explicit choice, without creating a replacement
or stopping native sessions. Deletion is disabled until the current page has a
confirmed active Window; an unavailable page must open or create one first.

Open the floating **Window** button to choose a workspace and select one of its
session views. The entry remembers its dragged position. **View → Window view**
only changes its visibility. Less frequent actions are under **Window options**;
renaming uses an explicit **Save** or **Cancel**, not focus changes. On narrow
screens the panel stays inside the viewport and its content scrolls.

## Select a session view

Select a session view directly by clicking its conversation or controls.
There is no separate primary-group selector. **New session view** adds an
independent empty dock with the same selection and layout controls as a bound
view. Select it and choose a session from the sidebar. A primary group can be
closed from its own view when another primary group remains.

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

## Deployment and upgrades

The website and Relay implement the shared Window service. Existing Controllers
can keep serving sessions without an upgrade because the native session protocol
is unchanged. Using the new `agent-remote-controller window` commands requires a
CLI build that includes them; those commands contact the service directly and do
not require restarting the running Host daemon.

Window schema version 2 requires matching service, browser assets, and Window CLI
builds. The service automatically migrates valid persisted version 1 Windows,
preserving Window/View IDs, revisions, and operation receipts. Older strict
Window clients cannot read version 2. Rollback builds must retain the version 2
reader. The layout now uses `selectedPrimaryViewId` instead of `primaryViewId`,
and each primary's `collapsed` value instead of `mainMinimized`. Replace the
retired `minimize` command with `view collapse WINDOW_ID PRIMARY_VIEW_ID`.

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
independent docks; the last primary cannot be closed. Closing a view or deleting
a Window does not stop or archive native work.

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
