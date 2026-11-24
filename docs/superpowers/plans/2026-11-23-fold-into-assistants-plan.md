# Bots: plan

Builds the [bots design](../specs/2026-11-23-bots-design.md), decided with the owner on 2026-11-23: one kind of bot with a
mission, messages between bots, chains for the audit, work items for progress; Side, Call For Support, Team and TPM folded in.

## Before

No intermediate release (owner, 2026-11-23): `feat/assistant-tasks` and `feat/assistant-tasks-deployable` are not deployed on
their own, since step 2 replaces their mode switch and tools. Steps 1 and 2 build on them as stacked branches, each its own PR, and
the first deployment (Relay first, then Controllers) follows step 2. Each step below is one branch that ends with `pnpm verify`, the e2e flows on Chromium and
WebKit, and a check in `pnpm local`; protocol fixtures, schemas and compatibility metadata change with the step that changes them.
No release keeps an old path beside its replacement: the owner updates every Controller, so the Relay requires the new capability
once a step ships (Relay first, then Controllers).

## Step 1: the bot record and the chain

Implementation plans: [1a, the bot store](2026-11-23-bots-1a-bot-store-plan.md); 1b (standing instructions) and 1c (chains) follow.

1a is built on `feat/bots-1-record` (2026-11-23): bot records beside the Window rows, merged on read and reconciled after each
change, existing bots migrated on load with stable ids, assistant ids are bot ids, and the mission is written in a bot's details.
Unit suites and `pnpm verify:changed` pass; in `pnpm local` a mission saved from the page and the bot's id survived a restart.

1b (2026-11-23): the Relay names a Host's bots with their missions and the Controller opens a bot's session with the base
instructions and its mission. Live, a resumed Claude session did not see them: Claude Code ignores appended instructions on
`--resume`. So standing instructions also travel as a message when they change (design 5.1), built with step 2's delivery, which
comes next. Chains (1c) move to step 4, where the audit needs them; nothing before the audit depends on them.

- [x] Bot record (design 2.1, closes O70): `botId` stable across handoffs and moves, name, label, picture, mission, chief (a bot
  or the person), lifetime, main, status, work item, peers. Existing bots get ids from their group views; name, label and picture
  move out of `WindowBotDetails`. Built in `feat/bots-1-record`; `peers` are not built (`read_bot` reads any standing bot).
- [x] Mission as standing instructions; base instructions in the repository with a version (design 5.1).
- [x] Chains (design 7, built in step 4): every input the person sends and every timer tick opens one; messages and created bots carry its id and
  the usage providers report.

## Step 2: one kind of bot

Built on `feat/bots-1-record` (2026-11-23), toward the first deployment:

- **Inboxes.** Every bot has an inbox, a Team whose only seat is its main session, bound where it is; the Relay keeps it on the
  session the bot shows. Its standing instructions (base text, version 1, and mission, `standingInstructionsText` in the protocol)
  are queued there whenever the bot has not been sent that text; messages from other bots are queued there too (links are no longer
  created), with reply chains kept on the receiving inbox. Live: a new bot reported in from its instructions, and a bot messaged two
  others, one of which answered with `message_assistant`.
- **No mode.** The coordinator and plain switch is gone; every bot gets the task, message and room tools; any bot reaches any other.

Decided with the owner (2026-11-23): step 2 is finished before the first deployment, so what ships is the model, not a stage
that renames its tools later. How the rest is built:

- **A temporary bot is a projection of its task Team.** Its name is the task's title, its mission the brief, its chief the
  task's owner, its session the worker, its status the task's state; its `botId` is derived from the Team's id. No second record
  to keep in step, and the task cards and the details list keep showing them.
- **Every bot has the same `agent_remote` tools, called as its own session:** `create_bot`, `message` (with `status`),
  `list_bots`, `read_bot`, `stop_bot`, `retire_bot`, `update_mission`, and the room tools. A worker gets them too, instead of
  `report_task` and `ask_owner`. The Relay maps each `message` by who sends it to whom: a temporary bot to its chief is a report
  (`done`, `failed`), a question (`needs_input`) or progress; a chief to its temporary bot is input to the task; anything to a
  standing bot goes to its inbox.
