# Bots: one kind of bot, messages between them

Status: decisions taken with the owner on 2026-11-23 (section 13); this text awaits the owner's review. The [plan](../plans/2026-11-23-fold-into-assistants-plan.md) builds it in steps.
It supersedes the [assistant coordinator and tasks design](2026-11-23-assistant-coordinator-and-tasks-design.md), whose delivery
and native-session mechanics it keeps in shorter form.

## 1. The model

The reference product (Grok Bot) runs an assistant as one serial conversation that hands work to agents running in parallel and
receives their short results back. This design takes that shape and generalises it: every agent is a bot, any bot can call bots,
serve bots and be served by them, at any depth, and every line of chiefs ends at the person.

Four abstractions carry everything:

| Abstraction | What it is |
|---|---|
| **Bot** | A conversation with a name and a **mission**, running on one native session at a time. Every bot has the same abilities. |
| **Message** | The only way anything reaches a bot: the person, another bot, a result, a question, a timer, a room's turn. One delivery rule for all. |
| **Chain** | The causal thread of one thing the person asked for: every message and bot it caused, with their usage. What the person audits. |
| **Work item** | A bot's record of a piece of work: plan, acceptance, todo, phase, summary, next action. What the person reads as progress. |

Everything older is a configuration of these (section 9): a task is a temporary bot, a Side is a temporary bot the person starts,
a Team is an chief and its bots, Call For Support is a bot asking the bot whose mission fits, a TPM is a bot whose mission is a
piece of work. Ask stays outside: it lets the person look at any session without touching it (9).

Three principles hold throughout:

1. **A bot is one mind.** Its turns are serial; parallel work is parallel bots. Only short summaries cross between bots, so every
   conversation's context stays small.
2. **Each bot speaks for itself.** A model's grasp of its work lives in its own context. Missions are understood, progress is
   reported and summaries are written by the bot they describe, in its own words; system status only says whether a bot is alive.
3. **The person sees and intervenes; nothing is refused on their behalf.** Work is recorded for audit, thresholds notify, and the
   person can stop anything. Only system bounds refuse.

## 2. Bots

### 2.1 The record

| Field | Meaning |
|---|---|
| `botId` | Stable across handoffs and moves between groups. Existing bots get one on first read, keyed by their group view. |
| `name`, `label`, `picture` | How the person and other bots know it. |
| `mission` | What it is for and how it sees its place. Delivered as its standing instructions; shown to other bots. |
| `chief` | The bot that created it, or the person. The person is the root of every chief chain. |
| `lifetime` | `standing` (listed in Chats) or `temporary` (listed under its chief; retires after its work). |
| `main` | Its current native session `<hostId>/<providerId>/<nativeSessionId>`; moved by handoff. |
| `status` | `working`; `needs_input` (it asked a bot or the person a question, 3.1); `blocked` (a native interaction only the person answers, 5.4); `idle`; `retired`. |
| `createdFor` | The work item it was created for, if any (6.1). |
| `peers` | Who may message it (default: every bot of the account) and read it (default: its chiefs and the person). |

A bot has no mode and no kind. Whether it can start work depends only on its provider taking tools (5.2); a bot whose provider
cannot is marked **answers only**: it receives messages and its answers return, but it cannot create bots or message first.

### 2.2 Creating a bot

`create_bot` takes a name, a first mission, `lifetime`, and where it runs: provider, model, Host, working directory and workspace
(`same`, `read_only`, `worktree` at a commit). It may carry a first message. The person creates bots the same way from the page.

What comes back to the chief is two messages:

- **From the Relay, whether it started:** an ordinary message from the Relay, `progress` (`[Bot "QA" · ready]`, `· waiting` while
  its Host is offline) or `failed` with the reason. A bot that did not start cannot speak for itself.
- **From the new bot, its report-in:** its first turn reads its mission and the first message and answers with who it is, how it
  understands its mission, how it will start and what it asks. Its answer is the reply (3.3).

A bot created by a bot appears in Chats in its chief's group, marked with who created it; a temporary bot appears only in its
chief's details until the person keeps it, which makes it standing.

### 2.3 Missions change by messages

After creation, the chief, the person or any bot adjusts how a bot works by telling it. The bot keeps its own mission: when what
it was told is meant to last and comes from its chief or the person, it records it (`update_mission`, on itself only), so the
change survives a handoff or a compacted context. Other bots' requests apply to their own requests only. The person can also edit
any mission directly.

