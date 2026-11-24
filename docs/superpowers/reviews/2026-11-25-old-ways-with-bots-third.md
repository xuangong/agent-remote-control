# The older features' ways of working, done with bots a third time

Date: 2026-11-25 local (UTC+8); the machine clock read 2026-11-24 18:49 to 19:32 UTC during the run, and clock times below are UTC.
Branch `feat/bots-8-boards`, worktree `.worktrees/bots-8`, build `b891b4554ef8` (clean checkout). This is the third record of use,
beside [the first](2026-11-24-old-ways-with-bots.md) (build `3566a635`) and [the second](2026-11-25-old-ways-with-bots-after-fixes.md)
(build `d409519d849b`). It is not a test: I played the owner, drove real sessions with the same small tasks, and wrote down what
happened. No product code was changed and no test code was written. Numbers come from the Relay's chain records
(`GET /v1/remote/chains`), the audit page, the Claude Code transcripts under `~/.claude/projects/` (for model calls) and the sessions'
histories, read through `agent-remote-controller-dev` and a headless Chromium. Screenshots are under `.tmp/local/r3/` (ignored by git).
Each scenario was run once, so run-to-run variance applies: a difference of 10 to 20 per cent between records is inside normal variation,
and the model-driven behaviours below (asking, chatter) can go the other way on another run.

What changed since the second record, from [the bots 9 review plan](../plans/2026-11-25-bots-9-review-plan.md), "After the second
record": base instructions v8 (a bot asks the bot that knows rather than guesses or copies a neighbour; a chief does not ask its staff for
progress), the `/side` draft cleared on the Relay when the composer is replaced, a side's held message saying that nothing answers it, and
one approval per chain and folder now covering every kind of tool action.

## How the session was run

- Same method as the second record. Helpers outside the repository (`/tmp/old-ways3/*.mjs`) only wrapped the instance's Controller command
  line (create a session, put it in a group with a mission, send, read history, read boards and chains), read a Claude Code transcript to
  count model calls (distinct assistant message ids), and drove a headless Chromium (type in the composer, click "Bring back", open a
  fresh page, screenshots, the Settings audit). `/side` was typed into the page's composer.
- **The instance could not be restarted on its own state (new problem N-6, below).** `pnpm local up` in the worktree failed with
  `Invalid or unsupported Relay state.` The persisted state of the old instance held standing approvals with a `kind` field from the second
  record, and the build under test no longer has that field. The state file is signed, and removing an instance needs the user's
  confirmation, so I left the old instance (`~/.agent-remote-control-dev/instances/bots-8-5ac6711d`, port 62636) stopped and untouched and ran
  `ARC_LOCAL_ROOT=/Users/xian/.arc-local-third pnpm local up` for the same checkout: a fresh instance at `http://localhost:61240` with the
  same build. Consequences: an empty workspace and no earlier bots (the second record had about 45 bots in `list_bots`; this one has only
  the bots created in this run), so the contamination of earlier folders is smaller but not gone: the Side scenario's `r3-side` folder and the
  side's `printf-vs-echo.md` sat in the workspace when Support ran, as `r2-side` did in the second record.
- Approvals: a background loop of mine answered every pending `tool_approval` of this run's sessions with "Allow once" for Side and Support
  (16 approvals: Side 5, 2a 7, 2b 4), and chose "Allow for this chain in this folder" whenever the card offered it for Team (1 card; the loop
  would have answered once otherwise, and did not need to). No bot asked the person a question.
- Sessions created: Claude Code `Maker R3`, three side bots (Biscuit, Plum, Nori), `Style Keeper R3`, `Builder R3`, `Docs Keeper R3`,
  `Builder R3b`, `Lead R3` (staff `R3 Coder`, `R3 Tester`, `R3 Docs`, created by the lead); Codex `Lead R3X` (staff `R3X Coder`, `R3X Tester`,
  `R3X Docs`). All four Codex sessions were released at the end (`session release` answered `{"released": true}` each; their state now
  reads `unknown`).
