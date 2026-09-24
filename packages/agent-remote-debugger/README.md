# ARDB — Agent Remote Debugger

`ardb` is the **headless Session View** and its debugger. Session View is the core interaction surface around which Agent Remote Control is organized. Sidebar navigation, session management, diagnostics, security and other product controls support that view.

The package name is `@orchardworks/agent-remote-debugger`; the executable is `ardb` and the repository entry is `pnpm ardb`. It is independent of `agent-remote-controller`, which runs Hosts and has no debugger subcommand.

Today, `ardb` exercises Session View's public protocol and reconstructed state through the same transport, session client and Replica as the product browser. CLI and structured output replace visual presentation; the shared client remains responsible for synchronization and operation correlation. `ardb server` also serves the product Session View against a locally owned Relay. An automated scenario-runner command remains a future extension. Native runtime interpretation remains in Provider adapters.

## Run locally

Build the package before invoking the executable:

```bash
pnpm --filter @orchardworks/agent-remote-debugger... run build
pnpm ardb --help
```

The Relay URL resolves from `--relay`, then `AGENT_REMOTE_URL`, then `BORGEE_REMOTE_URL`, then `http://127.0.0.1:5910`. WebSocket commands resolve their Origin from `--origin`, then `AGENT_REMOTE_ORIGIN`, then `BORGEE_REMOTE_ORIGIN`, then `http://127.0.0.1:6175`.

Commands target the **public Relay Agent ID**, not an arbitrary native Codex/Claude session ID. `session create` chooses a public Agent ID; `--provider-session-id` supplies the separate native identity when supported. An already attached session can be observed by its public Agent ID. `session resume` requires an exact persistence handle, not a bare native ID.

Client commands expect an existing reachable Relay and appropriate access. `server` serves the workbench; selecting Live starts a local Relay and an adapter-owned native session. Neither performs hosted browser sign-in nor imports browser cookies. `--origin` supplies the WebSocket Origin; it is not an authentication credential.

## Serve a Session View

```bash
ardb server --open
# Or start directly with a live session:
ardb server --provider codex --cwd /path/to/workspace --open --jsonl
# Or: --provider claude / --provider copilot / --adapter /path/to/adapter.mjs
```

Without a Provider option, the server starts without a native process. In the compact top-right controls, select **Live**, choose a Provider and working directory, and click **Start live session**. The optional executable path is on the server machine. Select **Replay** to open a server recording. **Clear view** unloads the recording and clears the displayed view; it does not delete files or change native history. Select Live to display the retained session again. Both modes share one URL; switching preserves the live session, recording capture, and playback position. `ardb replay FILE` selects the initial recording but exposes the same Live controls. Starting Live never resumes or re-executes operations from that file.

With a Provider option, the first `server_ready` record prints the URL, public Agent ID, native session ID, and copyable client commands. `--port 0` (default) selects a free loopback port; `--open` opens a browser. `--timeout` is the startup deadline in milliseconds (default 30000). An optional `--executable` selects a native binary, and `--model` / `--reasoning-effort` supply creation settings. `--persistence-file handle.json` resumes through the selected Adapter; do not combine resume with creation settings.

The page is the actual product `LabWorkbench` and `useConversationSession`, bundled into this package. It mounts Timeline, Chatbox and their normal capability-driven controls without account, Sidebar, Host or Tunnel contexts. It calls the existing public Relay HTTP/WebSocket endpoints. Opening another tab, refreshing or reconnecting subscribes to the same owned session; it never creates a second native session.

Use another terminal to drive the live view (substitute the printed values):

```bash
export AGENT_REMOTE_URL=http://127.0.0.1:PORT
export AGENT_REMOTE_ORIGIN=$AGENT_REMOTE_URL
ardb send AGENT_ID "Explain this workspace" --wait idle --json
ardb settings list AGENT_ID --json
ardb settings set AGENT_ID SETTING_ID VALUE --json
ardb interaction list AGENT_ID --json
ardb interaction respond AGENT_ID REQUEST_ID --response-file answer.json --json
ardb cancel AGENT_ID --json
ardb inspect AGENT_ID --json
ardb observe AGENT_ID --jsonl
```

