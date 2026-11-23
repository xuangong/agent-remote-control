# Assistant tasks, messages and rooms: handoff

Updated 2026-11-23. This hands over the work on branch `feat/assistant-tasks`. It covers:

- the reference model and why ARC follows it;
- the plan, and what this branch built of it;
- where the code is and how to verify it;
- why it is not ready to deploy;
- what to do next, in order.

Read with it:

- the design: [assistant coordinator and tasks](../superpowers/specs/2026-11-23-assistant-coordinator-and-tasks-design.md);
- the plan with its checklist and verification: [assistant tasks plan](../superpowers/plans/2026-11-23-assistant-tasks-plan.md);
- the open items [O69](../superpowers/open-items/O69.md), [O70](../superpowers/open-items/O70.md) and
  [O71](../superpowers/open-items/O71.md).

## 1. Where things stand

| Item | State |
|---|---|
| Branch | `feat/assistant-tasks`, from `main` at `6d115b46`, pushed. Not reviewed, no PR, not merged |
| Milestones | M1 to M4 done on the Team delivery path; M5 scoped only (section 6) |
| Deployed | Nothing. The branch is not ready to deploy (section 5) |
| Verification | `pnpm verify` and the e2e flows pass at the head; the component tier's only failures are timeouts that pass alone (O65) |
| Owner decisions | Q1 to Q5 of design 12.2 follow the design's recommendations |

## 2. The reference model

The product this follows (Grok Bot) organises an assistant this way, as its interface and behaviour show:

1. **One main conversation per assistant, one turn at a time.** Everything that talks to the assistant lands there: the person,
   other assistants, and the results of its own work. Its mind is that conversation; it is never split into parallel ones.
2. **Work runs as tasks on background agents.** When the person asks for several things, the main conversation starts a task for
   each. A task has a title and one of three states: working, needs input, done. Its agent works in parallel and returns a short
   summary, which arrives in the main conversation as a new input and wakes it. The main conversation's turns stay short:
   understand, split, dispatch, sum up.
3. **A task has its own thread.** The person can open it beside the main chat and write to the task's agent directly: send,
   interrupt or queue. The main conversation is told.
4. **Assistants message each other's main conversation, never a task.** A message carries its sender and may answer an earlier
   message. Delivery has an explicit outcome (delivered, duplicate, forbidden, unreachable). The receiver decides what to do, and may
   start its own task. The conversation folds these exchanges into one line ("3 messages with …"). Only the person reaches past the
   main conversation into a task.
5. **A group chat is a room that schedules turns.** It asks one member at a time to speak, gives it only the messages since it last
   spoke, who else is there, a deadline, and whether to wind down.
6. **A main assistant** coordinates the person's other assistants.

What makes it work: communication is serial and in one place, so the assistant stays coherent; only work is parallel; and summaries,
not transcripts, cross from workers to the main conversation, so the main conversation's context stays small.

## 3. The plan, and what this branch built

The design maps the model onto ARC's native agent CLI sessions:

- the main conversation is the bot's current native session;
- a task's agent is an ordinary native session created on a Host;
- tools reach both through `AgentSessionExtensions`, as Team and Call For Support tools do;
- everything reaches a session as an operation of the P2 queue (IM session service) with requester, receipts and at-most-once
  delivery;
- Side, Team, Call For Support and TPM become tasks.

The design's steps are T0 (the P2 queue) to T6 (rooms). T0 does not exist yet, so this branch builds the user-visible model on the
delivery path Call For Support already has, the Team path. Its claim, durable receipt, native send and settle already give
at-most-once delivery. Each concept is a kind of Team:

| Concept | On this branch | Delivery |
|---|---|---|
| Task | A Team with `task`: Leader = the worker session (created), requester = the owner's main session (bound) | Brief to the worker; updates to the owner, coalesced into one input at idle, questions first |
| Link between two assistants | A Team with `link`: both members are main sessions, bound where they are | `[Message from <name> · m<id>]`, between turns, after task updates |
| Room | A Team with `room`: every member is a main session; transcript, seen counts, speaker, turns, deadline | `[Room "<name>" · <id> · your turn · N new messages · ends in M min]` to one member at a time |

Nothing framed by the Relay ever steers or enters a CLI's own next-turn queue: it waits until the target is idle (design 5.4 rules 1
and 2). The person's own input is unchanged.

Built, by milestone (the plan has the commits):

- **M1:** `create_task`, `task_status`; the worker's `report_task`; coalesced updates; task cards with Open; the task list in the
  assistant's details.
- **M2:**
  - questions: the worker's `ask_owner`, and a pending native interaction makes the task wait for the person;
  - one reminder, then `no_report`;
  - the owner's `message_task`, `cancel_task` and `mark_task_done`; Stop and Mark done in the details;
  - the person's words to a worker reach the owner as "the person wrote";
  - uncertain deliveries and creations wait as `brief_unknown` and are never resent;
  - `create_task` takes a workspace (`same`, `read_only`, `worktree` with the patch saved as a file on the Host), `provider` and
    `model`.
- **M3:** `list_assistants` and `message_assistant` with `reply_to` and a six-message chain limit; messages folded per sender. The
  assistant directory is derived from the Window groups (O70).
- **M4:**
  - an assistant opens a room with `open_room`; members answer with `room_say` (with `done` and the result) or `room_pass`;
  - the person reads, writes and ends rooms in the Teams panel;
  - a member that does not answer loses its turn; turn and time limits close a room.

