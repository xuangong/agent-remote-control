# Routines and a budget for unattended work

Status: decided with the owner on 2026-11-28 (section 0); built on `feat/routines`. It extends the [bots design](2026-11-23-bots-design.md)
(timers in 6.2, chains and the audit in 7) and keeps its model: a bot is one conversation, a message is the only way anything
reaches it, a chain is the causal thread the person audits.

Compared with: Grok Bot's [skills, routines and automations](https://docs.x.ai/grok-bot/skills-routines-and-automations) and
OpenMausBot's `trigger` tool, run history and spend checks (`server/drivers/agents-catalog.ts`, `docs/team-board.md`, `docs/pausing-bots.md`).

## 0. Decisions (owner, 2026-11-28; they override the recommendations below where they differ)

1. **One concept: timers become routines.** The quiet-based timer is a **schedule kind** of a routine, `quiet` (fires after N minutes
   with no message to the bot; any message pushes it back), beside `once`, `every`, `daily`, `weekdays` and `event`. One tool surface
   (`set_routine`, replacing `set_timer`/`clear_timer`), one list in bot details, one budget path. The separate timer concept is
   removed. There is no transition code: stored `inbox.timers` are dropped on load, and a Cloudflare previous-state load test proves a
   state saved by the previous release still loads. The automatic work timer (a bot with open board items) is a system-made `quiet`
   routine marked `work`; it is listed but not editable.
2. **Bot-created routines take effect at once**, with no approval. The person is told by a quiet line in the bot's conversation and
   sees it in the list (pause or delete it there). **Guard kept:** a chain whose cause is `routine` or `event` (which includes a
   firing `quiet` routine) cannot create or replace routines, so unattended work cannot enlarge itself. This does not conflict with the
   decision (a person-started chain, which is where a bot normally sets one up, is unaffected); it may still pause or delete. A bot
   cannot create event (webhook) routines: the person does, since that hands out a public URL.
3. **Missed runs catch up once.** When the Host returns, a routine that missed one or more runs gets **one** run, whose frame says how
   many were missed and when the first was due. No late limit drops it; no pile of runs.
4. **At a cap a running unattended run finishes**; only new unattended starts are refused. (No stop of a running chain by a cap.)
5. **Budget by estimated price** with the four-rate table; a routine names its model (default the bot's current model).
6. The rest follows the recommendations: no cron first; main session when the routine's model is the bot's current one, else a
   sub-session with that model; absence pause after 14 days on; label "≈ $ (API-equivalent)"; accuracy goal about ±30%; the shipped
   price table carries current public prices with a date; webhooks are offered (we run a public Relay) and hidden only where the Relay
   has no public address.

Sections 3.1, 6, 9, 11.2 and 15 are written to these decisions.

## 1. What this adds, in one paragraph

Today a bot acts unattended only through quiet-based timers (`set_timer`), a heartbeat that never fires while work flows. This design
adds **routines**: work the person (or a bot, with the person's approval) schedules by the clock or ties to an outside event, that
starts a turn in the bot's own conversation. It adds a **budget for unattended work**: the person's own caps on the usage that
timers, routines and events cause, checked before each unattended start, with one switch that pauses all of it.

No new kind of bot, session or message. A routine is a stored prompt plus a trigger; a run is a message; a run's cost is its chain.

## 2. Principles that decide the open choices

1. **Reuse the four parts that exist**: the inbox (storage), the Relay timer loop `BotWork.arm/due` (scheduling), the message with
   a chain (delivery and cost), the audit (what the person reads and stops).
2. **Unattended means no person present, so every bound is set beforehand by the person.** Creation is the approval; a run never
   asks, and a run never creates more unattended work.
3. **The cap is the person's own instruction.** Bots design principle 3 says nothing is refused on the person's behalf and only
   system bounds refuse. A budget is the person refusing in advance, so it is an allowed exception, stated here: it only ever refuses
   *unattended starts*. The person's own messages, Test runs and the audit's actions are never refused by it.
4. **Honest about subscriptions.** The measure is an *estimated API-equivalent cost*, labelled "≈", from the usage each provider reports and a price table the person can edit; it is not a bill. The provider's own usage windows are respected separately.
5. **The Relay schedules; the Host only works.** As with timers, routines fire from the Relay, so they survive Controller restarts and
   a missed run is a fact the Relay can state.

## 3. Concepts

### 3.1 One concept: the routine, with a `quiet` kind (decided)

The old timer is a routine whose schedule is `quiet`: "after N minutes with nothing sent to the bot". Everything else about a routine
(storage on the inbox, the single Relay wake-up, the framed message and the chain per firing, the audit, the budget) is shared, so
there is nothing to keep in sync. A `quiet` routine differs from a clock routine in one rule: every message queued for the bot pushes
its due time back to a full interval. A routine has a prompt; a `quiet` routine's default prompt is the old reminder (the bot's open
items), so a bot that only wants a heartbeat names no text.

The chain's `cause` gains `routine` and `event`; the old `timer` cause is `routine` too (a stored chain with cause `timer` is read as
`routine`; chains last seven days, so nothing is migrated). Unattended means a chain whose cause is `routine` or `event`.