Agent normalized events, interpreted by the Adapter and projected by the Relay, remain authoritative. A CLI operation is an intent; subscribed views receive its resulting state through their normal subscriptions. The debugger does not inject synthetic success into the page. Client-local pending inputs remain local until acknowledged and reconciled by the shared client.

The server emits `source: relay` Replica records and `source: browser` / `kind: browser_trace` metadata. Browser records include client identity, connection state, protocol direction/channel/type and request ID; they omit message payloads, input values and resource bytes. This diagnostic channel is best-effort, bounded to 64 queued records, and reports dropped records after delivery resumes. Page shutdown may lose its final diagnostic batch. It never changes public operation outcomes. Use `observe`, `inspect` and `protocol trace` as independent clients for state assertions and detailed redacted protocol inspection. Output may include conversation content. `server --jsonl` can be replayed as recorded Session View state; browser metadata is not used to drive playback.

The server accepts only its exact loopback Host/Origin. It owns one session, so its public create/resume endpoints reject new sessions; start a separate server for another native session. SIGINT/SIGTERM gracefully stop the server and dispose its owned session and temporary images. Codex defaults to a private app-server; it does not restart or alter an existing shared daemon. Each Adapter remains responsible for terminating its native resources, including failed startup.

A trusted local Adapter module exports `createAdapter()` returning an `AgentProviderAdapter`, optionally with an async `dispose()` for provider-wide resources. It is loaded only from CLI configuration. Native normalization, capabilities, history boundaries, controls and stdio ownership stay in that Adapter; ARDB does not reinterpret native messages.

## Record human and AI collaboration

Start `ardb server --provider codex --open` (or another supported provider) and use
the shared Session View normally. Expand the top-right controls and choose **Record**, then collapse
the floating controls to keep the view clear. **Stop recording** stops only capture;
**Export JSONL** downloads a file compatible with `ardb replay`.

Capture runs in the ARDB server, starts with the current loaded baseline and includes
subsequent session changes from every browser and CLI client. Refreshing the browser,
closing it, or reviewing a recording does not stop capture or the Agent. A small red
indicator remains visible while recording. The current recording is kept in server
memory until replacement or server exit. Export before either; capture stops at 64 MiB.
Starting another recording requires explicit replacement of the current recording ID,
so stale tabs cannot accidentally replace or stop a different capture.

Expand **Connect an AI or CLI client** to copy the exact `ardb observe ... --jsonl`
command. Give it to an AI agent running on the same machine. It can listen while you
operate the browser, inspect state and use the existing send/settings/interaction
commands against the same Relay and public Agent ID. This is a shared protocol
subscription, not an extra AI account or a second native session. Existing capability,
readiness and operation checks apply equally to browser and CLI clients.

The live controls also open server recordings. **Live** returns to
the same Agent; capture and external observers continue while a recording is displayed.
The server remains loopback-only with Host/Origin checks. This does not enable remote
network access to the machine or add hosted authentication.

## Record and replay

Keep `server` running in one terminal and use independent commands or the browser to interact with it:

```bash
ardb server --provider codex --open --jsonl > session.jsonl
# Stop with Ctrl+C after the interaction you want to share.
ardb replay session.jsonl --open
```

Replay starts paused with the captured baseline. Play/pause, playback speed (0.5× to 4×), a seek slider, restart and step-to-next-event controls help locate a specific moment. Events sharing a timestamp are applied in file order as one step. Playback pauses when its tab becomes hidden. **Open recording** browses directories and JSONL/NDJSON files on the machine running ARDB. It starts in the replay file directory (or the live server workspace); enter a server path or navigate folders. It never opens a browser upload picker. A valid file replaces the current recording and starts paused; an invalid file leaves the current recording intact and shows the error. The same product Timeline and composer render recorded state; input and operation controls are read-only. Merely opening or playing a recording does not create an Adapter, Relay, native process or WebSocket, and never retries recorded commands. Explicitly selecting Live can start a new native session; an existing live connection continues while viewing Replay.

