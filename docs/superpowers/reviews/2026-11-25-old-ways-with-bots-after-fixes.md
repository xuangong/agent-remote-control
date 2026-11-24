# The older features' ways of working, done with bots again after the fixes

Date: 2026-11-25 (clock times are UTC; the page shows UTC+8). Branch `feat/bots-8-boards`, local instance of the worktree
`.worktrees/bots-8` (instance `bots-8-5ac6711d`), restarted with `pnpm local up` to build `d409519d849b` (clean checkout) before the
run. This is the second record of use, beside [the first](2026-11-24-old-ways-with-bots.md) (build `3566a635`). It is not a test: I
played the owner again, drove real sessions with the same small tasks, and wrote down what happened. No product code was changed.
Numbers come from the Relay's chain records (`GET /v1/remote/chains`), task records (`GET /v1/remote/teams`) and the audit page,
read through `agent-remote-controller-dev api` and the headless page. Screenshots are headless captures under `.tmp/local/r2/`
(ignored by git).

What changed since the first record, from [the bots 9 review plan](../plans/2026-11-25-bots-9-review-plan.md): base instructions v7
(general delegation, no closing chatter, status `ack`), answers to requests reaching their sender, the composer draft cleared, an
assignee reading its item, a person's edit caused by the person, messages never reassigning items, a `/side` answer shown as a card
beside the conversation with "Bring back", and one approval per chain and folder ("Allow for this chain in this folder").

## How the session was run

- Same method as the first record. Helpers outside the repository (`/tmp/old-ways2/*.mjs`) only wrapped the instance's Controller
  command line (create a session, put it in a group with a mission, send a message, read history, read boards and chains) and a
  headless Chromium script (type in the composer, click "Bring back", screenshots, the Settings audit). `/side` was typed in the
  page's composer, as a person does.
- Approvals: a background loop of mine answered the pending `tool_approval` of the sessions created in this run. For Side and Call For
  Support it answered "Allow once" (13 approvals). For Team it chose "Allow for this chain in this folder" whenever the card offered
  it and "Allow once" otherwise (4 approvals, all chain choices; the first one was the first approval of the run). No bot asked the
  person a question. The loop was stopped for about 45 s once, on purpose, to see a side's approval in the page (Side 3).
- Sessions created: Claude Code `Maker R2`, `Style Keeper R2`, `Builder R2`, `Docs Keeper R2`, `Builder R2b`, `Lead R2` (its staff
  `R2 Coder`, `R2 Tester`, `R2 Docs`, created by the lead), three side bots; Codex `Lead R2X` (staff `Coder R2X`, `Tester R2X`,
  `Docs R2X`). All four Codex sessions were released at the end (`session release` answered `{"released": true}` each).
  The earlier simulation's sessions (about 40, idle, "OW" and "CX" names) were left alone; they still show in the roster and in
  `list_bots`.
- Realism limits as before: the person is a script that answers within seconds. The workspace still holds the folders of the first run
  (`ow-side`, `ow-support`, `ow-team`, ...), and bots read neighbouring folders; this matters for Call For Support (see C-1).
- All sessions used the instance's default model, as in the first record. Support and Team were run once each: a single run per
  scenario, so differences of 10 to 20 per cent are inside normal variation between runs of the same prompt.

## 1. Side

**Goal.** Side questions while working; the answer stays as a card beside the conversation, the main bot does not restate it or spend
a turn, Bring back works, the draft is cleared.

**Setup.** Standing bot `Maker R2` (Claude Code), mission as in the first run ("You are the person's hands-on developer. ...").

**What I did (inputs).**

1. To Maker R2 (CLI): "Please create a folder r2-side with a shell script greet.sh that prints "Hello, <name>!" for its first argument
   (default "world"), and a README.md that says how to run it. Then tell me the exact usage line." The main turn took about 20 s
   (one Bash approval), so it was already finished when the first side was asked.
2. 10 s later in the page composer: "/side Quick side question: what is the difference between $0 and $@ in a POSIX shell script? Two
   sentences please."
3. In the page, "Bring back" on that card.
4. In the page: "Good. Now add a --shout option to greet.sh that prints the greeting in upper case, document it in the README, and write a
   test.sh in r2-side that runs greet.sh with no argument, with a name, and with --shout and prints PASS or FAIL for each. Run it." and
   9 s later, while that turn ran: "/side Is it better to use printf instead of echo in a portable shell script, and why? Test it in the
   shells you have if useful."
