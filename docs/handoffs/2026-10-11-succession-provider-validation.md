# Session succession provider validation

Date: 2026-10-11. Branch: `feat/session-succession`.

Status: provider evidence and production Host integrations are implemented and
cross-reviewed. The missing Copilot history/source-reference wiring and bounded
source-create certification on production directories are corrected. Final
workspace gates against the frozen implementation are **complete**.
This is not a release, deployment or installed-Controller update.

The [prior OpenCode/common baseline](2026-10-11-session-succession-validation.md)
retains its original source freeze, results and package artifact. Those results
do not certify the subsequent provider changes. This report is the current
provider-stage validation record; final run identities and numbers belong here.

## Delivered contract

- SDK evidence v2 separates adapter `inputId` correlation, the proven native user
  record `nativeInputId`, and optional execution `nativeExecutionId`. Exact target,
  composed text, authority and frozen selections bind the proof. Materialization
  alone does not prove execution; execution start does not prove task completion.
- Native authority may be a trusted service or an owned runtime. It is not a
  global process lease or a cross-restart exactly-once guarantee. One native
  observation feeds ordinary Session View state and evidence.
- Claude and Copilot keep bounded empty descriptors with the original session
  identity. Only explicit Host permission may initialize a known, undispatched
  empty candidate. Missing native history does not grant permission. No fake seed
  prompt is inserted. Existing native history uses native resume.
- Original creation evidence and the latest confirmed recovery configuration are
  separate. Host reserves handle capacity before settings dispatch and retains
  confirmed values through normal readback/observation for the whole lineage.
  Delayed events cannot overwrite newer settings. Native rejection still retains
  any different confirmed value; failed persistence remains uncertain. Shutdown
  drains already-started setting/readback work before disposing native sessions.
- Host admits only idle sessions with no pending input, interaction, active child
  work or unsettled mutation. Same-Host/canonical-cwd provider pairs are selected
  from capabilities and current evidence. Recovery inspects the original witness;
  it never redispatches an uncertain input or recreates its candidate.

## Native evidence and limits

All native evidence below uses isolated macOS arm64 profiles and loopback model
fixtures. It exercises real executables and adapters, not an external commercial
model. These runs do not certify every CLI version, Windows/Linux behavior or a
complete real-provider-to-browser deployment.

| Provider | Tested runtime | Evidence and remaining limit |
| --- | --- | --- |
| Codex | Standalone CLI 0.162.0, public app-server protocol | Focused non-native suite: 414 passed; final affected native evidence/shared/settings suite: 19 passed. Same-provider model, effort, permissions, instructions and planning are retained. An isolated shared daemon restart before the first input preserved the exact empty session and made zero model requests. Exact `clientId` user/turn readback and source tools were verified. Required RPC/evidence fields are capability checks, not claims about every historical version. |
| Claude Code | Agent SDK 0.3.247, bundled native 2.1.247 | Focused non-native suite: 140 passed. Isolated production-adapter test: 1 passed, including zero-input descriptors, source callback, exact UUID, live start, confirmed settings and cold materialization. This native version did not emit declared `session_state_changed`; complete public Stop task/cron snapshots plus the exact zero-queue result prove owned-runtime quiescence. Cold history does not prove reply execution. Effort/permission recovery requires the latest confirmed Host handle. |
| Copilot | SDK 1.0.11, bundled CLI 1.0.83 | Native suite: 18 passed, including 3 evidence cases for empty descriptors, pending approvals, queues and active background children. Additional independent source-history native test: 1 passed; final-build actual Host preparation/callback tests: 2 passed. The send receipt binds correlation to native `user.message`; matching `assistant.turn_start` proves start. This receipt binding is attachment-local: cold readback may remain unknown and must not be guessed from text or replayed. |
| OpenCode | CLI 1.18.18, SDK 1.18.31 | The built production adapter was rerun with the updated evidence contract: 1 native test passed for A input, empty B, B first/ordinary inputs and empty C. All owned processes exited and profiles were removed. The reviewed configuration still requires disabled background subagents and the explicit callback plugin for source references; callback validation remains separate prior-baseline evidence. |

## Integration and review

The Host provider matrix passed **16/16** cases over real WebSocket transport with
controlled native implementations. It validates common routing/dispatch across
the four-provider matrix. It is not sixteen real-provider full-stack runs.
Provider-native evidence, controlled Host transport, browser acceptance and
packaging are separate layers.