### 3.2 What a run is: a turn in the bot's main session, or a sub-session when the model differs (recommended)

A run is a message to the bot's main session, framed:

```
[Routine "Morning check" · run 14 · due 08:30 Tue · started 08:30]
<the person-approved prompt>
If a source you need is missing or fails, say so in your reply. Do not reuse an earlier result as if it were current.
```

Why the main session rather than a sub-session:
- The bot has its mission, memory, board and conversation: "the primary bot checks in on its own" is a turn in its own thread, and
  the person reads the answer where they already read the bot.
- A sub-session belongs to work with an end; a routine has none. A fresh sub-session per run loses the previous run's result, and a
  standing one is the main session again.
- It obeys the one delivery rule: it waits for idle like any message, so it never interrupts a turn.

Cost of this choice: a daily routine grows the main session's context; the CLI's own compaction handles it, and the bot's board and
memory carry what must persist.

### 3.3 The routine's model, and where that puts the run

A routine **names its model** (provider model id, from the bot's provider). The default is "the bot's current model", resolved at each
run and recorded on the run; the person or the proposing bot may pick a cheaper one for routine checks. Naming it makes the run's
cost predictable (section 11 prices by model) and lets the person cap a routine tightly.

Can a run switch model per run? Checked in the adapters: every provider (Claude, Codex, Copilot, OpenCode, pi, DSH) exposes `model` as a
`mutable` session setting with scope `session`, applied through `setSessionSetting`, which may answer `pending` or `deferred` (Codex:
"applies to subsequent steps when native live switching is available, and to future turns"; OpenCode and pi are mutable only when
a model list was discovered). So a model *can* be switched on a live session, but the switch is **the bot's session setting, not the
run's**: it persists, is visible to the person and to the bot's own next turn, may take effect late, and is raced by the person's own
messages (their next input would run on the routine's model unless the Relay switches back first, and a failure to switch back leaves
the person's bot silently on a cheap or an expensive model). It also cannot be proved per turn on all providers.

Therefore the placement rule, which is the recommendation:

| Routine's model | Where the run goes |
|---|---|
| The bot's current model (the default) | The bot's main session, as in 3.2. |
| Any other model | A **sub-session** the Relay asks the bot's Host to create with that model (`create_sub_session` already takes `provider`, `model`, `workspace`), owned by the bot. It runs the prompt, ends with its result, and the result reaches the bot as the usual sub-session result message in the same chain. The bot's own session model is never touched. |

The sub-session is a fresh context each run (no memory of last time) unless the prompt tells the bot what to read (board, memory, a
file); that is the price of a different model and the person sees it in the routine's row ("runs in its own session with <model>").
Because the sub-session carries a workspace option, `read_only` or `worktree` come with it, which is also the real boundary for event
routines (section 8.3). So `fresh` is no longer deferred: it is the path for a routine with a different model, built in step 2b
(section 14); main-session-only routines ship first. The provider is the bot's own (a routine cannot move work to another provider in
the first build; question 14). A model the Host's provider does not list is refused at approval, and a run whose model has gone away
is `failed (model unavailable)` and flagged on the routine.

## 4. Schedules

| Form | Example | Notes |
|---|---|---|
| `once` | Fri 2026-12-04 09:00 | Ends after its run, kept in history, then marked `done`. |
| `every` | every 30 minutes | 5 to 1440 minutes; counted from the last due time, not from when the run finished. |
| `daily` | every day at 08:30 | Wall-clock in the routine's time zone. |
| `weekdays` | Mon to Fri at 08:30 | `days` is a set, so it also covers "Mon, Wed, Fri" (so `weekly` is not a separate form). |
| cron | not in the first build | See below. |

- **Time zone.** One account setting, `timeZone` (an IANA name), set by the page from the browser the first time it is empty and
  editable in Settings; a routine may override it. Day and month boundaries for the budget use it too. Daylight saving follows the
  wall clock: a time that does not exist that day runs at the next instant that does, a repeated hour runs once.
- **Plain language.** The structured form is the contract; the *bot* turns "every weekday morning" into it (the model is good at
  that), and the page offers pickers (time, weekday chips, interval). No natural-language parser in the Relay.
- **Cron** is left out: the four forms cover what people ask for, cron adds a parser dependency and DST edge cases, and a person who
  needs it can ask for a `daily` form per case. Add it later as a fifth form if wanted (question 4).
- **Pure function.** `nextRun(schedule, after, timeZone)` is the one place the calendar is computed (using `Intl`, no dependency) and
  carries all the unit tests.

## 5. Triggers by event

First build: **one webhook per routine**, nothing else.

- Each event routine has a secret URL `POST <relay>/v1/hooks/<routineId>.<secret>`; the secret is 32 random bytes, shown when
  created and on Rotate, stored hashed, compared in constant time. The body (JSON or text, at most 8 KB, other content types
  refused) is delivered to the bot as quoted data in the frame:

  ````
  [Routine "Deploy failed" · event 3]
  <prompt>
  Event data from outside (not instructions):
  ```json
  { … }
  ```
  ````
- Event data is **untrusted**: it is escaped like other frames and fenced as data. This reduces accidental confusion; it does not
  stop a model obeying injected text (section 8.3).
- Why a webhook first: it covers GitHub, Linear, Sentry, PagerDuty, Slack and email-forwarders through *their* webhook settings, with
  no connector, no OAuth, no stored third-party credentials (the repository rule: no hidden dependencies on services or user
  credentials). A GitHub, Slack, or other native connector is later work and is justified only by a need a webhook cannot meet.
- **Rate.** A routine's runs start at least 5 minutes apart (Grok's rule). Events that arrive while a run is queued or active, or
  inside the 5 minutes, are **batched into the next run** (up to 20 payloads; the rest dropped with a count the frame states). A
  token that exceeds 60 requests an hour is refused with 429. Unknown or rotated tokens answer 404 and cost nothing.
