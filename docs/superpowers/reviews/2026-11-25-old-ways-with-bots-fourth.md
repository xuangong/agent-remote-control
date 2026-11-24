# The older features' ways of working, done with bots a fourth time

Date: 2026-11-25 local (UTC+8); the machine clock read 2026-11-24 20:13 to 21:18 UTC during the run, and clock times below are UTC.
Branch `feat/bots-8-boards`, worktree `.worktrees/bots-8`, build `6f399659eec8` (clean checkout). This is the fourth record of use, beside
[the first](2026-11-24-old-ways-with-bots.md) (build `3566a635`), [the second](2026-11-25-old-ways-with-bots-after-fixes.md) (build `d409519d849b`)
and [the third](2026-11-25-old-ways-with-bots-third.md) (build `b891b4554ef8`). It is not a test: I played the owner, drove real sessions with the
same small tasks, and wrote down what happened. No product code was changed and no test code was written. Numbers come from the Relay's chain
records (`GET /v1/remote/chains`), the Relay's team records (`GET /v1/remote/teams`), the Claude Code transcripts under `~/.claude/projects/` (for
model calls), the sessions' histories (through `agent-remote-controller-dev`) and a headless Chromium. Screenshots are under `.tmp/local/r4/`
(ignored by git). Each scenario was run once, so run-to-run variance applies: a difference of 10 to 20 per cent between records is inside normal
variation, and the model-driven behaviours below (asking, chatter) can go the other way on another run.

What changed since the third record, from [the bots 9 review plan](../plans/2026-11-25-bots-9-review-plan.md), "After the third record": a side
answers by its final text and sends no message to its chief (the Host sends `side_final`, the card shows it); an assignment notice carries the item
number and the first 500 characters of the brief; base instructions v10 ("copying a neighbour's style is a guess too", "do not start work no one
asked for", "answer a message with `message` and `reply_to` set to its id; your final text goes to no one"); and the T-1 change: a bot whose
provider has the bot tools never has its final text routed to a sender as a reply (only toolless providers still do).

## How the session was run

- Same method as the third record. Helpers outside the repository (`/tmp/old-ways4/*.mjs`, copies of the third record's with the names changed to
  R4) only wrapped the instance's Controller command line (create a session, put it in a group with a mission, send, read history, read teams and
  chains), read a Claude Code transcript to count model calls (distinct assistant message ids), and drove a headless Chromium (type in the
  composer, click "Bring back", open a fresh page, screenshots, the Settings audit). `/side` was typed into the page's composer.
- The instance of this worktree had been removed; `pnpm local up` created a fresh one on this build (`bots-8-5ac6711d`, `http://localhost:59571`),
  with an empty workspace and no earlier bots. The state directory name is the same as the old one, so the native Claude Code histories of the
  second record's sessions were still listed (all `unknown`); my approval loop ignored them. Workspace contamination is as in the third record:
  the Side scenario's `r4-side` folder (greet.sh, README, CHANGELOG, test.sh) existed when Support ran. The standing keepers made for Support
  (`Style Keeper R4`, `Docs Keeper R4`) existed during the Team runs, as in the third record.
- Approvals: a background loop of mine answered every pending `tool_approval` of this run's sessions with "Allow once" for Side and Support (14
  approvals: Side 5, 2a 7, 2b 2), and with "Allow for this chain in this folder" whenever the card offered it for Team (3 cards, all offered the
  chain choice). The one `AskUserQuestion` of the whole run (the Claude lead, 3.1) I answered by hand.
- Sessions created: Claude Code `Maker R4`, three side bots (Plum, Nori, Hatch), `Style Keeper R4`, `Builder R4`, `Docs Keeper R4`, `Builder R4b`,
  `Lead R4` (staff `R4 Coder`, `R4 Tester`, `R4 Docs`, created by the lead); Codex `Lead R4X` (staff `R4X Coder`, `R4X Tester`, `R4X Docs`).
- **The four Codex sessions could not be released** (new problem N-10): `agent-remote-controller-dev session release <address>` answered
  `{"released": false}` for each, repeated over about 15 minutes, also after `pnpm local up` restarted the Controller (nothing was running). Their
  Relay seats were still `busy` with undelivered messages (see N-7). They are still loaded in the shared Codex daemon; the addresses are
  `88597e1f-4aa1-44fb-9bd0-ee20382706ce/codex/` + `01a20f5c-7747-7d92-bbd0-184d2eaf48ca` (Lead R4X), `01a20f5d-d4df-7481-a5f3-d6a0bdc9d4e8`,
  `01a20f5d-d55c-7400-a53c-d4999036221f`, `01a20f5d-d5d3-7ae0-93ca-548823fa64dc`. The release should be repeated once N-7 is cleared.
- Realism limits as before: the person is a script that answers within seconds. Default model of the instance for every session.