- Messages between bots are at most 300 characters; a chief runs at most 12 bots.
- Then: standing bots from `create_bot` placed in the chief's group, `update_mission` for standing bots, replies from final
  text, attachments with bundles, the person's words to an organized bot, and the e2e flows of design 11.

Built (2026-11-23, `feat/bots-1-record`): every bot's tools (`create_bot` temporary and standing, `message` with `status`,
`list_bots`, `read_bot`, `update_mission`, `stop_bot`, `retire_bot`, the room tools) for main sessions and temporary bots alike; a
standing bot created by a bot starts with its instructions and tools, joins its chief's group, and can answer its first message;
300-character messages and 12 bots per chief; e2e flow E15 (temporary bots reporting as one input, a message and its answer
between standing bots, a standing bot created and placed). Live with Claude Code: a temporary bot reported its count, and a standing
bot wrote its file and reported to its chief.

Built (2026-11-24, `feat/bots-4-chains`), the rest of step 2. Owner rules: the end state only, no transition code for older peers
(the owner updates every Controller and Relay together), audit and notify rather than guardrails.

- **Outcomes (design 3.2).** `message` returns `{ outcome, messageId?, reason? }` with one of `delivered`, `held`, `duplicate`,
  `forbidden`, `unreachable` (`BotMessageResult`, with a protocol fixture `bot-messages.v1.json` that the protocol, Relay and
  Controller tests all read). A refusal is an outcome the sender reads, not an error: an unknown or retired bot (one answer for
  both, so the roster cannot be probed) is `unreachable`; the bot itself, and a chain the person stopped, are `forbidden`; a
  repeated `operationId`, or a call that queued nothing new, is `duplicate`; a seat that is not ready is `held`. For a task's Team
  the outcome is read from what the call queued for the receiving seat, so every route (report, question, progress, input) answers
  the same way. Malformed calls and the 300-character bound stay errors, since the bot can shorten and retry.
- **Replies from final text (design 3.3).** The Host watches each bot's stream (`watchChainTurns`): the last run of its assistant
  text in a turn is the final text, and the cause of the turn names the one message that started it (`TurnCause` framed `answers`)
  when that input is exactly one message from another bot that is not a reply (standing instructions beside it do not count; two
  messages, a person steering the turn, a timer or a reply make the turn answer none). When such a turn ends the Host sends
  `bot_reply` with the text, never a tool call; the Relay sends it to the message's sender as a reply (`reply to m…`, so it earns no
  reply), cut at 300 characters with a pointer to `read_bot`, and sends nothing when the turn already answered its sender: every
  `bot_message` of that turn carries the same cause, and a message to the sender (or with `reply_to`) marks the inbox entry
  `answered`. Chosen over having the Controller track tool calls by name, which depends on how each provider names tools. Standing
  bots only: a temporary bot ends its turns with its report (`done`, `failed`), and its missed report already has a reminder.
  `read_bot` now reads any standing bot of the account, not only one's staff, so the pointer works for the bot that asked; design
  8's `peers` are not built, and the audit and the account's single owner stand in for them.
- **The person's words to a bot with a bot chief (design 3.5).** When the person types into a standing bot's session the Host sends
  `bot_told` from its record of the input; the Relay queues `[The person wrote to <name>] <first 300 characters>` (one line) in the
  chief's inbox, once per message, and the chief's input is framed, so it is never taken for the person's words. The frame is
  written by the Relay from the record like every other frame (design 12 says Controller; every frame as built, the standing
  instructions and timers included, is written by the Relay), and the client folds it to one line. A bot whose chief is the person
  queues nothing. A temporary bot's chief already hears the person through `tell_task`.
