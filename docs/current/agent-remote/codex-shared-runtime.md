# Shared Codex sessions across devices

The Codex provider can connect to an existing native app-server through its local
Unix WebSocket or, on Windows, an authenticated loopback WebSocket. A desktop CLI and the Remote Controller can then send messages,
steer active work, and respond to interactions on the same native thread. There
is one writer in the daemon and multiple subscribed clients, with no history fork
or process takeover.

## Setup

Use a Codex installation with native local app-server support. This integration
was tested with Codex 0.154.0 on macOS. Keep the complete native installation,
including `codex-code-mode-host`, instead of copying only the main executable.

On macOS and Linux, start the native daemon and connect the desktop terminal to it:

```sh
agent-remote-controller codex daemon start
agent-remote-controller codex
# To reopen a saved session in that same daemon:
agent-remote-controller codex resume <native-session-id>
```

Configure the Agent Host locally before starting it:

```sh
# Shared mode and daemon permissions are the defaults.
# Optional when using a nondefault socket:
# export AGENT_HOST_CODEX_SOCKET=/absolute/path/to/codex.sock
agent-remote-controller start
```

Normal Relay URL, pairing credentials and provider selection still apply. Use
the same native Codex home on both clients; `AGENT_REMOTE_CODEX_HOME` selects it
for the Host. Without an explicit socket path the provider uses
`$CODEX_HOME/app-server-control/app-server-control.sock`, with `~/.codex` as the
default home. These Host settings are persisted with the accepted connection
configuration for later starts. An already-running Host needs a controlled
restart to change its provider configuration; `pair` only replaces the uplink.

Open the same Host and native session from the phone. The desktop client can
remain open. Multiple Remote browser windows reuse the Host's existing session
binding as before.

### Windows setup

Windows uses a Controller-managed native app-server because native Codex does not
implement the Unix daemon lifecycle there. This integration was tested with native
Codex 0.153.4. From PowerShell, with the same Codex home for both clients:

```powershell
agent-remote-controller codex daemon start
agent-remote-controller start
agent-remote-controller codex
```

The manager chooses a free loopback port and requires a random bearer token. The
Controller discovers and verifies the endpoint through an authenticated named
pipe; the terminal proxy passes the token through the environment. State is stored
in `<CODEX_HOME>/agent-remote-daemon`. Keep that directory private to your account.
Unix socket and file-descriptor-limit overrides must be unset on Windows.
On macOS/Linux, the Controller daemon start/restart command defaults to a soft
file descriptor limit of `8192`, configurable through `AGENT_HOST_CODEX_NOFILE`.
On every platform, `agent-remote-controller codex daemon start|restart` explicitly
sets `OPENAI_API_KEY=arc` for the daemon process, replacing any inherited value.
The `codex app-server daemon start|restart` aliases do the same. No shell-specific
environment assignment is needed in PowerShell, Command Prompt, or Unix shells.
This leaves `CODEX_GATEWAY_API_KEY` and ordinary Codex CLI invocation credentials
unchanged. Starting an already running daemon does not change its environment;
use an explicit restart to apply it.