- Realism limits as before: the person is a script that answers within seconds. Default model of the instance for every session.

## 1. Side

**Goal.** Three side questions while working; tokens and model calls per side; the card beside the conversation; Bring back; the
draft after sending `/side`, on a fresh page.

**Setup.** `Maker R3` (Claude Code), mission as in the earlier runs.

**What I did (inputs).** As in the second record: (1) to Maker R3: create `r3-side` with `greet.sh` and a README and give the usage
line; (2) 10 s later in the page composer `/side Quick side question: what is the difference between $0 and $@ ...`; (3) "Bring back" on
that card; (4) "Good. Now add a --shout option ... write a test.sh ... Run it." and 9 s later `/side Is it better to use printf instead of
echo ...`; (5) "Next, add a CHANGELOG.md ..." and 7 s later `/side Sorry, side question: run `for s in sh bash dash; ...``. The approval loop
ran throughout (in the second record it was paused for the third side).

**What the bots did.**

| Side | Asked | Tokens | Cost | Model calls | What the calls were | Approvals |
|---|---|---|---|---|---|---|
| 1 `$0` versus `$@` | 18:52:23 | 81,746 | $0.158 | 3 | ToolSearch, `message` to the chief, final text | none |
| 2 `printf` versus `echo` | 18:55:53 | 142,519 | $0.154 | 5 | Bash, Write, ToolSearch, `message`, final text | 2 (Bash, Write) |
| 3 `echo -n` in three shells | 18:57:04 | 109,339 | $0.108 | 4 | Bash, ToolSearch, `message`, final text | 1 (Bash) |

- Every call re-reads the whole cached context, about 26,000 to 29,000 tokens per call (first call: about 26,000 cache-creation). So a side's
  tokens are the number of its model calls times about 27,000, plus its tool output. Side 1 is exactly 3 calls = 81,746.
- In all three sides the last two calls are the same: `ToolSearch` (the `message` tool is deferred in Claude Code) and a `message` to the chief,
  which returns `{"outcome":"held","reason":"Recorded beside the conversation you were asked from; ... Nothing answers it: do not send it
  again or wait."}`. The side then writes its final text. It does not resend and does not wait, so the held reason works. But the call
  itself is there because the side's first input says "When you finish, message your chief once with status done or failed: ... at most 300
  characters." The card shows that held message (what "Bring back" quotes is the 300-character report, not the side's longer final text:
  side 1's card says "$0 expands to the name of the shell or script as it was invoked; it is not one of the positional parameters. ...", its final
  text is worded differently and ends with "My report to Maker R3 wasn't delivered directly. It was saved next to the conversation ...").
  So the answer is produced twice, and two of side 1's three calls (about 55,000 of 81,746 tokens, 67 per cent) exist only to produce the
  card text.
- The 300-character limit also showed: side 2 wrote an unrequested `printf-vs-echo.md` in the workspace root with its table and rules, and its
  card says "Table + rules: workspace/printf-vs-echo.md" (the later builders read it as a neighbour file).
- The main conversation was left alone. Maker R3's chains are my five inputs (54,216; 27,618 for Bring back; 57,735; 59,009 tokens, one turn
  each) and the bring-up turn; none was caused by a side. The cards sit between the main turns: `Side "<question>" answered`, `Open`,
  `Bring back`, then the answer text (`s1-main-three-cards.png`).
- Bring back on card 1: a person message `From the side "Quick side question: ...":` quoting the answer; the main bot answered in one
  turn (27,618 tokens, $0.012): "Thanks, that's correct. `greet.sh` only uses `$1` ... I can add that if you like." (`s1-bring-back.png`).
- The draft. After each `/side` the roster row showed no `Draft` text. At 18:52 (after side 1), 18:58 (after the three sides) and at 19:32
  (40 minutes after the first send) I opened a fresh browser context, which takes the draft from the Relay: the roster has no `Draft /side ...`
  row and Maker R3's composer is empty (`s1-draft-fresh-page.png`, `s1-maker-card-fresh.png`).
