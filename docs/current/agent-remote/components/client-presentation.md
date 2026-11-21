# Client session presentation
Module: `agent-client/src/client/session-presentation.ts` and `agent-client/src/client/lease-view.ts`; tests: `agent-client/src/client/session-presentation.test.ts` (vector table `agent-client/src/testing/session-presentation-vectors.ts`), `agent-client/src/client/lease-view.test.ts`, `agent-client/src/client/session-state.test.ts`, `agent-client/src/client/session-states.test.ts`, `agent-client-web/src/react/AgentComposer.pending.test.tsx`.

| Clauses | Gaps when written | Closed by a test | Not tested, with the reason |
|---:|---:|---:|---:|
| 20 | 4 | 4 | 0 |

## Purpose
- C1. One pure function set says what a person sees of a session: its one business notice (`sessionNotice`), whether the composer takes input and whether a send goes now (`composerAvailability`), and the activity label (`sessionActivityLabel`). Views read these and never read connection phase, control check, synchronization or runtime recovery for words or enablement (target T5).
- C2. `leaseView(control)` is one table from the replica's control state to `{ state, readOnly, checking, native }`; the renderer never reads `access`, `available` or `nativeOwner` itself.

## Inputs and outputs
- C3. Input is `SessionFacts` (`RemoteSessionState`, Host online and name as the Relay last said, and the replica read only for failure words). Output is a `SessionNotice` or none, a `ComposerAvailability`, a label or none, and plain words (`sessionNoticeWords`, `leaseNoticeLabel`) through a translator (English default, Chinese in the catalogue). No clock, no I/O.
- C4. Notice precedence, first match wins: connection `unavailable`; activity `failed`; activity `closed`; Host offline; lease (terminal, other Controller, read-only); runtime `unavailable`.

## States and transitions
- C5. Lease states: no control channel `unknown`; `checking` (not read-only, `checking: true`); `control`; read-only with owner `native_cli` -> `native_cli`; read-only with another Controller -> `other_controller`; read-only with no owner -> `read_only`. A control check has no words.
- C6. R1: connection phase, control checking, synchronization, held rows and a recovering runtime never produce a notice, a disabled composer or a label of their own; they only decide whether a send goes now or waits. Stale non-recoverable diagnostics never speak for a later attempt (only `connection: unavailable` shows them).
- C7. R2: the composer is disabled only for a business reason: read-only lease (`read_only`, `terminal_in_control`, `other_controller`), `ended`, `failed`, `unavailable` (refused for good), or an agent without `sendMessage` (`unsupported`).
- C8. R3: when enabled, `dispatch` is `now` exactly when `operations.send_message.allowed` (synchronized, control check over, send allowed), otherwise `when_ready` (the send waits in the queue).
- C9. R4: an offline Host is a notice and leaves the composer enabled. A runtime `unavailable` is a notice (`agent_unavailable`) and also leaves it enabled; sends wait.
- C10. Activity label: none before a Snapshot or for a refused session; the native owner's words for `native_cli`, "Native control transferred" for `other_controller`; then `failed`, `closed`, `waiting`, `running` (Working), else Starting / Ready, or Executing command while a command is pending and the session is idle or starting.

## Limits
- C11. No numeric limit, no clock, no size bound in these two modules. The only fixed text is the fallback words: `UNAVAILABLE` ("This session is unavailable."), `FAILED` ("The agent failed without error details."), `ITS_HOST`; the client's own fallbacks are translated, a failure described by the agent, Relay or Controller is shown as sent.

## Errors and refusals
- C12. A failure notice takes the runtime failure message, else the last error, else the fallback; an `unavailable` notice takes the last non-recoverable diagnostic, else the fallback.
- C13. R5: the words for a native owner come only from `leaseNoticeLabel`; no other path words a lease.

