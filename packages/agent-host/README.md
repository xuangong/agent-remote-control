# Agent Remote Controller CLI

The `@orchardworks/agent-remote-controller` npm package provides the
`agent-remote-controller` command. It runs the local Agent Host and connects
Codex, Claude Code and GitHub Copilot sessions to a Relay for the browser
controller. Supports macOS, Linux and native Windows with Node.js 22 or newer. No repository
checkout or pnpm is needed after installation. The npm package declares
`darwin`, `linux` and `win32`. The package contains the latest bundled provider
implementation, including Codex Default-mode structured questions.

## Build and install

The public package name is `@orchardworks/agent-remote-controller`. Once a version
has been published to npm, install it with:

```sh
npm install -g @orchardworks/agent-remote-controller --registry=https://registry.npmjs.org/
```

The internal workspace package remains `@orchardworks/agent-remote-controller`;
the build script assigns the public name to the standalone tarball. The generated
manifest targets public publication on npmjs.org. Building and installing a tarball
do not publish it; publishing is a separate release operation.

Maintainers can publish through GitHub Actions with npm Trusted Publishing.
See the [release setup guide](https://github.com/xuangong/agent-remote-control/blob/main/docs/controller-npm-release.md)
for the one-time bootstrap and release-tag workflow.

From the source checkout, install dependencies and run:

```sh
pnpm build:agent-remote-controller
npm install -g ./dist/agent-remote-controller/orchardworks-agent-remote-controller-0.1.0.tgz \
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
npm install -g --prefix "$HOME/.local" ./dist/agent-remote-controller/orchardworks-agent-remote-controller-0.1.0.tgz \
  --registry=https://mirrors.cloud.tencent.com/npm/
export PATH="$HOME/.local/bin:$PATH"
```

To run the tarball without a global installation, use:

```sh
npm exec --yes --registry=https://mirrors.cloud.tencent.com/npm/ \
  --package=./dist/agent-remote-controller/orchardworks-agent-remote-controller-0.1.0.tgz \
  -- agent-remote-controller foreground
```

Set the connection environment below first. The first run installs the SDK
dependencies into npm's cache. Replace `foreground` with `start`, `status`,
`pair`, or `stop` for daemon management.

## Share a session with another device

With the Controller daemon running and registered on this Host:

```sh
agent-remote-controller share
agent-remote-controller share list-sessions
```

`share` asks you to select one of this Host's enabled providers, then paste a
native session ID. For Codex, run `/status` in the native CLI and copy the
**Session** value. A missing ID can be corrected without restarting the command.

`share list-sessions` offers two terminal browsing modes: **Recent sessions**
across enabled providers, and **By folder** to choose a workspace before choosing
a session. Folders are grouped by their full paths and ordered by their latest
session activity. Each session shows its provider, title, native ID, directory,
and update time. Sessions without a workspace appear under **(no directory)**.

Press **/** or select **Search** to enter a query, then **Enter** to see matches.
Folder searches match full paths; session searches match titles and native IDs.
Search is case-insensitive; multiple space-separated terms must all match.
Search inside a folder stays within that exact directory. Choose **Clear search**
(or submit an empty query) to reset it, or **b** to return to folders/browsing modes.
Folder browsing and session searches load metadata from all catalog pages, with
progress displayed; results are cached for this invocation. No conversation
content is loaded. Use Ctrl+C to interrupt metadata loading.

In a terminal, provider, browsing mode, folder, and session choices use **↑/↓**
to move and **Enter** to select. Choose **Older entries** or **Newer entries**
(**n/p**) to browse pages of 20 entries. **Home/End** jump to the first/last choice; **Page Up/Down**
move by ten choices. **Esc**, `q`, or Ctrl+C cancel a selection. Session IDs are
still entered as text (`q`, Ctrl+C, or end of input cancel).

Non-terminal input retains the recent-session numbered choices for scripts,
with `n` for older sessions and `p` for newer sessions.

Before displaying a link and terminal QR code, the Controller checks the selected
identity against its current native catalog. Sharing does not resume a session,
load conversation history, create a session, or establish another uplink. A session
outside the provider's discoverable catalog cannot be shared through this command.
On the phone, open the same site and use **Scan to open**. The code contains only
the site, Host, provider, and native session ID; access uses the receiving device's
own sign-in. Keep the full white border visible and widen the terminal if the QR
code wraps.

The CLI uses the authenticated local management socket of the running daemon and
its registered Host identity. If that daemon predates this command, update it and
restart the Controller. There is no need to restart the native Codex daemon.

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
# Bash (Linux): read the key without putting it in shell history.
read -rsp "Pairing key: " AGENT_HOST_REMOTE_KEY; echo
# In macOS zsh, use: read -rs 'AGENT_HOST_REMOTE_KEY?Pairing key: '; echo
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
version, export `COPILOT_AUTO_UPDATE=false` before starting the Host. This setting is retained privately with the provider configuration and reused by login startup.
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
agent-remote-controller status            # Check daemon and uplink state
agent-remote-controller stop              # Stop this Host and release its owned resources
agent-remote-controller start             # Start using saved connection settings
agent-remote-controller autostart status  # Check login startup and service state
agent-remote-controller autostart disable # Disable login startup and stop the managed service
agent-remote-controller autostart enable  # Enable login startup and start the managed service
agent-remote-controller foreground        # Run in this terminal instead; Ctrl+C stops it
```

On macOS, the first `start` enables login startup by default. A per-user LaunchAgent starts the Controller after login and restarts it if the process exits. This runs in the logged-in user's session, not before login. Saved connection and provider settings are reused, and the heartbeat mechanism reconnects when the network returns. `foreground` does not configure login startup.

`stop` unloads the running service before shutting down, so it stays stopped for the current login session and releases the Controller's connections and owned native resources. The login-startup preference remains enabled: a later `start` or the next login can start it again. Shared native daemons remain owned by their original applications and are not terminated. Stopping or restarting the Controller can interrupt active work; persisted native history is retained.

`autostart disable` stops a supervisor-managed Controller and persistently disables login startup. Later `start` commands respect that choice and run a manual background daemon until `autostart enable` is used. If a manual daemon is already running, enabling login startup preserves it and takes effect on the next login; stop it and start again to use the system supervisor immediately. Keep the same `AGENT_HOST_STATE_DIR` when managing an installation.

### Windows

Use PowerShell or CMD with Windows-native Node and provider CLIs. Install and authenticate
the providers locally before pairing. After installing the Controller:

```powershell
$env:AGENT_HOST_SERVER = 'https://your-relay.example'
$env:AGENT_HOST_REMOTE_KEY = 'paste-the-generated-key'
$env:AGENT_HOST_WORKSPACE = 'C:\Users\me\projects\app'
$env:AGENT_HOST_PROVIDERS = 'codex'
agent-remote-controller start
agent-remote-controller status
Remove-Item Env:AGENT_HOST_SERVER, Env:AGENT_HOST_REMOTE_KEY
```

For CMD, use `set` instead of PowerShell's `$env:` or Unix `export`:

```bat
set "AGENT_HOST_SERVER=https://your-relay.example"
set "AGENT_HOST_REMOTE_KEY=paste-the-generated-key"
set "AGENT_HOST_WORKSPACE=C:\Users\me\projects\app"
set "AGENT_HOST_PROVIDERS=codex"
agent-remote-controller start
agent-remote-controller status
set "AGENT_HOST_SERVER="
set "AGENT_HOST_REMOTE_KEY="
```

npm installs both PowerShell (`.ps1`) and CMD (`.cmd`) entry points. If your
PowerShell execution policy blocks the `.ps1` entry point, invoke
`agent-remote-controller.cmd` explicitly; changing the execution policy is not
required. Commands and arguments are the same in both shells.

`start` runs a detached background process without opening another console window.
`status`, `pair`, `share`, and `stop` use a token-authenticated Windows named pipe.
`stop` closes the uplink and owned resources and removes daemon state. Credentials
and native settings are restored on subsequent starts. The default state directory
is `%USERPROFILE%\.agent-remote-control\agent-host`; keep it in a private user
directory with Windows ACLs that exclude other users. Unix file modes do not set
Windows ACLs. Credential files are flushed before atomic replacement; directory
fsync is unavailable through Node on Windows.

Native `.exe` and JavaScript entry points are supported, including paths containing
spaces. Standard npm `codex.cmd`, `claude.cmd`, and `copilot.cmd` installations are
resolved to their package entry points without a command shell. Custom batch wrappers
must be replaced with an explicit `.exe` or JavaScript path in `AGENT_HOST_CODEX`,
`AGENT_HOST_CLAUDE`, or `AGENT_HOST_COPILOT`.

Windows `start` enables login startup by default through a per-installation script
in the current user's Startup folder. No administrator account or stored Windows
password is required. `autostart status`, `enable`, and `disable` manage that script.
`stop` retains it for the next login; `disable` removes it and stops a managed Host.
A manually started Host remains running when login startup is enabled or disabled.
The launcher stores paths and PATH, while pairing credentials remain in the state
directory. Windows Script Host and Windows PowerShell must be available. Windows
login startup does not provide automatic crash restart or pre-login boot startup.

Shared Codex and managed VS Code tunnels are supported on Windows as described
below. The Host still defaults to private Codex mode until shared mode is explicitly selected.
Native sandbox availability remains provider-specific. Claude's restricted command
sandbox still fails closed on unsupported platforms; Windows support does not
automatically enable trusted full control or weaken local execution policy.

For a user-owned npm prefix on Windows, add the prefix itself to PATH (not its
`bin` subdirectory). Use `Get-Content -Wait` on `agent-host.log` for live diagnostics.

### Linux

On Linux, `start` uses a **systemd user service** by default when `systemctl --user` can reach the current user's manager. It installs `agent-remote-controller-<state-directory-hash>.service` under `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user`, enables login startup, and starts the service. Use the same user, `HOME`, `XDG_CONFIG_HOME`, and `AGENT_HOST_STATE_DIR` for all lifecycle commands; the configuration directory must be one that the user's systemd manager searches. Do not run the CLI with `sudo`. Install Node and the Controller in persistent locations: the service stores absolute executable paths and the current PATH, and does not source shell startup files. Reinstall the service with `start` after changing those paths.

The service restarts an exited Controller after ten seconds. `stop` stops it without disabling future startup; `autostart disable` removes the service and persists the opt-out. `status` identifies `supervisor: systemd`; `autostart status` separately reports the saved preference, installed unit, user-manager availability, and enabled service. Unit metadata contains paths, not pairing credentials. Credentials and provider settings stay in the private state directory. The same bounded `agent-host.log` is used on both operating systems. systemd gives the Controller time to release its resources and then kills any remaining processes in the service's cgroup; external shared daemons are outside this ownership boundary.

A user service normally starts when the user logs in. For a server that must start at boot without login and keep running after logout, an administrator can enable lingering for that account:

```sh
sudo loginctl enable-linger "$(id -un)"
loginctl show-user "$(id -un)" --property=Linger
```

The Controller does not modify lingering or install a root service. Enabling it affects the account's other user services too. See the [systemd loginctl documentation](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html#enable-linger%20%5BUSER%E2%80%A6%5D).

Without an accessible systemd user manager (including most containers), `start` prints a warning and starts a manual daemon, which has no login startup or crash recovery. Explicit `autostart enable` fails with an actionable message in that environment. An existing systemd installation is never silently replaced with a manual process while its manager is inaccessible. For Docker or another supervisor, run `agent-remote-controller foreground` as the container command, persist the state directory and native profiles, and let that supervisor provide restart policy and signal forwarding. Install and authenticate Linux-native provider CLIs inside that environment; macOS executables cannot be reused there. systemd 240 or newer is needed for direct append logging. Provider architecture and libc requirements still apply to their own binaries.

`status` reports the uplink state; process startup alone does not prove registration succeeded. A rejected/expired pairing requires a new key. With a running daemon, set `AGENT_HOST_SERVER` and `AGENT_HOST_REMOTE_KEY` together and run `agent-remote-controller pair` to replace the connection without restarting sessions.

To apply an updated tarball, stop the existing Host, install the new tarball,
and run `agent-remote-controller start`. Installing a package does not replace already running
processes. Native session history remains in the native profiles; in-flight
requests and active work may be interrupted by a restart.

## Connection diagnostics

The background Controller appends connection diagnostics to `agent-host.log` in its state directory. The active log and its three numbered archives retain at most 5 MiB each after successful cleanup. Cleanup runs at daemon startup, before an owned diagnostic when the active file is already over its threshold, and once per second for output written directly through inherited stdout or stderr descriptors. Rotation preserves the active inode so append descriptors installed by manual startup, launchd, or systemd keep writing to the active log. One owned diagnostic can take the active file up to 64 KiB over its threshold until the next owned write or polling pass. An inherited burst has no finite instantaneous overshoot bound; the next pass archives only its latest 5 MiB and discards the earlier excess. Inherited bytes appended after the retained tail is captured and before the active inode is truncated can also be lost even when archive creation succeeds. If an archive cannot be retained, the Controller still truncates the active file when possible and retries cleanup later without logging the cleanup failure recursively.

Each owned diagnostic is redacted before being limited to 64 KiB and remains one line. Connection JSON includes a UTC timestamp, process ID, uplink generation, and connection ID. These fields correlate retries, pairing replacements, and process restarts. In foreground mode, the same diagnostics go to standard error without daemon archive management.

Events cover connection attempts, successful registration, the first observed disconnect cause, scheduled reconnect delays, terminal retry cancellation, and deliberate closure. Reasons distinguish missing Relay heartbeats, registration deadlines, socket failures, HTTP handshake rejection, invalid protocol messages, and local credential-persistence failures. Numeric WebSocket close codes, HTTP statuses, safe network error codes, and heartbeat timing are included when available. A `peerReason` field classifies a small set of known Relay reports, including a missing heartbeat acknowledgment, heartbeat delivery failure, connection replacement, and broker closure; it is a remote report, not a locally confirmed cause. Normal heartbeat traffic is not logged.

```sh
tail -f "${AGENT_HOST_STATE_DIR:-$HOME/.agent-remote-control/agent-host}/agent-host.log"
```

`heartbeat_timeout` means the Controller did not receive a heartbeat within the configured silence budget; it does not establish whether the cause was sleep, the network, or the Relay. A later socket close does not overwrite that initial observation. Pairing credentials, management tokens, protocol payloads, raw remote close text, and raw network-error messages are excluded from connection diagnostics. Diagnostics begin with the updated Controller; they cannot reconstruct causes missing from older logs.

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
synced temporary file and atomic rename, syncs the containing directory on Unix, updates
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
## Shared Codex runtime

### Windows shared daemon

Windows Codex does not implement the Unix `app-server daemon` lifecycle. The
Controller manages an independent `codex app-server` with an authenticated
loopback WebSocket instead. This uses the native Codex protocol and has been
verified with Codex **0.153.4**. Use a version that supports `--ws-auth` and
`--ws-token-file`; older CLIs fail startup without silently removing authentication.

```powershell
$env:CODEX_HOME = "$env:USERPROFILE\.codex"
agent-remote-controller codex daemon start
$env:AGENT_HOST_CODEX_CONNECTION = 'shared'
$env:AGENT_HOST_CODEX_TRUST_SHARED = '1'
agent-remote-controller start
agent-remote-controller codex resume <session-id>
```

Stop and start an existing Host to change its provider configuration. Use the same
Codex home and native executable for the Host and terminal clients. The proxy
selects the saved local address and passes its bearer token through an environment
variable, never a command-line argument. `AGENT_HOST_CODEX_SOCKET` and
`AGENT_HOST_CODEX_NOFILE` are Unix-only settings and must be unset on Windows.

`codex daemon status`, `restart`, and `stop` manage this shared runtime. Its state,
token and log are under `<CODEX_HOME>/agent-remote-daemon`. The port is chosen from
available loopback ports at startup. Multiple clients use one native process;
closing a client or stopping the Host does not stop the shared daemon. Restarting
the daemon disconnects all clients and may interrupt active work. A Windows Job
Object reclaims its native process tree if the daemon manager itself crashes.
Daemon startup is explicit and independent of Controller login startup.

Keep the Codex home private to your Windows account. A custom network endpoint or
an untrusted remote server cannot be substituted through the saved daemon address.

### macOS and Linux shared daemon

To use the same native session from a desktop CLI and the Remote Controller,
start `codex app-server daemon start` and connect the CLI with
`codex --remote unix://`. Configure this Host with
`AGENT_HOST_CODEX_CONNECTION=shared` and `AGENT_HOST_CODEX_TRUST_SHARED=1` before
starting it. `AGENT_HOST_CODEX_SOCKET` optionally selects an absolute local socket
path; otherwise the native socket under the configured Codex home is used.

Shared mode accepts the daemon's native permissions for Codex only. It never
starts a replacement writer or stops the daemon when a Remote connection closes.
The default remains `private`. Existing private CLI or desktop sessions must be
released once before they can be opened in the shared daemon. An already-running
Host must be restarted to apply provider configuration changes.

## Local previews and images

The managed Controller enables authenticated loopback previews on the Relay origin by default. Registrations persist in the managed state directory, expire after one hour by default, and reconnect on startup without extending their deadline. Set `AGENT_HOST_PREVIEW_TTL_MS` to change the fixed lifetime and `AGENT_HOST_PREVIEW_PROTECTED_PORTS` to a comma-separated list of TCP ports that must not be exposed. Markdown image reads are scoped to the session working directory and use existing session resource transport. See [local previews](../../docs/current/agent-remote/local-previews.md) for the complete behavior and configuration.

## VS Code tunnels

The Host owner can manage one VS Code tunnel from the web sidebar. The Controller checks `code tunnel --help` before enabling the feature, starts from its state directory, exposes device authorization and connection state, and supplies per-session workspace links. `AGENT_HOST_VSCODE` explicitly selects a local CLI executable; otherwise `code` must be available on the Controller’s PATH. Missing or unsupported CLIs disable the controls.

The managed tunnel is reclaimed when the Controller exits or crashes, or after five minutes continuously disconnected from the Relay. Set `AGENT_HOST_VSCODE_DISCONNECT_TIMEOUT_MS` to a positive millisecond duration to change that grace period. Reclamation and Controller restart require an explicit start from the UI. Short interruptions and browser closure retain the running tunnel. macOS, Linux and Windows are supported. On Windows, the Host resolves the VS Code installation's `code-tunnel.exe` (including from a configured `code.cmd` path), and uses a Job Object to reclaim descendants even if the tunnel or its supervisor exits first. Windows PowerShell must be available to create the job. License consent and native device authorization are still required. See the [Host VS Code tunnel design](../../docs/current/agent-remote/host-vscode-tunnel.md).

## Native Codex commands

Use the Controller's saved native configuration without copying its socket path:

```sh
agent-remote-controller codex
agent-remote-controller codex resume <session-id>
agent-remote-controller codex resume --last
agent-remote-controller codex --help
agent-remote-controller codex daemon status
agent-remote-controller codex daemon restart
```

On macOS and Linux, interactive commands receive `--remote unix://<socket>`. Windows uses the authenticated loopback endpoint described above. Resolution uses explicit environment settings, then privately saved Controller settings: `AGENT_HOST_CODEX` / `AGENT_REMOTE_CODEX_EXECUTABLE`, `AGENT_REMOTE_CODEX_HOME` / `CODEX_HOME`, and `AGENT_HOST_CODEX_SOCKET`. Without a socket override, the socket is `<CODEX_HOME>/app-server-control/app-server-control.sock`. Use the same `AGENT_HOST_STATE_DIR` as your Controller installation. Relay pairing is not required for an unconfigured local invocation.

Native commands inherit the terminal and run with `LC_ALL=C`. Relay credentials are not passed to the child. Native exit codes are preserved. An explicit native `--remote` overrides the automatic address. Help, version, and local management commands retain their native behavior.

On macOS and Linux, `codex daemon start|restart|stop` maps to `codex app-server daemon ...`; `status` maps to native `daemon version`, which reports the running and local versions. Both the shorthand and the full native daemon spelling use the same checks. Lifecycle commands do not receive `--remote`; a custom socket is rejected because the CLI cannot establish that the daemon under the configured home owns it. Connecting never implicitly starts or restarts a daemon.

On macOS and Linux, `daemon start` and `restart` default to a soft file descriptor limit of `8192`. Override it with `AGENT_HOST_CODEX_NOFILE` in the saved Controller configuration or explicit environment. The proxy sets the child's soft limit before executing Codex; if the requested limit cannot be set, it fails before invoking the native lifecycle command and leaves the running daemon alone. This setting does not alter an already running daemon and does not elevate privileges.

The web session-link dialog includes **Resume locally** for native Codex sessions. Copy the command and run it on the Host computer with the same Controller state directory; opening a session on the web does not require opening its local terminal first.

A confirmed shared-daemon RPC error for file descriptor exhaustion is reported as `native_file_limit` when creating or opening sessions. The web notice offers an expandable restart explanation and a copyable `agent-remote-controller codex daemon restart` command. Copying does not execute a restart. Restarting disconnects every session attached to that daemon and can interrupt running responses and tools. Saved history remains, but unfinished operations need inspection and unconfirmed messages must not be replayed automatically. Restarting frees descriptors and starts the replacement with the configured soft limit (`8192` by default).

Creation failures retain their uncertain operation identity even when a file-limit cause is known. Retrying the same operation never dispatches a duplicate creation. Private-runtime failures, local Controller socket errors, and ordinary timeouts do not receive shared-daemon restart advice.
