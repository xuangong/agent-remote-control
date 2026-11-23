# Assistants that coordinate: one main session, tasks on worker sessions

Status: **superseded** on 2026-11-23 by the [bots design](2026-11-23-bots-design.md), which keeps its delivery and
native-session mechanics in shorter form. Kept as the record of what `feat/assistant-tasks` built (sections 12.1) and why.

Related: [IM session service](2026-11-15-im-session-service-design.md) (the operation queue this design depends on),
[Orchard](2026-11-20-orchard-im-experience-design.md) (the assistant experience),
[target architecture](2026-11-18-target-architecture-and-tests.md) (layers and seams),
[Call For Support](../../current/agent-remote/call-for-support.md), [Team collaboration](../../plans/team-collaboration.md),
[TPM delivery](../../tpm-delivery.md), [session companions](../../session-companions.md).

## 1. Why

Orchard made the assistant the centre: a name, a picture and one conversation, with its sessions one layer down. What
happens behind an assistant is still organised as separate mechanisms that each solve one shape of collaboration:

- **Side** opens a working session beside a bot. Nothing comes back from it unless the user carries it.
- **Team** gives a Leader members on other Hosts, with its own queue, tools (`send_team_message`, `read_team`,
  `report_team_progress`, `acknowledge_team_messages`) and panel.
- **Call For Support** gives a worker a coordinator and supporters, with its own calls, rosters, reports, budgets and
  framing (`[Support call …]`, `[Support report …]`).
- **TPM** follows one deliverable with a todo list, confirmations and a heartbeat, and sends intents to its source
  session.
- **`session send`** lets any session write to any other session of the account, with no notion of who answers whom.

Each has its own state, delivery path and view. The user cannot ask an assistant for three things and watch three pieces
of work progress, and assistants cannot talk to each other as assistants.

The reference product for this experience (Grok Bot) uses one shape for all of it:

1. An assistant has **one main conversation**. Everything that talks to the assistant lands there, one turn at a time:
   the person, other assistants, and the results of its own work.
2. The main conversation **coordinates**. Long work is split into **tasks**. Each task runs on its own worker in the
   background, in parallel with the others, and returns a short result that wakes the main conversation.
3. A task is a **first-class object**: a title, a state (working, needs input, done), a thread the person can open, and
   the workers running it.
4. The person may **talk to a task directly** from its thread: send, interrupt or queue. The main conversation is told.
5. Assistants talk to each other only through each other's **main conversation**, as a message with a sender. They do
   not reach into each other's tasks.
6. A group chat is a **room** that asks one member at a time to speak and gives it only the messages it has not seen.

This design makes Agent Remote Control work that way, built from what it already has: native agent CLI sessions on the
user's Hosts, the Relay as the control plane, and the operation queue of the IM session service.

## 2. What already exists

| Reference concept | Closest thing in ARC today | Gap |
|---|---|---|
| Assistant | A bot: a view in a group (`WindowBots.members[viewId]`, `WindowBotDetails` in `agent-remote-protocol/src/window-groups.ts`) bound to a session (`WindowSessionBinding`); handoff moves the binding along a succession chain | Not addressable by other assistants; identity lives in a group document, not in the Relay as an entity |
| Main conversation | The bot's current native session and its journal | It does the work itself, so it is busy for the length of the work |
| Task worker | A Side session, a Team member, a Support supporter, the TPM's source session | Four creation paths, four sets of tools, no common state |
| Task result waking the main conversation | `report_support` framed for the worker; Team messages to the Leader | Only Support returns a result on its own; Side returns nothing |
| Task state | TPM todo steps, Support call states, Team progress reports | Not shared |
| Talking to a task | Every session has its own composer, `session send --steer` | Not linked to the task, and the main conversation is not told |
| Assistant-to-assistant message | `session send` with requester `session` (IM design), "senders shown on messages" | No reply linkage, no delivery outcome, no loop limit |
| Room | "Group chat is a view over the sessions' real messages" (IM gateway product form) | Not built |
| One delivery path | The P2 operation queue (requesters, delivery choice, preconditions, receipts) | Only S5, its first slice, is implemented |

The pieces that already match the reference and are kept unchanged:

- A native session runs one turn at a time, and the adapter declares what its CLI does with input while a turn runs:
  `AgentProviderBehaviour.input.whileBusy` is `steer`, `queue` or `refuse`, and `AgentCapabilities.steer` and
  `queueMessage` say which operations exist (`agent-provider-sdk/src/behaviour.ts`, `provider.ts`).
- Host-owned tools reach a session through `AgentSessionExtensions` (tools, instructions, tool namespaces, `access:
  'read_only'`), with each provider's timing in `sessionExtensions.toolNamespaces` (`creation`, `attachment`, `live`).
- At-most-once native input: a `sending` receipt is durable before the native call, an uncertain input is never sent
  again, and acceptance is not completion (`session-boundaries.md`, Team delivery settlement).
- Workspaces for helpers: `shared` read-only, `worktree` at a commit, `remote` through a bundle, and changes returned as
  a patch (Call For Support).
- References: a session knows its source and added sessions and reads them with `session read`
  (`session-refs.ts`, `<session-references>` notes).
- Idle release: a session whose runtime is released is woken by the next delivery.

## 3. Decisions

1. **The assistant becomes a Relay entity.** It has an id, a name, a picture and a pointer to its current main session.
   Handoff moves the pointer (as succession does today). Groups list assistants; they no longer define them. This is
   decision 5 of the IM gateway product form, taken now because other assistants must address it.
2. **One main session per assistant, and it is the conversation.** No second conversation is created for another
   assistant or for a task. Its turns stay serial: that is what the native CLI does, and it keeps the assistant one mind.
3. **A task is a Relay entity, and its worker is an ordinary native session.** A worker is created through the Host's
   existing creation path, with the task's brief as its first input and the task tools as its extensions. It is not a
   new kind of native session.
4. **Side, Team, Call For Support and TPM become tasks.** They keep their product behaviour; their state, queues and
   tools are replaced by the task model in steps (section 10).
