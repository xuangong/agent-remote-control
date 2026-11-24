# Bots step 8: boards, asks and mentions

Decided with the owner (2026-11-24), after comparing bots with the Grok Bot app installed on this machine (`/Applications/Grok Bot.app`
1.2.3; its protocol read from the bundle, its server not seen): one bot has many sessions (one per thread it is asked in) and shares
what it learns through a memory; work is tracked on a board per bot; reports to a coordinator always reach its main session.

## Principles

1. **Bots talk to main sessions; people get sessions of their own.** Every message from another bot reaches the receiving bot's
   main session, combined between turns in the order of design 3.2 (as in Grok Bot, where a bot's message is an entry of the
   receiver's main transcript). What the person asks from another conversation (a mention) is answered in a session of its own
   for that conversation, as Grok Bot answers each Slack thread, DM or group in its own session.
2. **The main session coordinates.** A bot's main session talks, plans, assigns and keeps its board; work of any size goes to
   temporary bots or staff, so its turns stay short and its staff never wait long. It may still do small things itself.
3. **One board per bot.** The board is the bot's current plan, edited whenever the plan changes; no bot writes another bot's board.
4. **Notify, never guard.** Every change to an item assigned to a bot tells that bot; conflicts are reported, not refused.

## 8a. The board (replaces work items)

- An item: key, title, status (open, working, waiting, done, cancelled), assignee (the bot itself, one of its temporary bots, or a
  standing staff bot), parent item, links (commit, branch, PR, file, attachment, another bot), a one-line result, version, updated
  by and at. At most 50 open items; done and cancelled items are kept a week.
- A plan note heads the board: a few lines on how the bot means to do the work, each change with one line saying why.
- Who writes: the bot's main session and its answer sessions; a temporary bot writes the item it was created for (status, links,
  result), since it is the chief's own worker (in Grok Bot a board's members are the bot's sessions and workers, and a task names
  its owner session); the person edits any item from the bot's details. A standing staff bot writes only
  its own board and reports by `message`; its chief updates the item.
- Every write names the version it read; a stale write is applied field by field and the writer is told what it overwrote (no
  refusal). A change to an item assigned to another bot (retitled, reassigned, cancelled, its brief changed) queues
  `[Item "<title>" changed · <what changed>]` for that bot; it replans its own board.
- Context stays with the item, so the main session can hand long work away and still find it (it reads its board first whenever it
  starts, resumes or was compacted):
  - The item keeps the brief as sent, and the latest report (one line, at most 300 characters) beside its status.
  - Binding both ways: `create_bot` or `message` naming an item records the assignee on it; the assignee's first input names the item
    (`[Item 7 "Run the regression" · from Chief]`), and its reports update that item without the chief matching them by hand.
  - From an item the person and the chief open the session or bot doing it, and read its process with `read_bot`.
- Tools: `board` (read one's own board, or the board of a bot one is chief of, read only), `update_board` (create, change, move,
  cancel items; the plan note). `create_bot` and `message` may name the item they serve; the item then links the bot.
- Existing work items and timers: work items become board items; the timer of open work stays (design 6.2). Old data may be dropped.

As built (8a):

- Protocol: `BoardItem`, `BoardPlan` and `Board` in `bots.ts` (limits as constants), `Board` on `TeamInbox` in place of `work`, the host calls
  `board` and `update_board`, an `item` on `create_bot`, `bot_message` and `create_task`, and the item a task was created for on `TeamTask.item`
  (board owner, key, title). `WorkItem`, `update_work` and `complete_work` are gone; a Relay drops an old inbox's `work` when it loads. Fixture
  `fixtures/board.v1.json` holds valid and invalid items, boards and calls.
- Items keep `changedAt` (the version at which each field last changed), which is how a stale write knows what it overwrote: only fields it
  writes, with another value, that changed after the version it read. A new item names no version; a temporary bot may leave out the version
  and the key of the one item it writes. The plan note has its own version and the same notice; each change keeps a `why` line (last 20).
