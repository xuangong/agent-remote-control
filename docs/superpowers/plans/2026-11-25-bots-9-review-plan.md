# Bots step 9: what the old ways of working showed

From [the record](../reviews/2026-11-24-old-ways-with-bots.md) of Side, Call For Support, Team and TPM done with bots. The quick fixes
of its Reflection are done first (base instructions v6, answers to requests reaching their sender, the composer draft, an assignee
reading its item, the cause of a person's edit, a request not reassigning an item). Decided with the owner on 2026-11-25, following
the recommendations:

## 9a. A side stays beside (decided: yes)

- A `/side` bot's result shows as a card beside the conversation it was asked from and does not become an input of that conversation's
  bot; nothing is restated there and no turn starts.
- A "Bring back" action on the card sends the answer into the conversation as the person's input, when the person wants it there.
- The side keeps its own conversation; its approvals show in the roster where the person sees them.

As built: `TeamCreate.bot` starts the task with `task.side: true` (`TaskBroker.create(..., { side: true })`, not a field of the host call). For a side the Relay's task `enqueue` records nothing addressed to its owner (result, question, progress, no-report, told, cancelled), so no input and no turn reach the conversation's bot; the report still sets `task.result`, and the bot's `message` to its chief reads as delivered. Temporary bots another bot creates are unchanged. The conversation's timeline shows each reported side as a card (`SideCards`, placed by turn like the asks) with Open and Bring back; Bring back sends `From the side "<title>":` and the answer quoted with `> ` as the person's message into that conversation (`sendPersonInput`). The roster row of the owning bot takes the needs-you dot while any of its temporary bots waits on an approval (`waiting.reason === 'interaction'`); before this the approval showed only inside the side. No E15 flow covered `/side`.

## 9b. Status check-ins without a model turn (decided: not now)

The board in a bot's details already answers "where are we?"; asking the bot still costs a turn. Revisit after use.

## 9c. Less closing chatter (decided: yes)

- Base instructions: after a delivery, do not acknowledge or thank; answer a report only when it changes what you do.
- A message whose only content is an acknowledgement ("received", "thanks", "noted") reaches the receiver folded and does not start a
  turn by itself: it waits for the next input. Measure turns and tokens of a Team run before and after.

As built: base instructions are v7 ("after a delivery or a report, do not acknowledge or thank: answer one only when it changes what you do"; an acknowledgement that must be sent uses status `ack`). The `message` tool takes the explicit status `ack`; the Relay marks the queued message `ack: true` (`TeamMessage.ack`), whatever its receiver is (a standing bot's inbox, a temporary bot, a chief). The Host's poll leaves a queued acknowledgement out while no other input is queued for the same seat (`withoutHeldAcks`), so it starts no turn; once another input is queued, it goes in the same delivery (the Controller joins a worker's inputs when an acknowledgement is among them, as it does for a main session). An acknowledgement does not resume a bot that waits for an answer and is not a report on a board item. Turns and tokens of a Team run are not measured here; that waits for the simulated Side and Call For Support runs of the checks.

## 9d. One approval per chain and folder (decided: yes)

- When the person answers a bot's native approval, they may choose "for this chain in this folder": the bots of the same chain asking
  for any kind of tool action in the same working directory are answered alike until the chain ends. The person's own decision, applied
  by the Controller of each bot; listed in the audit with the chain, revocable there.
- Approvals of other chains or other folders still ask the person.

As built: the choice is "Allow for this chain in this folder", offered by the Controller of a bot's session (a standing bot's main session, its answer session, a temporary bot's worker) as one more policy of the native `tool_approval` (`CHAIN_APPROVAL_POLICY`, `chain-folder`, with `policy` added to the request's scopes), so the public interaction schemas are unchanged. It is offered only on a request that can be allowed once and whose session has a known working directory; a session that is no bot's sees no change. The card shows it beside Allow, apart from the adapter's own rules. When the person chooses it, the Controller's session wrapper (`watchChainTurns`) sends the Relay `chain_approval` with `grant` (the chain is found from the turn's cause, as for every bot call) and hands the adapter an ordinary allow once; the adapter never hears the policy. The Relay keeps `BotChain.approvals` (kind as the adapter reports it, folder, when, how many times applied; at most 20 per chain; one entry per kind and folder). For each later native tool approval of a bot session, the Controller asks `chain_approval` with the kind (the tool name) and the folder; a standing approval of the same chain answers `allowed` and counts the use, and the Controller answers allow once through the session's own answer path, as the person's decision. A stopped chain (or the bot's stopped part of it) answers nothing; a chain past its retention takes its approvals with it. Another chain, folder or kind is asked as before; plan and form approvals and questions are never answered. The audit lists each chain's approvals (kind and folder, when, applied n times) and `revoke_approval` ("Ask me again") removes one. Also: a `/side` bot's `message` to its chief now returns `held` with a reason saying the answer shows beside the conversation, since nothing reaches the chief. Tests: Relay (recorded, applied by kind and folder, revoked, stopped, retention, limit), Controller (offered only on bots, recorded on the person's choice, answered for the same chain, folder and kind, not for another or after revoking), page (the card; the audit lists and revokes) and E15c (a real chain across two bots, another chain asked, the audit revokes).

Widened to every kind (owner, 2026-11-25): a standing approval is one grant per chain and folder (`StandingApproval` is `cwd`, `at`, `applied`; `chain_approval` and `revoke_approval` carry no kind). It answers every native tool approval of the chain's bots in that folder, Bash included; plan and form approvals and questions are still never answered. The audit lists "Any tool in <folder>" with how many times it applied. Tests: the Relay and Controller tests now prove that any kind in the folder is allowed and another folder or chain still asks (the folder condition was mutation-checked), E15c has the tracker ask for another tool kind.

## 9e. Asking for help shows on the page (decided: no)

Help is ordinary delegation by message and board item; the folded bot-message line and the board already show it.

## Delegation is one path (decided: 2026-11-25)

Asking another bot for help is handing it work: the base instructions say "work outside your mission goes to the bot whose mission fits (`list_bots`): hand it over by message and wait for its answer" (still v7). An item is assigned only by `create_bot` with the item or an explicit `update_board` assignee; a `message` naming an item tags the exchange and never changes the assignee, for staff, temporary bots and peers alike (the relation-based branch of af97cf2d is gone). The instructions tell a bot to assign with `update_board` (or `create_bot` with the item) when handing an item over.

## After the second record (2026-11-25)

The [second record](../reviews/2026-11-25-old-ways-with-bots-after-fixes.md) left four items, done here:

- **C-1, T-1: base instructions v8.** The delegation line covers missing knowledge without naming help: "What you cannot see or are unsure of (a convention, a decision, someone else's work), ask the bot that knows (`list_bots`, by mission) rather than guess or copy a neighbour; work outside your mission goes to the bot whose mission fits." A chief is told not to ask its staff for progress: read the board and wait for their reports. Asking is still handing work over; there is no special case. T-1 only gets the instruction here; the cause in the Relay (every routed answer starts a turn) is not changed.
- **S-3: the draft survived on the Relay.** The earlier fix cleared the page copy, but the shared draft sync publishes a change 800 ms later, and opening the side replaces the composer at once, which disposed the sync and dropped the pending publish. Disposal now publishes an edit that was still waiting.
- **N-1: a side's cost.** The code between the records adds under 1k tokens to a side's start (about 550 characters of base instructions and 2k of tool text; the tool count is unchanged), so the start is not the cause. The totals step by about one cached-context round (56k, 81k, 108k-112k), so the side made more model calls in its turn. The one change on a side's path is that its message to its chief now returns `held`, which the tool text describes as waiting for the receiver; the reason now says nothing answers it and not to resend or wait. This is inferred from the code and the token steps, not measured; the next record counts model calls per side.
- **9d widened** to every kind of tool action (see 9d).

## After the third record (2026-11-25)

The [third record](../reviews/2026-11-25-old-ways-with-bots-third.md) ranked what could still improve; three items are done here, one commit each:

- **N-1, N-4: a side answers by its final text.** The Host sends the final text of a temporary bot's turn as `side_final`; the Relay records it as the result of a `/side` bot (once, kept to the result limit of 4000 characters; any other bot's call is ignored) and the card shows it, so the card equals the side's page and no file is needed to hold a long answer. The side's brief and worker instructions say to answer in the reply, message no one and write no file it was not asked for (the seat carries `side`). A side's `message` still returns `held`, but nothing tells it to send one. Bring back is unchanged (it quotes the card). Expected: two fewer model calls per side.
- **T-2: an assignment notice carries the item.** When the board assigns an item to another bot, the notice reads `[Item 4 "title" changed · assigned to you · brief: ...]` with the item number and the first 500 characters of its brief on one line. `create_bot` with an item already names the item and the brief in its first message.
- **C-1, N-3: base instructions v9.** One generic line: "Copying a neighbour's style is a guess too: if a bot's mission covers it, ask that bot first." and "Do not start work no one asked for."; the redundant "Say how you now understand your work." is dropped. No special case for help.