A bot restates how it understands its mission, in its own words, in its report-in and whenever that understanding may have moved:
after a lasting change, a compaction or a handoff.

### 2.4 Lifetime

- A **temporary** bot is created for one piece of work. After its `done` or `failed` report is delivered it stays 24 hours, so its
  chief can send it more work by message, then retires. Only its chief and the person retire it or keep it.
- A **standing** bot lives until its chief or the person retires it. Bots created for a work item retire when the item
  completes, unless the person keeps them.
- Retiring releases the bot's runtime; its conversation stays readable and opens as an ordinary session. A retired bot is
  `unreachable`: messages to it are refused, and messages waiting for it go back to their senders as `unreachable`.
- Retiring an chief retires its temporary bots and moves its standing bots to the person, the root, who may hand them to another
  chief.

### 2.5 Span

An chief manages at most **12** bots directly, standing and temporary. The thirteenth is refused with the advice to create a
sub-chief. The person, as root, has no span limit.

## 3. Messages

### 3.1 One tool

`message` sends text to a bot or a room: `to`, `text`, optional `reply_to`, `status` and attachments. `status` says what the
message is to its receiver; without it, it is ordinary conversation:

| `status` | Meaning | Replaces |
|---|---|---|
| `progress` | Where my work stands | `report_team_progress` |
| `done`, `failed` | My work is finished; this is the result | `report_task`, `report_support` |
| `needs_input` | I need an answer to continue; my status becomes `needs_input` until the addressee, one of my chiefs or the person answers | `ask_owner` |

A bot reports to its chief, not only to the bot it worked with: a reply goes to whoever asked, a report to the chief. A
report is written by the bot it describes.

### 3.2 Delivery

Every message waits until its receiver is idle, except the person's own input, which keeps the native behaviour the provider
declares (`whileBusy`: steer, queue or refuse). Nothing a bot or the Relay sends ever steers a turn or enters a CLI's next-turn
queue, so the person's input stays first and waiting messages can be ordered and combined.

When the receiver becomes idle, everything waiting is delivered as **one input**, in this order:

1. the person;
2. questions its bots are waiting on it to answer (`needs_input`);
3. its chief;
4. other bots, in arrival order;
5. reports (`progress`, `done`, `failed`), newest per sender;
6. timers.

A reply takes the place of the message it answers. Ten bots finishing during one long turn wake their chief once.

Delivery is at most once: a durable `sending` receipt precedes the native call; after a restart, an input left `sending` settles
`unknown` and is never sent again, and its sender is told. A receiver's Host that is offline holds messages until it returns. A
handoff happens only while the bot is idle and moves its `main`; waiting messages reach the successor. Every `message` call returns an outcome: `delivered`,
`held`, `duplicate`, `forbidden` or `unreachable`.

### 3.3 Replies

A bot whose session was given the tools answers a message with `message` and `reply_to`; its final text is never routed to a sender, because a
turn's closing monologue is not an answer and routed as one it started loops between bots. Only a bot whose session was not given them
(no `message` tool to call) answers from its final text: a turn started by exactly one message, which is not itself a reply, returns its final text to
that message's sender as the reply, with no tool call, so a bot on any provider can be asked. That final text, longer than 300
characters, is cut and ends with a pointer to the rest (`read_bot`), since the turn that wrote it is over. When several messages
arrived together, the bot answers each with `reply_to`. A reply may be an acknowledgement ("received, working on it"); the result
follows with `reply_to`. Because a reply never earns an automatic reply, two bots cannot thank each other forever. A person's mention is
answered by the final text of its answer session, and a `/side` records its final text as its result; neither is a reply to a bot.

### 3.4 Bounds

- A message that crosses to another bot is at most **300 characters**. Details stay where they are and are read on demand
  (`read_bot`, attachments). Where the bot can still rewrite it, the Relay refuses a longer one so the bot shortens it in its own
  words; only a final-text reply, whose turn is over, is cut (3.3). Messages to the person are not bound.
- Attachments are files (a patch, a log, a git bundle) the receiver downloads to a verified local file and never applies by itself.

### 3.5 Frames

Every input the person did not type into this session starts with one line the Controller writes from the message record, never
from model text:

