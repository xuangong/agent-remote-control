# Controller installation and updates

Run `install.sh` on macOS, Linux (x64/ARM64), or **inside an existing Docker
container**. First installation guides pairing. Existing installations offer
**Update**, **Clean install**, or **Cancel** (the default).

## Requirements

- A POSIX shell (`sh`), curl, tar, SHA-256 tools, Node.js 22 or newer and npm in the
  environment where the Controller will run. Bash and the Docker CLI are not required.
- The selected native agents must be on PATH. `--install-codex` installs Codex
  0.155.1 privately if missing, without replacing an existing Codex installation.
- HTTPS access to GitHub Releases and access to the configured npm registry.
- A one-time pairing key from the Agents website for a new Host. The key's purpose
  controls whether enrollment also initializes a Gateway token and CLI configuration.

No source checkout, global npm installation or root access is required. The installer
checks release platform, Node requirement, SHA-256, Git revision and clean build
identity. Controller npm lifecycle scripts are disabled.

## Install and pair

Run:

```sh
curl -fsSL --proto '=https' --proto-redir '=https' \
  https://github.com/xuangong/agent-remote-control/releases/latest/download/install.sh \
  | sh -s -- --install-codex
```

The script reads terminal input through `/dev/tty`, so piping the script does not
consume the pairing key. To inspect it before execution, download it with `-o
install.sh`, then run `sh install.sh --install-codex`. The script is also available
from the repository at
`https://raw.githubusercontent.com/xuangong/agent-remote-control/main/install.sh`.

The installer prompts for the Relay (default `https://agents.xianliao.de5.net`) and
recommends a weather-city-random Host name. It then guides you through:

1. Open the selected Agents website and sign in.
2. Open **Settings > Pair Agent Host**.
3. Choose **Host only** or **Gateway token + CLI setup**.
4. Click **Generate pairing key**, then copy only the `arc_...` key from the configuration.
5. Paste the key into the terminal's hidden prompt.

Each pairing key enrolls one Host and expires after use. The installer never logs in
for you, grants Gateway permissions, or accepts a key as a command argument.

```sh
sh install.sh --install-codex --name sunny-hangzhou-a1b2c3 \
  --server https://agents.xianliao.de5.net --providers codex
```

The program is installed beneath `~/.local/share/agent-remote-controller`, the command
in `~/.local/bin`, and state in `~/.agent-remote-control/agent-host`. Use `--prefix`,
`--bin-dir` and `--state-dir` for alternate absolute paths. The installer prints the
command directory if it is missing from PATH; it does not edit shell startup files.
The wrapper uses the stable release launcher, `LC_ALL=C`, and a default
`AGENT_HOST_CODEX_NOFILE=8192`. Explicit environment overrides are preserved.

On macOS and Linux hosts, startup uses the existing launchd/systemd support (or a
manual background process when a service manager is unavailable). The installer
reports ready only after registration. It does not restart a shared Codex daemon.
If startup fails, keep the saved state and inspect `agent-remote-controller status`;
resolve the problem and run `start` with the existing identity instead of creating
another pairing key.

## Inside Docker

Enter your container and run the **same** `curl ... | sh` command above. For example,
you can start an interactive Node image with persistent home and workspace volumes:

```sh
docker run --init -it --name my-agent-host \
  -v my-agent-home:/root -v my-agent-workspace:/workspace \
  -w /workspace node:22-bookworm sh
# Inside the container, run the curl ... | sh command above.
```

The image/environment needs the requirements listed above. The installer detects
`/.dockerenv`, `/run/.containerenv`, or the `container` environment variable, and runs
Controller in **foreground** mode. It does not use launchd/systemd or create another
container. `--foreground` explicitly selects this behavior for other containers.

Keep the foreground process alive to keep the Host online. Closing it stops that
Controller; container restart policy and startup command are controlled by your
container configuration. Persist the installation and Host state (the example
persists `/root`) and the workspace. To start the saved Host again, run its installed
command with `foreground`, without creating a new key. Configure your container's
command to do this automatically if needed. For image builds, use `--no-start` and
run `foreground` at runtime; install as the intended runtime user so the private
package and state directories remain readable.

To update a running container Host, use another shell in the **same** container and
rerun the installer. The local management socket talks to its existing foreground
Controller. It never deletes the container, image, volumes, native CLIs or workspace.

## Existing installations

The installer finds its command in `--bin-dir`, or PATH when that option is omitted.
The existing wrapper retains its configured state directory unless you explicitly
provide `--state-dir` or `AGENT_HOST_STATE_DIR`. Compatibility is checked against the
running Controller's platform, architecture, Node runtime and protocol.

A compatible newer release displays both versions and offers **Update**. **Clean
install** also allows reinstalling the same version. Without a terminal, the default
is to leave everything unchanged. `--yes` explicitly approves an update;
`--clean --yes` explicitly approves a clean reinstall.

```sh
sh install.sh
sh install.sh --version X.Y.Z --yes
sh install.sh --clean --yes
```

Clean install downloads a fresh runtime and dependencies, performs a bounded shutdown,
uninstalls the old managed runtime and installs the fresh package. The bootstrap
launcher, Host identity, device credential, settings and history are retained.
A temporary runtime backup and journal restore the previous version if startup fails
or replacement is interrupted. Successful activation removes the superseded runtime.
It is not a factory reset and does not reinstall Node or native agent CLIs.

The running Controller must support the local `update` command; older versions need
one website update first. Clean install additionally requires this installer's
bootstrap launcher; older launchers only offer ordinary updates. An orphaned state
directory is protected: locate its existing executable rather than creating a new
identity. A stopped Controller must be started with its saved settings first.

Verified updates restart the Controller immediately without waiting for idle sessions
or approvals. Shared Codex daemon tasks keep running. Private tasks, Controller-hosted
tool calls and in-flight requests may be interrupted. Older Controllers can still
report a queued update; the installer does not mistake this for completed activation.
Failed or uncertain requests are never automatically replayed. The local CLI provides:

```sh
agent-remote-controller update --check
agent-remote-controller update --version X.Y.Z --yes
agent-remote-controller update --version X.Y.Z --yes --clean
```

## Automation

Download the script first, then supply a private key file or key input stream:

```sh
sh install.sh --key-file /private/path/pairing-key --name windy-berlin-a1b2c3
# Or: your-secret-reader | sh install.sh --key-stdin --name windy-berlin-a1b2c3
```

`--key-stdin` uses defaults for omitted options without reading the terminal; do not
combine it with piping the script itself to `sh`. Remove external key files after
successful enrollment. `--no-start` installs the command without requesting a key or
starting services. `--version X.Y.Z` selects a specific published release.

## Validation

`pnpm test:setup` covers fresh installation using real local npm archives, disabled
lifecycle scripts, invalid releases, hidden terminal input, explicit update/clean
consent, protected existing state, piped `sh` execution and container foreground
behavior. Downloads and service startup are isolated fixtures; no real Host is paired.
Controller tests use real management sockets and launcher children for shutdown,
clean replacement, failed activation and interrupted-reinstall recovery.