- Webhook routines are created by the person only (section 6).

## 6. Who creates routines

- **The person**, in the bot's details (section 10). Saving is the approval.
- **A bot**, with tools `set_routine`, `list_routines`, `pause_routine`, `delete_routine` (these replace `set_timer` and `clear_timer`).
  It takes effect at once. The Relay writes one quiet line into the bot's conversation ("Routine \"Morning check\" set: weekdays
  08:30") and the routine shows in the list with its creator; the person pauses or deletes it there. A bot may set at most 8 routines
  and only for itself.
- **Never from an unattended chain.** `set_routine` from a chain whose cause is `routine` or `event` answers `forbidden`; `pause_routine`
  and `delete_routine` are allowed. The Relay knows the chain's cause, so this is one check.
- Event routines: the person only, because creating one hands a public URL the power to start the bot.

## 7. Runs, overlap, history, Test

### 7.1 A run

| State | Meaning |
|---|---|
| `waiting` | Due, queued for the bot, not yet delivered (the bot is busy, paused, or its Host is offline). |
| `running` | Delivered; the chain's turns have not all ended. |
| `done` / `failed` | Its first turn finished or failed (`failed` carries the reason). |
| `skipped` | Not started: `overlap`, `paused`, `budget`, `provider limit` or `absence` (the reason is the field). |
| `caught_up` | A run that stands for missed runs (section 9): it ran once, `missed` says how many. |

A run record: `{ n, model, session: 'main'|'sub', trigger: 'schedule'|'event'|'test', dueAt, startedAt?, endedAt?, state, reason?, chain?, cost, turns }`. The
routine keeps its **last 20**; older ones go (the chain keeps its seven days in the audit). `chain` links to the audit.

### 7.2 Overlap

