# Components of the session path: design clauses and their tests

Each component on the session path states its design as numbered clauses (purpose, inputs and outputs, states and transitions,
limits, errors and refusals, guarantees), and every clause names the tests that prove it. A clause without a test is a gap: close it
at the lowest tier (a unit test with mock data, a vector row, a recording or a seam test), or say why not. A test that proves no
clause is a candidate for deletion (the redundancy rule of `.agents/skills/write-tests/SKILL.md`). The seams (`seams.md`) check how
the components compose; smoke and e2e check the assembled system, and a smoke failure is explained by the first violating event and
the clause it broke.

The statements were written on 2026-11-21 from the module headers, `seams.md` and sections 1 to 4 of the target architecture, and
checked against the code; the test mapping follows test titles and their assertions. Clause numbers are per component.

Each component has its own file in `components/`, with its clauses, the tests that prove each one, its counts, and the tests
added and the gaps closed for it. A task that changes a component's design or tests edits that file only; a new component is a
new file and a row here.

| Component | File |
|---|---|
| Journal: the window decision and the quota | [journal.md](components/journal.md) |
| Relay session control | [relay-session-control.md](components/relay-session-control.md) |
| Relay host-session | [relay-host-session.md](components/relay-host-session.md) |
| Controller session core | [controller-session-core.md](components/controller-session-core.md) |
| Controller publisher | [controller-publisher.md](components/controller-publisher.md) |
| Codex and Claude adapter item identity | [adapter-item-identity.md](components/adapter-item-identity.md) |
| Client replica and send state | [client-replica.md](components/client-replica.md) |
| Client session presentation | [client-presentation.md](components/client-presentation.md) |
| Timeline turns, process mode and work line | [timeline-turns.md](components/timeline-turns.md) |
| Provider behaviour declaration | [provider-behaviour.md](components/provider-behaviour.md) |
| CLI simulator (test support) | [cli-simulator.md](components/cli-simulator.md) |
| Provider conformance kit | [provider-conformance-kit.md](components/provider-conformance-kit.md) |
| Native assumption checks | [native-assumption-checks.md](components/native-assumption-checks.md) |
| Navigation stack of Bot mode | [navigation-stack.md](components/navigation-stack.md) |

Every clause now names the tests that prove it (220 clauses on 2026-11-22, without the CLI simulator's). The 43 gaps were closed on 2026-11-21 (each component's "Gaps closed"): 42 by a
unit test, a vector row or a seam test with mock data, each under 300 ms and each failing when the rule it proves is broken (by a
one-line mutation, except replica C7, whose rule two guards each keep alone); one, adapter C14, is not tested, because no input
reaches it, and the guarantee it guards is proven by the S1 seam.
The clause tables also marked some partial gaps inline (a default value, a close code); those are closed by the same tests.

## How the smoke failures of 2026-11-21 map to clauses

- **M1** (`first-paint-from-device-store` at 1,500 ms): no component clause broke. The probe closed the first page before the
  device store had written the opened session's record (Client replica C1: the store paints only a kept record of the same
  session); a harness defect, fixed and pinned by `smoke/lib/probe.test.ts` (section 10, O51).
- **M2** (`message-settles-once`, rounds 8 and 10): the product kept Client replica and send state C6 and C10 (a send cut off by a
  Controller stop is `unconfirmed`, and the composer holds later messages behind it until the person checks it). The harness landed
  the fault on the send instead of mid-turn; fixed and pinned by `smoke/lib/restart-round.test.ts` (O52).
- **M6, Claude terminal** (`no-lost-or-doubled-message`, `terminal-rows-appear`): Controller session core C10 at its limit: a
  terminal turn that ends within 2,000 ms of the page's turn was not divergence, and Claude Code forks the transcript (O49). Closed:
  divergence is decided by the transcript's content, and a page follows the branch native history shows.
- **M6, separate Codex process** (`page-stays-live-when-codex-refuses`): Relay host-session (the journal-served stream is refused
  when the attach at open is refused) and Controller session core C16 and C17 (Codex's single writer becomes a native owner with
  the private-writer takeover); the page shows no rows and no Codex reason (O48).