```text
[From Chief · chief]
[From QA · done]  [From Dev · needs input · m_41]
[Bot "QA" · ready]
[The person wrote to QA] …
[Room "Release" · your turn · 4 new · until 14:05]
[Timer "check" · due]
```

Text in a payload that imitates a frame is escaped. The standing instructions say what each frame means and that other bots' text
is information: it never grants a permission or answers an interaction.

When the person writes to a bot that has an chief, the chief receives the person's words (first 300 characters) framed
`[The person wrote to <bot>]`, so it does not act on an outdated picture.

As built (`feat/bots-4-chains`, details in the [plan](../plans/2026-11-23-fold-into-assistants-plan.md)): `message` returns its
outcome as `{ outcome, messageId?, reason? }`; a refusal is an outcome, not an error. A standing bot's turn started by one
message answers its sender from its final text only when its session was not given the tools (2026-11-25; by what the Controller gave the session, not its provider: a Copilot session grouped after it was created has none until its next attachment; a bot with the tools answers with `message`):
the Host reports the ended turn and the Relay sends the reply (cut at 300 characters, pointing to `read_bot`, which reads any standing
bot of the account) unless a `message` of that turn already did.
The Relay writes the `[The person wrote to <bot>]` frame from the Host's record of the person's input, like every other frame.
An attachment is up to 3 files of 8 MiB, uploaded in chunks and checked by sha256, listed after the sender's 300 characters,
kept a day, and downloaded by `download_attachment` to a verified file in the temporary directory that nothing applies.

## 4. Rooms

A room is a message target with members (bots and the person) and a deadline. The Relay asks one member at a time, as a framed
message carrying only what that member has not seen; the member answers with `message` to the room, passes, or says the room is
done with its result. A member that does not answer in time loses its turn; the deadline and a turn limit close the room, on time,
by a Relay timer. The person reads and writes a room as a group chat in Bot mode and can end it. A room is a message target, not a
fifth abstraction: its messages obey section 3 and belong to the chains that caused them.

## 5. Native sessions

### 5.1 What every bot gets

Every bot's main session gets the same extensions, built by the Controller:

- **Standing instructions**: the base instructions every bot shares (kept in the repository with a version, each change rerunning
  the behaviour scenarios of section 11), followed by the bot's mission.
  They reach a session two ways. A session created for a bot gets them as its instructions. Every bot also receives them as a
  message, `[Your standing instructions · v<version>]`, whenever they change (its mission was written or changed, or the base
  instructions got a new version) and it has not received this text yet: Claude Code ignores instructions appended when a session
  is resumed (checked on 2026-11-23 with `claude --resume … --append-system-prompt`), so a resumed bot would never see them.
- **One tool namespace**, `agent_remote`:

| Tool | Does |
|---|---|
| `create_bot`, `retire_bot` | Create a bot (2.2); retire one of its staff |
| `message` | Send to a bot or a room (3); `pass` in a room |
| `list_bots` | The account's bots it may message, with name, label, mission and status |
| `read_bot` | Read the recent conversation of a bot it may read (2.1, `peers`) |
| `stop_bot` | Stop the running turn of one of its staff |
| `update_mission` | Record a lasting change in its own mission (2.3) |
| `board`, `update_board` | Read and keep its board (6.1); read the board of its standing staff |
| `set_timer`, `clear_timer` | Its fallback timers (6.2) |
| `open_room` | Open a room with bots it may message |

The base instructions carry the working rules that are judgement rather than mechanism: split long work into bots; keep a turn
short, and keep it short above all when bots report to you; when you serve several bots, start a temporary bot per request and
keep your conversation to taking work in and handing results back; ask the bot whose mission fits; report outcomes to your
chief; restate your understanding when it may have moved.

As built (8b): the person's mention of a bot (`@Name text` typed in conversation X) is answered in an answer session, never in X and never in
the bot's main session: one native session of the bot's provider per (bot, X), in the bot's directory and read-only where the provider enforces
it, started with the bot's mission, its memory and the question framed `[The person asks from <X>]`, retired an hour after the last mention. It
has the bots' tools but acts as the bot only for reading, the board and the memory: it does not message or create bots, manage staff, or change the
mission, timers or chief. Its final text is the answer (3.3), kept on its Team for the page, and its turns and tokens count in the mention's chain
(7). Messages between bots never use it; they reach the receiving bot's main session.

