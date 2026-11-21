# Timeline turns, process mode and work line
Module: `agent-client/src/presentation/turns.ts` (`foldTurns`), `process-mode.ts` (`workDisclosure`, `effectiveProcessMode`, `assistantProcessChoice`, `readProcessMode`), `work-summary.ts` (`workSummary`, `liveStatus`, `fileName`), `assistant-name.ts` (`assistantNames`, `assistantNameIndex`); tests: `agent-client/src/presentation/turns.test.ts` (vectors `agent-client/src/testing/turn-vectors.ts`), `process-mode.test.ts`, `work-summary.test.ts`, `assistant-name.test.ts` (vectors `assistant-name.vectors.ts`), `agent-remote-seams/tests/S6/recorded-turns.integration.test.ts`.

| Clauses | Gaps when written | Closed by a test | Not tested, with the reason |
|---:|---:|---:|---:|
| 21 | 3 | 3 | 0 |

## Purpose
- C1. A loaded timeline folds into turns: a person's message and everything after it up to their next message. The answer is the run of assistant messages after the last work step; everything before it is work. Letters between agents stay beside the conversation. All of it is pure (replica entries and the agent's active turn only).
- C2. The process mode decides how much of a turn's work shows; the work summary and the live line say what the work is in one line each.

## Inputs and outputs
- C3. `foldTurns(entries, activeTurn, agentStatus?, pendingInteractions = 0)` returns `Turn[]` with `key`, `turnId?`, `prompt?`, `work: WorkStep[]` (kind, state, entries), `answer`, `letters`, `state: running | ended`.
- C4. `workDisclosure(mode, turn, choice?, revealed?)` returns `{ line: open | closed, steps: summary | preview }`. `workSummary(steps, t)` returns `{ text, failed, running }`; `liveStatus(name, turn, t)` returns `{ sentence, progress? }`.

## States and transitions
- C5. T-2: a person's message opens a turn; a background check's message does not (it stays in its background step).
- C6. T-3: assistant messages after the last non-background step are the answer; those before a step are `narration` steps; background activity never moves the split.
- C7. T-4: consecutive runtime notices are one `notice` step and consecutive rows of a background check are one `background` step; a letter between two notices separates them.
- C8. T-5: a step is `running` while its tool call or compaction runs, `failed` when its tool call or compaction failed or it is a notice, else `done`; each tool kind (shell, read, edit/write, search, fetch, other) is its own step kind.
- C9. T-6: only the last turn can run: when a request waits for the person, when the active turn is one of its turn ids, or, when its rows carry no turn id, when the agent is `running` or `waiting`.
- C10. T-7: rows before the first person's message of the loaded window form a turn without a prompt.
- C11. Disclosure table: Concise closed; Process open while the turn runs and closed when ended; Full open with every step at preview; the reader's toggle wins for that turn until the mode changes; a search hit opens the line at preview level.
- C12. Mode choice: the assistant's own mode, else the device default, else Concise; picking the device default stores nothing for the assistant; a stored value that is not one of `concise`, `process`, `full` reads as none.

## Limits
- C13. Work summary shows at most 3 clauses, then "and N more" (`work-summary.ts`, `all.slice(0, 3)`); one clause per kind of work in the order the turn first did it.
- C14. A single file is named by the last path segment (`fileName`); several are counted; edits that only wrote new files say "wrote"; remarks, notices and answered interactions add no clause; steps with no clause say how many steps ("N steps"); no steps is empty text.
- C15. Assistant names: 25 default names (`ASSISTANT_NAME_IDS`, `assistant-name.ts`), in English and Chinese; when all are taken further assistants are numbered ("Dango 2"). No bound on the number of turns or steps is enforced in these modules (the window size is the loaded window of the replica).

## Errors and refusals
- C16. Unknown input never throws: an unknown item type reads as a `narration` step; an unreadable stored mode reads as none; a failed background check's own steps stay visible instead of grouping into its background step; a turn the replica has not read yet (active turn id not in the loaded rows) leaves the last loaded turn ended.
- C17. A step failure is shown through `failed` (count in the summary: failed steps, a notice group as one), never as a thrown error.

## Guarantees (ordering, no loss, no doubles)
- C18. T-1: every entry appears in exactly one turn, once, in order (prompt, work, answer, letters), for every kind of row and for recorded conversations, live and re-read.
- C19. A turn's `key` is its turn id when its rows carry one and no earlier turn took it, otherwise `pos:<first entry key>`; keys are unique in a fold, so views keep identity across folds.
- C20. Names are stable: a name is picked by the FNV-1a hash of the assistant's key, so every device and both languages call the same assistant the same name, and no two assistants of an account share a name.
- C21. The live line says what the assistant is doing now (tests, command, reading/editing/writing a named file, searching, fetching, a tool, compaction, background, thinking, planning, writing a reply, working) and the progress of the latest todo ("2 of 5 done"); in Chinese in the design voice.