5. In the page: "Next, add a CHANGELOG.md to r2-side in Keep a Changelog style with the changes so far." and 7 s later, while it ran:
   "/side Sorry, side question: run `for s in sh bash dash; do $s -c 'echo -n x; echo' ; done` and tell me which shells print the -n
   literally. One short answer." (with my approval loop paused, to see the approval wait).

**What the bots did.**

- Each `/side` opened a temporary bot with a nickname and the chip "Side" (Peach, Bean, Sprout) and switched the page to it. Each side
  answered in one turn and sent nothing to Maker R2: its chain shows 0 messages and 1 turn.

  | Side | Asked | Answered after | Tokens | Cost | Approval |
  |---|---|---|---|---|---|
  | 1 `$0` versus `$@` | 17:32:20 | 14 s | 81,617 | $0.096 | none |
  | 2 `printf` versus `echo` (the side ran the shells) | 17:35:13 | 31 s | 112,191 | $0.132 | 1 Bash (loop), answered in 2 s |
  | 3 `echo -n` in three shells | 17:37:16 | 60 s, of which about 45 s was my paused loop | 108,889 | $0.107 | 1 Bash (loop) |

- The main conversation never restated a side answer and never spent a turn on one. Maker R2's chains in the whole run are the four
  chains of my own inputs (54,143, 27,500, 57,480 and 59,023 tokens, one turn each) and none caused by a side. In the first run the
  third side alone cost a 91,032-token main turn.
- Each answer appears in Maker R2's timeline as a card line `Side "<question>" answered` with `Open` and `Bring back`, followed by the
  answer text (screenshot `s1-main-three-cards.png`: three cards placed between the main turns; `s1-maker-card.png` after the first).
- "Bring back" on card 1 added a person message `From the side "Quick side question: ...":` with the answer quoted, the card button
  turned to "Brought back" (`s1-bring-back.png`), and the main bot answered it in a new turn (27,500 tokens, $0.010): "That's right.
  `greet.sh` only uses `$1`, so if you pass several words without quotes, only the first one is used ... Do you want it to greet all
  the words instead?" That is a turn the person chose to start.
- Side 3 waited on a Bash approval whose card sits in the side's conversation. In the roster, Maker R2's row showed "Wants to ask you
  som..." with the needs-you ring while both Maker R2's own CHANGELOG write and the side's loop waited, so I cannot separate which
  one caused it (`s1-side3-approval-roster.png`; the side page shows the approval with "Allow", "Allow for this chain in this folder",
  "Not now", "Show what changes").
- The draft: after each `/side` the roster row of Maker R2 showed `Draft /side ...` and a page opened later in a fresh browser
  context (so the draft came from the server) restored the text into Maker R2's composer, over the placeholder (`s1-main-three-cards.png`,
  bottom: the composer holds "/side Sorry, side question: ..." overlapping "Message Maker R2..."). Reopening Maker R2 inside the same page
  context that sent the `/side` cleared it, but a new context found it again. Checked at 17:35, 17:39 and 18:13 (the last time, 35
  minutes after the last send). Plain messages sent from Maker R2's own conversation left no draft.

