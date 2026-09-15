# Shared Codex sessions across devices

The Codex provider can connect to an existing native app-server through its local
Unix WebSocket. A desktop CLI and the Remote Controller can then send messages,
steer active work, and respond to interactions on the same native thread. There
is one writer in the daemon and multiple subscribed clients, with no history fork
or process takeover.

## Setup

Use a Codex installation with native local app-server support. This integration
was tested with Codex 0.153.4 on macOS. Keep the complete native installation,
including `codex-code-mode-host`, instead of copying only the main executable.

Start the native daemon and connect the desktop terminal to it:

```sh
codex app-server daemon start
codex --remote unix://
# To reopen a saved session in that same daemon:
codex --remote unix:// resume <native-session-id>
```

Configure the Agent Host locally before starting it:

```sh
export AGENT_HOST_CODEX_CONNECTION=shared
export AGENT_HOST_CODEX_TRUST_SHARED=1
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

## Ownership and permission boundaries

- `private` remains the default connection mode and creates an isolated
  app-server process for each provider session. `shared` never silently falls
  back to a private runtime if the daemon is missing or disconnected.
- Shared mode uses native WebSocket JSON-RPC over the local Unix socket. The
  native `app-server proxy` command forwards bytes; it does not translate the
  WebSocket handshake into newline-delimited JSON.
- `AGENT_HOST_CODEX_TRUST_SHARED=1` explicitly accepts the shared daemon's native
  permissions for Codex only. It does not change Claude or Copilot restrictions.
  A connected client cannot independently sandbox work already running in a
  shared thread. The existing Host workspace/grant checks remain in effect.
- Closing a Remote session closes its connection, not the daemon or another
  subscriber. Native daemon lifetime and idle thread unloading remain native
  policies. A broken native socket is surfaced as a failed session. Restore the
  native daemon and restart the Host to discard failed cached bindings; automatic
  native reconnection is not implemented. Ordinary browser reconnects continue
  using the existing healthy Host connection.
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
- This adds no TCP listener, cloud endpoint, new Remote protocol message or
  capability for terminating arbitrary processes. Windows socket transport has
  not been validated.

## Verification

`shared-runtime.local.test.ts` runs two independent provider clients against one
real native Codex app-server and a local deterministic Responses fixture. No
cloud model request or real user session is used. It covers simultaneous attach,
history, live messages from either client, continued use after one client closes,
late-join question replay, duplicate-answer rejection, and disconnection while
the other client still has a pending question, and explicit failure after daemon loss.

```sh
AGENT_REMOTE_SHARED_CODEX_TEST_EXECUTABLE=/path/to/codex \
  pnpm test:codex-shared
```

Native tests opt in through this executable setting; ordinary provider tests
cover configuration rejection and missing-socket errors without running Codex.
