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
export AGENT_HOST_OPENCODE_URL=http://127.0.0.1:4096
export AGENT_HOST_OPENCODE_PASSWORD='choose-a-local-password'
# Optional: defaults to opencode, matching the native server.
export AGENT_HOST_OPENCODE_USERNAME=opencode
```

Controller detects a reachable, healthy OpenCode server (1.18.18 or newer) automatically. Website Settings can disable it per Host; detecting it does not start the server or change its credentials. The URL defaults to `http://127.0.0.1:4096`; it must not contain credentials, a query or a fragment. Basic credentials stay in local configuration, never in persistence handles or public events. Controller's existing workspace admission policy still applies to each native session's actual directory, including direct-ID opens.

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

- Native history, text/reasoning, shell exit status and duration, file diffs, output images, todos and compaction map to normalized events. Initial history is bounded; older pages use native cursors. Ordinary text deltas and tool lifecycle updates preserve the Relay epoch, including after todos and answered interactions.
- Native session token/cost aggregates are used when supplied. Otherwise tokens describe the latest useful model step; paginated history is not summed into an invented lifetime total. Context capacity comes from the native model catalog.
- Permissions and questions are read from native pending lists and reconciled after reconnect, including requests answered by another client. Plan exit remains the native question/answer flow, not a fabricated plan-approval request.
- Image input and output use bounded adapter resources. Native local output files are readable only for a loopback server and only through validated resource locators; remote URLs and arbitrary paths are not fetched.
- Model, agent, model-specific variant and permission settings persist in the native session. External switch events refresh these settings. Variants keep their native meaning; they are not universally equivalent to Codex reasoning effort.
- Native skills, custom commands and MCP prompt commands use the server catalog and refreshed documentation resources. Manual compact calls native summarization. Commands wait until the native turn and pending interactions finish. Immediate input and steer can join active native work without aborting it; a separate next-turn queue is not advertised.
- Native titles use existing Host operation deduplication and cross-browser broadcasts. Unchanged titles are not written again.
- Native prompt editing forks strictly before the selected user message and uses the existing favorite/Track replacement flow. It does not revert the original workspace. Active turns, pending interactions, child prompt edits and unresolved native reverts are rejected.
- Parent runtime information includes direct native children, current observed status and native task provenance where available. Child navigation validates the native parent identity and canonical workspace before opening.
- Transport recovery reconciles messages and pending state without replaying uncertain input. Legacy immediate/steer input retains the same native history, including during model and tool execution. Unknown admissions wait for matching native evidence and are never automatically replayed. Host callback tools and dynamic Ask/source reads require [explicit native plugin setup](opencode-callbacks.md); an unconfigured server remains usable for ordinary sessions. The newer durable runner has an independent history and cannot safely replace only the sending endpoint. Ordinary MCP callbacks do not carry trusted native session identity for Ask authorization. See [verified native boundaries](opencode-native-boundaries.md).

For a repeatable live Session View, two-client observation, recording and replay workflow, see [OpenCode ARDB development](opencode-debugging.md).

## Validation

The integration pins `@opencode-ai/sdk` 1.18.31 and is native-smoke tested against OpenCode 1.18.18. It uses established session/global-event endpoints and the mounted experimental global session list for discovery across projects. Generated durable Session v2 APIs are not assumed interchangeable with this execution path.

```sh
pnpm --filter @orchardworks/agent-remote-debugger... build
pnpm test:opencode
AGENT_OPENCODE_TEST_EXECUTABLE=/absolute/path/to/opencode pnpm test:opencode:native
```

The native suite isolates HOME/XDG data and starts both a real OpenCode server and a deterministic local model HTTP fixture. It verifies actual native execution/streaming, native title persistence, history pagination, cross-project discovery, resume, two shared ARDB clients and shared service lifetime without using personal model accounts. It is not evidence of a successful call to a commercial model service.
