# Instance lifecycle

Run all commands from the checkout being verified. The
[guide](../../../../docs/local-development.md#commands) has the command reference
and, under [How it works](../../../../docs/local-development.md#how-it-works), the
layout of the instance directory.

| Command | Use |
| --- | --- |
| `pnpm local up` | Build this checkout, then start or restart its instance. Prints status when ready. Read [Before restarting](#before-restarting-a-running-instance) and [Run `up` to completion](#run-up-to-completion) first. |
| `pnpm local up --no-build` | Restart from the existing build output, only when no code changed. |
| `pnpm --silent local status --json` | State, URL, local user, Controller uplink, command line sign-in, running build and checkout commit. Exit 0 only when ready, 3 otherwise. |
| `pnpm local logs` | Last 80 lines of the runner (site) and Controller logs of the current run. Do not use `--follow`: it never exits. |
| `agent-remote-controller-dev diagnostics --source controller --limit 60` | Controller diagnostics. `agent-remote-controller-dev status` shows the uplink, `--build-info` the instance and build; its other commands drive sessions, Hosts and Windows: see [command line](cli.md). |
| `pnpm local list` | Every instance on this machine; `*` marks this checkout. |
| `pnpm local down` | Stop this checkout's instance; state is kept. |
| `pnpm local remove --yes` | Delete this checkout's stopped instance with its site state and Controller pairing. Stop and ask the user first ([when](../SKILL.md#stop-and-ask-the-user)). |

## Before restarting a running instance

`up` stops a running instance before it starts it again. That interrupts its
running sessions: native history persists, active turns and pending approvals do
not. Before `up` on an instance that may already be running, list its sessions:

```bash
agent-remote-controller-dev session list --limit 50
```

It never signs in. Restart when no session shows `"state": "running"` or
`"waiting"`, or when every such session is one this task started. Otherwise
someone is using the instance: stop and ask the user. When the command fails,
`pnpm local list` shows the instance's state (it does not sign in either); an
instance that is not `running` has nothing to interrupt.

## Run `up` to completion

A build can take minutes. Give `up` a tool timeout of at least 10 minutes, or run
it in the background and wait for it to exit. An `up` killed outright (a tool
timeout can do that) leaves `operation.lock` (see [Locks](#locks)); one
interrupted while it waits for readiness may leave the runner running, which
`pnpm local down` stops. Do not start a second `up` while one runs.

After changing code, run `pnpm local up`; use `--no-build` only to restart the same
build. `up` waits for readiness (90 seconds by default; the guide's
[environment variables](../../../../docs/local-development.md#environment-variables)
cover a slow machine), prints the status and exits 0. A failed build, or
`--no-build` without artifacts, leaves a running instance as it was.

## Read status

```
Instance: <name> (running)
Site: http://localhost:<port>  local user: signed in
Controller: uplink registered (pid <pid>)  command line: signed in
Running build: <12-character commit>[ (dirty)] since <time>; checkout now <12-character commit>[ (dirty)]
State: <instance directory>
```

The instance is ready when the state is `running`, the local user is signed in
and the uplink is `registered`. `up` also signs the instance's Controller command
line in as the local user; `command line: signed out` only affects the commands
that go through the site (see [command line](cli.md#sign-in)). The guide lists the
[other states](../../../../docs/local-development.md#commands) and what clears
them.

`Running build` is the commit and dirty flag recorded when the instance started;
`checkout now` is read at the time of the call. A different commit means the build
is old. `Running build` keeps the dirty flag from the start, so further edits to
an already dirty checkout do not show in `status`: run `pnpm local up` after your
last edit before you verify. `local user: unavailable` on a running instance can
be the sign-in limit: wait a minute instead of calling `status` again.

## When something fails

`up` prints the last 20 lines of `runner.log` and `controller.log` after a
startup failure; read them first, then `pnpm local logs`. The guide's
[troubleshooting table](../../../../docs/local-development.md#troubleshooting)
lists every message with its cause and fix. These cases need a decision from you.
In them, `<instance>` is the `State:` directory from `status`.

### Port held by another process

`Port <port> is in use by another process.` Identify the holder, running `ps` for
each pid that `lsof` lists:

```bash
lsof -nP -iTCP:<port> -sTCP:LISTEN
ps -ww -o command= -p <pid>
```

If `lsof` or `ps` is refused or shows nothing usable, the holder cannot be
confirmed: stop and ask the user.

- `node …/scripts/local/runner.mjs <instance>`, ending in this instance's own
  directory, is its leftover: `kill <pid>`, then `up`.
- Another instance's runner (`scripts/local/runner.mjs <other instance directory>`,
  usually another checkout) or anything else not from this instance: stop and ask
  the user. Do not stop it.
- `pnpm local remove --yes` then `up` gives a new port at the cost of the site
  state and the pairing: only after you stop and ask the user.

### Locks

A message naming `<instance>/operation.lock` means a `pnpm local` command holds,
or left behind, that lock. Read the owner's `pid` from
`<instance>/operation.lock/owner.json` and check its command with
`ps -ww -o command= -p <pid>`. The message does not decide it: `A previous local
command (pid <pid>) was interrupted…` means the pid is not running, but
`Another local command is changing this instance…` also appears when an unrelated
program reused the pid.

- The command is a `pnpm local` or `node …/scripts/local/command.mjs …` process for
  this checkout: another command is changing this instance. Do not remove the
  lock. Wait for it when it is yours, such as your own background `up`; otherwise,
  or when it still runs after a few minutes, stop and ask the user.
- The pid does not run, or runs an unrelated program: the command is gone. Remove
  `<instance>/operation.lock` and retry.
- `owner.json` is missing or unreadable: the command may be starting. Retry once
  after a few seconds; if the message is unchanged, stop and ask the user.

### Orphaned Controller

`The runner is gone but Controller pid <pid> still runs.` State `orphaned`.
`ps -ww -o command= -p <pid>` must show
`<this checkout>/packages/agent-host/dist/cli.js foreground`, with this checkout's
path. Only then `kill <pid>`, then `up`. Any other command is not this instance's:
stop and ask the user.

### Other messages

- `…belongs to another site origin. Remove the instance with pnpm local remove --yes.`
  and `The instance's saved Controller connection is unreadable (…)`: stop and ask
  the user before `remove --yes`, and do not print `controller/connection.json`.
- `This environment does not allow listening on local ports (EPERM)` or
  `… starting background processes (EPERM)`: [Before you start](../SKILL.md#before-you-start).
- A sign-in limit message: wait a minute, then run the command once; never retry in
  a loop. The limit is in the [sign-in budget](../SKILL.md#machine-use-and-the-sign-in-budget).
- The instance did not become ready: `up` already stopped the runner it started.
  Read the log tails and `agent-remote-controller-dev diagnostics --source controller --limit 60`.
- A provider that never appears is not installed or detected on this Mac, or Codex
  has no running daemon: stop and ask the user, as the provider row of
  [Stop and ask the user](../SKILL.md#stop-and-ask-the-user) says.

## Clean up

Stop an instance you started with `pnpm local down` when nobody needs it. Before
removing a worktree, run `pnpm local down` and then `pnpm local remove --yes` in
it; `remove` refuses a running instance. Neither command deletes test sessions:
they stay in the shared native histories and the user's own Controller lists them.
For an instance whose worktree you removed and left behind, follow the guide's
[Cleaning up](../../../../docs/local-development.md#cleaning-up), for that instance
only.