## 1. Side

**Goal.** Three side questions while working; tokens and model calls per side; the card; no message to the chief; no stray files; the draft on a
fresh page; Bring back.

**Setup and inputs.** `Maker R4` (Claude Code), mission as before. (1) To Maker R4: create `r4-side` with `greet.sh` and a README and give the usage
line; (2) 10 s later in the page composer `/side Quick side question: what is the difference between $0 and $@ in a POSIX shell script? Two
sentences please.`; (3) "Bring back" on that card; (4) "Good. Now add a --shout option ... write a test.sh ... Run it." and 15 s later
`/side Is it better to use printf instead of echo in a portable shell script, and why? Test it in the shells you have if useful.`; (5) "Next, add a
CHANGELOG.md ..." and 13 s later `/side Sorry, side question: run `for s in sh bash dash; ...` and tell me which shells print the -n literally. One
short answer.` The approval loop ran throughout.

**What the bots did.**

| Side | Asked | Answered after | Tokens | Cost | Model calls | What the calls were | Approvals |
|---|---|---|---|---|---|---|---|
| 1 `$0` versus `$@` | 20:16:35 | 8.6 s | 26,387 | $0.134 | 1 | final text | none |
| 2 `printf` versus `echo` | 20:19:48 | 34.4 s | 54,964 | $0.112 | 2 | Bash, final text | 1 (Bash) |
| 3 `echo -n` in three shells | 20:21:47 | 22.9 s | 53,125 | $0.083 | 2 | Bash, final text | 1 (Bash) |

- Third record: 81,746 / 142,519 / 109,339 tokens and 3 / 5 / 4 calls. Now 68, 61 and 51 per cent fewer tokens. There is no `ToolSearch` and no
  `message` call in any side (read in the transcripts of the three side sessions: Bash and the final text only). The Relay's record of each side
  has `messages: []`: nothing was sent to Maker R4. Each side's first call carries the cold cache (about 26,000 cache-creation tokens), which is why side 1's
  dollar cost ($0.134) is higher than its token count suggests; a call that finds the cache warm costs a tenth of that.
- The card shows the whole answer. Each side's result in the Relay is its final text: 307, 2,615 and 317 characters. Side 2's long answer (a table of five shells,
  four numbered points and code) shows in full on the card and is the same text as on the side's page; the third record cut it to 300 characters and the side wrote a
  `printf-vs-echo.md` file to hold the rest. The workspace root holds only `r4-side` after the Side scenario: no stray file (`ls` of the workspace).
- The main conversation was left alone. Maker R4's chains are my four inputs (54,058; 27,461 for Bring back; 57,026; 58,305 tokens, one turn each) and the
  bring-up turn; none was caused by a side (third record: 54,216; 27,618; 57,735; 59,009).
- Bring back on card 1: a person message `From the side "Quick side question: ...":` quoting the answer, the button becomes "Brought back", and the main bot answered in one turn
  (27,461 tokens, $0.010): "That's correct, and `greet.sh` doesn't need any change for it ..." (`s1-bring-back.png`).
- The draft. After the three `/side` sends the roster shows no `Draft` row, and the composer of Maker R4 is empty in a fresh browser context at 20:23 (7 minutes after the
  first send) and at 21:13 (57 minutes after) (`s1-draft-fresh-page.png`, `s1-maker-card-fresh.png`, `s1-draft-fresh-page-late.png`).
- Approvals: 5 in the scenario (3 by Maker R4, 2 by sides), all "Allow once" by the loop within seconds; the side's approval wait was not observed.

**Screenshots.** `.tmp/local/r4/s1-side1-sent.png` (the side's page right after `/side`, still working), `s1-side2-sent.png`, `s1-side3-sent.png`, `s1-card1.png` (the
card with Open and Bring back and the full answer under it), `s1-bring-back.png`, `s1-maker-card-fresh.png` (a fresh page: the cards of side 2 and 3 between the main turns, empty composer),
`s1-draft-fresh-page.png`, `s1-draft-fresh-page-late.png`.

**Problems.**

- S-5 as before: nicknames (Plum, Nori, Hatch), an empty mission in the Details panel of a side (`s1-side1-sent.png`), the chip "Side".
- The side rows keep an orange dot in the roster after they answered (`s1-maker-card-fresh.png`: Hatch, Nori, Plum), like every bot row that holds an unread answer; I did not check what clears it.

**Outcome.** Side is now as cheap as one question needs (one model call without a tool, two with one), the card equals the side's page, nothing is sent to the chief, nothing is
written that was not asked for, the draft is gone, and Bring back works.

## 2. Call For Support

**Goal.** A bot that does not know a project convention asks the bot that knows, by itself (v9 and v10).

**Setup.** As before: `Style Keeper R4` (same convention text, tag "(ow)") and `Builder R4`; for 2b `Docs Keeper R4` (README conventions: three sections "## Synopsis", "## Exit codes",
"## See also", the last line "Maintained by platform-team.") and `Builder R4b`.

### 2a. The same convention task

**What I did.** (1) To Builder R4: "Please create r4-support/backup.sh that copies the file given as its first argument to the same path with a .bak suffix, plus the changelog entry for
it in r4-support/CHANGELOG.md. Follow the project conventions." Nothing else, and no nudge afterwards. (2) After it finished: "Good. Now have the keeper review the fixed files, and tell me its
verdict."

**What the bots did.**

- Round 1 (20:25:17 to about 20:27:16, one chain of 3 turns: builder, keeper, builder; 436,062 tokens, $0.242; 10 builder model calls for the task after 4 for the bring-up). The builder listed
  the workspace, called `list_bots` (20:25:41), saw the keeper's mission, put the item on its board, and sent a message to `Style Keeper R4` before writing a line (20:25:56): "r4-side uses
  echo/Keep a Changelog, unlike your rules, yours apply? Exact changelog line format ...? File header needed? Anything else (cp -p, existing .bak)?" Its reply to me said
  "Nothing is written yet. I've put the job on my board and asked Style Keeper R4 to confirm the conventions before I build it. Two sources of 'project conventions' disagree: ..." It did not copy
  the neighbour. The keeper's first answer was refused by the `message` tool (more than 300 characters), the second went through (20:26:24) and arrived in the builder's chain as
  `[Message from Style Keeper R4 ... reply to ...]`; the builder then wrote `backup.sh` (`set -eu`, `printf`, usage on stderr, exit 64, `cp -p`), `test_backup.sh` (4 PASS; it hit the sandbox's
  `mktemp` block and fixed that itself) and the changelog line `Added backup.sh to copy a file to .bak 2026-11-25 (ow)`, and reported. Compare the third record: 4 model calls, no `list_bots`, the
  neighbour's conventions copied and declared to be the project's.
- Round 2 (the review, 20:27:52 to 20:29:40; chain of 3 turns, 246,359 tokens, $0.094; the review also added 2 turns and 325,000 tokens to the first chain): the builder wrote an item 2 on its
  board assigned to the keeper (a board write), which sent the keeper `[Item 2 "Style Keeper R4 review of r4-support backup files" changed · assigned to you · brief: Review r4-support/backup.sh,
  test_backup.sh, CHANGELOG.md against project conventions; report verdict.]` (the item number and the brief are in the notice), and sent a message with the three files attached. The keeper
  answered the item first: its `message` with `item: 2` was refused ("No item 2 on your board; read it with board."), it sent the verdict as a plain message (20:29:03), and then answered the attached
  message with `reply_to` (20:29:30). The builder reported the first verdict ("approved all three files, no changes needed") and then spent one more turn on "a second reply, also a pass".
  Verdict reached the builder and me in the chain, including for the request sent as a reply. No rule was broken, so nothing was fixed.
- Board at the end: item 1 `done`, assignee `self`; item 2 `done`, assignee the keeper (`b_b1cdd724...`, the keeper's id).
- Totals for 2a: builder chains 8ecc46 + c48040 = 1,007,596 tokens, $0.456, 8 turns (builder and keeper turns together), 7 `message` calls (builder 2; keeper 5, of which 2
  were refused); builder model calls after the bring-up: 16; 7 approvals. Third record: 880,467 tokens, $0.496, 21 builder calls, 7 approvals; second: 680,625 tokens, $0.355; first: 765,635 tokens, $0.50. No
  nudge was needed this time.

### 2b. A clean variant: conventions that exist in no file

`Builder R4b`: "Please create r4-support2/rotate.sh that keeps the last three copies of the file given as its first argument (file.1 newest, then file.2, file.3), with a README.md for it. Follow the project
conventions." Chain f159e4: 20:34:16 to 20:35:28, 5 turns, 580,090 tokens, $0.276, 4 messages; 11 builder model calls for the task (15 in all). It listed the workspace, called `list_bots` (20:33:43),
wrote `rotate.sh`, `test_rotate.sh`, `CHANGELOG.md` and a README in the format of the Docs Keeper's rules (three sections, a two-column exit-code table, "Maintained by platform-team."), and then sent
two review requests at once (20:34:16 and :17: to `Style Keeper R4` for script, test and changelog, to `Docs Keeper R4` for the README, each with `item: 1`). Both verdicts arrived in the chain ("Pass, no rules
broken ..." and "passes. One '# rotate.sh' title, then exactly three sections in order ..."), and the builder reported them. Its reply to me: "I didn't copy the neighbouring folders. I took the
conventions from the two bots that keep them: Style Keeper R4 (scripts) and Docs Keeper R4 (READMEs). For example, `r4-side/README.md` doesn't follow the README rules." It did not message either keeper *before*
writing: it read the rules from their public missions in `list_bots` (the missions hold the full convention text, C-2), so the first contact was a review request. The test and the changelog were not asked
for by me, but the Style Keeper's rules require both. 2 approvals.

**Screenshots.** None for this scenario; the evidence is the transcripts, the board and the chain records.

**Problems.**

- C-1 is now met in both runs in the sense that matters (no builder copied a neighbour; both consulted the keepers without a nudge; 2a asked before writing, 2b asked for a review after writing from rules it read in
  `list_bots`). The ask in 2a depended on the builder noticing that its neighbour and the keeper disagreed.
- N-8 (new): an item assigned to a bot on another bot's board cannot be answered with `item:` by the assignee (`No item 2 on your board`), so the notice that now carries item and brief leads the assignee to a refused
  call, a fallback message and, with the separate review message, a duplicate verdict and an extra builder turn. A message over 300 characters is refused too (the keeper wrote 300+ characters of rules and had to repeat).
- The board assignee of the review item is the keeper again (third record: `self`, the keeper a link). This time the builder itself wrote the assignment (a board write), which is the intended way
  (`c7f17671`), so it is a choice of the model, not a message reassigning an item.

**Outcome.** The bot way now triggers without a nudge in 2 of 2 runs (third record 0 of 2). The review verdict reaches the builder in the chain. Costs: 2a about 1.0 million tokens, 2b 0.6 million.

## 3. Team with Codex

**Setup and inputs.** `Lead R4X` (Codex), the same mission as the third record plus "You work only inside the folder you are started in.". (1) At 21:01:40: "I need a small tool delivered in
the folder r4-team-cx: slugify.sh, which prints the slug of the text given as its arguments (lower case, words joined by single dashes, everything else removed), with a test script and a README. Please set up a
coder, a tester and a docs writer as your standing staff, split the work between them, and tell me when it is delivered. Staff must work only inside r4-team-cx." (2) At 21:03:16 (1 min 36 s later), straight to
`R4X Coder`: "Small change from me: the slug must be cut at 40 characters, and never end with a dash. Please change the script accordingly." (disposition `queued`). No approvals were asked.

**What the bots did.** The lead created three Codex staff and a board. The direct change reached the lead as `[The person wrote to R4X Coder] ...` and was carried into the plan and the briefs of the tester and the docs
writer ("All briefs already updated with the 40-character cap and trailing-dash trim"). The lead and the staff asked the two standing Claude keepers by themselves (as in the third record): the style keeper reviewed
the script and tests, the docs keeper reviewed the README and asked for one change (Synopsis `./slugify.sh <args>`), which the docs writer applied. The tester wrote 23 cases, then 33 after the 40-character rule
(boundaries 39/40/41, a dash at 40). The lead's delivery text came at 21:06:23, 4 min 43 s after my request: "Delivered in r4-team-cx: slugify.sh, test_slugify.sh, and README.md. All 33 tests pass, including the
40-character limit and trailing-dash removal. Reviews are complete. Your three standing staff remain available and restricted to that folder." I ran the delivered script: a 72-character sentence came out as
`hello-world-this-is-a-very-long-title-th` (40 characters), `The quick brown fox jumps over the lazy dogs- now` as a 39-character slug that does not end with a dash, and `test_slugify.sh` printed `PASS: 33 tests`. The folder
holds exactly `slugify.sh`, `test_slugify.sh` and `README.md`: no changelog, nothing unasked.

**Numbers.** Chain of my request: 21:02:03 to 21:06:23, 30 turns, 55 messages, 3 bots created, 2,440,460 tokens. Chain of the direct message: 21:03:24 to 21:07:18, 10 turns, 19 messages, 1,919,952 tokens. Together 40
turns, 74 messages, 4.36 million tokens in about 5 min 40 s from the request to the last turn (cost is not reported for Codex). Third record: 89 turns, 92 messages, 13.74 million tokens, 10 min 33 s; second: 40 turns, 51
messages, 4.04 million in 5 min 37 s; first: 30 turns, 28 messages, 2.74 million.

- Turns after the delivery text: the lead had none (its delivery text is its last turn). The direct-message chain ran on for 55 more seconds (21:06:23 to 21:07:18). Third record: 11 more lead turns, 6 of them pure
  narration. The lead's closing narrations ("The docs writer applied the reviewer's only requested correction. I'll check the final files and close out delivery.") are still written as final texts, but none of the
  eight team sessions I read holds an input "final answer to <message>": no narration started a turn.
- The conversation's last words, and the roster preview, are now the delivery text, not a narration (third record: "I'll check this final report against the closed changelog item.").
- **The run did not end by itself; it froze** (N-7). After 21:06:12 the Relay shows each of the four seats `busy` while the sessions themselves were `idle`, with messages queued behind a message that never started: the lead
  (a tester ack, `dispatching`), the coder (an ack of the lead `dispatching` since 21:04:36, and four later messages `queued`, among them the tester's "Found contract mismatch ... truncates to 40 chars" and its final evidence),
  the tester (a lead ack `dispatching`) and the docs writer (a tester ack `dispatching`, two messages `queued`, among them the docs keeper's "Approved"). The lead delivered at 21:06:23, 11 seconds after the ack that froze its seat;
  the coder and the docs writer never received what was queued for them. Whether the end of the chatter in this run is the fix or the freeze I cannot say from one run: both explain the absence of closing turns.
- Approvals: none asked.

## 4. Team with Claude Code

**Setup and inputs.** `Lead R4` (Claude Code), the same mission as before. (1) At 20:37:48: "I need a small tool delivered in the folder r4-team: wordstat.sh, which prints the number of lines, words and characters of the file
given as its argument (like a tiny wc), with a test script and a README. Please set up a coder, a tester and a docs writer as your standing staff, split the work between them, and tell me when it is delivered." (2) At 2
min 52 s (20:40:42), straight to `R4 Coder`: "Small change of plan from me: wordstat should print labelled output on one line, like `lines=3 words=12 chars=60`, instead of bare numbers. Please change the script." (3) At
20:49:06, after eight minutes of silence: "It has gone quiet for several minutes. Where do things stand? Is it delivered?" (4) At 20:50:58 I answered the lead's question by hand ("One line"). (5) At 20:57:42 I wrote to `R4 Docs`
directly that its queued messages had never reached it and asked it to check the README against the script.

**What the bots did.**

- The lead created the three staff in 5 seconds (20:38:16 to :21), each with an item (`create_bot` with `item`). The coder and the docs writer answered at once with `needs_input` ("Item 2's brief has no spec ('per the brief') and I can't
  read parent item 1"). The lead wrote afterwards (page text, `s4-lead-stalled.png`): "A setup mistake on my part held up all three staff at the start. Creating them replaced each task's description with my short hand-off note, so none
  of them could see what wordstat.sh should do." It put the spec back on the three items by message at 20:39:36 to :38. In the third record the staff did not need to read the board (the spec was in the `create_bot` message).
- First delivery by the coder at 20:40:00 (13 tests by the tester shortly after). The staff's replies crossed with the lead's late spec: the coder answered the spec with `ack` twice (identical, 20:40:15 and :22), the tester and the
  docs writer each answered once.
- My direct change arrived at 20:40:42. The coder changed the script (one line, `lines=2 words=5 chars=24`, 20:41:13), said so in its reply, and sent the lead a `progress` message. The relay turned my message into
  `[The person wrote to R4 Coder] ...` for the lead.
- **From about 20:41 nothing moved** (N-7). The lead's last turn ended at 20:40:53 with "The test script passes all 13 of its tests ... Only the docs writer's final check of the README remains." The notice of my change, the coder's
  progress message and the tester's last report sat `queued` for the lead; two lead messages to the docs writer ("wordstat.sh is in. Please check the README against it now", "test_wordstat.sh is in (13/13 pass) ... report done") sat `queued`
  for the docs writer. In the Relay the lead, the tester and the docs writer were `busy` while their sessions were idle. No bot wrote to me; the person was told nothing. I waited eight minutes, then asked.
- After my question the lead read its board, found the coder's flag, and asked me with `AskUserQuestion` which format I wanted (the three-line one or "One line"), although I had told the coder myself. I answered "One line". It then
  told me that the tests probably still expected three lines, that it had asked the tester and the docs writer to update, and "I'll tell you once the tests pass and the README is checked", and explained the quiet spell as the coder
  having flagged the change on the board instead of a message (the coder had sent a message; it was queued). Its two new messages joined the queue: the tester and docs writer never got them (the Relay still shows `busy`, 2 and 4 queued).
- A direct person message does reach a frozen seat: my message to `R4 Docs` produced a turn (chain bdfc8a, 185,579 tokens): README now says `lines=N words=N chars=N` and an example from a real run. It did not clear the seat (4 queued, still
  `busy`). The tester was never reached: `test_wordstat.sh` still expects three lines and prints `passed: 4  failed: 9` against the delivered script, which prints `lines=2 words=5 chars=10`. The lead never gave a delivery text.
- Numbers (task chains, not counting the bring-up turn): chain of my request 20:38:17 to 20:51:25, 15 turns, 19 messages, 3 bots created, depth 4, 1,962,900 tokens, $1.33; my question (20:51:10) 1 turn, 166,864 tokens, $0.27; the direct message to the
  coder 1 turn, 138,330 tokens, $0.056; the direct message to the docs writer 1 turn, 185,579 tokens, $0.26. Together 18 turns, 25 messages, 2.45 million tokens, $1.92, for a result that was not delivered. Third record: 30 turns, 28 messages, 3.28
  million, $1.62, delivered; second: 34 / 33 / 4.20 million / $1.90; first: 39 / 41 / 5.18 million / $2.32. Model calls of the sessions (transcripts): lead 26, coder 19, tester 16, docs writer 16.
- Closing turns after the delivery: none, because there was no delivery.
- Did the chief ask staff for progress? The lead's messages are hand-offs and spec repairs ("Please run test_wordstat.sh against it and report the results to me", "Please finish checking the README against both scripts and report done"), no "how far
  are you" check-in.
- Approvals: three cards in the run, each offered "Allow for this chain in this folder" and each answered that way: a Write (20:39:47), a Bash of the tester ("Parser skipped input between top-level statements", 20:39:53) and an Edit of the coder in
  its own direct-message chain (20:40:54). The audit lists one standing approval `Any tool in .../workspace`, "applied 3 times", with "Ask me again" (`s4-audit-approvals.png`). Third record: 1 card applied 9 times; second: 4 cards; first: 37.

**Screenshots.** `.tmp/local/r4/s4-lead-stalled.png` (the lead's conversation with its plan, the board with the coder's "Latest report: The person asked me directly ..." and the lead's own account of the setup mistake), `s4-audit-approvals.png`
(Settings, Assistants, the chain of "You asked Lead R4" with its standing approval and the stop/pause buttons per bot), `s4-settings.png`.

## New problems and observations

- **N-7. A bot seat freezes `busy` and everything queued behind it is never delivered.** In both Team runs: 7 seats (Claude: lead, tester, docs writer; Codex: lead, coder, tester, docs writer) held one `ack` message that stayed `accepted`
  or `dispatching` with no `acceptance` of `started` or `handled`, which the Relay counts as an unresolved delivery (`unresolvedTeamDelivery` in `team-delivery.ts`), the seat shows `busy` although the session is `idle`, and every later message to it
  stays `queued`. None of the 6 other seats (Maker, the keepers, the builders, the Claude coder) held such an ack and none froze. The state is persistent: it survived a restart of the Controller (`pnpm local up`) about 35 minutes later (the
  Claude seats were `busy` since 20:41) and it kept the Codex sessions from being released (N-10). A person's own message to the session still starts a turn. Consequence in the Claude run: the person's direct change reached the coder but the lead was
  never woken, the tester and the docs writer never got the lead's requests, no delivery text, eight minutes of silence. I did not isolate the cause. What I can say: this build changed the way a turn that began from a bot's message ends (the Host no longer sends
  `bot_reply` for a bot with the tools), and the third record's build, with the same acks, did not freeze in two Team runs; so the T-1 change is the first suspect, but a rare ordering of an ack and a running turn could also be the trigger.
- N-8. An item assigned to a bot on another's board cannot be answered with `item:` by the assignee, and a `message` over 300 characters is refused (2a).
- N-9. `create_bot` with an item left the staff without the spec in the Claude run ("per the brief"), by the lead's own account, where the third record's `create_bot` message carried the usage and exit codes. The notice for a later assignment
  does carry the item and brief (T-2), but the first message of a new bot did not carry what the item's brief should have said.
- N-10. Codex `session release` answers `false` for sessions whose seat is frozen; four sessions stay loaded in the shared Codex daemon until N-7 is cleared.
- N-11. A chief asked the person a question about a decision the person had already made through another bot (the Claude lead, `AskUserQuestion` with options "One line" and "Three lines" where I had written the change myself). It had learned of my change only from the coder's board flag, not from the person-wrote notice, which was queued.
- Does any bot now fail to answer because its final text no longer replies? Not that I could find. Message-started turns answered with `message` and `reply_to` (the keepers five times, the docs keeper, the staff) and the answers arrived. Bots that had nothing to
  say wrote a final text and sent nothing ("I already wrote the README ... I didn't send anything back"), which is the intended behaviour. The cost of the explicit answer is in the tool: the 300-character limit and the `item` check above, not a missing answer. The freeze
  (N-7) is the one way an answer was lost in this run, and it was lost on the way in, not out.
- N-6 (the previous Relay state refused by the new schema) was not exercised: the instance's state was removed, so `up` made a new one.

## Comparison across the four records

Verdicts compare the fourth record with the third, and say where it stands overall. "n/e" means not exercised in that record.

| Finding | First | Second | Third | Fourth | Verdict |
|---|---|---|---|---|---|
| S-1 side answer lands in the main conversation | 91,032-token main turn, three copies | card beside; 0 main turns | 0 main turns | 0 main turns; Bring back chosen by me (27,461 tokens) | Fixed (holds) |
| S-2 side delivers to its chief | delivery sentence before the answer | 0 messages in chains | `message` held, 2 of 3 calls | 0 messages, no `ToolSearch`, no `message` | Fixed |
| S-3 `/side` draft left behind | `Draft /side ...`, restored by a new page | not fixed, restored even 35 min later | no row, empty at 40 min | no row, empty at 7 and 57 min | Fixed (holds) |
| S-4 side's approval invisible from the main conversation | stays "Working" | needs-you ring, not isolated | n/e | n/e (loop answered at once) | n/e |
| S-5 nickname, empty mission | "Gummies" | "Peach/Bean/Sprout" | "Biscuit/Plum/Nori" | "Plum/Nori/Hatch", empty mission | Not fixed (out of scope) |
| Bring back | n/a | works | works | works, "Brought back", one main turn | Holds |
| N-1 a side costs more | 56,361 to 62,766 tokens, $0.024 to $0.030, 2 calls | 81,617 to 112,191, $0.096 to $0.132 | 81,746 to 142,519, $0.108 to $0.158; 3 to 5 calls | 26,387 to 54,964, $0.083 to $0.134; 1 to 2 calls | Fixed (below the first record; cost per call is the cold cache) |
| N-4 card is a 300-character report, long answers go to a file | n/a | n/a | yes (side 2 wrote a file) | card = full answer (2,615 characters), no file | Fixed |
| C-1 no help asked | 0 of 1 | 0 of 2 | 0 of 2; asked only after the nudge | 2 of 2 consulted keepers unprompted (2a asked before writing; 2b read their missions and asked for review) | Improved (one run each; variance) |
| C-3 review verdict lost | lost | arrived, not a reply | arrived with `reply_to` set | arrived in the chain, twice | Holds (duplicate, N-8) |
| Item moved to the reviewer | assignee the keeper | `self` | `self`, keeper a link | the builder wrote the assignment; the keeper is the assignee, its `item:` reply refused | Worse (by a model's board write, see N-8) |
| C-2, C-4, C-5 | public mission, `ListAgents`, ten stale bots | unchanged | unchanged, fresh workspace | missions in `list_bots` read as the rules (2b); fresh workspace | Unchanged |
| T-1 closing chatter, many turns | Claude 39, 41 messages, 5.18 M, $2.32; Codex 30, 28 messages, 2.74 M | Claude 34, 33 messages, 4.20 M, $1.90; Codex 40, 51 messages, 4.04 M | Claude 30, 28 messages, 3.28 M, $1.62, 3 closing turns; Codex 89, 92 messages, 13.74 M, 11 after first delivery | Claude 18, 25 messages, 2.45 M, $1.92, not delivered (frozen); Codex 40, 74 messages, 4.36 M, 0 closing lead turns, 4 min 43 s to delivery | Improved for Codex (confounded by the freeze); Claude not comparable |
| N-2 final text routed as an answer feeds the chatter | n/a | hypothesis | traced | 0 inputs "final answer to" in 8 team sessions | Fixed (by T-1) |
| Chief asks staff for progress | check-ins | "report on ..." | none | none (hand-offs only) | Holds |
| T-2 item number and brief in the notice | "read item N" fails | spec still missing | specs in `create_bot` (Claude); Codex notice without key or brief | notice carries item and brief (keeper, Codex staff); Claude `create_bot` left the staff without the spec | Improved for notices; new for `create_bot` (N-9) |
| T-3 folded "Message from ..." lines | yes | yes | yes | yes (collapsed groups in the lead's page) | Unchanged |
| T-4 stale or crossed reports | yes | yes | mild | yes: coder acks twice, tester "Lead R4's last three messages crossed with my report" | Unchanged |
| Approvals | 37 | Team 4 cards, 11 uses; 13 once | Team 1 card, 9 uses; 16 once | Team Claude 3 cards, 3 uses (one per chain and kind of prompt); Codex none; 14 once for Side and Support | Holds (1 to 3 cards, within variance) |
| N-6 persisted approvals refused | n/a | n/a | instance would not start | n/e (state removed) | n/e |
| N-7 seat frozen `busy`, queue never delivered | n/a | n/a | not seen | 7 of 7 seats that held an ack, in both providers | New |
| N-8 refused `item:` reply by an assignee; 300-character `message` limit | n/a | n/a | n/a | seen in 2a | New |
| N-9 `create_bot` with item leaves the spec out | n/a | n/a | n/a | Claude run | New |
| N-10 Codex sessions cannot be released | n/a | n/a | released: true | released: false for all four | New (follows N-7) |
| N-11 a chief asks the person about the person's own change | n/a | n/a | n/a | once | New |
| P-1, P-2, P-3, Mention | | n/e | n/e | n/e | n/e |

## Analysis: was each change effective

- **A side answers by its final text (N-1, N-4): effective.** Evidence: the transcripts of the three sides hold 1, 2 and 2 model calls and none is `ToolSearch` or `message`; the Relay records `messages: []` for each; the card text is the side's whole
  answer (307, 2,615 and 317 characters, equal to the page); the workspace root has no stray file; tokens fall to 26,387, 54,964 and 53,125, against 81,746, 142,519 and 109,339. The two calls the third record found to exist only to deliver are gone: the
  saving per side is what that record predicted (2 of 3 calls for a plain question).
- **An assignment notice carries the item and the brief (T-2): effective for notices.** Evidence: the keeper's input read `[Item 2 "..." changed · assigned to you · brief: Review r4-support/backup.sh ...]`; the Codex staff received `[Item "..." changed · brief changed]`
  and acted on it with no request for a key. Not enough for a new bot: the Claude `create_bot` item arrived without the lead's spec (N-9).
- **Base instructions v9 (ask the covering bot before copying a neighbour; start no unasked work): effective in these runs, not proven.** Evidence: 2a asked the keeper before writing and said why ("unlike your rules, yours apply?"); 2b did not copy the neighbours and
  cited the two keepers; the Codex team added no changelog (the third record's unasked CHANGELOG). The same runs also show that the ask is cheap to trigger when the keepers' rules are readable in `list_bots`. One run each: variance applies, and the third record's 0 of 2
  (same words, v8) is a reminder that the model's choice can flip.
- **T-1, final text goes to no sender: effective for the loop, and it is where the fourth record's worst problem lies.** Evidence for the loop: no input "final answer to ..." in any of eight team sessions; no lead narration started a staff turn; the Codex team's delivery
  text is its last turn and the roster preview of a finished team is the delivery. Evidence for the cost: explicit answers need the `message` tool, which has a 300-character limit and an item check (N-8), and the new turn path ends a message-started turn without `bot_reply`
  (the first suspect for N-7, not isolated). I cannot separate the effect on chatter from the effect of the freeze in the Codex run.
- **The ack path is the weak point.** v7 holds an ack back and joins it to the next input for the seat; in this build every seat that took such an ack stopped being able to receive. The design intent (an ack starts no turn) is met in the worst way: it starts none, and neither does anything after.
- **One approval per chain and folder (9d): effective.** Three cards and "applied 3 times" for the Claude team (a chain started by my direct message needs its own, and the Bash of the tester asked once more); none for the Codex run.

## Reflection: what can still improve, ranked

1. **Fix N-7 first: a seat must never stay `busy` because of an ack, and a queue must not wait on an idle session.** It turned a 5-minute delivery into silence and unfinished tests, it keeps Codex sessions loaded, and it is persistent across restarts. Start from what each frozen
   seat has in common (one `ack` message in `accepted` or `dispatching` with no `acceptance`), reproduce it with a real transport and two bots (A acks B twice while B's turn runs), and decide who finishes the delivery of a held ack when the turn that took it ends without `bot_reply`. A person-visible
   guard is also worth having: a bot that has not been delivered to for a minute while its session is idle should show as stuck in the roster, and the person should see "waiting for a delivery" rather than silence.
2. **Let the person know when a chain is silent.** In the Claude run the person was told nothing for eight minutes and the chief's own record said "working". The "Tell me when a chain passes" reminder is about limits; a chain with queued messages and no running turn deserves the same reminder.
3. **Make `create_bot` carry the item's brief into the first message of a new bot (N-9) and let an assignee answer on the item it was given (N-8).** One concept: an item assigned to a bot is that bot's to read and report on, wherever the board lives. Also say the 300-character limit in the tool's description so a keeper does not spend a call on it.
4. **Keep the chief from asking the person what the person already said (N-11).** When a coder reports "the person asked me directly", the chief should apply it; the notice reached the chief only after the freeze.
5. **A review of one's own changes by a keeper should be asked once.** In 2a the builder's board assignment plus its attached message produced two verdicts and an extra turn; either the item assignment or the message is enough.
6. **Show the side's approval where the person looks (S-4)** and the delivery of a finished team in the roster. Still open from the second record; the roster preview is right now.
7. **Nicknames and an empty mission for a side (S-5).** Out of scope; a side could carry its question as its name.

## What worked and should stay

- A side that answers by its final text: one call, the card equal to the page, nothing sent, nothing written.
- The side card with Open and Bring back; the draft gone.
- One approval for a chain's folder, listed in the audit with "Ask me again".
- The `[The person wrote to X]` notice to the chief, and the lead carrying the person's change into the briefs (Codex).
- The item number and the brief in an assignment notice.
- A builder that asks the keeper (or reads its mission) before copying a neighbour, and verdicts that reach the asker in the chain.
- A Codex team of three staff that delivered a 33-test slugifier with the person's late change, a keeper review of the README, no unasked file and no closing narration.
