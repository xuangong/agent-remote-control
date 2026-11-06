# Instance lifecycle

Run all commands from the checkout being verified. The
[guide](../../../../docs/local-development.md) has the full command reference and
the layout of the instance directory.

| Command | Use |
| --- | --- |
| `pnpm local up` | Build this checkout, then start or restart its instance. Prints status when ready. |
| `pnpm local up --no-build` | Restart from the existing build output, for example after `down` or a startup failure that needed no code change. |
| `pnpm --silent local status --json` | State, URL, local user, Controller uplink, running build and checkout commit. Exit 0 only when ready, 3 otherwise. |
| `pnpm local logs` | Last 80 lines of the runner (site) and Controller logs of the current run. Do not use `--follow`: it never exits. |
| `pnpm local controller diagnostics --source controller --limit 60` | Controller diagnostics. `controller status` shows the uplink. Its `session` and `window` subcommands act on sessions, so hard rule 1 applies. |
| `pnpm local list` | Every instance on this machine; `*` marks this checkout. |
| `pnpm local down` | Stop this checkout's instance; state is kept. |
| `pnpm local remove --yes` | Delete this checkout's stopped instance, including its site state and Controller pairing. |

## Start and refresh

After changing code, run `pnpm local up`: it builds the Controller, the website
and the Devbox server bundle, then restarts the instance. Use `--no-build` only
to restart the same build. In a worktree without `node_modules`, `up` installs
dependencies first.

A build can take minutes: give the command a long timeout, and do not start a
second `up` while one runs. `up` then prints `Waiting for the site…` and
`Waiting for Controller registration…`, waits up to 90 seconds
(`ARC_LOCAL_READY_TIMEOUT_MS` raises it on a slow machine), prints the status and
exits 0.

A failed build, or `--no-build` without artifacts, leaves a running instance as
it was. Restarting interrupts the instance's running sessions: native history
persists, active turns and pending approvals do not. The first `up` picks a free
port and keeps it, because the local identity is bound to the origin.

## Read status

```
Instance: <name> (running)
Site: http://localhost:<port>  local user: signed in
Controller: uplink registered (pid <pid>)
Running build: <12-character commit>[ (dirty)] since <time>; checkout now <12-character commit>[ (dirty)]
State: <instance directory>
```

The instance is ready when the state is `running`, the local user is signed in
and the uplink is `registered`. The other states are `stopped` (run `up`),
`stale` (the recorded processes are gone; `up` or `down` clears the record),
`orphaned` (see below) and `unknown` (the reason is printed).

`Running build` is the commit and dirty flag recorded when the instance started;
`checkout now` is read at the time of the call. A different commit means the build
is old. `Running build` keeps the dirty flag from the start, so further edits to
an already dirty checkout do not show in `status`: run `pnpm local up` after your
last edit before you verify. `local user: unavailable` on a running instance can be the sign-in limit;
wait a minute instead of calling `status` again.

## When something fails

`up` prints the last 20 lines of `runner.log` and `controller.log` after a
startup failure; read them first. Causes and extra steps are in the guide's
[troubleshooting table](../../../../docs/local-development.md#troubleshooting).

| Message | Do |
| --- | --- |
| `Build step failed: <command>. A running instance was left unchanged.` | Fix the build error printed above it, then `up` again. |
| `Build artifacts are missing (…). Run pnpm local up without --no-build.` | Run `pnpm local up`. |
| `Port <port> is in use by another process. The origin <origin> cannot change; free the port and run up again.` | Find the holder with `lsof -nP -iTCP:<port> -sTCP:LISTEN`; stop it only when it is your own leftover, otherwise report it. As a last resort `pnpm local remove --yes` then `up` gives a new port and loses the site state and pairing. |
| `The runner exited during startup.` | Read the log tails. `This instance's Controller state belongs to another site origin. Remove the instance with pnpm local remove --yes.` means exactly that. `The instance's saved Controller connection is unreadable (…)`: report it and do not print `controller/connection.json`. |
| `The instance did not become ready within <n> seconds while waiting for the site.` (or `… for Controller registration.`) | `up` already stopped the runner it started. Read the tails and `pnpm local controller diagnostics --source controller --limit 60`. |
| `The runner is gone but Controller pid <pid> still runs. Stop that process, then retry.` | State `orphaned`. `ps -ww -o command= -p <pid>` must show `<this checkout>/packages/agent-host/dist/cli.js foreground`; only then `kill <pid>`, then `up`. Any other command is not yours. |
| `This environment does not allow listening on local ports (EPERM)` or `… starting background processes (EPERM)` | Hard rule 8: report it and ask for YOLO mode. |
| `A previous local command (pid <pid>) was interrupted and left its lock. Remove <instance>/operation.lock and retry.` or `Another local command is changing this instance. If none is running, remove <instance>/operation.lock.` | Hard rule 9. |
| `The instance's sign-in limit (30 per minute) is exhausted; retry within a minute.` | Wait a minute; do not retry in a loop. |

A provider that never appears is not installed or detected on this Mac, or
Codex has no running daemon: report it.

## Clean up

Stop instances you no longer need with `pnpm local down`. Before removing a
worktree, run `pnpm local down` and `pnpm local remove --yes` in it; `remove`
refuses a running instance (`Stop the instance with pnpm local down first.`).
Neither command deletes test sessions: they stay in the shared native histories
and the user's own Controller lists them. If a worktree you removed left its
instance behind, follow the guide's
[Cleaning up](../../../../docs/local-development.md#cleaning-up) for that
instance only.