The final production-directory review found that all four providers lacked the
ordinary source-create bound required by the trusted succession-v2 entry. The
adapters now declare their native creation identity bounds and the actual
directories certify only ordinary source creation. No Host gate was relaxed.
The focused integration suite passed 115 tests in eight files, and an independent
review reran the nine actual-directory cases successfully. These cases cover
Host v2 admission, source tool calls, durable grants and recovery of the original
created identity after restart without another creation. The evidence and native
producer bounds are retained in `source-create-native-bounds.md` under the local
evidence directory.

Copilot production registration now installs provider/profile-scoped durable
source grants. An attached source uses the public SDK event-log API; an unattached
source uses bounded, read-only native `events.jsonl` interpretation inside the
adapter, without opening or taking ownership of the source. The 8 MiB/4,096-event
limits fail explicitly, as do invalid, changing or unavailable histories. No
unproven turn grouping is invented. Portable file identity/path checks close the
Windows symlink gap independently of POSIX-only flags. Registration and directory
tests passed 18/18; independent history tests passed 8/8 plus one native test.
The final-build actual Host cases passed 2/2: preparation reached ready without
an extra model turn, and a restored reader used explicit native approval to read
its source. Optional registration configuration forwards the existing SDK model
service and login settings without changing defaults or adding CLI flags.

Independent common-boundary review resolved recovery-read shutdown ordering,
in-flight setter draining, failed-setting confirmed-value retention and execution
policy refresh-option forwarding. All three independent behavioral regressions
passed after the corrections. The final no-op retention optimization avoids
copying large context records without changing ownership or ordering.

The final full-suite attempt exposed an outdated cancellation assertion and a
real pre-inspection race. Context must be bound before inspecting an empty
descriptor. A terminal check now prevents inspection when cancellation wins
before binding; cancellation during binding or inspection retains recovery data
without making the candidate current or allowing first input. Independent
regressions passed 36/36, including cold recovery and zero native dispatch.

Two final acceptance failures were test synchronization defects: Copilot's real
terminal needed to finish slash-command completion before Enter could execute
`/exit`, and the mobile browser helper needed to wait for the restored primary
view before opening collapsed actions. The targeted native handoff suite passed
4/4 and the targeted mobile reload case passed after those test-only corrections.
Neither correction changes production ownership, permissions or timeouts; final
workspace and browser results are recorded separately below.

A later mobile image assertion exposed a test seed racing the editor's normal
pagehide save. The joined test now adds an actual image through the file chooser,
observes its generated identity and exact stored bytes, then verifies them after
reload on B and succession to C. The focused joined matrix passed 6/6 before the
complete browser matrix passed 23 tests with five desktop-only mobile skips.
This final test-file change invalidated the implementation fingerprint while the
workspace suite was running: ten Lab cases stopped at that preflight check.
`provider-final-build-5` regenerates the fingerprint after the test freeze; the
subsequent workspace run is the final gate. No production fix was needed for
those ten preflight failures. Original failed logs and traces remain available.

The next workspace attempt found two Host test synchronization defects. The
updater test observed the persisted `restarting` phase before the asynchronous
save completed and the restart callback ran. It now waits for that callback;
all 18 updater cases passed. The native-owner test used elapsed sleeps without
proving that its takeover request reached the real HTTP handler before expiry.
It now controls deadline delivery after release begins and waits for withdrawal
and cleanup events; all seven ownership cases passed. It retains the 25 ms
deadline configuration and checks old-writer fencing, reservation removal and
successor ownership. Neither correction changes production behavior or increases
timeouts. Compatibility was regenerated after both test files were frozen.

`provider-final-unit-5` then passed every package except one native Codex Host
restart test, which hit its existing 15-second HTTP deadline without identifying
the request. The unchanged focused test passed, as did all 1,304 Lab cases under
the same package concurrency with external phase diagnostics. Initial creation,
backend restart, replacement creation and original-session attachment took
987 ms, 1,213 ms, 364 ms and 5 ms respectively in that diagnostic run. The single
timeout was not reproduced and its cause is not established. The test now retains
its stage, POST URL, original cause and fixture output on failure; no assertion,
deadline or production code changed. Focused verification and Lab/e2e typechecking
passed after this diagnostic-only change. The final workspace rerun below is
separate evidence, not a claim that an unknown root cause was corrected.