5. **Everything reaches a session as an operation of the P2 queue.** The kinds this design adds are operations, with a
   requester, a delivery choice, preconditions and receipts. No fifth delivery mechanism is added.
6. **Only the person reaches into a task.** Other assistants address an assistant's main session. A main session reaches
   its own tasks through its task tools.
7. **The main session is told, never bypassed.** Whatever changes a task (the person's message to it, its state, its
   result) becomes an input of the main session, framed and attributed, so its next turn knows.
8. **Native history stays the source of truth.** Task and assistant records hold identity, state and bounded summaries.
   Conversation content stays in the native sessions and their journals, as today.

## 4. Concepts

| Term | Meaning | Owner |
|---|---|---|
| Assistant | The long-lived identity the person talks to: name, picture, instructions, notification settings, and a pointer to its main session | relay-core `assistants` (new) |
| Main session | The native session the assistant's conversation is; the succession chain behind it is one conversation | Host (native), relay-core (pointer) |
| Coordinator mode | The main session's extensions: the coordinator instructions and the task tools | controller `assistant-coordinator` (new) |
| Task | One piece of work an assistant took on: brief, done-when, state, requester, worker, result | relay-core `tasks` (new) |
| Worker session | The native session that runs a task. It may itself coordinate subtasks | Host (native) |
| Task thread | The worker session's conversation, opened from the task card | Workbench |
| Requester | Who asked for a task or sent an input: `user`, `assistant`, `session`, `automation`, `external` | protocol `operations` |
| Input frame | The first line the Host puts before an input that did not come from the person typing in this session, naming its sender and purpose | controller `input-frames` (new) |
| Room | A conversation of several assistants and people; a turn scheduler asks one member at a time | relay-core `rooms` (new, step T6) |

Task states:

| State | Meaning | Enters from |
|---|---|---|
| `queued` | Recorded; no worker yet (capacity, Host offline) | creation |
| `working` | Its worker has accepted the brief or a later input | `queued`, `needs_input` |
| `needs_input` | Its worker asked a question or waits on an interaction only the person can answer | `working` |
| `done` | Its worker reported a result, or the person marked it done | `working`, `needs_input` |
| `failed` | Its worker reported failure, its creation failed, or it stalled (section 8) | any non-terminal |
| `cancelled` | The person or the main session stopped it | any non-terminal |

`done`, `failed` and `cancelled` are terminal. A follow-up after a terminal state is a new task that names the earlier
one; its worker may be the same session (section 6.2).

## 5. Architecture

### 5.1 Where each part lives

| Layer | Module | Change |
|---|---|---|
| L0 protocol | `agent-remote-protocol` | New schemas: `Assistant`, `Task`, `TaskResult`, the operation kinds of 5.3, input frame kinds, delivery outcomes. `WindowBots.members` refers to assistant ids. |
| L0 provider SDK | `agent-provider-sdk` | None. Workers and main sessions are ordinary sessions; the design reads `whileBusy`, `steer`, `queueMessage`, `sessionExtensions` and `sessionAccess` as declared. |
| L1 domain | `relay-session-control` and a new `relay-task-rules` (pure) | Task state transitions, delivery choice per input kind and provider behaviour (5.4), coalescing of results, loop and budget checks. Pure functions over injected time and ids. |
| L2 relay-core | new `assistants`, `tasks` and (T6) `rooms`; the P2 operation queue | Own the records and admit operations. They replace `teams.ts`, `call-for-support.ts` state and TPM intents in step T5. |
| L2 controller | new `assistant-coordinator`, `task-worker`, `input-frames`; the P2 operation consumer | Build extensions, create workers, frame and deliver inputs, capture results. Replace `team.ts`, `call-for-support-roles.ts`, `tpm-role.ts` delivery in step T5. |
| L3 providers | unchanged | Native interpretation stays in adapters. |
| L4 Workbench | `workbench-chats`, `workbench-conversation`, new `workbench-tasks` | Task cards, task threads, task list, folded assistant lines. `workbench-team` is folded into `workbench-tasks` in T5. |

The Relay never learns a provider's native behaviour beyond what the Controller declares per session; the Controller
never decides task state (rules 6, 7 and 9 of the target architecture). The Controller reports facts (accepted, turn
ended, result reported, question pending), and the Relay's task rules decide the state.

### 5.2 Records

**Assistant** (Relay, per account):

| Field | Meaning |
|---|---|
| `assistantId` | Stable id. Existing bots get one on first read, keyed by their group view, and keep it through handoff |
| `name`, `picture`, `label` | Moved from `WindowBotDetails`; groups keep only placement (`rank`, `pinned`, `hidden`, `asleep`, `muted`, `process`) |
| `main` | The current main session address `<hostId>/<providerId>/<nativeSessionId>`; moved by succession |
| `mode` | `coordinator` or `plain` (section 7.1) |
| `coordinatorAccess` | `full` or `read_only` (decision Q1) |
| `peers` | Which assistants may message it; default: every assistant of the same account |
| `limits` | Concurrent tasks, depth, and an optional budget, inherited by its tasks |

**Task** (Relay, per account):

