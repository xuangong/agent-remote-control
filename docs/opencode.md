# OpenCode shared provider

OpenCode 2.x uses the official `@opencode/client` Promise SDK over HTTP and SSE. The minimum supported native version is 2.0.25; 1.x servers use a different API and are rejected with an explicit upgrade reason. Its native server owns sessions and running tasks; Controller and ARDB are clients. Controller can manage the local server's lifecycle without changing this shared-session model. The normal product Session View, Favorites, Track and native session rename are reused.

## Use the managed local server

Install OpenCode and configure its model/provider credentials using OpenCode's own tooling. This integration does not supply model credentials or reuse another provider's login.

With the usual Controller already running, no separate `opencode serve` command is required. At startup and during its every-minute provider scan, Controller checks `http://127.0.0.1:4096`. If no service is listening and a supported OpenCode CLI is installed, it starts an authenticated, loopback-only server. **Settings → Hosts → Agent providers → Detect again** requests another scan. An absent CLI is reported as unavailable; Controller does not install or upgrade OpenCode.

```sh
agent-remote-controller opencode server status
```

The existing Controller login-startup mechanism provides recovery after a reboot: when Controller starts again, provider discovery starts the missing local server. It does not add a separate machine-wide OpenCode startup service. Native model credentials remain in OpenCode's own profile. Binding to loopback keeps the native HTTP interface local; the existing Controller/Relay connection supplies remote access.

Manage this server from any terminal using the same Controller state directory:

```sh
agent-remote-controller opencode server start
agent-remote-controller opencode server stop
agent-remote-controller opencode server restart
agent-remote-controller opencode server status
```

`stop` persists a local opt-out so the next provider scan or Controller restart does not immediately start it again. `start` clears that opt-out. `restart` is an explicit stop/start operation and can interrupt native work. Website provider disable only stops discovery and new admission; it does not stop a running native server or task.

Stopping, disconnecting or updating Controller leaves the managed OpenCode server running. When the native process exits unexpectedly, a later provider scan may start a replacement, but it never replays uncertain input or resumes an interrupted task automatically. A process that is still alive but fails health checks is reported for diagnosis; Controller does not restart it automatically.

On Linux under the Controller's systemd user service, the OpenCode supervisor runs in a separate user scope so service cleanup does not kill it. In a manual or container launch, the surrounding supervisor defines process lifetime. A user logout, container stop or operating-system shutdown can still end native tasks; login recovery restarts the server process, not unfinished work.

On Windows, a Job Object owns the native process and its descendants and follows the OpenCode supervisor's lifetime, rather than the Controller's. Stopping the managed server or losing its supervisor closes the job; updating Controller alone does not close it. Windows PowerShell is required for the job launcher.

## External servers and configuration

A healthy existing server on the default endpoint is reused without changing its credentials or taking process ownership. Controller's server `stop` and `restart` commands do not terminate an external server. If it requires authentication, configure the matching native credentials locally:

```sh
export AGENT_HOST_OPENCODE_PASSWORD='choose-a-local-password'
# Optional: defaults to opencode, matching the native server.
export AGENT_HOST_OPENCODE_USERNAME=opencode
```

For a managed server, Controller generates a password once and retains it in an endpoint-specific private configuration under its state directory. It reuses that password across discovery scans, Controller upgrades and native restarts. A separate token protects local lifecycle management. Neither credential enters persistence handles, public events, browser configuration or recordings. On Windows, keep the state directory protected by the current user's ACLs; Unix file modes do not configure Windows ACLs.

`AGENT_HOST_OPENCODE` selects a CLI executable explicitly. On macOS and Linux, discovery checks Controller's PATH and common installer locations: `~/.opencode/bin`, `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin` and `/usr/bin`. It does not source shell startup files. Windows uses native executable/npm entry resolution. Set the override for another installation location or a custom wrapper.

