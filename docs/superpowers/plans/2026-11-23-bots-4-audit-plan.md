# Bots step 4: chains and the audit

Step 4 of the [bots plan](2026-11-23-fold-into-assistants-plan.md), for section 7 of the [bots design](../specs/2026-11-23-bots-design.md).
The person sees what their bots do, and stops what they choose, instead of the Relay refusing on their behalf.

## What a chain is

A chain is the work one cause set off: an input the person sent to a bot, or a bot's timer coming due. Every message between bots,
every bot created and every turn that follows from it belongs to the chain, with the model usage the providers report.

## Who knows what

| Fact | Known by | How it travels |
|---|---|---|
| A turn starts from the person's input | The Controller: it frames every input that is not the person's | It starts a chain for the session: `c_` and 16 hexadecimal digits |
| A turn starts from a bot's message, a report or a room turn | The Controller, from the Team message it delivers | The message carries its chain; delivering it makes it the session's chain |
| A timer comes due | The Relay | The Relay starts a chain for the timer message |
| A bot calls a tool | The Controller | The call carries the session's chain; what it causes (messages, bots, room turns) carries it on |
| A turn's usage | The Controller, from `turn_completed` | `chain_turn {chain, usage}` after the turn |

The Relay keeps the chains: in hosted state, at most 200 per account, the oldest finished ones pruned first and none kept past
seven days. A chain record holds its cause (person or timer, and the bot), the bots it reached, counts of messages, turns and bots
created, its longest reply depth, usage, start and last activity, and whether the person stopped it.

## Sub-steps

### 4a. Chains recorded

- Protocol: `ChainId`; `TeamMessage.chain?`; `chain?` on the bot actions that cause something (`bot_message`, `create_bot`,
  `open_room`); `chain_turn`; `BotChain`, the record.
- Controller: the session's chain (set by the person's input or by a delivered Team message), sent with every bot tool call and
  with `chain_turn` at the end of a turn.
- Relay: chain records, updated by the calls; the Team messages it queues carry the chain; a timer starts its own.
- The hop limit goes: the depth along a reply chain is recorded in the chain, not refused (design 7). `recent` keeps hops only
  to answer `reply_to`.
- Tests: Relay unit tests with mock data (a person's chain through two bots and a created bot; a timer's chain; pruning); the
  Controller's chain on a delivered message and on a person's input; one E15 flow that reads the chain of a message exchange.

Built (`feat/bots-4-chains`, 7fcdbda1). As planned, with these choices:

- The Controller does not mint chain ids. It sends the cause of the turn (`{kind: 'person', messageId}` or `{kind: 'framed'}`),
  noted from the session's latest live `user_message`; the Relay names a person's chain from the session and message id, so a
  retried call lands in the same chain. Framed input continues the chain recorded on the member when the Relay handed it the
  message (`TeamMember.chain`, set at claim).
- The Relay runs each causing call in its chain's scope (`AsyncLocalStorage`, available in the Worker with `nodejs_compat`), and
  the one Team change wrapper stamps and counts what the call added: messages, bots reached and created, reply depth. No message
  path knows about chains. A room's turns moving on time keep the room's chain; a due timer starts one; a bot's standing
  instructions belong to no chain.
- Chains live in the account's broker state beside Call For Support state, at most 100, none past seven days, and are read at
  `GET v1/remote/chains` with the names of their bots. That route is the first part of 4b.
- Usage is the increase of the session's usage over the turn, by the same accounting as support groups.

### 4b. The audit view

- `GET v1/chains`: the account's chains, newest first, with their bots by name.
- Actions on a chain: stop it (its queued messages withdrawn, its bots' running turns interrupted), stop one bot's part of it.
  Actions on a bot: pause (its inbox holds messages until resumed), retire.
- Workbench: an Audit page in Settings' neighbourhood, a row per chain (cause, bots, messages, turns, usage, duration, live or
  stopped) opening to its timeline of messages; the actions above.
- Component tests on builder states; an E15 flow stopping a chain.

### 4c. Thresholds that notify

- The person sets thresholds for a chain (usage, depth, duration). Passing one sends a needs-you reminder through the existing
  attention path; nothing stops.
- Defaults: off until the person sets them; the audit page offers them.

Built: 4b (f4155245, bc116879) and 4c (bc116879).

- The audit is an item of Settings > Assistants rather than a page of its own: the decisions sit where the person sets how all
  bots behave, and the section loads its code only when shown. Each chain is a row with its cause, counts and tokens; it opens to
  its bots, each with the decisions that apply to its kind.
- Stopping marks `interrupt` on every member whose current chain is the stopped one; its Host cancels that session's running
  turn once per value. A stopped temporary bot is cancelled as a task. A later call in a stopped chain, or by a bot whose part
  was stopped, is refused with a sentence the bot can pass on.
- Pausing holds a standing bot's queued messages on the Relay (the poll does not show them and a claim is refused).
- Thresholds are kept per account beside the chains. Passing one is recorded on the chain (`passed`) and pushed once per chain
  and threshold as a needs-you reminder for the chain's first bot, through the Relay's push reminders, unless a visible page
  shows that bot.

## Bounds that stay

Sizes (messages of 300 characters, briefs, queues, Relay and Host storage) and the span of a chief (12 bots). They refuse
with a message that says which bound, as now.

## Order and checks

4a, then 4b, then 4c, each committed and verified with its unit tests, `pnpm build`, and E15 at the end of 4b. The full
`pnpm verify`, components and both e2e browsers at the end of step 4.
