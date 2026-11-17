# M5 to M7: where the rules and their tests went

Companion of `2026-11-18-target-architecture-and-tests.md`, steps M5, M6 and M7. For each step: the module and its contract, the tests that own the rule now, the mutation check that justified each deletion, and the change scope before and after. A mutation is a one-line break of the rule in the module; a deleted test must fail under at least one mutation that also fails the new tests.

## M5 Journal window decision (X3)

**Module.** `agent-remote-journal/src/window-decision.ts`: `decideWindow(tail, window, room?)` is a pure function that returns `unchanged`, `extend` or `replace` with a reason. Its contract is written in the file and in `seams.md` (S2, "Window decision"). `SessionJournal.sync` and `extensionBytes` call it; `SessionJournal` keeps the writes. The client's side is `agent-remote-web/src/replica/window-absorption.ts` (`absorbWindow`, moved out of the reducer, no logic change).

**Vector table.** `windowVectors` (47 rows, journal `./testing`) with three consumers, one line each: the journal (`window-decision.test.ts`: `decideWindow` and `SessionJournal.sync`, 94 tests), the Controller publisher (`journal-window.contract.test.ts`: the window `windowOp` builds from timeline items with its own digests, 41), the client replica (`seams/S3/window-absorb.integration.test.ts`: `absorbWindow`, 47). The table lives in the journal and not in `agent-remote-fixtures`: the fixtures package depends on the journal, and a journal test importing it would close a dependency cycle. Web does not import the journal: its consumer is the S3 seam suite.

**Deleted (22).** 21 tests of `journal-sync.test.ts` (the decision restated through `sync`: digest, missing, moved, new-inside, open versus complete, incomplete, empty window, further back, long window, item before the first shared key, leading live-only, no shared key, live-only skip and append, equal board, new live-only key, live-only content that cannot be rewritten, open content, open without a body, extension fits, extension does not fit, and the four reason tests) and the absorption half of one reducer test (`reducer.test.ts`, the epoch and retirement half stays).

| Mutation (window-decision.ts) | New tests failing (journal and Controller consumers) | Old tests failing (all packages checked) |
|---|---:|---|
| no check before the first shared key | 3 | 1 journal |
| digest ignored | 3 | 4 journal, 4 Relay, 2 Controller |
| an extension becomes a replacement | 36 | 7 journal, 3 Relay, 10 Controller |
| tool call only is rewritten in place | 5 | 3 journal, 1 Controller |
| live-only items join the native comparison | 27 | 9 journal, 44 Controller |
| incomplete journal ignored | 6 | 2 journal, 2 Relay |
| room ignored | 3 | 1 journal |
| open content ignored | 6 | 2 journal |
| open versus complete, empty window, no shared key, further back, held key in an extension, open live-only item, in-place for any content | 2 to 10 each | 1 to 3 journal each |
| replica: always take the window row, keep the held sequence | 38 and 39 | 1 web reducer test (now trimmed), 2 React and 1 transport test that check DOM identity and stay |
| replica: ignore resource ids, count the background | 1 each | none: no old test caught them; two new unit tests cover them |

Not mutation-proven, so kept: the old test for a key that is live-only in one place and native in the other. The guard that returns `changed` for it is shadowed (the native comparison returns `changed` first), so no mutation of that line fails any test; the new vectors state the outcome. The `state === 'complete'` test in the digest comparison is likewise equivalent to the digest test.

Kept on purpose, not duplicates: the Relay's host-journals window tests (events to subscribers, diagnostics, quota and refusal behaviour), the Controller's recording-driven continuity tests (the S2 proof the spec names), and the real-socket `journal-served-reconnect` test, which tests paging after an in-place update, not the decision. The spec's "six real-server variants" do not exist in this checkout: there is one.

**Scope.** A change to the window rule selected, by package, the journal and its dependents: Controller, Relay core, debugger, fixtures, seams, Workbench, Cloudflare, SQLite store (about 6,100 tests at the baseline; the Workbench and the Controller alone are 85 s and 74 s). It selects now the vector table and its three consumers plus the S2 seam: 99 + 41 + 47 + 4 + 16 = 207 tests, each file under 20 ms, 1.5 s with start-up. The package-level `verify:changed` still selects the dependents; the module-level plan (section 5.9) is what makes the small scope real.

