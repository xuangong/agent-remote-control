# Agent Remote Control

An independent workbench for discovering, creating, connecting to, and debugging agent sessions. It includes the remote protocol, provider SDK, DSH and Codex adapters, Node relay, browser client and renderer, terminal debugger, recorded scenarios, and an outbound DSH Host plugin.

The workbench has no account system. Generate a temporary key locally, configure the DSH Host plugin with that key, and select the connected installation to browse its native sessions and workspaces. Chat, questions, approvals, Timeline, Trace, and Replica Inspector share the existing public protocol.

## Run locally

Use Node 22 or later and pnpm 10.34.5. All commands run from this repository root.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm dev
```

Open `http://127.0.0.1:6175`. The default server at `http://127.0.0.1:5910` includes recorded sessions and the DSH pairing broker. It requires neither a Borgee checkout nor a Go server. Existing listeners are not replaced; choose free ports with `AGENT_REMOTE_PORT` and `AGENT_REMOTE_WEB_PORT` when needed.

The scoped npm registry in `.npmrc` resolves the pinned DSH prerelease packages through the Tencent mirror. The lockfile pins the dependency graph. Native DSH services target `0.1.2-rc.1`; the Codex fixture targets `codex-cli 0.148.0`. Provider constraints and supported degradations are recorded in [compatibility.json](packages/agent-remote-lab/compatibility.json).

## Connect a real DSH installation

Build the independent outbound Host plugin:

```bash
pnpm --filter @agent-remote-control/dsh build:bundle
```

The archive is `packages/agent-remote-dsh/dist/host-bundle/agent-remote-control-dsh-host-0.1.0.tgz`. Install it into a compatible DSH Web profile using the DSH CLI associated with that installation:

```bash
dsh plugin --profile web add "file:$(pwd)/packages/agent-remote-dsh/dist/host-bundle/agent-remote-control-dsh-host-0.1.0.tgz"
```

In the workbench, generate a temporary key. Start DSH Web with its existing home and workspace so its native session catalog remains available:

```bash
export AGENT_REMOTE_SERVER_URL="http://127.0.0.1:5910"
export AGENT_REMOTE_ACCESS_KEY="paste-the-generated-key"
export AGENT_REMOTE_INSTANCE_NAME="My DSH"
dsh --profile web --host 127.0.0.1 --port 3081
```

The plugin also accepts Cordis configuration fields `serverUrl`, `remoteKey`, and `instanceName`. Select the registered Host in the workbench, choose an existing session or create one in a native workspace, then connect. The native DSH installation continues to own model selection, credentials, persistence, and approval services.

Keys are valid for new connections for 24 hours and bind to one installation. Established connections remain active after key expiry until they disconnect. Restarting the workbench clears temporary keys and host bindings, so generate a new key and reconnect the plugin. Host reconnection within the same workbench process restores session bindings on demand without replaying message submissions or uncertain creation requests.

## Development and verification

```bash
pnpm typecheck
pnpm test
pnpm test:conformance
pnpm test:e2e
pnpm lint:docs
```

Test scripts enforce per-test and outer process deadlines. Browser tests use separate configurable ports and refuse to reuse an existing server. Set `AGENT_REMOTE_TEST_RELAY_PORT` and `AGENT_REMOTE_TEST_WEB_PORT` to free ports for concurrent testing. Run `pnpm compatibility:update` after source changes, then `pnpm compatibility:check` to verify the declared implementation digest.

`pnpm dev codex` runs the explicit Codex fixture. The optional DSH fixture launcher and installed-release preparation tools remain documented in the [Lab guide](packages/agent-remote-lab/README.md); these controlled fixtures are separate from the native Host connection above.

## Package boundaries

| Package | Owns |
| --- | --- |
| `agent-provider-sdk` | Native-independent session and observation contract. |
| `agent-provider-dsh`, `agent-provider-codex` | Native provider interpretation and runtime adapters. |
| `agent-remote-protocol` | Public schemas, codecs, versioned uplink envelopes, and contract fixtures. |
| `agent-remote-relay` | Session execution, ordered public state, transport, and uplink clients. |
| `agent-remote-web` | Browser transport, recovery, replica, and reusable React DOM rendering. |
| `agent-remote-debugger` | Terminal operations over the public protocol. |
| `agent-remote-dsh` | Native catalog, shared-session setup, and independent DSH Host bundle. |
| `agent-remote-lab` | Workbench, local server, pairing broker, directory, and validation fixtures. |

Existing `@borgee/*` library package names remain compatible. The standalone DSH runtime uses `@agent-remote-control/dsh`; its installable profile bundle is `@agent-remote-control/dsh-host`.

See the [product design](docs/blueprint/agent-remote-observation.md), [architecture map](docs/current/agent-remote/README.md), and [source and license notices](NOTICE.md).

## Terminal debugger

The `bdb` CLI is included in `packages/agent-remote-debugger`. It uses the same public HTTP/WebSocket protocol as the browser, including sessions attached through a paired DSH Host.

```bash
pnpm bdb provider list --json
pnpm bdb inspect SESSION_ID --json
pnpm bdb timeline SESSION_ID --tail 20 --json
pnpm bdb send SESSION_ID "Hello" --json
pnpm bdb protocol trace SESSION_ID --jsonl --until idle --timeout 10000
```

Use the public session ID shown by the workbench. `--relay` and `--origin` override the standalone defaults `http://127.0.0.1:5910` and `http://127.0.0.1:6175`. Environment settings are `AGENT_REMOTE_URL` and `AGENT_REMOTE_ORIGIN`; the older `BORGEE_REMOTE_URL` and `BORGEE_REMOTE_ORIGIN` aliases remain accepted. `bdb --help` lists creation, resume, observation, steer, cancel, planning, interaction, resource, and wait commands.

The live Codex process tests require `codex-cli 0.148.0`. Set `BORGEE_CODEX_TEST_EXECUTABLE` to an executable from an isolated installation of that exact version when the default `codex` executable differs. This does not require changing a global Codex installation.
