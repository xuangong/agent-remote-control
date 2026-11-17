# Agent Remote Control Collaboration

Write code, comments, and documentation in English. Respond to the user in Chinese.

- Make changes in a dedicated worktree under `.worktrees/`; keep the main checkout available for normal use.
- Keep the Provider SDK, public Remote protocol, Relay state, native adapters, and client renderer as separate boundaries. Native runtime interpretation belongs in adapters.
- The standalone workbench has no account system. Pairing keys are temporary and process-local. Never add hidden dependencies on Borgee services, source paths, workspace packages, or user credentials.
- Keep protocol fixtures, replay behavior, public schemas, and compatibility metadata synchronized with contract changes.
- Run `pnpm compatibility:update` after reviewed implementation changes, then verify `pnpm compatibility:check`.
- Use per-test and outer process deadlines for every test run. Root test commands already enforce both.
- Test observable behavior rather than source text. Use real transports for changes to protocol, pairing, or reconnect behavior.
- Preserve existing local services and untracked user material. Use configurable free ports for local validation.
- When a change affects the website, Relay or Controller, verify it in this checkout's local instance (`pnpm local up`); follow `.agents/skills/prepare-arc-local/SKILL.md`.
- Keep readable conversation rendering primary; Trace and Replica Inspector support diagnosis.
- Write large files in chunks. Name code by business meaning and keep process history out of comments.
- Do not publish packages, push, or create a remote repository unless the user asks.

## Test layers

Test what a change touches. Unit and integration tests use mock data; only e2e and local/native tests use a real stack.

| Layer | Uses | Runs |
|---|---|---|
| Unit | One module through its public functions; ports replaced by stubs; mock data | Every task: `pnpm test:unit <package> [file]` |
| Contract | Protocol fixtures, public schemas, replay and recordings, compatibility metadata; both ends consume the same fixture | After a contract change, with the producing and consuming unit suites |
| Integration | A few real modules wired through an explicit seam contract, everything outside the seam replaced by fixtures or in-memory stores; never the whole stack | After a change on that seam; `pnpm verify:changed` runs the changed packages and their dependents |
| E2E | The real client in a browser against a real Relay and Controller with a scripted provider; main flows and cases found by `pnpm local` | End of a step, before a merge or release: `pnpm test:e2e`, `pnpm test:preview-browser` |
| Local/native | Real CLIs, models and terminals on this machine | By hand or nightly: `pnpm test:local`, `pnpm test:claude`, `pnpm test:opencode:native` |

Run `pnpm task:start` at the start of a task so `pnpm verify:changed` compares with that commit. Run the full `pnpm verify` at the end of a step and before a merge or release.

Speed rule for unit and integration tests, which use mock data: a test over 1 s is wrong, and a test over 300 ms needs a look. Use fake timers, injected clocks and mock ports instead of real waits, processes or full stacks. `scripts/lib/slow-test-reporter.mjs` lists tests over 300 ms and reports a test over 1 s that `scripts/slow-test-allowlist.json` does not name; set `ARC_SLOW_TEST_ENFORCE=1` to fail the run on one. The allowlist only shrinks. Local/native, browser, e2e and process-project tests are exempt.