`AGENT_HOST_OPENCODE_URL` selects an explicit HTTP endpoint without embedded credentials, a query or a fragment. A custom endpoint remains externally managed by default. For an isolated test or advanced local setup, `AGENT_HOST_OPENCODE_AUTO_START=1` explicitly authorizes Controller to manage a custom loopback endpoint:

```sh
export AGENT_HOST_OPENCODE_URL=http://127.0.0.1:14096
export AGENT_HOST_OPENCODE_AUTO_START=1
```

`AGENT_HOST_OPENCODE_AUTO_START=0` disables automatic startup; an already running healthy server can still be discovered. This setting is separate from website provider disable and the persistent `server stop` preference. Automatic management never binds a public network address.

Controller only registers a healthy, supported server (2.x, 2.0.25 or newer). A port conflict, authentication failure, unsupported version or failed startup produces a diagnostic reason. The requested endpoint is fixed: Controller never accepts OpenCode's fallback to another port, because that would change the native session namespace. It only terminates a failed startup that it owns, never an unrelated listener. Controller's existing workspace admission policy still applies to each native session's actual directory, including direct-ID opens.

To keep full external lifecycle ownership even after a server exit, set `AGENT_HOST_OPENCODE_AUTO_START=0` in Controller's local configuration. Start and supervise OpenCode yourself and set the matching Controller URL and credentials:

```sh
OPENCODE_PASSWORD='choose-a-local-password' opencode serve --hostname 127.0.0.1 --port 4096
```

In PowerShell, set `$env:OPENCODE_PASSWORD = 'choose-a-local-password'` before running the same `opencode serve` command. Keep the service running under your chosen supervisor.

OpenCode is a shared runtime. As with Codex shared, its native execution policy is trusted by default. `AGENT_HOST_OPENCODE_TRUST_SHARED=0` requests the Host's restricted policy instead. An external server cannot enforce that additional sandbox, so a restricted registration is rejected explicitly; the Controller does not claim restrictions it cannot enforce. Explicit full-control Host configuration can also authorize native execution.

## CLI and web share the same runtime

```sh
agent-remote-controller opencode resume <native-session-id>
```

This wrapper reads the Controller's configured endpoint and credentials, including generated managed-server credentials, and runs native `opencode --server <endpoint> --session <id>`. `resume --last` attaches with native `--continue`. Running the wrapper without arguments opens the attached TUI for the current directory.

Direct native usage also works when you provide the configured server credentials:

```sh
OPENCODE_PASSWORD='choose-a-local-password' opencode --server http://127.0.0.1:4096 --session <native-session-id>
```

A separate `opencode`/`opencode serve` process is a different runtime. Attaching to the same server is necessary to share live execution. There is no Take control lease: browser and native clients can observe and operate the same session. Native arbitration applies to simultaneous operations.

Closing a view, releasing an idle subscription, stopping ARDB or upgrading Controller does not abort native work. Explicit Cancel calls the native session interrupt endpoint. Stopping the OpenCode server itself is a separate administrative action.

## ARDB

With the same local endpoint/credential variables:

```sh
pnpm ardb server --provider opencode --cwd /path/to/project --open --jsonl > session.jsonl
```

The floating Live provider selector also includes OpenCode. It uses server-side configuration; credentials and native endpoint selection are not browser inputs. Use the existing persistence-handle export/resume path (`--persistence-file`) to reopen an existing native session. ARDB observation, controls, recording and playback use the existing Remote protocol.

Native callback plugin installation remains explicit. Automatic server management does not install the plugin, rewrite global OpenCode configuration, or restart an existing server to load it. Follow [OpenCode callbacks](opencode-callbacks.md) when enabling Host callback tools or Ask source references.

## Capabilities and recovery

