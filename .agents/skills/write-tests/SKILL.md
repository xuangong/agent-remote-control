---
name: write-tests
description: Use when writing, changing, moving or deleting tests in this repository, when a test is slow or flaky, when a change seems to need "run everything", or when deciding which tier a test belongs to. Covers module-first test design, mock data at seams, the tier model, speed budgets, mutation-checked deletion and change-scoped runs.
---

# Writing tests here

Every rule below comes from the 2026-11 test restructuring. Before it, a one-line
change ran the changed package and every dependent: 3,000 to 8,100 tests in 2 to
8 minutes with about ten failing, and the same rule was
asserted in four packages. Measured at the end, same machine, baseline tag against
HEAD (section 11 of `docs/superpowers/specs/2026-11-18-target-architecture-and-tests.md`):
- a rule change runs its module and its seams: 13 to 370 tests in 3 to 14 s
  (window rule 230 tests, 8 s, was 6,009 in 431 s; Workbench state 13 tests, 3 s,
  was 2,994 in 108 s; protocol schema 704 tests, 14 s, was 8,143 in 468 s);
- `pnpm test` runs 11,362 tests in 315 s with none failing (9,610 in 517 s, 9 failing);
- tests over 1 s: 152 to 48 in a full parallel run (allowlist 11); over 300 ms: 666 to 415;
- the largest files: `broker.ts` 2,737 to 423 lines, `host.ts` 1,807 to 551, `App.tsx` 3,765 to 90;
- 13 product defects were found by smoke, e2e and package tests and pinned at the lowest tier.

## 1. Design the module first; the tests follow

Software is assembled like a building:
- Every component has a purpose fixed before assembly. You can check it alone with stand-in inputs: **unit tests with mock data**.
- How components connect is specified in advance. You can check a connection against the specification with stand-in data on the far side: **integration (seam) tests with mock data**.

**Redundant tests mean the module division is unclear.** When the same rule is asserted through several entry points, for example a Worker socket, a whole-app mount, a Relay stream and an e2e spec, the rule has no home of its own. Do not add a fifth assertion. Extract the rule into a module with:
- one purpose, written at the top of the file;
- a public contract: functions and types, and for seams also ordering, guarantees and errors, written in `docs/current/agent-remote/seams.md`;
- dependencies passed in as **ports** (clock, ids, storage, transport, process, page lifecycle), never reached for directly.

Pure state plus ports is the shape that tests well. Examples in this repo:

| Rule | Home | Shape |
|---|---|---|
| Unchanged, extend or replace a journal window | `agent-remote-journal/src/window-decision.ts` (`decideWindow`) | pure function plus one shared vector table |
| Control lease of a browser stream | `agent-relay-core/src/domain/session-control` (`transition`, `viewOf`) | pure transition table; `stream-control.ts` is only the shell |
| Send state of a pending message | `agent-client/src/replica/send-state.ts` | pure transition table |
| Succession refresh and settlement | `agent-client/src/succession/*` (`reduceRefresh`) | reducer returning next state and effects as data |
| Device-store paint rule | `agent-client` display lease plus the `DeviceDatabase` port | rule plus port; IndexedDB is one implementation |

The shell (socket handling, React hooks, process spawning) stays thin and gets few tests. The rules get many fast ones.

## 2. The tiers

| Tier | What it exercises | Data | Runs |
|---|---|---|---|
| Unit | One module through its public functions; ports stubbed | Mock data (builders) | Every task: `pnpm test:unit <package> [file]` |
| Contract and integration (seams) | Two or more real modules wired through a written seam contract; everything outside is mock | Recorded or constructed fixtures, golden transcripts | When either side of the seam changes: `agent-remote-seams`, `pnpm fixtures:check` |
| Transport | A real socket or Worker where the transport itself is the subject | Mock data | With its package; keep it small |
| Component (browser) | A Workbench fixture page in a real browser on builder states; no Relay, no Controller (`agent-remote-lab/e2e/components`, `e2e/*.browser.ts`) | Layout and component rules | After a layout or component change, and at the end of a step: `pnpm test:components`, `pnpm test:preview-browser` |
| E2E | The real client in a browser against a real Relay and a Controller with a scripted provider (`agent-e2e/flows`, `pnpm test:e2e:flows`) | Main flows only, plus cases that `pnpm local` found | End of a step, before a merge or release |
| Smoke | `pnpm local` with real CLIs under extreme conditions: latency, loss, half-open sockets, mid-turn restarts, quota, many sessions, terminal and page racing | Real | `pnpm smoke:quick` per step, `pnpm smoke` before a release |
| Local/native | Real CLIs, models and terminals | Real | By hand or nightly |

