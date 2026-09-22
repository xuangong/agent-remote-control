# Controller releases and remote updates

GitHub Releases under `xuangong/agent-remote-control` are the release authority. A stable `controller-vX.Y.Z` release supplies `controller-release.json` and a standalone npm tarball. The manifest binds the version, Git revision, SHA-256, Node minimum and supported OS/architecture pairs. The Relay caches discovery; Hosts independently resolve the requested published version and verify the downloaded bytes. Browser input cannot select an arbitrary executable, URL, package or command.

If the GitHub REST release catalog returns 403 or 429, discovery falls back to GitHub's public latest stable release redirect. The redirect must identify a stable Controller tag in the same repository, and its manifest and package must be available. This fallback only verifies the current latest release; it never substitutes another version for a requested update. Other upstream errors and invalid release metadata remain failures. No GitHub credentials are required.

Hosts register their running Controller identity and update capability. Owners can confirm updates for their own Hosts; shared access never grants upgrade rights. Each Host updates independently when its platform, Node version and Relay protocol are compatible. Batch updates target eligible online Hosts; unsupported or offline Hosts never block the others. Frontend, Relay, Controller and native runtime do not need matching product versions. Legacy installations display a bootstrap instruction. Offline Hosts are reported as unavailable rather than silently queued indefinitely.

A packaged stable launcher supervises the Controller process. Updates install into a new private directory, preserving the previous package, credentials, native configuration and installation ID. The launcher switches its child and commits the active package only after the new Controller registers. Failed startup rolls back; connection loss during upgrade is not itself proof of success. Docker requires the state directory to remain writable and persistent.

Shared Codex tasks do not prevent an update: its independent daemon is not restarted. In-flight mutations, approvals, unknown outcomes running private/Claude/Copilot sessions, and active sessions using Controller-hosted source tools delay switching. Admission closes during the final restart window to avoid accepting a new write after the safety check. Upgrade status persists locally and remains queryable after reconnect. Download/install failures leave the current process running. No automatic replay of a failed upgrade is performed.

The first installation of this launcher is manual for legacy Controllers. Updating the package manager installation later should continue to use the same state directory. Releases do not automatically publish to npm; npm publication remains a separate explicit workflow.

The stable launcher itself remains at its bootstrap version and supervises versioned Controller children. A future incompatible launcher contract requires an explicit local bootstrap. Package dependencies are installed with npm without lifecycle scripts; updates need registry access as well as GitHub access.

## Windows

Windows x64 uses the same release discovery, owner confirmation, checksum verification,
safe restart admission and registration-based rollback as macOS. A release must list
`win32-x64`; an installed VS Code or native agent does not establish Controller update
support. The Host must report a clean release identity and run through the packaged
`dist/launcher.js` entry point. Development builds and older installations that invoke
`dist/cli.js` directly require a one-time local bootstrap.

On Windows the launcher requests graceful shutdown over its private Node IPC channel.
The Controller closes its Relay connection, releases its owned resources and removes
its daemon state before the replacement starts. An unresponsive child is forcibly
terminated after the shutdown deadline. An independent shared Codex daemon is not
part of this replacement. Both foreground and login-started Controllers support the
shutdown request; loss of the launcher IPC channel also requests cleanup.

For a legacy Windows installation, first finish private native tasks and pending
approvals. Use the same Windows account and `AGENT_HOST_STATE_DIR` as the existing
Controller. Stop the Controller, install the standalone tarball from the selected
`controller-vX.Y.Z` GitHub Release, then start it again:

```powershell
agent-remote-controller stop
# Replace X.Y.Z with the selected published version, including Windows x64 support.
$controllerVersion = 'X.Y.Z'
npm install --global --ignore-scripts "https://github.com/xuangong/agent-remote-control/releases/download/controller-v$controllerVersion/orchardworks-agent-remote-controller-$controllerVersion.tgz"
agent-remote-controller start
agent-remote-controller status
```

Retain the state directory; do not re-pair or delete credentials. Starting the packaged
command rewrites the enabled Windows login entry to use the stable launcher. An
explicitly disabled login preference stays disabled. The website should then report
the running version. Later compatible releases become available under **Controller
updates → Update Host → Confirm update**. This does not publish a release from the
browser or update the native Codex/VS Code installation.

Run `pnpm test:controller-updates` after building workspace dependencies. It covers
real child replacement and rollback, graceful Controller shutdown over IPC with a
real local WebSocket Relay, restart admission, Windows website discovery and owner-only
update requests through the Worker HTTP/WebSocket boundary.

## Linux and containers

Linux x64 and ARM64 use the same release discovery, owner confirmation, verified
installation, safe restart admission and registration-based rollback. Releases must
list `linux-x64` or `linux-arm64` for the Host. Node 22 or newer and npm are required;
the updater supports official Node installations and distribution npm layouts such as
Debian/Ubuntu's `/usr/share/nodejs/npm`. It runs npm with the current Node executable
and disables lifecycle scripts. No root privileges are required for remote updates:
packages are staged inside the Host's writable state directory.

For a legacy Linux installation, finish private tasks and pending approvals, then
use the same user and `AGENT_HOST_STATE_DIR` to bootstrap the published launcher:

```sh
agent-remote-controller stop
# Replace X.Y.Z with the selected published release version.
controller_version=X.Y.Z
npm install --global --ignore-scripts "https://github.com/xuangong/agent-remote-control/releases/download/controller-v${controller_version}/orchardworks-agent-remote-controller-${controller_version}.tgz"
agent-remote-controller start
agent-remote-controller status
```

Use a Node installation whose global prefix is writable by this user. Retain the
state directory and pairing credentials. Starting the packaged command rewrites an
enabled systemd user service to use the stable launcher. A disabled autostart
preference remains disabled. Without a systemd user manager, `start` can run the
launcher as a manual background process; it still supports remote updates, but has
no service-manager crash recovery. Development builds require a clean published
release before the website can offer remote updates.

In Docker, keep `foreground` as the command. The container entrypoint rejects
`start`, `_serve` and `autostart`, which would introduce a competing daemon or service
manager. The process chain is container init → entrypoint → stable launcher →
Controller. An update replaces only the Controller child; the container restart
policy handles exit of the outer process. SIGTERM is forwarded through the chain for
graceful shutdown. Keep a stop grace period of at least 30 seconds, as in the supplied
Compose file.

Persist `/data` (including `/data/host/controller-updates`) as a writable volume owned
by the container user. The launcher restores the selected version after container
restart or recreation with that volume. Do not remove the volume, run npm globally
inside a running container, or restart the container merely to apply a website update.
A read-only image filesystem is compatible if the state volume, npm cache and temporary
directory remain writable. GitHub and npm registry access are required. To bootstrap
a legacy image, rebuild it with a published launcher package and recreate the container
with the existing volumes. Website updates change the Controller package; Node,
native agents and the base image remain managed through image deployment.

Once bootstrapped, Linux Hosts appear under **Controller updates → Update Host →
Confirm update**, including eligible Hosts in batch updates. Publishing a new GitHub
release remains separate from requesting installation on a Host.

`pnpm test:controller-updates` covers Linux website eligibility, real npm installation
without lifecycle scripts, manual launcher startup, container-entrypoint child
replacement and rollback, and persisted selection after restarting the entrypoint.
`pnpm test:setup` covers rejection of container background commands. The container
process tests run on Linux without requiring a Docker daemon; they do not validate
Docker volume mounts or an actual systemd user manager.
