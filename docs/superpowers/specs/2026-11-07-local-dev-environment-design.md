# Native local development environment and its skill

Status: approved design on 2026-11-07; not implemented.

## Problem

Agents that change the website, Relay or Controller have no quick way to see the
complete product running their own source. The production site requires a
main-site login and the user's own Controller is paired with it; deploying to
check a change is an outward-facing release.

The Local Devbox (`deploy/devbox`, [docs/devbox.md](../../devbox.md)) already
signs a local browser in without credentials and pairs its Controller
automatically, but it only runs in Docker: every source change rebuilds the
image, the native CLIs inside are Linux builds that must be signed in again, and
macOS behaviour is not exercised. `pnpm start` runs the diagnostic Lab, not the
product. No skill tells an agent how to prepare, refresh, verify or drive a
local environment.

Daynight solved the same problem with a development CLI channel, an isolated
state root, a test identity and the `prepare-daynight-local` skill. This design
gives Agent Remote Control the equivalent, adapted to its architecture.

## Decisions

| Question | Decision |
| --- | --- |
| Runtime | Native macOS from source is primary. The Docker Devbox stays as the isolated alternative and is unchanged. |
| Native profiles | The development Controller shares the user's `~/.claude` and `~/.codex` (and other native homes). No credential import or re-login. |
| Granularity | One environment per worktree, each with its own port, Relay state and Controller state, so parallel agents verify their own changes independently. |
| Implementation | Reuse the Devbox server (`createDevboxServer`) unchanged for local identity and pairing; add a native launcher under `scripts/local/`. |

Rejected alternatives: extending the `pnpm start` Lab launcher (it serves the
diagnostic Lab and only runs attached), and a Docker Devbox per worktree with
the native homes mounted (Linux behaviour, slow rebuilds, macOS profiles are
not portable into a Linux container).

## Command

Run from a worktree (or the main checkout) as `pnpm local <command>`:

| Command | Behaviour |
| --- | --- |
| `up [--no-build]` | Build, then start or restart this worktree's instance; print its URL when ready. |
| `down` | Stop this worktree's instance and keep its state. |
| `status` | Source path and commit, dirty state, URL, process IDs, whether the Controller is registered. |
| `logs [--follow]` | Site and Controller logs. |
| `list` | Every instance on this machine with its source, port and running state. Read-only for other instances. |
| `remove --yes` | Delete this worktree's stopped instance directory. |
| `controller <args>` | Run the development Controller CLI with this instance's state directory; only `status`, `diagnostics`, `window`, `session` and `environment` are allowed. |
| `api <path> [--method M --data JSON]` | Authenticated JSON request to the instance's user API, for example `v1/remote/hosts`. |
| `screenshot <path> --out FILE [--viewport WxH]` | Headless screenshot of a signed-in page. |

The script name `local` must be checked against pnpm built-in commands during
implementation; if pnpm intercepts it, use `pnpm local-env` with the same
subcommands.

## Instance layout

Instances live outside every repository so test sessions do not load this
repository's agent instructions and removing a worktree cannot delete a running
instance's state:

```
~/.agent-remote-control-dev/instances/<worktree-name>-<path-hash>/
  instance.json   checkout path, port and origin (written once)
  runtime.json    current run: build commit and dirty flag, runner and Controller PIDs (written by the runner)
  relay/          Devbox server state (identity.json, relay/state.json)
  controller/     AGENT_HOST_STATE_DIR of the development Controller
  workspace/      test workspace; the Controller's only allowed workspace root
  logs/           runner, site and Controller logs
```

`<path-hash>` is derived from the worktree's real path, so the directory name
is stable for a worktree and distinct across worktrees with the same name.
`ARC_LOCAL_ROOT` overrides `~/.agent-remote-control-dev` (tests always set it).
`instance.json` and `runtime.json` hold no credentials; the Controller's
`connection.json` under `controller/` holds the device key and must never be
printed.

## Lifecycle

`up`:

1. Builds with `pnpm build`, `pnpm build:relay` and `pnpm build:devbox` unless
   `--no-build` is given. A failed build leaves a running instance untouched.
2. Allocates a free loopback port on first start and records it. The origin is
   `http://localhost:<port>`; the Devbox identity is bound to that origin, so a
   recorded port is reused and a change is refused. If another process holds the
   recorded port, `up` stops with an error instead of choosing a new one.