- Approvals: 5 in the whole scenario (2 by Maker R3, 3 by sides), all answered "Allow once" by the loop within seconds, so the side's approval
  wait was not observed this time.

**Screenshots.** `.tmp/local/r3/s1-side1-sent.png`, `s1-side2-sent.png`, `s1-side3-sent.png`, `s1-main-three-cards.png`, `s1-bring-back.png`,
`s1-maker-card-fresh.png`, `s1-draft-fresh-page.png`.

**Problems.**

- N-1 still open and now explained: a side costs 3 to 5 model calls for a one-turn answer; 2 are only the delivery to a chief that does not
  receive it. 81,746 to 142,519 tokens, $0.108 to $0.158, against 56,361 to 62,766 tokens and $0.024 to $0.030 in the first record, 81,617 to
  112,191 tokens and $0.096 to $0.132 in the second. The code between the records did not change this; the plan's inference ("the side
  made more model calls") is confirmed by the count, and the cause is the instruction to message, not the start.
- The card carries the 300-character report, the side's page the full answer: the person reads two versions, and a long answer is pushed into a
  file (side 2).
- Nicknames (Biscuit, Plum, Nori) and the empty mission of a side are as before (S-5); I did not re-inspect the details.

**Outcome.** Side now behaves as designed for the main conversation, and the draft is gone. Each side is dearer than it needs to be.

## 2. Call For Support

**Goal.** A bot that does not know a project convention asks the standing bot whose mission fits, by itself (v8).

**Setup.** As before: `Style Keeper R3` (the same convention text, tag "(ow)") and `Builder R3`; for 2b `Docs Keeper R3` (README conventions: three
sections "## Synopsis", "## Exit codes", "## See also", the last line "Maintained by platform-team.") and `Builder R3b`.

### 2a. The same convention task

**What I did.** (1) To Builder R3: "Please create r3-support/backup.sh that copies the file given as its first argument to the same path with
a .bak suffix, plus the changelog entry for it in r3-support/CHANGELOG.md. Follow the project conventions." Nothing else. (2) After its reply, the
same nudge as before: "This does not follow our project conventions. You have no way to see them in the files, but some bot here is the
keeper of them: find it, get the rules from it, then fix backup.sh and the changelog entry accordingly." (3) "Good. Now have the keeper review
the fixed files, and tell me its verdict."

**What the bots did.**

- Round 1 (19:00:32 to 19:01:25, 4 model calls, 115,124 tokens, $0.078, 2 approvals): no `list_bots`, no message. It listed the workspace, read
  `r3-side` and `printf-vs-echo.md`, wrote `backup.sh` (exit 1 on a usage error, no `set -eu`) and a Keep a Changelog file, and said: "The only
  existing project was `r3-side`, so I followed its conventions". It was not unsure, it was sure; it offered a `test.sh` and README "like `r3-side`".
  Asked nobody.
- Round 2 (after the nudge; 19:05:51 to 19:06:59; 2 messages, 3 turns, 379,704 tokens, $0.242; 10 model calls of the builder): `ToolSearch`,
  `list_bots`, a board item, a message to the keeper, the keeper's answer arrived as `[Message from Style Keeper R3 ... final answer to ...]`,
  then it fixed `backup.sh` (`set -eu`, printf, exit 64 with the usage line), added `test_backup.sh` (it hit the sandbox's `mktemp` block and fixed that
  itself), rewrote the changelog line with the date and "(ow)" and reported.
- Round 3 (the review; 19:07:47 to 19:08:51; 2 messages, 3 turns, 385,639 tokens, $0.176; 7 model calls): the builder sent the request with `reply_to` set
  (the condition that lost the verdict in the first record) and the keeper's verdict arrived within the chain: "Almost a pass, with one change:
  CHANGELOG.md:3 starts with "- ", and an entry must start with a past-tense verb ...". The builder removed the bullet and told the person:
  "I haven't asked it to look again since removing the bullet." Its board: both items `done`, assignee `self`.
