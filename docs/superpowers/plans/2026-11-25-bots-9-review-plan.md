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

## 9b. Status check-ins without a model turn (decided: not now)

The board in a bot's details already answers "where are we?"; asking the bot still costs a turn. Revisit after use.

## 9c. Less closing chatter (decided: yes)

- Base instructions: after a delivery, do not acknowledge or thank; answer a report only when it changes what you do.
- A message whose only content is an acknowledgement ("received", "thanks", "noted") reaches the receiver folded and does not start a
  turn by itself: it waits for the next input. Measure turns and tokens of a Team run before and after.

## 9d. One approval per chain and folder (decided: yes)

- When the person answers a bot's native approval, they may choose "for this chain in this folder": the bots of the same chain asking
  for the same kind of action in the same working directory are answered alike until the chain ends. The person's own decision, applied
  by the Controller of each bot; listed in the audit with the chain, revocable there.
- Approvals of other chains, other folders or other kinds still ask the person.

## 9e. Asking for help shows on the page (decided: yes)

- A bot's conversation shows a one-line "Asked <bot>" where it messaged another bot for help or a review, with the answer folded under it.
- The asked bot's row in Chats shows who is asking it, while the request waits.

## Checks

Affected tests per sub-step; then Side and Call For Support simulated again with real bots and recorded beside the first record; then
the launch gate (full verification and the walkthrough) once at the end.