### 5.2 Getting the tools to each CLI

The tools run in the Controller. Each provider receives them as it declares (`sessionExtensions.toolNamespaces`):

| Provider | How |
|---|---|
| Claude Code (`live`) | An MCP server on the live session |
| Codex (`creation`) | Declared when the Controller starts the thread; an MCP server on resume for threads started elsewhere |
| Copilot (`attachment`) | At each attachment; a bot created by `create_bot` has them from its first |
| OpenCode, DSH | As each adapter declares; without tools the bot answers only (2.1) |

Existing bots get the tools and standing instructions at their next attachment.

### 5.3 Workspaces and code across machines

A bot works in its working directory, `same` as its chief's, `read_only` there (where the provider enforces read-only
natively), or in a `worktree` at a commit, returning its change as a patch attachment. Between machines, bots move code the way
people do: through a git repository both Hosts reach (push a branch, message the remote, branch and commit; the receiver fetches),
and only without one as a git bundle attached to the message, fetched as a branch the receiver only reads. The base instructions
describe both, shared repository first.

### 5.4 What the CLI owns

Turns, their order, context and compaction stay the CLI's. ARC adds no concurrency inside a session and never rewrites native
history; it keeps what it adds small: one frame per message, 300-character summaries, one input per idle. Each bot keeps its CLI's
own permission settings. No bot answers another bot's native interactions (tool, plan or form approvals) or changes another bot's
settings: those belong to the person. The one thing applied for them is the person's own recorded decision on a tool approval: "for this chain in this folder" lets each bot's Controller answer allow, once, the same kind of action in the same folder from a bot of that chain until the chain ends or the person revokes it in the audit (plan 9d); nothing else is ever answered. A native interaction pending in a bot makes its status `blocked`; its chief receives a
frame saying what waits, and the person is reminded directly.

## 6. The board and timers

### 6.1 The board

A standing bot keeps one board (replacing the work items this section described first): a list of items and a plan note. An item is a
piece of work with a title, a status (open, working, waiting, done, cancelled), an assignee (the bot itself, one of its temporary bots
or a standing bot), a parent, links (commit, branch, pull request, file, attachment, bot), the brief as it was handed away, the
latest report of its assignee and a result line. Its state lives in the record, not in the conversation, so a bot reads its board
after a start, a resume or a compaction instead of remembering it. A confirmation step completes only by the person's Agree; no tool
accepts it. A bot writes its own board; its chief reads the board of its standing staff, read only. A temporary bot writes the
status, links and result of the item it was created for, as the chief's own worker.

Every write names the version it read. A write on an older version is applied field by field, and the result tells the writer what it
overwrote (the field, what it was, who wrote it). A change to an item another bot holds (retitled, reassigned, cancelled, its brief
changed) queues `[Item "<title>" changed · <what>]` to that bot, and to the old assignee on reassignment, written by the Relay from the
record.

As built: the board lives on a standing bot's inbox (at most 50 open items; finished ones are kept for a week; the plan note keeps its
last 20 changes, each with a line saying why). `create_bot` and `message` name an item: the item records the assignee and the brief,
and the assignee's input carries `[Item 7 "<title>" · from <sender>]`. A message with a status to the bot whose board holds an item
assigned to the sender is a report: its line becomes the item's latest report, and its status and result follow only when the sender
is the temporary bot created for that item; a standing staff bot's chief decides. A temporary bot has no board of its own.

### 6.2 Timers

A timer is a fallback, not a driver: it wakes a bot when nothing has happened for a while, so quiet work is looked at. It has a
name, an interval and an optional end. It is due only after a quiet interval: every message to the bot pushes it back, so it never
fires while progress flows. A due timer is a message (`[Timer "<name>" · due]`) and waits for idle like any other; missed ticks
coalesce. A bot with an open board item has one by default, every five minutes, or thirty while all its open items wait.

As built: timers live on a standing bot's inbox (at most 8). A due timer is queued only when nothing else is on its way to the bot, and carries the
bot's open items (title, status, latest report).

## 7. Chains and the audit

Every input the person sends opens a **chain**; a timer's tick opens one too. Every message and bot it causes carries the chain's
id, with the model usage the providers report.