- Totals for 2a: 880,467 tokens, $0.496, 21 builder model calls after the bring-up, 7 approvals. Second record: 680,625 tokens, $0.355, 6
  approvals; first: 765,635 tokens, $0.50.

### 2b. A clean variant: conventions that exist in no file

`Builder R3b`: "Please create r3-support2/rotate.sh that keeps the last three copies of the file given as its first argument (file.1 newest, then
file.2, file.3), with a README.md for it. Follow the project conventions." It did not call `list_bots` and asked nobody: it listed the workspace,
read `r3-side`, `r3-support` and `printf-vs-echo.md`, wrote `rotate.sh`, a README in free form, an unrequested `test.sh` and an unrequested changelog, and
said "I followed the other script folders: plain POSIX `sh`, `printf` instead of `echo`". 6 model calls for the task, 182,591 tokens, $0.124, 4
approvals. Neither keeper was asked. Its first input did contain v8's sentence (the transcript holds "ask the bot that knows").

**Screenshots.** None for this scenario; the evidence is the transcripts, the board and the chain records.

**Problems.**

- C-1 again, in both runs: 0 of 2 builders asked by themselves. v8 words the rule for what the bot "cannot see or is unsure of". The builder is
  not unsure: with "Follow the project conventions" in the request it finds a sibling folder, decides that those are the conventions and states
  so in its reply. The sentence sits as one bullet in a list of ten and says nothing about the person's words "project conventions".
- The review again came only when the person asked for it.

