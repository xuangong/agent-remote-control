# CLI simulator (test support)
Module: `agent-controller/src/test-utils/simulated-cli.ts` (`simulatedCli`), exported to the seams as `@orchardworks/agent-remote-controller/testing/simulated-cli`. A native CLI at the provider port, played from the behaviour an adapter declares, with the faults of section 3.1 of `docs/superpowers/specs/2026-11-21-requirements-vs-external-dependencies.md` as knobs (step B2). Tests: `agent-controller/src/test-utils/simulated-cli.test.ts`.

## Clauses
- S1. Each resume makes the Controller's process one client of the session until that session is disposed; a session is loaded while it has a client and for the declared `unloadAfterLastClientMs` after its last client leaves.
- S2. A send runs a turn: the user message and `turn_started` at once, the reply and `turn_completed` after `turnMs`; the user message reaches history as the CLI takes it, the reply when the turn ends; a CLI that keeps client ids keeps the send's `inputId` as the user row's `clientMessageId`.
- S3. Another client of shared clients (`externalWriter`) is seen live by attached clients when `othersVisible` is `live`, reaches history, and loads the session while it runs.
- S4. A writer elsewhere (`single_writer`, or `separate` beside shared clients) is refused while the session is loaded; otherwise it holds the writer for its turn, and a resume meanwhile is refused with `AgentSessionInUseError` reason `writer_elsewhere`.
- S5. Fork on divergence: a write elsewhere continues the newest branch as it was when the write began; a reread shows the branch written last, also within one millisecond; a resident client continues its own branch. Through the managed stdio directory a resident client tells the records it holds, and the transcript its records as a reread gives them.
- S6. Resume faults: slow, hung (once or until healed), and a usage limit typed `native_usage_limited` with `resetsAt` until that time; the usage limit at a turn (`at: 'turn'`), as CLIs signal it, fails each turn with code `native_usage_limited` after its user message and reports `runtimeInfo.usageLimit { resetsAt }` until a turn runs again.
- S7. Mid-turn faults on the next turn: a crash fails it, typed `native_exited` when the declaration types it, and ends the stream; a hang leaves it running after its user message.
- S8. An event of a kind the adapter does not know, in every history read and turn until healed, reported by the simulated adapter as one diagnostic each time and never a row (the rule of gap 10).
- S9. Every delay runs on the injected clock, the global timers by default, so fake timers drive it.

| Clause | Test(s) that prove it |
|---|---|
| S1 | `simulated-cli.test.ts` > "keeps a session loaded while this process is its client and for the declared unload time after (S1)", "unloads a session at once when the CLI declares no unload time (S1)" |
| S2 | "runs a send as a turn whose user message reaches history as the CLI takes it and its reply when it ends, and reads history back at the next resume (S2)"; the client id: `interrupted-send.test.ts` |
| S3 | "shows another client's turn live to this process's client, and loads the session while it runs (S3)" |
| S4 | "refuses a writer elsewhere while the session is loaded, and refuses a resume while one writes (S4)", "refuses every writer elsewhere for a single writer that this process holds (S4)" |
| S5 | "forks a transcript two writers write at once: a reread shows the newest branch, the resident client keeps its own (S5)", "shows the branch written last on a reread when two writes end in the same millisecond (S5)" |
| S6 | "answers a slow resume after its delay, and a hung one only once healed (S6)", "refuses a resume with a typed usage limit until the limit resets (S6)", "fails each turn with native_usage_limited after its user message until the limit resets, and says when it resets meanwhile (S6)" |
| S7 | "fails a turn whose CLI exits with native_exited and ends the stream, and leaves a hung turn running (S7)" |
| S8 | "reports an event of a kind the adapter does not know in every history read and turn until healed, as a diagnostic and never a row (S8)" |
| S9 | every test above runs on fake timers; "declares the behaviour it plays, so a Controller reads it as an adapter states it" |

## Gaps reproduced in the simulator, as expected failures (`it.fails`)
Each test fails today for the reason its open item names; the change that closes the item turns it into a plain test.

| Open item | Test | What fails today |
|---|---|---|
| O47 (closed, now plain tests) | `agent-remote-seams/tests/S2/session-residency.integration.test.ts` > "stays resident past the idle grace, so another client's turn still reaches the page live (O47)", "is let go a short grace after no page shows it, so the CLI unloads it within its own unload time of the page closing (O47)" | before the change: the Controller let the shown session go after 5 minutes, and held an unshown one for 5 minutes |
| O48 (closed, now plain tests) | `agent-remote-seams/tests/S2/writer-elsewhere.integration.test.ts` > "stays readable from its journal, says the CLI's reason, offers a retry and no take-over, and goes live again after it (O48)", and the Retry test beside it | before the change: the page's open was refused (409 `session_in_use`) |
| O49 (closed, now plain tests) | `agent-controller/src/transcript-fork.test.ts` > "shows the terminal's branch, which native history shows, when the terminal's turn ends %i ms after the page's (O49)" (0, 1,999 and 2,001 ms) | before the change: the 2,000 ms rule missed the fork, so the Controller kept the page's branch |
| Gap 4 (O53, closed, now plain tests) | `agent-controller/src/provider-conformance.test.ts` > "gives a hung resume up at the declared deadline as native_unresponsive, and opens the session again once it is free" (every declaration) | before the change: nothing answered the hung resume, and the next open waited behind it |
