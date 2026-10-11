# Session succession provider completion

Status: provider evidence and production source integrations are implemented and
cross-reviewed. Final workspace gates passed in the existing worktree.
The [current validation report](../../handoffs/2026-10-11-succession-provider-validation.md)
owns final run identities, results and artifact metadata. The prior OpenCode/common
completion remains evidence only for its original frozen revision.

## Contract corrections

- Separate adapter input correlation from the native user-record identity returned
  after dispatch. Keep exact target, text, authority and frozen request binding.
- An owned runtime is an evidence authority, without claiming a globally shared
  service or durable deduplication. Native turn/start evidence proves execution
  started; it does not prove task completion.
- Persist prepared empty descriptors with their original session ID and native
  configuration. Only explicit Host permission allows initializing missing empty
  history. Dispatching, accepted, unknown or materialized input forbids this
  fallback. Never insert placeholder user input to force native persistence.
- Keep native selection interpretation in adapters. Bind reasoning effort and
  opaque provider settings without interpreting permissions in Host or View.
  Retain latest confirmed recovery handles separately from original creation
  evidence throughout the lineage, including failed target selections that confirm
  another value. Drain admitted setting/readback work before native shutdown.
- Reuse the existing native observation and runtime readback; add no second
  observer or independent settings state. Avoid cloning large context histories
  for unchanged recovery handles.
- Successors consume normalized history on the first real input. They are not new
  source-tool children. Existing Ask/Side/TPM readers keep their role bindings.

## Implementation and verification

1. Correct SDK codecs and bounded Host proof storage; update OpenCode and fixtures.
2. Implement independent Codex, Claude Code and Copilot evidence, empty creation
   and native restore. Preserve native ownership, existing extensions and settings.
3. Connect original creation handles through Host directories and workspace
   policy. Derive empty initialization permission from durable dispatch state.
4. Exercise each real native executable with isolated profiles and loopback model
   responses. Cover zero-input prepare, cold restore, exact input correlation,
   explicit execution start, wrong authority and uncertainty without replay.
5. Exercise Host transports across provider boundaries, existing source readers
   and TPM. Review implementation independently, then update compatibility and
   run affected integration, browser, type/build and package checks.

Use test-case and process deadlines. Preserve user services and all prior
evidence. Do not publish, deploy, update installed Controllers or modify native
CLIs as part of implementation validation.

## Progress

- [x] SDK evidence v2: distinct `inputId`, `nativeInputId` and execution identity;
  owned-runtime authority, reasoning effort/provider options and bounded codecs.
- [x] Codex adapter: real empty-session persistence, native client-ID/turn
  correlation, confirmed settings, source tool restoration and no replay.
- [x] Claude adapter: explicit empty descriptor, exact user UUID, complete public
  Stop/result quiescence, confirmed settings and cold materialization evidence.
- [x] Copilot adapter: explicit empty descriptor, native receipt/user/start
  correlation, native queue/approval/background-child readiness and cold-unknown
  handling without text-based reconstruction.
- [x] Host original/latest handle identity, explicit empty initialization,
  bounded retention, failure settlement and shutdown ordering; independent review
  regressions passed. One observation remains authoritative.
- [x] Four-provider Host matrix: 16/16 over real WebSockets with controlled native
  sessions. Real executable tests remain a separate evidence layer.
- [x] Finish the additional Codex shared empty-session restart regression.
- [x] Certify ordinary source creation through all four production directories;
  preserve separate source-tool/grant checks and exact recovery without replay.
- [x] Finish Copilot production source-history registration and native callback
  recovery validation, including portable native-file path checks.
- [x] Final workspace build, full tests, browser acceptance, compatibility and
  isolated Controller package smoke against one source freeze.
- [x] Record final counts, skips, source identity and artifact in the current
  provider validation report. Do not reuse the prior baseline's completed gates.

Native fixtures use standalone Codex 0.162.0; Claude Agent SDK 0.3.247 with bundled
native 2.1.247; Copilot SDK 1.0.11 with native 1.0.83. OpenCode retains its prior
CLI 1.18.18 / SDK 1.18.31 baseline and configured callback path. These are tested
configurations, not a blanket compatibility claim. All use isolated profiles,
loopback model responses and bounded test/process deadlines.
