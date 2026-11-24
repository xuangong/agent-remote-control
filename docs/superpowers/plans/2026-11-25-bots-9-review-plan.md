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
  for the same kind of action in the same working directory are answered alike until the chain ends. The person's own decision, applied
  by the Controller of each bot; listed in the audit with the chain, revocable there.
- Approvals of other chains, other folders or other kinds still ask the person.

## 9e. Asking for help shows on the page (decided: no)

Help is ordinary delegation by message and board item; the folded bot-message line and the board already show it.

## Delegation is one path (decided: 2026-11-25)

Asking another bot for help is handing it work: the base instructions say "work outside your mission goes to the bot whose mission fits (`list_bots`): hand it over by message and wait for its answer" (still v7). An item is assigned only by `create_bot` with the item or an explicit `update_board` assignee; a `message` naming an item tags the exchange and never changes the assignee, for staff, temporary bots and peers alike (the relation-based branch of af97cf2d is gone). The instructions tell a bot to assign with `update_board` (or `create_bot` with the item) when handing an item over.

## Checks

Affected tests per sub-step; then Side and Call For Support simulated again with real bots and recorded beside the first record; then
the launch gate (full verification and the walkthrough) once at the end.