Local evidence is retained under
`.superpowers/sdd/2026-10-10-session-succession/`, including
`task-codex-succession-research/report.md`,
`task-claude-new-provider-research/implementation-report.md`,
`task-claude-new-provider-research/adapter-native-final-4.json`,
`task-claude-new-provider-research/common-review.md`, and the root Copilot native
run records. Failed attempts remain separate from passing evidence.

## Final workspace gates

Root updates this table only from completed runs against the final source freeze.

| Gate | Current result | Final evidence |
| --- | --- | --- |
| Build and compatibility metadata | Passed | `provider-final-build-5`; final test-only metadata update `provider-final-compatibility-update-4`; digest `sha256:180eecb2dcc4e025012c20b0fc78e6b44e54ae9594959b8ebd12666540073fc0` |
| Typecheck | Passed | `provider-final-typecheck-3`, `provider-final-e2e-typecheck-1`, `provider-final-host-typecheck-1` and `provider-codex-host-diagnostic-typecheck-1` |
| Full workspace tests | Passed: 5,616 tests, 35 skipped, 0 failed | `provider-final-unit-6`; 576 files passed, 10 skipped; 343.423 seconds, exit 0; finished 2026-10-11 09:01:34 UTC |
| Desktop/mobile browser acceptance | Passed: 23 tests, 5 desktop-only skips | `provider-final-browser-3`; desktop 14 passed, mobile 9 passed and 5 skipped; actual Host/Gateway/UI with controlled native sessions |
| Controller package and isolated smoke | Passed: 3 tests, 0 skipped | `provider-final-controller-build-2` and `provider-final-controller-smoke-2`; temporary installation, CLI and paired-daemon lifecycle |
| Final compatibility check and source freeze | Passed | `provider-final-compatibility-5`; runtime freeze 4 unchanged throughout the full run; source identity below |

The final isolated Controller artifact is
`.superpowers/sdd/2026-10-10-session-succession/task-provider-controller-package-final-2/orchardworks-agent-remote-controller-0.2.42.tgz`
(646,175 bytes; SHA-256
`499275f3433a8e89da99329fde8b6806665d46f4578c38e534c638e8d9ea8c96`).
It records inherited HEAD `f0ff47377b18095263fe6efa5f2e051e45d88952` with
`dirty: true`; the reviewed working-tree changes are identified by the source
manifest, not by that HEAD alone. Version 0.2.42 is the current package manifest,
not a newly published release. All three smoke checks passed against this exact
tarball in temporary installation directories; the user's global Controller was
not replaced.

The package contains neither tests nor Lab compatibility metadata, and its build
does not read the implementation fingerprint. The later Host test corrections,
Lab test diagnostics and regenerated Lab fingerprint therefore do not invalidate
this artifact or its smoke results. No production package input changed after its
build.

The browser gate used the same production sources as `provider-final-build-4`.
Later source changes only correct browser and Host test synchronization or add
Lab test diagnostics; build 5 and the final metadata update record the
corresponding fingerprints. Full
typechecking was followed by explicit checks of the changed e2e and Host tests.
The runtime freeze is
`task-5-g2g3-root-validation/provider-runtime-freeze-final-4.json` under the local
evidence directory. It differs from freeze 2 only in the two Host tests, one Lab
test and compatibility metadata. It records 308 changed/nontracked runtime-scope
files against review base `cc3f3599479fc578045c1828ee6d56c638b2c84b`; SHA-256
`5df330ffd85bae51ee36fd4844d5158e8af9bf9950549f115e9971df486c1cf1`.
The full suite and final compatibility check left that freeze unchanged.

The final source-and-documentation manifest is
`task-5-g2g3-root-validation/provider-final-source-manifest-1.json`; its hash and
the completed gate records are retained in
`task-5-g2g3-root-validation/provider-final-completion-1.json`. Both are under the
local evidence directory. These identities describe the reviewed working tree,
not a new commit. The full-suite total counts only its final successful run;
focused/native/browser/package results above are separate, not added to it.

Keep unresolved operations and the complete state set in the
[recovery guide](../current/agent-remote/session-succession-recovery.md).
Controller, Relay and website require a coordinated upgrade. Local validation
does not authorize publication, deployment, service replacement or native CLI
modification.
