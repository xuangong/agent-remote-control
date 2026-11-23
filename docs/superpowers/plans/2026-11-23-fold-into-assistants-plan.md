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

## Step 2: Call For Support becomes expert assistants

- [ ] A profile migrates to an assistant: its name, coordinator provider, model and Host; its budget to the assistant's limits;
  its read-only and worktree workspaces to the workspace its tasks use by default. The migration runs once in the Relay and is
  idempotent; the person sees the new assistants in Chats.
- [ ] Coordinator instructions say when to ask an expert assistant (an independent review, another model or machine) and that its
  answer is advice.
- [ ] Delete profiles, enablement, support groups, calls, rosters and approval, ledgers, report framing, the four support tools,
  the support settings and panel views, `callForSupport` and `readOnlyProvider` negotiation where tasks replace them, and the
  `support_enablement` host call (the coordinators move to their own call).
- Gate: a session asks an expert on another provider for a review; the expert runs a read-only task and answers with findings and
  an attached patch; a follow-up reaches the same expert with its context. Flow 4 extended with the attachment.

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
  assistant in the Relay, delivered as `[Timer "<name>" · due]` when the main session is idle, missed ticks coalesced, ticks with no
  change folded as background checks. The heartbeat of [session companions](../../session-companions.md) is removed in favour of it.
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
