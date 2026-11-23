# Fold Side, Call For Support, Team and TPM into assistants: plan

Decided 2026-11-23 with the owner; the design is section 10 of
[assistant coordinator and tasks](../specs/2026-11-23-assistant-coordinator-and-tasks-design.md#10-what-happens-to-side-team-call-for-support-and-tpm).

## Goal

The person keeps four ideas: an assistant, its tasks, messages between assistants, and rooms. Ask stays as the way to look at any
session without touching it. Every older way of making sessions work together is rebuilt on these and then deleted, with its
records migrated, its panels and launchers removed, and its tools gone from every CLI.

Out of this plan: T0 (the P2 operation queue) and moving tasks, links and rooms off the Team path. The migrations here use the task
and message tools as they are; when T0 lands, those tools keep their names and only their delivery changes.

## Before the migrations

`feat/assistant-tasks` (with `feat/assistant-tasks-deployable`) is merged and deployed, Relay first, so assistants, tasks and
messages run in production.

## Step 0: what the migrations need

- [ ] **E2E flows for the model** (design 11, flows 1 to 5): two tasks reported and summed up; a task interrupted from its thread;
  a worker's tool approval answered by the person; assistant A messages B and B replies; a worker's Host offline until it returns.
  Chromium and WebKit. These are the gates of every step below, since Side, Call For Support and TPM have no flow of their own and
  Team has one case in E7.
- [ ] **The assistant record (T1, O70)** first: ids that survive moving groups, the session a bot shows now, name and label as its
  responsibility, peers. Links, rooms, timers and reading a peer's conversation all rest on it.
- [ ] **A reply is the receiver's answer** (design 10.1): the final text of the turn a message started returns to the sender, so a
  bot on any provider can be asked; plain bots can receive messages.
- [ ] **Attachments on messages and task results.** A message or a report carries files (a patch, a log) as resources, as Team
  resources do today; the receiver downloads one to a verified local file, never applies it.
- [ ] **Assistant limits.** Per assistant: running tasks, task depth, and an optional budget measured as Call For Support usage is
  today (`call-for-support-usage.ts`); a task past the budget waits for the person.
- [ ] **`continue_task`.** A finished task's worker takes a new brief with its context, so a coordinator reuses a member.
- [ ] **`read_task`.** The main session reads a worker's recent conversation (the existing `session read`) instead of asking it.

## Step 1: Side

- [ ] `/side` starts a task of the current assistant: brief = the person's first message, no done-when, workspace `same`. The task
  thread is the Side view.
- [ ] Existing Side relations are listed as tasks (state `done`, openable); new Sides are only tasks.
- [ ] Delete Side creation and relation kinds, `/btw` follows `/side`.
- Gate: flows 1 and 2 with a task the person started; the Side cases of the component tier rewritten against task threads.

## Step 2: Call For Support becomes bots with responsibilities

- [ ] Coordinator instructions say that other bots have responsibilities (name and label from `list_assistants`), that a bot asks
  the one whose responsibility fits for a review, another model or another machine, and that the answer is advice.
- [ ] Verify in `pnpm local` that bots do this unprompted: a coordinator facing a change that needs an independent review messages
  the bot labelled for reviews.
- [ ] Profiles are not migrated: the person sets up the bots they want. The support settings say so once, then go.
- [ ] Delete profiles, enablement, support groups, calls, rosters and approval, ledgers, report framing, the four support tools,
  the support settings and panel views, the `callForSupport` and `readOnlyProvider` negotiation, and the `support_enablement` host
  call (the coordinators move to a call of their own).
- Gate: bot A asks bot B (on another provider) to review an uncommitted change; B sees it (attached patch or read-only task) and
  answers; a follow-up reaches B with its context. Flow 4 extended accordingly.

## Step 3: Team

- [ ] A Team's Leader is a coordinator; its members become its tasks' workers, kept for `continue_task`. A member the person names
  becomes an assistant.
- [ ] Existing Teams migrate: the Leader's assistant gets the members as finished tasks it can continue.
- [ ] Rooms move to Bot mode as group chats (O71), so the Teams panel has nothing left.
- [ ] Delete the Team queue and inbox, Team delivery for kinds other than task, link and room, `team_message`, the Teams panel and
  its launcher. E7's Team case is rewritten for a coordinator with tasks.
- Gate: flows 1 to 5; E7 rewritten; a room in Bot mode reaches a result.

## Step 4: timers, then TPM

- [ ] **Timers on assistants** (design 10.4): set by the person or the assistant (`set_timer`, `clear_timer`), stored with the
  assistant in the Relay, delivered as `[Timer "<name>" · due]` when the main session is idle, missed ticks coalesced. A timer that
  watches another bot is skipped, without waking the model, when that bot's conversation has nothing new, and may fire early when it
  has; ticks that change nothing are folded as background checks. The heartbeat of [session companions](../../session-companions.md) is removed in favour of it.
- [ ] Reading a peer's conversation at a tick, allowed by the watched assistant's peers.
- [ ] Todo and confirmation become companions any assistant may switch on, not TPM's own.
- [ ] A TPM becomes a project manager assistant: a timer (five minutes by default, as the heartbeat), messages with the assistant
  it watches, its todo and confirmations; `complete_work` becomes ending its work and clearing the timer.
- [ ] Migrate existing TPM sessions to project manager assistants.
- [ ] Delete `tpm_intent`, TPM's delivery path and its launcher.
- Gate: e2e flows written first on the new path: a timer tick reads the watched assistant and messages it; a quiet tick folds and
  sends no reminder; a confirmation waits for the person's Agree; ending the work clears the timer.

## Rules for every step

- One step per branch; it ends with `pnpm verify`, the e2e flows on Chromium and WebKit, and a check in `pnpm local`.
- Protocol fixtures, public schemas, replay and compatibility metadata change with the step that changes them.
- No release keeps both the old and the new path: the owner updates every Controller, so the Relay may require the new capability
  once the step ships (Relay first, then Controllers).
- `architecture/exceptions.json` entries for deleted modules are removed; nothing is added.
