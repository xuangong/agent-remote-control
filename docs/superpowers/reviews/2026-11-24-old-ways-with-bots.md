# The older features' ways of working, done with bots

Date: 2026-11-24. Branch `feat/bots-8-boards`, local instance of the worktree `.worktrees/bots-8` (build `3566a635`, instance
`bots-8-5ac6711d`, one Host with Claude Code and Codex enabled). This is a record of use, not a test: I played the owner, drove real
sessions with realistic small software tasks in the instance workspace, and wrote down what happened. Nothing here is a pass or fail
check, and no code was changed. Quotes are short and copied from the sessions; numbers come from the Relay's team records, board
records and the audit (chains), read through `agent-remote-controller-dev api`. Times are UTC unless a screenshot shows the page's local
time (UTC+8). Screenshots are headless captures under `.tmp/local/ow/` (ignored by git).

What the old features were for (design `2026-11-23-bots-design.md` sections 9 and 10, plans `bots-7-folds` and `bots-8-mentions`):

| Old feature | Purpose | Replaced by |
|---|---|---|
| Side | A question beside the conversation that does not disturb the main work | A temporary bot started with `/side` |
| Call For Support | A bot that cannot do something well gets help from a specialist and carries on | A bot asks the standing bot whose mission fits (`list_bots`, `message`) |
| Team | A chief organises staff to deliver one piece of work | A chief bot, its standing staff, its board |
| TPM | One owner tracks a multi-step piece of work over time and resumes it | A bot whose board holds the work |

## How the session was run

- Helpers outside the repository (`/tmp/old-ways/*.mjs`) only wrapped the instance's Controller command line: create a session, put it in
  a group with a mission (`POST /v1/windows`), send a message, read history, read boards (`GET /v1/remote/teams`) and chains
  (`GET /v1/remote/chains`), start a side bot (`POST /v1/remote/teams/create`) and a mention (`POST /v1/remote/teams/ask`). The page was
  driven with headless Chromium: typing in the composer, the board edit form and memory field in the details, screenshots.
- Approvals: Claude Code sessions ask for permission on `Write`, `Edit` and some `Bash` commands. A background loop of mine answered every
  pending `tool_approval` of the sessions of this run with "allow once" (37 approvals; summaries such as "Allow Edit?", "Allow Write",
  "A variable i...", "Parser skipp...", "Contains brace expansion"). Codex sessions asked for none. No bot asked the person a question.
- Pre-existing sessions of earlier scenario runs (about 37 sessions, among them groups called "Scenarios Chief ...", "Reviewer ...")
  were left alone. They are on the account, so they show in the roster and in `list_bots` (see Side finding S-4 and Support).
- Codex sessions created: Lead CX, Coder CX, Tester CX, Docs CX, Tracker CX; all five released at the end
  (`session release <address>` answered `{"released": true}`).
- Realism limits: the person here is a script that answers within seconds and never gets bored, so "effort" below is counted in
  inputs and approvals, not in minutes of attention. All sessions used the default model of the instance (shown as `claude-opus-5.5`
  on Claude Code's details).

## 1. Side

**Goal.** While working with a bot on a small script, ask a side question beside the conversation and carry on with the main work.

**Setup.** Standing bot `Maker OW` (Claude Code), group of its own, mission: "You are the person's hands-on developer. You build small
scripts and their docs in the working directory, in small steps, and tell the person what you did in short plain words."

**What I did (inputs).**

1. To Maker OW: "Please create a folder ow-side with a shell script greet.sh that prints "Hello, <name>!" for its first argument (default
   "world"), and a README.md that says how to run it. Then tell me the exact usage line."
2. 10 s later, while it worked, a side question through `POST /v1/remote/teams/create` (what `/side` does):
   "Quick side question: what is the difference between $0 and $@ in a POSIX shell script? Two sentences please."
3. "Good. Now add a --shout option to greet.sh that prints the greeting in upper case, and document it in the README." (typed in the page)
4. Then, typed in the page composer: "/side Is it better to use printf instead of echo in a portable shell script, and why?"
5. "Next, in ow-side please write a test.sh that runs greet.sh with no argument, with a name, and with --shout, ... Then add a CHANGELOG.md
   in Keep a Changelog style with the changes so far." and 8 s later, a third side: "Sorry, side question: what does `set -eu` do at
   the top of a shell script? One short paragraph."

**What the bots did.**

- Main work: Maker OW wrote `greet.sh` and `README.md` in one turn (one Bash approval) and answered with the usage line
  `./greet.sh [name]`. `--shout` was added in about a minute; `test.sh` and `CHANGELOG.md` in about 48 s (one Bash approval, summary
  "Contains brace expansion").
- Side 1 ("Side: shell question"): a temporary bot with Maker as chief was created at once (`Worker`, mission = my text). It answered
  from knowledge without tools and sent its answer to Maker OW with `message` (status done), "Answered from knowledge; nothing run."
  Chain: 1 message, 2 turns, 56,361 tokens, $0.024 in its final state (27,537 tokens after its first turn), started 14:55:19, finished its answer at 14:56:06.
