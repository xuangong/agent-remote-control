# Agent Remote Control Collaboration

Write code, comments, and documentation in English. Respond to the user in Chinese.

- Make changes in a dedicated worktree under `.worktrees/`; keep the main checkout available for normal use.
- Keep the Provider SDK, public Remote protocol, Relay state, native adapters, and client renderer as separate boundaries. Native runtime interpretation belongs in adapters.
- The standalone workbench has no account system. Pairing keys are temporary and process-local. Never add hidden dependencies on Borgee services, source paths, workspace packages, or user credentials.
- Keep protocol fixtures, replay behavior, public schemas, and compatibility metadata synchronized with contract changes.
- Task branches never update the compatibility digest of `packages/agent-relay-node/compatibility.json`, the generated index of `docs/superpowers/open-items/` or the legacy token budgets of the stylesheets (`packages/agent-remote-lab/src/ui/legacy-token-budget.json`, a ceiling that only falls): `pnpm compatibility:check` reports a stale digest on a task branch and passes, and fails on `main`, on a detached HEAD and in the release workflows. After merging into `main`, run `pnpm postmerge` there before pushing: it regenerates the digest and the index, lowers the budgets to their counts, commits them alone and checks them. A release runs `pnpm compatibility:update` after its version change (`docs/controller-npm-release.md`).
- Ledgers are one file per entry: open items in `docs/superpowers/open-items/` and design clauses per component in `docs/current/agent-remote/components/`. A task edits only the files of the items and components it changes.
- `pnpm arch:check` is blocking and enforces the layer rules of `docs/superpowers/specs/2026-11-18-target-architecture-and-tests.md` section 1.2 against `architecture/modules.json`. Every source file belongs to a module. A violation that cannot be fixed yet is listed in `architecture/exceptions.json` with the migration step (M3 to M14) that removes it; fix, never add, and lower an entry's `max` when you fix one.
- Use per-test and outer process deadlines for every test run. Root test commands already enforce both.
- Test observable behavior rather than source text. Use real transports for changes to protocol, pairing, or reconnect behavior.
- Preserve existing local services and untracked user material. Use configurable free ports for local validation.
- When a change affects the website, Relay or Controller, verify it in this checkout's local instance (`pnpm local up`); follow `.agents/skills/prepare-arc-local/SKILL.md`.
- Keep readable conversation rendering primary; Trace and Replica Inspector support diagnosis.
- Write large files in chunks. Name code by business meaning and keep process history out of comments.
- Do not publish packages, push, or create a remote repository unless the user asks.

## Test layers

Test what a change touches. Unit and integration tests use mock data; only e2e and local/native tests use a real stack. How to write them: `.agents/skills/write-tests/SKILL.md`.

| Layer | Uses | Runs |
|---|---|---|
| Unit | One module through its public functions; ports replaced by stubs; mock data | Every task: `pnpm test:unit <package> [file]` |
| Contract | Protocol fixtures, public schemas, replay and recordings, compatibility metadata; both ends consume the same fixture; the provider conformance kit (`pnpm test:providers`) | After a contract change, with the producing and consuming unit suites |
| Integration | A few real modules wired through an explicit seam contract, everything outside the seam replaced by fixtures or in-memory stores; never the whole stack | After a change on that seam; `pnpm verify:changed` builds and type-checks the changed packages and their dependents, then runs each changed module's tests and the seam suites the module names in `architecture/modules.json` (`pnpm test:changed`) |
| Component (browser) | Fixture pages of the Workbench in a real browser on builder states; no Relay, no Controller (`packages/agent-remote-lab/e2e/components`, and the `e2e/*.browser.ts` files) | After a layout or component change, and at the end of a step: `pnpm test:components`, `pnpm test:preview-browser` |
| E2E flows | The real client in a browser against a real Relay and a Controller with a scripted provider (`packages/agent-e2e/flows`); the main flows and cases found by `pnpm local` | End of a step, before a merge or release: `pnpm test:e2e:flows`, and again with `E2E_BROWSER=webkit`. It is the only e2e tier: the older Relay-backed Playwright specs were moved down or deleted with a mutation check (`docs/superpowers/specs/2026-11-21-e2e-convergence-mapping.md`) |
| Local/native | Real CLIs, models and terminals on this machine | By hand or nightly: `pnpm test:local`, `pnpm test:claude`, `pnpm test:opencode:native`, `pnpm test:native:browser` (the page against a real Codex or DSH runtime), and each CLI's assumption check, `pnpm test:native:<cli>` |

Run `pnpm task:start` at the start of a task so `pnpm verify:changed` compares with that commit. Run the full `pnpm verify` at the end of a step and before a merge or release.

Speed rule for unit and integration tests, which use mock data: a test over 1 s is wrong, and a test over 300 ms needs a look. Use fake timers, injected clocks and mock ports instead of real waits, processes or full stacks. `scripts/lib/slow-test-reporter.mjs` lists tests over 300 ms and fails the run on a test over 1 s that `scripts/slow-test-allowlist.json` does not name and that is over 1 s again when its file runs alone (a retry for timing only, so machine load does not fail a run); `ARC_SLOW_TEST_ENFORCE=0` only lists them. The allowlist only shrinks. Local/native, browser, e2e and process-project tests are exempt.
