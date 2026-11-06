# Local development instance

`pnpm local` runs the complete product from a source checkout: the website and
Relay with a built-in local user, and a development Controller paired with
them. Use it to see website, Relay and Controller changes working before you
push or deploy. Agents use it through the
[`prepare-arc-local` skill](../.agents/skills/prepare-arc-local/SKILL.md).

macOS is the primary platform; Linux is supported. On Windows the command stops
with `pnpm local supports macOS and Linux.`

It reuses the [Devbox](devbox.md) server, with the same automatic local sign-in
and Controller pairing, but without Docker. The Docker Devbox remains the
isolated Linux alternative.

## Commands

Run from the checkout or worktree you want to try:

```bash
pnpm local up            # build, then start or restart this checkout's instance
pnpm local up --no-build # start or restart from the existing build output
pnpm local status        # URL, running build, local user and Controller state
pnpm local logs          # runner and Controller output of the current run
pnpm local logs --follow # keep following both logs
pnpm local down          # stop; state is kept
pnpm local list          # every instance on this machine
pnpm local remove --yes  # delete this checkout's stopped instance
```

Before the first `up`, install Node 22 or later, pnpm 10.34.5 and at least one
agent CLI, signed in natively as you normally use it. The instance reuses that
sign-in, so it asks for no other. `up` picks a free port the first time and
keeps it; `pnpm local status` shows the URL.