- **T-1: final-text replies only for toolless providers (2026-11-25, the owner may revisit).** A bot that has the bot tools answers with `message`; its final text is never routed to a sender (the Controller asks `takesTools` of its provider before it sends `bot_reply`), which removes the loop where a turn's closing monologue was routed as `final answer to <message>`. The answer session of a mention and a side's result keep using the final text. Base instructions v10: "Answer a message with message and reply_to set to its id; your final text goes to no one."

## After the fourth record (2026-11-25)

- **N-7: an acknowledgement never holds a seat.** Cause: a delivery that carried an acknowledgement (9c) settled into a receipt that still had the `ack` field; the stored-team validation (`validSavedTeam`) does not allow it, so the Relay refused the settle with 409 and every later change to that team. The claimed acknowledgement stayed `dispatching` or `accepted` without `started`, the seat stayed `busy`, queued input behind it never moved, and `session release` answered `false`, across a Controller restart, because the state is the Relay's. The unit tests of 9c never saw it because their store did not validate on commit. Fix: a receipt drops `ack` (as it drops `chain`); a queued acknowledgement is no input on its way to a task worker, so it no longer hides that worker's ended turn. Tests: the real host broker settles a claimed acknowledgement and still validates the team; a held acknowledgement leaves a worker's ended turn counted.
- **N-9: `create_bot` with an item gives the bot the item's brief in its first input** (standing and temporary alike).
- **N-8: an assignee may name the item it was assigned on its chief's board in a `message`**; it only tags the exchange and never writes that board. The `message` text declares its 300-character limit in its schema as well as in the tool description.

Not done here: N-6 (reading persisted approvals that carry `kind`), S-4 and the roster preview of a finished team.

## Checks

Affected tests per sub-step; then Side and Call For Support simulated again with real bots and recorded beside the first record; then
the launch gate (full verification and the walkthrough) once at the end.
