# Agent Remote Controller CLI

The `@agent-remote-control/agent-remote-controller` package provides the
`agent-remote-controller` command. It runs the local Agent Host and connects
Codex, Claude Code and GitHub Copilot sessions to a Relay for the browser
controller. Requires Node.js 22 or newer. No repository checkout or pnpm is
needed after installation. The package contains the latest bundled provider
implementation, including Codex Default-mode structured questions.

## Build and install

From the source checkout, install dependencies and run:

```sh
pnpm build:agent-remote-controller
npm install -g ./dist/agent-remote-controller/agent-remote-control-agent-remote-controller-0.1.0.tgz \
  --registry=https://mirrors.cloud.tencent.com/npm/
agent-remote-controller --help
```

The tarball bundles this repository's runtime code. npm installs the pinned
Claude Agent SDK, Copilot SDK and Copilot CLI dependencies. The separate Claude
catalog helper is included. It does not include native credentials, local state,
workspace files, the Web UI, or a Relay. This command does not publish to npm.

For installation without administrator permissions, use a user-owned prefix and
add its bin directory to PATH:

```sh
npm install -g --prefix "$HOME/.local" ./dist/agent-remote-controller/agent-remote-control-agent-remote-controller-0.1.0.tgz \
  --registry=https://mirrors.cloud.tencent.com/npm/
export PATH="$HOME/.local/bin:$PATH"
```

To run the tarball without a global installation, use:

```sh
npm exec --yes --registry=https://mirrors.cloud.tencent.com/npm/ \
  --package=./dist/agent-remote-controller/agent-remote-control-agent-remote-controller-0.1.0.tgz \
  -- agent-remote-controller foreground
```

Set the connection environment below first. The first run installs the SDK
dependencies into npm's cache. Replace `foreground` with `start`, `status`,
`pair`, or `stop` for daemon management.

## Connect to a Relay

The first pairing requires an explicit Relay URL in `AGENT_HOST_SERVER` and
a pairing key in `AGENT_HOST_REMOTE_KEY`. There is no built-in Relay default.
This project's hosted Relay and browser controller use `https://agents.xianliao.de5.net`.

1. Open your Controller (for the hosted deployment, `https://agents.xianliao.de5.net`).
2. Sign in if required, then choose **Pair Agent Host** and create a pairing key.
3. On the computer holding your projects, configure and start the Host:

```sh
export AGENT_HOST_SERVER=https://agents.xianliao.de5.net
export AGENT_HOST_PROVIDERS=codex,claude,copilot
export AGENT_HOST_WORKSPACE="$HOME/projects"
export AGENT_HOST_NAME="My development machine"
# Read the key without putting its value in shell history (macOS zsh):
read -rs 'AGENT_HOST_REMOTE_KEY?Pairing key: '; echo
export AGENT_HOST_REMOTE_KEY
agent-remote-controller start
unset AGENT_HOST_REMOTE_KEY AGENT_HOST_SERVER
agent-remote-controller status
```

Select only providers installed and authenticated on this machine. The default
is `codex`. Codex must be 0.148.0 or newer, Claude Code 2.1.247 or newer; newer
versions are accepted but only the repository compatibility targets are verified.
The packaged Copilot CLI is 1.0.83 with SDK 1.0.11. Codex and Claude use their
existing native login/profile. Copilot uses its native authentication as well.
Copilot's native auto-update mechanism can select a different installed version,
including a prerelease rejected by Host version validation. To use the packaged
version, export `COPILOT_AUTO_UPDATE=false` before starting the Host. This applies
only to that process environment and must also be set on subsequent starts; it
is not retained in the Host connection settings.
DSH connects through its own Host plugin; `dsh` is not an `AGENT_HOST_PROVIDERS`
value.

The existing `AGENT_HOST_*` configuration names and local state directory remain
compatible with earlier source-checkout launches.

If the desired CLI is not on PATH, set the executable explicitly before start:

```sh
export AGENT_HOST_CODEX=/absolute/path/to/codex
export AGENT_HOST_CLAUDE=/absolute/path/to/claude
# Optional override of the packaged Copilot CLI:
export AGENT_HOST_COPILOT=/absolute/path/to/copilot
```

Optional profile settings are `AGENT_REMOTE_CODEX_HOME`,
`AGENT_HOST_CLAUDE_HOME` and `AGENT_HOST_COPILOT_HOME`.
Only the requested providers are started; no model prompt is submitted at launch.

Once registration succeeds, the Host privately retains its connection and
provider settings. Later starts can use the saved settings without the key in
the environment. Keep `AGENT_HOST_STATE_DIR` consistent if you override it.
The default is `~/.agent-remote-control/agent-host`; it contains private
`connection.json`, `installation-id`, management state and `agent-host.log`.
Do not share this directory or its connection file.

## Lifecycle and upgrades

```sh
agent-remote-controller status      # Check daemon and uplink state
agent-remote-controller stop        # Stop this Host and its owned native sessions
agent-remote-controller start       # Start using saved connection settings
agent-remote-controller foreground # Run in this terminal instead; Ctrl+C stops it
```