This is a **Session View event recording**, not a screen video. It captures the observer's loaded Timeline, Agent/runtime settings, interactions, resource metadata and connection status, with event timing. It does not capture typing drafts, pointer movements, scroll position, every token's native timing, browser-local send receipts, unavailable older history, or network frames. Browser trace metadata is retained for inspection but ignored during playback. Resource bodies, uploaded images and sensitive fields are not embedded; missing-resource notes appear in the player and it never contacts the original Host for those resources.

New server recordings include versioned `recording_start` / `recording_end` markers. For startup with a Provider, `server_ready` is emitted only after the recording subscriber has captured its initial baseline. With a deferred Provider and `--jsonl`, `server_ready` announces the workbench URL; after the user starts Live, `recording_start` and the baseline precede a second `server_ready` record with `mode: live`. Existing `observe --jsonl` and older server JSONL files using record schema 1.1.0 remain replayable; a note reports unknown completion when there is no closing marker. An unfinished last JSON line can be discarded with a visible warning. Malformed middle lines, unsupported versions, mixed sessions and missing baselines are rejected with actionable errors. Wall-clock regressions preserve file order and produce a warning. The initial loaded baseline is presented at time zero. The first version accepts files up to 64 MiB.

To generate a repeatable demonstration from the repository:

```bash
pnpm --filter @orchardworks/agent-remote-debugger... run build
node packages/agent-remote-debugger/scripts/record-demo.mjs /tmp/session.jsonl
pnpm ardb replay /tmp/session.jsonl --open
```

The script refuses to overwrite an existing file. It drives separate CLI processes through a real loopback Relay and a deterministic stdio test Agent: send a message, change reasoning effort, request and answer approval, cancel active work, then send a final message. It has bounded waits and shuts down only its own processes. This demonstrates transport and renderer behavior, not authenticated Codex/Claude/Copilot behavior. The recorder script is repository tooling; the built `replay` command and its assets are included in the debugger package.

## Current capabilities

| Command | Current behavior |
| --- | --- |
| `server` | Owns a local Relay/session and serves the product Timeline + Chatbox; emits Replica records and browser protocol metadata. |
| `replay <session.jsonl>` | Replays recorded state in the product Session View without connecting to an Agent. |
| `settings list/set` | Lists native session settings or changes a declared setting through the shared client. Values are Provider-defined. |
| `provider list` | Lists Providers exposed by the Relay. This is not Host or native session discovery. |
| `session create` | Creates through the Relay with a Provider and optional native session ID, working directory, model, reasoning effort, system prompt and planning preference. Availability depends on the Relay and Provider. |
| `session resume` | Restores through the Relay using an exact persistence-handle JSON file or stdin. |
| `inspect` | Prints the reconstructed Replica: Agent Snapshot/runtime information, loaded Timeline, interactions, resources, synchronization state and diagnostics. |
| `timeline` | Prints normalized Timeline entries; `--tail N` selects the loaded tail, `--all` loads older pages, and `--follow` streams subsequent changes. |
| `observe` | Streams connection, Agent, Timeline reset/upsert, interaction, resource, diagnostic and checkpoint records from the shared Replica. |
| `protocol trace` | Observes validated public HTTP/WebSocket messages, with direction, channel, message type and request ID when present. Includes protocol diagnostics; it is not raw network or native CLI capture. |
| `send`, `steer` | Sends text from an argument, file or stdin and waits for the correlated result; optional `--wait` waits for a subsequent condition. |
| `cancel` | Requests cancellation when the session declares support. |
| `planning` | Sets planning on/off when the session declares support. |
| `wait` | Waits for `idle`, `interaction` or `failed`. |
| `interaction list/respond` | Lists outstanding typed interactions and submits a schema-validated response to an exact request ID, subject to the session capability. |
| `resource get` | Retrieves a referenced public resource, verifies its byte count and SHA-256, and writes a file atomically or emits bytes on stdout. |

