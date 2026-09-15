# Agent Remote Control

An independent workbench for discovering, creating, connecting to, and debugging agent sessions. It includes the remote protocol, provider SDK, DSH, Codex, Claude Code, and Copilot adapters, Node relay, browser client and renderer, terminal debugger, recorded scenarios, and an independent Agent Host runtime.

The workbench has no account system. Generate a temporary key locally, pair an Agent Host or DSH Host plugin with that key, and select an advertised Provider under the connected installation to browse its native sessions and workspaces. Chat, questions, approvals, Timeline, Trace, and Replica Inspector share the existing public protocol.

## Run locally

Use Node 22 or later and pnpm 10.34.5. All commands run from this repository root.

To build and start the complete controller with Codex, Claude, and DSH:

```bash
pnpm start --codex /absolute/path/to/codex --claude /absolute/path/to/claude \
  --dsh /absolute/path/to/dsh
```

The launcher builds Agent Host and Web, installs the DSH Host plugin, starts both native Hosts, pairs them automatically, and prints the controller URL after all three providers are ready. Keep the terminal open; Ctrl+C stops this environment. Use `pnpm start --config .runtime/controller.json` for repeatable configuration, or `--dsh-repo` for a DSH source checkout. See the [complete startup guide](docs/runbooks/controller-start.md) for profiles, ports, configuration, and lifecycle.

To start only the workbench and pair Hosts manually:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm dev
```

Open `http://127.0.0.1:6175`. The default server at `http://127.0.0.1:5910` owns the labeled Recorded fixture and the Agent Host pairing broker. Native Codex, Claude Code, and Copilot run only in the independent Agent Host. Existing listeners are not replaced; choose free ports with `AGENT_REMOTE_PORT` and `AGENT_REMOTE_WEB_PORT` when needed. `AGENT_REMOTE_BIND` can expose the broker on an explicit interface; local management authorization remains unchanged.

The scoped npm registry in `.npmrc` resolves the pinned DSH prerelease packages through the Tencent mirror. The lockfile pins the dependency graph. Native DSH services target `0.1.2-rc.1`; the Codex fixture targets `codex-cli 0.148.0`. Provider constraints and supported degradations are recorded in [compatibility.json](packages/agent-remote-lab/compatibility.json). The [Provider support baseline](docs/current/agent-remote/provider-support.md) compares DSH, Codex, Claude and Copilot, including endpoint gaps, verification and workarounds; use its [onboarding checklist](docs/current/agent-remote/provider-onboarding.md) for a new Provider.

## Install Agent Host as a standalone command

Run `pnpm build:agent-remote-controller` to create `dist/agent-remote-controller/agent-remote-control-agent-remote-controller-0.1.0.tgz`.
Install it with `npm install -g ./dist/agent-remote-controller/agent-remote-control-agent-remote-controller-0.1.0.tgz --registry=https://mirrors.cloud.tencent.com/npm/`.
The installed `agent-remote-controller` command runs without a repository checkout or pnpm.
See the [Agent Host CLI guide](packages/agent-host/README.md) for native CLI requirements,
pairing, background operation and upgrades. Run `pnpm test:agent-remote-controller-package` after
building to verify installation and daemon lifecycle in an isolated prefix.

For simultaneous desktop CLI and phone control of one Codex session, use the
[shared native runtime setup](docs/current/agent-remote/codex-shared-runtime.md).

## Connect a real Codex CLI

Start the workbench, open **Pair Agent Host**, and generate a temporary key. In another terminal, start Codex through the Host:

```bash
export AGENT_HOST_SERVER=http://127.0.0.1:5910
export AGENT_HOST_REMOTE_KEY='paste-the-generated-key'
export AGENT_HOST_CODEX=/absolute/path/to/codex
export AGENT_HOST_WORKSPACE=/absolute/path/to/workspace
pnpm agent-remote-controller start
```

Select **Codex · <Host name> · Online** in Session intake. The verified CLI version is `0.148.0`; older versions are rejected with an actionable message. `AGENT_REMOTE_CODEX_HOME`, `AGENT_REMOTE_CODEX_EXECUTABLE`, and `AGENT_REMOTE_WORKSPACE` remain supported aliases. See [Codex installation and debugging](docs/runbooks/codex-debug.md) for an isolated Tencent-registry install and the process/session boundaries.

## Connect Claude Code, or both native providers

Start the workbench and generate a temporary key through **Pair Agent Host**. For Claude alone:

```bash
export AGENT_HOST_SERVER=http://127.0.0.1:5910
export AGENT_HOST_REMOTE_KEY='paste-the-generated-key'
export AGENT_HOST_PROVIDERS=claude
export AGENT_HOST_CLAUDE=/absolute/path/to/claude
export AGENT_HOST_WORKSPACE=/absolute/path/to/workspace
pnpm agent-remote-controller start
```

