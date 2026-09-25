# OpenCode Session View Parity Plan

> Execute scoped workers for native projection, controls, and session management. The coordinator owns event reconciliation, Session integration and ARDB acceptance. Do not commit or merge incomplete parity work.

**Goal:** Close the OpenCode versus Codex integration review gaps using native semantics and demonstrate the resulting product Session View through ARDB.

**Architecture:** Preserve Provider SDK / native adapter / Relay / renderer boundaries. Extend the OpenCode adapter with separate controls, projection and native session helpers. Existing normalized events and public controls remain the integration contract. ARDB is the live debugger and replay acceptance surface.

**Tech Stack:** TypeScript, official OpenCode SDK 1.18.31, native OpenCode 1.18.18, HTTP/SSE and Remote HTTP/WebSocket tests, product Session View.

**Spec:** `docs/superpowers/specs/2026-09-25-opencode-provider.md`; this approved parity request supersedes its original implementation omissions, without authorizing emulated native semantics.

## Constraints

- Work in `.worktrees/opencode-provider`; no merge, push, release or user-service changes.
- Native limitations must be demonstrated and recorded; absent native form/authorization/steer semantics cannot be invented to satisfy capability flags.
- All tests have per-test and outer deadlines. Use isolated native data, free ports and deterministic model responses.
- Never retry uncertain prompts, abort native work on detach, or change original session/workspace for fork editing.

## 1. Stable incremental Timeline

Files: `packages/agent-provider-opencode/src/session.ts`, a focused timeline projector helper and real transport tests.

- [x] Make the todo/answered-interaction regression fail by asserting one unchanged Relay epoch across three text deltas.
- [x] Compare observations by stable native identity; append text deltas and tool lifecycle updates using existing normalized semantics. Reserve replacement for actual edits/removals/corrections.
- [x] Preserve historical ordering and resolved interactions across reconnect without turning every token into a replay. Verify late tool updates, reasoning, pagination and corrected text.

## 2. Native tool results, resources and usage

Files: OpenCode `normalize.ts`, `images.ts`, focused tests.

- [x] Test native edit/apply_patch metadata as structured file changes, command exit status/duration and output images.
- [x] Expose only bounded native-authorized resources with validated locators; test file/URL rejection and resource preservation.
- [x] Use native authoritative totals where present, otherwise explicitly distinguish available step counts; derive model context capacity from native catalog and context usage from actual native tokens.

## 3. Settings, commands and interactions

Files: new OpenCode `settings.ts`, `commands.ts`, session integration and focused tests.

- [x] Discover model/agent/variant and permission rules from the actual server; apply confirmed native permission updates and preserve unrelated rules.
- [x] Expose native skills with documentation and genuine invocation, and explicit compact using native session summarization.
- [x] Verify plan/build and native plan-exit questions. Record which normalized interaction types have native producers.
- [x] Probe actual busy prompt behavior before enabling steer; advertise only proven semantics.

## 4. Session operations

Files: OpenCode `provider.ts`, new prompt-edit helper, Host `opencode-directory.ts`, session child runtime projection and tests.

- [x] Validate target user identity and native fork-before-target behavior without touching original files or history.
- [x] Preserve directory prompt-edit integration and existing favorite/Track replacement broadcasts.
- [x] Expose child sessions with native provenance, current state and validated parent-child navigation.
- [x] Implement source-reference callback support with trusted native session identity using an explicitly installed native plugin; ordinary MCP has no trusted session identity. See `docs/opencode-native-boundaries.md`.

## 5. ARDB acceptance and delivery gate

Files: `scripts/opencode-native.test.mjs`, focused ARDB acceptance/recording script, integration documentation and compatibility metadata.

- [x] Use real OpenCode plus isolated local model transport to run a live ARDB server and product Session View.
- [x] Exercise controls from CLI and browser; observe normalized updates independently; inspect rendering of text, tools/diff, interactions and settings.
- [x] Export JSONL and replay it through the same Session View; preserve a repeatable script and report missing debugger affordances found in use.
- [x] Run provider/Host/ARDB/product regressions, typecheck, builds, package smoke, compatibility update/check and diff checks.
- [ ] Commit/merge only on a subsequent user request after capability and verification gates pass. This implementation phase does not publish or deploy.

## Review and acceptance result

Completed controls, normalized tool results/resources/usage, incremental timeline, native fork and child navigation, and the isolated ARDB/browser/CLI/recording/replay workflow. The real view exposed and verified fixes for variant schema rejection and duplicate compaction lifecycle rows. Scripts are `opencode-debug-scenario.mjs`, `opencode-debug-browser.mjs`, and `opencode-native-boundaries.test.mjs`.