- Assigning: `create_bot` or `message` naming an item sets the assignee, the brief (the first one the assignee got; a follow-up leaves it) and
  status working. The tag line `[Item 7 "title" · from Chief]` is written by the Relay after the frame's header, never in a payload
  (`[Item` lines in a payload are quoted). For a temporary bot the tag also goes on its later inputs and its reports, from the stored item.
- Reports: a `message` with a status, from a bot to the bot whose board holds an open item assigned to the sender (the named `item`, or the
  only one), sets the item's latest report (a failed report reads "Failed: ..."). Status and result follow (progress working, needs_input
  waiting, done done with the result, failed open) only when the sender is the temporary bot created for that item. A standing staff bot's
  report changes neither status nor result.
- Notices (retitled, brief changed, cancelled, assigned to you, reassigned) are queued after the write from the record, by the item's key
  and version, to a standing bot's inbox or a running temporary bot's task; a bot that is gone is simply not told.
- Timer of open work: unchanged rules, driven by open board items; the due timer lists their title, status and latest report.
- `list_bots` returns `board: { open, items }` for the caller's own open items where it returned `work`; `read_bot` is unchanged.
- Page: `TaskDirectory.board` replaces `work`; the assistant details list items with status, latest report and result; a quiet bot's roster
  row shows its latest open item and status. Frames `[Item ...]` show as plain text in the timeline for now.
- Tests: `bot-board.test.ts` (versions, stale writes, limits, the assignee notice, temporary bot writes, report binding, chief read access),
  protocol fixture test, Controller tool mapping test, an E15 flow. The stale-write notice and the assignee notice were each mutation checked.

## 8b. Answer sessions (for the person's conversations)

- The person's mention (8d) from conversation X opens, or reuses, the bot's answer session for X: one per (bot, conversation),
  kept for follow-ups from X and retired after an hour without one. There is no count limit; the Host stops an idle one.
- An answer session starts with the bot's mission, its memory (8c) and the question; it reads conversation X and the bot's main
  session through `read_bot` when it needs more (Grok Bot's threads read the main agent's context the same way).
- It may read the board and update items; it does not message the bot's staff, which stays the main session's work.
- Its final text answers (design 3.3). Chains record it as the bot's answer session; the audit lists it under the bot.
- Bots asking bots need no answer session: the receiver's main session answers between turns, combined with whatever else
  waits, and stays short because it coordinates (principle 2).

## 8c. Memory

- Beside its mission, a bot keeps a memory: short facts (at most 50, 300 characters each) that every session of it starts with.
  `remember` adds or replaces a fact, `forget` removes one; the bot's own sessions and the person write it, never another bot
  (Grok Bot keeps learned facts per bot and lets people review memory changes). The mission stays
  what the bot is for; the memory is what it learned.
- An answer session that learned something lasting records it in the memory; nothing else flows back to the main session.

As built (8c):

- A fact is `{ id, text }` (id `f` and 8 hexadecimal digits, text 1 to 300 characters); a memory is at most 50 facts. It is an identity field
  of the bot's record and of its details, like the mission, so the person edits it through the same details write (`bot.update`).
- Writers: the bot's own main session (`remember`, `forget`) and the person (the details). The invariant is structural: the two calls name
  no bot, so the Relay always acts on the caller's own bot, and a temporary bot, which has no memory, is refused; another bot, its chief
  included, cannot write it and no guard stands beside that. `remember(text, replace?)` adds a fact, or replaces the one `replace` names by
  id or exact text; the same text twice is one fact; a 51st is refused with "forget one first". `forget(fact)` removes one by id or exact text.
- Delivery: `botInstructions(mission, memory)` puts `Your memory (...)` after the mission, one line `- <id> · <text>` per fact (absent when
  empty), so every session starts with it, and the existing hash resends the standing instructions to the main session when the person
  changes the memory. A bot's own write counts as sent (`known`), as a mission write does. The base instructions are unchanged (8f).
  The Controller keeps each bot's memory with its mission, so a session opened later starts with it too.
