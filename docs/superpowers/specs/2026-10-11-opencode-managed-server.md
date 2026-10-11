# Controller-managed OpenCode server

## Problem and scope

An installed OpenCode CLI should be enough for Controller to make the provider
available after native model authentication. Requiring an operator to discover
`opencode serve`, configure authentication and maintain another startup service
leaves a supported installation invisible in the product.

Add local server lifecycle management to the Host. Keep the existing OpenCode
SDK HTTP/SSE adapter, native session identity, shared control, directory admission
and Session View contracts. The native server still owns session execution;
Controller manages a process that can outlive its own connection and updates.

This specification defines the intended behavior and validation requirements.
It does not claim a completed test run, release or deployment.

## Configuration and discovery

The default endpoint is `http://127.0.0.1:4096`. Unless startup is disabled,
Controller ensures the default server during provider discovery at startup and
every minute. Discovery first checks the existing endpoint. A supported healthy
service can be reused even without a locally installed CLI.

When the endpoint is absent, resolve the installed CLI through the existing native
executable boundary and validate its supported version before spawning it. Use
`AGENT_HOST_OPENCODE` when configured. Never install, update or authenticate a CLI
as a side effect of discovery. Model credentials stay in the native profile.

Configuration modes:

| Configuration | Lifecycle behavior |
| --- | --- |
| Default local endpoint, startup allowed | Reuse healthy server or start installed CLI |
| `AGENT_HOST_OPENCODE_AUTO_START=0` | Observe available server; do not start automatically |
| Custom endpoint without startup opt-in | External lifecycle only |
| Custom loopback endpoint with `AGENT_HOST_OPENCODE_AUTO_START=1` | Explicitly authorized local lifecycle management |
| Custom non-loopback endpoint | External lifecycle only; never launch a public listener |
| Website provider disabled | Do not discover or recover automatically; leave native work running |
| Persistent `server stop` preference | Suppress automatic startup until explicit `server start` |

The URL has no embedded credentials, query or fragment. Normalize endpoint
identity before using it as a private configuration scope. A custom port supports
isolated validation without interfering with a user's default native service.

An already registered provider still receives the lifecycle ensure check. Do not
skip recovery merely because its adapter and directory already exist. Reuse
those objects and their endpoint/credentials; do not create a second observation
or change session binding identities during recovery.

## Process ownership and readiness

A detached Node supervisor owns one native child and serves a bounded,
token-authenticated management interface on an ephemeral loopback port. Its
generation and management address are published in private state only after its
child confirms readiness. The native fixed HTTP endpoint is the exclusive bind;
there is no independent stale-lock or fixed management-socket cleanup protocol.

Concurrent starts may briefly spawn competing children. A supervisor is ready
only if its own child reports the exact requested listening URL and authenticated
health succeeds at that endpoint. Native port fallback is rejected and only the
losing supervisor's child is stopped. The endpoint contributes to native session
namespace and reference identity; an alternate port cannot substitute for it.

A pre-existing healthy service is usable but remains external. An authentication
failure, occupied port, unknown listener or still-running unhealthy owned child
does not authorize starting a competing process or killing the listener. Lifecycle
diagnostics distinguish these conditions from an absent CLI or exited process.

Only a supervisor holding a live child reference can stop that native process.
Never kill a process by a PID recovered from a file. If the supervisor disappears
while its child remains healthy, reconnect as an externally owned service; stale
metadata does not prove process ownership.

An owner record is a rendezvous pointer, not a liveness assertion. Query the
authenticated management endpoint for live state. Leave stale owner pointers in
place after exit and atomically replace them after a new owner becomes ready.
Do not implement read-generation-then-unlink cleanup: a newer owner can publish
between the comparison and deletion.

## Credentials and local state

Create the native Basic Auth password once in endpoint-scoped private state.
Use atomic no-overwrite creation so concurrent first starts share one credential
instead of overwriting each other. Keep explicit username/password configuration
effective and stable when supplied. The supervisor management token is separate
from the native password and tied to its generation.

Credentials are never arguments, diagnostics, public events, persistence handles
or recording content. Children receive the existing sanitized native environment;
the lifecycle feature does not introduce a second full environment snapshot on
disk. Files and their parent directory are private; Windows installations rely
on the user's state-directory ACLs rather than Unix file modes.

Existing adapter authentication must survive native recovery. Determine the
default endpoint's effective credentials before creating its registration, even
when initially reusing a service without authentication. If that external service
later exits and a managed server is started, the existing transport must already
use the same credentials. Do not rotate them as part of discovery or an update.