The Paseo reference follow-up implements both previously unresolved areas: legacy-session steer through prompt_async with preserved history, and dynamic Ask/source callbacks through a trusted native plugin. Durable history remains separate and is not substituted. Universal Codex effort and normalized interaction kinds with no native producer retain their actual native meaning rather than being fabricated. Callback availability requires explicit plugin setup.

## Final boundary regressions

- Input admission is reserved before asynchronous preparation and remains reserved after initial prompt acknowledgement until matching native input with active work or a matching terminal record is observed. Unrelated busy/error events cannot resolve uncertain input, and cancellation acknowledgement cannot resolve a later admission. A definite rejection releases the reservation; an uncertain write is not replayed. Explicit cancellation also releases it. Commands share admission with messages, including during command discovery.
- A corrected bounded history tail excludes receipts whose native anchors belong to older pages. Loading that older page restores the receipt beside its native predecessor. Unanchored initial observations are not copied into every history page.
- Verification uses provider HTTP/SSE regressions, native shared-session/fork/child/history tests, native busy-input and callback tests, and the ARDB/browser scenario. Task 8 records the final results after all review fixes.

## Paseo reference follow-up (approved)

Ruling: Preserve native prompt-edit forks and dynamic Ask source reads. A text history snapshot is useful as a separate feature, but is not an equivalent implementation of source authorization.

### Task 6: Trusted native callback bridge

Implement a standalone OpenCode native plugin plus a local authenticated bridge based on Paseo's native `context.sessionID` binding. Keep callback authorization in the Host. Register/revoke callbacks for each native session, enforce schema and bounded request handling, prevent cross-session access, and restore grants after Controller restart. Provide explicit external-server plugin configuration and capability detection; never silently modify or restart a user's server. Wire Host source references and ARDB/Controller packaging. Existing Codex grants must remain compatible. Real HTTP and native plugin validation are required.

### Task 7: Legacy busy input verification and admission

Reproduce Paseo's legacy `promptAsync` path on native 1.18.18 while a model step and a tool are running. Assert the follow-up reaches a subsequent model request with original context and executes exactly once. Enable steer/immediate only for proven semantics, distinguish definitive rejection from uncertain input, and do not substitute durable history or simulate native queue behavior. Preserve reconnect and normalized echo/turn semantics.

### Task 8: End-to-end acceptance

Use ARDB and real native runtime to validate callback tools and source reads, shared-session isolation, busy input, disconnect/recovery, and recording/replay. Run affected regressions, typechecks, builds, package validation, compatibility update/check, and final review. Do not commit incomplete work; no push/deploy/release authorization in this task.


## Final follow-up acceptance

- Trusted callbacks and dynamic source Ask are implemented and independently reviewed. Native plugin setup is explicit; ordinary sessions do not depend on it. The native test executes callbacks before and after Controller recreation, accepts a new tool without native restart, and rejects an unbound native session.
- Native legacy steer is verified during both model and shell-tool execution, preserves source history and native echo/turn identity, and never cancels and resends. Admission and delayed-cancel races have focused regressions and review closure.
- The actual ARDB path exposed empty pending-tool details that violated the public schema and disconnected the client. Ten tool lifecycle/codec regressions now pass. The final scenario requires zero unexpected disconnects and rejects any model-fixture failure.
- Final provider suite: 102 tests. Host/Codex affected tests: 42. ARDB: 102. Relay projector: 10. Web replica: 23. Conformance: 17. Four isolated native suites pass against OpenCode 1.18.18.
- The final rebuilt native/ARDB scenario passes all 13 checks, records 646 events with no recording warnings, no replica diagnostics, and zero Remote disconnects. Evidence: `.tmp/opencode-debug/2026-09-25T12-43-41-574Z-fd4e26f6.jsonl.evidence.json`.
- Full workspace build/typecheck, standalone Controller installation/setup smoke, final package asset/CLI checks, compatibility update/check, and diff checks pass. No commit, push, deployment, release, or user-service restart is performed in this phase.

## Release follow-up: Controller 0.2.22

The user authorized merge, deployment, and a direct GitHub Release after acceptance. The release sweep found an outdated OpenCode degradation validator and provider fixtures; these now match the implemented steer/callback boundaries. The subscription cleanup regression now verifies stable subscription ownership across navigation and zero remaining subscriptions after unmount instead of an obsolete fixed count.

The portable workspace regression passes through Cloudflare (52 tests); the corrected Lab suite passes 713 tests with six existing skips. Codex local-native tests are excluded because PATH resolves Codex 0.46.0 instead of their pinned 0.148.0. The default root test command also duplicates hookTimeout for two packages; the release sweep invokes package test scripts directly under an outer deadline. Neither limitation is claimed as a passing native Codex suite.
