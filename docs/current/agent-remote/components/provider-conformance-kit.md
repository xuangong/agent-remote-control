# Provider conformance kit
Module: `agent-provider-sdk/src/conformance.ts` (`runProviderConformance`, the `./conformance` entry) and its pure checks `agent-provider-sdk/src/conformance-checks.ts`; the Controller's ports `agent-controller/src/test-utils/provider-conformance.ts` (the journal's window decision over a real agent manager, and the host runtime beside the CLI simulator on a fake clock); each adapter's subject in its `./recordings` entry (`codexConformanceSubject`, `claudeConformanceSubject`, `copilotConformanceSubject`, `piConformanceSubject`), with a fake of its CLI in `src/test-utils/native-fake.ts`. Run by `pnpm test:providers` (`agent-controller/src/provider-conformance.test.ts`), on mock data, in about 3 s. Design source: section 4.3 of `docs/superpowers/specs/2026-11-21-requirements-vs-external-dependencies.md` (step B3, with part 2 of B5).

| Clauses | Gaps when written | Closed by a test | Not tested, with the reason |
|---:|---:|---:|---:|
| 9 | 0 | 0 | 0 |

## Clauses
- P1. Every journal-capable adapter passes one suite, keyed on its declaration (`descriptor.behaviour`), never on its provider id; a new adapter brings a subject (declaration, recordings, native fake) and needs no change of the Controller, the Relay or the client.
- P2. Part 1, recorded sessions: each recording is read again in the declared order (K1) with usable identities, no item the live run lacked and every item finished but a running tool (K2); a Relay journal built from the live run meets five more rereads unchanged, each window in the declared order (journal C25), and a settled session (`settled`, `restart`, both required) reopens unchanged. No line of a recording is exempt: the recorders compare a new run with a recording by `recordingShape`, in which only the journal's rules move a line (a live-only item has no place; a turn's siblings are sorted when declared unordered).
- P3. Part 3, the declared behaviour, through a fake of the CLI that drives the real adapter: live-only marks only of declared kinds (K3); the client's input id kept live and on a reread when `echoes_client_id` (K4); the CLI's limit signal failing the turn `native_usage_limited` with the reset in `runtimeInfo.usageLimit` when typed (K5); the CLI's refusal of a second writer raised as `AgentSessionInUseError` `writer_elsewhere` when declared (K6); an event of a kind the adapter does not know, in history and live, one diagnostic each time and no row (K7, the same turn played with and without it). K7 runs for OpenCode too, which is not journal-capable (`runUnknownEventRule`).
- P4. Part 2, faults through the port, played by the CLI simulator from the declaration: a resume 1 ms inside the declared deadline opens; a hung resume is given up at the deadline as `native_unresponsive`, the next open succeeds and the late session is closed; a usage limit refuses an open, and fails a turn, `native_usage_limited` with when it resets, until a turn runs again; a crash fails the turn `native_exited`; a silent turn of an adapter without a heartbeat ends `native_unresponsive` at `TURN_SILENCE_MS`, its runtime released; a writer elsewhere is refused with its reason and wait for a single writer (or a lock-file probe beside shared clients) and never for a forking CLI.
- P5. Each check returns findings that name the declared field the adapter contradicts (`conformance-checks.ts`), so a failure says which declaration is wrong.

| Clause | Test(s) that prove it |
|---|---|
| P1 | `provider-conformance.test.ts` runs `runProviderConformance` for Codex (the shared daemon's declaration), Claude Code, Copilot and pi |
| P2 | `provider-conformance.test.ts` > "has the recordings every journal-capable adapter makes: settled and restart", "%s: is read again in the declared order (reread.order …, K1)", "%s: gives every row a usable identity, and a reread names no item the live run lacked (K2)", "%s: a journal of the live run meets five more rereads unchanged, and a settled session reopens unchanged" (39 recordings) |
| P3 | `provider-conformance.test.ts` > "marks live-only only items of the declared kinds (K3)", "reports the client's input id with the user row, live and when read again (K4)", "fails the turn the CLI's limit signal stops as declared (K5)", "raises the CLI's refusal of a second writer typed (K6)", "reports an event of a kind it does not know as one diagnostic, never a row and never a silent drop (gap 10, K7)" |
| P4 | `provider-conformance.test.ts` > part 2 (7 to 8 tests per declaration); mutations caught: the resume deadline 1 ms later, the late session not closed, the watchdog 1 ms later, the watchdog's release removed, the reason or the reset dropped from the Controller's answer |
| P5 | `agent-provider-sdk/src/conformance-checks.test.ts` (8 tests, a conforming and a contradicting case of each check) |

Matrix on 2026-11-22 (pass, or `fails` for an open item reproduced as an expected failure; n/a when the declaration excludes the check):

| Check | Codex (shared daemon) | Claude Code | Copilot | OpenCode | pi |
|---|---|---|---|---|---|
| K1 order, K2 identity, continuity (each recording) | pass (12) | pass (19) | pass (8) | n/a, no journal | pass (8) |
| K3 live-only kinds | pass | pass | pass, after the declaration gained `partial_output` | n/a | pass |
| K4 input identity | pass | pass | n/a (`none`) | n/a | n/a (`none`) |
| K5 usage limit | pass | pass | pass | n/a | n/a (no limit signal) |
| K6 writer elsewhere | pass | n/a | pass | n/a | n/a |
| K7 an event of a kind it does not know (gap 10) | pass, was a row | pass, was dropped | pass, was dropped | pass, was a refresh | pass |
| Slow resume, hung resume, limit at open and at a turn, crash, silent turn, unknown event | pass | pass | pass | n/a | pass |
| Writer elsewhere | pass (refused, `writer_elsewhere`) | pass (not refused) | pass (refused, `writer_elsewhere`) | n/a | n/a (fork on divergence) |
| The CLI again after it exited | pass | pass | pass | n/a | pass |

The kit found that a session whose CLI exited mid-turn kept its failed runtime ("Provider observation stream failed"), also when the page opened it again; closed by session core C26 (native exit), so the row above now passes for every declaration.