**Exceptions.** None lowered. The `domain-impure` entry for the journal (`crypto.randomUUID` for epochs) was owned by M5 but needs the Relay's `Ids` port; its owner is now M11.

**Smoke (`pnpm smoke:quick`, seed 91788, build 8a0d831a642a).** M2 passed (7 invariants: one replacement per restart 2, sequences contiguous 14, messages settle once 4, no duplicate key 48, no blank frame 45, no stale label 4, turn rows complete 4). M7 passed (catch-up one tail request 2, no stale label 15, draft and position kept 2, no blank frame 40, no duplicate key 30, half-open recovers 1). M1 failed on `first-paint-from-device-store` as at the baseline (4.6 s Claude, 4.9 s Codex at 300 ms and 2% loss against 3.3 s; the loss draws differ with the seed); M8 owns it.

## M6 Relay session control (X2)

**Module.** `agent-relay-core/src/domain/session-control/session-control.ts` (module `relay-session-control`, layer 1, under the domain-impure ban): `transition(state, event)` returns the next state and a reply as data; `viewOf(state)` is the `session_control` payload. Ids come with the events (`fresh`). The contract is written in the file and in `seams.md` (S3, "Lease table"). `stream-control.ts` is the shell (decode, mint ids, ask the Controller who holds the session, send replies); `createStreamControl` behaves as before. The lease code was already one closure in `stream-control.ts` (S5 had moved it out of `broker.ts` and `journal-sessions.ts`), so the move is the state machine out of that closure, about 60 lines, not the 250 the spec estimated.

Client: `agent-remote-web/src/client/lease-view.ts`, one table from the replica's control state to `readOnly`, `checking`, `native` and the words of the read-only notice and the activity line; `remoteSessionState`, `SessionControlNotice` and `SessionWorkbench` read it. There is no refusal-to-view mapping in `remote-session-client.ts` to move: refusals reach the replica only as the control state.

**Tests added.** 27 table rows and 6 more over purity, owner copying and the view (`session-control.test.ts`); 10 shell tests (`stream-control.test.ts`); 6 rows of the lease view table. Each under 20 ms. The S3 lease transcripts (acquire, stale revision, send without a lease, native owner refuses, offline Host) replay unchanged through the new shell (the S3 suite, 18 tests).

**Mutation check** (13 mutations of the table: no revision check, token reissued, owner kept on acquire, mutation always passes, an absent token passes, token kept after a refusal, owner never named, stale holder accepted, snapshot always announces, view ignores the owner, any code counts as ownership, revision kept on refusal, `available` always true): every mutation failed the new table or shell tests (1 to 7 each). The old tests that failed with them were 8 in `journal-session-stream.test.ts` and `broker-journal-sessions.test.ts`, plus 4 resource-budget tests of `broker.test.ts` that only fail when every mutation is let through; the S3 seam failed 0 to 5 per mutation. Client mutations (checking counts as read-only, the two owner labels swapped, control counts as read-only): the new rows failed, and so did 6, 1 and 144 Workbench and composer tests that render the state (they test behaviour: queueing while checking, the draft staying focused, the takeover words).

**Deleted.** No whole test: the old tests that fail under a lease mutation are stream integrations (they open a Controller stream, forward frames, hold operations). Two lost their lease assertions, which the table owns: the stale-revision, forged-token and read-only assertions of the first and the re-acquire sequence of the second (15 lines), keeping the assertions on the stream wiring (the Controller is never opened for a refused mutation; the owner is shown when opening is refused). The spec estimated about 30 tests; the checkout does not have them. The lab `session-control-transport` test (real transport) and the Controller's owner check at delivery (`relay-session-control.test.ts`) stay, as the spec says.

**Scope.** A lease rule change selected the Relay core package and its dependents (Controller, debugger, fixtures, seams, Workbench, Cloudflare). It selects now the table and the shell (43 tests, 0.3 s) and the S3 suite (18 tests, 0.5 s); a client change selects `lease-view.test.ts` (6 tests) and the renderers that read it.

**Exceptions.** None lowered; the Relay core exceptions are owned by M11.

**Smoke (seed 33512, build 39bb5c0f1aac).** M2 and M7 passed, every invariant as at the baseline; M1 failed on first paint from the device store as at the baseline (3.3 s Claude, 3.9 s Codex), owned by M8.
