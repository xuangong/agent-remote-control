# Copilot session handoff

## Accepted behavior

Native CLI and web transfers use **Interrupt and take over** only. Interruption
starts immediately; there is no safe-wait promise or idle heuristic. The next
writer starts only after the previous writer confirms shutdown and native
ownership is released. Session ID, Favorites, and Track identity stay unchanged.

Web-to-web transfer only changes remote interaction authority; it does not cancel
or restart native execution. ARDB is a remote client, not a native CLI process.
Background reconnect, Track, and discovery never request takeover.

## Ownership and outcomes

A local authenticated management endpoint identifies an ARC-managed native owner.
Takeover targets an exact owner generation. One successor reserves the transfer;
other contenders and stale requests cannot interrupt the successor. No native
lock file is deleted, and unmanaged clients cannot be killed automatically.

Admission stops before shutdown. The adapter confirms native release; a missing
or timed-out confirmation prevents the next writer from starting. Explicitly
requested interruption, forced termination, unexpected process exit, and unknown
outcomes are distinct diagnostic results. Accepted pending input is never silently
replayed after transfer.

The Chatbox is the web takeover entry point while read-only. A native takeover
explains that running work is interrupted. CLI resume offers the same immediate
operation. No safe handoff or escalation controls are offered.

## Chatbox layout

Read-only ownership is a compact row inside the existing composer: owner on the
left, one takeover action on the right. Native interruption guidance uses a
separate full-width line. Empty drafts and mutation toolbars are hidden; existing
text and image drafts remain mounted, selectable and height-bounded. Collapsing
the draft retains the ownership row and action. Taking control never submits the
draft or automatically focuses the editor.

The same row reports takeover and synchronization progress. Unconfirmed native
handoff offers **Check status**, which attaches without a takeover generation and
therefore cannot interrupt the current owner. A known refusal can be retried
explicitly. Cold views do not repeat the takeover instructions in a large empty
state, and there is no ambiguous Cancel button beside the interruption action.

## Native findings (CLI 1.0.83, SDK 1.0.11)

These findings were obtained with temporary profiles, a loopback model fixture,
and a real PTY. No user session was used.

- Calling `session.rpc.suspend()` while a model response is pending resolves
  immediately and interrupts the turn. It is not a wait-until-idle primitive.
- `--ui-server` starts an embedded loopback JSON-RPC server. In this version,
  its constructor does not pass a connection token to the native server, even
  when `COPILOT_CONNECTION_TOKEN` was supplied. A token handshake returns
  `AUTHENTICATION_NOT_CONFIGURED`; subsequent unprotected calls are accepted.
  This is not an acceptable authenticated ARC management endpoint.
- `session.getForeground` discovers the TUI session. `sessions.open` with
  `kind: attach` alone does not initialize the SDK session RPC handle. Calling
  `session.resume` enables those RPCs, but must not be assumed to be a harmless
  observation operation: host callbacks and interaction ownership need testing.
- `queue.setDrainPaused({paused: true})` prevents a newly submitted TUI prompt
  from beginning execution. It does not prevent the prompt from being accepted
  into the queue and is not, by itself, an admission barrier.
- A queued prompt remains in memory after `suspend`, but disappears after
  disconnect and resume. Reading an empty queue immediately before disconnect
  is therefore insufficient: a concurrent submission can be lost.
- Enqueuing `/exit` reports `queued: true`; that acknowledgement is not proof
  that the TUI exited or that native ownership was released.
- Rejecting `onUserPromptSubmitted` does not reject the native prompt. The SDK
  catches the hook exception and returns no output; the message is persisted and
  reaches the model. The isolated characterization test at
  `packages/agent-provider-copilot/tests/handoff-capabilities.test.ts` verifies
  this with a real SDK transport and a loopback model response. The extension
  API's `joinSession()` returns the same SDK session implementation, so adding
  this hook in a companion extension is not an admission barrier either.

## Implemented ownership boundary

`native-session-owner.ts` provides a local, token-authenticated loopback endpoint
and a profile-scoped ownership record. Generation checks fence concurrent and
stale requesters. The record is private and only its kind/generation cross the
public protocol. Unmanaged native writers are rejected using native lock checks.
A dead ARC owner is reported as unexpected; no native lock is deleted.

`agent-remote-controller copilot resume <id>` registers explicit native ownership.
When occupied, its terminal selector offers interruption or cancellation. Scripts
can pass `--take-over`. Native selection menus and sessions started outside this
wrapper do not provide an ARC-managed handoff endpoint.

The Controller closes the session through the adapter's native close operation.
The terminal wrapper signals its managed binary, waits for exit, then verifies
native ownership release. It unwraps the official npm loader because that loader
uses `spawnSync` without reliably forwarding process signals. If release cannot
be verified, takeover fails explicitly and no replacement writer starts.

The public `session_control.nativeOwner` state fences browser operations while
the native CLI owns the session. After native resume, existing views reconnect;
the requesting view explicitly acquires interaction control after synchronization.
History is retained, but an interrupted response need not be complete. Queued
native execution is not promised to survive interruption and is never replayed.

## Regression coverage

- `native-session-owner.test.ts`: authenticated local transport, competing and
  stale requesters, release failure, dead owner recovery, and classified outcomes.
- `copilot-immediate-handoff.local.test.ts`: running SDK to native CLI to SDK,
  same native identity, history restoration and further input.
- `native-handoff-transport.local.test.ts`: two browser WebSockets observe native
  transfer, reject stale writes, reconnect, and receive resumed execution.
- `copilot-handoff.spec.ts`: the built product, authenticated Gateway session
  channel, real Host and native CLI transfer running work in both directions.
  Existing and fresh mobile pages acquire control, retain the original draft,
  and keep the former browser read-only.
- `session-connection-errors.spec.ts`: a cold mobile page exposes immediate
  takeover in its read-only Chatbox and restores editing after attach.
- `session-control.spec.ts`: browser-to-browser takeover keeps the same Copilot
  turn running and preserves the former owner's draft.

The earlier `copilot-handoff.local.test.ts` characterizes native completion and
manual PTY interruption primitives; it does not define a safe-wait product mode.
The PTY cases run on macOS/Linux and are skipped on Windows. Windows process exit
is classified as forced; native Windows takeover still requires live verification.

## Accepted web interaction policy (all stdio providers)

Web pages share the same Controller-owned native process. Exactly one page owns
interaction control; other pages keep observing in read-only mode. An explicit
web takeover atomically transfers this authority without waiting for the native
turn, cancelling a task, disposing a process, or resuming the native session.
Pending approvals can be answered by the new controlling page. Writes already
admitted before transfer may settle; later or delayed old-page writes are fenced.

This common protocol mechanism applies to all stdio Agent providers and is not a
Copilot adapter feature. Browser reconnect has a grace period and proof-based
restoration. Track, history, recording, and background observation do not steal
control. Native CLI handoff still requires the separate release invariants above.