| Clause | Test(s) that prove it |
|---|---|
| C1 | `turns.test.ts` > "folds the every-kind conversation as a person reads it"; `TURN_VECTORS` rows T-2, T-3 |
| C2 | `work-summary.test.ts` > "workSummary", "liveStatus" tables; `process-mode.test.ts` > "workDisclosure" table |
| C3 | `turns.test.ts` > "foldTurns" vector rows (turn shapes), "is empty for an empty timeline" |
| C4 | `process-mode.test.ts` > "workDisclosure"; `work-summary.test.ts` > "counts failed steps, a notice group as one", "adds the progress of the latest todo" |
| C5 | `turns.test.ts` > "T-2: a person's message opens a turn", "T-2: a background check's message stays in its step" (vector rows) |
| C6 | `turns.test.ts` > T-3 vector rows: "remarks before a step are narration, the messages after the last step the answer", "a turn without steps is all answer", "a turn that ends in a step has no answer", "a background check after the answer leaves the answer in place", "a failed check's own steps do not move the split either", "a visible check's reply is an answer bubble" |
| C7 | `turns.test.ts` > T-4 vector rows: "consecutive notices are one step", "a letter between two notices separates them and stays in the conversation", "checks in a row are one background step" |
| C8 | `turns.test.ts` > T-5 vector rows: "a step runs, fails or is done with its tool call, compaction or notice", "each tool kind is its own step kind" |
| C9 | `turns.test.ts` > T-6 vector rows (5) and "T-6: only the last turn can run, whatever the activity says" |
| C10 | `turns.test.ts` > T-7 vector row "rows before the first message of the window are a turn without a prompt" |
| C11 | `process-mode.test.ts` > "workDisclosure" (6 base rows and 24 choice and reveal rows) |
| C12 | `process-mode.test.ts` > "the stored mode" (reads %j as %j, "takes the assistant's own mode, then the device's default, then Concise", "stores nothing for an assistant whose reader picks the default, and the choice otherwise") |
| C13 | `work-summary.test.ts` > "clauses in the order the turn did them", "more than three kinds", "summarises the every-kind turn in at most three clauses" |
| C14 | `work-summary.test.ts` > "one read names the file", "reads of several files count them", "a new file is written", "remarks and notices alone count steps", "is no line for a turn without work, and answered interactions add no clause", "names a file by the last segment of its path" |
| C15 | `assistant-name.test.ts` > "has twenty-five names, each in English and Chinese", `ASSISTANT_NAME_VECTORS` rows "when every name is taken, the name its key picks is numbered", "when every name is taken, assistants whose keys pick one name are numbered one after the other", "when every name is taken, the numbered name is in the reader's language"; no bound on turns or steps: `turns.test.ts` > "a long timeline" > "folds a thousand entries into one turn each, once, with a unique key per turn" |
| C16 | `turns.test.ts` > T-6 row "a turn the replica has not read yet leaves the last loaded one ended"; T-3 row "a failed check's own steps do not move the split either"; `process-mode.test.ts` "reads %j as %j" (unreadable stored values); `TURN_VECTORS` row "a row of a type the client does not know is a narration step and moves nothing else" |
| C17 | `work-summary.test.ts` > "counts failed steps, a notice group as one" |
| C18 | `turns.test.ts` > "T-1: every entry is in one turn, once" (all vectors), "T-1: every kind of row of a whole conversation is in one turn, once"; `agent-remote-seams/tests/S6/recorded-turns.integration.test.ts` > "every entry is in one turn, once" (recordings, live and re-read) |
| C19 | `turns.test.ts` > vector row "key: a turn is keyed by its id, a second turn of the same id and a turn without one by its first entry", and "T-1: every kind of row ..." (unique keys); "a long timeline" > "keys the same entries the same on every fold", "keeps the keys of the earlier turns when a row or a turn is appended" |
| C20 | `assistant-name.test.ts` > "gives every assistant of an account a different name, the same in each language and order", "names one assistant among the others of its account, and alone by default", vector rows |
| C21 | `work-summary.test.ts` > "liveStatus" (12 rows), "adds the progress of the latest todo", "speaks Chinese in the design voice" |

Gaps: none. Closed 2026-11-21: C15, C16 and C19. Not covered by any clause: no test shows the work line, process mode and turn fold
rendered together in the Workbench (component tier); out of scope for this module, noted for the browser layer.

Tests that map to no clause (candidates for deletion): none found.

## Gaps closed

Closed on 2026-11-21. The clause table above names each test by its title; this table names the file and the mutations of the rule that the test fails on (each was applied, run and reverted).

| Component, clause | Test file | Mutation caught |
|---|---|---|
| Turns C15 | `turns.test.ts`; `assistant-name.vectors.ts` rows | a fold that stops at 900 entries; the numbering loop removed; the English name in the Chinese list |
| Turns C16 | `turn-vectors.ts` row | the fallback step kind `tool` |
| Turns C19 | `turns.test.ts` | a key counted from the end |