## Lifecycle commands and recovery

Expose the following Controller CLI commands using its existing private
configuration resolution:

```sh
agent-remote-controller opencode server start
agent-remote-controller opencode server stop
agent-remote-controller opencode server restart
agent-remote-controller opencode server status
```

`start` clears the persistent stop preference and ensures the authorized server.
`stop` records the preference before asking a live owner to terminate its child.
`restart` is an explicit administrative interruption and never takes ownership of
an external server. `status` reports observed lifecycle/readiness without exposing
credentials or trusting a stale PID.

An in-flight automatic start must not undo manual stop. Carry the preference
revision through startup and recheck before starting and after readiness. When
the preference changes or becomes disabled, the supervisor stops only its own
new child. Tests must cover stop during a delayed startup, not just stop after
registration.

Controller owns the automatic recovery schedule; the supervisor does not run a
second native restart loop. When an enabled managed native process has exited,
the next provider scan can recreate it. A still-running unhealthy process remains
available for diagnosis and an explicit operator decision. Do not automatically
restart native tasks, replay uncertain messages or turn transport recovery into
a successful operation result.

Controller stop, Relay disconnection, provider disable, subscription release and
Controller update must not terminate a healthy shared OpenCode process. An
explicit native cancel remains a session operation; server stop/restart remains
a separate administrative action.

## Operating-system lifetime

Use the existing Controller login startup on macOS, Linux and Windows. When the
Controller starts after login or reboot, discovery ensures an absent enabled
OpenCode server. No additional permanent system startup installation is required.

On macOS and manual launches, detach the supervisor and native process from the
Controller's process group. On Windows, use the native executable resolution and
background process facilities without opening a console window. Validate actual
service shutdown behavior rather than assuming `detached` overrides a service
manager's process cleanup.

For Controller running in a systemd user service, launch the OpenCode supervisor
in a separate transient user scope. A detached process alone would remain inside
the Controller's cgroup and be killed by its existing `KillMode=mixed` policy.
Keep that policy for Controller-owned resources; scope isolation provides the
shared server lifetime. Pass private environment values through inherited
environment, not `systemd-run` command-line arguments.

A container stop, VM shutdown, system shutdown or user-service termination can
still stop native work. In a manual/container environment without systemd user
services, the surrounding supervisor defines the lifetime. Do not promise native
task continuity across shutdowns or resume tasks merely because the process has
been restarted.

## Boundaries and diagnostics

The Host owns executable discovery, credentials, process lifecycle, operator
preferences and diagnostics. The OpenCode adapter continues to interpret native
runtime facts, recover HTTP/SSE observations and report normalized session state.
No Provider SDK, Remote protocol or browser ownership lease is required.

Preserve actionable safe reasons for unavailable providers and lifecycle failures:
missing/unsupported CLI, auth rejection, port conflict, startup deadline,
unexpected port, unavailable supervisor, manual stop and unhealthy live process.
Do not include native stderr or environment values that might contain secrets.

The callback plugin remains explicitly configured. This change does not install
it, rewrite global native configuration, or restart a running service to load it.
Existing configured callbacks continue to use their current private rendezvous.
ARDB and native attach remain clients of the configured shared server.

## Required validation

Use isolated state directories, free loopback ports, per-test deadlines and an
outer process deadline. Do not stop a user's existing native server or use personal
model credentials.

- Installed CLI plus absent endpoint starts a supported authenticated server;
  absent/unsupported CLI does not trigger installation or registration.
- A healthy managed server is reused with stable credentials; default unauthenticated
  external reuse can transition to the same credentials after exit.
- External, custom and disabled configurations preserve their lifecycle boundaries.
- Multiple starts converge on the requested native endpoint. Port fallback,
  occupied listeners and authentication failures do not create a false registration.
- Stop persists across scans and Controller restarts; start clears it. Stop during
  delayed startup does not leave an automatically revived process.
- Existing registrations recover after native exit without duplicate registration
  or observation. An unhealthy live process is not killed automatically.
- Stale management metadata and supervisor disappearance do not permit PID-based
  termination or deletion of a newer owner's record.
- Controller stop/update leaves the server usable, including a real systemd user
  service lifecycle and native Windows/macOS process behavior where available.
- Local attach reads the same generated credentials; public output and diagnostic
  failures do not reveal native or management secrets.

Record which platform and native scenarios were actually executed before release.
Run the focused suites, package/build checks and the repository compatibility
update/check workflow after the implementation is reviewed.
