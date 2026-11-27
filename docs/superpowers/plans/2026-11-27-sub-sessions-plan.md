# Sub-sessions: temporary bots become sessions of a bot, in Grok Bot's shape

Plan for the owner decision of 2026-11-27. It changes [bots design](../specs/2026-11-23-bots-design.md) 2.1, 2.2, 2.4, 2.5, 5.1, 6.1, 9, 10 and 12, and
[bots plans](2026-11-24-bots-8-mentions-plan.md) 8a, [9](2026-11-25-bots-9-review-plan.md) 9a and 9d and [10](2026-11-25-bots-10-hosts-plan.md).
Revised the same day twice: for the owner's direction to organise like Grok Bot (1a), then for the owner's answers (1b: a main bot above project bots, one shared board per project; decisions in section 15, open gaps in section 14). No product code is written here. Old data is dropped, there is no transition layer, and the owner updates every Controller
(memory: fold-data-loss-ok, controller-upgrade-compatibility).

## 1. The owner's decisions (binding)

1. A bot has one **main session** for communication. Long or context-heavy work goes to its **sub-sessions**: independent agent-loop
   sessions, like the bot's own subagents but visible. A sub-session is **not a bot**: no Chats entry, no mission, board, memory or
   picture, and it never becomes a standing bot. Keep (turn into standing) is removed.
