# Assistant tasks: execution plan

Design: [assistant coordinator and tasks](../specs/2026-11-23-assistant-coordinator-and-tasks-design.md). Branch
`feat/assistant-tasks`. Decisions Q1 to Q5 follow the design's recommendations.

Each item is checked when its code, tests and verification are committed. Verification per item: unit tests of the touched
modules; `pnpm verify:changed` per commit; a real session in `pnpm local` for each milestone; `pnpm verify` and the e2e flows
(Chromium and WebKit) at the end of each milestone.

## M1: tasks complete on one Host (T2)

- [x] T2a: create, brief, report, result, cards, negotiation (commits ee18dee7, 72cfef0c, 5c2b6803)
- [x] Several task updates for one main session arrive as one input, needs-input first (36e4978e)
- [x] A task card opens the worker session (36e4978e, 2e58959f); in a Window it takes the tile's place
- [x] The assistant's details list its tasks (Needs you, Working, Done) (36e4978e)

## M2: the task lifecycle (T3)

- [x] needs_input: a worker's pending interaction, and `ask_owner` (c0ff5c53, 3cd8342c)
- [x] `message_task` from the owner, answering a question or adding input (c0ff5c53)
- [x] The person's input to a worker tells the main session (c0ff5c53)
- [x] `cancel_task` and `mark_task_done`, from the owner and from the page (c0ff5c53)
- [x] A worker idle without a report gets one reminder, then needs input (c0ff5c53)
- [x] A worker whose creation is unknown leaves its task needing input (c0ff5c53)
- [x] Workspaces `read_only` and `worktree` (with the patch returned), provider and model choice (a497fbf9)

## M3: assistants and their messages (T1, T4)

- [x] Assistants as Relay entities: id, name, current main session — a directory over the Window groups (8f8681cb); the separate record is O70
- [x] `list_assistants` and `message_assistant`, framed, between turns, with replies and hop limits (8f8681cb)
- [x] Folded assistant lines in the conversation (8f8681cb)

## M4: rooms (T6)

- [x] A room of assistants and people; a scheduler asks one member at a time with the new messages (c87009f9, 95aab522); what remains is O71

## M5: one queue and the older mechanisms (T0, T5)

- [x] Scoped against the IM session service P2 plan (below)

M1 to M4 run on the Team delivery path. What moves them onto one queue and retires the older mechanisms cannot finish on this branch:
T0 is the rest of P2 in the [IM session service roadmap](2026-11-15-im-session-service-roadmap.md), whose gate tells the owner
when every Controller must be updated, and Q5 removes the old panels only after one release in which both views read the same
records. The steps, in order:

1. **T0, the operation queue (P2).** The queue of the [IM session service design](../specs/2026-11-15-im-session-service-design.md#operation-queue)
   for `send_message` first: requesters, delivery choice, preconditions, claimed and sending receipts, echo with the sender. Its own
   plan, under the P2 gate; the owner is told which Controllers must be updated before the Relay depends on it.
2. **Tasks, links and rooms on the queue.** The framed inputs of M1 to M4 become operation kinds: `task_brief`, `task_input`,
   `task_event` (coalesced at idle), `assistant_message` and `room_turn`. Their records leave the Team catalog for relay-core
   `tasks`, `assistants` and `rooms` stores, and the Team kinds `task`, `link` and `room` with their seats are removed. Order at
   idle across kinds (5.4 rule 4) comes with the queue. Closes O69's delivery rules.
3. **T1, the assistant record** (O70): ids that survive moving between groups, name and picture moved from `WindowBotDetails`,
   `peers`, coordinator and plain mode, per-turn limits. Links and rooms read it.
4. **T5, the older mechanisms on tasks.** Call For Support calls become tasks with `read_only`, `worktree` or `remote` workspaces;
   TPM intents become tasks of the TPM's main session; Team members' work becomes tasks of the Leader; Sides become tasks the person
   started. Each feature's existing e2e flows must pass on the task path.
5. **One release with both views**, then delete the Team, Support and TPM panels, queues and tools (Q5).

## Verification (2026-11-23)

- Each milestone ran in `pnpm local` with real Claude Code sessions: two tasks finishing during one turn arrived as one input; a
  card and a details row opened the worker; a worker's question was answered with `message_task`, its file write waited for the
  person and finished once approved; the person's words to a waiting worker reached its owner; Stop from the details stopped the
  worker and told the owner; two assistants exchanged a message and its reply; a room of two assistants reached a result, and a
  second room waited for the person's message before deciding.
- `pnpm verify` and the e2e flows pass at the M1, M3 and final heads. Unit suites need an English locale on this machine
  (`App.bot-attention` formats times in the system locale).
- The component tier at the M1, M3 and final heads: every failure was a WebKit or layout timeout that passed when run alone, as
  O65 records.