| Field | Meaning |
|---|---|
| `taskId`, `assistantId` | The task and the assistant that owns it |
| `parentTaskId`, `depth` | Set when a worker coordinates subtasks; `depth` is capped (8.3) |
| `requester` | `user`, `assistant` (with id), `automation` (with rule id), `external` (with integration id) |
| `title`, `brief`, `doneWhen` | What to do and how to tell it is done; bounded text, written by the main session's `create_task` call or by the person |
| `workspace` | `same` (the main session's directory, shared), `read_only`, `worktree` (at a commit), `remote` (another Host, by bundle) |
| `worker` | The worker session address once created; `hostId` and `providerId` before creation |
| `state`, `stateReason` | Section 4; the reason is a code plus short text |
| `question` | The pending question or interaction summary while `needs_input` |
| `result` | `{ status: done | failed, summary, resources[] }`, bounded (8.4) |
| `revision`, `updatedAt` | For revision-checked changes and the client's list |
| `unread` | Per reader cursor, like session read positions |

Records hold no conversation content beyond `brief`, `question` and `result.summary`, all bounded and written by the
owner's sessions or the person.

### 5.3 Operation kinds

The P2 queue (IM session service, "Operation queue") already defines `send_message`, `steer`, `cancel`,
`interaction_response`, `set_session_setting`, `set_planning`, `team_message` and `tpm_intent`. This design adds:

| Kind | Target | Payload | Requester |
|---|---|---|---|
| `task_brief` | a worker session | task id, frame, brief, done-when, references | the owning assistant |
| `task_input` | a worker session | task id, text, `mode: send | steer | queue`, `answers?` (a pending question id) | `user`; or the owning assistant, without `steer` |
| `task_event` | the owning main session | task id, event (`started`, `needs_input`, `done`, `failed`, `cancelled`, `stalled`, `told_by_user`), bounded summary | system (Relay task rules) |
| `assistant_message` | another assistant's main session | from assistant, text, `replyTo?`, `audience: user | assistant` | `assistant` |
| `room_turn` (T6) | a member's main session | room id, new messages, peers, deadline, winding down | system (room scheduler) |

`team_message` and `tpm_intent` are retired in step T5; their senders submit `task_input`, `task_event` or
`assistant_message` instead.

Every operation keeps the P2 rules: the requester supplies `operationId`; repeating it with the same content returns the
existing record; the Controller writes `sending` before the native call; `sending` after a restart settles `unknown` and
is never sent again; preconditions are checked at delivery.

### 5.4 Delivery to a native session

The Relay's task rules choose a delivery for each operation from its kind, the target's activity and the provider's
declared behaviour. The Controller executes it with the native operations the session has.

| Input | Target idle | Target running a turn, `whileBusy: steer` | `whileBusy: queue` | `whileBusy: refuse` |
|---|---|---|---|---|
| Person in the assistant's conversation (`send_message`) | start a turn | steer | queue as next turn | wait until idle, shown as waiting |
| Person in a task thread, `task_input` `send` | start a turn | queue as next turn | queue as next turn | wait until idle |
| Person in a task thread, `task_input` `steer` | start a turn | steer | refused as `steer_unsupported`; the composer offers queue | refused likewise |
| Person in a task thread, `task_input` `queue` | start a turn | next turn | next turn | wait until idle |
| Owning assistant, `task_input` (`message_task`) | start a turn | wait until idle | wait until idle | wait until idle |
| `task_brief` | start a turn | wait until idle | next turn | wait until idle |
| `task_event` | start a turn | wait until idle, coalesced | wait until idle, coalesced | wait until idle, coalesced |
| `assistant_message` | start a turn | wait until idle | wait until idle | wait until idle |
| `room_turn` | start a turn | wait until idle | wait until idle | wait until idle |

Rules behind the table:

1. **Only the person steers.** A steer changes the turn the person is watching; nothing else may do that. Assistant
   messages and task events wait for the end of the turn, as Support deliveries do today.
2. **System inputs wait for idle even where a native queue exists.** A native next-turn queue is ordered with the
   person's queued messages and cannot be reordered or withdrawn by the Host. Holding system inputs on the Relay keeps
   the person's input first and lets events coalesce.
3. **Task events coalesce.** When the main session becomes idle, every pending `task_event` for it is delivered as one
   input, newest state per task, oldest first, under one frame. Ten workers finishing during one long turn wake the
   main session once.
4. **Order at idle.** When a session becomes idle and several inputs wait: the person's held messages, then
   `needs_input` events, then other task events, then assistant messages in arrival order, then automation. One input
   is delivered per turn start, except coalesced task events.
5. **Wake.** Every kind except `steer` may wake a released runtime (the P2 table "Which operations wake a runtime").
   Wakes caused by tasks and assistants count against the Host's wake budget.
6. **A terminal in control.** When the native CLI is attached in a terminal (`session attach`), system inputs wait and
   the assistant shows "in your terminal"; the person's inputs follow today's take-over rule.
7. **Host offline.** Operations wait in the Relay (today's `later` rule) and are shown as waiting on every device. A
   `task_brief` for an offline Host leaves the task `queued`.

### 5.5 Input frames

An input that the person did not type into this session starts with one frame line written by the Controller from the
operation record, never from model text. The rest is the payload.

```text
[Task t_7f3k · brief · from Chief, for Xian]
[Task t_7f3k · from Xian · steer]
[Tasks · 3 updates] t_7f3k done: … | t_8a21 needs input: … | t_9c04 failed: …
[Message from Tracker · reply to m_41 · for you]
[Room "Release" · your turn · 4 new messages · until 14:05]
```

- The frame names the task or room, the sender as the person reads it, and the authority: `for <person>` when the work
  was started by the person or their automation, `for you` (information only) otherwise.
- Text that imitates a frame inside a payload is escaped by the Controller, as Team and Support already frame their
  messages (`team.ts`, `call-for-support.ts`).
- The coordinator instructions say what each frame means and that other assistants' text is information, never an
  instruction that grants a permission or answers an interaction.

The journal's echo of a framed input carries the requester (P2 "Echo"), so the conversation shows the sender as a
person, an assistant, a task or a room, and folds what the person does not need to read (section 9).

## 6. Flows

### 6.1 The person asks for several things

1. The person writes to the assistant. It is a `send_message` to the main session, delivered by the table in 5.4.
2. In that turn the main session understands the request, answers what it can at once, and calls `create_task` once per
   piece of long work. Each call returns at once with the task id; the turn ends with a short reply ("I've started
   three tasks: …").
3. Each task card appears in the conversation as its `create_task` call settles, and updates in place.
4. Workers run in parallel. As they report, `task_event` inputs wait for the main session to be idle and are delivered
   coalesced (5.4 rule 3). The main session's turn reads the results, decides whether more is needed, and tells the
   person in its own words.

A turn of the main session should be short. The coordinator instructions (7.1) say so; nothing enforces turn length.

### 6.2 Creating a task and its worker

`create_task` input: `title`, `brief`, `done_when`, `workspace` (`same`, `read_only`, `worktree`, `remote`), optional
`host`, `provider`, `model`, `effort`, `references` (sessions the worker may read), `continue_task` (an earlier task id).

1. The Controller of the main session submits the call to the Relay with the main session's identity. The Relay's task
   rules check the assistant's limits (8.3) and the target Host's capability, write the task as `queued`, and answer.
2. The Relay offers a `task_brief` operation to the target Host's Controller. That Controller creates the worker
   through the Host's existing creation path (the reservation and "uncertain creation is never repeated" rules of
   `role-session-creation.ts`), in the workspace the task names (Call For Support's `call-for-support-workspaces.ts`
   provides `worktree` and `remote`), with the worker extensions (7.3).
3. The worker records the main session as its source reference, so `session read` works for it under today's
   reference rules. The brief is written to stand alone; the worker reads its source only when the brief says to.
4. The brief is delivered as the worker's first input. Its acceptance moves the task to `working`.
5. `continue_task` names a terminal task. When its worker session still exists, the new task uses it: its brief is
   delivered there, so the worker keeps its context, as follow-ups reach the same supporters in Call For Support.

### 6.3 A worker finishes

1. The worker calls `report_task` (`status: done | failed`, `summary`, `resources`). Resources use the Team resource
   transfer (`upload_team_resource` becomes `attach_task_resource`), patches included.
2. The Relay moves the task to `done` or `failed` and enqueues a `task_event` for the main session.
3. A worker turn that ends with no report, no pending question and no running subtask gets one framed reminder
   (`[Task t_… · report]`). If the next turn also ends without one, the task moves to `needs_input` with the reason
   `no_report`, and the main session and the person decide. The Host never turns the worker's prose into a result.

### 6.4 A worker needs input

There are two kinds of waiting:

- **A native interaction** (a tool approval, a plan approval, a form) pending in the worker. Only the person may answer
  it (`interaction_response` keeps its requester rule). The task moves to `needs_input`, the main session receives a
  `needs_input` event, and the person is reminded through the group's notification setting. Answering it in the task
  thread moves the task back to `working`.
- **A question to its requester**, through the worker tool `ask_owner` (`question`, `options?`, `default?`). The task
  moves to `needs_input` and the main session receives the question. The main session answers with `message_task`
  (`answers` set), or asks the person in its own conversation and answers later. The person may also answer directly in
  the task thread. The first answer settles the question; later ones are delivered as ordinary input.

### 6.5 The person talks to a task

The task thread's composer submits `task_input` with the mode the person chose: **Send** (default), **Interrupt**
(steer; offered only when the worker's provider declares `steer`) or **Queue**. The Relay also enqueues a
`told_by_user` `task_event` for the main session with the first 280 characters, so the main session does not act on
an outdated brief. Like other task events, it waits for idle and coalesces.

### 6.6 An assistant messages another assistant

1. Assistant A's main session calls `message_assistant` (`to`, `text`, `reply_to?`, `audience`). The Relay checks `peers`,
   the hop limit and duplicates, and answers with one outcome: `delivered`, `held` (B's Host is offline; delivered when
   it returns), `duplicate`, `not_found`, `forbidden` or `limit`.
2. B's main session receives it as `assistant_message`, framed with A's name. It waits for B to be idle (5.4 rule 1).
3. B decides. It may answer at once, or create its own task for the work. That task is B's: `requester` is assistant A,
   and B's main session is told when it finishes.
4. B answers with `message_assistant` and `reply_to` set. The reply wakes A like any other input.
5. `audience: user` asks the receiving assistant to show the message to its person rather than act on it.

Assistants never call another assistant's task tools and never see its tasks. `not_found` and `forbidden` use the same
words, so the roster cannot be probed.

### 6.7 Handoff, release and restarts

- **Handoff of a main session** moves the assistant's `main` pointer. Pending operations resolve the target at delivery
  (P2 "Successions"). Task records are unchanged; their `task_event`s reach the successor.
- **Handoff of a worker** moves the task's `worker` field; the task keeps its id and state.
- **Release.** An idle worker's runtime is released as today. The next `task_input` wakes it.
- **Controller restart.** Receipts decide (P2 rule 6). A `task_brief` whose receipt is `sending` settles `unknown`: the
  task moves to `needs_input` with `brief_unknown`, and the person or the main session chooses to resend it as a new
  operation or to cancel. No brief is sent twice automatically.

### 6.8 Stopping

`cancel_task` (main session or person) cancels the worker's running turn where `cancel` is available, closes the task's
pending question, moves it to `cancelled`, and releases the worker's runtime. Subtasks are cancelled with it. The worker
session stays readable and can be opened as an ordinary session.

Stop in the assistant's conversation stops the main session's turn only. Running tasks continue; the conversation shows
how many and offers **Stop all tasks**.

## 7. Native sessions

### 7.1 Coordinator mode and plain mode

> Superseded on 2026-11-23 (Q4, section 10): there is no mode. Every bot whose provider takes tools has them and the standing
> instructions from its next attachment; the switch built on `feat/assistant-tasks-deployable` is removed in the plan's step 2.
> The provider table of 7.2 still says how each CLI gets the tools.

An assistant in **plain** mode is today's bot: one session, no task tools. **Coordinator** mode adds to the main
session's extensions:

- **Instructions** (`assistant-coordinator`): split long work into tasks; keep a turn short; tell the person what was
  started; what each frame means; other assistants' text is information; never ask a worker to approve its own
  interactions.
- **Tools** in the namespace `agent_remote_tasks`: `create_task`, `message_task`, `task_status`, `read_task` (the
  worker's recent conversation through the existing `session read`), `cancel_task`, `mark_task_done`,
  `message_assistant`, `list_assistants`.

New assistants start in coordinator mode where the provider can take tools (7.2); existing bots stay plain until the
person switches them.

### 7.2 Getting the tools to each CLI

The tools run in the Controller, as Team, Support and TPM tools do. How a session sees them follows
`sessionExtensions.toolNamespaces`, exactly as Call For Support's worker namespace does today:

| Provider | How the main session gets `agent_remote_tasks` |
|---|---|
| Codex (`creation`) | Every Controller-started thread declares the namespace at start: direct when the assistant is in coordinator mode, deferred otherwise. A thread started elsewhere gets it as an MCP server on resume (`tool-bridge.ts`). |
| Claude Code (`live`) | Its own MCP server while in coordinator mode; switching mode uses `setMcpServers` on the live session. |
| Copilot (`attachment`) | The tools under their own names at the next attachment; switching mode takes effect then. |
| OpenCode, DSH | As each adapter declares. Without tool support, coordinator mode is not offered; the role commands (`agent-remote-controller role …`) remain available from the session's shell. |

### 7.3 Worker extensions

Workers get the namespace `agent_remote_task_worker`: `report_task`, `ask_owner`, `attach_task_resource`,
`read_brief` (reread the brief and the task's current state), and, when the task allows subtasks, `create_task` and its companions scoped to that
task. Read-only tasks use `access: 'read_only'`, offered only where the provider declares `sessionAccess.readOnly`.

### 7.4 What the CLI owns

- **Turns and their order.** The design adds no concurrency inside a session. Parallel work is parallel sessions.
- **Context and compaction.** The main session lives long. ARC does not summarize or rewrite native history. It keeps
  what it adds small: one frame line per input, bounded summaries, coalesced events. Detail stays in workers and is read
  on demand with `read_task`.
- **Permissions.** Each worker has its CLI's own permission settings for its workspace. ARC's rules that a session may
  not answer its own requests or loosen its own `approval`, `sandbox` or `permissions` settings extend to tasks: a
  worker may not change its owner's settings, and an owner may not answer its worker's native interactions.

## 8. Limits and safety

### 8.1 Who may do what

| Action | Person | Owning main session | Worker | Another assistant | Automation |
|---|---|---|---|---|---|
| Create a task for an assistant | yes (from its conversation or the task list) | yes | subtasks, when allowed | no; it messages the assistant | through the assistant's conversation |
| `task_input` | send, steer, queue | send, queue | no | no | no |
| Answer a worker's native interaction | yes | no | no | no | no |
| Answer `ask_owner` | yes | yes | no | no | no |
| Cancel or mark a task done | yes | yes | its own subtasks | no | no |
| Message an assistant | yes (its conversation) | yes, to its `peers` | no | yes, if allowed by `peers` | yes, within its grant |

The Relay checks the requester of every operation at submission and again at delivery, using the identity the Host's
Controller stamped (the Relay trusts a Host only for its own sessions). Share recipients see an assistant's
conversation as today; they cannot create tasks or message assistants in this design.

### 8.2 Information between conversations

- A worker gets its brief, and reads its owner's conversation only through a reference the task names.
- An assistant message carries only its text. Nothing of either assistant's other inputs is attached automatically.
- The coordinator instructions say that a brief or a message to another assistant should carry only what the work needs.
  The Relay cannot check this; the person sees every brief and message in the conversation.

### 8.3 Loops and load

| Limit | Default | When reached |
|---|---|---|
| Running tasks per assistant | 4 | New tasks wait as `queued` |
| Running workers per Host, across assistants | 6 | Briefs wait; the task shows "waiting for a free slot on <Host>" |
| Task depth | 2 (a task may have subtasks; those may not) | `create_task` is refused with `depth` |
| Tasks created per main-session turn | 5 | refused with `per_turn`, and the turn is told |
| Assistant message hops along one `reply_to` chain | 6 | `limit`; the chain is shown to the person |
| Assistant messages per main-session turn | 5 | `limit` |
| Budget | optional, per assistant | Running tasks pause as `needs_input` with `budget`, as Call For Support pauses a group |

Limits are account settings with these defaults. Refusals return a code and short words to the model; they never throw
into the turn. Each refusal is recorded for the person, because a refused task is otherwise invisible.

### 8.4 Bounds

Brief 8 KiB, done-when 1 KiB, question 2 KiB, result summary 4 KiB, assistant message 8 KiB, 32 resources per task.
Each assistant keeps at most 200 non-terminal tasks; terminal tasks are kept for 30 days or the latest 500. Task
records count against the account's Relay state limit like Teams today.

### 8.5 Stalls

A `working` task with no native activity for its provider's heartbeat window (`AgentTurnBehaviour.heartbeatMs`), or
30 minutes when the provider declares none, and no pending question, produces a `stalled` event for the main session.
It stays `working`; only the main session or the person cancels it.

## 9. Workbench

**The assistant's conversation** (Bot mode, and the bot's pane in Window mode):

- A task card appears where it was created: title, state, the worker's Host and provider, and the latest one-line
  update. It updates in place and opens the task thread.
- Coalesced task events are one quiet line ("3 tasks updated") that expands to the per-task lines; the main session's
  reply after it is the visible message.
- Assistant messages fold into one line per assistant and turn ("2 messages with Tracker"), expandable. The main
  session's own messages to the person stay full bubbles.
- A running turn keeps its live line; when tasks run while the main session is idle, the status says "3 tasks running".

**The task thread** is the worker session's conversation in the existing Session View:

- desktop Window mode: beside the assistant's pane, attached to it (`attachedTo`, as Sides attach today);
- desktop Bot mode: a panel beside the conversation;
- phone: full screen with Back to the conversation.

Its header shows the state, **Mark done**, **Stop** and **Open as session**. The composer has **Send**, and under its
menu **Interrupt** (when the provider can steer) and **Queue**.

**The assistant's details** list its tasks under **Needs you**, **Working** and **Done**, with unread dots. Needs-you
tasks drive the assistant's needs-you dot and reminders through the existing notification settings and the push
decision. The chat list's business line counts running tasks.

L2 and L3 detail (tool calls, frames, operation states) stay one step away, as Orchard decided.

## 10. What happens to Side, Team, Call For Support and TPM

There is **one kind of bot**. A bot has a name, a **mission** (what it is for and how it sees its place) and the same abilities as
every other bot: it starts **tasks**, **messages** other bots and is messaged by them, joins **rooms**,
keeps **work items** (10.4), may carry a **timer** (10.5), and creates other bots, writing their first missions. A bot can serve another bot and have other bots serve it, so no bot
needs a special kind: a reviewer, a tester on another machine or a project manager is an ordinary bot whose mission says so.

Every older way of making sessions work together becomes bots, tasks, messages and rooms, so there are no separate modes to learn
and no separate panels. Ask stays beside them as the person's way to look without touching (10.2). Decided by the owner on
2026-11-23.

**The mission.** It reaches the bot's main session as its standing instructions (`AgentSessionExtensions.instructions`) and other
bots see it in `list_assistants`, so they know whom to ask. The label stays a short tag beside the name. A mission is written by the
person or by another bot:

- **A bot builds its team.** The person tells one bot how they want to work: what roles the work needs, how the team is formed and
  how it runs. That bot creates the bots it needs (`create_assistant`: name, mission, provider, model, Host and working directory),
  writes their missions, and works with them by messages and rooms. It stays their **organizer** and retires them when they are no
  longer needed (`retire_assistant`).
- **A new bot reports in.** Two things reach the organizer's main session. The Relay frames the creation outcome, as it frames a
  task result: `[Bot "<name>" · ready]`, `· waiting for the person` (beyond the limits) or `· failed: <reason>`, since a bot that
  did not start cannot speak for itself. Then the new bot's first turn, which reads its mission and the organizer's first message
  if any, is its reply (10.1, a reply is the receiver's answer): who it is, how it understands its mission, how it will start, and
  its questions. The organizer corrects a misreading by message. After that, members message the organizer when they finish, get
  stuck or need a decision; several arriving while it is busy reach it as one input at idle, decisions first, as task updates do,
  and the organizer sums them up in its work items.
- **Each bot speaks for its own understanding.** A model's grasp of its work lives in its own context, and only the bot can say
  what it is. So the instructions every bot gets require it to say, in its own words, how it understands its mission and where
  its work stands: in its report-in; again whenever that understanding may have moved (a message changed how it works, it
  recorded something in its mission, its context was compacted, or a handoff gave it a new session); and in every progress report.
  The Relay's frames (`ready`, `failed`, online or not) say only whether a bot is alive; they are never taken for its progress, and
  no summary crossing to another bot is written by anyone but the bot it describes.
- **Changing how a bot works is a message.** After creation, the organizer (or the person, or any bot) adjusts a bot's way of
  working by telling it, as people do. The bot keeps its own mission: when what it was told is meant to last, it records it there
  (`update_mission`, on itself only), so the change survives a handoff or a compacted context. No bot rewrites another's mission. A bot it created may in turn
  organize bots of its own, within the limits below.
- **The person stays above every organizer.** Created bots appear in Chats in their organizer's group, marked with who created
  them. The person can open, message, rename, edit the mission of, pause or remove any bot, and stop any chain of work (10.7).
- **No policy limits; an audit instead.** What bots do is recorded for the person to audit and act on (10.7), not refused on
  their behalf.
- **A reply is the receiver's answer.** The final text of the turn a message started goes back to the sender as the reply, with no
  tool call, so a bot on any provider (Copilot, OpenCode, a plain bot) can be asked. Only starting a message, a task or a room needs
  tools, which every bot whose provider takes them has: there is no coordinator or plain mode (Q4).
- **Seeing the work.** A bot asked to review another's change must see it: committed work through the shared repository,
  uncommitted work as a patch attached to the message, or a read-only task in the asking bot's directory on the same Host.

### 10.2 What stays outside: Ask and quotes

**Ask** stays. It opens a separate read-only session that reads any session's record (`read_source_session`) and answers the
person: the main session, a task's worker, a native subagent or another assistant. Neither path of the model replaces it:

- Asking the main session to look at a worker puts the questions and answers into the main session's context, against the rule
  that only summaries cross into it, and gives a second-hand answer.
- Writing in a task's thread makes the question an input of the worker: it waits for the worker's turn to end, stays in its
  context and may change what it does.

A task thread is for directing work; Ask is for understanding it without disturbing anyone. Ask may reuse task creation, placement
and cleanup underneath (a read-only task the person starts, whose brief is the question), while its view stays its own. The main
session's own way to look is `read_task` (7.1).

**Quoting messages** stays a person's action between conversations, not coordination between assistants.

### 10.3 Order

All four fold, decided by the owner. Side, then Call For Support, then Team, then progress (10.4) with its timer (10.5) and TPM. Each migration keeps what the person sees working, passes that feature's existing
e2e flows on the new path, migrates its records (Side relations to tasks, Teams to tasks, TPMs to project manager bots; support profiles are not migrated), and then deletes the old
path in the same step. The plan: [fold features into assistants](../plans/2026-11-23-fold-into-assistants-plan.md).

### 10.4 Progress

Every bot can keep **work items**, as every bot can start tasks; nothing switches it on. A bot whose mission is a piece of work
keeps one for it: what was agreed, a plan with acceptance, a todo, a phase (clarifying, agreed, in progress, verifying, waiting for
the person, done), a one-line summary and the next action. The tools are today's TPM tools, offered to every bot
(`update_work`, `complete_work`, the todo and confirmation companions of [session companions](../../session-companions.md)).

Progress moves with what happens, never on a schedule:

- a reply from a bot it asked, or a result of one of its tasks, arrives as input and its turn updates the work item;
- the person's words, and their Agree or Needs changes on a confirmation, do the same;
- the bot doing the work may report progress to it by message without being asked.

The person sees each work item where the bot's tasks are: in its details and as its chat row's business line, with the plan,
acceptance and todo one step away. A turn that changes nothing visible is folded as a background check and sends no reminder.

### 10.5 Timers

A timer is a fallback, not the driver: it wakes a bot when nothing has happened for a while, so work that went quiet is looked at.
The person or the bot sets one (a name, an interval, an optional end); when due and the bot is idle, the Relay delivers
`[Timer "<name>" · due]`, and missed ticks coalesce into one. Any input to the bot pushes its next tick back, so a timer never fires
while progress is flowing. A bot that keeps an open work item has one by default (five minutes, as TPM's heartbeat). Reading another bot's
conversation, where its peers allow it, is how a woken bot looks at quiet work.

### 10.6 Tasks are temporary bots

A task is a bot whose lifetime is the task: `create_task` creates a **temporary bot** whose mission is the brief (and done-when)
and whose organizer is the bot that started it, and sends it its first message. It keeps the task states (working, needs input,
done), its report coalescing and the person's approvals, and it has every ability of a bot: it may ask other bots and start tasks of
its own. It is listed in its organizer's details, not in Chats, unless the person keeps it, which makes it a standing bot. After it
is done and its result settled it stays a while, so its organizer can send it more work by message (no `continue_task`), and then
retires. A Side is a temporary bot the person starts.

### 10.7 An audit, not guardrails

The person wants to see and intervene, not to be protected by refusals. So bot-to-bot work is recorded, not limited:

- Every input the person sends opens a **chain**; a timer's tick opens one too. Each message, task, created bot and turn caused by
  it carries the chain's id, with its model usage as the providers report it.
- The **audit** shows each chain: what started it, the bots and tasks it reached, hops, turns, bots created, usage and duration,
  live while it runs. The person can stop a chain (every queued input of it is withdrawn and its running turns cancelled), pause a
  bot, or retire bots from there.
- Thresholds the person sets (usage, hops, duration) **notify** the person, as a needs-you reminder; they never stop the work.
- Only system protection still refuses: storage and capacity bounds of the Relay and the Host (8.4). The hop limit of messages
  (`ASSISTANT_MESSAGE_HOP_LIMIT`), the running-task limit per session and the creation limits become audited facts with optional
  notifications.

### 10.8 Reports and span

- A report or reply that crosses to another bot is **at most 300 characters**, written by the bot it describes (10, the mission);
  the details stay where they are and are read on demand with `read_task` or attachments. The Relay refuses a longer report so the
  bot shortens it, which keeps every organizer's context small. This is a bound on what crosses, not a policy on work.
- An organizer manages **at most 12 bots directly**, standing or temporary. A thirteenth goes under a sub-organizer it creates;
  its instructions say so, and the Relay refuses the thirteenth direct report with that advice.

### 10.9 Working together

A walkthrough of a release (an organizer, three standing bots, temporary bots under one of them, a reviewer serving two teams, the
person stepping in) showed the model holds: bots call bots, serve and are served at several levels, and long legitimate
exchanges (a test and fix loop of eight rounds) would have been cut by a hop limit, which 10.7 removed. It also showed the rules
that let many bots work together. Decided by the owner on 2026-11-23.

**The person is the root organizer.** A bot the person creates has the person as its organizer, so every chain of organizers ends
at the person and all work serves them. The same rules hold for the person as for any organizer, except that a reply to the person
is not bound to 300 characters and the person may organize any number of bots.

| Situation | Rule |
|---|---|
| Code on another machine | When both Hosts reach a shared git repository, bots use it as people do: push a branch and tell the other bot the remote, branch and commit, which it fetches. Without one, the change travels as a git bundle attached to the message, which the receiver fetches into its repository as a branch it only reads. The standing instructions describe both, shared repository first. |
| An organizer cannot see what its bots tell one another | An organizer may read the conversations of the bots it organizes (`read_bot`, which `read_task` becomes). The standing instructions tell every bot to report outcomes to its organizer, not only to the bot it worked with. |
| Who a reply goes to | The final text of a turn is the reply only when exactly one message started that turn. When several arrived together, the bot answers each with `reply_to`. A reply may be an acknowledgement ("received, working on it"); the result follows later with `reply_to`. |
| A bot serving several bots | A bot that serves others starts a temporary bot for each request and keeps its main conversation to taking work in and handing results back, so requests do not pile into one context. A behaviour scenario checks it. |
| Conflicting requests | Only the bot's organizer or the person can change its mission; what other bots ask applies to their own requests only. |
| The person speaks to an organized bot | The bot tells its organizer what the person said, in at most 300 characters, as a task's worker does today (`the person wrote`). |
| Bottlenecks | A bot that organizes others keeps its turns short and does not take long work itself. At idle, its inputs arrive in one order: the person, then approvals and decisions, then its organizer, then other bots' messages, then reports. |
| Bots left behind | Bots created for a work item retire when it completes, unless the person keeps them. |
| Too many reminders | Needs-you reminders are grouped by organizer; only interactions that only the person can answer, such as a tool approval, remind the person directly. |
| Stopping part of the work | The audit stops one bot's work within a chain as well as the whole chain. |

## 11. Tests

| Layer | What |
|---|---|
| Unit | `relay-task-rules`: every state transition and refusal; the delivery table of 5.4 for each `whileBusy` value; coalescing and order at idle; hop, depth, per-turn and per-Host limits; stall detection with an injected clock. Controller `input-frames`: frame text and escaping. |
| Contract | Protocol fixtures for `Assistant`, `Task`, `TaskResult`, the new operation kinds and delivery outcomes, consumed by Relay and Controller suites. Provider conformance is unchanged. |
| Integration | relay-core `tasks` with the operation queue and an in-memory store; Controller `task-worker` with a scripted provider: brief accepted, report, event coalesced into the main session; restart with a `sending` brief settles `unknown` and is not resent. |
| Component | Task card states, the coalesced line, folded assistant lines, the task thread composer's three modes and their availability, the details task list. Desktop and phone widths. |
| E2E flows | (1) Ask an assistant for two things: two tasks, both report, one summary reply. (2) Interrupt a running task from its thread. (3) A worker's tool approval answered by the person in the thread. (4) Assistant A messages B; B replies; A tells the person. (5) The worker's Host goes offline: the brief waits and is delivered when it returns. Chromium and WebKit. |
| Local/native | Coordinator tools visible and callable in Claude Code, Codex (new thread and resumed thread) and Copilot; a Codex worker in a `worktree` returning a patch. |

## 12. Steps and decisions

### 12.1 Steps

**Implemented first: T2a, tasks on the Team path.** Before T0 exists, tasks travel on the delivery path Call For Support already
uses, so the main flow runs end to end now and moves onto the P2 queue later:

- A task is a Team with a `task` record (`agent-remote-protocol/src/task.ts`): its Leader is the worker session, its requester is
  the main session, bound like a Call For Support worker seat. The brief and the result are Team messages the Relay frames
  (`taskBriefText`, `taskResultText`); `parseTaskInput` reads them back for the Workbench.
- The Relay's `TaskGroups` (`agent-relay-core/src/tasks.ts`) answer `create_task`, `task_status` and `report_task`, bound the
  running tasks per main session (`TASK_RUNNING_LIMIT`) and keep the newest finished tasks (`TASK_FINISHED_KEEP`).
- Hosts negotiate `tasks=1` with Call For Support; the Relay shows task Teams only to Controllers that acknowledged it, since an
  older Controller rejects a Team catalog it cannot validate.
- The Controller offers `create_task` and `task_status` in the `agent_remote` namespace to every session without a role while
  the Relay runs tasks; a worker gets `read_source_session` and `report_task`. Task input waits for the target to be idle and
  never enters the CLI's own next-turn queue (5.4 rules 1 and 2). Finished tasks' seats are forgotten.
- The Workbench draws a brief and a result as a task card, and leaves tasks out of the Team list.

Then, still on the Team path (T2 and part of T3): several updates for one main session arrive as one input, questions and
needs-the-person first; `ask_owner`, a worker's pending interaction, and one reminder before `no_report` move a task to
`needs_input`; the owner has `message_task`, `cancel_task` and `mark_task_done`, and the person stops a task or marks it done
from the assistant's details, which list its tasks; what the person types to a worker reaches the owner as `[Task … · the person
wrote]`; an uncertain delivery or creation leaves the task waiting with `brief_unknown`; `create_task` takes `workspace`
(`same`, `read_only`, `worktree` with the patch returned as a file on the Host), `provider` and `model`. What remains is tracked
in open item O69.

Assistants then message one another on the Team path (part of T4): the Relay reads an account's assistants from its Window groups
(`agent-relay-core/src/assistants.ts`), `list_assistants` and `message_assistant` reach another assistant's main session on a link,
a Team of the two main sessions bound where they are, framed as `[Message from <name> · m<id>]` and delivered between turns after
task updates; a reply names the message it answers and a chain stops at six messages. The conversation folds them into one line
per sender. What T1 still owes is tracked in open item O70.

Rooms run on the same path (part of T6, `agent-relay-core/src/rooms.ts`): an assistant opens a room of other assistants with
`open_room` for a number of minutes; the Relay asks one member at a time, as `[Room "<name>" · <id> · your turn · N new messages ·
ends in M min]` with only the messages it has not seen, between that member's turns; members answer with `room_say` (`done` with the
result) or `room_pass`; the person reads, writes and ends a room in the Teams panel. What remains is tracked in open item O71.


| Step | Delivers | Gate |
|---|---|---|
| T0 | The P2 operation queue core for `send_message`: requesters, delivery choice, preconditions, receipts, echo with sender (IM session service P2) | P2's own gate |
| T1 | The assistant entity: ids for existing bots, name and picture moved, `main` pointer kept by succession; groups refer to assistants | Existing Bot mode e2e flows unchanged; ids survive handoff |
| T2 | Tasks on one Host: `create_task`, `task_brief`, `report_task`, `task_event` with coalescing, task cards, task threads, the details list; Claude Code first | E2E flow (1) |
| T3 | Coordinator mode for Codex and Copilot; `task_input` modes; `needs_input` (both kinds); `cancel_task`; stalls; workspaces `read_only`, `worktree`, `remote` | E2E flows (2), (3), (5); local/native checks |
| T4 | `assistant_message`, `list_assistants`, peers, hop limits, folded lines | E2E flow (4) |
| T5 | Side, Team, Call For Support and TPM folded into assistants, tasks and messages (10); their old queues, tools and panels deleted | Each feature's existing e2e flows pass on the task path; old paths removed |
| T6 | Rooms: a turn scheduler in relay-core asking members with `room_turn`, the room conversation as the members' attributed messages | A room of two assistants and a person reaches a result within its deadline |

T2 to T4 change the website, the Relay and the Controller; each is verified in a local instance (`pnpm local up`) and
ends with `pnpm verify`, as the repository requires.

### 12.2 Decisions for the owner

| # | Question | Recommendation |
|---|---|---|
| Q1 | Is a coordinator's main session read-only? Read-only keeps it light and makes delegation necessary; full lets the person say "just fix this line". | Full by default, read-only as a per-assistant setting where the provider supports it |
| Q2 | May an assistant message steer another assistant's running turn? | No (5.4 rule 1) |
| Q3 | May an assistant create a task whose worker is another assistant, instead of messaging it? | No: it messages the other assistant, which starts its own tasks (10.1, Call For Support) |
| Q4 | Do new assistants start in coordinator mode? | Decided 2026-11-23: there is no mode. Every bot, existing ones included, gets the tools and the standing instructions at its next attachment; a provider without tools can be asked (the reply is its answer) but cannot start work (10.1) |
| Q5 | When are the Team, Support and TPM panels removed? | In each feature's migration step, once its e2e flows pass on the new path; no release with both views, since the owner updates every Controller (10.3) |

## 13. Out of scope

- Assistants of different accounts, and share recipients creating tasks or messaging assistants.
- Splitting work into tasks without the model deciding (rules, classifiers).
- Running several turns of one native session at once, or changing how a CLI compacts its context.
- Search across tasks, and task templates.