Use `agent-remote-controller codex daemon status|restart|stop` to manage this
independent runtime. Stopping the Controller or closing a client leaves it running.
A Windows Job Object reclaims its native process tree if its manager crashes.
See [Windows shared daemon](../../../packages/agent-host/README.md#windows-shared-daemon)
for requirements and lifecycle details.

### Starting from the terminal

Run `agent-remote-controller codex` from the project directory to create an
interactive session in that directory. With the automatically selected shared
endpoint, the Controller explicitly passes the invoking shell's current directory
to Codex; the saved Host workspace and the daemon's startup directory do not
replace it. `-C` / `--cd` overrides remain supported, including paths with spaces.

`resume` and `fork` retain native directory behavior for existing sessions.
Daemon management commands, private-mode invocations, and explicit `--remote`
connections retain their native argument semantics.

## Ownership and permission boundaries

- `shared` is the default Controller connection mode. Explicit
  `AGENT_HOST_CODEX_CONNECTION=private` settings and managed Gateway sessions
  retain isolated app-server processes. `shared` never silently falls
  back to a private runtime if the daemon is missing or disconnected.
- Shared mode uses native WebSocket JSON-RPC over the local Unix socket or an
  authenticated Windows loopback connection. The
  native `app-server proxy` command forwards bytes; it does not translate the
  WebSocket handshake into newline-delimited JSON.
- `AGENT_HOST_CODEX_TRUST_SHARED` defaults to `1`, accepting the shared daemon's
  native permissions for Codex only. An explicit `0` retains the permission
  rejection unless full control is enabled. It does not change Claude or Copilot restrictions.
  A connected client cannot independently sandbox work already running in a
  shared thread. The existing Host workspace/grant checks remain in effect.
- Trusted shared Codex sessions allow web permission changes on Windows, macOS,
  and Linux. The Host does not add a local permission lock. Native requirements
  and idle-session checks still apply. Confirmed native permission changes from
  another client update the web controls through the shared daemon notifications.
- On an authenticated Relay, permission changes require a gateway sign-in within
  the last ten minutes. An older sign-in returns a request-scoped
  `reauthentication_required` error without disconnecting the session or forwarding
  the change to the Host. The web workbench offers **Sign in again**, preserves the
  session return location, and requires the user to retry after authentication.
- Closing a Remote session closes its connection, not the daemon or another
  subscriber. Native daemon lifetime and idle thread unloading remain native
  policies. The Provider reconnects automatically after a socket failure while
  keeping the existing Remote session and observer alive. Disposing the Remote
  session cancels recovery without stopping the external daemon.
- Both clients may submit input. Native turn ordering and steering apply; this
  is not collaborative editing of an unsent draft. Pending interactions are
  replayed to a joining client. Once answered, native resolution dismisses the
  other client's pending form. The resolution notification does not supply the
  other client's exact answer, so no answer is fabricated there.
- An external CLI or desktop app holding a thread in a private runtime still
  causes a writer conflict. This feature cannot convert that live process into
  a shared daemon. Release it once, then reopen the saved thread through the
  shared daemon. Never remove a live writer lock. Compatibility with a desktop
  app that does not expose the native socket is not established.
- Windows adds an authenticated TCP listener bound only to `127.0.0.1`; Unix
  continues to use its native socket. This adds no cloud endpoint, new Remote
  protocol message or capability for terminating arbitrary processes.

## Recovery behavior

The reusable `@orchardworks/codex-daemon-client` package owns one recovery loop for each loaded native root and all of its child sessions. It depends only on `ws` at runtime and accepts the embedding application's native initialization identity. The Provider retains its existing `codex_app_server_daemon` identity and `Agent Remote Control` title. Its `runtime.ts` maps native callbacks to SDK sessions and child descriptors; observation queues, timeline projection, interaction receipts and active-turn publication remain in the Provider. See the [native client API and independent consumer](../../../packages/codex-daemon-client/README.md).
Transient failures retry indefinitely with jittered exponential backoff from
500 milliseconds to 30 seconds. Each connection attempt has a 10-second
deadline, each restoration has a 30-second deadline, and at most four roots
restore concurrently through a scheduler shared by Provider roots. The native client lets other applications inject their own scheduler scope. An explicit test or embedding configuration may set a
finite attempt limit. Permission rejection, incompatible native protocol, and a
missing native thread stop retries and expose the runtime as unavailable.

Recovery initializes the replacement transport, attaches the existing root with
`thread/resume`, and reads authoritative root and child snapshots with
`thread/read`. It does not issue `thread/start`, replay messages, start a turn,
or resend cached setting updates. A thread with no persisted native rollout is
unavailable after a daemon restart and is not recreated under a new identity.

While reconnecting or restoring, all Provider mutations reject immediately.
Notifications, native requests, snapshot results, and child discovery are fenced
by transport generation so an old connection cannot change restored state. Any
pending native interaction is published as `interaction_invalidated`; recovery
does not fabricate an answer, rejection, or cancellation. Repeated native
request IDs receive fresh public identities after recovery and after a Host
restart.

Once restoration completes, each observed session publishes one
`timeline_replacement` containing the authoritative history and notifications
buffered across the snapshot handoff. The original observer remains open and no
second `history_boundary` is emitted. Loaded child session objects retain their
identity and native direct-input eligibility.

The timeline cutoff applies only to timeline reconciliation. Generation-scoped `serverRequest/resolved` controls remain effective even when received during `thread/resume` or before a repeated snapshot read. Buffered spawn items retain native parent-turn and call identities, and notifications for unknown children enter normal discovery after the handoff. Snapshot histories are inspected for descendants of every restored session, including loaded children.

After replaying the post-snapshot notifications, the adapter publishes the actual active turn through `runtime_updated.activeTurnId`: a native ID identifies the surviving turn and `null` clears an obsolete one. This state correction does not invent a successful completion or user cancellation. The Relay and browser therefore agree on idle controls and the actual interrupt target after recovery.

## Verification

`shared-runtime.local.test.ts` runs independent provider clients against one real
native Codex app-server and a local deterministic Responses fixture. No cloud
model request or real user session is used. It covers simultaneous attach,
history, live messages from either client, continued use after one client closes,
late-join question replay, duplicate-answer rejection, disconnection while the
other client still has a pending question, and stable recovery after the daemon
disappears and returns at the same socket. The restart case persists a native
turn before stopping the daemon so it verifies recovery of a real saved rollout.

`packages/codex-daemon-client/src/client.test.ts` uses an independent notebook consumer and a real Unix socket to check native snapshot/delta ordering, original-thread recovery, configurable initialization, request cancellation and disposal. The notebook imports no application SDK and also runs against a packed artifact installed outside the workspace. Transport tests live with that package.

`shared-recovery.test.ts` retains Provider and Manager/Wire integration coverage and uses a real Unix WebSocket transport with a deterministic
app-server fixture. It covers authoritative replacement, unbounded default retry,
explicit bounded retry, permanent missing-thread classification, interaction
invalidation, generation-safe identities, repeated loss, child stability, and
disposal cancellation.

```sh
AGENT_REMOTE_SHARED_CODEX_TEST_EXECUTABLE=/path/to/codex \
  pnpm test:codex-shared
```

Native tests opt in through this executable setting; ordinary provider tests
cover configuration rejection and missing-socket errors without running Codex.

## Idle Controller subscriptions

The Controller detaches its shared Codex connection after five minutes without
remote demand and with a safely idle native runtime. Full session windows (Main,
Side and Ask), activity-only observers (Track and Ask), other devices, and active
requests all retain the connection. A favorite alone does not retain a connection.

Short browser disconnects and mobile sleep do not immediately dispose a session.
Returning demand resets the grace interval. Cleanup pauses while the Controller's
Relay uplink is disconnected; registration starts a fresh full grace interval.
Running turns, pending interactions, native recovery, and unconfirmed mutations
prevent release. Otherwise-idle bindings protected by unknown outcomes or failed
child discovery are checked after one minute without demand. Checks share the
existing native connection and run one at a time per Controller. Failed or unsafe
checks back off to at most one every fifteen minutes. Native recovery or a Relay
outage pauses effective reconciliation; demand, new operations, and connection
changes invalidate outstanding results.

Reconciliation reads native family metadata, retrying at most one unresolved child
with the latest ten-turn page and a ten-second request budget. It never falls back
to full child history, creates a new native connection, resumes or sends a message.
A successful idle check removes only the release protection, then starts the full
five-minute grace again. Unknown message results and operation-cache retry rules
remain unchanged. Unreadable or busy state is never force-released.
Native child projections are detached before their owning parent connection; this
can extend the parent's grace period.

Reopening restores the same native session and stable remote identity, including
history created by other native clients while the Controller was detached. The
normal timeline reset/catch-up protocol handles the new projection. No send is
replayed as part of restoration. Lifecycle diagnostics record
`session_idle_released`, `session_idle_restored`, and `session_idle_reconciled` without conversation content.

This cleanup closes only the Controller-owned connection. It does not cancel work,
archive history, stop the daemon, or close another CLI/client's subscription. Codex
controls when an unsubscribed native thread is unloaded, so a reduction in
`thread/loaded/list` is not guaranteed to be immediate. Private Codex runtimes,
Claude and Copilot are not automatically disposed by this mechanism.

## Owner-requested daemon restart

Host settings expose **Restart Codex daemon** when the Controller advertises the
Codex `daemonControl` capability. The account owner must explicitly confirm the
Host-wide impact: every shared Codex session on that Host, including local CLI
sessions, disconnects; running tasks are interrupted and do not resume
automatically. Saved conversation history is preserved. Shared-account guests
cannot read or invoke this control. Private Codex runtimes and custom sockets do
not advertise it.

The Controller runs its existing `codex daemon restart` command, followed by
`codex daemon status`. This preserves the configured Codex home, executable,
locale, Unix file descriptor limit, and `OPENAI_API_KEY=arc` injection on daemon
start. Windows uses the existing Windows daemon lifecycle manager. Updating the
Controller itself still does not restart Codex.

Before dispatch, the Controller records an operation ID and a new revision in
`codex-daemon-operation.json` under its state directory. Repeating the current
operation returns its saved outcome; stale revisions and concurrent new intents
are rejected. The job survives Relay disconnection. A Controller process
replacement with an unfinished record reports `unknown` and never replays the
restart. Execution timeout or an unsaved result also leaves the outcome unknown.
Only an explicit, newly confirmed intent may start another restart.

The website queries the outcome without automatically resending a restart.
Polling pauses when Host management is hidden or the page is backgrounded and
is bounded to two minutes per foreground observation window. **Check status**
remains available afterward. The saved result describes the last operation,
not continuous daemon health. A `ready` result confirms that the restart and
subsequent readiness probe completed; it does not assert recovery of every
session. No messages or interrupted turns are replayed.

Deploy the Server and website before installing a Controller that advertises
this capability: older strict uplink decoders reject unknown provider fields.
The updated Server accepts older Controllers but does not offer the operation
for them.