The background daemon survives terminal closure, but is not automatically
started at OS boot. `status` reports the uplink state; process startup alone does
not prove registration succeeded. A rejected/expired pairing requires a new key.
With a running daemon, set `AGENT_HOST_SERVER` and `AGENT_HOST_REMOTE_KEY` together
and run `agent-remote-controller pair` to replace the connection without restarting sessions.

To apply an updated tarball, stop the existing Host, install the new tarball,
and run `agent-remote-controller start`. Installing a package does not replace already running
processes. Native session history remains in the native profiles; in-flight
requests and active work may be interrupted by a restart.

## Local execution policy

The CLI admits workspaces under trusted local roots. Its default root is
`AGENT_HOST_WORKSPACE` (or `AGENT_REMOTE_WORKSPACE`), falling back to the directory
where the Host starts. The selected default directory is retained for later
starts. To admit additional roots, set `AGENT_HOST_ALLOWED_WORKSPACE_ROOTS` to a
JSON array of absolute directory paths before starting the Host:

```sh
export AGENT_HOST_WORKSPACE=/Users/me/projects/app
export AGENT_HOST_ALLOWED_WORKSPACE_ROOTS='["/Users/me/projects/app","/Users/me/projects/docs"]'
```

The default workspace must be inside an allowed root. Paths must exist; the
Codex session discovery lists saved threads, including threads owned by another
Codex client. Opening a thread requires the native writer lock. If another client
owns it, the Host returns HTTP 409 with `session_in_use`. Release the session in
the original client, or exit that client, before retrying. Finishing a turn alone
does not release the session. The Host does not take over the lock or silently
fork the conversation. A CLI older than the client that wrote the history may
also be unable to read its stored format; configure a compatible
`AGENT_HOST_CODEX` executable and restart the Host after validating it.

Host checks real paths, including symbolic links, before creating or importing
sessions and before native input or settings mutations. Catalogs omit sessions
outside those roots and sessions whose workspace cannot be established. Native
permission settings are read-only to remote controllers; model controls remain
available. These rules apply to the CLI. Embedders can provide the same trusted
`executionPolicy` through `createAgentHostRuntime` or `createAgentHost`, and
should also configure Codex/Claude providers with `restrictedNative: true` to
enforce their native permission and sandbox boundaries.

A workspace admission check is not filesystem isolation. The providers have
different execution guarantees:

- Codex starts and resumes threads with native `workspace-write` and approval
  policy `never`. Native sandbox escalation and additional permission grants are
  disabled. The adapter hides and rejects the permissions command and locks
  permission mutations even when a command interaction invokes them internally. Codex may still read
  outside the workspace and use its native temporary directories; existing
  native configuration and platform support determine the remaining sandbox
  details.
- Claude requests the SDK command sandbox with `enabled: true`,
  `failIfUnavailable: true`, and `allowUnsandboxedCommands: false`. Unsupported
  platforms fail closed. Saved elevated permission modes are reset to `default`.
  The command sandbox does not establish isolation for every native tool,
  external MCP service, hook, or filesystem read.
- Copilot has no filesystem sandbox guarantee supplied by this integration.
  Workspace admission and existing native interactive permissions still apply.

For trusted full remote control, set `AGENT_HOST_TRUSTED_FULL_CONTROL=1` locally
before starting the Host. This explicitly disables workspace admission, remote
permission locking, and the Codex/Claude sandbox defaults above. It is retained
in private connection settings; set it to `0` and restart to restore the default
policy. Remote APIs cannot alter these local policy settings. Changes require a
Host restart; re-pairing only replaces the uplink connection.

Relay, Gateway, and local Host management environment variables are masked before
native subprocesses start, including executable version probes. The entire
`AGENT_HOST_` and `AGENT_REMOTE_` namespaces are masked, including
`AGENT_REMOTE_SIGNING_SECRET`; selected native profile paths are passed through
the provider configuration before sanitizing the child environment. Provider login
variables such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GH_TOKEN` remain
available to the selected native runtime. This filters inherited environment
variables; it does not hide local credential files from an otherwise authorized
native tool.

## Device credentials and stopping work

New durable enrollment exchanges the invitation for a device credential. The CLI
advertises `credentialRotation: true` because it has a durable persistence
callback. On `credential_issued`, it writes the private connection file using a
synced temporary file and atomic rename, syncs the containing directory, updates
the current reconnect key, then sends `credential_saved`. `registered` remains
the final registration acknowledgment. Later rotation uses the same exchange.
The saved device credential is authoritative after a disconnected acknowledgment;
subsequent registration saves cannot restore the invitation or an older key.
Failed local persistence refuses acknowledgment and requires local storage repair
and re-pairing. Leave server/key overrides unset on later starts so the saved
device credential is used.

Embedders must supply an `uplink.onCredential(credential): Promise<void>` callback
that resolves only after durable persistence to advertise rotation. Existing
legacy enrolled Hosts remain compatible but cannot rotate until updated. Device
credentials must never be returned to a browser or logged.

Owner-authorized stop requests call `POST /remote/stop` with `{}` over the Host
control uplink. The response contains `results`, with one `agentId` and status
`cancelled`, `unsupported`, or `failed` per attached session. Native cancel calls
run independently with a local deadline, so an unsupported or unresponsive
session does not hide other results. `cancelled` means the native cancel call
completed; it does not prove OS process termination. Revoking browser access or
rotating a device credential does not cancel already running native work.
