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