3. Stops a running instance of this worktree (runner first, which stops the
   Controller and then the site), then starts a detached runner process with its
   output in `logs/`.
4. The runner starts `createDevboxServer` from `dist/devbox/server.mjs`, obtains
   a Host invitation through the server's local identity (first start only; later
   starts reuse the Controller's saved device credential), then starts
   `packages/agent-host/dist/cli.js foreground` from the same worktree.
5. `up` returns when `/auth/status` returns the `devbox` user and
   `controller status` reports `uplink: registered`, or fails with the log
   location after a bounded wait.

`down` sends SIGTERM to the runner, which stops the Controller (TERM, then
process-group KILL after a deadline) and closes the site. Stale PIDs in
`instance.json` are detected and reported rather than signalled.

The runner never installs a launchd service, never uses the Controller's
`start` daemon mode, and does not survive a reboot.

## Development Controller environment

The runner builds the Controller environment from an allowlist (`HOME`, `PATH`,
`USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TMPDIR`, `TERM`) and adds:

| Variable | Value |
| --- | --- |
| `AGENT_HOST_STATE_DIR` | `<instance>/controller` |
| `AGENT_HOST_WORKSPACE` | `<instance>/workspace` |
| `AGENT_HOST_ALLOWED_WORKSPACE_ROOTS` | `["<instance>/workspace"]` |
| `AGENT_HOST_NAME` | `Dev · <worktree-name>` |
| `AGENT_HOST_SERVER`, `AGENT_HOST_REMOTE_KEY` | Instance origin and invitation, first start only |
| `AGENT_HOST_CODEX_AUTO_START` | `0` |
| `AGENT_HOST_OPENCODE_AUTO_START` | `0` |

Inherited `AGENT_*`, `CLAUDECODE`, `CLAUDE_CODE_*` and similar session variables
are not passed, so a launcher run from inside an agent session does not leak its
grants or nested-session markers. `AGENT_HOST_TRUSTED_FULL_CONTROL` is never
set: the Controller's execution policy (`execution-policy.ts`) then refuses to
create, open or resume any session whose workspace is outside the allowed root,
and locks permission settings. Native profile variables (`CLAUDE_CONFIG_DIR`,
`CODEX_HOME`) are not set, so the shared default homes are used.

The development Controller reuses the Codex daemon and OpenCode server that the
user's own Controller keeps running; with auto-start disabled it never starts,
restarts or updates them. If no Codex daemon is running, Codex is unavailable in
the instance.

## Safety model for shared native profiles

Sharing `~/.claude` and `~/.codex` means the development Controller sees the
same native session stores and coordinates session ownership with the user's
Controller through `<profile>/.arc-session-owners`. The guarantees and residual
risks are:

- Code-enforced: sessions can only be created or opened inside the instance
  workspace; permission settings are locked to native defaults.
- Not isolated: test sessions are written to the shared native histories (under
  paths inside `~/.agent-remote-control-dev`, so they are easy to recognise) and
  appear in the user's own Controller as ordinary sessions.
- Not isolated: the Codex daemon and OpenCode server are shared processes.
  OpenCode callbacks (Ask) go through the shared server's plugin, so only Claude
  and Codex are covered end to end.
- Rule-enforced by the skill: agents operate only sessions they created in the
  instance workspace and never take over, stop or archive any other session.

## Skill

`.agents/skills/prepare-arc-local/`, with `.claude/skills` as a symlink to
`../.agents/skills` so Codex and Claude Code read the same files. AGENTS.md gets
one line pointing to it. The skill connects the mechanisms; the human guide
`docs/local-development.md` owns the mechanism details.

```
prepare-arc-local/
  SKILL.md               purpose, when to use, which reference to read, hard rules
  references/
    lifecycle.md         up, down, status, logs, list, remove; ports, build failures, refresh, cleanup
    verification.md      verification layers and the evidence each requires
    browser.md           headless Playwright usage and the screenshot command
    api.md               reading state through `pnpm local api`; when API writes are acceptable
    test-loop.md         the complete test loop
```

