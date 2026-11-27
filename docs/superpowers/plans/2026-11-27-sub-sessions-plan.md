# Sub-sessions: temporary bots become sessions of a bot, in Grok Bot's shape

Plan for the owner decision of 2026-11-27. It changes [bots design](../specs/2026-11-23-bots-design.md) 2.1, 2.2, 2.4, 2.5, 5.1, 6.1, 9, 10 and 12, and
[bots plans](2026-11-24-bots-8-mentions-plan.md) 8a, [9](2026-11-25-bots-9-review-plan.md) 9a and 9d and [10](2026-11-25-bots-10-hosts-plan.md).
Revised the same day four times, each for a decision of the owner; the last (1b) is final: a personal ledger per bot, pages kept by a bot for team trackers, a primary bot, and Grok-shaped sub-sessions. Decisions are in section 15, open gaps in section 14. No product code is written here. Old data is dropped, there is no transition layer, and the owner updates every Controller
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

The owner's direction: learn Grok Bot's pattern and imitate it where the earlier decisions allow. Three rounds of reading went into this plan; each
corrected the one before, and this text is the final one.

### Evidence and its limits

Three sources. (a) `/Applications/Grok Bot.app/Contents/Resources/app.asar` (1.2.3), read as untrusted data with regular expressions over the bytes
(`python3 -I`): the generated message schemas (`static $(){return["<Name>|<field> <type>…"]`) and the `…_tool_call` enum; nothing was run. It gives
argument and result **shapes** of 74 tool calls, not prompts, nor the values of string fields (`delivery`, `lifecycle`, `mode`). (b) The owner's
screenshot of the real UI, relayed by the coordinator (not seen by me). (c) xAI's public docs, read with WebFetch: `docs.x.ai/grok-bot/bots`,
`/files-and-results` (fetched by me), and `/overview`, `/how-grok-bot-works`, `/chat-and-collaboration`, `/use-cases`, `/faq` (as summarised by the
coordinator). Where this plan needs something none gives, it chooses and says "ours".

What the sources say, which the plan follows:

- **Primary Bot** (docs, /bots): "your main point of contact. It checks in with you on its own and coordinates work with your other Bots." The person
  creates one or picks an existing Bot and can replace it later; there is at most one.
- **Focused Bots** (docs, /bots): "a long-lived teammate with its own job, conversation, and working context"; existing Bots "can suggest or create a
  focused Bot when a job needs a lasting owner". In the UI (screenshot): a group with a chief bot and the bots it recruited, each with its own avatar and
  last message, an Unassigned section, bot-to-bot traffic folded in the chief's conversation ("6 messages with 4 Bots").
- **Memory** (docs, /bots): per Bot, preferences, rules, facts and a dated work log, so a Bot keeps its role without replaying messages; a reset clears
  history but keeps memory. This is today's `remember`/`forget` and mission; nothing to build.
- **Pages** (docs, /files-and-results): "A tracker is a page, such as a launch tracker that lists open tasks, owners, and statuses." Pages are text,
  tables and charts a Bot builds; "only the Bot changes a page's content"; viewers read it; it "lives in the Bot's Library". In the bundle the page is
  `write_canvas`/`read_canvas` (contents, page id, title).
- **Work sessions** (bundle): `create_agent`/`send_to_agent`/`get_agent_status`/`read_agent_transcript`/`stop_agent`; Bots hand coding work to cloud
  agents and attach the results (docs, /files-and-results; the screenshot shows local Codex runs). A Bot's own tasks (`GrokBotAgentTask`) name the
  sessions that work on them (`subagent_ids`, `cloud_agent_bc_ids`). Tracked tasks carry `key, title, status, owner, owner_session_id, parent_key,
  links, tags, internal_notes, version` and an update reports `conflicts` (bundle).
- **Periodic updates** (bundle): `start_project_updates { agent_id }` → `{ until_ms, was_on }`; **side chat** `{ parent_bc_id, seed_turn_count }`; the
  worker tool `communicate_update { current_step, final_summary }`.

### Mapping