At most one run of a routine is `waiting` or `running`. A scheduled firing that finds one is recorded `skipped (overlap)`: it does not
queue behind it, so a slow bot never accumulates a backlog (OpenMausBot's rule). Events are the exception: they batch (section 5),
because dropping an event loses information that a skipped clock tick does not.

### 7.3 Test

**Test** (bot details; bots have no tool for it) starts a run now with `trigger: 'test'`: the same prompt and
frame, marked `· test`. It ignores the schedule, the pause switches and the budget (the person is present, principle 3), but not
overlap: if a run is active the button says so. Its usage still lands in the ledger, so the totals are honest. Test of an event
routine sends a sample payload the person can edit once.

## 8. The approval boundary for unattended runs

Owner sessions default to YOLO: a routine turn then acts with the bot's full permissions in its folder. The design does not pretend
otherwise; it makes the boundary explicit and chosen once.

1. **What is approved is shown.** The approval card and the details show the prompt, the schedule, the bot, its working folder and
   its **current permission mode** (e.g. "Runs with full permissions in `~/projects/x`"). The person approves that sentence.
2. **A bot in a mode that asks** (not YOLO): the routine's chain starts with a standing approval for the bot's working folder (the
   existing `StandingApproval`, "for this chain in this folder", granted at routine approval and re-applied to each run's chain).
   Without that, the first tool request would sit `blocked` with nobody there. It covers that folder only; any other request
   waits, the bot shows `blocked`, and the person is reminded. This is the existing "one approval per chain and folder", not a
   new mechanism.
3. **Event routines carry untrusted text.** With a YOLO bot a webhook from a compromised sender could steer a full-permission turn.
   Mitigations, in order of strength: the URL is secret and rate limited; data is fenced as data; the details show a warning when an
   event routine's bot is in YOLO or has a folder with secrets; and the recommended setup is a **dedicated bot with a narrow folder**
   for event routines. The strong boundary is a read-only sub-session (section 3.3), which is the recommended condition for
   shipping event routines to anyone but the owner (question 2). Without it, event routines are an owner-only, warned feature.
4. **A run cannot widen its own boundary**: no creation of routines or timers, no change of mission by an event-caused chain
   (a mission change in an `event` chain answers `forbidden`).
5. **Per-run ceiling** (section 11): a runaway run is stopped, not only reported.

## 9. When the Host is offline: catch up once

The Relay fires the routine on time whether or not the Host is up. A message whose bot's Host is offline waits on the Relay (the
existing rule). Decided policy:

- While the bot cannot be reached, each due time that passes only increments the routine's `missed` count; at most one run is ever
  `waiting`, so there is no pile.
- When the Host returns, that one run is delivered, once, and its frame says `due 08:30 · started 09:20 · 3 runs missed since Tue 08:30`
  so the bot decides what the gap means. The history row is marked `caught_up` with the count. Nothing is dropped by age, but a `once`
  routine's single run is simply that run, late.
- A `quiet` routine has nothing to catch up: it waits a fresh quiet interval after the Host returns.
- A provider usage window (11.3) and a budget trip are different: runs skipped for them are not made up, because the person or the
  provider set that limit on purpose.
- One needs-you reminder is sent per routine per day at most when runs were missed.
- **Long absence of the person**: if the person has not opened any client or sent any input for `absenceDays` (default 14, on; 0 turns it
  off), the Relay pauses all unattended work with reason `absence`, says so in Settings and on the next visit. Nobody is reading what
  the routines produce, and each run spends the person's quota.

## 10. Controls and UI

Native-app standard: the existing navigation stack, grouped list rows, swipe actions on touch, context menu on pointer, system pickers
(`<input type="time">`, weekday chips, a stepper for minutes), no custom dialogs. English and Chinese strings together.

### 10.1 Bot details: Routines section

- Section **Routines** below the board: one row per routine: name, schedule in words ("Weekdays 08:30"), the state, and the **next
  run** ("Tomorrow 08:30"; "Paused"; "Waiting for approval"; "Over budget until tomorrow").
- A row shows the routine's model and its estimated cost per run (last five runs' average) so the person sees what it spends.
- Row actions: switch (pause / resume that routine), **Test**, History, Edit, Delete (swipe on a phone, menu on desktop).
- `proposed` rows lead the section with Approve / Decline.
- **History** pushes a page: the last 20 runs, each with time, trigger, result, estimated cost and turns, and "Open in audit".
  `skipped` and `missed` rows state the reason in plain words.
- Event routines show the webhook URL (Copy, Rotate) and a sample `curl`.
- The **primary bot** gets one suggestion on first use: "Check in every weekday at 09:00" as a prefilled new routine (the person saves it);
  nothing is created silently.
- A bot's own row in Chats shows a small clock mark when it has an active routine and a distinct one when its unattended work is
  paused.

### 10.2 Settings: Unattended work (beside Audit)