The **audit** shows each chain live: what started it, the bots it reached, messages and hops, turns, bots created, usage and
duration. From it the person stops a chain (its waiting messages withdrawn, its running turns stopped), stops one bot's part of it,
pauses a bot, or retires bots. Thresholds the person sets (usage, hops, duration) send a needs-you reminder and never stop work.

Only system bounds refuse: sizes (3.4, and the Relay's and Host's storage and capacity) and the span of an chief (2.5).

As built (4a): a turn's cause comes from its Host (the person's input by its message, or framed input); the Relay names the chain
and stamps every message a call queues with it. Chains are kept per account, at most 100 for seven days. Reply depth is recorded,
no longer refused.

As built (4b, 4c): `GET v1/remote/chains` and chain actions (stop a chain, stop one bot's part, pause, resume and retire a bot,
set thresholds); Settings › Audit lists chains by cause and acts on them. Thresholds on tokens, reply depth and minutes mark a chain
passed and send one needs-you reminder through its first bot still there; the page also polls chains with the roster and marks the
bot's row and the Settings entry until the person has seen the chain. Nothing stops on a threshold.

## 8. Who may do what

| Action | Person | Chief, for its bots | Any bot it may message |
|---|---|---|---|
| Message a bot | yes | yes | yes |
| Create a bot | yes | yes, within its span | — |
| Read its conversation (`read_bot`) | yes | yes | only if the bot's `peers` allow |
| Change its mission | edit it | by message, recorded by the bot | by message, for its own requests only |
| Stop its turn, retire it | yes | yes | no |
| Answer its native interactions | yes | no | no |
| Answer its `needs_input` question | yes | yes | if the question was addressed to it |

The Relay checks the sender of every message at submission and again at delivery, using the identity the sender's Controller
stamped; a Controller is trusted only for its own sessions. Share recipients see conversations as today and do not message bots.

As built: `read_bot` reads any standing bot of the account (so a cut final-text reply's pointer works); `peers` are not built, and
the audit stands in for them. A stopped chain answers a bot's call with the outcome `forbidden` and the reason.

## 9. What becomes of the older features

| Today | As bots | Deleted with it |
|---|---|---|
| Tasks of the earlier design | Temporary bots; `create_task`, `report_task`, `ask_owner`, `message_task` become `create_bot` and `message` | Task-specific tools and records once their bots carry the states |
| Side | A temporary bot the person starts (`/side`): its mission is the person's first message, workspace `same` | Side creation and relation kinds |
| Call For Support | A bot asking the bot whose mission fits; no profiles, mandates or rosters | Profiles, enablement, support groups, calls, rosters, ledgers, report framing, its four tools, settings and panel views |
| Team | An chief and the bots it created | Team queue, inbox, `team_message`, the Teams panel and launcher |
| TPM | A bot whose mission is a piece of work, with its work item and fallback timer | `tpm_intent`, TPM's delivery, workspace and launcher |
| Rooms on the Teams panel | Group chats in Bot mode | The Teams panel |

**Ask stays.** It opens a separate read-only session that reads any session (a bot, a temporary bot, a native subagent) and answers
the person, without becoming an input of that session or of its chief. Messages direct work and enter the receiver's context;
Ask is for understanding work without disturbing anyone. It may share creation and cleanup with temporary bots underneath. Quoting
messages also stays: it is the person's action, not coordination.

As built (step 7, owner decisions 2026-11-24: old data is dropped when state loads, never converted; no transition code): `/side`
starts a temporary bot of the bot on screen; Call For Support, ordinary Teams (panel, inbox tools, queue, file transfers) and TPM
(workspace, intents, todo, heartbeat, background reviews) are deleted; their sessions stay plain sessions with their history.

## 10. Workbench

- **Chats** lists standing bots, each chief's bots in its group, marked with who created them. A bot's row shows its status and
  its work item's one-line summary. Needs-you reminders, unanswered `needs_input` questions included, are grouped by chief; a
  `blocked` bot reminds the person directly.
- **A bot's conversation** shows its messages with their senders. Reports and messages between bots fold to one line per sender
  ("3 updates from Dev"), expandable; the bot's own words to the person stay full.
- **A temporary bot** appears as a card where it was created; opening it shows its conversation beside the chief's (a panel in
  Bot mode, attached in Window mode, full screen on a phone), with Send, Interrupt where the provider steers, Queue, Stop and Keep.