2. Its main bot and the person direct it. The person opens it (beside the main bot's conversation, full screen on a phone), talks to
   it, approves, interrupts, stops. Other bots cannot see or reach it (not in `list_bots`, not addressable by `message`).
3. The main bot decides its lifetime: more related work goes to the **same** sub-session (context reused), or the main bot ends it.
   No time-based release. The main bot reviews periodically (section 6). When the main bot retires, its sub-sessions end.
4. `/side` is a sub-session the person starts from a conversation; its result still shows as a card beside that conversation, and
   Bring back stays.
5. Delegation to another bot is `message` plus board items (the original decision). *Superseded by 1b:* standing bots created by bots are now
   project bots created only by the main bot (`create_project`).

Held fixed: one approval per chain and folder (sub-sessions are in their bot's chain); messages never reassign items; owner sessions default to YOLO; prefer removing concepts over adding guards.


## 1a. Direction of 2026-11-27: organise like Grok Bot

New owner direction: learn Grok Bot's pattern and imitate it. This revision mirrors it everywhere the earlier decisions allow, and
section 15 lists every place where it does not, for the owner to decide.

### Evidence and its limits

Read from `/Applications/Grok Bot.app/Contents/Resources/app.asar` (1.2.3) as untrusted data: regular expressions over the bytes
(`python3 -I`), the generated message schemas (`static $(){return["<Name>|<field> <type>…"]`) and the `…_tool_call` enum. Nothing was run.
What the bundle gives: argument and result **shapes** of 74 tool calls. What it does **not** give: tool descriptions and prompts
(server side), the values of string fields (`delivery`, `lifecycle`, `mode`, status `category`), and which role may call which tool (the
tool enum is shared by every agent). Where this plan needs one of those, it chooses and says "ours".

Grok's organisation, from the schemas:

- A **main bot** talks to the user (`send_to_user`, `communicate_update { current_step, final_summary }`; `SendToAgentRecipient.Kind` is
  `MAIN_BOT` or `PROJECT_SESSION`).
- A **project** is itself a long-running agent: `create_project` takes the same arguments as `create_agent` and returns an `agent_id`;
  it has a **plan document** (`read_project` returns `plan`; `update_project` takes `string_replacements [{ old_string, new_string }]`
  and a `summary`) and **periodic wake-ups** (`start_project_updates` / `stop_project_updates` take an `agent_id`; the result is
  `{ agent_id, until_ms, was_on, message }`). `ProjectDetails` holds a subagent store directory and a **side chat**
  (`SideChatInfo { parent_bc_id, seed_turn_count, subagent_type }`: a child chat seeded with some turns of its parent).
- A **worker** is an agent: `create_agent { prompt, name?, model?, base_branch?, machine_type?, worker_id?, pool?, labels, environment…,
  repo_url?, tracked_task_keys[], fork_from?, fork_turns? }` returns `{ agent_id, message }`; `send_to_agent { agent_id, message,
  delivery, title, model?, tracked_task_keys[] }` returns `{ worker_bc_id, delivered_as, message, recipient }`; `get_agent_status
  { agent_ids[] }` returns workers `{ bc_id, name, lifecycle, turn_in_flight, last_terminal_turn_status, pr_url,
  last_activity_at_ms }`; `read_agent_transcript { agent_id, mode, max_turns }` returns `{ transcript, truncated }`; `stop_agent
  { agent_id }`. The in-loop `task` tool is the CLI-style subagent (`description, prompt, subagent_type, model?, resume?, agent_id?`);
  the flag `grok_bot_task_subagent_roster` lists workers as a roster.
- **Tracked tasks** are the board: `list/create/update/delete_tracked_tasks`, `update_tracked_task_statuses`, `update_tracked_task_tags`.
  `TrackedTaskView { key, title, status_id, status_label, owner, owner_session_id, parent_key, links[], tags[], internal_notes,
  updated_at_ms, version }`; a link is `agent_id | pr { url, opened_by_agent_id, counts_for_completion } | document { path, label } |
  url { url, label }`. A list returns `{ tasks, statuses { id, label, category, task_count, description }, members { name, session_id,
  is_you }, tags { id, label, color, task_count }, older_closed_count, truncated, matching_count, next_cursor }` and filters by
  `keys`, `status_categories`, `owner`, `linked_agent_id`. An update names `version`, can move (`position`), add and remove links, and
  returns `{ updated, conflicts [{ key, field, current_value, changed_by, changed_at_ms, current_version }] }`. Statuses are custom
  records with a category.
- **Goals:** `create_goal { objective }`, `update_goal { status ACTIVE | PAUSED | COMPLETE | CLEARED }`.

### Mapping

| Grok Bot | Ours | Note |
|---|---|---|
| Main bot (user-facing) | **Main bot** (总机器人), one per account, the person's home | Decided in 1b; section 5.0 |
| Project (long-running agent with plan, tasks, members) | **Project bot** (项目机器人) with its main conversation, shared board and plan | `create_project` replaces `create_bot` |
| Worker (`create_agent` family) | **Sub-session** | Tools renamed `*_sub_session`, shapes mirrored (section 4) |
| `task` subagent with `resume` | The CLI's own subagents; a sub-session is the same idea made visible and reusable | No typed subagents (`DEEP_SEARCH`, `FIX_LINTS`, `SPEC`) |
| Tracked tasks + statuses + tags + members | **Board** of a bot (`board`, `update_board`) | Fields and result shapes mirrored (section 4.3) |
| Project plan document | The board's **plan**, edited by string replacements with a summary | Larger, 4000 characters |
| `start_project_updates` (periodic wake-ups until `until_ms`) | The main bot sets an "updates" **timer with an end** on a project bot; `set_timer` gains `until_minutes` | Section 6 |
| Side chat (seeded child chat) | **`/side`**: a sub-session started by the person, optionally seeded from the conversation | See 7 |
| `fork_from` + `fork_turns` | `create_sub_session` with `fork_from`/`fork_turns`, using the fork the page already has (`/fork`) | Provider capability |
| `communicate_update` | The sub-session's one reporting tool (section 4.2) | Final text is the fallback |
| `stop_agent` | `stop_sub_session` = end | Decision 3 |
| `send_to_user`, goals | Not adopted | Contradictions 14 and 15 |

### 1b. The owner's answers of 2026-11-27 (second round)

1. **Hierarchy: follow Grok.** A user-facing **main bot** (zh 总机器人) sits above **project bots** (zh 项目机器人, Grok's project agents), which
   run **sub-sessions**. The person talks mainly to the main bot, which creates and directs project bots.
2. **Board: follow Grok.** One shared board per team: the project bot, its members and its sub-sessions all write it, versioned with
   conflicts. This replaces "a bot writes only its own board" and "a staff bot never writes its chief's board".
3. **Periodic review:** an optional timer the bot turns on, with an end; its wake-up frame carries the sub-session roster; without it,
   review happens in ordinary turns.
4. **Fork:** supported for sub-sessions, `fork_turns` required, behind the provider's fork capability; `/side` may carry the conversation's context.
5. The other rows of section 15 and the open questions: my recommendations are taken (custom status categories with Agree person-only,
   `*_sub_session` names, no separate goal concept, `/side` belongs to the person and the main bot does not see it, sub-sessions message
   no one, 8 live per bot, a person's direct turn in a sub-session is its own chain).

Sections 4.0, 4.3, 5.0, 6, 8, 9, 10 and 11 carry the consequences; section 15 records each answer; section 14 lists what is still open.
Where Grok's evidence is only shapes, the plan says "ours".

## 2. What the code does today (the survey this plan starts from)

A temporary bot is a **Team with `task`** (`packages/agent-remote-protocol/src/task.ts`, `TeamTask`): members `[worker leader, owner
requester]`, a state machine `working | needs_input | done | failed | cancelled`, and a bot id derived from the Team id
(`temporaryBotId`, `agent-relay-core/src/chain-scope.ts`). It is made bot-shaped in many places:

| Where | What it does for a temporary bot |
|---|---|
| `agent-relay-core/src/tasks.ts` (`TaskGroups`) | create, report once (`report_task`), `ask_owner`, `message_task`, `cancel_task`, `mark_task_done`, `tell_task`, reminder and `no_report` waits (`turnEnded`), `brief_unknown`, `side` (nothing reaches the owner) |
| `agent-relay-core/src/bot-calls.ts` | `temporary()` as a `Bot`, `caller()` recognises a worker, `named()`/`byKey()`/`list()`/`readSession()` list and address it, `create()` temporary branch, `keep()`, `manageStaff()` (`stop_bot`, `retire_bot`), `sideFinal()`, `send()` routes bot to chief and chief to bot, `span()` counts it toward the 12 |
| `agent-relay-core/src/teams.ts` | `keep_task`, `cancel_task`, `mark_task_done` actions; `startBot` (`/side`); `chainView` names/kinds; `botSession`; `project` writes `task.botId` |
| `agent-relay-core/src/chain-scope.ts`, `audit.ts` | chains count a task as a created bot and as a bot reached; `stopInTeams` cancels a task running in a chain; `retire_bot` ends one |
| `agent-relay-core/src/bot-board.ts` | a temporary bot writes the status, links and result of the item it was created for (`own`); a report from it moves the item |
| `agent-relay-core/src/coordination-retention.ts` | finished tasks kept, 200 per account |
| `agent-remote-protocol` (`bots.ts`, `team.ts`, `task.ts`) | `BotRecord.lifetime`, `BotListing.kind: 'temporary'`, `create_bot.lifetime`, task host calls, `side_final`, `TeamCreate.bot`, `BoardItem.assignee` = `self | BotId`, `ChainView.kinds` |
| `agent-controller/src/team.ts`, `task-roles.ts`, `bot-tools.ts` | worker seat with the full bot tool namespace plus `agent_remote_task` (`read_source_session`); worker held while the task runs; `observeWorkerInput` tells the owner what the person wrote; `forgetFinishedTasks`; a worktree worker's patch appended to its report; `side_final` sent from a side's ended turn |
| Page | `TasksList.tsx` (Mark done, Stop, Keep as a bot), `TaskInputItem.tsx` task cards, `SideCards.tsx`, `task-directory.ts`, `useForks.ts` (`/side`), `BotRoster.tsx` (approval dot), `BotAudit.tsx` (Retire for a temporary bot) |
| Tests | `tasks.test.ts`, `bot-calls.test.ts`, `bot-board.test.ts`, `chains.test.ts`, `task-worker.test.ts`, `task-roles.test.ts`, `bot-tools.test.ts`, `task.test.ts`, `team.test.ts`, fixtures `bot-messages.v1.json`, component spec `temporary-bots.spec.ts`, E15 flow 1, `scripts/bots-scenarios.mjs` scenarios `temporary` and `board` |

Findings that shape the design:

- The design text says a finished temporary bot "stays 24 hours so its chief can send it more work". **The code does not do this**:
  a finished task is not `running`, so `named()` no longer finds it and `message` answers `unreachable`. The 24 h retention exists only
  in the text of 2.4. Nothing has to be removed for it; the design text is corrected.
- A worker today has the full bot tool namespace (it can message bots, create bots, write a board item, ask `ask_owner`). That makes
  it a bot and is why it needs bot-shaped bookkeeping. The new sub-session gets almost no tools (section 4), which removes most of
  that bookkeeping instead of renaming it.
- The worker's lifecycle ends at its report; its Controller seat is forgotten once the task is finished. Reuse needs the seat to
  survive the end of a turn.
- Results already travel two ways: an explicit `message ... status done` (worker) and the **final text** of a turn (`side_final`).
  A turn's result (the `final_summary` of `communicate_update`, else the final text) becomes the only way for a sub-session; this deletes `report_task`, `ask_owner`, the reminder/`no_report` machinery and
  "the worker stopped without reporting".

## 3. Concepts and names

| Term | Meaning |
|---|---|
| **Sub-session** (zh **子会话**) | A native agent-loop session of a bot, directed by its main bot and the person. Not a bot. |
| **Main bot** (总机器人) | The account's one user-facing bot: creates and directs project bots, reads every board. |
| **Project bot** (项目机器人) | A bot for one lasting body of work, created by the main bot; owns a shared board and a plan, runs sub-sessions. |
| **Team** | A bot and its live sub-sessions: the writers of one board. |
| **Owning bot** | The main bot or project bot that started a sub-session (a plain conversation for `/side` from a session that is no bot). |
| **Work** | One dispatch to a sub-session: its first prompt, or later input from the main bot, with a one-line `title`. A sub-session works through one piece at a time, in order. |
| **Result** | The `final_summary` the sub-session reported, or the final text of its ended turn. |
| **Idle** | The sub-session's turn has ended and nothing is on its way to it. It keeps its context. |
| **End** | Release: its runtime is let go, its conversation stays readable as an ordinary session. Ended is final. |

"Temporary bot", "task", `lifetime`, "worker" and "Keep" disappear from product text, protocol and code. "Side" remains the name of the
person's command and of its card (zh 旁路, unchanged).

Ids: `s_` plus 32 hex (`SubSessionId`), derived from the Team id like `temporaryBotId` was, but a different pattern so a sub-session id
can never be taken for a `BotId`. This is how decision 2 holds by construction: nothing that resolves a bot (`named`, `byKey`,
`list`, `read_bot` of other bots' sessions, `message`) ever sees an `s_` id.

## 4. The tool surface

Shapes mirror Grok Bot's; names say "sub-session" and "project" because "agent" already means the CLI in this product. Grok's fields that
are not mirrored are listed in section 15.

### 4.0 Roles and who has which tool

There are three kinds of session that call tools, and exactly one **main bot** per account (section 5.0).

| Tool | Main bot | Project bot | Sub-session |
|---|---|---|---|
| `create_project` (Grok `create_project`) | yes | no | no |
| `message` (recipient `main` or a project bot; Grok `send_to_agent` with `MAIN_BOT`/`PROJECT_SESSION`) | yes | yes | no |
| `list_bots` (projects with mission and status; a project bot also sees the main bot and its peers) | yes | yes | no |
| `read_bot` (a bot's conversation; a bot's own sub-sessions) | yes (any project) | yes (any bot, as today) | no |
| `board`, `update_board` (items, statuses, tags, links) | any project's board, and its own | its project's board | its project's board |
| `read_project`, `update_project` (the plan) | any project, and its own | its own | read only |
| `start_project_updates`, `stop_project_updates` | yes | no | no |
| `create_sub_session`, `send_to_sub_session`, `stop_sub_session` | yes (its own) | yes (its own) | no |
| `get_sub_session_status` | yes (its own, and read only across projects) | yes (its own) | no |
| `set_timer`, `clear_timer`, `remember`, `forget`, `update_mission`, `list_hosts`, `download_attachment`, `open_room` | yes | yes | no |
| `communicate_update`, `read_main_session` | no | no | yes |

Removed: `create_bot` (a project bot is created by `create_project`; no bot below the main bot creates bots), `set_chief` (every project bot
hangs under the main bot), `stop_bot`, `retire_bot`.

### 4.1 Sub-session tools (main bot and project bots)

| Tool | Arguments | Result |
|---|---|---|
| `create_sub_session` | `prompt` (the first work, standing alone, up to 8000), `name?`, `model?`, `provider?`, `tracked_task_keys[]` (board items it takes up), `fork_from?` (`"main"` = this bot's main conversation, or the id of one of its own sub-sessions) with `fork_turns` (**required** with `fork_from`), `workspace` (`same`, `read_only`, `worktree`), `host`, `cwd`, `new_folder` (plan 10), `operationId` | `{ sub_session_id, message }` |
| `send_to_sub_session` | `sub_session_id` (id or name), `message` (the next work, up to 8000), `delivery` (`queue`, the default: between turns; or `interrupt`: stop the running turn first), `title` (one line naming this piece of work; shown as last work), `tracked_task_keys[]`, `operationId` | `{ sub_session_id, delivered_as: delivered | held | duplicate, message }`; `unreachable` when it has ended |
| `get_sub_session_status` | `sub_session_ids[]` (none = all its own) | `{ sub_sessions: [{ id, name, lifecycle, turn_in_flight, last_terminal_turn_status, last_work_title, current_step?, tracked_task_keys[], pr_url?, last_activity_at_ms }], message }` |
| `stop_sub_session` | `sub_session_id` | `{ sub_session_id, message }`; ends it, idempotent |

`lifecycle` is `starting | live | needs_you | ended` (ours; Grok's values are not in the bundle); `last_terminal_turn_status` is `finished |
failed | interrupted`; idle is `live` with `turn_in_flight` false, its length `now - last_activity_at_ms`. `pr_url` is the `pr` link of the
items it works on. There is no `steer` delivery: design 3.2 stands. `read_bot` takes Grok's `mode` (`last_turn` | `recent`) and `max_turns`
and also reads a bot's own sub-sessions; the result carries `truncated`.

### 4.2 What a sub-session has

It is not a bot: no `message`, memory, timers or sub-sessions of its own. It has its native tools and:

- `communicate_update { current_step?, final_summary? }` (Grok's shape). `current_step` is one line, shown in the status and on the page,
  and never wakes its bot. `final_summary` is the result of the piece of work; a turn that ends without one uses its final text.
- `read_main_session`: the conversation it was started from.
- `board` and `update_board` on **its project's shared board** (4.3), items and links only.

### 4.3 The shared board (Grok's tracked tasks)

**Team boundary.** A **team** is a bot and everything running under it: the project bot, its live sub-sessions, and nothing else (staff bots
do not remain). Each project bot has exactly one board, shared by the whole team. The main bot has a board of its own for what the person
asks of it, and its team is itself and its sub-sessions. The **main bot reads and writes every board** (Grok's main bot with its
all-projects tasks panel, flag `main_bot_rhs_tasks`); the person edits any item. A project bot sees only its own board and, for an item
another bot handed it, that one item. This replaces design 6.1's "a bot writes only its own board" and plan 8a's "a standing staff bot writes
only its own board".

**Who writes what.** Items, links, tags and notes: the project bot, its sub-sessions and the main bot, all through the same call. Board
structure (the statuses, the plan): the project bot, the main bot and the person; a sub-session reads them. Messages never reassign items
(held rule): ownership changes only by a board write.

**Versioning.** Every write names the `version` it read (a new item names none). A stale write still applies field by field and the result
lists `conflicts [{ key, field, current_value, changed_by, changed_at_ms, current_version }]`: what it overwrote and who wrote it (design 6.1
stays; Grok's result is ambiguous about applying). A change to an item an owner holds (retitled, reassigned, cancelled, brief changed)
queues `[Item "…" changed · …]` to that owner, whether a bot or a sub-session, written by the Relay from the record; the writer is never told
to wait.

Item (`BoardItem`):

| Field | Source | Note |
|---|---|---|
| `key`, `title`, `parent_key`, `version`, `updated_at_ms` | Grok | `parent` renamed |
| `status_id`, `status_label` | Grok | Per-board statuses `{ id, label, category, description? }`; categories `open | active | closed` (ours); seeded open, working, waiting, done, cancelled. A status that needs the person's Agree stays a person-only transition whatever its category |
| `owner`, `owner_session_id` | Grok, replaces `assignee` | `self` (the board's bot), a live sub-session, or on the main bot's board a project bot; `members` names them |
| `links[]` | Grok | `agent_id` (a sub-session id or a project bot id), `pr`, `document`, `url`; ours keep `commit`, `branch`, `file`, `attachment`, `host`, `folder` |
| `tags[]`, `internal_notes` | Grok | Notes are visible to the person |
| `brief`, `report`, `result`, per-field `changedAt`, `updatedBy`, `closedAt` | Ours | Reports from sub-sessions and project bots; stale-write notices; the confirmation rule |

Read (`board`, with optional `project`): `{ tasks, statuses, members { name, session_id, is_you }, tags, older_closed_count, truncated,
matching_count, next_cursor }`, filtered by `keys`, `status_categories`, `owner`, `linked_agent_id`; plus the roster of live sub-sessions.
The main bot's read without a project returns the open items of every project board grouped by project. Write (`update_board`, with optional
`project`): items with `version`, `position`, `add_links`/`remove_links`, `statuses`, `tags`; result `{ updated, created [{ client_ref, key,
version }], conflicts }`. `delete` is not adopted: cancel and a week of retention stay.

**The plan** is a document of the project, not a board field: `read_project { project? }` returns it; `update_project { project?,
string_replacements [{ old_string, new_string }], summary, version }` edits it (each `old_string` must match exactly once; up to 4000
characters; the last 20 summaries are kept). The project bot edits its own; the main bot any.

Dispatching with `tracked_task_keys` records the sub-session as `owner` of those items, adds an `agent_id` link and records the dispatch
`title`. A project bot's work arrives from the main bot as items written on its board (owner `self`) plus a `message` naming them.

### 4.4 The main bot's project tools

| Tool | Arguments | Result |
|---|---|---|
| `create_project` | `prompt` (the mission: what the project is for), `name`, `model?`, `provider?`, `host`, `cwd`, `new_folder` (plan 10), optional first items (`tracked_task_keys` of its own board), `operationId` | `{ project_id (a BotId), message }`; the project bot reads its mission and reports in, as a created standing bot does today |
| `message` | `to`: `main` (from a project bot) or a project bot name/id; `text` (300), `status`, `reply_to`, `item`/`tracked_task_keys`, attachments, `operationId` | `{ outcome, messageId?, recipient { kind: main_bot | project_session, id, display_name }, reason? }` |
| `start_project_updates` | `project`, `until_minutes` (required) | `{ project, until_ms, was_on, message }`: sets a named timer ("updates") on that project bot, ending at `until_ms` |
| `stop_project_updates` | `project` | `{ project, was_on, message }` |
| `read_project`, `update_project` | 4.3 | |

`message` keeps its name and its 300-character bound (design 3.4); Grok's `send_to_agent` is the same call for a worker, and its
recipient kinds `MAIN_BOT` and `PROJECT_SESSION` are the `main` and project recipients above (the `to: "chief"` of today). Long work reaches a
project as board items, not as message text.

### 4.5 Limits

At most **8 live** sub-sessions per bot that started them (`SUB_SESSION_LIVE_LIMIT`, replacing `TASK_RUNNING_LIMIT = 12`; they no longer count
toward the span). The ninth is refused with the roster and "stop one or send it the work". Person-started sides are not counted. At most 12
live project bots under the main bot (`BOT_SPAN_LIMIT`, unchanged, now the main bot's only span; revisit with use). Board: 50 open items per
board as today. `ACCOUNT_TEAM_LIMIT` still bounds the account; ended sub-sessions are pruned by count (200), never by age.

## 5. Relay state and Controller

### 5.0 Bots: one main bot, project bots

`BotRecord` gains `kind: 'main' | 'project'` and loses `lifetime` and `chief`. This reverses design 2.1's "a bot has no mode and no kind" for
this one distinction; everything else about a bot (a mission, a main session, status, memory, picture, board, timers, inbox) is the same
record and the same code. Where the page and the tools used to ask "who is its chief", the answer is now by kind:

- **One main bot per account**, enforced by the Relay (a second `kind: 'main'` is refused). Recommendation taken from the coordinator's
  question: exactly one, because the person's home and the all-projects view need one answer, and a second would be a project bot.
- Every other bot is a **project bot**; its chief is the main bot by definition, not by a stored field (`chief` is removed, and with it
  `set_chief`, `personSetChief`, the chief-changed frame, sub-chiefs and chains of chiefs). A project bot with no main bot yet (before
  setup) simply has none to message; `to: "main"` answers `unreachable` with the reason "no main bot is set up".
- **Setting up the main bot**: the page offers "Set up your main bot" (Host, provider, folder) which creates a session with the main bot's
  standing instructions, or the person turns an existing session into it (the "session becomes bot" path of E15d). Until it exists, Chats
  shows only that offer above the project bots.
- **What a main bot is**: not a worker. Its instructions (section 8) say it keeps the whole picture, creates and directs projects, reads
  boards, and answers the person; it may still use its own sub-sessions for one-off long jobs and its own small things.
- **Direct talk to a project bot is kept** (ours: Grok's schemas show projects as conversations with their own side chat and plan but say
  nothing about who may open one). The person opens any project bot from Chats and talks to it as today; the main bot then hears
  `[The person wrote to <project>]` (first 300 characters, the existing frame, now always to the main bot) and does not answer it.
- Rooms, answer sessions (`@Project text`), timers, memory, attachments and the audit are unchanged and apply to both kinds.

### 5.1 The record

`Team.task` is replaced by `Team.sub` (a `SubSession`), on the same Team container so claims, durable receipts, settlement,
at-most-once and chain stamping are reused unchanged. Members stay `[worker leader, main requester]`. Fields follow the status shape of 4.1.

```text
SubSession {
  title                    // name, at most 120
  prompt                   // the first work, kept as given
  startedBy                // 'bot' | 'person'  ('person' = /side)
  lifecycle                // 'starting' | 'live' | 'needs_you' | 'ended'
  turnInFlight             // a turn is running or work is on its way to it
  lastTerminalTurnStatus?  // 'finished' | 'failed' | 'interrupted'
  lastWorkTitle?           // the `title` of the last dispatch (<= 120)
  currentStep?             // from communicate_update, one line
  lastResult?              // { text (<= 4000), at }: final_summary, or the turn's final text
  lastActivityAt           // idle length = now - lastActivityAt while !turnInFlight
  waiting?                 // needs_you only: 'interaction' (a native approval only the person answers) | 'input_unknown' (a delivery settled unknown; never sent again)
  forkedFrom?              // { turns }: seeded from the main conversation
  workspace?               // same | read_only | worktree
  endedAt?, endedBy?       // 'main' | 'person' | 'main_retired'
  subSessionId?            // written by the Relay when it lists the Team, so the page names an item's owner
  createdAt, updatedAt
}
```

The items it owns are not stored on it: they are the board items whose `owner_session_id` is its worker session (`tracked_task_keys` in
the status is a read of the board). It holds no `mission`, `memory`, `picture`, `chief`, `peers`, `lifetime`, `doneWhen`, `reminded`,
single-shot `result` or `side`; there is no `done`, `failed` or `cancelled` state.

Removed from `bots.ts`/`team.ts`/`task.ts`: `BotRecord.lifetime` (all bots are standing), `BotListing.kind`, `create_bot.lifetime`,
`create_task`, `task_status`, `message_task`, `cancel_task`, `mark_task_done`, `tell_task`, `ask_owner`, `report_task`, `side_final`,
`TeamAction` `cancel_task`/`mark_task_done`/`keep_task`, `ChainView.kinds`, `TaskView`, `TASK_*` limits that no longer apply,
`TaskWaiting` reasons `question`/`no_report`/`brief_unknown`. Host calls added (Relay to Controller wire): `create_sub_session`,
`send_to_sub_session`, `get_sub_session_status`, `stop_sub_session`, `sub_update` (from `communicate_update`), `sub_turn_end` (the Host
reports an ended turn), `sub_told` (the person wrote to it); `TeamAction` gains `stop_sub_session` for the person. `TeamCreate.bot`
(`/side`) becomes `TeamCreate.sub`.

### 5.2 Results come from the turn

When the sub-session's turn ends, the Host sends `sub_turn_end { outcome, text? }` (a generalisation of `side_final`) and, if the session
called `communicate_update`, `sub_update { current_step?, final_summary? }` before it. The Relay:

- records `lastTerminalTurnStatus`, `lastResult` (`final_summary` of this turn if given, else the final text; cut to 4000), clears
  `turnInFlight` and `currentStep`, sets `lastActivityAt`; `lifecycle` is `needs_you` if an interaction is pending;
- for a **bot-started** sub-session, queues one input for the main bot: `[Sub-session "QA" · result]` + the first 300 characters,
  ending with `…` and "read it with read_bot" when cut; `failed` and `interrupted` have their own header so the main bot is never left
  waiting. It waits for the main bot's idle and is combined with other waiting inputs by the existing rule (3.2): reports are folded
  newest per sender, so ten sub-sessions finishing wake the main bot once. A `current_step` queues nothing;
- for an owned board item, writes the item's `report` line (300) with the existing `board.report`. The status is not changed by the
  Relay: the owner (main bot, or the sub-session through its limited `update_board`) sets it.

The whole waiting machinery (`question`, reminder, `no_report`, "ask the owner or the person") is deleted. The person writing into the
sub-session directly behaves as the person writing to any bot with a chief (design 3.5): the main bot gets `[The person wrote to
sub-session "QA"]` + 280 characters (`sub_told`), and the turn's result then reaches it as above.

### 5.3 The Controller seat

`agent-controller/src/team.ts`:

- The worker seat is **held while the sub-session is live** (working or idle), not only while a task runs: its ended turns, pending
  interactions and the person's direct input must be seen for results and `sub_told`. It is forgotten when the sub-session is `ended`
  and its deliveries are settled (the existing `forgetFinishedTasks` rule, on `ended` instead of done/failed/cancelled) and when the
  Relay no longer lists it (the existing 10-minute missing rule). A cancelled seat stops its running turn first (existing).
- New work is **input to the idle worker**: `send_to_sub_session` (and `create_sub_session` with its prompt) queues a framed message for the worker seat; the Controller delivers it
  between turns, claimed with a durable receipt, exactly like any seat; the first brief is just the first such input. `delivery: interrupt`
  sets the worker's `interrupt` and the input waits for idle behind it (the Relay already has `member.interrupt` for chain stops).
- Delivery unknown after a restart: state `needs_you`, reason `input_unknown`; the main bot or the person sends the work again
  (`send_to_sub_session` or the composer). This replaces `brief_unknown` and the "tell the person, cancel it" text.
- The instructions (`task-roles.ts` becomes `sub-session-roles.ts`) are the only instructions: **no standing bot instructions** and
  no `[Your standing instructions]` messages (it is not a bot). Text in section 8.
- Tool namespace: only `agent_remote_sub` with `communicate_update`, `read_main_session` and the owned-items `update_board`; the full `agent_remote` namespace is not given to it
  (`bot-tools.ts` `namespace()` is used for bots only), so the Relay's `caller()` no longer has a "worker is a bot" branch and every
  call from a sub-session session is refused as "not a bot".
- `fork_from`/`fork_turns`: the Controller creates the worker session with the fork the page uses for `/fork` (`withForkContext`), copying
  the last `fork_turns` turns of the main conversation; a provider without the capability refuses with that reason and the main bot starts fresh.
- A worktree workspace keeps its patch: the patch path is appended to the result text, as it is appended to a worktree worker's report now.
- Chain approvals (`watchChainTurns`, `CHAIN_APPROVAL_POLICY`) keep working: a dispatched turn's chain is its dispatching message's chain,
  so it is the main bot's chain, and `chain_approval` asks by (chain, kind, folder). The Controller offers the policy on sub-session
  sessions as it offered it on a temporary bot's worker. A turn the person starts by typing into a sub-session opens a chain of its own,
  as every person input does (design 7): their approval choice there applies to that chain.
- The Host keeps the held lease for idle sub-sessions; step 4 measures what an idle held lease costs per CLI. If a CLI holds a
  process per lease, the fallback is to release the runtime at idle and re-acquire on dispatch or open, with the person's direct input
  noticed through the session's own events (the existing `observeWorkerInput`).

### 5.4 Relay classes

`TaskGroups` becomes `SubSessions` (`sub-sessions.ts`): `start`, `send`, `turnEnded`, `told`, `end`, `endAllOf(mainSeat)`, `view`.
`bot-calls.ts` loses the temporary `Bot` (`task` field, `temporary()`, `chiefOf` for tasks, `keep`, `manageStaff`, `sideFinal`, the
`from.task`/`to.task` branches of `send`) and gains the four sub-session tool calls and the roster in `board`. `chain-scope.ts`: remove
`temporaryBotId`; `stampChain` counts a new sub-session in `scope.subSessions` (a new chain counter next to `created`, which stays bots
only) and never adds it to `scope.bots`. `audit.ts`: `stopInTeams` interrupts a sub-session turn that runs in a stopped chain and
withdraws its queued work, and leaves the sub-session idle (the person ends it with Stop); `retire_bot` is removed. `bot-board.ts`:
the `own` writer rule becomes the shared-board rule of 4.3 (project bot, its sub-sessions and the main bot write items; structure by the project
bot, the main bot and the person); the board record moves to the project; `assignee` becomes `owner`/`owner_session_id` (step 3a). A new
`projects.ts` holds `create_project`, the one-main-bot rule and the updates timers (step 3b); `chief`, `set_chief`, `span` of chiefs and the
chief-changed frame are deleted.
`bot-store.ts`: when a standing bot gets `retiredAt`, call `SubSessions.endAllOf` for its session (decision 3 "its bot retires,
its sub-sessions end"; retiring a project bot ends its sub-sessions; the main bot cannot be retired, only replaced by setting up another after removing it; before, retiring did not touch temporary bots because the text and code had diverged).
`coordination-retention.ts`: kind `task` becomes `sub` (ended kept 200; live never pruned).

## 6. Reviewing sub-sessions and projects periodically

Grok's mechanism is `start_project_updates`: periodic wake-ups of a project agent until `until_ms`. The owner's answer: an **optional timer the
bot turns on, with an end**; without it, review happens in ordinary turns. So:

1. **Ordinary turns.** Each sub-session result is a decision point (more related work with `send_to_sub_session`, or `stop_sub_session`); the
   bot reads its board first whenever it starts, resumes or was compacted, and that read, like `get_sub_session_status`, carries the
   roster: "name · live, idle 3 h · last: <last_work_title> · step: <current_step>". The ninth `create_sub_session` is refused with the roster.
   No turn is added.
2. **The optional timer.** `set_timer { name, minutes, until_minutes? }` (a bot, for itself; `until_minutes` is Grok's `until_ms`) and, for a
   project bot, `start_project_updates { project, until_minutes }` from the main bot (the same timer, set from above). A due timer is a
   message (design 6.2: quiet-based, waits for idle, missed ticks coalesce) and its frame carries the open items **and the sub-session roster**.
   The project bot's instruction for an "updates" timer: review items and sub-sessions, stop or reuse them, and send the main bot one line if
   something changed. The timer ends at its `until`; `stop_project_updates` and `clear_timer` end it early.
3. **The default timer** (every five minutes while a bot has open items, design 6.2) is unchanged and now also lists the roster, so a bot
   that works with sub-sessions is reminded of idle ones at the moments it already wakes.

No automatic release (decision 3) and no line appended to every input. The person sees the same roster in details and can stop any
sub-session.

## 7. `/side`

Grok's side chat is a child chat seeded with some turns of its parent (`SideChatInfo.seed_turn_count`). Ours: `/side <text>` is a
sub-session with `startedBy: 'person'`, prompt = the text, workspace `same`, main = that conversation's session (a bot or not),
opened beside the conversation as today (`useForks.ts`; `startBot` becomes `startSub`). It is seeded from the conversation with
`forkedFrom { turns }` when the provider supports the fork the page already uses for `/fork` (`withForkContext`); otherwise it starts
fresh as today. The number of seeded turns is a taste decision (open question 3). Differences from a bot-started sub-session, all today's
side behaviour, now one field:

- Nothing reaches the main bot as input: no result frame, no `sub_told`. The card beside the conversation shows `lastResult` and updates
  when a later turn ends; Open and Bring back are unchanged (`SideCards.tsx`).
- It is the person's own: not on the main bot's roster, not counted in its limit, not addressable by it (open question 1). It ends when
  the person stops it, or when its main is retired or gone.
- It has the tools of every sub-session, so `communicate_update.final_summary` is its answer and the "message no one" line is gone.

## 8. Instructions: base v12, the main bot, project bots, sub-sessions

`BOT_INSTRUCTIONS_VERSION` 11 becomes 12; the text is the shared base plus one role section chosen by `BotRecord.kind`
(`botInstructions(mission, memory, kind)`; the standing-instructions message names the kind). Every bot receives the new text as `[Your
standing instructions · v12]`, and the behaviour scenarios rerun (design 5.1).

**Shared base changes** (the other bullets of v11 stay). Frames bullet: `[Sub-session …]` joins the bracket examples. The v11 "You coordinate"
bullet is replaced by the role sections. New shared bullet:

> A sub-session keeps its context between pieces of work. Send later work that relates to it to the same one (send_to_sub_session) instead of starting another; start a new one for unrelated work (create_sub_session, with tracked_task_keys for the board items it takes up). When a result arrives, decide: send it more, or end it (stop_sub_session). Ending loses its context and the person can still read its conversation. get_sub_session_status, your board and your timer show each live one with how long it has been idle and what it last did; stop the ones you will not use again. Eight live at most.

**Main bot section:**

> You are the person's main bot: they talk to you first about everything. You keep the whole picture and do not do project work yourself. Create a project (create_project) for each lasting body of work, with its mission; put its work on its board (update_board with project) and tell it by message. Read the boards (board) and plans (read_project) instead of asking projects for progress; ask for periodic updates only when something runs long (start_project_updates, always with an end) and stop them when they are not needed. Answer the person from what you read and what projects report, in your own words. The person may talk to a project directly: you hear it as [The person wrote to …]; take it into account and do not answer it. Small questions and one-off long jobs you may do yourself, with your own sub-sessions.

**Project bot section:**

> You are a project bot, one lasting body of work for the main bot and the person. Keep the plan (read_project, update_project) and the board (board, update_board) of your project; the board is shared by you and your sub-sessions. Keep each turn short: do long or context-heavy work in sub-sessions and read your board first whenever you start, resume or were compacted. Report to the main bot (message to: main) at milestones, when blocked and when asked; one line, details on the board. Work that belongs to another project goes to its bot by message, or to the main bot.

**Sub-session instructions** (`sub-session-roles.ts`, replaces `taskWorkerInstructions`; the session's instructions, not a message):

> You are a sub-session of the bot "<bot>", named "<title>": a working session of its own, not a bot. Work arrives as input labelled [Work …]; the first is your prompt, and more related work may follow later, so keep what you learn in mind. [workspace sentence as today: same, read-only, or worktree at commit …] Do the work yourself with your own tools. Your project's board is shared with your bot: update the items you work on (board, update_board) and leave its statuses and plan alone. At the end of each piece of work call communicate_update with a final_summary (what you did and found, where results are, what is left; only its first 300 characters reach your bot in the input, the rest it reads on request); use current_step while you work. If you need a decision, say so first in the summary and stop; the answer arrives as the next input. You cannot message or create bots. Read the conversation you were started from with read_main_session only if the prompt is not enough. The person may also write to you directly. Native permissions still apply.

## 9. What the person sees

| Surface | Today | After |
|---|---|---|
| Cards in the owning bot's conversation | `Task done / not finished / stopped`, questions, folded progress (`TaskInputItem.tsx`) | one card per result: **Sub-session "{title}" reported**, **… could not finish**, **… was interrupted**, **… needs you** (approval), each with Open; progress folding is gone (no progress status). Frame headers `[Task …]` become `[Sub-session …]`; `parseTaskInputs` becomes `parseSubSessionInputs` |
| Chats, details, board, audit | see 9.1 | see 9.1 |
| Side card | `Side "{title}" answered`, Open, Bring back | unchanged text; reads `lastResult` of the person-started sub-session |
| Opened sub-session | conversation beside the main bot (panel in Bot mode, attached in Window mode, full screen on a phone) with Send, Interrupt/Queue, Stop, Keep | same placement; the composer gives Send, Interrupt where the provider steers, Queue; the row gives Stop; **no Keep**; approvals answered as for any session |
| Notices | "Task needs you" | "Sub-session needs you" |
| Board panel | statuses fixed, assignee, brief, report | status labels (custom, with category), owner (bot or sub-session, opens it), parent, tags, internal notes, links including the sub-session, the plan with its change summaries; Grok-shaped members list |
| Sub-session row | name, state, idle, last work, last result | adds the current step while it works |

### 9.1 Chats and the main bot's conversation as the person's home

| Surface | Today | After |
|---|---|---|
| Landing | the last conversation or the Chats list | **The main bot's conversation** is home once it exists; the person's first words go to it. Without one, Chats shows "Set up your main bot" above everything else |
| Chats list | standing bots grouped by chief, staff rows marked "Staff of <chief>" | Row 1: **the main bot** (picture, status, needs-you dot, pinned). Below it, section **Projects** (项目): every project bot with its status, a one-line board summary (open items, working sub-sessions) and its needs-you dot; a project's pending approval or `needs_you` sub-session lights the main bot's row too (what a chief's row did). No staff rows; sub-sessions have no rows. Ordinary sessions and groups below as today |
| Open a project bot | opens its conversation | unchanged: the person can open and talk to any project bot directly (ours; section 5.0). Its composer, Interrupt, Queue and details are as today |
| Main bot's details | mission, staff, temporary bots, work items | mission and memory; **Tasks across projects** (the all-boards panel Grok shows beside its main bot: open items grouped by project with owner, status label, tags, links; edit any item); **Projects** (open each); its own sub-sessions; its own board; periodic updates running per project with their end times |
| Project bot's details | mission, staff, temporary bots, board | mission and memory; the **shared board** (status labels, owner, parent, tags, notes, links, version; members; the plan with its summaries); **Sub-sessions**; the timer with its end |
| Notifications | a staff bot's needs-you collapses under its chief | a project's needs-you collapses under the main bot ("Main bot: Release needs you"); a `blocked` bot reminds the person directly as today |
| Cards | task cards in the chief's conversation | sub-session cards in the conversation of the bot that started them; a project's report to the main bot folds to one line per project ("3 updates from Release") as reports between bots do now |
| Audit | chains with bots by kind | chains show main, project and sub-sessions by role; stop a chain interrupts all of it |

English and Chinese strings (new or replaced; all in `conversation.*.ts`, `timeline.*.ts`, `settings` areas of
`agent-client/src/presentation/messages/areas`):

| Key | English | Chinese |
|---|---|---|
| `details.subSessions` | Sub-sessions | 子会话 |
| `details.subSessionsEnded` | Ended | 已结束 |
| `details.subSessionIdle` | Idle for {time} | 已空闲 {time} |
| `details.subSessionLastWork` | Last work: {text} | 上一次的工作：{text} |
| `details.subSessionStop` | Stop | 停止 |
| `details.subSessionMore` | More about {title} | {title} 的更多信息 |
| `details.subSessionActionFailed` | The sub-session could not be changed. | 没能更改这个子会话。 |
| `timeline.sub.reported` | Sub-session "{title}" reported | 子会话“{title}”交回了结果 |
| `timeline.sub.failed` | Sub-session "{title}" could not finish | 子会话“{title}”未能完成 |
| `timeline.sub.interrupted` | Sub-session "{title}" was interrupted | 子会话“{title}”被打断了 |
| `timeline.sub.needsYou` | Sub-session "{title}" needs you | 子会话“{title}”在等你 |
| `timeline.sub.ended` | Sub-session "{title}" ended | 子会话“{title}”已结束 |
| `timeline.sub.told` | You wrote to sub-session "{title}" | 你对子会话“{title}”说的话 |
| `timeline.sub.open` | Open | 打开 |
| `chats.mainBot` | Main bot | 总机器人 |
| `chats.mainBotSetup` | Set up your main bot | 设置你的总机器人 |
| `chats.mainBotSetupHint` | Talk to it about everything; it creates and directs your projects. | 有什么事先跟它说；它会创建并指挥你的项目。 |
| `chats.projects` | Projects | 项目 |
| `chats.projectSummary` | {open} open · {working} working | {open} 项待办 · {working} 项进行中 |
| `chats.projectNeedsYou` | {project} needs you | {project} 在等你 |
| `details.allProjectTasks` | Tasks across projects | 各项目的任务 |
| `details.members` | Members | 成员 |
| `details.projectUpdates` | Periodic updates until {time} | 定期汇报至 {time} |
| `details.projectBots` | Projects | 项目 |
| `settings.audit.subSessions` | Sub-sessions started: {count} | 启动的子会话：{count} |
| `details.subSessionStep` | Now: {text} | 正在做：{text} |
| `board.tags` | Tags | 标签 |
| `board.notes` | Notes | 备注 |
| `board.owner` | Owner | 负责人 |
| `board.statusAdd` | Add a status | 新增状态 |
| `board.statusCategory.open` / `.active` / `.closed` | Not started / In progress / Closed | 未开始 / 进行中 / 已关闭 |
| `board.plan` | Plan | 计划 |
| `client.fork.sideDescription` | Start a sub-session alongside this chat for what you write after /side | 在这段对话旁边启动一个子会话，去做 /side 后面写的事 |

Removed keys: `details.tasks`, `details.tasksDone`, `details.taskMarkDone`, `details.taskKeep`, `details.taskStopped`,
`timeline.task.*` (all of them, including reminder, question, progress, progressFrom), `settings.audit.retire`. The side keys
(`timeline.side.*`) are unchanged. Both locale files are changed together; the existing key-parity check applies.

## 10. Data drop on deploy

No conversion (owner, 2026-11-24). When Relay state loads:

- Saved Teams that carry the old `task` are removed (as Call For Support, TPM and ordinary Teams were in step 7, `state.ts`); their worker
  sessions stay ordinary sessions with their history.
- **Boards are dropped**: the board shape changes (statuses, owners, links, tags, notes) and its owner moves from the bot's inbox to the
  project; an old board does not validate and is discarded with its plan note. Items that named a dropped temporary bot disappear with it.
- **Today's standing bots become project bots without a rewrite.** Their `BotRecord` and Window group views stay (mission, memory,
  picture, session). The unknown fields `lifetime` and `chief` are not part of the new schema, so the record is re-read from its group view as
  bot records already are on first read; `kind` is `project` unless the record says `main`, and there is no `main` until the person sets one
  up. Their old chief chains disappear (a bot formerly "staff of" another is now simply a project bot). Their conversations, missions and
  memory are kept; their boards and sub-bot relations are not.
- Chains kept in state (7 days) that name dropped bots resolve to "bot gone" in the audit.
- Controller: worker seats of old tasks are not in the Relay's poll, so the existing missing-seat rule forgets them after 10 minutes and
  releases their runtimes. Old Controllers fail the capability check with "Update the Controller to use bots" (the host capability marker is
  bumped; the owner updates every Controller).
- After deploy the person sees their old bots as projects under a "Set up your main bot" offer; nothing runs for them that did not
  before.

Because of the 2026-11-25 incident (Cloudflare state load, 30 min of 503), step 6 adds a test that loads a state saved by the previous
version (tasks, a temporary bot id as assignee, `lifetime` and `chief` records, old boards) into the Cloudflare SQLite store conformance run
(`agent-relay-cloudflare/test/store-conformance.workers.test.ts`) and into the node store, before any deploy.

## 11. Steps (each is a commit that builds and tests green; none pushes)

Both rounds of owner answers are taken (section 1b); steps assume them. Staged by addition first, removal last, so every commit keeps
`pnpm verify:changed` green without compatibility code that survives: the old task and chief paths are deleted in step 7, and nothing new
calls them.

**Step 0. Start.** Worktree `.worktrees/sub-sessions`, `pnpm task:start`. Commit this plan alone.

**Step 1. Design text.** Amend `bots-design.md`: 1 (the model: main bot, project bots, sub-sessions; Bot, Message, Chain, Board stay the four
abstractions), 2.1 (`kind`, no `lifetime`, no `chief`), 2.2 (`create_project`), 2.4 (sub-session lifetime; the false 24 h clause), 2.5
(span of the main bot), 5.1 (tool table by role, instructions), 6.1 (the shared board), 6.2 (timer end, roster), 8 (who may do what by role),
9 (Tasks, Side, Team rows), 10 (Chats, home, panels), 12, 13 (decisions of 2026-11-27). Pointers from plans 8a, 9a, 9d and 10. Component
ledger files only where one exists for the component. No code.

**Step 2. Protocol and contracts.** `sub-session.ts`; `BotRecord.kind`; `create_project`, `start/stop_project_updates`, `read_project`,
`update_project` calls; the sub-session calls and `TeamAction.stop_sub_session`; `Team.sub`; the board shape of 4.3; `message` result `recipient`;
`communicate_update`; frames `[Sub-session …]`, `[Work …]`; instructions v12 with role sections. Fixtures `sub-session.v1.json`, `board.v1.json`
(new shape), `bot-messages.v1.json`, `project.v1.json`. Old types stay until step 7. Compatibility metadata is not updated on the task branch
(AGENTS); `pnpm postmerge` after the merge. Tests: protocol units; fixtures consumed by Relay and Controller suites.

**Step 3a. Shared board.** The board lives on the project (the bot's inbox record), written by `BotBoard` for the project bot, its sub-session
callers and the main bot (any project); `status_id` with per-board statuses; `owner`/`owner_session_id`; `members`; tags; notes; `position`;
links; `read_project`/`update_project` with string replacement and summary; conflict results; notices to owners. Tests (unit): version and stale
field with `conflicts`; a sub-session's write accepted and a write of structure refused; the main bot writes another project's board and the
project bot is noticed; a project bot cannot read another board except the one item it was handed; the plan replacement fails when `old_string` is
not found exactly once; Agree stays person-only. Contract fixture on both ends.

**Step 3b. Main and project bots (Relay).** `kind`, one main bot, `create_project`, flat project bots under the main bot, removal of `chief`,
`set_chief` and nested creation, `message` recipients `main`/project with `recipient` in the result, told frames always to the main bot,
`start/stop_project_updates` (timer with an end), `set_timer` `until_minutes`, the span of the main bot, the roster on a due timer's frame.
Tests (unit): the second main bot refused; `to: "main"` without one is `unreachable`; a project bot cannot create a project; told frame reaches
main; updates timer ends at `until`; project bots cannot reach one another's sub-sessions.

**Step 3. Relay: `SubSessions`.** `sub-sessions.ts` with `create`, `send` (delivery queue or interrupt, title), `status`, `stop`, results from
`sub_turn_end`/`sub_update`, `current_step`, limit with roster, `fork_from` validation, end on retire of its bot, chain counter (`subSessions`),
audit stop (interrupt, leave live), `read_bot` of own sub-sessions, the person's stop, `startSub` (`/side`, seed, person-owned). Integration:
the Relay with the real Team broker and in-memory store; the host broker settling a claimed work input and validating the team. Unit tests:
reuse of one record; queue versus interrupt order; `unreachable` after end; at-most-once (`input_unknown`); the 300-character result frame with
pointer; ten results, one input; `final_summary` over final text; `current_step` queues nothing; other bots never see or reach it; the
person-started one gives no input to its bot.

**Step 4. Controller.** Tool namespaces by role (main, project, sub-session), `sub-session-roles.ts`, instructions per role, the seat lifecycle of
5.3 (held while live; forgotten on ended and settled), `sub_turn_end` and `sub_update`, `sub_told`, `fork_from` through the page's fork, the
main bot's setup (create a session with its instructions, or convert a session), `get_sub_session_status`, worktree patch on the result, chain
approvals on sub-session turns. Tests (unit, scripted provider): a second work input reaches the same native session; a restart leaves an
in-flight input `unknown`; outcomes `finished`, `failed`, `interrupted`; the person's input gives `sub_told`; the seat is released on end; a
sub-session session gets no bot tools; approvals offered per chain and folder; a project bot has no `create_project`. Measure the memory and
process cost of a held idle lease per provider (Claude Code, Codex); decide hold or release-at-idle and record it.

**Step 5. Page.** Chats (main bot row, Projects section, setup offer, home landing), the main bot's details with the all-boards panel, the
project's shared board panel (status labels, owner, tags, notes, members, plan), `SubSessionsList`, sub-session cards, `SideCards` reading
`lastResult`, the directory (`task-directory.ts` becomes `project-directory.ts` with projects, members, boards), audit rows by role,
`useForks.ts` (`/side` seeded), locale files in both languages. Tests: unit (directory, grouping, idle text, row summary); component specs on fixture
pages (`sub-sessions.spec.ts`, `main-bot-home.spec.ts`: setup offer, row order, needs-you collapse, all-boards panel, shared board panel,
phone width); translation parity; `pnpm test:components`, `pnpm test:preview-browser`.

**Step 6. Behaviour scenarios and instructions.** Rewrite `scripts/bots-scenarios.mjs` (12.3) and run v12 with real Claude Code and Codex
(design 5.1 requires it for an instruction change).

**Step 7. Removal.** Delete the old path: `tasks.ts`, `TeamTask`, the `create_task` family, `side_final`, `keep`, `manageStaff`,
`temporaryBotId`, the temporary branch of `create_bot`, `create_bot` itself, `set_chief` and chief frames, `stop_bot`, `retire_bot`,
`BotRecord.lifetime` and `chief`, `BotListing.kind`, `ChainView.kinds`, the old board shape, `TasksList`, task cards and keys, `task-roles.ts`,
the task seat code of `team.ts`. Delete or rewrite the tests of section 2 under the mutation-check rule. Add the old-state load test of
section 10. Lower `architecture/exceptions.json` entries this removes; `pnpm arch:check`.

**Step 8. Flows, live check, as built.** Section 12; then "As built" in the design and this plan; then the full gate once
(`pnpm verify`; `pnpm test:e2e:flows` on Chromium and with `E2E_BROWSER=webkit`). After the merge into `main`: `pnpm postmerge`; push only
when the owner asks.

## 12. Tests per layer and the live check

### 12.1 Layers

| Layer | What |
|---|---|
| Unit | Per step above, each module by its public functions with mock data and no real waits (fake clocks): protocol builders/parsers; `SubSessions` rules; board listing; limit; end-on-retire; Controller seat; page directory and list. |
| Contract | `sub-session.v1.json` and the changed `bot-messages.v1.json` consumed by protocol, Relay and Controller; chain/board shape; the provider conformance kit is unchanged (`pnpm test:providers` still run once at the end because the worker session path touches the adapters' creation options). |
| Integration | Relay with the real Team broker and in-memory store (`pnpm test:changed` runs the seam suites named in `architecture/modules.json`, which are updated for the new files); Controller with scripted provider through the Host broker seam; old-state load on both stores. |
| Component | Fixture pages for the details section, cards, side card, audit row, opened conversation (desktop and phone width). |
| E2E flows | Section 12.2, Chromium and WebKit. |
| Local/native | Section 12.3 and 12.4. |

### 12.2 E15 flows

| Flow | Becomes |
|---|---|
| E15 flow 1 (two temporary bots, one folded input) | **Two sub-sessions finish while the main bot is idle: one input, two result cards**; the page shows both under Details › Sub-sessions |
| (new) | **Reuse:** the main bot sends later work to the same sub-session; the native session id is unchanged, the second input reaches it, no new session is created |
| (new) | **End and decide:** a result arrives, the main bot ends the sub-session; Details moves it to Ended, its conversation stays readable, a later send is `unreachable` |
| (new) | **Not a bot:** it has no Chats row; `list_bots` of another bot and `message` to its name or id do not reach it; its session has no `agent_remote` tools |
| (new) | **The person directs it:** in the browser the person opens it beside the main conversation, writes to it (the main bot gets `[The person wrote to sub-session …]`), interrupts a running turn, and presses Stop (the main bot is told) |
| (new) | **`/side`:** typed in the browser, the card appears beside the conversation, nothing reaches the main bot, Bring back sends the quote as the person's message. (No flow covered `/side` before.) |
| (new) | **Main bot retires:** its live sub-sessions end |
| (new) | **Limit:** the ninth `create_sub_session` is refused with the listing |
| E15c (chain approvals) | A chain across a main bot and its sub-session: one "allow for this chain in this folder" covers both; the audit lists and revokes it; another chain is asked as before |
| E15 audit/stop flow | A stopped chain interrupts the sub-session's running turn and leaves it idle |
| E15 board flow | Items are dispatched with `tracked_task_keys`: the item shows the sub-session as owner with an `agent_id` link; its result becomes the item's `report`; the sub-session updates its own item's status and notes and is refused on another; a stale write returns `conflicts`; the main bot marks the item closed |
| (new) | **Status and step:** `get_sub_session_status` shows `turn_in_flight`, `current_step` while it works and `last_terminal_turn_status` after; a `current_step` starts no turn of the main bot |
| (new) | **Fork:** `create_sub_session` with `fork_from: "main"` and `fork_turns` starts a session that holds those turns (scripted provider records the seed); a provider without the capability is refused |
| (new) | **Review:** a due timer's frame lists an idle sub-session with its idle time and last work, and a bot with no open item gets no timer turn |
| (new) | **Main bot home:** with no main bot Chats shows the setup offer; after setup the main bot is home and the project rows sit below it |
| (new) | **Create and direct a project:** the person asks the main bot; `create_project` makes a project bot that appears in Projects and reports in; the main bot writes items on its board and messages it; the project bot starts a sub-session that writes the same board |
| (new) | **Shared board:** the project bot, its sub-session and the main bot write the same item; the stale write returns `conflicts` and the owner is noticed; a sub-session's write of the plan or statuses is refused |
| (new) | **The person talks to a project directly:** the main bot gets `[The person wrote to <project>]` and does not answer it |
| (new) | **Updates timer:** `start_project_updates` with an end wakes the project bot, whose frame lists the roster; at the end no more wakes; `stop_project_updates` ends it early |
| (new) | **One main bot, flat projects:** a second main bot is refused; a project bot has no `create_project`; `to: "main"` reaches the main bot; a project bot cannot reach another's sub-sessions |
| E15b | Unchanged |

### 12.3 `scripts/bots-scenarios.mjs` (real Claude Code and Codex, by hand or nightly)

`temporary` becomes `subsession`: the bot splits a request over two sub-sessions (files alpha and beta as today); then a follow-up
that only the first sub-session can do from what it already knows (a codeword given in its first brief), proving context reuse by the file
it writes; then the bot ends both. `board` uses a sub-session for its item. Facts the checks read: sub-session records, `lastResult`,
count of live sessions, native session ids unchanged across the two dispatches, the bot's turn count per result (no extra turn from
review), tool calls per bot turn, and that the bot never used `message` toward a sub-session. Scenarios `projects` (the person asks the main bot for two projects; the main bot writes their boards; each runs a sub-session; the main bot sums up from the boards, with its tokens per person turn recorded) and `shared-board` (conflicting writes). A scenario for fork and timers: a chief forks a sub-session from its conversation and the sub-session answers from the seeded turns. A new scenario, `release`, gives the bot
more sub-session work than the limit and checks it ends idle ones when refused. Version 12 of the instructions needs these runs
before the release (design 5.1).

### 12.4 Live check (`pnpm local up`, `.agents/skills/prepare-arc-local/SKILL.md`)

On a configurable free port with this checkout's Relay, Controller and website, a real Claude Code bot, then Codex:

1. A bot starts a sub-session; the card and the Details row appear; the person opens it, writes to it, watches the main bot receive
   `[The person wrote to sub-session …]` and the result frame; screenshot desktop and a phone-width viewport.
2. Send follow-up work to the same sub-session by the main bot; confirm the context was reused and the idle time resets.
3. Interrupt it mid-turn from its composer; confirm the main bot is told, nothing waits for a result.
4. Stop it from its row; confirm Ended, the conversation readable, the main bot told.
5. `/side` from a plain session and from a bot; Bring back; no Keep anywhere; Chats has no sub-session row.
6. Chinese locale pass of every string in section 9.
7. Set up the main bot; ask it for a project; watch the project appear, its board fill from three writers, the all-projects panel update; open the project bot directly and write to it; check the main bot's `[The person wrote to …]`; start and stop updates and see the timer end. Screenshots of Chats with the main bot and Projects, desktop and phone width.
8. Measure and record: Host memory and CPU with three idle held sub-sessions; the main bot's context growth per result frame.

## 13. Risks

- **A larger change than sub-sessions alone.** The main bot, the flat project layer and the shared board touch every part of the bots design.
  Steps 3a and 3b land independently of the sub-session steps so each can be reviewed or reverted alone.
- **Held idle leases.** If a CLI keeps a process per lease, eight idle sub-sessions per bot may be heavy. Step 4 measures; the fallback
  (release at idle, re-acquire on dispatch or open) does not change the Relay side.
- **Weak results.** A model that ends its turn with an empty or noisy summary gives its bot a weak result; the instruction says what to lead
  with, `read_bot` reads the rest, and the behaviour scenarios check it.
- **Grok evidence is shapes only.** Prompts, enum values and per-role permissions are not in the bundle; behaviour that depends on them (how a
  model uses `delivery`, which role writes tasks) is chosen here and checked by the scenarios.
- **The main bot's context.** It reads boards and reports for every project; `board` returns open items only, folded by project, and project
  reports are one line each, so its context stays small. The scenario "three projects" measures its tokens per person turn.
- **Shared-board conflicts.** Several writers (project bot, sub-sessions, main bot, person) race; the versioning reports and notifies but
  never refuses. If real runs show thrash, owner-scoped item locks are the next step, not part of this plan.
- **No bot tools for the sub-session.** It cannot call for help; its bot does that. This is the price of "not a bot".
- **Person-driven turns in a bot-started sub-session** add result frames to the bot's context: one input at idle, 300 characters, folded.

## 14. Remaining gaps (not decided by the owner's answers), with a recommendation

1. **Cross-project delegation.** A project bot's board is closed to other project bots. Recommendation: a project bot asks another by
   `message` (or the main bot), and the receiver puts the item on its own board with the sender's item tag; only the main bot writes across boards.
2. **Standing staff bots.** The owner's "if any remain". Recommendation: none remain; sub-sessions replace them, so `create_bot` and `set_chief`
   go and a team is a project bot plus its sub-sessions. If the owner wants nested project bots later, a bot's chief becomes a field again.
3. **Who sets up the main bot and where it runs.** Recommendation: the page's offer (Host, provider, folder) or converting a session; its Host
   should be the one the person uses most; if that Host is offline the main bot is offline like any bot.
4. **The main bot's own board.** Recommendation: it has one, for requests not yet given to a project; the all-projects panel shows it first.
5. **Project bot limit.** 12 under the main bot (existing `BOT_SPAN_LIMIT`); a number to revisit after use.
6. **Grok's `worker_model_selection` on a project** (a project chooses the model of its sub-sessions) and **project appearance** (icon, color,
   avatar). Recommendation: the picture exists already; add a project-level default model and provider for its sub-sessions (`create_project`
   `model`/`provider`) in step 3b, nothing more.
7. **`/side` seed size** (taste): recommend the visible conversation up to a bound the Host sets by provider; fresh when the provider cannot
   fork.
8. **Name of `message` versus `send_to_agent`.** Recommendation: keep `message` (renaming touches every bot, flow and instruction) with Grok's
   `recipient` in the result.

## 15. The owner's answers, and where Grok still differs from an earlier decision

| # | Grok does | Earlier decision | Answer |
|---|---|---|---|
| 1 | Main bot above projects above workers | Peer bots, chief chains, one kind of bot, span 12 | **Decided: follow Grok.** One main bot, flat project bots, `kind`, no chiefs (5.0, 4.0) |
| 2 | Workers and members write tracked tasks | A bot writes only its own board | **Decided: follow Grok.** Shared board: project bot, sub-sessions, main bot (4.3) |
| 3 | One shared board per project with members | One board per bot; chief reads staff boards read-only | **Decided: follow Grok.** One board per project bot; the main bot reads and writes all |
| 4 | Projects are standing; workers are not | Staff bots stay bots | Staff bots do not remain; a project bot is Grok's project (gap 2) |
| 5 | Periodic wake-ups of an agent | No extra turns just for review | **Decided:** optional timer with an end; the roster on its frame (6) |
| 6 | `send_to_agent` has no length bound | 300-character bot messages | `message` stays at 300; long work is board items; a sub-session dispatch takes 8000 |
| 7 | `delivery` | Nothing a bot sends steers | `queue | interrupt` only |
| 8 | Workers report with `communicate_update` | Bots answer by `message` (T-1) | Sub-sessions only |
| 9 | Wide worker tool set | A sub-session is not a bot | No bot tools, no nesting |
| 10 | Custom statuses with categories | Five fixed statuses; Agree | Adopted; Agree person-only |
| 11 | Updates report `conflicts` | Stale writes apply and tell | Our semantics, Grok's names |
| 12 | Many tools | Complexity watched | Two board tools plus two plan tools; sub-session tools four plus `communicate_update` |
| 13 | `*_agent` names | "Sub-session" is the owner's word | `*_sub_session`; `create_project`, `read_project`, `update_project`, `start/stop_project_updates` as Grok's |
| 14 | `create_goal`/`update_goal` | One board per bot | No separate goal: a goal is a root board item; the main bot design does not need Grok's goals |
| 15 | `send_to_user` | The person hears a bot in its conversation | Not adopted |
| 16 | `fork_from`/`fork_turns`, seeded side chat | Small contexts | **Decided:** sub-sessions, `fork_turns` required, provider capability; `/side` may seed |
| 17 | `send_to_agent.model` | Model set at creation | Not adopted |
| 18 | `stop_agent` | Main bot decides lifetime | Stop is final |
| 19 | `delete_tracked_tasks` | Cancel, keep a week | Not adopted |
| 20 | Cloud placement fields | Host, folder, workspace | Map to ours |
| 21 | Plan by string replacement | 1000-character note | Adopted, 4000 characters, as `read_project`/`update_project` |
| 22 | `internal_notes` | The person sees everything | Adopted, visible |
| 23 | `subagent_type` | Provider behaviour in adapters | Not adopted |
| 24 | Main bot is one per user (the flags show one main-bot surface) | Chiefs per bot | One main bot, enforced (5.0) |
| 25 | A project is a conversation (`bc_id`) with its own side chat; the UI is not in the bundle | The person opens any bot | Kept (ours); marked in 5.0 |