| Grok Bot | Ours |
|---|---|
| Primary Bot (at most one, picked and replaceable by the person) | `primary: true` on one standing bot, set from the page (4.6) |
| Focused Bot, created by any Bot when a job needs a lasting owner | A standing bot recruited with `create_bot`; its chief's group in Chats; as today |
| Bot memory and work log | Mission, `remember`/`forget`, unchanged |
| A Bot's own tasks, owned by itself or the sessions that work on them | The bot's **ledger**: its board, items owned by itself, a sub-session or another bot (4.3) |
| Tracker = a page a Bot keeps; only that Bot edits; read-only to others | **Pages** (`write_page`/`read_page`), card in the chief's conversation (4.5) |
| Work sessions (`create_agent` family; cloud agents, local Codex runs) | **Sub-sessions** (4.1); they replace temporary bots only |
| `communicate_update` | The sub-session's reporting tool (4.2) |
| `start_project_updates` | The bot's optional timer with an end (6) |
| Side chat | `/side`, a sub-session started by the person (7) |
| `fork_from`/`fork_turns` | The same arguments on `create_sub_session`, behind the provider's fork capability |
| Folded bot-to-bot traffic in the chief's conversation | "N messages with M bots" lines (9.1) |

### 1b. The owner's answers

Kept from the first round: the review timer is optional, turned on by the bot with an end, its frame carries the sub-session roster; fork is supported
for sub-sessions with `fork_turns` required behind the provider's fork capability and `/side` may carry the conversation's context; `*_sub_session`
names; no goal concept; `/side` belongs to the person; sub-sessions message no one; 8 live per bot; a person's direct turn in a sub-session is a chain
of its own. Kept from the second: chiefs and staff bots stay, any bot recruits with `create_bot`, no main bot above projects. Final answers (owner):

1. **A personal ledger per bot** (the board as before, per bot): the bot's items, each owned by the bot itself, one of its sub-sessions, or another bot;
   written by the bot and its sub-sessions; the owner of an item may change its status; the person may change any item; an Agree-gated status is
   person-only; a chief reads its staff bots' ledgers. Grok's useful item fields are kept (key, owner, parent, links including the sub-session id, tags,
   notes, version with conflicts between the bot and its sub-sessions).
2. **The team ledger is a page kept by a bot**, not a system board: a bot (the chief, or a tracker bot it assigns) reads the members' ledgers and writes
   a shared page (markdown with a table of tasks, owners and statuses), shown as a card in the chief's conversation and updated in place; everyone reads
   it, only its bot edits. The shared structured team board, nested team boards and cross-bot write rules are dropped.
3. **A primary bot**: the person marks one bot as primary (at most one, replaceable from the page); it is their main contact, may check in on its own (the
   optional timer) and coordinates; the base instructions say what that means. Any bot may still recruit focused bots.
4. Sub-sessions replace temporary bots; every bot can open them; its bot and the person direct them; other bots cannot reach them; the bot decides their
   lifetime with periodic review by the optional timer; no Keep; `/side` is a sub-session; **native in-turn subagents are allowed and nothing is built
   for them** (the instruction "never your own subagents" is dropped).

In the owner's sub-session decisions of section 1, "main bot" means **the bot whose main session owns the sub-session** (its bot); this plan writes "its
bot" or "the owning bot".

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
| **Primary bot** (zh **主机器人**) | The one bot the person marks as their main contact; it coordinates and may check in on its own. |
| **Ledger** | A bot's own board: its items and its plan note. The bot and its sub-sessions write it. |
| **Page** (zh **页面**) | A markdown document a bot writes with `write_page`; everyone reads it, only its bot edits it. A team tracker is a page. |
| **Work** | One dispatch to a sub-session: its first prompt, or later input from its bot, with a one-line `title`. |
| **Result** | The `final_summary` the sub-session reported, or the final text of its ended turn. |
| **Idle** / **End** | A sub-session whose turn ended with nothing inbound keeps its context; ending releases it for good. |

"Temporary bot", "task", `lifetime`, "worker" and "Keep" disappear from product text, protocol and code. "Side" remains the name of the person's command
and of its card (zh 旁路, unchanged).