These are Provider-neutral public operations. Support depends on the connected session's capabilities; the debugger does not fabricate missing native behavior.

## Debugging Session View

`ardb` uses the same `HttpWebSocketTransport`, `RemoteSessionClient` and `AgentReplica` as the product browser. It can therefore inspect the protocol and reconstructed state underlying the session view, including history/live synchronization and operation acknowledgements.

Use `protocol trace` for the public messages, `observe` for the resulting state changes, and `inspect` for a current state snapshot. Each invocation is an independent client: it does not intercept another browser tab's private connection, DOM or local UI state. It can observe changes to the same Relay session, and tests can compare the independent clients' resulting state.

## Headless regression scope

Use `ardb` as a headless Session View to exercise the non-rendering contract between a view and its Server: protocol negotiation, Snapshot/history/live synchronization, reconnect recovery, operation acknowledgement/error handling, interactions and resource delivery. CLI actions drive the public client path; structured records and exit codes let scripts assert the resulting state. The existing built-process suite uses real HTTP/WebSocket transports to verify these behaviors and compare independently reconstructed clients.

Keep reusable session behavior in the shared client/Replica so the product and `ardb` exercise the same implementation. Behavior that exists only in browser hooks is not automatically covered by a headless run. DOM/layout, focus, keyboard/touch handling and browser-specific lifecycle behavior still require browser tests. Provider-native parsing still requires adapter tests; the headless view only sees the public result.

Current commands can be composed into regression scripts. A common scenario runner and reusable assertions would build on this headless view; there is no `ardb test` command yet.

## Two-terminal workflow

Create the Agent once before opening an observer. Then keep a JSONL observer open in one terminal while a second terminal sends controls. Each process owns its own reconstructed Replica, so an observer can be restarted later and reconstruct Relay history.

```bash
# Initialize the Agent once
pnpm ardb session create example-agent --provider recorded --json

# Terminal A
pnpm ardb observe example-agent --jsonl

# Terminal B
pnpm ardb send example-agent "Summarize the trace." --wait idle --json
```

Use `--until idle`, `--until interaction`, or `--until failed` to make a stream finite. An explicit `--timeout <milliseconds>` is one deadline for the whole command, including readiness, acknowledgement, and any later wait; a stream without `--timeout` or `--until` remains open until interrupted.

## Command tree

```text
ardb
|-- server --provider <codex|claude|copilot> [--open]
|-- server --adapter <module-path> [--open]
|-- replay <session.jsonl> [--open]
|-- settings list <agent-id>
|-- settings set <agent-id> <setting-id> <value>
|-- provider list
|-- session create <agent-id> --provider <provider-id>
|-- session resume <agent-id> --persistence-file <path|->
|-- observe <agent-id>
|-- inspect <agent-id>
|-- timeline <agent-id>
|-- send <agent-id> [message]
|-- steer <agent-id> [message]
|-- cancel <agent-id>
|-- planning <agent-id> <on|off>
|-- wait <agent-id> --for <idle|interaction|failed>
|-- interaction
|   |-- list <agent-id>
|   `-- respond <agent-id> <request-id> --response-file <path|->
|-- resource
|   `-- get <agent-id> <resource-id> --output <path|->
`-- protocol
    `-- trace <agent-id> --jsonl
```

`send` and `steer` accept message text as an argument or from `--file <path|->`; their success output follows a correlated Relay acknowledgement. With `--wait idle`, the command waits for the affected turn to become active and then finish instead of treating unrelated Timeline, resource, or diagnostic traffic as progress. `interaction respond` accepts one exact public interaction-response JSON value. `resource get` writes decoded bytes only after a correlated available response whose byte length and SHA-256 both match. File output uses an atomic same-directory replacement; `--output -` deliberately makes stdout the byte stream while metadata remains on stderr.

## Output and exits

One-shot commands support `text` or `json`; streaming commands support `text` or `jsonl`. `--json` and `--jsonl` are aliases for the corresponding format. JSON is exactly one value plus a newline, JSONL is one object per line, and diagnostics plus structured errors are written to stderr.

