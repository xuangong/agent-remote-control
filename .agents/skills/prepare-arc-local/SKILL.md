---
name: prepare-arc-local
description: Use when verifying Agent Remote Control website, Relay or Controller changes in a local instance — preparing, refreshing or inspecting the per-checkout `pnpm local` environment, driving its signed-in site with a headless browser, reading its API, or running a real session through its development Controller. Excludes releases, Worker deployment and the user's own Controller.
---

# Prepare and operate the local instance

`pnpm local` runs this checkout's complete product on macOS: the website and
Relay with a built-in local user (no sign-in) and a development Controller
paired to it. Each checkout or worktree has its own instance, port and state
under `~/.agent-remote-control-dev/instances/`. The
[local development guide](../../../docs/local-development.md) owns the
mechanism; this skill says how to use it safely and what counts as evidence.

## Choose the reference

| Purpose | Read |
| --- | --- |
| Start, refresh, stop, inspect or clean up an instance | [lifecycle](references/lifecycle.md) |
| Decide what has been verified and report it | [verification](references/verification.md) |
| Look at or operate the website | [browser](references/browser.md) |
| Read state or prepare fixtures through the API | [api](references/api.md) |
| Run a real session end to end | [test loop](references/test-loop.md) |

Run every command from the checkout whose code you are verifying. An instance
runs the build it was started with. Rebuild with `pnpm local up` after every code
change; a check against an older build is not a check of your change.

## Machine use and the sign-in budget

Read state with `pnpm --silent local status --json` (pnpm 10 rejects `-s`; plain
`pnpm` prints a banner before the output). It exits 0 only when the instance is
ready and 3 otherwise; `{"state":"none"}` means this checkout has no instance.

The site allows 30 sign-ins per minute, shared with the user's own browser.
Every `status`, `api` and `screenshot` call and every new browser context signs
in once. Therefore:

- Never poll these in a loop. To wait for readiness, run `pnpm local up`; it
  polls `/health`, which does not sign in.
- Use one browser context per script.
- `list`, `logs` and `controller` never sign in.

## Hard rules

The development Controller shares `~/.claude`, `~/.codex` and the other native
profiles with the user's own Controller.

1. Sessions run only in the instance `workspace/` and you operate only sessions
   you created there. Never take over, stop, archive or rename any other
   session. Claude Code sessions are sandboxed in the instance; Codex and Copilot
   sessions run with their own permissions and are confined only by their working
   directory, so keep their prompts inside the workspace.
2. Never touch the user's own Controller — `~/.agent-remote-control/agents-cloud-cli`,
   its launchd service, the global `agent-remote-controller` command — or the
   production site. Operate the instance only through `pnpm local`.
3. Never use the instance website's Controller update, Codex daemon restart,
   OpenCode server or VS Code tunnel controls. Controller update would replace
   this checkout's build; the others act on processes shared with the user's
   Controller.
4. Never use the user's own browsers, profiles or windows. Use a headless browser
   as described in [browser](references/browser.md).
5. Never print cookies, pairing keys, `controller/connection.json` or whole
   configuration files.
6. Run `down` and `remove` only for the current checkout's instance. Other rows in
   `pnpm local list` may belong to other agents.
7. Before removing a worktree, run `pnpm local down` and `pnpm local remove --yes`
   in it.
8. A sandboxed session is refused listening sockets and detached processes:
   `This environment does not allow listening on local ports (EPERM)` or
   `This environment does not allow starting background processes (EPERM)` (the
   code can also be `EACCES`). Report the refusal and ask for YOLO mode; do not
   work around the sandbox.
9. Report a leftover-lock message. Remove `<instance>/operation.lock` only when the
   message says the previous command was interrupted. When it says another
   command is changing the instance, wait for that command; if after a few
   minutes no `pnpm local` command is running (check with `ps`), report it to
   the user before removing the lock.

## Report

State the instance origin, the running build's commit and dirty state, and for
each [verification layer](references/verification.md) whether it was verified,
failed or not exercised, with the observation. Leave the instance running when
the user may want to look at it, and say so; otherwise stop it.
