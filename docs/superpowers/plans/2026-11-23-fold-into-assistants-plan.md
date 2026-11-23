# Fold Side, Call For Support, Team and TPM into assistants: plan

Decided 2026-11-23 with the owner; the design is section 10 of
[assistant coordinator and tasks](../specs/2026-11-23-assistant-coordinator-and-tasks-design.md#10-what-happens-to-side-team-call-for-support-and-tpm).

## Goal

One kind of bot: a name, a mission, and the abilities every bot has (tasks, messages both ways, rooms, work items, a timer). A bot
can serve other bots and be served by them, so no bot is a special kind. Ask stays as the way to look at any
session without touching it. Every older way of making sessions work together is rebuilt on these and then deleted, with its
records migrated, its panels and launchers removed, and its tools gone from every CLI.

Out of this plan: T0 (the P2 operation queue) and moving tasks, links and rooms off the Team path. The migrations here use the task
and message tools as they are; when T0 lands, those tools keep their names and only their delivery changes.

## Before the migrations

`feat/assistant-tasks` (with `feat/assistant-tasks-deployable`) is merged and deployed, Relay first, so assistants, tasks and
messages run in production.

## Step 0: the assistant record and the chain

- [ ] **The assistant record (T1, O70)**: ids that survive moving groups, the session a bot shows now, name, label, **mission**,
  **organizer**, **lifetime** (standing or temporary), peers. The mission reaches the main session as its standing instructions and
  is shown to other bots by `list_assistants`. Links, rooms, timers and reading a peer's conversation rest on it.
- [ ] **Chains** (design 10.7): every input the person sends, and every timer tick, opens a chain; messages, tasks, created bots and
  turns carry its id, with the usage providers report.

## Step 1: one kind of bot

- [ ] **No mode** (design Q4): remove the coordinator/plain switch, its `mode` field and `coordinatorProvider` negotiation; every
  bot whose provider takes tools gets them and the standing instructions at its next attachment, existing bots included.
- [ ] **A reply is the receiver's answer** (design 10.1): the final text of the turn a message started returns to the sender, unless
  that turn already answered with a tool; bots on providers without tools can be asked and are marked "answers only".
- [ ] **Tasks are temporary bots** (design 10.6): `create_task` creates one and sends its first message; task states, coalescing and
  approvals stay; it may ask bots and start tasks; listed in its organizer's details; kept by the person to become standing; after a
  settled result it takes more work by message for a while, then retires. `continue_task` is not built.
- [ ] **Bots create bots** (design 10, the mission): `create_assistant` (name, first mission, provider, model, Host, directory),
  `retire_assistant` for the bots a bot organizes, `update_mission` on a bot's own mission only; created bots in Chats in the
  organizer's group with who created them; the creation outcome framed to the organizer, the new bot's first turn returned as its
  report-in.
- [ ] **Each bot speaks for its own understanding**: the standing instructions require the report-in, a fresh one after a change,
  a compaction or a handoff, and every progress report in the bot's own words.
- [ ] **Reports and span** (design 10.8): reports and replies that cross are at most 300 characters (today `TASK_SUMMARY_LIMIT` is
  4000); details through `read_task` (built here) and attachments; at most 12 bots managed directly (today 4 running tasks per
  session), the thirteenth refused with the advice to create a sub-organizer.
- [ ] **Attachments on messages and task results**: files (a patch, a log) as resources; the receiver downloads one to a verified
  local file, never applies it.
- [ ] **Explicit delivery outcomes**: delivered, duplicate, forbidden, unreachable.
- [ ] **E2E flows for the model** (design 11, flows 1 to 5, rewritten for bots): two temporary bots report and the organizer sums
  up; one is interrupted from its thread; a worker's tool approval answered by the person; bot A messages B and B's answer comes
  back; a worker's Host offline until it returns. Chromium and WebKit; the gates of every later step.
- Gate: the person describes a team to one bot; it creates two bots with missions; each reports in with how it understands its
  mission; the organizer gives one a piece of work by message and changes how the other works by message (which records it in its
  own mission); a Copilot bot answers a question; the person sees all of it in Chats and can change any bot.

## Step 2: the audit (design 10.7)

- [ ] The audit view: each chain with what started it, the bots and tasks it reached, hops, turns, bots created, usage and
  duration, live while it runs; stop a chain, pause a bot, retire bots from there.
- [ ] The person's thresholds (usage, hops, duration) notify as a needs-you reminder and never stop work.
- [ ] The hop limit, the running-task limit and creation limits stop refusing and become audited facts; only storage and capacity
  bounds still refuse.

## Step 3: behaviour scenarios

- [ ] `pnpm test:bots` (local/native tier, by hand or nightly) with real Claude Code and Codex: a described team is created and every
  bot reports in with its mission; the main conversation's turns stay short and it does not do the work itself; a change needing a
  review goes to the bot whose mission fits; an adjusted bot restates its understanding and records what lasts; after a compaction a
  bot rereads its work items and restates; a chain past a threshold notifies the person.
- [ ] Checks read facts only: bots, missions, report-ins, hops, turns, tool calls per main turn, report lengths.
- [ ] The standing instructions live in the repository with a version; every change reruns the scenarios.

## Step 4: the Workbench of the model

- [ ] A task's thread beside the main conversation in Bot mode, with Interrupt, Queue, Mark done and Stop.
- [ ] The organizer's details as its team: standing and temporary bots with states and unread dots.
- [ ] Rooms as group chats in Bot mode, closed on time by a Relay timer (O71).

## Step 5: Side

- [ ] `/side` starts a temporary bot of the current bot: its mission is the person's first message, workspace `same`; its thread
  is the Side view.
- [ ] Existing Side relations are listed as temporary bots (done, openable); new Sides are only temporary bots.
- [ ] Delete Side creation and relation kinds, `/btw` follows `/side`.
- Gate: flows 1 and 2 with a task the person started; the Side cases of the component tier rewritten against task threads.

## Step 6: Call For Support becomes bots asking bots

- [ ] The standing instructions say that other bots have missions (from `list_assistants`), that a bot asks the one whose mission
  fits for a review, another model or another machine, and that the answer is advice.
- [ ] Verify in `pnpm local` that bots do this unprompted: a bot facing a change that needs an independent review messages
  the bot whose mission is reviewing.
- [ ] Profiles are not migrated: the person sets up the bots they want. The support settings say so once, then go.
- [ ] Delete profiles, enablement, support groups, calls, rosters and approval, ledgers, report framing, the four support tools,
  the support settings and panel views, the `callForSupport` and `readOnlyProvider` negotiation, and the `support_enablement` host
  call.
- Gate: bot A asks bot B (on another provider) to review an uncommitted change; B sees it (attached patch or read-only task) and
  answers; a follow-up reaches B with its context. Flow 4 extended accordingly.

## Step 7: Team

- [ ] A Team's Leader becomes an organizer bot; its members become bots it organizes, standing if they had their own conversation
  with the person, temporary otherwise.
- [ ] Existing Teams migrate that way, keeping each member's session.
- [ ] Delete the Team queue and inbox, Team delivery for kinds other than task, link and room, `team_message`, the Teams panel and
  its launcher. E7's Team case is rewritten for an organizer and its bots.
- Gate: flows 1 to 5; E7 rewritten.

## Step 8: work items and timers, then TPM

- [ ] **Work items for every bot** (design 10.4): plan, acceptance, todo, phase, summary and next action; `update_work`,
  `complete_work` and the todo and confirmation companions offered to every bot, not only to a TPM.
- [ ] Progress moves with inputs: replies from the bots it asked, its task results, the person's words and decisions. Turns that
  change nothing visible fold as background checks.
- [ ] The person sees work items in the bot's details and its chat row's business line; plan, acceptance and todo one step away.
- [ ] **A fallback timer** (design 10.5): `set_timer`, `clear_timer`; due only after a quiet interval, pushed back by any input,
  missed ticks coalesced; five minutes by default for a bot with an open work item. It replaces the heartbeat of session companions.
- [ ] A TPM becomes a bot whose mission is its work: its work items, todo and confirmations carry over; the main session it coordinated is
  the bot it messages.
- [ ] Delete `tpm_intent`, TPM's own delivery path, workspace and launcher.
- Gate: e2e flows written first: a progress bot asks a working bot, its reply updates the work item the person sees; a
  confirmation waits for Agree; with no input for the interval the timer wakes the bot once, and an input before then pushes it
  back; `complete_work` ends the item.

## Rules for every step

- One step per branch; it ends with `pnpm verify`, the e2e flows on Chromium and WebKit, and a check in `pnpm local`.
- Protocol fixtures, public schemas, replay and compatibility metadata change with the step that changes them.
- No release keeps both the old and the new path: the owner updates every Controller, so the Relay may require the new capability
  once the step ships (Relay first, then Controllers).
- `architecture/exceptions.json` entries for deleted modules are removed; nothing is added.
