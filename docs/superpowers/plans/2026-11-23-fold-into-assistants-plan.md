# Bots: plan

Builds the [bots design](../specs/2026-11-23-bots-design.md), decided with the owner on 2026-11-23: one kind of bot with a
mission, messages between bots, chains for the audit, work items for progress; Side, Call For Support, Team and TPM folded in.

## Before

No intermediate release (owner, 2026-11-23): `feat/assistant-tasks` and `feat/assistant-tasks-deployable` are not deployed on
their own, since step 2 replaces their mode switch and tools. Steps 1 and 2 build on them as stacked branches, each its own PR, and
the first deployment (Relay first, then Controllers) follows step 2. Each step below is one branch that ends with `pnpm verify`, the e2e flows on Chromium and
WebKit, and a check in `pnpm local`; protocol fixtures, schemas and compatibility metadata change with the step that changes them.
No release keeps an old path beside its replacement: the owner updates every Controller, so the Relay requires the new capability
once a step ships (Relay first, then Controllers).

## Step 1: the bot record and the chain

Implementation plans: [1a, the bot store](2026-11-23-bots-1a-bot-store-plan.md); 1b (standing instructions) and 1c (chains) follow.

- [ ] Bot record (design 2.1, closes O70): `botId` stable across handoffs and moves, name, label, picture, mission, organizer (a bot
  or the person), lifetime, main, status, work item, peers. Existing bots get ids from their group views; name, label and picture
  move out of `WindowBotDetails`.
- [ ] Mission as standing instructions; base instructions in the repository with a version (design 5.1).
- [ ] Chains (design 7): every input the person sends and every timer tick opens one; messages and created bots carry its id and
  the usage providers report.

## Step 2: one kind of bot

- [ ] No mode (design 2.1): remove the coordinator/plain switch, `mode`, and `coordinatorProvider`; every bot whose provider takes
  tools gets the `agent_remote` namespace (design 5.1) and standing instructions at its next attachment; others are answers only.
- [ ] `create_bot`, `retire_bot`, `list_bots`, `read_bot`, `stop_bot`, `update_mission` (design 2, 5.1); creation outcome framed to
  the organizer and the first turn returned as the report-in (2.2); span of 12 (2.5); lifetime and retirement (2.4).
- [ ] `message` (design 3): `status` for progress, done, failed and needs input; delivery at idle in one order, combined into one
  input; replies from final text (3.3); 300-character bound (3.4); outcomes; `[The person wrote to …]` to organizers (3.5).
- [ ] Tasks become temporary bots: `create_task`, `report_task`, `ask_owner`, `message_task`, `task_status` and the task Team kind
  are replaced by `create_bot` and `message`; existing tasks are listed as retired temporary bots.
- [ ] Attachments, git bundles included (3.4, 5.3).
- [ ] Gate: the person describes a team to one bot; it creates two bots with missions; each reports in; the organizer gives one work
  by message and changes how the other works by message (recorded in its own mission); a Copilot bot answers a question; the
  person sees all of it in Chats and can change any bot. The e2e flows of design 11, written here, pass.

## Step 3: rooms, work items and timers

- [ ] Rooms as message targets with a Relay timer closing them on time (design 4, closes O71).
- [ ] Work items for every bot with todo and confirmation (design 6.1); `complete_work` retires the bots created for the item.
- [ ] Fallback timers pushed back by every message (design 6.2); the companions' heartbeat removed.
- [ ] Gate: a bot keeping a work item asks a working bot and the reply updates the item the person sees; a confirmation waits for
  Agree; a quiet interval wakes the bot once and a message pushes it back; a room of two bots and the person reaches a result.

## Step 4: the audit

- [ ] The audit view (design 7): chains live, stop a chain or one bot's part of it, pause, retire; thresholds that notify.
- [ ] The earlier refusals (hop limit, running tasks per session, creation limits) are removed; only system bounds and the span
  refuse.

## Step 5: behaviour scenarios

- [ ] `pnpm test:bots` with the release walkthrough (design 11). The base instructions are tuned here until it passes with Claude
  Code and Codex; every later change to them reruns it.

## Step 6: the Workbench

- [ ] Design 10: Chats grouped by organizer with status and work item lines; grouped reminders; folded lines between bots; the
  temporary bot beside its organizer with Send, Interrupt, Queue, Stop and Keep; details with bots, work items and the mission;
  rooms in Bot mode.

## Step 7: fold the older features

Each fold migrates its records, rewrites the feature's e2e cases on bots, and deletes the old path in the same branch (design 9).

- [ ] Side: `/side` creates a temporary bot; existing Side relations listed as retired temporary bots.
- [ ] Call For Support: profiles are not migrated; the support settings say so once, then go, with groups, calls, rosters, ledgers,
  report framing, the four tools, `callForSupport`, `readOnlyProvider` and `support_enablement`. Gate: a bot asks the bot whose
  mission is reviewing to review an uncommitted change, which it sees through a shared repository or a bundle.
- [ ] Team: a Leader becomes an organizer and its members the bots it organizes (standing when they had their own conversation with
  the person, temporary otherwise); the Team queue, inbox, `team_message`, panel and launcher go; E7's Team case is rewritten.
- [ ] TPM: a TPM becomes a bot whose mission is its work, its work items, todo and confirmations carried over; `tpm_intent`, its
  delivery, workspace and launcher go.

## Later

The P2 operation queue (IM session service) carries messages without changing the tools.