Ids: `s_` plus 32 hex (`SubSessionId`), derived from the Team id like `temporaryBotId` was, but a different pattern so a sub-session id can never be taken
for a `BotId`: nothing that resolves a bot (`named`, `byKey`, `list`, `read_bot` of other bots' sessions, `message`) ever sees an `s_` id.

## 4. The tool surface

Every bot has the same tools (design 2.1); the primary bot differs only by its instructions (4.6). Shapes mirror Grok Bot's where they fit; names say
"sub-session" because "agent" already means the CLI in this product.

### 4.0 What changes in the tool list

| Tool | Change |
|---|---|
| `create_bot` | Always standing (a recruit): `lifetime` removed, and the fields the standing path ignores. Report-in and group placement as today |
| `create_sub_session`, `send_to_sub_session`, `get_sub_session_status`, `stop_sub_session` | New (4.1); they replace the temporary form of `create_bot` and `stop_bot`/`retire_bot` |
| `board`, `update_board` | The bot's ledger (4.3): an owner may be a sub-session; nothing else changes |
| `write_page`, `read_page` | New (4.5): a bot's pages |
| `read_bot` | Also reads the caller's own sub-sessions |
| `set_timer` | Gains `until_minutes`; a due timer's frame carries the sub-session roster (section 6) |
| `list_bots` | No temporary entries; each standing bot shows whether it is the primary bot |
| `stop_bot`, `retire_bot` | Removed: they only managed temporary bots; the person removes a standing bot |
| `message`, `set_chief`, `remember`, `forget`, `update_mission`, `list_hosts`, `download_attachment`, `open_room`, `clear_timer` | Unchanged |
| `communicate_update`, `read_main_session` | New, for sub-sessions only (4.2) |

Tool count for a bot: minus 2, plus 6 (four sub-session tools and two page tools).

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
- `board` and `update_board` on its owning bot's ledger: the status, links and result of the items it owns (4.3); `read_page`.

### 4.3 The ledger: today's board, with sub-session owners

Owner's remark: "we were already doing almost exactly this." The per-bot board **is** the personal ledger and stays as it is: `board` and `update_board`, the
fields, the five statuses, the plan note, per-field versions with the overwrite notice (today's conflict report between a bot and the writer it raced),
the notices to an item's owner, and the chief reading its staff bots' boards read-only. Only what the decisions need changes:

- An item's `assignee` may be one of the bot's own live sub-sessions (`SubSessionId`). Dispatching with `tracked_task_keys` records it as owner, adds a
  link of kind `sub_session` with its id and records the dispatch `title`; messages never reassign items.
- A sub-session writes its bot's ledger as the temporary bot did: the status, links and result of the items it owns (the existing `own` writer rule,
  generalised from one item to every item it owns); it reads the whole ledger. The bot writes any item; the person any item; an Agree-gated status is
  person-only (as today).
- The owner of an item changes its status: for a sub-session that is the rule above. A staff bot changing the status of an item on its chief's board is
  **not built** (staff report by message and the chief decides, as today).

Removed from earlier drafts: tags and notes, custom statuses, string-replacement plan edits, the shared team board, nested boards, `members` lists, the
same-chief read widening, conflict renaming.

### 4.4 Limits

At most **8 live** sub-sessions per bot that started them (`SUB_SESSION_LIVE_LIMIT`, replacing `TASK_RUNNING_LIMIT = 12`; they no longer count
toward the span of 12 bots, which stays as design 2.5 says, for bots only). The ninth is refused with the roster and "stop one or send it the work".
Person-started sides are not counted. Board: 50 open items as today. `ACCOUNT_TEAM_LIMIT` still bounds the account; ended sub-sessions are pruned by
count (200), never by age.

### 4.5 Pages (Grok's pages and `write_canvas`/`read_canvas`)

A **page** is a markdown document a bot keeps; everyone of the account reads it, only the bot that wrote it edits it (Grok: "only the Bot changes a
page's content"). A team tracker is a page: the chief (or a bot it assigns, which reads boards the chief may read) writes a table of tasks, owners and statuses.

| Tool | Arguments | Result |
|---|---|---|
| `write_page` | `title` (up to 120), `contents` (markdown, up to 8000 characters), `page_id?` (omit to create), `version?` (the version it read; a stale one is applied and reported) | `{ page_id, version, message }` |
| `read_page` | `page_id?`, `bot?` (default the caller) | with `page_id`: `{ page_id, title, contents, version, updated_at_ms, bot }`; without: the bot's pages `[{ page_id, title, version, updated_at_ms }]` |

At most 10 pages per bot, whole-document rewrites, stored on the bot's inbox next to its board. **The card**: a page shows as one card in the conversation of
the bot that wrote it and, for a staff bot, in its chief's conversation, rendered from the record and updated in place ("Updated by <bot> 2 min ago", no new
timeline entry per rewrite); pages are listed in the bot's details.

### 4.6 The primary bot

- `BotRecord.primary: true` on at most one standing bot. The person sets it from the page: a bot's details and its Chats row offer "Make primary";
  marking another bot clears the first (replaceable, Grok's "you can replace it later"). Only a standing bot whose chief is the person can be primary
  (Grok: a Team Bot cannot be); setting one elsewhere is refused with the reason. The Relay enforces "at most one" in the one write that sets it.
- **What it is.** The person's main contact: Chats pins it first with a "Primary" mark, and the app opens on its conversation when it exists. Its
  instructions (section 8) tell it to check in with the person on its own by turning on its optional timer with an end (`set_timer … until_minutes`),
  and to coordinate: recruit focused bots with `create_bot` for jobs that need a lasting owner, assign a tracker bot for the team page, route what the
  person asks to the bot that owns it, and sum up.
- **How it learns it is primary.** The standing instructions carry a role line; setting or clearing the flag changes the instructions hash, so the
  bot receives the new `[Your standing instructions · v12]` message (the existing mechanism).
- Everything else about it is an ordinary bot: it has a ledger, pages, sub-sessions and staff.

## 5. Relay state and Controller

### 5.0 Records

No new kind of bot and no new board. `BotRecord` gains `primary?: true` (at most one) and loses `lifetime`. The board stays on the bot's inbox; `assignee`
and `updatedBy` widen to `SubSessionId`; pages are a new optional `pages` array on the same inbox. A sub-session's caller identity resolves to its owning
bot, so its `board`/`update_board`/`read_page` calls act on that bot's board with the sub-session as the writer. The report-in of a recruit is unchanged.

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
withdraws its queued work, and leaves the sub-session idle (the person ends it with Stop); `retire_bot` is removed. `bot-board.ts`: the `own` writer rule becomes the ledger rule of 4.3 (a sub-session writes the items it owns; an item's owner changes its status; the person any item; same-chief ledgers are readable); `assignee` widens to `SubSessionId` and items gain `tags` and `notes`. A new `pages.ts` holds `write_page`/`read_page` and `set_primary` lives with the bot record writes.
`bot-store.ts`: when a standing bot gets `retiredAt`, call `SubSessions.endAllOf` for its session (decision 3: when its bot retires, its sub-sessions end; before, retiring did not touch temporary bots because the text and code had diverged).
`coordination-retention.ts`: kind `task` becomes `sub` (ended kept 200; live never pruned).

## 6. Reviewing sub-sessions periodically

Grok's mechanism is `start_project_updates`, periodic wake-ups until `until_ms`; the docs say the primary Bot "checks in with you on its own". The
owner's answer: an **optional timer the bot turns on, with an end**; without it, review happens in ordinary turns.

1. **Ordinary turns.** Each sub-session result is a decision point (more related work with `send_to_sub_session`, or `stop_sub_session`). A bot reads
   its ledger first whenever it starts, resumes or was compacted, and that read, like `get_sub_session_status`, carries the roster: "name · live, idle
   3 h · last: <last_work_title> · step: <current_step>". The ninth `create_sub_session` is refused with the roster. No turn is added.
2. **The optional timer.** `set_timer { name, minutes, until_minutes? }` (design 6.2: quiet-based, waits for idle, missed ticks coalesce); the bot sets
   it for itself, it ends at its end or by `clear_timer`, and its frame carries the open items **and the sub-session roster**. The primary bot uses the
   same timer to check in with the person.
3. **The default timer** (every five minutes while a bot has open items, design 6.2) is unchanged and lists the roster too. A bot with no open items
   and no timer wakes for nothing.

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
instructions · v12]`, and the behaviour scenarios rerun (design 5.1). `botInstructions(mission, memory, { primary })` appends the primary section only for
the primary bot. Changed lines (the other bullets of v11 stay):

Frames bullet: `[Sub-session …]` joins the bracket examples.

Coordinate bullet (replaces the v11 one):

> You coordinate. Keep each turn short: answer what you can at once, and hand work of any size away. Work that you hand off, that is long or context-heavy, that you will give more of later, or that the person or other bots must see goes to a sub-session (create_sub_session); a job that needs a lasting owner goes to a focused bot you recruit (create_bot); work that belongs to another role goes to the bot whose mission fits (list_bots), by message. Your own in-turn subagents (the Task tool and the like) are fine for a quick lookup inside a turn; anything the person should see goes to a sub-session. Sub-sessions are yours alone: no other bot sees or reaches them. Keep your ledger (board, update_board): your items, each with an owner (yourself, a sub-session, or another bot), and the plan with a line saying why whenever it changes. Answer your staff's questions first. Do not ask your staff or sub-sessions for progress: read their ledgers and wait for their reports, then decide and sum them up for the person in your own words.

New bullets:

> A sub-session keeps its context between pieces of work. Send later work that relates to it to the same one (send_to_sub_session) instead of starting another; start a new one for unrelated work (create_sub_session, with tracked_task_keys for the ledger items it takes up). When a result arrives, decide: send it more, or end it (stop_sub_session). Ending loses its context and the person can still read its conversation. get_sub_session_status, your ledger and your timer show each live one with how long it has been idle and what it last did; stop the ones you will not use again. Eight live at most.

> A report, tracker or summary that others should read goes on a page (write_page), which everyone reads and only you edit. A team tracker is a page: read your staff's ledgers (board with bot) and keep a table of tasks, owners and statuses.

**Primary bot section** (only for the bot the person marked primary):

> You are the person's primary bot: their main contact. Check in with them on your own when something is worth saying: turn on a timer with an end for it (set_timer with until_minutes) and keep it short. You coordinate their other bots: recruit a focused bot for a job that needs a lasting owner, assign a tracker bot to keep the team page, route what the person asks to the bot that owns it, and sum up in your own words. The person may talk to any bot directly; you hear it as [The person wrote to …] and do not answer it.

**Sub-session instructions** (`sub-session-roles.ts`, replaces `taskWorkerInstructions`; the session's instructions, not a message):

> You are a sub-session of the bot "<bot>", named "<title>": a working session of its own, not a bot. Work arrives as input labelled [Sub-session …]; the first is your prompt, and more related work may follow later, so keep what you learn in mind. [workspace sentence as today: same, read-only, or worktree at commit …] Do the work yourself with your own tools. Your bot's ledger is shared with you: update the status, links and result of the items you own (board, update_board). At the end of each piece of work call communicate_update with a final_summary (what you did and found, where results are, what is left; only its first 300 characters reach your bot in the input, the rest it reads on request); use current_step while you work. If you need a decision, say so first in the summary and stop; the answer arrives as the next input. You cannot message or create bots. Read the conversation you were started from with read_main_session only if the prompt is not enough. The person may also write to you directly. Native permissions still apply.

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

### 9.1 Chats, the chief's conversation, pages and the primary bot

| Surface | Today | After |
|---|---|---|
| Chats | standing bots grouped by chief; staff rows "Staff of <chief>" (zh 成员); no row for temporary bots | **Unchanged**, plus: the **primary bot** is pinned first with a "Primary" mark (zh 主). Sub-sessions have no entry. A staff bot's pending approval or `needs_you` sub-session lights its chief's row as a temporary bot's approval did |
| Primary | none | A bot's details and its Chats row action **Make primary** (zh 设为主机器人) for a bot whose chief is the person; marking another replaces it; the app opens on the primary bot's conversation when one exists |
| Chief's conversation | the chief's words; reports fold to one line per sender | Bot-to-bot traffic folds further in Grok's wording: **"6 messages with 4 bots"**, **"3 messages with Windows Worker 1 and tracker"**, **"Message from tracker"**; each line expands; the chief's own words stay full |
| **Page card** | none | One live card per page in the conversation of its bot and, for a staff bot, its chief's: title, rendered markdown (tables), "Updated by tracker 2 min ago"; updated in place, never a new entry per rewrite |
| Details of a bot | mission, staff, temporary bots, board | mission and memory; staff; **Sub-sessions**; the **board** (items with owner, links, version; the plan note); **Pages** (Library: title, updated); the timer with its end; **Make primary** |
| Sub-session list in details | Tasks: Mark done, Stop, Keep | rows grouped *Needs you* / *Working* / *Idle* / *Ended* (last 10): name, state, "idle 3 h", the current step or last work line, the last result line, session id; actions **Open** and **Stop**. No Mark done, no Keep |
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
| `timeline.page.updated` | Updated by {name} {time} | {name} 于 {time} 更新 |
| `timeline.page.open` | Open page | 打开页面 |
| `timeline.bots.messagesWith` | {count} messages with {names} | 与 {names} 的 {count} 条消息 |
| `timeline.bots.messageFrom` | Message from {name} | 来自 {name} 的消息 |
| `details.pages` | Pages | 页面 |
| `details.pageUpdated` | Updated {time} | 更新于 {time} |
| `chats.primary` | Primary | 主 |
| `details.makePrimary` | Make primary | 设为主机器人 |
| `details.primaryRefused` | Only a bot that reports to you can be primary. | 只有直接向你汇报的机器人才能设为主机器人。 |
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
- **Ledgers survive.** The new item fields are optional and `assignee` only widens, so a bot's board and plan note validate unchanged; an item that
  named a dropped temporary bot shows "bot gone" as any unknown assignee does.
- `BotRecord.lifetime` is removed and `primary` added (optional): a record that still carries `lifetime` does not validate and is re-read from its group
  view as bot records already are on first read; no primary exists until the person marks one.
- Chains kept in state (7 days) that name dropped temporary bots resolve to "bot gone" in the audit.
- Controller: worker seats of old tasks are not in the Relay's poll, so the existing missing-seat rule forgets them after 10 minutes and releases their
  runtimes. Old Controllers fail the capability check with "Update the Controller to use bots" (the host capability marker is bumped; the owner updates
  every Controller).

Because of the 2026-11-25 incident (Cloudflare state load, 30 min of 503), step 7 adds a test that loads a state written by the current Worker
(tasks, a temporary bot id as assignee, `lifetime` records, a board) into the Cloudflare SQLite store conformance run, following
`agent-relay-cloudflare/test/storage-previous-worker-state.test.ts`, and into the node store, before any deploy.

## 11. Steps (each is a commit that builds and tests green; none pushes)

The owner's answers (1b) are taken. Implementation evolves the existing task record in place into the sub-session (the Team still carries it in its
`task` field internally; the rename is the last mechanical commit of step 7) so every commit stays green without a parallel path.

**Step 0. Start.** Branch `feat/sub-sessions` from main with the plan commits, `pnpm task:start`.

**Step 1. Design text.** Amend `bots-design.md`: 2.1 (no `lifetime`, `primary`), 2.2, 2.4, 2.5 (span counts bots), 5.1 (tool table, instructions), 6.1 (ledger
owners, writers, tags, notes, pages), 6.2 (timer end, roster), 9 (Tasks, Side rows), 10 (page card, folding, primary), 12, 13 (decisions of 2026-11-27).
Pointers from plans 8a, 9a, 9d and 10. No code.

**Step 2. Protocol and contracts.** Sub-session record and frames (`task.ts`), host calls (`create_sub_session`, `send_to_sub_session`,
`get_sub_session_status`, `stop_sub_session`, `sub_update`, `sub_turn_end`, `sub_told`, `write_page`, `read_page`, `set_primary`), `TeamAction.stop_sub_session`,
`SubSessionId` owners, pages, `BotRecord.primary`, `set_timer` `until_minutes`, instructions v12.
Fixtures `sub-session.v1.json`, `board.v1.json` (new fields), `bot-messages.v1.json`, `page.v1.json`. Compatibility metadata is not updated on the task
branch (AGENTS). Tests: protocol units, including that v12 no longer forbids a bot's own subagents, names sub-sessions for handed-off, long, reused or
person-visible work, carries the primary section only for the primary bot, and names the version.

**Step 3. Relay.** `SubSessions` (create, send with delivery and title, status, stop, results from `sub_turn_end`/`sub_update`, the limit with roster,
end on retire, `/side` start, chain counter, audit stop), the ledger rules of 4.3 (a sub-session writes the items it owns; person any; Agree person-only), pages (`write_page`/`read_page`, bounds, in-place version), `set_primary` (at most one,
chief-is-person), timer `until_minutes` and the roster in its frame. Integration with the real Team broker and in-memory store; the host broker settling a
claimed work input and validating the team (the 2026-11-25 N-7 class of bug).

**Step 4. Controller.** `sub-session-roles.ts`, the sub-session tool namespace (`communicate_update`, `read_main_session`, board), the new bot tools (the four sub-session tools and the two page tools),
the seat lifecycle (held while live; forgotten on ended and settled), `sub_turn_end`/`sub_update`/`sub_told`, chain approvals on sub-session turns, the
primary section of instructions, no standing instructions for a sub-session. Measure the memory and process cost of a held idle lease per provider.

**Step 5. Page.** Sub-sessions list and cards, `SideCards` on the new result, page cards (in place) and Pages in details, the board's owner display, folding lines, Make primary and the Primary mark, locale files in both languages, `--orchard-*` tokens in the lines touched.

**Step 6. Behaviour scenarios and instructions.** Rewrite `scripts/bots-scenarios.mjs` and run v12 with real Claude Code and Codex.

**Step 7. Removal and rename.** Delete the old path (`tasks.ts` task semantics, `create_task` family, `side_final`, `keep`, `manageStaff`, `temporaryBotId`,
the temporary branch of `create_bot`, `stop_bot`, `retire_bot`, `BotRecord.lifetime`, `BotListing.kind`, `ChainView.kinds`, `TasksList`, task cards and
keys, `task-roles.ts`), rename internals (`task` → `sub`) mechanically, delete or rewrite the tests of section 2 under the mutation-check rule, add the
old-state load tests (section 10), lower `architecture/exceptions.json`, `pnpm arch:check`.

**Step 8. Flows, live check, as built.** Section 12; "As built" in the design and this plan; then the full gate once. After the merge into `main`:
`pnpm postmerge`; push only when the owner asks.

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
| (new) | **Ledger:** a bot assigns an item to its sub-session; the sub-session changes the status of its own item and is refused on another; the bot's and its sub-session's stale writes return `conflicts`; the person changes any item; an Agree-gated status is refused for everyone but the person; a staff bot changes the status of an item its chief handed it |
| (new) | **Page card:** a tracker bot reads the members' ledgers and writes a page; the card appears in the chief's conversation and updates in place on a rewrite (no new entry); another bot's write to that page is refused; everyone reads it |
| (new) | **Recruit and fold:** a bot recruits another; the recruit reports in (its own conversation shows it, the chief gets the reply); six bot messages in the chief's conversation fold to "6 messages with 4 bots" and expand |
| (new) | **Primary bot:** the person marks a bot primary from the page; a second mark replaces it; a staff bot is refused; the app opens on its conversation; its instructions arrive as a new v12 message; with its timer it checks in |
| (new) | **Its bot retires:** its live sub-sessions end |
| (new) | **Timer with an end:** `set_timer` with `until_minutes` wakes the bot, whose frame lists the roster; after the end no more wakes; a bot with no open items and no timer gets no turn |
| E15b | Unchanged |

### 12.3 `scripts/bots-scenarios.mjs` (real Claude Code and Codex, by hand or nightly)

`temporary` becomes `subsession`: the bot splits a request over two sub-sessions (files alpha and beta as today); then a follow-up
that only the first sub-session can do from what it already knows (a codeword given in its first brief), proving context reuse by the file
it writes; then the bot ends both. `board` uses a sub-session for its item. Facts the checks read: sub-session records, `lastResult`,
count of live sessions, native session ids unchanged across the two dispatches, the bot's turn count per result (no extra turn from
review), tool calls per bot turn, and that the bot never used `message` toward a sub-session. Scenarios `team` (a primary bot recruits a tracker and a worker bot; each runs sub-sessions; the tracker writes the team page from the ledgers; the primary sums up, with its tokens per person turn recorded). A scenario for fork and timers: a chief forks a sub-session from its conversation and the sub-session answers from the seeded turns. A new scenario, `release`, gives the bot
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
7. The person marks a bot primary; it recruits a staff bot, which reports in; a tracker writes a team page and its card updates in place in the chief's conversation; the chief opens a sub-session, sends it more work, reads its status and stops it. Screenshots, desktop and phone width.
8. Measure and record: Host memory and CPU with three idle held sub-sessions; its bot's context growth per result frame.

## 13. Risks

- **Held idle leases.** If a CLI keeps a process per lease, eight idle sub-sessions per bot may be heavy. Step 4 measures; the fallback (release at idle,
  re-acquire on dispatch or open) does not change the Relay side.
- **Weak results.** A model that ends its turn with an empty or noisy summary gives its bot a weak result; the instruction says what to lead with and
  `read_bot` reads the rest.
- **Pages grow state.** Ten pages of 8000 characters per bot sit in the Relay's Team records; bounds are enforced and the record-size test covers a bot
  with a full page set.
- **Grok evidence is shapes, a screenshot and docs.** Prompts, enum values and per-role permissions are not available; behaviour that depends on them is
  chosen here and checked by the scenarios.
- **Ledger conflicts.** A bot and its sub-sessions race on one ledger; versioning reports and notifies but never refuses.
- **No bot tools for the sub-session.** It cannot call for help; its bot does that. This is the price of "not a bot".

## 14. Remaining gaps, with a recommendation

1. **Who may be primary.** Only a bot whose chief is the person (Grok: a Team Bot cannot be). As built.
2. **Who writes the team page.** The chief, or a bot that can read the boards it needs; the chief reads staff boards as today and may pass the data. The
   owner may later widen board reading to the whole group.
3. **A staff bot changing the status of an item on its chief's board** is not built; it reports by message.
4. **Page card placement.** The writing bot's conversation and its chief's. The owner may prefer an explicit pin.
5. **`/side` seed size** (taste), **live limit 8** (a number).

### Removed from earlier drafts

Tags and notes on items; custom statuses; string-replacement plan edits; the shared team board and nested team boards; `members` and the same-chief
ledger read; renamed conflict results; `read_bot` `mode`/`max_turns`; a goal concept; a main bot above project bots. Kept from today without change: the
board, `create_bot` and its report-in, the chief reading staff boards, answer sessions for mentions, memory, folded bot messages, the timer.

## 15. The owner's answers, and where Grok still differs from an earlier decision

| # | Grok does | Earlier decision | Answer |
|---|---|---|---|
| 1 | A primary Bot, at most one, picked by the person | No kinds of bots | **Decided:** `primary` flag, set from the page |
| 2 | A Bot's tasks owned by itself or its sessions | Boards per bot (design 6.1) | **Decided:** per-bot ledger with sub-session owners |
| 3 | A tracker is a page; only its Bot edits | Shared structured board per team | **Decided:** pages; no shared board, no nested boards |
| 4 | Workers are hidden work sessions | Temporary bots were bots | **Decided:** sub-sessions replace them |
| 5 | Periodic wake-ups | No extra turns for review | **Decided:** optional timer with an end |
| 6 | `fork_from`/`fork_turns` | Small contexts | **Decided:** sub-sessions only, `fork_turns` required |
| 7 | In-turn subagents are the CLI's | "Never your own subagents" | **Decided:** allowed, nothing built; instruction dropped |
| 8 | `send_to_agent` has no length bound | 300-character bot messages | `message` stays at 300; a sub-session dispatch takes 8000 |
| 9 | `delivery` | Nothing a bot sends steers | `queue | interrupt` only |
| 10 | Custom statuses; string-replacement plans | Five statuses; plan note | Not adopted |
| 11 | Separate transcript, goal, project tools | Complexity watched | Not adopted; `read_bot` takes `mode`/`max_turns`; a goal is a ledger item |