**Outcome.** Without a nudge the bot way still does not trigger (0 of 2, second record 0 of 2). With the nudge it works, the verdict arrives in
the same chain, including for a request sent as a reply (the first record's lost-verdict condition), and the item is not moved.
Note that in Team (3b) the same rule did trigger: see N-3.

## 3. Team

**Goal.** A chief organises staff to deliver one piece of work; midway the person changes a detail through the coder; count turns, messages,
tokens, cost, closing chatter, approvals answered with "Allow for this chain in this folder", and whether the chief asks staff for progress.

### 3a. Claude Code

**Setup and inputs.** `Lead R3`, the same mission as before. (1) "I need a small tool delivered in the folder r3-team: wordstat.sh, which prints the
number of lines, words and characters ... with a test script and a README. Please set up a coder, a tester and a docs writer as your standing
staff, split the work between them, and tell me when it is delivered." (2) At 2 min 52 s, straight to `R3 Coder`: "Small change of plan from me:
wordstat should print labelled output on one line, like `lines=3 words=12 chars=60`, instead of bare numbers. Please change the script."

**What the bots did.**

- The lead created the three staff in 5 seconds, each with its item and the spec in the `create_bot` message (the usage, the exit codes). The staff
  did not need to read the board. First delivery at 2 min 3 s (12 tests pass); I sent my change after that, so the plan changed from a delivered
  state: the lead noted the person's change from the `[The person wrote to R3 Coder]` notice, opened items 4 to 6, and told the tester and the docs
  writer. Stale reports happened once again in a mild form: Docs reported that the tests "fail 9 of 12" while the tester was updating them; the
  lead checked itself and said so ("R3 Docs' note ... is out of date").
- Delivery 2: "Your format change is delivered ... All 12 tests pass ... I ran it again myself". I ran the delivered script: `lines=2 words=3 chars=6`
  for a two-line file, and `test_wordstat.sh` printed `passed: 12  failed: 0`.
- Closing chatter: after the final delivery text (19:14:45) the lead ran 2 more turns ("These three replies change nothing. ...", "R3 Docs
  confirms the README matches ... Nothing is still open."); after the first delivery (19:12:17) one more ("R3 Tester ran the tests a second time ...").
  So 3 closing turns in all, 2 after the final delivery. Second record: 1. The cause is in N-2.
- Did the chief ask staff for progress? Its eight messages to staff are hand-offs with new work ("Item 5: the person changed ... Update test_wordstat.sh",
  "R3 Coder has landed the one-line format. Run your updated tests now and report"), and one `read_bot` to look at the docs writer. No "report on X" check-in and no
  "how far are you". Second record: check-ins of that kind existed. The staff still answered some hand-offs twice (a message reply plus the final text).
- Numbers. Chain of my request: 19:10:40 to 19:15:07 (4 min 27 s), 19 turns, 16 messages, 3 bots created, depth 3, 2,426,636 tokens, $1.32. Chain of the
  direct message to the coder: 19:13:06 to 19:15:15, 11 turns, 12 messages, 849,855 tokens, $0.30. Together 30 turns, 28 messages, 3.28 million tokens,
  $1.62. Second record: 34 turns, 33 messages, 4.20 million, $1.90; first: 39 turns, 41 messages, 5.18 million, $2.32.
- Approvals: one card for the whole run, the first Bash approval (19:10:52), answered "Allow for this chain in this folder". The audit lists it as
  `Any tool in .../workspace`, "applied 9 times", with "Ask me again" (`s3-audit-approvals.png`). No further card for Write, Edit or Bash. The coder's chain,
  started by my direct message, asked for none. Second record: 4 cards (one per kind and chain); first: 37 in the run, 17 for the three staff.

**Screenshots.** `s3-audit-approvals.png` (the standing approval of the chain, applied 9 times), `s3-lead.png` (an R3 Docs conversation that shows the closing chatter
between staff and chief: "Lead R3 has closed Item 6 ... Nothing is open on my side."), `s3-lead-claude.png`.

### 3b. Codex

**Setup and inputs.** `Lead R3X` (Codex), the same mission plus "You work only inside the folder you are started in." (1) The request with `r3-team-cx`
("... slugify.sh ... Staff must work only inside r3-team-cx."). (2) At 1 min 35 s, straight to `R3X Coder`: "Small change from me: the slug must be cut at 40
characters, and never end with a dash. Please change the script accordingly." (disposition `queued`). No approvals were asked.

**What the bots did.** The shape of the earlier runs, then a much longer tail. The lead created three Codex staff and a board. The direct change was noticed
(plan: "Person directly asked coder: slug cut to 40 characters ...") and the tester and docs briefs were updated. New: the lead and the staff asked the two standing
Claude keepers left from Support (`Style Keeper R3`, `Docs Keeper R3`) about conventions on their own (the keepers received messages from the lead and from all
three staff); the docs writer reported "Docs Keeper now says no behavior/example prose, only links to fuller docs/tests", and the lead ruled on the README format.
The first delivery text came after the tests passed (26 tests); I ran the delivered script: a 67-character title came out as
`hello-world-this-is-a-very-long-title-th` (40 characters), and `test_slugify.sh` printed `26 passed; 0 failed`. The folder also holds a `CHANGELOG.md`
that nobody asked for: after the delivery text, the style keeper's review (relayed by the tester) said a changelog entry was missing, and the lead opened
an item 4 for it ("Assigned the changelog follow-up to R3X Docs ... restricted to `r3-team-cx`"). The docs writer replied that the assignment "names 'Add
delivery changelog entry' but includes no item key or brief" (T-2), the lead sent the key, and the file was written.

**Numbers.** Chain of my request: 19:18:56 to 19:29:29 (10 min 33 s), 75 turns, 78 messages, 3 bots created, 12,262,086 tokens (cost not reported for Codex; the
$0.31 is the keepers' Claude turns). Chain of the direct message: 19:20:13 to 19:28:30, 14 turns, 14 messages, 1,473,868 tokens. Together 89 turns, 92 messages,
13.74 million tokens. Second record: 40 turns, 51 messages, 4.04 million tokens in 5 min 37 s; first: 30 turns, 28 messages, 2.74 million. After the lead's first
delivery text there were 11 more lead turns: 6 that only narrate ("I'll check that the final documentation report is recorded on the completed board item.", "This
matches the completed documentation review. I'll check the board for any outstanding work.", ...), 4 for the changelog follow-up and 1 closing text. The
conversation's last words, and the roster preview, are "I'll check this final report against the closed changelog item." (`s3-lead-codex.png`).
Approvals: none asked.

**Problems.**

- T-1 is worse, not better: 89 turns and 13.74 million tokens, 3.4 times the second record's tokens, on a task that was delivered at about the 30th turn.
- The chief's check-ins are gone from this run (the lead's messages were work hand-offs), yet the loop continued: see N-2 for the mechanism, which does not need a
  progress request.
- T-2: the docs writer could not tell which item a notification meant (item 4 had no key or brief in its message).
- T-3 (folded "Message from ..." lines between the lead's turns) unchanged; T-4 (stale reports) happened mildly in 3a.

**Outcome (3a and 3b).** Delivered, tested, and the person's direct change reached the chief and was carried through in both providers. Approvals fell to one card
for the Claude run and none for Codex. Message volume fell in the Claude run (28 against 33) and rose in the Codex run (92 against 51).

## New problems and observations

- N-2. The loop that produces closing chatter, found in the staff's inputs. A turn that starts from a bot's message ends with a final text, and that final
  text is routed to the sender as `final answer to <message>` (the fix for lost verdicts). The leads' final texts after a report are pure narration ("This adds
  nothing new", "I'll check that the completed test result is recorded"), and they were routed to the staff as answers: in 3a 6 of the 30 turns were staff turns
  started by a lead narration (R3 Coder 3, R3 Tester 1, R3 Docs 2); in 3b the lead's narrations went to the docs writer 4 times and to the tester twice, each
  starting a staff turn that ended with its own final text, routed back to the lead, which started another. v8's "do not acknowledge or thank ... send it with status
  ack" is not applied, because the narration is not a message the model sends: it is the turn's final text, and the Relay makes it a message. The models cannot
  mark it.
- N-3. v8's "ask the bot that knows" triggered in the Team (Codex) where the standing keepers existed in the account and did not trigger for the two builders.
  In the team it produced useful rules (docs format, test conventions) and also scope (a review-driven CHANGELOG nobody requested, many messages to the
  keepers). The keepers' public missions are visible to every bot, as in C-2.
- N-4. The 300-character report that a side must send is its card text, so the card and the side's own answer differ, and a longer answer goes to a file in the
  workspace (side 2) that other bots then read as a neighbour.
- N-5. A sibling folder is taken for "the project conventions" by a builder that is told to follow them (see Support), in a workspace that is as small as it gets.
- N-6. The default instance would not start on this build. Standing approvals persisted by the previous build carry `kind`; the new schema has none and
  rejects them, so the Relay refuses its whole state with `Invalid or unsupported Relay state.` (cause from the state's content and the schema diff, not isolated
  by a test). Any Relay that holds a standing approval from before the change would stop the same way: it needs a read that drops `kind` (or a tolerant schema)
  before it is deployed. This was found because the earlier simulation's approvals were in the state; no data was changed.

## Comparison across the three records

Verdicts are for the third record against the second, and overall. "n/e" means not exercised in that record.

| Finding | First | Second | Third | Verdict |
|---|---|---|---|---|
| S-1 side answer lands in the main conversation, restated, a main turn | 91,032-token main turn, three copies | card beside; 0 main turns | same: 0 main turns by 3 sides, only Bring back (27,618 tokens) chosen by me | Fixed (holds) |
| S-2 side ends with a delivery sentence before its answer | yes | side chains: 0 messages | the side still calls `message` (held) and its final text ends with "My report ... wasn't delivered directly" | Improved; the call remains (N-1, N-4) |
| S-3 `/side` draft left behind | `Draft /side ...`, restored by a new page | not fixed: restored even 35 minutes later | roster has no Draft row; composer empty in fresh pages at 18:52, 18:58 and 19:32 (40 minutes after the first send) | Fixed |
| S-4 a side's approval invisible from the main conversation | stays "Working" | needs-you ring on the main row, not isolated | n/e (loop answered the cards at once) | n/e |
| S-5 nickname, empty mission/memory | "Gummies" | "Peach/Bean/Sprout" | "Biscuit/Plum/Nori"; the card line names the question | Not fixed (out of scope) |
| Bring back | n/a | works | works (quote, "Brought back", one main turn of 27,618 tokens) | Holds |
| N-1 a side costs more | 56,361 to 62,766 tokens, $0.024 to $0.030, 2 calls | 81,617 to 112,191, $0.096 to $0.132, not counted | 81,746 to 142,519, $0.108 to $0.158; 3 to 5 calls; 2 calls are the held `message` | Not fixed, cause found (the brief's "message your chief") |
| C-1 no help asked | 0 of 1 | 0 of 2 | 0 of 2 (2a, 2b); asked only after the nudge; the Codex team did ask the keepers by itself | Not fixed for builders; improved in Team |
| C-3 review verdict lost | lost, found after 28 minutes | arrived, builder's request was not a reply | arrived with the builder's request sent as a reply (`reply_to` set) | Fixed (now reproduced) |
| Item moved to the reviewer | assignee "Style Keeper OW" | `self` | `self`, the keeper a link | Fixed (holds) |
| C-2, C-4, C-5 | public mission, `ListAgents`, ten stale bots | unchanged; about 45 bots | public mission as before; `ListAgents` not used; only this run's bots in a fresh workspace | Unchanged |
| T-1 closing chatter, many turns | Claude 38 + 1 turns, 41 messages, 5.18 M tokens, $2.32; Codex 16 + 14, 28 messages, 2.74 M | Claude 26 + 8, 33 messages, 4.20 M, $1.90, 1 closing turn; Codex 25 + 15, 51 messages, 4.04 M, 3 closing turns | Claude 19 + 11 = 30, 28 messages, 3.28 M, $1.62, 3 closing turns (2 after the final delivery); Codex 75 + 14 = 89, 92 messages, 13.74 M, 6 narrating lead turns, 11 after the first delivery | Improved for Claude (within variance); Not fixed, worse for Codex |
| Chief asks staff for progress | first run: check-in turns | "report on ..." check-ins | none in the Claude run (8 hand-offs, 1 `read_bot`); none seen in the Codex run | Improved (v8) |
| T-2 "read item N" fails | both providers | coder read the item, spec still missing | specs in the `create_bot` message (Claude, no read needed); Codex item 4 arrived with no key or brief | Improved; not solved for later assignments |
| T-3 about 20 folded message lines | yes | yes | yes | Unchanged |
| T-4 stale reports | yes | yes | mild (docs reported "9 of 12 fail" while the tester updated them) | Unchanged |
| Approvals | 37 (17 for the staff) | Team 4 cards, 11 uses; 13 once for Side and Support | Team 1 card, 9 uses; 16 once for Side and Support (my loop; no chain choice used there) | Improved (4 to 1 for the Team) |
| P-1, P-2, P-3, Mention | | n/e | n/e | n/e |
| N-6 persisted approvals refused by the new schema | n/a | n/a | the default instance does not start | New |
| N-2 final text routed as an answer feeds the chatter | n/a | named as a hypothesis | traced in the staff's inputs | New (cause of T-1) |

## Analysis: was each change effective

- **v8, ask the bot that knows (C-1): not effective for the builders, effective elsewhere.** Evidence: 2a and 2b, 0 of 2, 4 and 6 model calls, no `list_bots`. The
  builder's reply says "I followed the conventions of `r3-side`": it does not feel unsure. The same bullet did work in the Codex team, where the lead and three staff messaged
  `Style Keeper R3` and `Docs Keeper R3` without being told, so the rule is read; what fails is the trigger. A request with the words "project conventions" and no
  written rule is the trigger, and the sentence does not name it.
- **v8, a chief does not ask staff for progress: effective as worded.** Evidence: 8 messages of the Claude lead, all new work; no "report on ..." check-in in either
  run. It did not reduce the chatter, because the chatter does not come from check-ins (N-2).
- **Draft cleared on the Relay (S-3): effective.** Evidence: fresh pages at three times, no roster row, empty composer, where the second record's fresh pages restored
  the text three times. The change (publish a waiting edit when the sync is disposed) matches the second record's cause: replacing the composer by the side
  dropped the pending publish.
- **A side's held message says nothing answers it (N-1): effective for what it targets, not for the cost.** Evidence: after `held` every side went straight to its final
  text; none resent or waited. But the held message is the card's source, and the call to produce it (ToolSearch plus `message`) is two of three calls in side 1. The side now costs
  as much as the delivery it no longer makes.
- **One approval per chain and folder for every kind (9d): effective.** Evidence: 1 card for the whole Claude team, applied 9 times (Bash, Write, Edit and the rest
  under "Any tool in ... workspace"); 4 cards in the second record, 17 for the staff in the first. The direct message to the coder started a chain of its own and needed
  none. Not exercised for Side and Support, where my loop answered "Allow once" as in the second record.
- **Answers reaching the sender (C-3): effective and now also costly.** The verdict arrived for a reply-flagged request. The same rule routes narrating final texts,
  which is the engine of N-2.
- **Side beside the conversation (9a): effective.** Evidence: three cards, 0 main turns caused by a side, Bring back optional.

## Reflection: what can still improve, ranked

1. **Do not route a turn's narration as an answer (N-2, T-1).** The largest cost in the whole record: the Codex team spent 89 turns and 13.74 million tokens, 6 of the Claude
   team's 30 turns were answers to narration. Options in order of reach: route the final text of a message-started turn only when the incoming message asked for an answer
   (a request or a question) and treat a report as `ack` by default; or route nothing when the model's turn made no tool call and no board change; or end a chain
   branch after the item is `done`. Measure with the Codex team: 89 turns against about 30 needed.
2. **Take a side's card from its final text and drop its message to the chief (N-1, N-4).** Saves 2 of 3 calls for a plain answer (about 55,000 tokens, two thirds), removes
   the 300-character cut and the file written to hold the rest, and makes the card equal to the side's page. Change the brief: no "message your chief".
3. **Make the ask-for-help trigger concrete (C-1).** Name the case: "When the request says to follow conventions, or you are about to copy a neighbouring
   file's style, look at `list_bots` first and ask the keeper whose mission covers it." Verify with 2b. Pair with limits: a review loop with keepers should not add
   unrequested items (N-3): a chief should ask the person before taking a keeper's extra requirement as new work.
4. **Add a read for persisted approvals before deploying the schema change (N-6).** A Relay with a standing approval from the previous build refuses its whole state. Drop `kind` on read, then
   the next write. Highest severity if production holds any approval, though it only shows after a restart on the new build.
5. **Put the item number and the brief in the assignment notification (T-2).** The Codex staff could not read "Item 4 ... includes no item key or brief".
6. **Show the side's approval where the person looks (S-4).** Not exercised here; still open from the second record.
7. **Say in the page when the chief is only narrating.** The roster preview and the conversation's last line were "I'll check this final report against the closed changelog
   item." (Codex): after item 1, the preview of a finished team should be the delivery, not the last narration.

## What worked and should stay

- The side card with Open and Bring back, and the main bot left alone; the draft gone.
- One approval for a chain's folder, listed in the audit with "Ask me again".
- Verdicts reaching the asker, including from a request sent as a reply; the board keeping the assignee of an item.
- The `[The person wrote to X]` notice to the chief, and the chief carrying a direct change into its plan with a reason, in both providers.
- Specs inside the chief's `create_bot` message: the Claude staff worked without a board read.
- The held reason: no side resent or waited.