Unit and integration tests **must** use mock data. If a test needs the whole stack to check one rule, that is a missing module, not a reason to start the stack.

A component spec runs in the two Chromium projects, unless it is a `phone-*.spec.ts` written for exactly 390 x 844. To run it in WebKit or in the phone projects, name them in its first line, `// Component projects: webkit-desktop, orchard-phone-webkit`; `playwright.components.config.ts` selects by that line, so a new spec never edits it.

## 3. Mock data that stays honest

- **Build, don't copy.** Use the builders in each package's `./testing` entry (for example `agent-client/testing`: `buildSuccessionReplay`, `buildSuccessionChain`, `buildRoleEvidence`) and in `agent-remote-fixtures`. Inline wire literals drift from the protocol; builders are typed against it.
- **Record reality once, replay it everywhere.** Provider behaviour comes from recordings of the real CLI against a scripted model, each with golden `.rows.json`. Controller↔Relay and Relay↔browser behaviour comes from golden transcripts recorded at the baseline tag. A behaviour-preserving change must replay them byte for byte. A deliberate wire change is a separate, reviewed commit that regenerates them.
- **One vector table, several consumers.** When several layers must agree on a rule, write the cases once as data and let each layer read the table. The journal, the publisher and the replica all read the window-decision table. Disagreement between layers then becomes impossible to miss.
- **Freeze stored formats.** A persisted record has a frozen fixture, such as `device-record.v1.json`. A reader that changes must still read it.

## 4. Speed is a correctness property

A unit or integration test over **1 s is wrong**. Over **300 ms**, look at it. `scripts/lib/slow-test-reporter.mjs` lists both and fails the run on a test over 1 s that `scripts/slow-test-allowlist.json` does not name, after running its file once more alone (load moves a near-limit test, a real cause does not). The allowlist only shrinks, and every entry says why.

Almost every slow test here had one of these causes, and each has one fix:

| Cause | Fix |
|---|---|
| A real timer or sleep (`setTimeout`, retry backoff, heartbeats, deadlines) | Inject the clock or the delay (`hostLiveness`, `stateRetryMs`, deadline options) and advance it in the test |
| A real process, socket or `workerd` where the rule is a decision | Move the decision into a pure module and stub the port |
| A whole app mounted to check one rule | Extract the rule and test it alone |
| A polling `waitFor` racing a real delay | Make the delay an input. Never raise the `waitFor` limit. |
| A per-file setup cost | Share a fixture module and split the file by behaviour so files run in parallel |

**Flaky usually means a hidden real clock.** The `App.succession` flake that failed 1 run in 3 was a fixture socket that never answered a resume probe. The page waited out a real 4 s deadline against a 5 s `waitFor`. The first attempted fix ("wait the timer out") was wrong. The cause-level fix (the fixture drops its sockets like a lost connection, and the transport takes the wait as an option) took both tests from 5.3 s to 0.32 s and 12 of 12 passes.

## 5. Delete with proof: the mutation check

Never delete a test because it looks redundant. For each rule that moves into a module:

1. Write the module's unit tests (or vector rows).
2. Break the rule in the module, one mutation at a time.
3. Record which new tests fail and which old tests fail.
4. Delete an old test only if every mutation it catches is also caught by a new test.
5. Write the mapping (old test → owner test → mutations) in the step's mapping doc, such as `docs/superpowers/specs/2026-11-18-m5-m7-test-mapping.md`.

Mutation checks also show where the old suite was blind. Several succession rules (for example "a restored source always settles") had no old test that failed when they broke. The new module covers them, so the change added coverage while it removed redundancy.