**Screenshots.** `.tmp/local/r2/s1-side1-sent.png` (the side's page right after `/side`, roster still showing `Draft /side ...`),
`s1-maker-card.png`, `s1-bring-back.png`, `s1-main-while-side.png`, `s1-main-three-cards.png`, `s1-side3-approval-roster.png`.

**Numbers.** 3 sides, 302,697 tokens, $0.34; main bot: 4 turns of mine, 198,146 tokens (one of them started by Bring back); approvals
5 (3 in Maker R2, 2 in sides), all "Allow once" by my loop, none through the chain choice.

**Problems.**

- S-3 again. The `/side` text stays as a draft on the server (see above).
- N-1. A side costs more than in the first run: 81,617 to 112,191 tokens and $0.10 to $0.13 per side for one turn, against 56,361 to
  62,766 tokens and $0.024 to $0.030 in the first record. The first run's side also sent a message to its chief. I did not
  look into why a side's single turn is this big (base instructions, tool search and a larger context are candidates).
- The side's nickname and its empty Mission and Memory in the details are as before (S-5); the card line names the question.

**Outcome.** The side now stays beside the conversation and the main bot is left alone. Bring back works and is a choice.
The draft clearing did not work.

## 2. Call For Support

**Goal.** A bot hits something it does not know and gets help from the standing bot whose mission fits, by itself; the reviewer's
verdict reaches the builder without the fallback timer.

**Setup.** As in the first run: `Style Keeper R2` (the same convention text, tag "(ow)") and `Builder R2`, each in a group of
its own.

### 2a. The same convention task

**What I did (inputs).**

1. To Builder R2: "Please create r2-support/backup.sh that copies the file given as its first argument to the same path with a .bak
   suffix, plus the changelog entry for it in r2-support/CHANGELOG.md. Follow the project conventions." Nothing else; no nudge.
2. After its reply (it had not asked anyone), the same nudge as in the first run: "This does not follow our project conventions. You
   have no way to see them in the files, but some bot here is the keeper of them: find it, get the rules from it, then fix backup.sh and
   the changelog entry accordingly."
3. Because the builder did not ask for a review this time: "Good. Now have the keeper review the fixed files, and tell me its verdict."

**What the bots did.**

- Round 1 (17:41 to 17:42, 4 approvals, 153,096 tokens, $0.110): Builder R2 did not call `list_bots`. It read the neighbouring folders
  (`ls`, `cat` of `ow-support`, `r2-side` and the `.claude` folders) and wrote `backup.sh`, `test.sh` and a changelog in the style it
  found. Its reply ends: "I couldn't find any written project conventions, so I copied the style of `r2-side` ... `ow-support`
  uses a different format: one dated line per change, newest first. Tell me if you want that one instead." So it noticed a second
  style and offered the person the choice, but asked no bot. This is the same behaviour as in the first run.
- Round 2 (after the nudge; 17:43:38 to 17:44:25, 47 s; 2 messages, 3 turns, 309,930 tokens, $0.169; 2 approvals): the builder looked up
  `list_bots`, put a board item and plan ("Ask Style Keeper R2 for the conventions. Fix backup.sh, test file, CHANGELOG. Report to the person.")
  on its board, messaged the keeper, and the keeper's reply arrived in the builder's session as `[Message from Style Keeper R2 ... ·
  final answer to ...]`. The builder fixed `backup.sh` (`set -eu` on line 2, printf only, exit 64 with the usage line), renamed the
  test to `test_backup.sh`, rewrote the changelog line with the date and "(ow)", and reported.
- Round 3 (the review; 17:45:33 to 17:46:15, 42 s; 2 messages, 3 turns, 217,599 tokens, $0.076; 2 approvals by the keeper): the builder
  messaged the keeper, the keeper read the three files, ran the test and answered "Approved. backup.sh: ..." and that verdict arrived
  in Builder R2's session as `[Message from Style Keeper R2 ... · final answer to ...]` within the same chain. The builder
  passed it on: "Style Keeper R2 approved the fixed files and found no rules broken". No timer was needed.
- The builder's board item ended `done`, assignee `self`, with the keeper only as a linked bot. Nothing had been assigned to the
  keeper.
- Totals for 2a without the standing-instructions turns: 680,625 tokens, $0.355, 6 approvals (4 for the builder, 2 for the keeper).
  First run: 765,635 tokens, $0.50, with a lost verdict and 28 minutes until the timer.

### 2b. A clean variant: conventions that exist in no file

2a is contaminated by the first run's `ow-support` folder, so I also ran a task whose rules sit nowhere in the workspace.
`Docs Keeper R2`: "You are the keeper of this project's documentation conventions and the reviewer of its READMEs. Conventions:
every README.md has exactly three sections in this order: "## Synopsis" (one single indented line showing the command), "## Exit
codes" (a two-column table, code and meaning) and "## See also" (a bullet list, at least one entry); the file ends with the line
"Maintained by platform-team." ...". A new bot `Builder R2b` (the same builder mission), asked: "Please create r2-support2/rotate.sh that
keeps the last three copies of the file given as its first argument (file.1 newest, then file.2, file.3), with a README.md for it.
Follow the project conventions."

- Builder R2b did not call `list_bots` and asked nobody. It listed `r2-support` and `r2-side`, said "No written conventions doc exists,
  so I'm following the sibling `r2-support` style: POSIX sh, `set -eu`, header comment, exit 64 on usage, a `test_*.sh` with PASS/FAIL,
  and a CHANGELOG", wrote the script, a README in a free structure, an unrequested test and an unrequested changelog, and said
  "there's no written conventions file, so I copied the style of the sibling `r2-support` folder". Two keepers existed in the account
  (`Style Keeper R2`, `Docs Keeper R2`); neither was asked. 123,628 tokens, $0.115, 2 approvals, one turn.
- Its standing instructions (v7) read: "Work outside your mission goes to the bot whose mission fits (list_bots): hand it over by
  message and wait for its answer rather than guessing." The builder's own mission is "developer for small scripts", so a script and
  its README are inside its mission and the rule did not apply to the thing it was missing: knowing how this project does it.

**Screenshots.** None for this scenario; the evidence is the transcripts and the board.

**Problems.**

- C-1 again, in both runs: the bot never asked for help by itself. The sentence of v6 ("when you do not know how the project does
  something ... ask") was replaced by the delegation rule that is about work outside the mission.
- C-3 is not reproduced exactly: in the first run the builder itself sent the review request as a reply; here the person asked for
  the review, so the builder sent a plain message. The Team runs below do contain replies to messages, and their answers were routed back
  (every "final answer to" line); the loss has not happened again.
- The review was not requested by the builder this time (in the first run it asked by itself after fixing). With nobody saying "have it
  reviewed", the builder reported a fix without review.

**Outcome.** Without a nudge the bot way still does not trigger (0 of 2). With the nudge it works as before, the verdict now arrives at
once, and the item is no longer moved.

## 3. Team

**Goal.** A chief organises staff to deliver one piece of work, the person changes a detail through a staff bot midway; compare turns,
messages, tokens and closing chatter with the first run; answer the first approval with "Allow for this chain in this folder" and count
the approvals still answered (first run: 37 over the whole run, 17 of them for the three staff of the team).

### 3a. Claude Code

**Setup and inputs.** `Lead R2`, the same mission as Lead OW. (1) "I need a small tool delivered in the folder r2-team: wordstat.sh, which
prints the number of lines, words and characters of the file given as its argument (like a tiny wc), with a test script and a README.
Please set up a coder, a tester and a docs writer as your standing staff, split the work between them, and tell me when it is delivered."
(2) At 2 min 52 s, straight to the Coder: "Small change of plan from me: wordstat should print labelled output on one line, like
`lines=3 words=12 chars=60`, instead of bare numbers. Please change the script."

**What the bots did.**

- The lead created `R2 Coder`, `R2 Tester`, `R2 Docs`, wrote a board (delivery item, three staff items), and delegated. The coder first
  answered that "item 1 has no actual spec" (the brief only said "write r2-team/wordstat.sh per the brief"; it had read the item on the
  lead's board with `board`), then received the spec by message. The person's direct message reached the lead as a notice; the lead's
  plan changed to "Delivered v1 ... Now v2: person asked (via R2 Coder) for labelled output" with items 4, 5 and 6 added, and its memory
  gained "Standing staff could not open board items assigned via update_board alone. Always name the item number in the message and
  put the key spec in the message text too."
- Stale reports happened again: Docs reported 5 failing tests that it had run before the tester updated them; the lead noted it in its
  summary ("R2 Docs had reported 5 failing tests, but it ran them before R2 Tester had updated them. They all pass now").
- Delivery. The final summary reads "The labelled-output change is delivered ... passes 8/8. I re-ran it myself". I ran the delivered
  `test_wordstat.sh`: `8 passed, 0 failed`; `wordstat.sh` printed `lines=2 words=3 chars=6` for a two-line file. After the summary the lead
  ran one more turn: "These last reports from R2 Tester and R2 Docs only confirm what I'd already checked ... The labelled-output
  version is delivered.", which is now the last message of the conversation and the roster preview (`s3-lead.png`). The lead also did
  not call in the keeper this time.
- Numbers. The chain from my request: 17:52:33 to 17:56:54 (4 min 21 s), 26 turns, 23 messages, 3 bots created, depth 5, 3,567,358 tokens,
  $1.68. The chain from the direct message to the coder: 17:55:01 to 17:56:53, 8 turns, 10 messages, 630,890 tokens, $0.22. Together 34
  turns, 33 messages, 4.20 million tokens, $1.90. First run: 38 turns, 41 messages, 5,075,412 tokens, $2.27 for the main chain, plus 1
  turn and 108,937 tokens for the direct message, 6.5 minutes. The first run included a review by the keeper and two reopened items, so the
  workloads are not the same.
- Approvals: 4 answered, all through the chain choice, one per kind and chain: Bash (the tester, 17:53), Write (the docs writer, 17:53),
  Edit (17:54), and Bash again at 17:55 in the coder's chain (the direct message started a chain of its own). The audit lists
  them under "You asked Lead R2" as "Allowed for this chain": Bash applied 8 times, Write 0 times, Edit 2 times; and under the coder's
  chain Bash applied once (`s3-audit-approvals.png`, with "Ask me again" beside each). So 11 uses of a standing approval were
  answered by the Controllers and the person answered 4 cards. First run: 17 for these three staff, 37 for the whole first run.
- Acknowledgements: I found no acknowledgement-only message in the folded lines of the lead's conversation. I could not see message statuses
  in the transcripts, and the Relay's team records held no `ack` marks.

**Screenshots.** `s3-lead.png` (summary, Board with plan and "Done (6)", folded "Message from R2 Coder" lines, the closing chatter
as last message), `s3-audit-approvals.png` (the chain's approvals in Settings), the side's approval card in `s1-side3-approval-roster.png`.

### 3b. Codex

**Setup and inputs.** `Lead R2X` (Codex), the same mission plus "You work only inside the folder you are started in." (1) The first-run
request with `r2-team-cx` ("... Staff must work only inside r2-team-cx.") (2) at 1 min 35 s, straight to `Coder R2X`: "Small change from me: the
slug must be cut at 40 characters, and never end with a dash. Please change the script accordingly." No approvals were asked.

**What the bots did.** The same shape as before: three staff, a board, the direct change noticed and carried into the plan. Delivered:
`slugify.sh`, `test_slugify.sh`, `README.md`; I ran the delivered script: a 66-character title came out as
`hello-world-this-is-a-very-long-title-th` (40 characters) and `test_slugify.sh` printed `41 passed; 0 failed`. The lead's summary came
about 2 min before the chain ended: "Delivered in `r2-team-cx`: `slugify.sh`, `test_slugify.sh`, and `README.md` ... All 41 tests pass",
followed by three more lead turns, each triggered by a staff report that said the work was already done ("Final verification is already
complete: all 41 tests ... Item 3 remains complete."), each answered with "I'll check this report against the completed board.". The
conversation again ends with that line.

**Numbers.** Chain from my request: 18:05:57 to 18:11:34 (5 min 37 s), 25 turns, 32 messages, 3 bots created, 2,771,309 tokens. Chain from the
direct message: 18:06:49 to 18:10:45, 15 turns, 19 messages, 1,266,379 tokens. Together 40 turns, 51 messages, 4.04 million tokens. First
run: 16 turns, 17 messages, 1,425,261 tokens in 3.5 minutes, plus 14 turns, 11 messages, 1,315,672 tokens for the direct message
(together 30 turns, 28 messages, 2.74 million tokens). Cost is not reported for Codex.

**Problems.**

- T-1 again, and larger. In the Claude run one closing turn; in the Codex run three, and 82 per cent more messages than the first run.
  The first-run Codex run had its own closing noise, so this is a worse run of the same shape rather than a new problem, but the
  fix for it did not show. Where the chatter comes from, from the transcripts: the lead's check-in messages ("report on ...") make the
  staff answer, the staff's final text goes back to the lead as `final answer to <message>` (the fix for answers reaching the
  sender), and each such answer starts a lead turn; the models did not use status `ack`.
- T-2 improved but not solved: the coder read the item on the lead's board with `board`, but the lead's briefs contained no spec and the
  items' numbers were not in the messages ("items 2/3 refused": it tried items assigned to others), so a message still had to carry the
  spec. The lead wrote the remedy into its memory itself.
- T-3 unchanged: the lead's page shows folded "Message from ..." lines between its turns (`s3-lead.png`).
- T-4 again (the stale docs report).

**Outcome (3a and 3b).** Delivered, tested, the person's change reached the chief and was carried into the plan, both times. Approvals
fell sharply. Chatter and message volume did not.

## Comparison: first run against now

Verdicts: fixed, improved, not fixed, new. "n/e" means not exercised in this run (TPM and the mention were not repeated, as asked).

| Finding | First run | Now | Verdict |
|---|---|---|---|
| S-1 side answer lands in the main conversation, restated, a main turn | 91,032-token main turn, three copies of the text | card beside the conversation, 0 main turns caused by 3 sides | Fixed |
| S-2 side ends with a delivery sentence before the answer | its transcript led with "I sent the answer to Maker OW" | side chains have 0 messages; the answer is the final text and the card | Fixed |
| S-3 `/side` draft left behind | roster `Draft /side ...`, text reappeared | same: roster `Draft /side ...`, text restored by the server in a new page, even 35 minutes later; cleared only by reopening the conversation in the same page | Not fixed |
| S-4 a side's approval invisible from the main conversation | stays "Working" | main row takes the needs-you ring while any of its sides waits; the card offers the chain choice; ring not isolated from the main bot's own approval in this run | Improved (not isolated) |
| S-5 nickname, empty mission/memory | nickname "Gummies" | nickname "Peach/Bean/Sprout", empty mission; card line names the question | Not fixed (not in scope) |
| New: Bring back | n/a | works; sends the quoted answer as the person's message, the button turns "Brought back", the bot answers in a turn | New, works |
| C-1 no help asked | 0 of 1 | 0 of 2 (2a and 2b), copies the sibling folder; v7's delegation rule covers work outside the mission only | Not fixed |
| C-3 review verdict lost | lost; found after 28 minutes by the timer | verdict arrived in the builder's session within the review's 42 s chain ("final answer to ..."); exact first-run condition (builder's own reply-flagged request) not reproduced | Fixed (partly reproduced) |
| Item moved to the reviewer | assignee "Style Keeper OW" | assignee `self`, the keeper only a linked bot | Fixed |
| C-2, C-4, C-5 | public mission, `ListAgents`, ten stale bots | public mission as before; `ListAgents` not used; about 45 bots in `list_bots`, the right keeper still picked after the nudge | Unchanged |
| T-1 closing chatter, many turns | Claude 38 turns, 41 messages, 5.08 M tokens, $2.27; Codex 16 + 14 turns, 17 + 11 messages, 2.74 M tokens, with closing noise | Claude 26 + 8 turns, 23 + 10 messages, 4.20 M tokens, $1.90, one closing turn; Codex 25 + 15 turns, 32 + 19 messages, 4.04 M tokens, three closing turns | Not fixed (Claude slightly lower on a lighter workload; Codex worse) |
| T-2 "read item N" fails | both providers, memory fact | the coder read the lead's item with `board`; still no spec in the brief and no item number in the message; memory fact again | Improved |
| T-3 about 20 folded message lines | yes | yes | Unchanged |
| T-4 stale reports of staff | yes | yes ("5 failing tests" reported before the tester updated them) | Unchanged |
| 37 approvals in the first run | 37 (17 for the Team's staff) | Team: 4 cards, 11 uses of standing approvals; Side and Support were answered "Allow once" by my loop (13) | Fixed for the Team (one card per kind and chain) |
| P-1 chain cause "timer" for a person's board edit | cause timer | n/e (the audit does label my direct message "You asked R2 Coder") | n/e |
| P-2, P-3 status turns, edit form fields | cost per check-in | n/e | n/e |
| Mention of a busy bot | effective | n/e | n/e |
| N-1 a side costs more | 56,361 to 62,766 tokens, $0.024 to 0.030 | 81,617 to 112,191 tokens, $0.096 to 0.132 per side | New |

## Analysis: was each fix effective

- **Side beside the conversation (9a): effective.** Evidence: three sides, three cards, none of them became an input; Maker R2's chain list
  holds only my four inputs; the transcript tail after the third side is my own CHANGELOG turn. The first run's cost of a side to the
  main conversation (a restating turn of 91,032 tokens and three copies of the text) is gone. The side's own cost rose (N-1), so
  the side itself is dearer while the main bot is cheaper. Bring back is the person's choice and costs one main turn (27,500 tokens).
- **Draft cleared: not effective.** Evidence: the roster showed `Draft /side ...` and a fresh page restored the text three times (35
  minutes after the last send for the final check). The clearing seems to happen in the page's local state when the conversation is
  shown again, not in the stored draft, so it is lost to a new page. The next typed text, in a new page, would still be appended to the
  old text, as in the first run.
- **Delegation as one path, v7 (C-1): not effective for the case that mattered.** Evidence: 0 of 2 builders asked, both read sibling folders and
  guessed. The wording covers "work outside your mission"; a missing convention is inside the builder's mission. The builder in 2a
  even saw two different conventions in two folders and asked the person, not the keeper.
- **Answers reach the sender (C-3): effective.** Evidence: both reviews and 20-odd Team exchanges show `final answer to` arriving in the
  asker's session, and the review verdict was reported to the person 42 s after the request instead of 28 minutes. Side effect:
  every routed answer starts a turn of the receiver, which feeds the chatter of T-1.
- **Messages never reassign items: effective.** Evidence: the builder's item has assignee `self` and a bot link after a review request.
- **Assignee reads its item (T-2): partly effective.** Evidence: the coder read item 1 on the lead's board. Nothing made the lead put the
  item number or the spec into its message; the first answer was "item 1 has no actual spec" and the lead recorded the same lesson as in the
  first run.
- **No closing chatter, `ack` (9c): not effective in this run.** Evidence: the base instructions have the sentence (they are in each bot's
  first message) and the Claude lead still answered a confirming report in its last turn; the Codex lead answered three; the models never
  used `ack`; I saw no marked message. The loop is produced by the lead's own confirmation requests plus routed answers, which an
  "acknowledgements fold" does not touch, because the answers are not acknowledgements, they restate "already done".
- **One approval per chain and folder (9d): effective, with a limit.** Evidence: 4 cards for the Team (17 for the staff in the first run),
  11 uses answered by the Controllers, audit lists each grant with "Ask me again". The limit: a grant is per kind and folder and per chain, so a
  chain with Bash, Write and Edit asks three times, and the person's direct message to the coder started a chain of its own that asked once
  more. The Write grant was applied 0 times (the writer's one request was the grant itself).

## Reflection: what can still improve, ranked

1. **Make the ask-for-help rule trigger on missing knowledge (C-1).** Not fixed, and it decides whether Call For Support exists. Restore
   the v6 sentence beside the delegation one: "When you do not know how this project does something, or a change should be reviewed,
   look at `list_bots` before you guess or copy a neighbouring folder, and ask the bot whose mission fits." Verify with 2b, which has
   no confound.
2. **Cut the chatter at its source (T-1).** The staff's final text goes back as an answer to every request, including a lead's
   "report on ..." check-in, and the lead answers every answer. Options: do not start a turn for a routed answer that comes from a check-in
   or that arrives after the item is done; or stop the lead from sending status requests while its items are marked done. Measure with
   the Codex Team run: 25 turns before the delivery text plus 3 after.
3. **Clear the draft of a `/side` where it is stored (S-3).** One cause, visible in a second, and it garbles the next side.
4. **Approve more per card.** One grant per tool kind, folder and chain still means 3 cards plus 1 for a direct message to a staff
   bot. Offer "Allow file edits in this folder" as one group (Write, Edit), and let a person's direct message to a staff bot join the
   chain that hired it, so the grants carry over. Also offer the chain choice on the side's card in the first place (my loop did not use it
   there).
5. **Look at the side's cost (N-1).** 80,000 to 110,000 tokens and $0.10 to $0.13 for a one-turn answer is 3 to 5 times the first
   run's. Check the standing instructions and tool search of a temporary bot against what a side needs.
6. **Put the item number and the spec in the staff's input (T-2).** The Relay can add `Item N` and the brief to the first message of
   an assignment, so that the lead's memory fact is not needed; the reader rule is then a fallback.
7. **Show the side's approval where the person looks.** Separate the ring of "a side needs you" from the bot's own (a different mark or
   text such as "Peach needs you"), since the two cannot be told apart in the roster now.

## What worked and should stay

- The side card with Open and Bring back; the main bot left alone.
- The chain's "Allowed for this chain" list in the audit with "Ask me again".
- Verdicts reaching the asker, and the board keeping the assignee of an item.
- The board, the `[The person wrote to X]` notice to the chief, and the chief's plan changes with a reason, as in the first run.