- **Attachments (design 3.4, 5.3).** A `message` may carry up to 3 files of at most 8 MiB, named by path (absolute, or relative to
  the bot's working directory). The Controller uploads each with `attachment_begin`, `attachment_chunk` (32 KiB, in order) and
  `attachment_finish` Host calls; the Relay checks size and sha256 against the declaration and lists the files after the
  sender's 300 characters (`id · name · type · bytes · sha256`), so the bound stays on the sender's own words. The receiver calls
  `download_attachment`, which reads the chunks, checks size and sha256 and saves the file under the temporary directory
  (`agent-remote-attachments/<id>/<name>`, owner-only, kept a day), and returns its path; nothing applies it. Storage is a
  key-value port (`AttachmentStorage`): memory, a directory beside the Node Relay's state file, and a SQLite table of the
  Durable Object on Cloudflare; the store keeps unfinished uploads an hour, files a day, at most 512 files and 128 MiB per account.
  No negotiation flag and no resumable upload: the Controller and Relay are updated together, and a failed upload starts again. The
  old Team resource machinery was far larger (scopes, grants, pins, a negotiated uplink capability); a file's id is the capability
  here, and only a message tells a bot an id.
- **Base instructions v4** say: a reply from final text, shared repository first and a bundle only without one (the receiver
  fetches it into a branch it reads), a received file is never applied on its own, and what `[The person wrote to …]` means.
- **Tests.** Relay unit tests on the broker (outcomes, replies, told, attachments), the file store with a fake clock, a Cloudflare
  storage test, Controller tests with the real broker and team runtime (replies through a watched session, told, upload and
  download with a tampered chunk), a real-transport test (`bot-attachments.transport.test.ts`: the Controller's uplink client over
  a loopback WebSocket to the Relay's host broker), and three E15 flows (a reply from final text with the person's words to the
  bot, and an attachment downloaded).


- [x] No mode (design 2.1): remove the coordinator/plain switch, `mode`, and `coordinatorProvider`; every bot whose provider takes
  tools gets the `agent_remote` namespace (design 5.1) and standing instructions at its next attachment; others are answers only.
- [x] `create_bot`, `retire_bot`, `list_bots`, `read_bot`, `stop_bot`, `update_mission` (design 2, 5.1); creation outcome framed to
  the chief and the first turn returned as the report-in (2.2); span of 12 (2.5); lifetime and retirement (2.4).
- [x] `message` (design 3): `status` for progress, done, failed and needs input; delivery at idle in one order, combined into one
  input; replies from final text (3.3); 300-character bound (3.4); outcomes; `[The person wrote to …]` to chiefs (3.5).
- [x] Tasks become temporary bots: `create_task`, `report_task`, `ask_owner`, `message_task`, `task_status` and the task Team kind
  are replaced by `create_bot` and `message`; existing tasks are listed as retired temporary bots.
- [x] Attachments, git bundles included (3.4, 5.3).
- [x] Gate: the person describes a team to one bot; it creates two bots with missions; each reports in; the chief gives one work
  by message and changes how the other works by message (recorded in its own mission); a Copilot bot answers a question; the
  person sees all of it in Chats and can change any bot. The e2e flows of design 11, written here, pass.
  Status (2026-11-24): live in the scenarios with Claude Code and Codex, a Copilot bot answering a chief included; E15 passes.

## Step 3: rooms, work items and timers

- [x] Rooms as message targets with a Relay timer closing them on time (design 4, closes O71).
- [x] Work items for standing bots (design 6.1): `update_work`, `complete_work`, read with `list_bots` and in the bot's details.
- Dropped (owner, 2026-11-24): TPM was removed rather than folded, so work items get no todo or confirmation from it; a goal
  tool or another tool may track work later.
- [x] Fallback timers pushed back by every message (design 6.2): `set_timer`, and the default timer of open work.
- [x] The companions' heartbeat removed, with TPM (step 7d).
- [ ] Gate: a bot keeping a work item asks a working bot and the reply updates the item the person sees; a confirmation waits for
  Agree; a quiet interval wakes the bot once and a message pushes it back; a room of two bots and the person reaches a result.
  Status (2026-11-24): work items, timers and rooms verified in Relay unit tests and the scenarios; the confirmation is dropped
  with TPM.

Built (2026-11-23, `feat/bots-3-rooms-work`): rooms are message targets (`message` to a room, `pass`, `status done` for its
result) and move on time on the Relay's scheduler. A standing bot keeps up to 20 work items and 8 timers on its inbox; a temporary
bot's work is its brief and it reports with `message`. Open work keeps a timer named `work`: five minutes, thirty while all of it
waits. A due timer queues `[Timer "<name>" · due]` with the open work, unless something is already on its way to the bot; every
message queued for the bot pushes its timers back. The page folds a due timer into one line and shows the work items in the bot's
details. Verified by Relay unit tests on a fake scheduler (`bot-work.test.ts`, `rooms.test.ts`); the gate's live checks with real
models run with step 5's scenarios.

## Step 4: the audit

- [x] The audit view (design 7): chains live, stop a chain or one bot's part of it, pause, retire; thresholds that notify.
  Plan and what was built: [step 4](2026-11-23-bots-4-audit-plan.md).
- [x] The earlier refusals are removed: the reply hop limit is gone and depth is recorded. The running-task limit is the span of
  a chief (12), which stays; there was no creation limit beyond it.

## Step 5: behaviour scenarios

- [x] `pnpm test:bots` with the release walkthrough (design 11). The base instructions are tuned here until it passes with Claude
  Code and Codex; every later change to them reruns it.

First rounds (2026-11-23, `scripts/bots-scenarios.mjs`, on this checkout's local instance): scenarios `temporary` (a chief
splits a request between two temporary bots, which write files and report; it sums up), `standing` (it creates a standing
reviewer that answers by message; the person's lasting change goes into the reviewer's mission; a work item runs to its end) and
`shared` (a second chief asks the same reviewer). Found and fixed:

- An chief asked for bots used Claude Code's own subagents: bots without a mission never got the base instructions, and
  nothing said bots are not subagents. Base instructions v2 say so, as does `create_bot`; the scenarios give chiefs a mission.
- `update_work`, `complete_work` and `set_timer` cloned an immer draft and failed in the Relay; the unit tests now use drafts.
- A settled message of a chain failed validation as a receipt and held its inbox; fixed, with a test that settles.
- A reviewer kept a lasting change in Claude Code's memory files; the base instructions now name `update_mission`.

Final run (2026-11-24, `d1854103`, fresh local instance): 10 of 10 checks with Claude Code and 10 of 10 with Codex.

Added 2026-11-24: `bundle` (a git bundle attached between bots) and `copilot` (a Copilot bot asked by a chief), 6 of 6 with
Claude Code and Codex. Not yet in the scenarios: the shared-repository loop between two machines, the person speaking to a
temporary bot, and counting tool calls per chief turn.

## Step 6: the Workbench

- [x] Design 10: Chats grouped by chief with status and work item lines; folded lines between bots; details with bots, work
  items and the mission; rooms in Bot mode; Keep.
- [ ] Grouped reminders by chief: reminders stay per bot; a bot's row names its chief.

Built (d6ff44e4): a standing bot another bot created joins its chief's group, so Chats groups bots by chief already; its
row says "by Chief", and a quiet bot shows its latest open work item and phase instead of its sentence. Rooms are listed above the
bots from the Teams the page keeps and open as a group chat in a sheet. The details list the standing bots a bot is chief of beside
its temporary bots, work items and mission. A temporary bot's progress folds to one line per bot; results and questions stay cards.
A temporary bot opens beside its chief as any session does (Send, Interrupt and Queue are its conversation's own); its row
offers Stop, Mark done and Keep, which makes it a standing bot of its chief's group with its brief as its mission.

## Step 7: fold the older features

Each fold migrates its records, rewrites the feature's e2e cases on bots, and deletes the old path in the same branch (design 9).

- [x] Side: `/side` creates a temporary bot; existing Side views stay as ordinary bots of their group (7a).
- [x] Call For Support (7b): profiles are not migrated; the support settings say so once, then go, with groups, calls, rosters, ledgers,
  report framing, the four tools, `callForSupport`, `readOnlyProvider` and `support_enablement`. Gate: a bot asks the bot whose
  mission is reviewing to review an uncommitted change, which it sees through a shared repository or a bundle.
- [x] Team (7c): ordinary Teams are dropped when state loads (owner, 2026-11-24: no conversion; the sessions stay); the Team
  queue, inbox tools, `team_message`, file transfers, panel and launcher go; E7's Team case is rewritten on a temporary bot.
- [x] TPM (7d): removed (owner, 2026-11-24: history only, then dropped); a TPM's session stays a plain session; `tpm_intent`,
  its delivery, workspace, launcher, the session todo, heartbeat and background reviews go.

## Later

The P2 operation queue (IM session service) carries messages without changing the tools.