A wiring test that catches mutations only in a module with no unit test of its own is that module's only coverage, not a duplicate. Write the owner's unit tests first, then judge the wiring test again. The final census of the Relay's gateway and broker tests found no deletable test for this reason: 152 of 265 were the only coverage of route and composition modules.

Expect fewer deletions than a size estimate predicts. Old whole-app tests often check composition (layout, wiring, several features together) rather than the rule. They stay until the composition itself becomes a module.

## 6. Test what you touched

- **During a task:** `pnpm task:start` records a base. Then run `pnpm test:unit <package> [file]`, or `pnpm verify:changed`, which builds and type-checks the changed packages and their dependents since that base, then runs each changed module's own tests and the seam suites the module names in `architecture/modules.json` (`pnpm test:changed`). A source file given to `pnpm test:unit <package> <file>` runs its module's tests and seams the same way; a test file runs alone. The unit tests of the modules that import a changed module run too when they reach the changed file through the import graph (nearest first, at most 80 files); the rest wait for the step's full `pnpm verify`. Workspace packages resolve to `src` in Vitest, so dependants do not need a build first.
- **When a seam changes:** add the seam suite (`agent-remote-seams`) and `pnpm fixtures:check`.
- **Full suite:** at the end of a step, and before a merge or release.
- **Architecture:** run `pnpm arch:check` (blocking) on every change that adds an import. Fix violations. Never add an exception; lower an exception's `max` when you fix one.
- Keep the compatibility digest out of unit tests. It belongs to `pnpm compatibility:check` alone. A test that reads the repository's own manifest fails on every unrelated source edit.

## 7. Local findings become fast tests

`pnpm local` and smoke tests show what really happens with real CLIs and a real browser: what to change, and whether the intended effect arrived. They do not replace the lower tiers. Each finding moves down:

1. Record it: a transcript in `agent-remote-fixtures`, or a recording of the provider.
2. Pin it at its seam: an integration test with that data.
3. Pin the rule in its module: a unit test.
4. Add an e2e case only if it is a main flow, or it was found locally and cannot be expressed lower.

Examples:
- **Smoke M1** found first paint scaling with latency. The S7 test "a restored record paints before any frame arrives" now holds the fix.
- **The Claude terminal fork** became a recording plus a divergence test.

## 8. Checklist for a new or changed test

- [ ] I know which module owns the rule, and the test calls that module's public functions.
- [ ] Ports are stubbed. The test uses no real clock, socket, process, `workerd` or browser, unless it is in the transport, e2e, smoke or native tier on purpose.
- [ ] Data comes from builders, recordings or golden transcripts, not hand-copied wire literals.
- [ ] It runs under 300 ms, and the slow-test reporter does not list it.
- [ ] The same rule is not asserted elsewhere. If it is, I ran the mutation check and deleted or kept the other test with a recorded reason.
- [ ] Before committing, I ran only the affected scope: `test:unit`, seams, `fixtures:check`, `arch:check`.

## 9. Anti-patterns seen here

- **Mounting the Workbench to check a timeline or succession rule.** The test is slow, couples to layout and duplicates the rule.
- **Driving Relay rules through a Worker socket in the Cloudflare package.** 33 of these were deleted after mapping. One Worker persistence smoke test per feature remains.
- **Raising a timeout or `waitFor` to make a flake pass.**
- **A test that reads `process.cwd()` or the repository's compatibility manifest.**
- **Importing the same module by path and by package name.** You get two copies, and `instanceof` checks fail. Import by package name.
- **A resource invariant against a fixed limit while the content grows.** The soak's heap check could not tell a leak from a longer conversation. Normalize by what is retained: compare with a fresh page holding the same rows.
- **A package `test` script that chains two runs.** File arguments reach only the last run. Give the package a `test:unit` script that `pnpm test:unit` prefers.
- **Trusting the workspace for packaging.** Workspace resolution hides a private dependency under a public package and an `exports` map that drops a published path. Run the installed-package test (`scripts/*-package.test.mjs`) after changing a manifest.
- **Measuring through a harness that changes what it measures.** The first-paint probe closed the page inside the store's write-behind window. Check the probe before blaming the product.
