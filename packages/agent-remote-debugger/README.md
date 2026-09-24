# ARDB — Agent Remote Debugger

`ardb` is the **headless Session View** and its debugger. Session View is the core interaction surface around which Agent Remote Control is organized. Sidebar navigation, session management, diagnostics, security and other product controls support that view.

The package name is `@orchardworks/agent-remote-debugger`; the executable is `ardb` and the repository entry is `pnpm ardb`. It is independent of `agent-remote-controller`, which runs Hosts and has no debugger subcommand.

Today, `ardb` exercises Session View's public protocol and reconstructed state through the same transport, session client and Replica as the product browser. CLI and structured output replace visual presentation; the shared client remains responsible for synchronization and operation correlation. It is currently a terminal interface; a visual Session View workbench and automated scenario runner are future extensions, not existing commands. Native runtime interpretation remains in Provider adapters.

## Run locally

Build the package before invoking the executable:

```bash
pnpm --filter @orchardworks/agent-remote-debugger... run build
pnpm ardb --help
```

The Relay URL resolves from `--relay`, then `AGENT_REMOTE_URL`, then `BORGEE_REMOTE_URL`, then `http://127.0.0.1:5910`. WebSocket commands resolve their Origin from `--origin`, then `AGENT_REMOTE_ORIGIN`, then `BORGEE_REMOTE_ORIGIN`, then `http://127.0.0.1:6175`.

Commands target the **public Relay Agent ID**, not an arbitrary native Codex/Claude session ID. `session create` chooses a public Agent ID; `--provider-session-id` supplies the separate native identity when supported. An already attached session can be observed by its public Agent ID. `session resume` requires an exact persistence handle, not a bare native ID.

The CLI expects an existing reachable Relay and appropriate access. It does not start a Relay or CLI process, perform hosted browser sign-in, or import browser cookies. `--origin` supplies the WebSocket Origin; it is not an authentication credential.

## Current capabilities

| Command | Current behavior |
| --- | --- |
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
| `130` | The process received SIGINT. |

Structured errors identify a stable code, message, and recoverability independently of the exit category.

## Observation boundaries

`observe` projects the reconstructed public Replica into stable records: connection state, Agent snapshot, Timeline state, interactions, resources, diagnostics, and a checkpoint. It is not a direct DSH inspection channel.

A DSH image attachment is Provider-native input that the DSH adapter recognizes as an opaque `dsh-attachment:` locator and exposes as a public Relay resource. The debugger can observe the resulting public Timeline/resource metadata and retrieve its bytes through `resource get`, but it neither reads DSH attachment services nor interprets the DSH event that produced it.

`protocol trace` records validated public HTTP and WebSocket messages before debugger presentation, including direction and transport channel. It is not a Provider-native trace: DSH, Codex, and any other Provider logs and events end at their respective adapters. Trace output omits available resource content and retains only a byte-length and digest marker.

## Current gaps

The following are not implemented CLI features:

- `serve`, a product-like debugging website, native process/stdin/stdout supervision, native event recording, or offline recording replay.
- A unified scenario runner, test-profile format, fault-injection controls, or regression report command. Existing package tests exercise the CLI; they are not an `ardb test` user command.
- Host pairing/catalog, native session listing, directory/child attachment or controller lifecycle management. An already bound child can be addressed by public Agent ID within its capabilities.
- Provider command discovery/execution, session-setting mutation, image input or explicit next-turn delivery. Use existing product/headless APIs where supported; slash text is not equivalent to a typed command operation.
- Browser DOM/layout testing or collecting a browser tab's exact transport trace.

JSONL can be saved for inspection, but it is not a lossless replay format: sensitive values and resource content are redacted. Real CLI integration and adapter normalization still need their own native/transport tests.

## Verification

Run the debugger unit and built-process suites with bounded Vitest execution:

```bash
cd packages/agent-remote-debugger
perl -e 'alarm shift; exec @ARGV' 180 pnpm exec vitest run --testTimeout=10000
```

The built-process suite starts the recorded Relay on an ephemeral loopback port and invokes `dist/cli.js` as a fresh Node process. It covers public command acknowledgements, interaction responses, resource bytes, trace records, error categories, and concurrent Web/CLI replica convergence.
