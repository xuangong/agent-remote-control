# A chief chooses where its bot works

Date: 2026-11-26 local (UTC+8); clock times below are UTC (2026-11-25 16:14 to 16:16). Branch `feat/bots-8-boards`, worktree `.worktrees/bots-8`,
build `0edeb29b7f59` (clean checkout), instance `bots-8-5ac6711d`. This is the live run left open by [bots step 10](../plans/2026-11-25-bots-10-hosts-plan.md).
It is a record of use, not a test: I played the owner with the helpers of the earlier records (`/tmp/hosts10/*.mjs`, outside the repository).

## Setup

- One Host (the instance's development Controller, `Dev · bots-8`, macOS, 10 cores, 16 GiB); the bots of the earlier records were still there.
- A standing Claude Code bot `Lead H10` with the mission "You lead a small tools team: you plan the work on your board and hand each piece to a bot you
  create for it."
- The person's request: a tiny `hello.sh` printing "hello from h10", given to a new standing bot that works in its own new folder `h10-tools`;
  "Decide which Host and folder it works on (look at the Hosts first), create it for a board item, and tell me where it works and why."

## What happened

1. The lead's new session showed permissions `bypassPermissions` (YOLO) without any change by the person. My approval loop answered nothing: no
   tool approval was asked during the whole run, in the lead or in the new bot.
2. The lead called `list_hosts`: one Host, online, providers codex, claude and copilot, CPU 14 % of 10 cores, memory 12.9 of 17.2 GB, one session,
   the workspace with its top folders.
3. It wrote board item 1 ("hello.sh printing \"hello from h10\""), then called `create_bot` with the item, the Host and `new_folder` `h10-tools`.
   The answer named the Host and the folder; the folder was created once under the workspace.
4. Item 1 got the links `host: Dev · bots-8` and `folder: …/workspace/h10-tools`, and the assignee is the new bot. The new bot `H10 Tools` runs with
   that folder as its working directory.
5. The lead told the person where the bot works and why: the only Host online, it has Claude, CPU about 14 % and memory about 75 % used, "plenty of
   room for a job this small"; a new folder named as asked keeps the work apart.
6. `H10 Tools` wrote `h10-tools/hello.sh` (executable, `echo "hello from h10"`), ran it, and reported on item 1 to the lead by `message` with
   `reply_to`. The lead checked the file itself and passed the result on. About two minutes from request to report.

## Assessment

- The step 10 path works end to end with a real model: the Host is read, chosen with a stated reason, the folder is created and recorded on the
  item, and the bot works there. The reason the lead gave follows the base instructions (CLI present, load, folder by purpose).
- Default YOLO holds for the owner's bot sessions: no approval in a run that wrote and ran a script.
- Not exercised: a second Host (the instance has one; E15 covers two paired Hosts with a scripted provider) and an existing folder chosen by `cwd`.
- Found on the way, outside step 10: after `pnpm local up`, the development command line's stored sign-in was rejected (`signed_out` on `api`) while
  `login` reported it was signed in; `logout` then `login` fixed it. `login` should renew a credential the Relay refuses.
