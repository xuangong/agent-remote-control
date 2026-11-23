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

- [ ] To be scoped after M4 against the IM session service P2 plan