Sessions in the instance start only inside its `workspace/` directory, not in
the checkout. When a test needs files, copy or clone a test project into that
directory. `status` prints the instance directory as `State:`; the workspace is
its `workspace/` subdirectory (see [How it works](#how-it-works)).

The instance shares your native agent profiles, so its test sessions also
appear in your own Controller. In the instance website, do not use the
Controller update, Codex daemon, OpenCode server or VS Code tunnel controls. Use
the Docker [Devbox](devbox.md) when your native histories must stay untouched.
See [Shared native profiles](#shared-native-profiles).

`up` installs dependencies first when the checkout has no `node_modules`. A
failed build leaves a running instance untouched. When the site answers
`/health` and the Controller reports `uplink: registered`, `up` prints the
status, including the `http://localhost:<port>` URL. Open that URL in any local
browser; it is signed in automatically, and the development Controller appears
as the Host `Dev · <checkout directory name>`.

`status` reports one of these states: `running`; `stopped` (no run is
recorded); `stale` (the recorded processes are gone; `up` or `down` clears the
record); `orphaned` (see [Troubleshooting](#troubleshooting)); or `unknown`
(the processes could not be inspected; the reason is printed).

Every command except `up`, `status` and `list` needs an instance: `up` creates
it, and `status` and `list` answer without one. Without an instance, a command
prints `This checkout has no local instance. Run pnpm local up.` `api` and
`screenshot` also need the instance to be running. When it exists but is
stopped, they print `The instance is not running. Run pnpm local up.` `remove`
also refuses an instance that still runs. It does not delete the test sessions
from the shared native histories.

### Inspecting the instance

Three commands look into the instance:

```bash
pnpm local controller status
pnpm local api v1/remote/hosts
pnpm local screenshot / --out page.png
```

- `controller <args>` runs the Controller CLI against the instance's state. It
  accepts `status`, `diagnostics`, `window`, `session` and `environment`, and
  the read-only `help`, `--help`, `-h` and `--version`. It refuses everything
  else: the runner owns start, stop, pairing and updates, and native
  subcommands could take over shared sessions.
- `api <v1/path>` sends a signed-in JSON request to the instance's user API and
  prints the response body. Paths start with `v1/`. `--method M` selects the
  method, which is `GET`, or `POST` when `--data JSON` is given. A response
  with status 400 or above prints `HTTP <status>` to stderr and exits 1.
- `screenshot <path> --out FILE` saves a headless screenshot of the signed-in
  page. The path starts with `/` and defaults to `/`. `--viewport WxH` sets the
  size (default `1440x900`), and `--full-page` captures the whole page. The
  command waits up to 30 seconds for `main.lab-shell`; `--wait-for CSS` names
  another selector. A relative `--out` is resolved against the directory you
  ran `pnpm` from.

`screenshot` uses the checkout's Playwright Chromium. Install it once:

```bash
pnpm --filter @orchardworks/agent-remote-lab exec playwright install chromium
```

### Machine-readable output

`status --json` prints one JSON report. Like plain `status`, it exits 0 only
when the instance is ready: running, the local user signed in, and the
Controller registered. It exits 3 in every other case. With no instance for this
checkout it prints `{"state":"none"}` and exits 3. The report includes `state`,
`origin`, `localUser`, `controllerUplink` (`registered` when ready), `build`
(revision, dirty flag, start time and PIDs of the running build) and `checkout`
(the checkout's revision and dirty flag now, to compare with `build`).
`list --json` prints an array with one object per instance.

pnpm prints a script banner on stdout before the command's own output, so a
script should run:

```bash
pnpm --silent local status --json
```

pnpm 10 rejects the short form `-s`. Exit codes: 0 success, 1 failure, 3
`status` found no instance or one that is not ready.

### Sign-ins

The site allows 30 sign-ins per minute, shared with your browser. `status`,
`api` and `screenshot` each sign in once as the local user and sign out again
(`status` only while the instance is running). `up` polls `/health` while it
waits, then signs in twice: once to confirm the local user and once for the
status it prints. `list`, `logs` and `controller` never sign in. Past the limit,
`api` and `up` fail with an explicit message (see
[Troubleshooting](#troubleshooting)), and `status` reports the local user as
unavailable. Do not call `status` or `api` in a tight loop.

### Cleaning up

Before you remove a worktree, stop and delete its instance from that worktree:

```bash
pnpm local down
pnpm local remove --yes
```

Neither command deletes the test sessions; they remain in the shared native
histories.

If the worktree is already gone, its instance is still on the machine, and
`pnpm local list` from any checkout shows it. Its directory is
`<root>/instances/<name>`: `<name>` is the name column of `list`, and `<root>`
is `~/.agent-remote-control-dev` unless `ARC_LOCAL_ROOT` names another
directory (set it the same way for `list`).

If that directory holds a `runtime.json`, its `runnerPid` and `controllerPid`
may still run. Confirm each with `ps -ww -o command= -p PID`. The runner shows
`node …/scripts/local/runner.mjs <directory>` and the Controller shows
`…/packages/agent-host/dist/cli.js foreground`; leave any other process alone,
because the PID may belong to something else by now. Stop the runner with
`kill PID`, which stops its Controller and closes the site. If the Controller
still runs, stop it the same way. Then delete the instance directory.

## How it works

Each checkout has one instance, named after the checkout directory and an
eight-character hash of its real path:

```
~/.agent-remote-control-dev/instances/<checkout>-<hash>/
  instance.json   checkout path, port and origin
  runtime.json    current run: checkout commit and dirty flag at start, runner and Controller PIDs
  relay/          site state and local identity
  controller/     development Controller state, including its pairing
  workspace/      the Controller's only allowed workspace
  logs/           runner.log and controller.log of the current run
  operation.lock/ present only while a command is changing the instance
```

`up` builds the Controller, the website and the Devbox server bundle, then
starts a detached runner. The runner serves the site on
`http://localhost:<port>` and starts the Controller from the same checkout
(`packages/agent-host/dist/cli.js foreground`) with its own state directory.
The first start pairs it through the local identity; later starts reuse its
device credential. The port is chosen on the first start and kept, because the
local identity is bound to the origin. The site listens on the loopback
interface only, and `up` refuses to start while either `127.0.0.1` or `::1`
holds the port. The instance signs in anyone who can reach its port, so never
forward or publish it.

`down`, and the stop that `up` performs before it restarts, ask the runner to
stop; it stops the Controller and then closes the site. Commands that change an
instance run one at a time, guarded by `operation.lock`.

Nothing is installed as a login service and nothing survives a reboot. Your own
Controller, its state and its launchd service are not touched, but see
[Shared native profiles](#shared-native-profiles) for what the instance does
share.

## Environment variables

Set these in the shell that runs `pnpm local`.

| Variable | Meaning | Default |
| --- | --- | --- |
| `ARC_LOCAL_ROOT` | Directory that holds `instances/`. Set it for every command: instances under another root are not seen. The tests use a temporary directory. | `~/.agent-remote-control-dev` |
| `ARC_LOCAL_READY_TIMEOUT_MS` | How long `up` waits for the site and the Controller registration, as a positive whole number of milliseconds. | `90000` |
| `ARC_LOCAL_WEB_DIST` | Absolute path of the website build the instance serves; `up --no-build` checks it for `index.html`. `up` does not build into it. The tests use it. | `dist/relay/web` in the checkout |

## Shared native profiles

The development Controller uses the same `~/.claude`, `~/.codex` and other
native profiles as your own Controller, so no extra sign-in is needed. Its
environment is explicit: the launching shell's `AGENT_*`, `CLAUDECODE` and
similar variables are not passed on, and trusted full control is explicitly
disabled.

| Shared | Effect |
| --- | --- |
| Native sessions | The Controller only lists, creates and opens sessions inside the instance workspace and locks permission settings. Claude Code also runs in its restricted sandbox; Codex and Copilot sessions run with their own permissions, so only their working directory is checked. Test sessions are stored in the native histories and also appear in your own Controller. |
| Session ownership | Recorded in the profile (`.arc-session-owners`), so both Controllers see which one owns a session. |
| Codex daemon, OpenCode server | Never started, restarted or updated by the instance (`AGENT_HOST_CODEX_AUTO_START=0`, `AGENT_HOST_OPENCODE_AUTO_START=0`). Codex sessions use your running Codex daemon; without it, Codex is unavailable. OpenCode may be unavailable, because its server credentials belong to your own Controller's state. |
| Per-session stores | Permission modes, references and creation records under `~/.agent-remote-control/session-*` are keyed by session, so test sessions add entries there. |

In the instance website, do not use Controller update, Codex daemon restart,
OpenCode server or VS Code tunnel controls. Controller update would replace
this checkout's build; the other controls act on processes your own Controller
also uses. Claude Code and Codex are covered end to end; OpenCode Ask callbacks
go through the shared server.

## Troubleshooting

Messages print the absolute path of the instance directory. In this table,
`<instance>` is a placeholder for that path, which has the form
`<root>/instances/<checkout>-<hash>`.

| Symptom | Check |
| --- | --- |
| `Port <port> is in use by another process` | Another program holds the instance's port on `127.0.0.1` or `::1`. Free it; the origin cannot change. Alternatively run `pnpm local remove --yes`, then `pnpm local up`: the new instance gets a new port, at the cost of the old instance's site state and Controller pairing. |
| `Build artifacts are missing (…)` | `--no-build` found no earlier build. Run `pnpm local up` without it. |
| `The runner exited during startup.` | The error ends with the last lines of `runner.log` and `controller.log`; `pnpm local logs` shows more. The log names the reason, for example `This instance's Controller state belongs to another site origin. Remove the instance with pnpm local remove --yes.` and `The instance's saved Controller connection is unreadable (…)`. For the second, check `<instance>/controller/connection.json` without pasting it anywhere: it holds the device key. |
| `The instance did not become ready within 90 seconds while waiting for the site` (or `…for Controller registration`) | `up` stopped the runner it started and printed the log tails. Read them, or raise `ARC_LOCAL_READY_TIMEOUT_MS` on a slow machine. |
| The Controller never registers | `pnpm local controller diagnostics --source controller --limit 60`. |
| `orphaned` in `status`; `The runner is gone but Controller pid <pid> still runs. Stop that process, then retry.` | The runner died while its Controller kept running. Stop that Controller (`ps -ww -o command= -p PID` shows `…/packages/agent-host/dist/cli.js foreground`), then `up`. |
| `A previous local command (pid <pid>) was interrupted and left its lock. Remove <instance>/operation.lock and retry.` | A `pnpm local` command was killed before it could release its lock. Remove that directory, then retry. |
| `Another local command is changing this instance. If none is running, remove <instance>/operation.lock.` | Wait for the running `pnpm local` command to finish. If none is running, remove that directory. |
| `This environment does not allow listening on local ports (EPERM)` or `This environment does not allow starting background processes (EPERM)` | The session's sandbox refuses the local listener or the detached runner (the code can also be `EACCES`). Run `pnpm local` from a session without the sandbox (YOLO mode). |
| `The instance's sign-in limit (30 per minute) is exhausted; retry within a minute.` | Too many sign-ins in the last minute, counting your browser. Wait a minute, then retry. |
| `Playwright is not ready in <checkout>.` | Install dependencies in that checkout, then run the `playwright install chromium` command the message names. |
| A provider is missing | It is not installed or detected on this machine, or Codex has no running daemon. Install the provider or sign in to it natively, then run `pnpm local up` again. |

## Testing the launcher

`pnpm test:local-env` runs the launcher's unit and integration tests with a
temporary home and instance root. It needs the Controller build and Playwright's
Chromium to exist first.
