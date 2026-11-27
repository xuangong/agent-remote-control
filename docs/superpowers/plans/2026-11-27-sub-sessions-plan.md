# Sub-sessions: temporary bots become sessions of a bot, in Grok Bot's shape

Plan for the owner decision of 2026-11-27. It changes [bots design](../specs/2026-11-23-bots-design.md) 2.1, 2.2, 2.4, 2.5, 5.1, 6.1, 9, 10 and 12, and
[bots plans](2026-11-24-bots-8-mentions-plan.md) 8a, [9](2026-11-25-bots-9-review-plan.md) 9a and 9d and [10](2026-11-25-bots-10-hosts-plan.md).
Revised the same day three times: for the owner's direction to organise like Grok Bot (1a), for the owner's answers, and for the owner's correction after seeing the real Grok Bot UI (a chief with recruited bots, not a main bot above projects; 1b). Decisions are in section 15, open gaps in section 14. No product code is written here. Old data is dropped, there is no transition layer, and the owner updates every Controller
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
5. Delegation to another bot is `message` plus board items. Standing bots created by bots stay bots (recruits).

Held fixed: one approval per chain and folder (sub-sessions are in their bot's chain); messages never reassign items; owner sessions default to YOLO; prefer removing concepts over adding guards.


## 1a. Direction of 2026-11-27: organise like Grok Bot

The owner's direction: learn Grok Bot's pattern and imitate it where the earlier decisions allow. Two rounds of reading went into this plan;
the second corrected the first, and this text is the corrected one.

### Evidence and its limits

Two sources. (a) `/Applications/Grok Bot.app/Contents/Resources/app.asar` (1.2.3), read as untrusted data with regular expressions over the bytes
(`python3 -I`): the generated message schemas (`static $(){return["<Name>|<field> <type>…"]`) and the `…_tool_call` enum; nothing was run. It
gives argument and result **shapes** of 74 tool calls, not tool descriptions or prompts (server side), nor the values of string fields
(`delivery`, `lifecycle`, `mode`, status `category`), nor which role may call which tool. (b) The owner's screenshot of the real Grok Bot UI,
relayed by the coordinator (not seen by me). Where this plan needs something neither gives, it chooses and says "ours".

What the screenshot shows, which corrects my first reading ("main bot above projects above workers"): a **group** in the sidebar ("societas-bot") with
a **chief bot** ("管家大人") and the **bots it recruited** ("Mac Worker 1/2/3", "Windows Worker 1–5", designers, "tracker"), each a full chat
entity with its own avatar and last message (a recruit reports in: "你好，我已就位，等待分派…"); an **Unassigned** section for bots in no group; the
chief's conversation holds its own summaries to the person, with bot-to-bot traffic folded to lines ("6 messages with 4 Bots", "Message from
tracker", "3 messages with Windows Worker 1 and tracker"); a **progress board** card (进度看板, "Updated below") in the chief's conversation,
updated by the tracker bot; and the bots do heavy work by starting **local Codex runs** on their machine (hidden work sessions; "a running local
Codex task is not treated as stopped").

So, from the schemas read with that picture: `create_project` is how a chief **recruits a bot** (name, appearance, its own conversation, a plan,
periodic wake-ups); `create_agent`/`send_to_agent`/`get_agent_status`/`read_agent_transcript`/`stop_agent` drive the **work sessions**
(`create_agent`: `prompt, name?, model?, tracked_task_keys[], fork_from?, fork_turns?` and placement fields; `send_to_agent`: `agent_id, message,
delivery, title, model?, tracked_task_keys[]`; `get_agent_status` workers: `bc_id, name, lifecycle, turn_in_flight, last_terminal_turn_status,
pr_url, last_activity_at_ms`; `read_agent_transcript`: `agent_id, mode, max_turns`; `stop_agent`); **tracked tasks** are the board
(`TrackedTaskView { key, title, status_id, status_label, owner, owner_session_id, parent_key, links[], tags[], internal_notes, updated_at_ms, version }`;
links `agent_id | pr | document | url`; a list returns statuses with `category`, `members { name, session_id, is_you }`, tags and paging; an update
names `version` and returns `conflicts { key, field, current_value, changed_by, changed_at_ms, current_version }`); the project's **plan document**
is edited by `string_replacements [{ old_string, new_string }]` with a `summary`; `start_project_updates { agent_id }` returns
`{ agent_id, until_ms, was_on, message }`; a **side chat** is `{ parent_bc_id, seed_turn_count, subagent_type }`; the worker tool `communicate_update
{ current_step, final_summary }` reports progress and result.

### Mapping

| Grok Bot | Ours |
|---|---|
| Group with a chief bot and recruited bots | A **chief** and its **staff bots**, as today (design 2.1, `create_bot`, `chief`); the group row in Chats |
| Recruited bot: own avatar, own conversation, reports in | A standing bot created by `create_bot`: its report-in is a turn in its own conversation, which the person can open and talk to, and the reply to its chief |
| Chief's conversation with its own summaries, bot traffic folded | Unchanged principle (design 10); folding extended to "N messages with M bots" (section 9) |
| Hidden work sessions (local Codex runs) | **Sub-sessions** (`create_sub_session` family); they replace temporary bots only |
| Progress board card updated by the tracker bot | The **team board** with its **board card** in the chief's conversation, updated in place (4.3, 9) |
| Tracked tasks, statuses, tags, members | The team board's items, statuses, tags, `members` (4.3) |
| Project plan document | The team's plan, edited by string replacements with a summary, inside `update_board` (4.3) |
| `start_project_updates` (wake-ups until `until_ms`) | The bot's optional timer with an end (section 6) |
| Side chat | `/side`, a sub-session started by the person (section 7) |
| `fork_from`/`fork_turns` | The same arguments on `create_sub_session`, behind the provider's fork capability |
| `communicate_update` | The sub-session's reporting tool (4.2) |
| Unassigned section | Bots whose chief is the person and that have no staff are listed as they are today; a label "Unassigned" is optional page polish, not a concept |

### 1b. The owner's answers

First round (kept): (3) the review timer is optional, turned on by the bot with an end, its wake-up frame carries the sub-session roster, and without it
review happens in ordinary turns; (4) fork is supported for sub-sessions with `fork_turns` required behind the provider's fork capability, and `/side`
may carry the conversation's context; plus: custom status categories with Agree person-only, `*_sub_session` names, no separate goal concept (a goal
is a root board item), `/side` belongs to the person and its bot does not see it, sub-sessions message no one, 8 live per bot, a person's direct turn
in a sub-session is a chain of its own.

Second round (this correction, which replaces the first round's hierarchy and board answers):

1. **No main bot, no `kind`.** Chiefs and staff bots stay as today: any bot may recruit with `create_bot`, the recruit reports in, appears in Chats in
   its chief's group, and the person can talk to it. Staff bots remain.
2. **Sub-sessions replace only temporary bots**, with the owner's sub-session decisions.
3. **One shared board per team**, where a team is a chief's group: the chief, its staff bots and their sub-sessions all write it, versioned with
   conflicts. The chief's conversation shows a board card updated in place.
4. Keep the optional review timer and fork.
5. Keep Grok's tool and status shapes where they still fit; drop what only served the main-bot design.

In the owner's sub-session decisions of section 1, "main bot" means **the bot whose main session owns the sub-session** (its bot); there is no
separate main bot. This plan writes "its bot" or "the owning bot".

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
| `agent-relay-core/src/bot-board.ts` | the board lives on a standing bot's inbox; a temporary bot writes the status, links and result of the item it was created for (`own`); a report from it moves the item |
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
| **Sub-session** (zh **子会话**) | A native agent-loop session of a bot, directed by that bot and the person. Not a bot. |
| **Owning bot** | The bot whose main session started a sub-session (a plain conversation for `/side` from a session that is no bot). |
| **Chief**, **staff bot** | As today: a standing bot and the standing bots it recruited with `create_bot`. The person is the root. |
| **Team** | A chief, its staff bots and all their sub-sessions: the writers of one **team board** and one **team plan**. |
| **Work** | One dispatch to a sub-session: its first prompt, or later input from its bot, with a one-line `title`. A sub-session works through one piece at a time, in order. |
| **Result** | The `final_summary` the sub-session reported, or the final text of its ended turn. |
| **Idle** | The sub-session's turn has ended and nothing is on its way to it. It keeps its context. |
| **End** | Release: its runtime is let go, its conversation stays readable as an ordinary session. Ended is final. |

"Temporary bot", "task", `lifetime`, "worker" and "Keep" disappear from product text, protocol and code. "Side" remains the name of the
person's command and of its card (zh 旁路, unchanged).

Ids: `s_` plus 32 hex (`SubSessionId`), derived from the Team id like `temporaryBotId` was, but a different pattern so a sub-session id
can never be taken for a `BotId`. This is how "other bots cannot see or reach it" holds by construction: nothing that resolves a bot (`named`, `byKey`,
`list`, `read_bot` of other bots' sessions, `message`) ever sees an `s_` id.

## 4. The tool surface

Every bot has the same tools (design 2.1: a bot has no kind). Shapes mirror Grok Bot's where they fit; names say "sub-session" because "agent"
already means the CLI in this product.

### 4.0 What changes in the tool list

| Tool | Change |
|---|---|
| `create_bot` | Always standing (a recruit). `lifetime` is removed; so are fields the standing path ignores (check `createStanding`: `workspace` worktree). The report-in and the group placement are as today |
| `create_sub_session`, `send_to_sub_session`, `get_sub_session_status`, `stop_sub_session` | New (4.1); they replace the temporary form of `create_bot` and `stop_bot`/`retire_bot` |
| `board`, `update_board` | Reshaped to the team board in Grok's shape (4.3); the plan moves inside `update_board`; no `read_project`/`update_project` tools |
| `read_bot` | Takes Grok's `mode` (`last_turn` | `recent`) and `max_turns`; also reads the caller's own sub-sessions; the result carries `truncated` |
| `set_timer` | Gains `until_minutes` (Grok's `until_ms`); a due timer's frame carries the sub-session roster (section 6) |
| `list_bots` | No temporary entries, no "above" entry for a temporary bot's chief |
| `stop_bot`, `retire_bot` | Removed: they only ever managed temporary bots (`manageStaff`); a standing bot is removed by the person |
| `message`, `set_chief`, `remember`, `forget`, `update_mission`, `list_hosts`, `download_attachment`, `open_room`, `clear_timer` | Unchanged |
| `communicate_update`, `read_main_session` | New, for sub-sessions only (4.2) |

Tool count for a bot: minus 2, plus 4. Grok's separate transcript, project and goal tools are not adopted (section 15).

### 4.1 Sub-session tools

| Tool | Arguments | Result |
|---|---|---|
| `create_sub_session` | `prompt` (the first work, standing alone, up to 8000), `name?`, `model?`, `provider?`, `tracked_task_keys[]` (board items it takes up), `fork_from?` (`"main"` = this bot's main conversation, or the id of one of its own sub-sessions) with `fork_turns` (**required** with `fork_from`), `workspace` (`same`, `read_only`, `worktree`), `host`, `cwd`, `new_folder` (plan 10), `operationId` | `{ sub_session_id, message }` |
| `send_to_sub_session` | `sub_session_id` (id or name), `message` (the next work, up to 8000), `delivery` (`queue`, the default: between turns; or `interrupt`: stop the running turn first), `title` (one line naming this piece of work; shown as last work), `tracked_task_keys[]`, `operationId` | `{ sub_session_id, delivered_as: delivered | held | duplicate, message }`; `unreachable` when it has ended |
| `get_sub_session_status` | `sub_session_ids[]` (none = all its own) | `{ sub_sessions: [{ id, name, lifecycle, turn_in_flight, last_terminal_turn_status, last_work_title, current_step?, tracked_task_keys[], pr_url?, last_activity_at_ms }], message }` |
| `stop_sub_session` | `sub_session_id` | `{ sub_session_id, message }`; ends it, idempotent |

`lifecycle` is `starting | live | needs_you | ended` (ours; Grok's values are not in the bundle); `last_terminal_turn_status` is `finished |
failed | interrupted`; idle is `live` with `turn_in_flight` false, its length `now - last_activity_at_ms`. `pr_url` is the `pr` link of the
items it works on. There is no `steer` delivery: design 3.2 stands (nothing a bot sends steers a turn). Dispatching with `tracked_task_keys`
records the sub-session as `owner` of those items, adds an `agent_id` link and records the dispatch `title`; messages never reassign items.

### 4.2 What a sub-session has

It is not a bot: no `message`, `create_bot`, memory, timers or sub-sessions of its own. It has its native tools and:

- `communicate_update { current_step?, final_summary? }` (Grok's shape). `current_step` is one line, shown in the status and on the page,
  and never wakes its bot. `final_summary` is the result of the piece of work; a turn that ends without one uses its final text.
- `read_main_session`: the conversation it was started from.
- `board` and `update_board` on its team's board, items only (4.3).

### 4.3 The team board (Grok's tracked tasks) and the team plan

**Team boundary.** A **team** is a chief, its staff bots and all their sub-sessions. The board belongs to the team, not to a bot. Rule for which
board a bot works on (its **home board**): a bot whose chief is the person, or that has recruited at least one live bot, **leads** a team and its
home board is that team's board; a staff bot that has recruited none belongs to its chief's team and its home board is the chief's. A bot's
sub-sessions write the home board of the bot that started them. A chief with no staff yet leads a team of itself and its sub-sessions.

**Nested teams.** A staff bot S of chief C that recruits its own bots R1, R2 leads a **nested team** with its own board (created empty when S
recruits; items S had on C's board stay there). S is still a member of C's team (it writes C's board for the work C gave it) and C **reads** S's board
read-only (`board { bot: "S" }`, as a chief reads its staff's board today). Work flows down by items: C writes an item on C's board owned by S; S
breaks it down on S's board. A bot sees its home board, the board of the team it leads if different, and, for an item another bot handed it, that one
item. Between teams there is no shared board: a bot asks a bot of another team by `message` and the receiver puts the item on its own home board.

**Who writes what.** Items, links, tags and notes: every member (the chief, its staff bots, the sub-sessions), through the same call. Board structure
(statuses, plan): the chief that leads the team and the person; staff bots and sub-sessions read them. The person edits anything. This replaces
design 6.1's "a bot writes only its own board" and plan 8a's "a staff bot never writes its chief's board".

**Versioning.** Every write names the `version` it read (a new item names none). A stale write still applies field by field and the result lists
`conflicts [{ key, field, current_value, changed_by, changed_at_ms, current_version }]`: what it overwrote and who wrote it (design 6.1 stays;
Grok's result is ambiguous about applying). A change to an item an owner holds (retitled, reassigned, cancelled, brief changed) queues
`[Item "…" changed · …]` to that owner, a bot or a sub-session, written by the Relay from the record. Messages never reassign items.

Item (`BoardItem`):

| Field | Source | Note |
|---|---|---|
| `key`, `title`, `parent_key`, `version`, `updated_at_ms` | Grok | `parent` renamed |
| `status_id`, `status_label` | Grok | Per-board statuses `{ id, label, category, description? }`; categories `open | active | closed` (ours); seeded open, working, waiting, done, cancelled. A status that needs the person's Agree stays a person-only transition whatever its category |
| `owner`, `owner_session_id` | Grok, replaces `assignee` | A member: `self` (the writer), a staff bot of the team, a bot it leads, or a live sub-session; `members` names them |
| `links[]` | Grok | `agent_id` (a sub-session id or a bot's id), `pr`, `document`, `url`; ours keep `commit`, `branch`, `file`, `attachment`, `host`, `folder` |
| `tags[]`, `internal_notes` | Grok | Notes are visible to the person |
| `brief`, `report`, `result`, per-field `changedAt`, `updatedBy`, `closedAt` | Ours | Reports from staff bots and sub-sessions; stale-write notices; the confirmation rule |

Read (`board`, optional `bot` for a nested team's board): `{ tasks, statuses, members { name, session_id, is_you }, tags, plan, older_closed_count,
truncated, matching_count, next_cursor }`, filtered by `keys`, `status_categories`, `owner`, `linked_agent_id`; plus the roster of live sub-sessions of
the caller. Write (`update_board`): items with `version`, `position`, `add_links`/`remove_links`, `statuses`, `tags`, and `plan { string_replacements
[{ old_string, new_string }], summary, version }` (each `old_string` must match exactly once; the plan holds up to 4000 characters, the last 20 summaries
are kept); result `{ updated, created [{ client_ref, key, version }], conflicts }`. `delete` is not adopted: cancel and a week of retention stay.
The plan is the team's: one document, edited by the chief and read by all.

**The board card.** The team board shows in its chief's conversation as one card (Grok's 进度看板), placed at the turn where the board was first
written and updated in place from the board record afterwards (items by status, owners, latest writer and time); it never adds a timeline entry per
change. A nested team's board shows as a card in S's conversation.

### 4.4 Limits

At most **8 live** sub-sessions per bot that started them (`SUB_SESSION_LIVE_LIMIT`, replacing `TASK_RUNNING_LIMIT = 12`; they no longer count
toward the span of 12 bots, which stays as design 2.5 says, for bots only). The ninth is refused with the roster and "stop one or send it the work".
Person-started sides are not counted. Board: 50 open items as today. `ACCOUNT_TEAM_LIMIT` still bounds the account; ended sub-sessions are pruned by
count (200), never by age.

## 5. Relay state and Controller

### 5.0 Teams and the board record

No new kind of bot. The board record moves from the standing bot's inbox to the **team**: the Relay finds a caller's home board by the rule of 4.3
(`homeBoard(caller)`): from the bot's `chief` and from whether it has recruited live bots (both already in the bot record), and, for a sub-session,
from the bot that started it. One lookup replaces the chief/staff/own-board branches of `bot-board.ts` and `bot-calls.ts`. Recruiting a first bot
creates the nested board; removing the last recruit leaves it readable and empty. The report-in of a recruit is unchanged (design 2.2): a turn in its
own conversation, visible to the person who can open it, and the reply to its chief.

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
- for a **bot-started** sub-session, queues one input for its bot: `[Sub-session "QA" · result]` + the first 300 characters,
  ending with `…` and "read it with read_bot" when cut; `failed` and `interrupted` have their own header so its bot is never left
  waiting. It waits for its bot's idle and is combined with other waiting inputs by the existing rule (3.2): reports are folded
  newest per sender, so ten sub-sessions finishing wake its bot once. A `current_step` queues nothing;
- for an owned board item, writes the item's `report` line (300) with the existing `board.report`. The status is not changed by the
  Relay: the owner (its bot, or the sub-session through its limited `update_board`) sets it.

The whole waiting machinery (`question`, reminder, `no_report`, "ask the owner or the person") is deleted. The person writing into the
sub-session directly behaves as the person writing to any bot with a chief (design 3.5): its bot gets `[The person wrote to
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
- Delivery unknown after a restart: state `needs_you`, reason `input_unknown`; its bot or the person sends the work again
  (`send_to_sub_session` or the composer). This replaces `brief_unknown` and the "tell the person, cancel it" text.
- The instructions (`task-roles.ts` becomes `sub-session-roles.ts`) are the only instructions: **no standing bot instructions** and
  no `[Your standing instructions]` messages (it is not a bot). Text in section 8.
- Tool namespace: only `agent_remote_sub` with `communicate_update`, `read_main_session` and the owned-items `update_board`; the full `agent_remote` namespace is not given to it
  (`bot-tools.ts` `namespace()` is used for bots only), so the Relay's `caller()` no longer has a "worker is a bot" branch and every
  call from a sub-session session is refused as "not a bot".
- `fork_from`/`fork_turns`: the Controller creates the worker session with the fork the page uses for `/fork` (`withForkContext`), copying
  the last `fork_turns` turns of the main conversation; a provider without the capability refuses with that reason and its bot starts fresh.
- A worktree workspace keeps its patch: the patch path is appended to the result text, as it is appended to a worktree worker's report now.
- Chain approvals (`watchChainTurns`, `CHAIN_APPROVAL_POLICY`) keep working: a dispatched turn's chain is its dispatching message's chain,
  so it is its bot's chain, and `chain_approval` asks by (chain, kind, folder). The Controller offers the policy on sub-session
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
withdraws its queued work, and leaves the sub-session idle (the person ends it with Stop); `retire_bot` is removed. `bot-board.ts`: the `own` writer rule becomes the team-board rule of 4.3 (every member writes items; structure by the leading chief and the person); the board record moves from the bot's inbox to the team (`homeBoard`, 5.0); `assignee` becomes `owner`/`owner_session_id` (step 3a).
`bot-store.ts`: when a standing bot gets `retiredAt`, call `SubSessions.endAllOf` for its session (decision 3: when its bot retires, its sub-sessions end; before, retiring did not touch temporary bots because the text and code had diverged).
`coordination-retention.ts`: kind `task` becomes `sub` (ended kept 200; live never pruned).

## 6. Reviewing sub-sessions periodically

Grok's mechanism is `start_project_updates`, periodic wake-ups until `until_ms`. The owner's answer: an **optional timer the bot turns on, with an
end**; without it, review happens in ordinary turns.

1. **Ordinary turns.** Each sub-session result is a decision point (more related work with `send_to_sub_session`, or `stop_sub_session`). A bot reads
   its board first whenever it starts, resumes or was compacted, and that read, like `get_sub_session_status`, carries the roster: "name · live, idle
   3 h · last: <last_work_title> · step: <current_step>". The ninth `create_sub_session` is refused with the roster. No turn is added.
2. **The optional timer.** `set_timer { name, minutes, until_minutes? }` (design 6.2: quiet-based, waits for idle, missed ticks coalesce); the bot
   sets it for itself and it ends at its end or by `clear_timer`. Its frame carries the open items **and the sub-session roster**. Grok lets another
   agent turn a project's updates on; here only the bot does (a chief that wants a staff bot woken sends it a message).
3. **The default timer** (every five minutes while a bot has open items, design 6.2) is unchanged and lists the roster too, so a bot that works
   with sub-sessions is reminded of idle ones at the moments it already wakes. A bot with no open items and no timer wakes for nothing.

No automatic release and no line appended to every input. The person sees the same roster in details and can stop any sub-session.

## 7. `/side`

Grok's side chat is a child chat seeded with some turns of its parent (`SideChatInfo.seed_turn_count`). Ours: `/side <text>` is a
sub-session with `startedBy: 'person'`, prompt = the text, workspace `same`, main = that conversation's session (a bot or not),
opened beside the conversation as today (`useForks.ts`; `startBot` becomes `startSub`). It is seeded from the conversation with
`forkedFrom { turns }` when the provider supports the fork the page already uses for `/fork` (`withForkContext`); otherwise it starts
fresh as today. The number of seeded turns is a taste decision (gap 4 in section 14). Differences from a bot-started sub-session, all today's
side behaviour, now one field:

- Nothing reaches its bot as input: no result frame, no `sub_told`. The card beside the conversation shows `lastResult` and updates
  when a later turn ends; Open and Bring back are unchanged (`SideCards.tsx`).
- It is the person's own: not on its bot's roster, not counted in its limit, not addressable by it (a person-started sub-session belongs to the person). It ends when
  the person stops it, or when its main is retired or gone.
- It has the tools of every sub-session, so `communicate_update.final_summary` is its answer and the "message no one" line is gone.

## 8. Base instructions v12 and the sub-session's own

`BOT_INSTRUCTIONS_VERSION` 11 becomes 12 in `packages/agent-remote-protocol/src/bots.ts`; every bot receives the new text as `[Your standing
instructions · v12]`, and the behaviour scenarios rerun (design 5.1). Changed lines (the other bullets of v11 stay):

Frames bullet: `[Sub-session …]` joins the bracket examples.

Coordinate bullet (replaces the v11 one):

> You coordinate. Keep each turn short: answer what you can at once, and hand work of any size away. Long or context-heavy work of your own goes to a sub-session (create_sub_session); work that belongs to another role goes to the bot whose mission fits (list_bots), by message, or to a bot you recruited (create_bot, for a role your work keeps needing). Sub-sessions are yours alone: no other bot sees or reaches them. These tools, never your own subagents, are how the person sees your helpers. Your team shares one board (board, update_board): put the plan there with a line saying why whenever it changes, give each item an owner, and read it first whenever you start, resume or were compacted. Answer your staff's questions first. Do not ask your staff or sub-sessions for progress: read the board and wait for their reports, then decide and sum them up for the person in your own words.

New bullet:

> A sub-session keeps its context between pieces of work. Send later work that relates to it to the same one (send_to_sub_session) instead of starting another; start a new one for unrelated work (create_sub_session, with tracked_task_keys for the board items it takes up). When a result arrives, decide: send it more, or end it (stop_sub_session). Ending loses its context and the person can still read its conversation. get_sub_session_status, the board and your timer show each live one with how long it has been idle and what it last did; stop the ones you will not use again. Eight live at most.

Board lines elsewhere in v11 ("no bot writes another bot's board", "a standing staff bot writes only its own board") are replaced by: "the board is your team's:
your chief, your staff and your sub-sessions write items on it; the team's statuses and plan belong to its chief."

**Sub-session instructions** (`sub-session-roles.ts`, replaces `taskWorkerInstructions`; the session's instructions, not a message):

> You are a sub-session of the bot "<bot>", named "<title>": a working session of its own, not a bot. Work arrives as input labelled [Work …]; the first is your prompt, and more related work may follow later, so keep what you learn in mind. [workspace sentence as today: same, read-only, or worktree at commit …] Do the work yourself with your own tools. Your team's board is shared with your bot: update the items you work on (board, update_board) and leave its statuses and plan alone. At the end of each piece of work call communicate_update with a final_summary (what you did and found, where results are, what is left; only its first 300 characters reach your bot in the input, the rest it reads on request); use current_step while you work. If you need a decision, say so first in the summary and stop; the answer arrives as the next input. You cannot message or create bots. Read the conversation you were started from with read_main_session only if the prompt is not enough. The person may also write to you directly. Native permissions still apply.

## 9. What the person sees

| Surface | Today | After |
|---|---|---|
| Cards in the owning bot's conversation | `Task done / not finished / stopped`, questions, folded progress (`TaskInputItem.tsx`) | one card per result: **Sub-session "{title}" reported**, **… could not finish**, **… was interrupted**, **… needs you** (approval), each with Open; progress folding is gone (no progress status). Frame headers `[Task …]` become `[Sub-session …]`; `parseTaskInputs` becomes `parseSubSessionInputs` |
| Chats, details, board, audit | see 9.1 | see 9.1 |
| Side card | `Side "{title}" answered`, Open, Bring back | unchanged text; reads `lastResult` of the person-started sub-session |
| Opened sub-session | conversation beside its bot (panel in Bot mode, attached in Window mode, full screen on a phone) with Send, Interrupt/Queue, Stop, Keep | same placement; the composer gives Send, Interrupt where the provider steers, Queue; the row gives Stop; **no Keep**; approvals answered as for any session |
| Notices | "Task needs you" | "Sub-session needs you" |
| Board panel | statuses fixed, assignee, brief, report | status labels (custom, with category), owner (bot or sub-session, opens it), parent, tags, internal notes, links including the sub-session, the plan with its change summaries; Grok-shaped members list |
| Sub-session row | name, state, idle, last work, last result | adds the current step while it works |

### 9.1 Chats, the chief's conversation and the board card

| Surface | Today | After |
|---|---|---|
| Chats | standing bots grouped by chief; staff rows "Staff of <chief>" (zh 成员); no row for temporary bots | **Unchanged.** Sub-sessions have no entry. A staff bot's pending approval or `needs_you` sub-session lights its chief's row as a temporary bot's approval did (`BotRoster.tsx`). Recruits show their own avatar and last message (their report-in) as now |
| Open a bot | its conversation, composer, Interrupt, Queue, details | Unchanged |
| Chief's conversation | the chief's words; reports fold to one line per sender ("3 updates from Dev") | Bot-to-bot traffic folds further, in Grok's wording: **"6 messages with 4 bots"**, **"3 messages with Windows Worker 1 and tracker"**, **"Message from tracker"**; each line expands; the chief's own words to the person stay full |
| **Board card** | none (the board is in details) | One live card per team board in its chief's conversation (4.3): items grouped by status with owner and tags, the latest writer and time ("Updated by tracker 2 min ago"), Open to the details board; a nested team's card sits in its leading staff bot's conversation |
| Details of a bot | mission, staff, temporary bots, board | mission and memory; staff; **Sub-sessions** (below); **the team board** (status labels, owner, parent, tags, notes, links, version, members) and the team plan with its summaries; a nested team's board read-only for its chief; the timer with its end |
| Sub-session list in details | Tasks: Mark done, Stop, Keep | rows grouped *Needs you* / *Working* / *Idle* / *Ended* (last 10): name, state, "idle 3 h", the current step or last work line, the last result line, session id; actions **Open** and **Stop**. No Mark done, no Keep |
| Notices | a staff bot's needs-you collapses under its chief | unchanged |
| Audit | chains with bots by kind; Retire for a temporary bot | bots only; "Sub-sessions started: n" per chain; stopping a chain interrupts its sub-session turns; `Retire` removed |

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
| `timeline.board.title` | Progress board | 进度看板 |
| `timeline.board.updated` | Updated by {name} {time} | {name} 于 {time} 更新 |
| `timeline.board.open` | Open board | 打开看板 |
| `timeline.bots.messagesWith` | {count} messages with {names} | 与 {names} 的 {count} 条消息 |
| `timeline.bots.messageFrom` | Message from {name} | 来自 {name} 的消息 |
| `details.members` | Members | 成员 |
| `details.teamPlan` | Team plan | 团队计划 |
| `details.nestedBoard` | Board of {bot} (read only) | {bot} 的看板（只读） |
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

- Saved Teams that carry the old `task` are removed (as Call For Support, TPM and ordinary Teams were in step 7, `state.ts`); their worker sessions stay
  ordinary sessions with their history.
- **Boards are dropped.** The board's shape changes (statuses, owners, links, tags, notes) and its home moves from the bot's inbox to the team; an old
  board does not validate and is discarded with its plan note. Items that named a dropped temporary bot go with it. Standing bots, their missions, memory,
  pictures, groups and `chief` stay; so the chiefs and staff the person has now are the chiefs and staff after deploy, with empty team boards.
- `BotRecord.lifetime` is removed: every remaining bot is standing; records that still carry the field are re-read from their group view as bot records
  already are on first read.
- Chains kept in state (7 days) that name dropped temporary bots resolve to "bot gone" in the audit.
- Controller: worker seats of old tasks are not in the Relay's poll, so the existing missing-seat rule forgets them after 10 minutes and releases their
  runtimes. Old Controllers fail the capability check with "Update the Controller to use bots" (the host capability marker is bumped; the owner updates
  every Controller).

Because of the 2026-11-25 incident (Cloudflare state load, 30 min of 503), step 7 adds a test that loads a state saved by the previous version (tasks, a
temporary bot id as assignee, `lifetime` records, old boards) into the Cloudflare SQLite store conformance run
(`agent-relay-cloudflare/test/store-conformance.workers.test.ts`) and into the node store, before any deploy.

## 11. Steps (each is a commit that builds and tests green; none pushes)

The owner's answers (1b) are taken. Staged by addition first, removal last, so every commit keeps `pnpm verify:changed` green without compatibility
code that survives: the old task path and the old board shape are deleted in step 7, and nothing new calls them.

**Step 0. Start.** Worktree `.worktrees/sub-sessions`, `pnpm task:start`. Commit this plan alone.

**Step 1. Design text.** Amend `bots-design.md`: 2.1 (no `lifetime`), 2.2 (the temporary paragraph), 2.4 (sub-session lifetime; the false 24 h clause),
2.5 (span counts bots only), 5.1 (tool table, instructions), 6.1 (the team board, its writers, nested teams, the plan), 6.2 (timer end, roster), 9 (Tasks,
Side rows), 10 (board card, folding), 12, 13 (decisions of 2026-11-27). Pointers from plans 8a, 9a, 9d and 10. Ledger files only where a component
file exists. No code.

**Step 2. Protocol and contracts.** `sub-session.ts`; the sub-session calls and `TeamAction.stop_sub_session`; `Team.sub`; the board shape of 4.3
(statuses, owner, links, tags, notes, members, conflicts, plan edits); `read_bot` `mode`/`max_turns`; `set_timer` `until_minutes`; `communicate_update`;
frames `[Sub-session …]`, `[Work …]`; instructions v12. Fixtures `sub-session.v1.json`, `board.v1.json` (new shape), `bot-messages.v1.json`. Old types
stay until step 7. Compatibility metadata is not updated on the task branch (AGENTS); `pnpm postmerge` after the merge. Tests: protocol units; fixtures
consumed by Relay and Controller suites.

**Step 3a. Team board (independent of sub-sessions).** `homeBoard(caller)` (4.3), the board record on the team, nested boards read by the chief, writes by
chief, staff and sub-session callers, structure only by the leader and the person, `status_id`/categories, `owner`, `members`, tags, notes, `position`,
plan edits, conflicts, notices to owners, the board card's data (latest writer, time). Tests (unit): the home-board rule for a top-level bot, a staff
bot without recruits, a staff bot with recruits, a sub-session of each; version and stale field with `conflicts`; staff write the chief's board and are
refused structure; a chief reads a nested board and cannot write it by `bot`; a bot of another team cannot read the board except one handed item; plan
replacement fails when `old_string` is not found exactly once; Agree stays person-only. Contract fixture on both ends.

**Step 3. Relay: `SubSessions`.** `sub-sessions.ts` with `create`, `send` (delivery queue or interrupt, title), `status`, `stop`, results from
`sub_turn_end`/`sub_update`, `current_step`, the limit with roster, `fork_from` validation, end on retire of its bot, the chain counter (`subSessions`),
audit stop (interrupt, leave live), `read_bot` of own sub-sessions, the person's stop, `startSub` (`/side`, seed, person-owned), timer `until_minutes`
and the roster in a due timer's frame. Integration: the Relay with the real Team broker and in-memory store; the host broker settling a claimed work
input and validating the team (the 2026-11-25 N-7 class of bug). Unit tests: reuse of one record; queue versus interrupt order; `unreachable` after end;
at-most-once (`input_unknown`); the 300-character result frame with pointer; ten results, one input; `final_summary` over final text; `current_step`
queues nothing; other bots never see or reach it; the person-started one gives no input to its bot; the timer ends at `until`.

**Step 4. Controller.** `sub-session-roles.ts`, the sub-session tool namespace (`communicate_update`, `read_main_session`, board), the four tools in
`bot-tools.ts` (`delivery`, `title`, `fork_from`, worktree patch on the result), the seat lifecycle of 5.3 (held while live; forgotten on ended and
settled), `sub_turn_end`/`sub_update`/`sub_told`, `fork_from` through the page's fork, chain approvals on sub-session turns, no standing instructions for
it. Tests (unit, scripted provider): a second work input reaches the same native session; a restart leaves an in-flight input `unknown`; outcomes
`finished`, `failed`, `interrupted`; the person's input gives `sub_told`; the seat is released on end; a sub-session session gets no bot tools;
approvals offered per chain and folder. Measure the memory and process cost of a held idle lease per provider (Claude Code, Codex); decide hold or
release-at-idle and record it.

**Step 5. Page.** `SubSessionsList` (replaces `TasksList`), sub-session cards, `SideCards` reading `lastResult`, the **board card** in the chief's
conversation and the team board panel (status labels, owner, tags, notes, members, plan), the extended folding ("N messages with M bots", "Message from X"),
the directory (`task-directory.ts` becomes `sub-session-directory.ts`: sides, owned, assignees, open, stop), audit rows, `useForks.ts` (`/side` seeded),
locale files in both languages. Tests: unit (directory, grouping, folding rules, idle text); component specs on fixture pages (`sub-sessions.spec.ts`:
states, Stop, no Keep, opened conversation beside its bot, full screen on a phone; `board-card.spec.ts`: live update in place, nested card, folding
lines); translation parity; `pnpm test:components`, `pnpm test:preview-browser`.

**Step 6. Behaviour scenarios and instructions.** Rewrite `scripts/bots-scenarios.mjs` (12.3) and run v12 with real Claude Code and Codex (design 5.1
requires it for an instruction change).

**Step 7. Removal.** Delete the old path: `tasks.ts`, `TeamTask`, the `create_task` family, `side_final`, `keep`, `manageStaff`, `temporaryBotId`, the
temporary branch of `create_bot` and its `lifetime`, `stop_bot`, `retire_bot`, `BotRecord.lifetime`, `BotListing.kind`, `ChainView.kinds`, the old board
shape and per-bot board, `TasksList`, task cards and keys, `task-roles.ts`, the task seat code of `team.ts`. Delete or rewrite the tests of section 2
under the mutation-check rule. Add the old-state load test of section 10. Lower `architecture/exceptions.json` entries this removes; `pnpm arch:check`.

**Step 8. Flows, live check, as built.** Section 12; then "As built" in the design and this plan; then the full gate once (`pnpm verify`;
`pnpm test:e2e:flows` on Chromium and with `E2E_BROWSER=webkit`). After the merge into `main`: `pnpm postmerge`; push only when the owner asks.

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
| E15 flow 1 (two temporary bots, one folded input) | **Two sub-sessions finish while its bot is idle: one input, two result cards**; the page shows both under Details › Sub-sessions |
| (new) | **Reuse:** its bot sends later work to the same sub-session; the native session id is unchanged, the second input reaches it, no new session is created |
| (new) | **End and decide:** a result arrives, its bot ends the sub-session; Details moves it to Ended, its conversation stays readable, a later send is `unreachable` |
| (new) | **Not a bot:** it has no Chats row; `list_bots` of another bot and `message` to its name or id do not reach it; its session has no `agent_remote` tools |
| (new) | **The person directs it:** in the browser the person opens it beside the main conversation, writes to it (its bot gets `[The person wrote to sub-session …]`), interrupts a running turn, and presses Stop (its bot is told) |
| (new) | **`/side`:** typed in the browser, the card appears beside the conversation, nothing reaches its bot, Bring back sends the quote as the person's message. (No flow covered `/side` before.) |
| (new) | **Limit:** the ninth `create_sub_session` is refused with the listing |
| E15c (chain approvals) | A chain across a chief, a staff bot and a sub-session: one "allow for this chain in this folder" covers both; the audit lists and revokes it; another chain is asked as before |
| E15 audit/stop flow | A stopped chain interrupts the sub-session's running turn and leaves it idle |
| E15 board flow | Items are dispatched with `tracked_task_keys`: the item shows the sub-session as owner with an `agent_id` link; its result becomes the item's `report`; the sub-session updates its own item's status and notes and is refused on another; a stale write returns `conflicts`; its bot marks the item closed |
| (new) | **Status and step:** `get_sub_session_status` shows `turn_in_flight`, `current_step` while it works and `last_terminal_turn_status` after; a `current_step` starts no turn of its bot |
| (new) | **Fork:** `create_sub_session` with `fork_from: "main"` and `fork_turns` starts a session that holds those turns (scripted provider records the seed); a provider without the capability is refused |
| (new) | **Review:** a due timer's frame lists an idle sub-session with its idle time and last work, and a bot with no open item gets no timer turn |
| (new) | **Team board:** the chief, a staff bot and a sub-session write the same item; a stale write returns `conflicts` and the owner is noticed; a staff bot's or sub-session's write of the plan or statuses is refused; the board card in the chief's conversation updates in place with the writer and time |
| (new) | **Nested team:** a staff bot recruits two bots; its board is separate, its chief reads it and cannot write it by `bot`; its card sits in the staff bot's conversation |
| (new) | **Recruit and fold:** a bot recruits another; the recruit reports in (its own conversation shows it, the chief gets the reply); six bot messages in the chief's conversation fold to "6 messages with 4 bots" and expand |
| (new) | **Its bot retires:** its live sub-sessions end |
| (new) | **Timer with an end:** `set_timer` with `until_minutes` wakes the bot, whose frame lists the roster; after the end no more wakes; a bot with no open items and no timer gets no turn |
| E15b | Unchanged |

### 12.3 `scripts/bots-scenarios.mjs` (real Claude Code and Codex, by hand or nightly)

`temporary` becomes `subsession`: the bot splits a request over two sub-sessions (files alpha and beta as today); then a follow-up
that only the first sub-session can do from what it already knows (a codeword given in its first brief), proving context reuse by the file
it writes; then the bot ends both. `board` uses a sub-session for its item. Facts the checks read: sub-session records, `lastResult`,
count of live sessions, native session ids unchanged across the two dispatches, the bot's turn count per result (no extra turn from
review), tool calls per bot turn, and that the bot never used `message` toward a sub-session. Scenarios `team` (a chief recruits two staff bots and each runs a sub-session; all write the team board; the chief sums up from the board, with its tokens per person turn recorded) and `shared-board` (conflicting writes). A scenario for fork and timers: a chief forks a sub-session from its conversation and the sub-session answers from the seeded turns. A new scenario, `release`, gives the bot
more sub-session work than the limit and checks it ends idle ones when refused. Version 12 of the instructions needs these runs
before the release (design 5.1).

### 12.4 Live check (`pnpm local up`, `.agents/skills/prepare-arc-local/SKILL.md`)

On a configurable free port with this checkout's Relay, Controller and website, a real Claude Code bot, then Codex:

1. A bot starts a sub-session; the card and the Details row appear; the person opens it, writes to it, watches its bot receive
   `[The person wrote to sub-session …]` and the result frame; screenshot desktop and a phone-width viewport.
2. Send follow-up work to the same sub-session by its bot; confirm the context was reused and the idle time resets.
3. Interrupt it mid-turn from its composer; confirm its bot is told, nothing waits for a result.
4. Stop it from its row; confirm Ended, the conversation readable, its bot told.
5. `/side` from a plain session and from a bot; Bring back; no Keep anywhere; Chats has no sub-session row.
6. Chinese locale pass of every string in section 9.
7. A chief recruits a staff bot and the staff bot starts a sub-session; watch the recruit report in, the three write the same board, the board card update in place in the chief's conversation, and the bot messages fold to "N messages with M bots"; open the staff bot directly and write to it; a nested team's board shows read-only for its chief. Screenshots, desktop and phone width.
8. Measure and record: Host memory and CPU with three idle held sub-sessions; its bot's context growth per result frame.

## 13. Risks

- **The board change is wider than sub-sessions.** Team boards touch protocol, Relay, tool text and the page panel; step 3a lands independently so it can
  be reviewed or reverted alone.
- **Held idle leases.** If a CLI keeps a process per lease, eight idle sub-sessions per bot may be heavy. Step 4 measures; the fallback (release at idle,
  re-acquire on dispatch or open) does not change the Relay side.
- **Weak results.** A model that ends its turn with an empty or noisy summary gives its bot a weak result; the instruction says what to lead with,
  `read_bot` reads the rest, and the behaviour scenarios check it.
- **Grok evidence is shapes and one screenshot.** Prompts, enum values and per-role permissions are not available; behaviour that depends on them (how a
  model uses `delivery`, which member writes what) is chosen here and checked by the scenarios.
- **Shared-board conflicts.** Several writers race on a team board; versioning reports and notifies but never refuses. If real runs show thrash,
  owner-scoped item locks are the next step, not part of this plan.
- **Board card semantics.** The screenshot shows "Updated below" without saying whether Grok adds a new entry or updates one in place; this plan updates in
  place and shows the writer and time. The page spec is checked with the owner on first view.
- **No bot tools for the sub-session.** It cannot call for help; its bot does that. This is the price of "not a bot".
- **Person-driven turns in a bot-started sub-session** add result frames to its bot's context: one input at idle, 300 characters, folded.

## 14. Remaining gaps, with a recommendation

1. **Nested teams (resolved here, to confirm).** A staff bot that recruits leads its own team board, which its chief reads; teams never share a board.
2. **An item for a bot of another team.** `message` and the receiver's own board item; no cross-team board write.
3. **Where the "Unassigned" label goes.** Optional polish for bots with no chief and no staff; not a concept.
4. **`/side` seed size** (taste): the visible conversation up to a bound the Host sets by provider; fresh when the provider cannot fork.
5. **Live limit 8.** A number; step 4's measurement may move it.
6. **Board card behaviour** (above): in place, writer and time.

## 15. The owner's answers, and where Grok still differs from an earlier decision

| # | Grok does | Earlier decision | Answer |
|---|---|---|---|
| 1 | Group with a chief and recruited bots; no single main bot | Chiefs, staff, `create_bot`, span 12 (design 2.1, 2.5) | **Decided (second round): keep as today.** No main bot, no `kind` |
| 2 | Members and workers write the team's tracked tasks | A bot writes only its own board; staff never write the chief's | **Decided: follow Grok.** One board per team (4.3) |
| 3 | A progress card in the chief's conversation, updated by a bot | Board only in details | **Decided: board card updated in place** (9.1) |
| 4 | Periodic wake-ups of an agent | No extra turns just for review | **Decided:** optional timer with an end; roster on its frame (6) |
| 5 | `fork_from`/`fork_turns`; seeded side chat | Small contexts between bots | **Decided:** sub-sessions only, `fork_turns` required, provider capability; `/side` may seed |
| 6 | Workers are hidden work sessions | Temporary bots were bots | **Decided:** sub-sessions replace temporary bots only |
| 7 | `send_to_agent` has no length bound | 300-character bot messages | `message` stays at 300; a sub-session dispatch takes 8000 |
| 8 | `delivery` | Nothing a bot sends steers | `queue | interrupt` only |
| 9 | Workers report with `communicate_update` | Bots answer by `message` (T-1) | Sub-sessions only |
| 10 | Wide worker tool set | A sub-session is not a bot | No bot tools, no nesting |
| 11 | Custom statuses with categories | Five fixed statuses; Agree | Adopted; Agree person-only |
| 12 | Updates report `conflicts` | Stale writes apply and tell | Our semantics, Grok's names |
| 13 | Separate transcript, project, goal and tracked-task tools | Complexity watched | Not adopted: `read_bot` takes `mode`/`max_turns`; the plan is inside `update_board`; two board tools; a goal is a root board item |
| 14 | `*_agent` names | "Sub-session" is the owner's word | `*_sub_session` |
| 15 | `send_to_user`, `send_to_agent.model`, `delete_tracked_tasks`, typed `subagent_type`, cloud placement fields | Various | Not adopted |
| 16 | `stop_agent` | Lifetime is the bot's decision | Stop is final |
| 17 | Recruits report in and appear in the chief's group (screenshot) | Design 2.2 (report-in, own conversation, group placement) | Already ours; unchanged |