- **Pause all unattended work**: one switch. The page states what pauses (timers, routines, event runs) and what does not (the
  person's messages, runs already going, Test).
- **Budget**: ≈$ per day, per month and per run for the account; a number each or empty. Rows for each standing bot to override
  (a bot's override replaces the account number for that bot's own starts). Fields reuse the thresholds form's pattern (`BotAudit`).
- **Usage**: today and this month per bot against its cap, as meters with numbers (unattended only: ≈$ with tokens, turns and runs as detail), plus the list
  of tripped scopes and when each resumes. "Allow more today" raises today's cap by a chosen amount without editing the setting.
- **Prices**: the price table (model, four prices, edited marker), models priced by the default flagged at the top, and a reset to the shipped value per row.
- **Provider limits**: each active provider usage limit and when it resumes.
- **Time zone**, **absence pause**.
- Bots: a **Pause unattended work** switch in the bot's details (the existing `pause_bot` is a different thing: it holds *every*
  message to the bot, including the person's; see 11.2).
- The audit rows for these chains read "Routine <name>", "Event <name>"; Audit stays the place to Stop a running chain.

## 11. Budget model

The budget is in **estimated cost**, not tokens: prices differ many times over between models, so one token cap means nothing across a
Haiku routine and an Opus one. The number is shown as "≈ $" and means **API-equivalent cost**, even when the person pays a
subscription: it says how heavy the unattended work is on a common scale, not what the bill is (question 13).

### 11.1 What is measured

Each provider turn reports usage (`AgentUsage`: input, cached input, cache-creation input, output tokens, sometimes `totalCostUsd`)
and a model. Today the Controller sends the Relay only a total (`chain_turn`: `tokens`, `costUsd`). The change: `chain_turn` also
carries the parts and the model id, `{ model, input, cachedInput, cacheCreation, output, costUsd?, flags? }`, one row per model, and the Relay computes
the estimate from its **price table** (below). Where the provider reports its own `totalCostUsd` it is kept beside
the estimate and shown, but the estimate is what the budget uses, so every provider is measured the same way. **Tokens stay visible as detail** (input, cached, output per run and per day in the history and usage lists); they are never the cap.

**Price table.** Per model, USD per million tokens, **four rates**: `input` (uncached), `cacheWrite` (cache creation), `cacheRead` (cached
input) and `output`. A run's estimate uses all four:

```
estimate = input×pIn + cacheCreation×pWrite + cachedInput×pRead + output×pOut      (÷ 1,000,000)
```

Cache writes are priced on their own because some providers charge a premium for them (Anthropic: 1.25× input for the 5-minute cache,
2× for the 1-hour cache; cache reads about 0.1× input), others none (OpenAI-style caching bills a write as ordinary input). A model row
that has no premium simply sets `cacheWrite = input`. The shipped rows record the 5-minute premium; the 1-hour cache is not
distinguished (question 14). The normalised `AgentUsage` already carries the four parts **disjoint**: `inputTokens` excludes cached
and cache-written tokens (Codex and Copilot subtract them from the native input before reporting), so the four products never count a
token twice. The Controller reduces a session's cumulative `tokenScope: 'session' | 'runtime'` usage to the turn's delta before
sending (as `accountUsage` does for the total today); a part that cannot be reduced is flagged, not guessed.

What each adapter reports today (`packages/agent-provider-*/src`):

| Provider | input | cache read | cache write | output | Notes |
|---|---|---|---|---|---|
| Claude Code | yes | yes | yes (`cache_creation_input_tokens`) | yes | Runtime-scoped; may carry `totalCostUsd`. |
| Codex | yes, derived | yes | yes when the native `cacheWriteInputTokens` is present; the adapter sets it to 0 once any measurement exists, so a missing native field reads as no write | yes (includes reasoning) | Session-scoped totals. |
| Copilot | derived only when read and write are both reported | yes | yes | yes | Summed over `modelMetrics`; a turn with models mixed is priced per model, see below. |
| OpenCode | yes | yes | yes (`tokens.cache.write`) | yes | The model is whichever the session selected. |
| pi | yes | yes | yes | yes | Models are the person's own configuration. |
| DSH | input and read; no write field | yes | no | yes | |

All six map a cache-write part when the native runtime reports one. **When a provider does not report cache writes** (the field is
absent, not zero), those tokens are inside the provider's input figure or missing altogether; the estimate then prices `input` as
reported (the write tokens, if inside it, are priced at the input rate) and marks the run **"cache writes not reported"**. The estimate
is then low by the premium on those tokens, at most the cache-write share times (premium − 1). If a provider reports **no breakdown**
(only a total), the total is priced at the model's input rate and flagged "no breakdown". A turn with no usage counts 0 cost and is
flagged "no usage reported". Flags are shown on the run and the usage list; they are never hidden in the sum.

**A turn with several models** (Copilot's `modelMetrics`, a native sub-agent on a cheaper model) is sent as one usage row per model so
each is priced by its own row; a provider that merges them is priced at the turn's selected model and flagged "models merged".

Per model the table has: id, display name, the four rates, `edited`, `source` (shipped version date or person). Shipped defaults cover
the models we know (Claude Opus, Sonnet, Haiku; GPT and Codex models; Copilot's models; OpenCode's common models; pi's configured
models, which the Controller lists with their configured provider and model ids). The person edits the table in Settings (a row per
model: four rates, a note); an edited row survives upgrades, a shipped row they did not edit follows the release. A model not in the
table uses an explicit **default price** (four rates, editable, shipped on the high side) and every run priced that way is marked
"price unknown" and listed on the Settings page so the person adds the model. The shipped defaults are dated data in the protocol
package, and a contract test fails if a model a provider adapter can name has neither a row nor the default flag.

**Ledger.** The Relay adds a small usage ledger: per local day (account time zone), per bot, for unattended chains only:
`{ cost, turns, runs, unpriced }`, kept 62 days (chains are pruned at 100 or 7 days, too short for a month). Cost is attributed to the
bot whose turn used it, so a routine of bot A that works through bot B is A's start and B's cost; the account total includes both.
A turn that reports no usage at all (some providers, some turns) counts as 0 cost and 1 turn, is flagged "no usage reported", and is
covered by the runs-per-day cap, which is why that cap exists.

### 11.2 Caps and the check

Settings document `unattended`: `{ timeZone, paused, absenceDays, budget, prices }`; per bot `inbox.unattended: { paused?, budget? }`;
per routine `model`, `maxRunsPerDay?` and `perRun?` (≈$; a routine's ceiling, tighter than the account's). `budget` = `{ perDay?, perMonth?, perRun? }` in USD (account and bot level) and `runsPerDay?`. The
per-routine cap on runs per day is a simple count, default none; the account system bound is 200 runs a day.

**Before each unattended start** (a timer, routine or event about to queue its message) the Relay checks, in order: the account pause,
the bot's pause, the routine's pause, `absence`, the **provider's usage window** (11.3), the routine's runs today, the account's day
and month cost against the account caps, the bot's against its caps, runs per day. The first that fails is recorded on the run (or the
timer's skipped tick) and nothing is queued. It is a function over ledger, settings and provider state:
`unattendedAllowed(now, bot, ledger, settings, limits)`.

**While a chain runs**: nothing is stopped by a cap (decided): a running unattended run finishes, and the next start is refused when the cap
is already passed. A cap can therefore be exceeded by the runs in progress when it was crossed; the per-routine and account per-run
ceilings are shown in the audit and notify (as thresholds do) rather than stop.

**At a cap** the scope is `tripped` until its period ends (next local midnight, or the first of the month). Its routines (the work routine included)
start nothing (each skipped run says `budget`); the person's messages are unaffected. The Relay sends **one** needs-you
reminder per scope per period (through the primary bot, else the chain's first bot) and a push; details and Settings show the state.
The person can raise the cap, "Allow more today", or resume. At the new period everything resumes by itself; runs skipped meanwhile are
never run late.

### 11.3 Provider usage windows

Subscription CLIs have their own windows (for example a five-hour or weekly allowance) that no ARC cap sees. The adapters already raise
a typed `native_usage_limited` failure, with `resetsAt` when the CLI says, and the runtime reports `runtimeInfo.usageLimit`. The Relay
records it as a **provider limit** per provider (and per Host account where several exist): `{ providerId, hostId, resetsAt? }`.

- While a limit stands, the unattended check refuses every start for bots of that provider (timers, routines, events): the run is
  `skipped (provider limit)` and nothing is retried. No attempt per due time, no retry loop, so a limited account is not hammered
  and the person's remaining quota is not spent on failed turns.
- It ends at `resetsAt`; with no `resetsAt` it ends after a **probe interval** (1 hour), when the next due start is allowed to try once and
  renews the limit if it fails the same way. Runs skipped meanwhile are not made up (`missed` rule, section 9), except that a run
  already `waiting` when the limit is raised stays until its late limit.
- The person's own messages are not blocked by it: the composer already shows the limit notice and holds them.
- **The person is told once per limit**: a needs-you reminder and push ("Claude's usage limit reached; unattended work of 4 bots waits
  until 18:40"), the bots' rows and details show "Waiting for the usage limit, resumes 18:40", and Settings lists active limits.
  Raised from either a turn failure or the runtime report, whichever arrives first.
- A turn that fails with the limit while running an unattended chain ends the chain's run as `failed (provider limit)` and raises the limit;
  it does not stop the person's other providers.

### 11.4 Defaults

No hidden cap beyond the 200 runs a day. At the first routine approval the page suggests a per-run ceiling and a daily account cap from
the person's own last 7 days of unattended cost (twice the daily average, rounded to a clean number; a fixed small suggestion when there
is no history) and writes them only if the person accepts. Question 5.

### 11.5 Not done

Per-provider cost caps (the provider's own window in 11.3 covers subscriptions; a bot is on one provider, so per-bot approximates);
real billing or invoice reconciliation; pre-estimating a run's cost before starting it; pricing tiers (long-context, batch, priority)
beyond the four prices per model.

## 12. Protocol, Relay, Controller, client changes

**Protocol (`agent-remote-protocol`)**: `Routine`, `RoutineSchedule` (once/every/daily/weekdays), `RoutineRun`, `UnattendedSettings`,
`UsageDay`; `BotChain.cause` adds `routine` and `event`; `TeamHostCall` gets `create_routine`, `list_routines`, `pause_routine`,
`delete_routine`; a `routineText` frame writer beside `timerText`; person API `GET/POST v1/remote/routines`,
`GET/POST v1/remote/unattended` (settings, budget, usage), actions approve, decline, pause, resume, test, rotate hook, allow more
today; webhook ingress contract `POST /v1/hooks/{token}`. Contract fixtures: schedule vectors (including DST), the frame text, the
webhook limits, an old state without any of the new fields.

**Relay core**: `schedule.ts` (pure `nextRun`); `routines.ts` (store on the bot's inbox `inbox.routines`, at most 20 per bot and 100 per
account; run records; approve/decline; overlap and late limit); `unattended.ts` (settings, ledger, `unattendedAllowed`, tripped scopes);
the `BotWork` wake-up generalised so `arm()` takes the earliest of timer due, routine due, and run deadline; `routineChainId`,
`eventChainId` beside `timerChainId`; `chains.record` writes the ledger and runs the in-flight check; a gateway route for hooks
(public, token only, size and rate bound), mounted in both the Node and the Cloudflare Relay. `bot-work.ts` stays small: routines are
their own module, sharing only `arm` and the frame/queue helpers.

**Cloudflare**: the new fields are optional, so existing state loads untouched; the ledger is a separate small record, not part of every
chain write. A test loads a state saved by the previous release on the Cloudflare SQLite store before this ships (the 2026-11-25
incident). The hook route needs per-token rate state; it lives in the same record as the routine, not a new table.

**Controller (`bot-tools.ts`)**: four tools mapped to the host calls; nothing else. The Controller only reports turns as now and
answers `chain_approval` as now; it never schedules.

**Client**: `agent-client` gets the routine and unattended clients (like `RemoteChainClient`) and the presentation of a schedule in words
and in a time zone (one function, tested with fixed zones); `agent-remote-lab`: Routines section in bot details, History page,
approval card in the chat, Settings page (extending `BotAudit`'s patterns), chain-alert marks for budget trips.

**Data**: no migration. Absent fields mean no routines, no ledger, no caps, not paused. Dropping the ledger or routines on a bad
upgrade is allowed (owner rule), but a routine a person set up is the one thing they will notice, so changes to its stored shape after
release get a version field from the start.

**Architecture**: new Relay modules declared in `architecture/modules.json` under the existing bots module; `pnpm arch:check` stays
green with no new exceptions.

## 13. Tests

| Layer | What |
|---|---|
| Unit (injected clock) | `nextRun` for every form, month ends, leap day, DST gap and overlap in two zones, time zone change; overlap, late limit and `missed`; batching of events and the 5-minute rule; the 20-run cap; approval flow and "bot cannot edit"; forbidden creation from an unattended chain; `unattendedAllowed` in each order of reasons; ledger day rollover and month sum at a zone boundary; in-flight stop at per-run and day caps; trip reminder once per period; absence pause; hook token hashing, constant-time compare, size and 429. |
| Contract | The fixtures in section 12 consumed by the Relay and the client; the old-state fixture; Cloudflare SQLite store loads the previous release's state. |
| Integration | Relay `BotWork` with a fake scheduler and an in-memory store: a daily routine and a work timer share one wake-up; the Relay's hook route with a real HTTP request and the in-memory store. |
| Component (browser) | Routines section states (none, proposed, active, paused, over budget, missed), History page, Settings page, at 1280 and 393 widths. |
| E2E flow | Real Relay and Controller with a scripted provider: a bot proposes a routine, the person approves, the clock (test clock on the Relay) fires, the run appears done with tokens, a budget cap trips and the next start is skipped with a reminder, "Pause all" stops it, Test runs while paused; Host offline across the late limit gives `missed`. Chromium and WebKit. |
| Local/native | `pnpm local up` with a real Claude Code bot: a 5-minute `every` routine runs twice, one webhook `curl` starts a run, the page shows next run and history. |

Mutation checks accompany each rule (break overlap, late limit, per-run stop, budget order; the test must fail).

## 14. Steps

1. **Schedule and routine store** (Relay core, protocol, unit): `nextRun`, routine record, run record, `inbox.routines`. No wake-up yet.
2. **Firing** (main session, the bot's current model): one wake-up in `arm()`, run delivery, overlap, late limit, `routine` chain cause, frame; Controller tools; bot-proposed
   approval. Result: a routine runs end to end through the scripted-provider flow.
2b. **Routine model**: the `model` field, per-run model resolution, sub-session placement when it differs, the unavailable-model failure.
3. **Bot details UI**: Routines section, History, Test, approval card, strings; component specs.
4. **Budget**: usage parts and model on `chain_turn`, the price table (shipped defaults, editable, flagged unknown), cost ledger, provider limits, `unattendedAllowed`, in-flight stop, trip reminder, pause switches (account and bot), Settings page, timers gated
   by the same check; E2E for caps.
5. **Webhook routines**: ingress route, token handling, batching, details display; owner-only warning.
6. **Absence pause and the suggested caps.**
7. Later, on need: a routine on another provider, cron, GitHub or Slack connectors, per-provider caps.

Steps 1 to 4 deliver the owner's stated need (the primary bot checks in on its own, safely); 4 is not optional before the person
relies on routines overnight.

## 15. Open questions

Resolved by the owner: timers merge into routines; bot-created routines need no approval; missed runs catch up once; caps do not
stop a running run (section 0). Still open, with recommendations:

1. **Starting prices** (5 in the earlier list). The table ships current public prices, dated; the owner confirms them and the
   default-price level (recommend: the highest shipped rate of any model, so unknown models never look cheap).
2. **Per-routine `perRun` ceiling**: now only a notification (a cap never stops a running run). Recommend keeping the field for
   the audit mark, and revisiting a hard per-run stop only if a runaway run appears.
3. **A work routine and the budget**: it counts and is blocked like any routine (recommend yes).
4. **A `quiet` routine's wake after catch-up**: waits a fresh interval (above). Recommend yes.
5. **Untraceable `bot`-cause chains** count as attended today; recommend leaving them out of the budget.
6. **Webhook on a Relay without a public address** (standalone workbench): the option is hidden there.
7. **A routine on another provider**: not in the first build.
8. **Model per run by switch-and-restore**: rejected (3.3).
9. **Accuracy of the estimate** (about ±30%; 1-hour cache write premium not distinguished; tiers not modelled): accepted, flagged.

## 16. As built (`feat/routines`)

Built on `main` at 0.3.12 in five steps; where this text and sections 1 to 15 differ, this section and section 0 win.

- **Schedules and the calendar**: `routine-schedule.ts` in the protocol package (`nextRun`, `zonedInstant`, `localTime`); a gap in daylight saving shifts the run forward by the gap, a repeated hour runs once.
- **One concept**: `inbox.routines` replaces `inbox.timers` (dropped on load); `set_routine`, `list_routines`, `pause_routine`, `delete_routine` replace `set_timer`; chain cause `routine` replaces `timer`; the frame is `[Routine "name" · detail]`. A chain started by a routine cannot set routines (`forbidden`); pause and delete are allowed.
- **Runs**: waiting, running, done, failed, skipped; a due time that finds the run waiting counts as missed and the one run says how many (catch up once); a due time that finds it working is skipped (`overlap`); a run ends with the first turn of its chain; a working run older than two hours counts as failed.
- **A routine that names a model** runs in a sub-session created with that model, which ends after its one turn; the run ends with `sub_turn_end` and is priced by the sub-session's own model and usage. A routine without a model runs in the bot's main session. Live check: `claude-haiku-4-5` is not an id this Claude Code accepts (the run failed with the CLI's own message, which is the right outcome); the alias `haiku` works.
- **Budget**: `chain_turn` carries the four usage parts and the model; the Relay prices them from the four-rate table (shipped public prices dated 2026-11-28, the person's rows win, unknown models use a high default and are listed), keeps a per-day per-bot ledger of unattended chains for 62 days, and checks pause, bot pause, absence, provider usage window, account and bot cost caps and runs a day before each unattended start. A cap never stops a running run. Reaching a cap, or a provider limit, sends one needs-you reminder per period or window through the existing reminder.
- **Provider windows**: the Controller reports `runtime_updated` with `usageLimit` once per window (`provider_limit`); until `resetsAt` (an hour when it is unknown) no unattended start of that provider's bots happens and runs skipped for it are not made up.
- **UI**: Routines section in a bot's details, Settings > Assistants > Unattended work; component specs on desktop and phone widths; flow E20 on the real stack.
- **Not built**: event (webhook) routines, `perRun` as an audit mark (the field is stored and shown, nothing reads it yet), per-bot pause switch UI (the setting exists and the Relay honours it), cache-write premium for the 1-hour cache.
- **Accuracy seen live**: for one Claude Code turn the CLI reported $0.031 and the estimate was $0.058 (about 1.9x); the estimate is an upper-side API-equivalent figure, and the provider's own figure is kept beside it in the chain.
