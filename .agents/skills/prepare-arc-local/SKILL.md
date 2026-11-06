---
name: prepare-arc-local
description: Use for requests such as "run the site locally", "check this UI change in a browser" or "take a screenshot of the local site", and to verify website, Relay or Controller changes in this checkout's `pnpm local` instance with a headless browser or a real session. Do not use for documentation-only or unit-test-only changes, releases or deployment, or the user's own Controller.
---

# Prepare and operate the local instance

`pnpm local` runs this checkout's complete product: the website and Relay with a
built-in local user (no sign-in) and a development Controller paired to it. Each
checkout or worktree has its own instance, port and state under
`~/.agent-remote-control-dev/instances/`. macOS is the primary platform and Linux
is supported; Windows is not. The
[local development guide](../../../docs/local-development.md) owns the mechanism,
commands, environment variables and troubleshooting table; this skill says how to
use it safely and what counts as evidence.

## Before you start

`pnpm local` needs a session that may listen on local ports and start background
processes, and Chromium for screenshots. If `up` prints `This environment does not
allow listening on local ports` or `… starting background processes`, or Chromium
cannot start, stop and ask the user to re-run the work in a session without those
restrictions (Claude Code: bypass-permissions mode; Codex: full access; the
launcher's messages call this YOLO mode). You cannot change this yourself; do not
work around the sandbox. Meanwhile you can still run unit tests; the
[Stop and ask the user](#stop-and-ask-the-user) table says what to report as not
exercised.

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
change; a check against an older build is not a check of your change. If the
instance is already running, check first per
[Before restarting a running instance](references/lifecycle.md#before-restarting-a-running-instance):
`up` restarts it and interrupts its sessions.

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

## Safety rules

The development Controller shares `~/.claude`, `~/.codex` and the other native
profiles with the user's own Controller.

- **Own sessions only.** Sessions run only in the instance `workspace/` and you
  operate only sessions you created there. Never take over, stop, archive or
  rename any other session. Claude Code sessions are sandboxed in the instance;
  Codex and Copilot sessions run with their own permissions and are confined only
  by their working directory, so keep their prompts inside the workspace.
- **The user's own Controller.** Never stop, update, re-pair or reconfigure it
  (`~/.agent-remote-control/agents-cloud-cli`, its launchd service), and never
  touch the production site. Operate this instance only through `pnpm local`; do
  not use the global `agent-remote-controller` command for it. (The
  `agent-remote-sessions` skill uses that command legitimately to read the user's
  own sessions; that is a different task.)
- **Instance website controls.** Never use the instance website's Controller
  update, Codex daemon restart, OpenCode server or VS Code tunnel controls.
  Controller update would replace this checkout's build; the others act on
  processes shared with the user's own Controller.
- **Headless browser only.** Never use the user's own browsers, profiles or
  windows, or tools that drive them (DevTools-attached browsers, computer use).
  Use the headless script in [browser](references/browser.md).
- **No secrets in output.** Never print cookies, pairing keys,
  `controller/connection.json` or whole configuration files.
- **Own instance only.** Run `down` and `remove` only for the current checkout's
  instance. Other rows in `pnpm local list` may belong to other agents.
- **Clean up before removing a worktree.** Run `pnpm local down` and
  `pnpm local remove --yes` in it first.

## Stop and ask the user

These conditions end your work on the instance until the user answers. Stop and
ask the user; do not work around them.

| Condition | Ask for | If it stays open, report as not exercised |
| --- | --- | --- |
| The environment refuses local servers or background processes, or Chromium cannot start ([Before you start](#before-you-start)) | A session without those restrictions | Page, Feature, Model turn (Site and Controller too when `up` was refused) |
| The instance was not started by this task and may be in use, before `up` restarts it ([lifecycle](references/lifecycle.md#before-restarting-a-running-instance)) | Permission to restart: it interrupts running sessions | Every layer |
| A lock whose holder still runs a `pnpm local` command for this instance ([lifecycle](references/lifecycle.md#locks)) | Who runs it, and whether to wait | Every layer |
| Something that is not this instance holds the port or the recorded Controller pid ([lifecycle](references/lifecycle.md#port-held-by-another-process)) | Whether to free it | Every layer |
| Removing an instance with `pnpm local remove --yes`, which deletes its site state and pairing and gives it a new port. No question when the user just asked you to remove this checkout or its worktree | Confirmation | Every layer |
| A provider the check needs is missing from the Host or has no access (not signed in, no model access, Codex without its running daemon) | The user to install it or sign in natively; never start the Codex daemon | Model turn, and Feature when it needs a session |

Anything else that goes wrong — a failed check, a timed-out turn, a sign-in limit
you waited out, an unexpected page — is a result: note it in the report and
continue with the remaining layers. Layers verified before you stopped stay
verified; say why each other layer was not exercised.

## Report

```
Origin: http://localhost:<port>
Build: running <commit>[ (dirty)]; checkout <commit>[ (dirty)]
<layer>: verified | failed | not exercised — <what you observed, or why not>
  (one line each for Build, Site, Controller, Page, Feature, Model turn)
Screenshots: <path> — <what it shows>
Instance: left running at <origin> | stopped
```

Leave an instance you started running when the user may want to look at it, and
say so with its origin. A later `up` restarts it and interrupts its sessions, so
whoever restarts it must check `status` first. Stop an instance you started with
`pnpm local down` when nobody needs it. An instance you found running stays
running, restarted or not.