- Native history, text/reasoning, shell exit status and duration, file diffs, output images and compaction map to normalized events. Initial history is bounded; older pages use native cursors. Ordinary text deltas and tool lifecycle updates preserve the Relay epoch, including after answered interactions.
- Native session token/cost aggregates are used when supplied. Otherwise tokens describe the latest useful model step; paginated history is not summed into an invented lifetime total. Context capacity comes from the native model catalog.
- Permissions and forms are read from native pending lists and reconciled after reconnect, including requests answered by another client. Typed forms, custom question choices and single external actions reuse public interactions. Native forms with conditional/hidden fields or other constraints the public contract cannot represent stay pending with an explicit notice; complete those in a native client. The adapter never removes constraints to make a form appear supported. Saved permission approval is a project-wide persistent policy, not a session-only grant.
- Image input and output use bounded adapter resources. Native local output files are readable only for a loopback server and only through validated resource locators; remote URLs and arbitrary paths are not fetched.
- Model, agent, model-specific variant and permission settings persist in the native session. External switch events refresh these settings. Variants keep their native meaning; they are not universally equivalent to Codex reasoning effort.
- Native commands and skills use separate catalogs. Skill documentation is refreshed from native content and skill invocation sends the native skill identity with the prompt. The v2 command catalog does not identify MCP origin or expose command templates, so the adapter does not invent that metadata. Manual compact uses the native compaction inbox and the session model selection. Commands wait until native turn and pending interactions finish. Immediate input and steer use the same v2 session inbox and can join native execution without aborting it.
- Native titles use existing Host operation deduplication and cross-browser broadcasts. Unchanged titles are not written again.
- Native prompt editing forks strictly before the selected user message and uses the existing favorite/Track replacement flow. It does not revert the original workspace. Active turns, pending interactions, child prompt edits and unresolved native reverts are rejected.
- Parent runtime information includes direct native children, current observed status and native task provenance where available. Child navigation validates the native parent identity and canonical workspace before opening.
- Transport recovery reconciles v2 messages, native execution state, inbox admissions and pending interactions without replaying uncertain input. Unknown admissions wait for matching native inbox/message evidence and are never automatically replayed. Host callback tools and dynamic Ask/source reads require [explicit native plugin setup](opencode-callbacks.md); an unconfigured server remains usable for ordinary sessions. Ordinary MCP callbacks do not carry trusted native session identity for Ask authorization. Native history and sending use the same v2 execution path.

For a repeatable live Session View, two-client observation, recording and replay workflow, see [OpenCode ARDB development](opencode-debugging.md).

## Session succession

Handoff is explicitly unavailable for the current OpenCode 2.x adapter. Ordinary
discovery, shared sessions, native forks and callbacks remain supported. OpenCode's
default public history can establish ordinary input execution but cannot prove
the complete historical system-instruction selection required by ARC's prepared
first-input contract. Its experimental event log is not persisted by default.

The adapter reports this capability gap before creating a Handoff candidate or
dispatching a prepared input. Installing the callback plugin does not remove the
gap. A reviewed additional native recording mechanism is required before enabling
Handoff; the adapter never guesses a positive result from current settings or
automatically resends uncertain input. See [native boundaries](opencode-native-boundaries.md)
and the [recovery contract](current/agent-remote/session-succession-recovery.md).

## Validation

The integration pins `@opencode/client` 2.0.25. Native identity is checked through `/api/info`; discovery uses `/api/session`, history uses the cursor-based message list, and live observation uses `/api/event`. Session model/agent changes use native switch operations and settings settle only after authoritative readback. The adapter does not retain a parallel 1.x execution path. The isolated native suite below targets the actual 2.0.25 executable; passing HTTP fixtures alone is not evidence that the native suite passed.

```sh
pnpm --filter @orchardworks/agent-remote-debugger... build
pnpm test:opencode
AGENT_OPENCODE_TEST_EXECUTABLE=/absolute/path/to/opencode pnpm test:opencode:native
AGENT_OPENCODE_TEST_EXECUTABLE=/absolute/path/to/opencode node scripts/run-tests.mjs opencode-succession-adapter
```

The native suite isolates HOME/XDG data and starts both a real OpenCode server and a deterministic local model HTTP fixture. It verifies actual native execution/streaming, native title persistence, history pagination, cross-project discovery, resume, two shared ARDB clients and shared service lifetime without using personal model accounts. It is not evidence of a successful call to a commercial model service.