- Side 2 (page `/side`, auto-named "Gummies", chip "Side"): it ran a shell loop in four shells to check `echo` behaviour. That needed
  an approval (summary "A for or select loop in this command can't be checked before it runs"); after my "allow once" it answered with a
  table of what `/bin/sh`, `bash`, `zsh` and `dash` print. Chain: 58,770 tokens, $0.024, 18 s from start to finish plus the approval wait.
- Side 3 ("Side: set -eu"): answered in 20 s, 62,766 tokens, $0.030.
- Every finished side sent its answer into Maker OW's main session as an input
  (`[Task 8c3c7336-... · done · Side: set -eu]` and "This is the worker's report. Check what matters before relying on it, then tell the
  person what it means for their request."). When the main turn was running, the report waited and then started a second main turn:
  Maker OW's transcript is "I added test.sh and CHANGELOG.md ..." followed by the Task done card, followed by a second assistant message,
  "The helper's explanation of `set -eu` is right: ... One thing to add: `-o pipefail` doesn't work in every `sh`. ... I haven't added it,
  because you didn't ask for it. Want me to?" The main bot restated the side answer and added its own view of the main work.
  Main chain with this turn: 91,032 tokens.

**Screenshots.** `.tmp/local/ow/s1-maker.png` (Task done card plus restatement in the main conversation, Mission and Memory in the details),
`s1-side-page.png` (the side opened as "Gummies", "Task from Maker OW", "Gummies is working"), `s1-side-answer.png` (the printf answer table),
`s1-maker-after-sides.png`.

**What went wrong or felt awkward.**

- S-1. The side's answer lands in the main conversation: a "Task done" card with the whole answer, then a second assistant message from
  the main bot that repeats it. The side was meant to be beside the conversation; here it comes back into it, costs a main turn
  (and the main context grows by the answer twice), and the person reads the same two sentences three times (side page, card, restatement).
- S-2. The side bot's final text is its answer, but the base instructions make it end with `message` to the chief: its own transcript
  says "I sent the answer to Maker OW." before the answer. The answer is therefore in two places, and the side page leads with the delivery
  sentence rather than the answer.
- S-3. After sending `/side ...` from the composer the draft was not cleared: the roster row kept "Draft /side Is it better to use ..." and
  the composer still showed the text (the page screenshot after sending shows it overlapping the placeholder). In a later session my
  next typed text was appended to the old draft and became a garbled side bot ("Plum", mission "Is it better to use printf instead of echo
  in a portable sh@Style Keeper OW does a one-line changelog entry need the au..."); its answer then reached Maker OW and the main bot
  answered with the confusing "A second helper answered the printf versus echo question ... I don't know of that question or of Style Keeper"
  (`s5-mention.png`, `s5-mention-answered.png`). A cleared draft would have avoided this; I cannot tell whether it is the page or my
  headless context closing too early, but the draft was persisted and restored by the server.
- S-4. A side shell question needed an approval (loop in four shells). The approval sits in the side's own conversation; the main
  conversation shows nothing about it. With a real person away, the side stays "Working" until they find it.
- S-5. The side is named by a nickname ("Gummies", "Plum") and shows in the roster as an Ungrouped row under the main bot; the "Side" chip is
  small. Its details show an empty mission (the mission is the first message, so it appears as the first card instead) and an empty memory.

**Outcome.** The side question was answered quickly (20 to 60 s) and the main work was not blocked. The page and the main context were
not left alone, as the old Side promised.

## 2. Call For Support

**Goal.** A bot hits something it does not know (a project convention, a review) and gets help from the standing bot whose mission
fits, then continues.

**Setup.** Two standing bots, each in a group of its own. `Style Keeper OW`: "You are the keeper of this project's conventions and the
reviewer of changes to it. Conventions: every shell script starts with "#!/bin/sh" and then "set -eu"; scripts print with printf, never
echo; a usage error exits with status 64 and prints "usage: <script> <args>" to stderr; every script ships with a test_<name>.sh beside
it. Changelog entries (CHANGELOG.md, newest on top) are one line each, start with a past-tense verb, end with the author tag "(ow)", and
carry the ISO date. When a bot or the person asks about a convention or asks for a review, answer in a few lines, citing the rule."
`Builder OW`: "You are the person's developer for small scripts in the working directory. You work in small steps and tell the person
briefly what you did." The conventions are in no file; only the keeper knows them.

**What I did (inputs).**

1. To Builder OW: "Please create ow-support/backup.sh that copies the file given as its first argument to the same path with a .bak
   suffix, plus the changelog entry for it in ow-support/CHANGELOG.md. Follow the project conventions."
2. After its reply, because it had not asked anyone: "This does not follow our project conventions. You have no way to see them in the
   files, but some bot here is the keeper of them: find it, get the rules from it, then fix backup.sh and the changelog entry accordingly."

**What the bots did.**

- Round 1 (15:08:14 to 15:09:30 UTC, 4 approvals). Builder OW looked for conventions in the neighbouring
  `ow-side` folder (a Bash `ls`, `cat` of its scripts, then `ls` of a `.claude` folder), never called `list_bots`, wrote the files in the
  style of `ow-side` and said: "ow-support/ didn't exist and there's no written conventions file, so I copied the style of the nearby
  ow-side/ scripts". The result broke every convention: no `set -eu`, exit 1 on a usage error, no `test_backup.sh`, a Keep a Changelog
  file with sections and no `(ow)` tag. It was honest about it ("exits with status 1", "If a .bak file already exists, the script
  overwrites it without asking"), but it did not seek help. No board item, no message.
- Round 2 (after my nudge). Builder OW called `ToolSearch` for its tools, `ListAgents` (a native Claude tool that listed 12 peer sessions
  of the machine, not bots) and `list_bots`, put a board item and plan on its board ("Person said my first version ignored the conventions
  Style Keeper OW keeps."), and messaged the keeper (brief on the item: "Hi, Builder OW here. I'm writing ow-support/backup.sh ... Please
  send me the full current conventions"). It said: "Style Keeper OW is the keeper. Its mission lists rules, but I'll ask it directly to
  confirm the current set." The keeper answered by `message` with `reply_to` in one line: "Scripts: #!/bin/sh then set -eu; printf,
  never echo; on a usage error print "usage: backup.sh <file>" to stderr and exit 64; put test_backup.sh beside it. CHANGELOG.md: newest
  on top, one line, past-tense verb, ISO date (YYYY-MM-DD), ends "(ow)". The rules don't fix where the date goes."
- Builder OW then rewrote `backup.sh`, added `test_backup.sh`, rewrote the changelog line, ran the tests (the first run failed because
  `mktemp` is blocked by the sandbox in the default temp directory; it fixed that itself), set its board item to waiting and asked the
  keeper to review, naming the item. The keeper read the three files, ran the test and finished with the final text "Reviewed all three
  files and they follow the conventions. ... Approved." (screenshot `s2-keeper.png`).
- Builder OW's item then read "waiting" with the result "Fixed per conventions; test_backup.sh 3/3 PASS. Awaiting Style Keeper OW
  review.", its assignee shown as "Style Keeper OW" (the review request named the builder's own item, so the item was assigned to the
  keeper). The keeper's "Approved" never arrived in Builder OW's session: a search for "Approved" in it found nothing. Builder OW only
  learned of the review about 28 minutes later by the chain timestamps (15:11 to 15:40), when its fallback timer fired ("Nothing has reached you for a while. Look at your open
  work ..."): it read the keeper with `read_bot`, found the later full review the person had asked of the keeper for another reason, and
  reported: "I checked on the review. Style Keeper OW hasn't answered my request yet, but in a separate review it did for the person, it
  passed backup.sh and test_backup.sh." The item still stood at "waiting" at the end.
- Cost. Round 2 chain `Builder OW + Style Keeper OW`: 5 turns, 3 messages, 587,026 tokens, $0.40 by 15:21:00. Round 1 chain: 178,609
  tokens, $0.10.

**Screenshots.** `s2-builder.png` (the builder's message "My version breaks several of these: it has no set -eu ... I'm waiting for its
reply because the mission doesn't say where the date goes", the board in the details: plan, item "Waiting", "Assigned to Style Keeper OW",
links, result), `s2-keeper.png` (the keeper's conversation: standing instructions, "Message from Builder OW · Item 1", its reply, the
review "Approved").

**What went wrong or felt awkward.**

- C-1. Nothing makes a bot ask for help. The base instructions say how to message and name `list_bots`, but not "when you do not know
  how the project does something, ask the bot whose mission fits before you guess". Builder OW guessed from neighbouring files, produced
  something wrong and sounded sure. The person had to notice, say that a keeper exists and tell it to ask. That is the opposite of the
  old Call For Support, which a bot could invoke by itself.
- C-2. The keeper's mission is visible to every bot in `list_bots`, so the "help" was already in the mission text; the builder
  could have followed the rules without a message. The message added one extra round trip (about 20 s) for the single detail the mission
  did not settle (the date's place). That is fine, but it shows a standing bot's mission is both its job description and a public
  knowledge file.
- C-3. The review verdict was lost. A final text from a bot that was messaged with `reply_to` set was not routed back to the sender
  (hypothesis: a message that is itself a reply is treated as an acknowledgement, "do not thank a reply"). The sender then waits on a
  `waiting` item until the timer, 28 minutes later. In the page the keeper's row shows the verdict with an unread dot and the builder's row
  shows "Waiting".
- C-4. `ListAgents` (a native Claude tool) lists every peer session on the machine, bots or not; the base instructions tell the bot to
  use `create_bot` and `message` instead, but this bot's first look was there.
- C-5. The account's other standing bots (about ten "Reviewer", "Chief", "Planner", "Helper" bots from earlier runs) are in `list_bots`
  with their missions. A real account with many bots would make the choice harder; the matching here was easy only because the
  keeper's mission was distinctive.

**Outcome.** With the person's nudge the bot way works: the right standing bot was found and the rules were applied and reviewed.
Without it the bot did not ask, and the result was wrong. The review loop did not close.

## 3. Team

**Goal.** A chief organises 2 to 3 standing staff to deliver one piece of work; midway the person speaks to one staff bot and changes a
detail; see how the chief learns and adapts its board. Done with Claude Code, then repeated with Codex.

### 3a. Claude Code

**Setup.** `Lead OW`: "You lead the delivery of small software pieces for the person. You organise standing staff for roles that recur
(a coder, a tester, a documentation writer), keep the plan on your board, and sum up for the person in plain words. You do not write the
code yourself."

**What I did (inputs).**

1. To Lead OW: "I need a small tool delivered in the folder ow-team: wordstat.sh, which prints the number of lines, words and characters
   of the file given as its argument (like a tiny wc), with a test script and a README. Please set up a coder, a tester and a docs writer
   as your standing staff, split the work between them, and tell me when it is delivered."
2. About 3 minutes in, straight to the Coder: "Small change of plan from me: wordstat should print labelled output on one line, like
   `lines=3 words=12 chars=60`, instead of bare numbers. Please change the script."

**What the bots did.**

- Lead OW created Coder OW, Tester OW and Writer OW as standing staff with missions, then wrote a board: item 1 "Deliver wordstat in
  ow-team/", items 2, 3 and 4 for the three staff with briefs and the plan note "wordstat: coder writes the script (item 2); tester
  writes tests from the spec in parallel, runs them once the script exists (item 3); writer writes README in parallel (item 4). Then
  Style Keeper OW reviews, I report to the person." It chose, by itself, the keeper from Support to review (the keeper's mission was in
  `list_bots`). The briefs on the items said "Read item 1 for details"; the staff cannot read the chief's board. The lead wrote a memory
  fact after that: "My staff can't read my board items. Put the full spec in the handoff message itself (or in a file in the repo); never
  just say "read item N"."
- The person's message to the Coder: the Coder changed the script (`sed -i` on `wordstat.sh`, a new top line in `CHANGELOG.md`), then
  said: "Lead OW's spec says bare numbers, so I'll let them know the format changed (their tester may be writing against the old one)."
  and messaged the lead. Independently the lead had received the Relay's notice, `[The person wrote to Coder OW] Small change of plan
  from me: ...`, and had written to the Coder: "I saw the person's request for labelled output (lines=N words=N chars=N), so go ahead.
  Please also add a CHANGELOG.md line for it, and tell me when it's done so the tester and writer can follow." The coder answered
  "Already done; replying with the status."
- The lead's board after the change: plan note "Output format changed to lines=N words=N chars=N. Coder OW changes script + CHANGELOG
  line; then Tester OW updates/reruns tests and Writer OW updates README; then Style Keeper OW reviews; then I report delivery." with the
  change line "The person asked Coder OW directly for labelled output."; items 3 and 4 reopened with the result "Reopened: tests must
  expect labelled output once Coder OW changes it." / "Reopened: README output format/example must show labelled output."
  (screenshots `s3-lead.png`).
- The lead then told the user honestly that the earlier pass was against the old format: "Tester OW and Writer OW both reported
  success, but they checked the old version from before the change. I've asked them to update the tests and the README for the new
  format and run them again. It isn't delivered yet."
- The keeper's final review found two slips (a comment before `set -eu` in the test script; the README test count out of date), the
  fixes came back, and the lead's final text: "wordstat.sh is delivered in ow-team/, and Style Keeper OW's final review passed. ...
  test_wordstat.sh has 8 tests, and all 8 pass. ... Coder OW, Tester OW and Writer OW stay on as standing staff for the next piece."
  I ran the delivered `test_wordstat.sh` myself: `8 passed, 0 failed`; `wordstat.sh` printed `lines=2 words=3 chars=6` for a two-line file.
- Totals. One chain from the person's request: 38 turns, 41 messages, 3 bots created, 5,075,412 tokens, $2.27, from 15:16:01 to
  15:22:30 (about 6.5 minutes). The direct message to the coder was a second chain of 1 turn (108,937 tokens, $0.05). Approvals for
  the staff: Coder 3, Tester 7, Writer 7 (all "allow once"), none asked of me by the lead.
- Final board of Lead OW: 5 items done (the delivery, three staff items, the review item), each with a one-line result.

**Screenshots.** `s3-lead.png` (final summary and board, plan note with "Changes (4)", "Done (5)"), `s3-coder.png`.

**What went wrong or felt awkward.**

- T-1. Cost and chatter: a 15-line script, a 90-line test and a 55-line README cost 5.1 million tokens and 38 turns. Most turns
  were messages answering messages (acknowledgements of acknowledgements, "Already done; replying with the status", "Writer OW
  confirmed again that the README is up to date; nothing new there").
- T-2. "Read item N" handoffs failed once and cost a round trip; the board's brief is private to the chief but the base instructions
  and the item tag both suggest otherwise (`[Item 2 "Code ow-team/wordstat.sh" · from Lead OW]` reads like a pointer).
- T-3. The chain is long and in the page the lead's conversation shows each staff message as a folded line ("Message from Writer OW")
  with the lead's reply under it; the person sees about 20 of them (screenshot) and has to find the one that matters. The summary was
  accurate and clear.
- T-4. The tester and writer finished in parallel with the coder's change landing; their first reports described the old behaviour. The
  chief caught it only because it had been told by the Relay's notice; nothing else would have shown the mismatch.

### 3b. Codex

**Setup.** `Lead CX` (Codex), the same mission plus "You work only inside the folder you are started in."

**Inputs.** (1) "I need a small tool delivered in the folder ow-team-cx: slugify.sh, which prints the slug of the text given as its
arguments (lower case, words joined by single dashes, everything else removed), with a test script and a README. Please set up a coder,
a tester and a docs writer as your standing staff, split the work between them, and tell me when it is delivered. Staff must work only
inside ow-team-cx." (2) about 80 s later, directly to Coder CX: "Small change from me: the slug must be cut at 40 characters, and never end with
a dash. Please change the script accordingly." The platform answered `"disposition": "queued"` because the coder was running a turn.

**What the bots did.** The staff were Codex sessions too (provider follows the chief). The lead's board had items 1 to 3 assigned
within a minute, then its plan note read "Direct messages supply briefs because cross-board reads fail." with the change line "All three
staff reported cross-board access denied; direct briefs unblock their work." (the same problem as in 3a). The person's direct message
was noticed: change line "The person told Coder CX to cap slugs at 40 characters and never leave a trailing dash; tests and docs must
match." Final: coder "implemented executable POSIX slugify.sh with 40-character truncation and trailing-dash removal", tester "Expanded suite
inspected and run by Lead: 28 passed, 0 failed. Covers 39/40/41+ lengths, dash at position 40...", docs verified. I ran the delivered script:
a 78-character title came out as `hello-world-this-is-a-very-long-title-th` (40 characters) and `test_slugify.sh` printed `28 passed, 0 failed`.
Chains: the person's request 16 turns, 17 messages, 1,425,261 tokens, 15:39:58 to 15:43:32 (3.5 minutes); the coder's direct-message chain 14
turns, 11 messages, 1,315,672 tokens (15:40:44 to 15:44:10) (cost not reported for Codex). Approvals: none.

**Awkward.** After delivery the page ended with noise rather than the summary: the lead's final summary ("Delivered in ow-team-cx:
slugify.sh, test_slugify.sh, and README.md. Slugs are capped at 40 characters ...") was followed by several more turns of mutual closure
("Item 2 is closed with 28/28 tests passing", "Already recorded: 28 passed, 0 failed. Item 2 remains closed; no further action needed.",
"The board already records 28/28 passing ... No further reports needed unless a new issue appears.") because the tester kept messaging
the lead; the conversation's last words (and the roster preview) are the closing noise (`s6-codex-lead.png`). The Codex team used
fewer tokens than the Claude team and finished sooner, mostly because it did not reopen items twice.

**Outcome (3a and 3b).** The purpose was reached both times: delivered, tested, reviewed, and the person's direct change
reached the chief within the same minute and the chief re-planned on its board with a reason. The attention cost for the person was low
(one request, one direct change, a few approvals on Claude Code); the token cost and the message volume were high.

## 4. TPM

**Goal.** One bot tracks a multi-step piece of work on its board across several separate check-ins from the person over time
("where are we?", "continue"), including one where the person edits its board or memory in the details to steer it; does it resume from
the board? Done with Claude Code, then repeated with Codex.

### 4a. Claude Code

**Setup.** `Tracker OW`: "You track one piece of work to its end for the person: the release of the tool in ow-side (greet.sh) as version
1.1. You keep the plan and the steps on your board, do the steps yourself when they are small, and answer the person's check-ins ("where
are we?", "continue") from your board. You never do more than the person asked for in one go."

**What I did (inputs, in order).**

1. "Let's prepare release 1.1 of the greet tool in ow-side. The steps, in order: 1) add a --version option that prints "greet 1.1.0"; 2)
   update the test script to cover it; 3) update the README usage and the CHANGELOG for 1.1.0; 4) build a release archive
   ow-side/dist/greet-1.1.0.tar.gz holding greet.sh, README.md and CHANGELOG.md; 5) final check of the archive contents. Put these on your
   board. Do only step 1 now, then stop and wait for me."
2. "continue"
3. "where are we?"
4. In the page, in the bot's details, Board section: opened item 4, "Edit item", set the title to "4) Build
   ow-side/dist/greet-1.1.0.zip (greet.sh, README.md, CHANGELOG.md) as a zip" and the brief to "Make a .zip, not a tar.gz: our release
   tooling only accepts zip archives.", "Save item"; then in Memory added the fact "Release archives are .zip files named
   greet-<version>.zip; never tar.gz." (`s4-board-edit-form.png`, `s4-board-edited.png`). I said nothing to the bot.
5. "continue" (step 3), then "/compact" (to lose the context), then "Where are we, and what will you do on the next step?", then "continue"
   (step 4), then "continue" (step 5).

**What the bot did.**

- Kickoff: put five items and the plan "The person releases one step at a time: do only the step they ask for, then stop and wait." on
  its board, did step 1 (prints `greet 1.1.0`), marked item 1 done with its result, and stopped: "Say "continue" when you want step 2."
  It created no temporary bot and no staff; it did the small steps itself, as the mission said. 54 s for the first turn.
- "continue" did step 2 only (`test.sh` 5/5 pass), "where are we?" answered from the board with the five steps and status marks, and
  asked for "continue" for step 3.
- After my page edit of item 4 and the memory fact the bot woke on its own (chain cause "timer", 3 turns, 201,550 tokens): "You changed
  step 4: it now builds ow-side/dist/greet-1.1.0.zip instead of a tar.gz, because your release tooling only accepts zip files. I've
  updated the plan on my board to match, and step 5 will check the zip's contents. I haven't built anything yet; I'm still waiting for
  you to say "continue" for step 3." The plan note gained a change line "Person changed step 4 to a .zip archive because their release
  tooling only accepts zips." Nobody had asked it to look.
- Step 3 ("continue"): it moved the changelog entries under a new `[1.1.0] - 2026-11-24` heading and raised a decision: "there was no
  earlier release section in the CHANGELOG ... If 1.0.0 was actually released, tell me its date and I'll split those entries into a
  1.0.0 section." The question stayed open to the end.
- After `/compact` (reply "Compacted") the bot read its board again (the `board` tool call is in the transcript) and answered "Steps 1-3
  of 5 are done. ... Next step (4): I'll build ow-side/dist/greet-1.1.0.zip ... It will be a .zip, not a tar.gz, as you changed it."
  Steps 4 and 5 then ran: a 1,203-byte `dist/greet-1.1.0.zip` with the three files, `unzip -t` clean, extracted files byte-identical to the
  sources, executable bit kept, `--version` printing `greet 1.1.0`.
- All five items ended "done", each with a one-line result. Whole run: 10 chains, 1,161,717 tokens, $0.63. Approvals: 6.

**Screenshots.** `s4-tracker-before-edit.png` (conversation with check-ins; details Board with plan and items 3 to 5 "Open", "Done (2)"),
`s4-board-edit-form.png`, `s4-board-edited.png`, `s4-tracker-final.png`.

**What went wrong or felt awkward.**

- P-1. Nothing visible tells the person that the bot woke up after the edit and re-planned, other than the extra assistant message in the
  conversation. The chain's cause is recorded as `timer` although the trigger was the person's edit.
- P-2. Each check-in is a full model turn. Ten chains for five steps; a "where are we?" costs 63,438 tokens (a read of the board and a
  summary; 90,526 after the compaction) against 123,266 to 149,063 for a step, so a bare status question costs about half a step.
- P-3. The item title the person typed is the bot's own item text, so the page's edit form worked, but it only offers title, status,
  assignee, brief; the "result" and "latest report" (what the bot wrote) cannot be corrected there.

### 4b. Codex

**Setup.** `Tracker CX` (Codex), the same mission for `slugify.sh` 1.1.0 in `ow-team-cx`, "You work only inside ow-team-cx."

**Inputs.** The same five steps (`--version` printing "slugify 1.1.0", test script, README and a new CHANGELOG, a `.tar.gz` of the
three files, final check), then "continue", "where are we?", the same page edit of item 4 (to `.zip`, with the same brief) and a memory fact
("Release archives are .zip files named slugify-<version>.zip; never tar.gz."), "continue", "/compact" (Codex answered with its own context
summary: "Steps 1-3 done ... ZIP is required by release tooling. Board plan version 8"), then "continue" twice.

**What the bot did.** The same shape. Board after kickoff: plan with three change lines ("Initialized the board from the standing mission;
no existing items were present." and so on), item 1 done, items 2 to 5 open. After the page edit the bot woke by itself ("I'll read the updated
board and reconcile the archive format in the plan.") and rewrote the plan note and the next-step text: "Step 4 builds
ow-team-cx/dist/slugify-1.1.0.zip ..." and the assistant message "The planned archive is `slugify-1.1.0.zip`." The archive built was a
zip, and the final check passed ("valid ZIP; exactly slugify.sh, README.md and CHANGELOG.md at root; all bytes match source files;
slugify.sh executable ..."). The input text of the person had said `.tar.gz` and the item was the only place the change was recorded.

**Cost.** Ten chains, about 3.6 million tokens (cost not reported). The per-check-in tokens in the audit grow along the conversation
(for the last four chains: 119,837, then 611,392 after the compaction, 741,045 and 879,008), while the Claude bot's stayed between 42,000 and 201,550. The two "where are we?" asks cost 327,670 tokens (before the edit) on Codex against 63,438 on Claude Code.
Each Codex step took 46 to 50 s, a bit longer than Claude Code's 30 to 38 s. Screenshot `s7-codex-tracker-final.png`, audit
`audit.png` and `settings.png` (Settings > Assistants > Bots' work lists "You asked Tracker CX ... 879,008 tokens").

**Outcome (4a and 4b).** The bot resumed from its board in both providers and after a compaction; the person's board edit steered the work
without any message from the person. The person's check-in pattern works: each "continue" did exactly one step.

## 5. Mention of a busy bot from another conversation

**Goal.** Mention (`@bot`) a bot that is busy, from another conversation of mine.

**What I did.** To Style Keeper OW: "Please review every .sh file under ow-side, ow-support and ow-team against the conventions, one file
at a time, reading each file in full, and give me a table with one line per file." Twelve seconds later, in Maker OW's page composer:
"@Style Keeper OW does a one-line changelog entry need the author tag, and what is the tag?"

**What happened.** The page showed "Style Keeper OW is answering" under the Maker OW conversation, and 8 s later "Style Keeper OW was asked;
its answer shows here." The answer, folded in the conversation: "Yes. Every CHANGELOG.md entry must end with the author tag "(ow)". Each entry
is also one line, starts with a past-tense verb and includes the ISO date. Example: `Added test_build.sh 2026-11-24 (ow)`." The relay
recorded `asked` 1795534596373 and `answered` 1795534604445 (8.07 s). The keeper's main session was still running its file review (idle at
15:37:37); a search of its history for the question found nothing, and its page shows only the review table (`s5-keeper-after-mention.png`),
so the main session was not disturbed. Chain of the answer session: 1 turn, 25,621 tokens, $0.13. The big review finished with a table of 6
files (two fails in `ow-side` for missing `set -eu`, naming the test `test.sh`), an inconsistency noticed between two scripts' exit codes
for an empty argument, and the question "Should I hand these fixes to a bot?" (`s5-keeper-after-mention.png`).

**Awkward.** In my run the same conversation held the garbled side from S-3, so the page around the answer was confusing; the folded
"Style Keeper OW answered" line hides the answer until opened (`s5-mention-answered.png`).

**Outcome.** The mention worked as designed: a separate session answered at once while the bot was busy.

## Analysis

Evidence is from the records above; I compare with what each old feature was for.

**Side. Partly effective.** The purpose, a quick answer without disturbing the work, is met on speed (20 to 60 s, the main work kept
running) and on cost per question ($0.02 to $0.03, 28,000 to 63,000 tokens), and answers can be better than a plain answer because the side can run a
check (the four-shell echo table). It fails the "beside, not inside" part: every answer is sent into the main session, which restates it in a
second assistant message and spends another turn (91,032 tokens for the main turn of the third side), so the main conversation fills with side
content (S-1). Attention: one input for the person, plus an approval in one of three cases; clarity: the side opens as a separate row but its
"Task done" card and the main bot's restatement duplicate it, and a stale `/side` draft produced a garbled second side (S-3).

**Call For Support. Not effective on its own; effective when prompted.** The old feature let a bot get help without the person. Here
the bot never asked: it guessed the convention from neighbouring files, wrote files that broke five rules, and reported with
confidence (C-1). Only after the person said who to ask did the flow work, and then well: right bot, the rules were applied, tests added,
a review. The person's effort was one extra message plus noticing the problem; latency 15:10:04 to 15:11:44 for the second round; token cost
$0.40 for a 15-line script. Reliability: the review verdict was lost (C-3). The mechanism (list the standing bots with missions, message
one) is sound and lighter than the old profiles and mandates, but it needs a trigger.

**Team. Effective, expensive.** The chief split the work by itself, the staff worked in parallel, the person's direct change reached
the chief in seconds, the chief re-planned with a reason on its board and reopened the right two items, caught that earlier "pass" reports
were stale, and delivered a verified result with an accurate summary. The Codex run did the same faster. Attention cost was lowest of all four
(two inputs). Latency: 6.5 minutes (Claude), 3.5 minutes (Codex) for a task a single bot would do in about one minute. Cost: 5.1
million tokens and $2.27 (Claude), 1.4 million (Codex), about 40 turns and 40 messages, with a lot of closing chatter (T-1). The
person-to-staff direct message is the best part: both the staff bot and the chief handle it, and the board records it. The weakest part is
that the briefs on items were unreadable by the staff in both runs (T-2), costing a round trip each time.

**TPM. Most effective.** One bot, its board, check-ins separated by minutes and a compaction: each "continue" did one step, "where are we?"
answered from the board, the person's edit to an item was noticed unprompted and carried into the plan, and the compaction did not lose the
thread because the bot re-read its board (and its memory is in its instructions). That is what the TPM feature promised, with less
machinery. The cost is per check-in (a status question costs about half a step: 63,438 tokens against 123,000 to 149,000 on Claude Code; on Codex 327,670 for a status and 611,000 to 879,000 per
turn after the compaction) and the page does not say that the bot reacted to the edit (P-1). Clarity: the Board in the details is the
best thing in the page: plan, why lines, status and results are readable at a glance.

**Mention. Effective.** An answer in 8 s from a busy bot, without disturbing it or the asking conversation's main session.

**Common threads.**

- Effort: all four needed few inputs from the person, but Claude Code needed 1 approval per 2 to 3 tool calls (37 in this run); a real
  person would have spent most of their attention there, not on the bots.
- Reliability: two coordination gaps in the same family, a message that does not reach the sender who expects an answer (C-3) and a
  report that reaches the main session as a new turn (S-1) rather than staying beside it.
- Observability: the audit (Settings, Assistants, Bots' work) is good for cost; the chains' cause says "timer" for a person's board edit; the
  page does not connect a chain to the board changes it made.

## Reflection: where the product can improve

Ranked by impact; each is tied to the evidence above. Not implemented.

### Quick fixes

1. **Add a sentence to the base instructions for asking help (C-1).** "When you do not know how the project does something or need a
   review, look at `list_bots`, pick the standing bot whose mission fits and message it before you guess; say what you asked and wait
   on the answer." Evidence: Builder OW guessed and broke every convention; with the same instruction as a person's nudge it worked.
   Impact: restores Call For Support's reason to exist.
2. **Do not send a finished side's report into the main session as an input that needs a reply (S-1, S-2).** Let the side bot end with
   its answer as final text (no `message` to its chief) and show it as a card in the chief's conversation that does not start a turn; or tag
   the input "for information, do not answer". Evidence: 91,032-token main turn restating the answer; three copies of the same text.
3. **Clear the composer draft when a `/side` or `@bot` is sent (S-3).** Evidence: the roster kept "Draft /side Is it better ...", and the
   next typed text was appended to it and produced a garbled side.
4. **Tell the staff how to read an item, or have the tools carry the brief (T-2).** Either a `board` read for the assignee's own item or
   the Relay writing the item's brief into the staff's first input, or, cheaper, a base-instruction line "never say read item N, put the
   spec in the message". Evidence: both Claude and Codex chiefs hit "cross-board access denied" and stored a memory fact about it.
5. **Route a reply to a message that itself carries `reply_to` when the sender is waiting on an item (C-3).** If the base rule
   "do not thank a reply" suppresses the review verdict, mark messages that ask for something (`needs_input` or a request flag) so the
   answer is sent. Evidence: "Approved" never reached the builder; the item stayed "waiting" until the timer, 28 minutes later.
6. **Name the cause of a chain correctly.** A person's board edit shows as cause "timer" in the audit (P-1). Label it "your edit".
7. **Do not assign the sender's own item to the receiver when asking for help.** Builder's item showed "Assigned to Style Keeper OW"
   because the message named the item (C-3 screenshot). A message that asks for help or review should not move the item's assignee, or
   should say "reviewer" instead of assignee.

**Fixed (bots-8).**

- C-1, base instructions v6 (f3190165): a bot that does not know how the project does something, or needs a review, asks the standing bot whose mission fits.
- C-3, lost verdict (c4cb3cea): the cause was `inputCause`, which named no answered message for any input carrying `reply_to`. The builder's review request was itself sent as a reply, so the keeper's final text was never routed back. Only the Relay's own final-text reply ("final answer to") now ends the exchange.
- S-3, draft (ef11bfc6): the composer cleared the saved draft only while its session was still shown; opening the side first left it behind.
- T-2, item read (847cb599): the assignee reads the item handed to it on the other bot's board with `board` (bot and item), read only. Chosen over copying the brief into the input: one read rule, no second copy.
- P-1, cause (d1698c48): the person's edit runs in a chain of its own with cause `person` (shown as "You asked ..."), instead of joining the bot's latest timer chain.
- Item moved by a help request (af97cf2d): a message naming the sender's item assigns it only to the sender's own staff or temporary bots; to a peer it names the item and changes nothing. Later (bots plan 9): a message never assigns, to anyone.

### Larger changes

1. **A short "close the loop" rule for teams (T-1).** After a delivery, staff should stop acknowledging each other's closure; the chief
   should not reply to a report that changes nothing. A message kind "ack" that does not start a turn, or a limit on reply depth per item,
   would have saved about a third of the turns in the Codex run and the final five turns of noise. The audit's reply-depth threshold
   exists ("Tell me when a chain passes ... Reply depth"), but it only reminds; the cost is in the product's default behaviour.
2. **Cheaper status check-ins (P-2).** A "where are we?" could be answered from the board by the Relay or the page without a model
   turn when the bot is idle (the board and its results are already on the page). That removes 63,000 to 330,000 tokens per
   status question. The page's board view is the check-in; a button "Ask where we are" could still call the bot.
3. **Side as truly beside (S-1, S-4, S-5).** A side should have its own conversation, show approvals in the main roster when it needs the
   person, and never push into the main transcript unless the person says "bring this back" (a button "Send to Maker"). Give the side the
   main bot's context read-only, as `read_source_session` does, and name it by its question rather than a nickname.
4. **Make "help" visible.** Show in the main bot's conversation a one-line "asked Style Keeper OW" and in the keeper's roster row who
   asked, so that the person sees Call For Support happen (the builder's board was the only trace). Pair with quick fix 1.
5. **Observability across bots.** One chain view that shows, for the person, the messages between bots with their sizes, the board
   changes they caused and the approvals waiting on any bot of the chain; today the person reads a chain's counts (turns, messages, tokens)
   in Settings and then opens each conversation. Evidence: 41 messages in the Team chain were readable only per conversation.
6. **Approvals by default for staff.** 37 approvals for a trivial team; the person approves a similar action many times
   (Allow Edit?, Allow Write). A per-chain "allow this folder for this chain" would turn that into one input.

### What worked and should stay

- The board with plan note, why lines, results and the person's in-place editing; the notice to the owner when the person edits it.
- The `[The person wrote to X]` notice to the chief when the person speaks to a staff bot directly.
- A mention answered in its own session (8 s, the busy bot undisturbed).
- The fallback timer: it recovered the lost review verdict, albeit 28 minutes late.
- The standing bot's mission as a public job description (it made the lead pick the keeper by itself).