Select **Claude Code · <Host name> · Online**. Claude Code must be version `2.1.247` or newer; the adapter pins `@anthropic-ai/claude-agent-sdk` to `0.3.247`. Set `AGENT_HOST_PROVIDERS=codex,claude` and `AGENT_HOST_CODEX` to advertise both providers under one Host. The default remains `codex`. All selected executables must be available; empty, duplicate, or unknown selections fail startup.

`AGENT_HOST_CLAUDE_HOME` selects an optional native profile through `CLAUDE_CONFIG_DIR`. Native authentication and settings remain owned by Claude Code. See [Claude installation and debugging](docs/runbooks/claude-debug.md) for isolated installation, configuration, session lifetime, and supported controls. Use a different `AGENT_HOST_STATE_DIR` when keeping an existing daemon running alongside a separate Host.

## Connect GitHub Copilot through its official SDK

Copilot is opt-in: `pnpm start --providers copilot` uses the pinned installed CLI; pass `--copilot /absolute/path/to/copilot` to override. For a manually paired Host, set `AGENT_HOST_PROVIDERS=copilot`, `AGENT_HOST_SERVER`, `AGENT_HOST_REMOTE_KEY` and `AGENT_HOST_WORKSPACE`, then run `pnpm agent-remote-controller start`. `AGENT_HOST_COPILOT` overrides the executable and `AGENT_HOST_COPILOT_HOME` selects the native profile. Comma-separated Host selections may include `codex,claude,copilot`.

The adapter uses official `@github/copilot-sdk` **1.0.11** and Copilot CLI **1.0.83**, through SDK stdio. It does not use ACP. Authentication remains in the native CLI profile/environment. Real SDK/CLI tests use an isolated local model endpoint, without cloud prompts. See the [Copilot audit](docs/current/agent-remote/copilot-support-audit.md) for supported input, history, parent-owned children, experimental APIs and remaining gaps. Run `pnpm test:copilot` for the bounded adapter and native loopback suite.

## Connect a real DSH installation

Run the guided setup from the repository root. It installs the Host plugin, generates a temporary key, starts DSH, and checks Host registration and Web readiness:

```bash
node scripts/dsh-debug.mjs
```

For a source installation, pass `--dsh-repo /path/to/deepseek-harness`. Add `--build-dsh` to install its dependencies and build its official runtime artifacts. An installed CLI can be selected with `--dsh /path/to/dsh`. The default DSH home is isolated under `.runtime/dsh-debug/home`. See the [guided DSH debugging runbook](docs/runbooks/dsh-debug.md) for first-run setup, repeatable commands, ports, and troubleshooting.

For manual installation:

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

The plugin also accepts Cordis configuration fields `serverUrl`, `remoteKey`, and `instanceName`. Each advertised Provider appears in the workbench selector as `<Provider name> · <Host name> · Online/Offline`, alongside the labeled Recorded fixture. Selecting it switches session discovery and workspace selection to that installation. Choose a workspace and click **Open session**, or select an existing session from the directory. Offline Hosts remain visible, with creation disabled; another Provider can still be selected. The native DSH installation continues to own model selection, credentials, persistence, and approval services.

Keys are valid for new connections for 24 hours and bind to one installation. Established connections remain active after key expiry until they disconnect. Restarting the backend clears temporary keys and host bindings. A background Host can keep native sessions alive: generate a new key, set `AGENT_HOST_SERVER` and `AGENT_HOST_REMOTE_KEY`, then run `pnpm agent-remote-controller pair` to replace only its uplink. Host reconnection within the same backend process restores session bindings on demand without replaying message submissions or uncertain creation requests.

## Development and verification

```bash
pnpm typecheck
pnpm test
pnpm test:conformance
pnpm test:e2e
pnpm lint:docs
```

Test scripts enforce per-test and outer process deadlines. Browser tests use separate configurable ports and refuse to reuse an existing server. Set `AGENT_REMOTE_TEST_RELAY_PORT` and `AGENT_REMOTE_TEST_WEB_PORT` to free ports for concurrent testing. Run `pnpm compatibility:update` after source changes, then `pnpm compatibility:check` to verify the declared implementation digest.

`pnpm dev` runs the Recorded-backed workbench and pairing broker. `pnpm agent-remote-controller start` starts the selected native providers in the managed Host daemon so a later `pnpm agent-remote-controller pair` can replace its uplink without stopping native sessions. `pnpm agent-remote-controller foreground` is an attached debugging mode without daemon pairing control. `pnpm dev codex-fixture` remains a clearly labeled direct fixture composition for adapter validation; `pnpm dev recorded` runs the Recorded fixture and broker. The optional DSH fixture launcher and installed-release preparation tools remain documented in the [Lab guide](packages/agent-remote-lab/README.md).

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

Optional authenticated hosting: see [Gateway Relay](docs/current/agent-remote/gateway-relay.md) for gateway login, Host sharing and cumulative session allowances.
[Agents deployment](docs/current/agent-remote/deployment.md) covers the independent
`agents.xianliao.de5.net` Worker, SSH Docker and local Node/workerd Docker profiles.