## Guarantees (ordering, no loss, no doubles)
- C14. The same facts always give the same outputs (pure, no hidden state); every vector row fixes notice, composer and label together.
- C15. Over every cross of connection phase x lease x runtime connection x activity x Host x restored, no output contains a T5 word (connecting, checking, synchronizing, restoring, reconnecting).
- C16. Without a business fact the outputs are no notice, an enabled composer and a business label or none.
- C17. A refused (`unavailable`) session is never treated as recovering, so input is not held for a reconnect that will not happen.
- C18. A send over a restored replica waits and is dispatched only once the first server page confirms the state (R3 consumed by the composer).
- C19. R6 (O48): a session the CLI refuses as a client (`cli_refused`: another process writes it, or a turn runs) is read-only with the CLI's reason in words, its composer is disabled for that reason, and the Workbench's control notice offers Retry, which asks for control again, never a take-over.
- C20. R7 (gap 3): the account's usage limit, as the adapter reports it (`runtimeInfo.usageLimit { resetsAt }`), is the notice `usage_limited` after the lease's, worded with when it resets (today, tomorrow or a date, with the time, in the reader's locale, `momentWords`); the composer stays enabled, and while the reset is known and ahead of `now` a send waits for it (`dispatch: 'when_ready'`). A reset that `now` has passed no longer limits. The Workbench says it beside the composer.

| Clause | Test(s) that prove it |
|---|---|
| C1 | `session-presentation.test.ts` > "the presentation of a session, row by row" (all vector rows) |
| C2 | `lease-view.test.ts` > "the lease view table" (6 rows) |
| C3 | `session-presentation.test.ts` > "words a notice in business terms"; vector rows; Chinese: "the words of a session in Chinese" > "words the notice %s" (every notice), "words each lease state", "words the composer block and the activity label" |
| C4 | vector rows with one fact (e.g. "ready, closed", "ready, failed with a runtime failure", "ready, Host offline") and rows with two facts at once, one for each step of the order: "refused for good, and the agent had failed: the refusal speaks", "failed and the Host offline: the failure speaks", "failed and read-only: the failure speaks and blocks", "closed and the Host offline: the end speaks", "closed and a terminal has control: the end speaks, the terminal words the label", "Host offline and a terminal has control: the Host speaks, the lease blocks", "Host offline and the runtime unavailable: the Host speaks", "read-only and the runtime unavailable: the lease speaks", "another Controller has control and the runtime unavailable: the lease speaks" |
| C5 | `lease-view.test.ts` > "the lease view table" (all six rows, including the notice and activity words) |
| C6 | `session-presentation.test.ts` > "R1: ... say nothing" > "gives no T5 word in any output, over N combinations"; vector rows "connecting again, a stale refusal in the diagnostics", "restored running turn, catching up, checking", "ready, runtime reconnecting" |
| C7 | `session-presentation.test.ts` > "R2 and R3: the composer" > "is disabled only with a business fact present"; the converse: "the order of the notice and the reasons of the composer" > "has a row for every reason that disables the composer" (all seven), "disables the composer in every row that has a business fact"; vector rows "ready, closed", "ready, a terminal has control", "ready, sendMessage unsupported", "read-only and sendMessage unsupported: the lease blocks" |
| C8 | `session-presentation.test.ts` > "sends now exactly when synchronized, the control check is over and send_message is allowed" |
| C9 | `session-presentation.test.ts` > "keeps an offline Host enabled (R4)"; vector rows "ready, runtime unavailable", `AgentComposer.pending.test.tsx` > "keeps an agent that takes no messages blocked, and lets a message wait while the runtime is unavailable" |
| C10 | `session-presentation.test.ts` > "says a pending command while the session is idle, and nothing before the Snapshot"; vector rows (labels); `lease-view.test.ts` activity column |
| C11 | `session-presentation.test.ts` > vector rows "unavailable, no Snapshot, no reason", "ready, failed ..." (fallback words); no limit to test |
| C12 | vector rows "ready, failed with a runtime failure", "unavailable, session deleted", "unavailable, no Snapshot, no reason" |
| C13 | `lease-view.test.ts` > "the lease view table" (notice column) |
| C14 | `session-presentation.test.ts` > "the same facts give the same outputs" > "%s: a repeat call and an equal copy agree" (every vector row) |
| C15 | `session-presentation.test.ts` > "gives no T5 word in any output, over N combinations" |
| C16 | `session-presentation.test.ts` > "gives no notice, an enabled composer and a business label or none when no business fact is present" |
| C17 | `session-state.test.ts` > "does not treat a refused session as recovering, so input is not held for a reconnect that will not happen" |
| C18 | `agent-remote-seams/tests/S6/client-replica-to-renderer.integration.test.tsx` > "takes a send over a restored replica, shows it as Sending, and sends it only after the first server page confirms the state"; `AgentComposer.pending.test.tsx` > "waits for confirmed control, and holds a waiting message as Not sent when a terminal takes the session, sending it only on Retry" |
| C19 | `lease-view.test.ts` > "a session the CLI refuses as a client (O48)"; `session-presentation.test.ts` vector row "ready, the CLI refuses: a writer elsewhere" and "has a row for every reason that disables the composer" (eight now); `agent-remote-lab/src/components/SessionWorkbench.test.tsx` > "says the CLI's reason for refusing a session and offers a Retry, never a take-over (O48)" |
| C20 | `session-presentation-vectors.ts` rows "ready, usage limited until a known time: the notice says when, sends wait", "... a time that has passed: no notice, sends go", "... with no reset time: the notice, and sends go", "usage limited and a terminal has control: the lease speaks and blocks"; `session-presentation.test.ts` > "says when a usage limit resets, in business words (R7)", the Chinese "says when a usage limit resets (R7)" and its notice row, "sends now exactly when ..., and no usage limit holds sends until a known reset (R7)", "a moment as a sentence says it" (7 rows, both locales); `SessionWorkbench.test.tsx` > "says the account's usage limit and when it resets beside the composer, which stays open (gap 3)"; through the Relay: S2 `usage-limit.integration.test.ts` |

Gaps: none. Closed 2026-11-21: C3, C4, C7 and C14. For C7 the seven reasons each had a row already (`other_controller` is "ready,
another Controller has control", `failed` is "ready, failed with a runtime failure"); the gap list counted four. Not a clause: R3 in
the module header says "synchronized, the control check is over and `send_message` is allowed" but the code reads only
`session.operations.send_message.allowed`; the test asserts equality with the three-part rule, which holds today because
`operations` is derived in `session-state.ts`. Keep the test; reword the header.

Tests that map to no clause (candidates for deletion): none found.

## Gaps closed

Closed on 2026-11-21. The clause table above names each test by its title; this table names the file and the mutations of the rule that the test fails on (each was applied, run and reverted).

| Component, clause | Test file | Mutation caught |
|---|---|---|
| Presentation C3 | `session-presentation.test.ts` | one Chinese lease word changed |
| Presentation C4, C7 | `session-presentation-vectors.ts` rows, `session-presentation.test.ts` | six reorderings of the notice and composer checks |
| Presentation C14 | `session-presentation.test.ts` | a call counter in `sessionNotice` |