- Page: the details list the facts beside the mission, each with edit and delete (no add: the person tells the bot, which keeps it). The
  richer layout is 8g.
- Tests: `bot-memory.test.ts` (adding, replacing and forgetting by id or text, the limits, the writer invariant, the instructions and their
  resend), protocol fixture `fixtures/memory.v1.json`, window service, Controller mapping, a jsdom test of the details. The writer
  invariant was mutation checked (a write that reaches the caller's staff fails the test).

## 8d. The person mentions a bot

- The composer offers the account's bots after `@`. `@Name text` sent in conversation X sends nothing to X's session; it asks the
  bot (8b) with X as the asking conversation. The answer shows in X's timeline as one expandable line ("Reviewer answered"), and
  in the bot's details.

## 8e. Changing a chief

- `set_chief` (the person, or the bot's current chief) moves a standing bot to another chief, or to the person; the old chief, the
  new chief and the bot are each told. The span of 12 counts for the new chief.

As built (8e):

- Two entrances to one move: the bot's chief calls the Host call `set_chief(bot, chief)` (`chief` is a standing bot by name or id, or
  `person`; the bot must be its own standing staff), and the person uses the audit action `set_chief { botId, chief | null }` on the chains
  route, from the bot's details (a select of the person and the other standing bots, not itself or its own staff, and a button). The Relay
  refuses a loop (a bot cannot report to its own staff) and the same chief is a no-op.
- The record's chief changes in one commit that advances the bot's group revision, so pages refetch; an edit of the details still cannot set it.
- Notices, queued after the move from the record: the bot `[Chief changed · your chief is now B (it was A)]`, the old chief `[Chief changed ·
  "Bot" is no longer your staff; its chief is now B]`, the new chief `[Chief changed · "Bot" is now your staff (its chief was A)]`; the person
  is named "the person" and is told nothing. The frame is written by the Relay (`chiefChangedText`) and a payload cannot forge it (`[Chief`
  lines are quoted).
- Span: a chief's span is its standing bots plus its temporary bots at work. No span limit existed before this step, so `set_chief` is where
  the limit of 12 first applies; the 13th is refused with the advice to create a sub-chief. Creating a bot is not yet counted (open question).
- Tests: `bot-memory.test.ts` (notices to all three, the person's path, who may move, loops, the span), protocol fixture, window service,
  Controller mapping, the task directory and a jsdom test of the picker. The notices were mutation checked (dropping the old chief's notice
  fails the tests).

## 8f. Base instructions (version 5)

- The main session is a coordinator: keep turns short, put the plan on the board, give work of any size to temporary bots or
  staff, answer staff questions first. Asks arrive in answer sessions. Lasting facts go to memory, purpose to the mission.
- Rerun `pnpm test:bots` with Claude Code and Codex.

## 8g. The Workbench

- A bot's details show its board first: the plan note, then open items as a tree (assignee, status, links, result); an item
  assigned to a staff bot expands into that bot's board, read only. The person edits items and the plan note in place.
- The details also show the memory and the answer sessions now open.
- The audit lists answer sessions under their bot.

## Tests

- Unit (Relay, mock data): board writes, versions and stale writes, the notice to an assignee, the temporary bot's write,  answer
  session reuse per conversation and retirement, memory limits, set_chief notices.
- Controller: answer sessions start with mission, memory and the ask; final text settles the ask.
- Component: the board in the details at desktop and phone widths; the mention picker; the answer line in a timeline.
- E15: a chief assigns an item to a temporary bot, which marks it done with a link; the person mentions a busy bot and the answer
  shows in place while its main session runs a turn; a reassigned item notifies its old assignee.
- Scenarios: `pnpm test:bots <provider> board ask` with Claude Code and Codex.