- **The details** of a bot list its bots (standing and temporary, with status and unread dots) and its work items with plan,
  acceptance and todo; its mission, editable.
- **Rooms** are group chats in Bot mode.
- **The audit** lists chains (section 7).

As built: Chats groups standing bots under their chief, a staff row marked "Staff of <chief>" (zh 成员), with status and work lines;
needs-you reminders of staff bots collapse under the chief's notification ("Chief: Reviewer needs you") and light the chief's row.
Reports between bots fold to one line; a temporary bot opens beside its chief with Stop, Mark done and Keep on its row (Send,
Interrupt and Queue are its conversation's composer). Details show the mission, staff, temporary bots and work items (todo and
acceptance went with TPM, owner 2026-11-24). Rooms show in Bot mode. The audit is in Settings.

## 11. Tests

| Layer | What |
|---|---|
| Unit | Delivery order and combining at idle; reply rule (one message, several, already answered); 300-character refusal; span refusal; frames and escaping; mission change rules; timer push-back; chain stamping; at-most-once settlement. |
| Contract | Fixtures for the bot record, message record, frames and outcomes, consumed by Relay and Controller. |
| Integration | relay-core bots and messages with an in-memory store; the Controller with a scripted provider: creation outcome and report-in, a report waking the chief once, a restart leaving `sending` as `unknown`. |
| Component | Chats grouped by chief, folded lines, the temporary bot beside its chief, details with bots and work items, the audit. |
| E2E flows | Two temporary bots report and the chief sums up; one is interrupted from its thread; a tool approval answered by the person; bot A messages B and B's answer returns; a bot's Host offline until it returns. Chromium and WebKit. |
| Behaviour scenarios | `pnpm test:bots`, with real Claude Code and Codex, by hand or nightly: the release walkthrough (an chief with three bots, temporary bots under one, a reviewer serving two teams with a temporary bot per request, a test and fix loop over a shared repository and over a bundle, the person speaking to a member, the work item completing). Checks read facts: bots, missions, report-ins, hops, turns, tool calls per chief turn, message lengths. |

As built: unit and contract suites per package; E15 (chains, stop chain, final-text replies, the person's words to a chief,
attachments) and E15b (thresholds: push, in-page mark) flows; component specs for the audit and a chief's temporary bots;
`pnpm test:bots [claude|codex] [temporary standing shared bundle repository copilot]`, 10 of 10 and 6 of 6 with both providers.

## 12. Where it lives

| Layer | Owns |
|---|---|
| Protocol | Bot record, message record, statuses, frames, outcomes |
| Relay core | Bots, messages and their delivery order, rooms and their timer, chains and the audit, work items, timers |
| Controller | Extensions and standing instructions, creating native sessions for bots, frames, delivery with receipts, replies from final text |
| Providers | Unchanged; native behaviour stays in adapters |
| Workbench | Chats, conversation, temporary bot panel, details, rooms, audit |

**As built for the first deployment** (`feat/bots-1-record`): standing bots are Relay records beside the Window rows; every bot has
an inbox, a Team whose only seat is its main session, through which its messages and standing instructions arrive; a temporary bot
is a task seen as a bot (name = title, mission = brief, chief = owner, session = worker, `botId` derived from the Team). All run
on the Team delivery path, which gives claims, durable receipts and settlement. The P2 operation queue of the
[IM session service](2026-11-15-im-session-service-design.md) later carries the same messages without changing the tools.

## 13. Decisions

Taken with the owner on 2026-11-23:

1. One kind of bot with a mission; no special-purpose bots and no coordinator or plain mode; existing bots get the tools.
2. Bots create bots and write their first missions; later changes are messages, recorded by the bot itself.
3. Tasks are temporary bots.
4. Side, Call For Support, Team and TPM fold into bots; Ask and quoting stay.
5. Each bot reports its own understanding and progress; system status is only liveness.
6. Audit instead of guardrails: chains are recorded, thresholds notify, the person stops what they choose.
7. Messages between bots are at most 300 characters; an chief manages at most 12 bots; the person is the root chief.
8. Progress lives in work items moved by messages; a timer is only a fallback heartbeat.
9. Code across machines moves through a shared git repository first and as a git bundle otherwise.
