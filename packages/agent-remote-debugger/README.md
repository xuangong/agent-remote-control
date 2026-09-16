# Borgee Agent Remote Debugger

`@agent-remote-controller/agent-remote-debugger` provides `bdb`, a terminal presentation adapter for an Agent Remote Relay. It uses the same public transport, session client, and Replica as the Web package; it does not connect to a Provider runtime or implement a second synchronization algorithm.

## Run locally

Build the package before invoking the executable:

```bash
pnpm --filter @agent-remote-controller/agent-remote-debugger build
node packages/agent-remote-debugger/dist/cli.js --help
```

The Relay URL resolves from `--relay`, then `AGENT_REMOTE_URL`, then `BORGEE_REMOTE_URL`, then `http://127.0.0.1:5910`. WebSocket commands resolve their Origin from `--origin`, then `AGENT_REMOTE_ORIGIN`, then `BORGEE_REMOTE_ORIGIN`, then `http://127.0.0.1:6175`.

## Two-terminal workflow

Create the Agent once before opening an observer. Then keep a JSONL observer open in one terminal while a second terminal sends controls. Each process owns its own reconstructed Replica, so an observer can be restarted later and reconstruct Relay history.

```bash
# Initialize the Agent once
node packages/agent-remote-debugger/dist/cli.js session create example-agent --provider recorded --json

# Terminal A
node packages/agent-remote-debugger/dist/cli.js observe example-agent --jsonl

# Terminal B
node packages/agent-remote-debugger/dist/cli.js send example-agent "Summarize the trace." --wait idle --json
```

Use `--until idle`, `--until interaction`, or `--until failed` to make a stream finite. An explicit `--timeout <milliseconds>` is one deadline for the whole command, including readiness, acknowledgement, and any later wait; a stream without `--timeout` or `--until` remains open until interrupted.

## Command tree

```text
bdb
|-- provider list
|-- session create <agent-id> --provider <provider-id>
|-- session resume <agent-id> --persistence-file <path|->
|-- observe <agent-id>
|-- inspect <agent-id>
|-- timeline <agent-id>
|-- send <agent-id> [message]
|-- steer <agent-id> [message]
|-- cancel <agent-id>
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

## Verification

Run the debugger unit and built-process suites with bounded Vitest execution:

```bash
cd packages/agent-remote-debugger
perl -e 'alarm shift; exec @ARGV' 180 pnpm exec vitest run --testTimeout=10000
```

The built-process suite starts the recorded Relay on an ephemeral loopback port and invokes `dist/cli.js` as a fresh Node process. It covers public command acknowledgements, interaction responses, resource bytes, trace records, error categories, and concurrent Web/CLI replica convergence.