Browser: the repository's Playwright with its bundled Chromium, headless, as
the existing e2e suites use. Any local browser context is signed in on first
request, so no login helper is needed. `browser.md` carries a runnable script for
readiness waits, screenshots, a mobile viewport and basic interaction. The
user's own browsers, profiles and windows are never used.

Verification layers, each reported as verified, failed or not exercised with
its observation:

1. Build: source path, commit and dirty state.
2. Site: the running runner serves this worktree's build; `/auth/status` returns
   the `devbox` user.
3. Controller: registered with the site; providers detected.
4. Page: headless browser shows the signed-in product; screenshot retained.
5. Model turn: a new Claude or Codex session in the instance workspace completes
   a real reply.

An HTTP check or a screenshot is not evidence that a model turn works.

Test loop: `pnpm local up` and status check; select Host `Dev · <worktree>` and
a provider in the page; create a session in the instance workspace and send a
short prompt; observe the complete reply; exercise the feature under change
(Window, Side, Team, references and so on) through the real page controls;
record screenshots and the result. API writes may prepare fixtures but never
replace the page leg of a UI check.

Hard rules in `SKILL.md`:

1. Operate only sessions you created in the instance workspace. Never take over,
   stop or archive any other session.
2. Never touch the user's Controller (`~/.agent-remote-control/agents-cloud-cli`,
   its launchd service, the global `agent-remote-controller`) or the production
   site. Operate the instance only through `pnpm local`.
3. In the instance website, do not use Controller update, Codex daemon restart,
   OpenCode server or VS Code tunnel controls; they act on processes shared with
   the user's Controller.
4. Never use the user's own browsers, profiles or windows.
5. Never print cookies, pairing keys, `connection.json` or whole configuration
   files.
6. Run `down` and `remove` only for your own worktree's instance; other
   instances in `list` may belong to other agents.
7. Run `pnpm local down` before removing a worktree.
8. In a sandboxed session, listening and spawning can be refused; report it and
   say that YOLO mode is needed instead of working around the sandbox.

## Testing

`pnpm test:local-env` (also part of `pnpm test:setup`), with per-test and outer
process deadlines like every root test command:

- Launcher unit tests (`node --test`, temporary `ARC_LOCAL_ROOT`, never the real
  HOME): stable instance naming from a worktree path; port allocation recorded and
  reused, an occupied recorded port refused; Controller environment allowlist
  and added variables, with `AGENT_*`, `CLAUDECODE` and
  `AGENT_HOST_TRUSTED_FULL_CONTROL` removed; stale PID detection; `down` and
  `remove` scoped to the current instance.
- Integration test: real `createDevboxServer` and the real development
  Controller with a temporary HOME and a PATH without native CLIs. `up --no-build` signs
  `/auth/status` in without credentials; the Controller reports
  `uplink: registered`; `status` and `api v1/remote/hosts` show the Host; `down`
  stops both processes and keeps state; a second `up` reuses the port, identity
  and device credential.

Manual acceptance after implementation, in the feature worktree with the real
shared profiles: headless screenshot of the signed-in page with
`Dev · <worktree>` online; a Claude session in the instance workspace completes a
real reply; opening a session outside the workspace is refused; the user's own
Controller stays registered and its running sessions are unaffected;
`pnpm local down`.

## Documentation

- `docs/local-development.md`: what the environment is, commands, instance
  layout, shared-profile limits, troubleshooting.
- README "Run locally": link to it.
- AGENTS.md: one line to use `prepare-arc-local` for local verification.

## Delivery boundaries

Work happens in `.worktrees/local-dev-env` on `feat/local-dev-env`. No push,
release or deployment. `pnpm compatibility:update` and
`pnpm compatibility:check` run after the implementation. The Docker Devbox, the
Lab and `pnpm start` keep their current behaviour.

## Implementation checks

Facts to confirm early in implementation, because the design depends on them:

- `pnpm local` reaches the root script and is not a pnpm built-in.
- `agent-remote-controller status` reports a `foreground` Controller's uplink
  when given the same `AGENT_HOST_STATE_DIR`.
- With auto-start disabled, the development Controller attaches to the running
  shared Codex daemon and never starts, restarts or updates it.
- Session listing from the development Controller does not offer to open
  sessions outside the allowed root, or opening them is refused with a clear
  message.
