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

- [ ] needs_input: a worker's pending interaction, and `ask_owner`
- [ ] `message_task` from the owner, answering a question or adding input
- [ ] The person's input to a worker tells the main session
- [ ] `cancel_task` and `mark_task_done`, from the owner and from the page
- [ ] A worker idle without a report gets one reminder, then needs input
- [ ] A worker whose creation is unknown leaves its task needing input
- [ ] Workspaces `read_only` and `worktree` (with the patch returned), provider and model choice

## M3: assistants and their messages (T1, T4)

- [ ] Assistants as Relay entities: id, name, current main session
- [ ] `list_assistants` and `message_assistant`, framed, between turns, with replies and hop limits
- [ ] Folded assistant lines in the conversation

## M4: rooms (T6)

- [ ] A room of assistants and people; a scheduler asks one member at a time with the new messages

## M5: one queue and the older mechanisms (T0, T5)

- [ ] To be scoped after M4 against the IM session service P2 plan