| Exit code | Meaning |
| ---: | --- |
| `0` | The command completed or its requested condition was reached. |
| `2` | Arguments, local input, or input JSON were invalid. |
| `3` | Relay connection or authorization failed. |
| `4` | The public protocol rejected the operation or validation failed. |
| `5` | The requested condition or command timed out. |
| `130` | A client command received SIGINT. `server` and `replay` exit successfully after graceful SIGINT/SIGTERM cleanup. |

Structured errors identify a stable code, message, and recoverability independently of the exit category.

## Observation boundaries

`observe` projects the reconstructed public Replica into stable records: connection state, Agent snapshot, Timeline state, interactions, resources, diagnostics, and a checkpoint. It is not a direct DSH inspection channel.

A DSH image attachment is Provider-native input that the DSH adapter recognizes as an opaque `dsh-attachment:` locator and exposes as a public Relay resource. The debugger can observe the resulting public Timeline/resource metadata and retrieve its bytes through `resource get`, but it neither reads DSH attachment services nor interprets the DSH event that produced it.

`protocol trace` records validated public HTTP and WebSocket messages before debugger presentation, including direction and transport channel. It is not a Provider-native trace: DSH, Codex, and any other Provider logs and events end at their respective adapters. Trace output omits available resource content and retains only a byte-length and digest marker.

## Current gaps

The following are not implemented CLI features:

- Native raw-event recording and re-execution of recorded operations. The command is `server`, not `serve`; native process/stdin/stdout handling remains owned by the selected Adapter.
- A unified scenario runner, test-profile format, fault-injection controls, or regression report command. Existing package tests exercise the CLI; they are not an `ardb test` user command.
- Host pairing/catalog, native session listing, directory/child attachment or controller lifecycle management. An already bound child can be addressed by public Agent ID within its capabilities.
- Provider command discovery/execution, CLI image input or explicit next-turn delivery. Use existing product/headless APIs where supported; slash text is not equivalent to a typed command operation.
- Browser DOM/layout control from the CLI. The served view reports bounded protocol metadata; it does not export a lossless transport capture.

Session-state playback preserves redaction and does not embed resource bodies. It is not a lossless network or screen recording. Real CLI integration and adapter normalization still need their own native/transport tests.

## Verification

Run the debugger unit and built-process suites with bounded Vitest execution:

```bash
cd packages/agent-remote-debugger
perl -e 'alarm shift; exec @ARGV' 180 pnpm exec vitest run --testTimeout=10000
```

The built-process suite starts the recorded Relay on an ephemeral loopback port and invokes `dist/cli.js` as a fresh Node process. It covers public command acknowledgements, interaction responses, resource bytes, trace records, error categories, and concurrent Web/CLI replica convergence.

The server browser suite runs the built package from a temporary installation directory with only production dependencies linked. A deterministic child process communicates over real stdin/stdout. The actual product view receives CLI messages, sends browser messages and approvals, reconnects after an offline interval and refreshes without recreating the Agent. Settings changes, rejected settings and owned-process shutdown are also checked. These tests do not claim authenticated live Codex, Claude or Copilot acceptance.

```bash
pnpm --filter @orchardworks/agent-remote-debugger... run build
cd packages/agent-remote-debugger
perl -e 'alarm shift; exec @ARGV' 150 pnpm exec playwright test
```

## Session View presentation

The product, live debugger and recording player share `LabWorkbench` and its
`SessionViewFrame`, including theme scope, responsive composer, timeline scrolling,
disclosure behavior and display modes. Both browser entries load the same stylesheet
entry to preserve cascade order. Product navigation and account controls remain outside
this view. Recordings use its read-only mode rather than a second renderer.

Debug and playback controls float above the view without reserving layout space.
Use the Replay/Debug toggle (or Escape inside the controls) to collapse them. Playback
continues when collapsed. Preview, Simple and Content only use the product display
preference, saved in local storage for the current origin.
