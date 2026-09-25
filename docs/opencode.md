# OpenCode shared provider

OpenCode uses the official JavaScript SDK over HTTP and SSE. Its native server owns sessions and running tasks; Controller and ARDB are clients. The normal product Session View, Favorites, Track and native session rename are reused.

## Start the native server

Install OpenCode and configure its model/provider credentials using OpenCode's own tooling. This integration does not supply model credentials or reuse another provider's login.

Start an independent server on the Host machine:

```sh
OPENCODE_SERVER_PASSWORD='choose-a-local-password' opencode serve --hostname 127.0.0.1 --port 4096
```

Keep this process running, or manage it with your operating system's service manager. The Controller does not silently start, restart or upgrade OpenCode. Binding to loopback keeps the native HTTP interface local; the existing Controller/Relay connection supplies remote access.

PowerShell:

```powershell
$env:OPENCODE_SERVER_PASSWORD = 'choose-a-local-password'
opencode serve --hostname 127.0.0.1 --port 4096
```

## Configure Controller

Set these variables in the Controller's local environment before running the usual Controller start/connect command:

```sh
export AGENT_HOST_PROVIDERS=codex,claude,copilot,opencode
export AGENT_HOST_OPENCODE_URL=http://127.0.0.1:4096
export AGENT_HOST_OPENCODE_PASSWORD='choose-a-local-password'
# Optional: defaults to opencode, matching the native server.
export AGENT_HOST_OPENCODE_USERNAME=opencode
```

Select only the providers installed and configured on this machine. For OpenCode alone use `AGENT_HOST_PROVIDERS=opencode`. The URL defaults to `http://127.0.0.1:4096`; it must not contain credentials, a query or a fragment. Basic credentials stay in local configuration, never in persistence handles or public events. Controller's existing workspace admission policy still applies to each native session's actual directory, including direct-ID opens.

OpenCode is a shared runtime. As with Codex shared, its native execution policy is trusted by default. `AGENT_HOST_OPENCODE_TRUST_SHARED=0` requests the Host's restricted policy instead. An external server cannot enforce that additional sandbox, so a restricted registration is rejected explicitly; the Controller does not claim restrictions it cannot enforce. Explicit full-control Host configuration can also authorize native execution.

## CLI and web share the same runtime

```sh
agent-remote-controller opencode resume <native-session-id>
```

This wrapper reads the Controller's configured endpoint and credentials and runs native `opencode attach`. `AGENT_HOST_OPENCODE` optionally selects the CLI executable. `resume --last` attaches with native `--continue`. Running the wrapper without arguments opens the attached TUI for the current directory.

Direct native usage also works:

```sh
OPENCODE_SERVER_PASSWORD='choose-a-local-password' opencode attach http://127.0.0.1:4096 --session <native-session-id>
```

A separate `opencode`/`opencode serve` process is a different runtime. Attaching to the same server is necessary to share live execution. There is no Take control lease: browser and native clients can observe and operate the same session. Native arbitration applies to simultaneous operations.

Closing a view, releasing an idle subscription, stopping ARDB or upgrading Controller does not abort native work. Explicit Cancel calls native abort. Stopping the OpenCode server itself is a separate administrative action.

## ARDB

With the same local endpoint/credential variables:

```sh
pnpm ardb server --provider opencode --cwd /path/to/project --open --jsonl > session.jsonl
```

The floating Live provider selector also includes OpenCode. It uses server-side configuration; credentials and native endpoint selection are not browser inputs. Use the existing persistence-handle export/resume path (`--persistence-file`) to reopen an existing native session. ARDB observation, controls, recording and playback use the existing Remote protocol.

## Capabilities and recovery

- Native history, text/reasoning, tool results, todos, compaction and usage map to normalized events. Initial history is bounded and older pages use the native server cursor. Token usage describes the latest native model step; a session-wide total cost is omitted because a partial history cannot establish it.
- Permissions and questions are read from native pending lists and reconciled after reconnect, including requests answered by another client.
- Image input uses bounded SDK data payloads. Resource reads are limited to adapter-owned embedded image resources, not arbitrary filesystem paths or URLs.
- Native model/agent selections and custom commands use catalogs from the connected server. Selections apply to the next prompt; an unsent local selection is not a native persisted session setting. Reopening restores the last native message selection. Unsupported settings and delivery modes fail explicitly.
- Native titles are updated through the same Host operation deduplication and cross-browser title broadcast path as other providers. An unchanged title is not written again.
- Transport disconnects update connection state. Recovery reconciles native messages and pending state without replaying user input. Message/part identity prevents final snapshots from duplicating streamed output.
- Explicit queued/steer delivery, Host callback tools and prompt editing/fork are not exposed. Native revert can affect workspace files, so it is not substituted for the product's prompt-edit semantics.
- Child sessions can be listed/opened independently. Parent-attached child projections are not currently supplied.

## Validation

The integration pins `@opencode-ai/sdk` 1.18.31 and is native-smoke tested against OpenCode 1.18.18. It uses established session/global-event endpoints and the mounted experimental global session list for discovery across projects. Generated durable Session v2 APIs are not assumed interchangeable with this execution path.

```sh
pnpm --filter @orchardworks/agent-remote-debugger... build
pnpm test:opencode
AGENT_OPENCODE_TEST_EXECUTABLE=/absolute/path/to/opencode pnpm test:opencode:native
```

The native suite isolates HOME/XDG data and starts both a real OpenCode server and a deterministic local model HTTP fixture. It verifies actual native execution/streaming, native title persistence, history pagination, cross-project discovery, resume, two shared ARDB clients and shared service lifetime without using personal model accounts. It is not evidence of a successful call to a commercial model service.