Capability: everything above is offered only when the Relay and the Controller agree on `tasks=1`. The Relay hides task, link and room
Teams from older Controllers, whose strict Team validation would otherwise reject the whole catalog.

## 4. Code map and verification

| Area | Files |
|---|---|
| Protocol | `agent-remote-protocol/src/task.ts` (records, frames, parsing), `team.ts` (Team kinds, calls, actions, shape rules) |
| Relay | `agent-relay-core/src/tasks.ts`, `assistants.ts`, `rooms.ts`; routing in `teams.ts`; capability in `team-service.ts`; groups wired in `gateway.ts` |
| Controller | `agent-controller/src/team.ts` (seats, delivery batches, presence with interactions, the person's input, cancel, worktrees), `task-roles.ts`, `call-for-support-worker.ts` (the main session's tools), `host.ts` |
| Page | `agent-client-web/src/react/items/TaskInputItem.tsx`, `react/TaskDirectory.tsx`; `agent-remote-lab/src/features/tasks/`, `conversation/assistant/TasksList.tsx`, `features/team/RoomView.tsx` |
| Tests | `tasks.test.ts`, `assistants.test.ts`, `rooms.test.ts` (relay-core); `task-worker.test.ts` (controller); `task.test.ts` (protocol); `TaskInputItem.test.tsx`; `task-directory.test.tsx`, `TeamMenu.test.tsx` (lab) |

To verify:

- Run unit suites and `pnpm verify` with an English locale (`LANG=en_US.UTF-8`); `App.bot-attention` formats times in the system locale and fails on a
  12-hour or Chinese locale.
- The component tier needs a quiet machine. Five WebKit tests and one layout test time out under load and pass alone (O65). Run them
  alone before calling a failure real, and do not run the tier while rebuilding the same checkout: a build empties `dist`.
- Live checks use `pnpm local` and `agent-remote-controller-dev`, following the `prepare-arc-local` skill. Open the page at `/` in
  scripts: opening a session link in Window mode rebinds the current tile, which changes which session a bot shows.

## 5. Why it is not ready to deploy

1. **Process.** No independent review, PR or remote CI yet.
2. ~~**It changes every session.**~~ Done on `feat/assistant-tasks-deployable`: only assistants in coordinator mode get the task,
   assistant and room tools. Existing bots stay plain; new bots start as coordinators where the provider can be one (Claude Code,
   Codex). Copilot stays plain (O70).
3. ~~**Storage grows.**~~ Done there too: ended tasks, rooms and links are kept up to 200, 50 and 100 per account.
4. **Known gaps.**
   - A link keeps the sessions it bound, so after the person points a bot at another session, messages reach the old one (O70).
   - Rooms close at the next action after their deadline, not on time (O71).
   - Stalls are not detected (O69).
5. **Coverage.** Live runs used Claude Code only. Codex (tools declared at creation), Copilot (at attachment) and OpenCode follow
   the same code paths but were not run for real. Mixed Relay and Controller versions are covered by unit tests only.

## 6. What to do next

In this order:

1. **Make it deployable:**
   - ~~add the coordinator/plain switch per assistant~~ and ~~prune ended rooms and idle links~~: done on
     `feat/assistant-tasks-deployable` (plan, section Deployable);
   - ~~run the flows live with Codex and Copilot~~: a Codex coordinator ran a task end to end; Copilot cannot follow a mode change
     (it takes tools only when it attaches) and is not offered coordinator mode (O70);
   - open a PR, get the independent review, and deploy the Relay before the Controllers.
2. **T0, the P2 operation queue,** as its own plan under the IM session service roadmap. Tell the owner which Controllers must be
   updated before the Relay depends on it.
3. **Move tasks, links and rooms onto the queue.**
   - Their framed inputs become `task_brief`, `task_input`, `task_event`, `assistant_message` and `room_turn` operations, and their
     records move to their own relay-core stores.
   - The Team kinds `task`, `link` and `room` go away.
   - This brings the order at idle across kinds (5.4 rule 4).
4. **T1, the assistant record** (O70): ids that survive moving groups, name and picture out of `WindowBotDetails`, peers, limits.
5. **T5:**
   - Call For Support, TPM, Team and Side work become tasks, with each feature's e2e flows passing on the task path;
   - then, after one release with both views (Q5), delete the old panels, queues and tools.
6. **Remaining Workbench pieces:**
   - a task thread header with Mark done and Stop, and Interrupt and Queue in its composer;
   - Bot mode's side panel for task threads;
   - unread dots, and needs-you feeding the assistant's reminders;
   - rooms as conversations in Bot mode (O71).

## 7. Lessons from this branch

- **Presence just after a delivery lags.** A Controller that reports a worker idle in the same poll that delivered its input makes
  the Relay think the turn ended. Task seats skip that poll's presence.
- **Authorize a member by its seat, not by the directory.** A room checked the speaker against the assistant directory. When a tile
  was rebound, a real member was refused. Rooms now resolve the caller through the session the room bound.
- **One native session can hold several requester seats, but only one other seat.** That is why links and rooms bind every member
  as a requester.
- **Claude Code approves namespace tools without asking.** Flat tools need approval, so worker tools are a namespace where the
  provider takes one.
- **Claude Code may title a session after its latest input,** which can be a frame. Names shown in frames come from the first line of
  a title, or "the main session".
