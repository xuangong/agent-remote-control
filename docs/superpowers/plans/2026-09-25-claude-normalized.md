# Claude normalized provider and stdio control

> Execute inline with the executing-plans workflow. The user authorized the established Copilot integration approach; retain native-specific semantics.

**Goal:** Make the existing Claude provider usable through the same product Session View and managed stdio handoff as Copilot, with audited normalized coverage and native regression evidence.

**Architecture:** Claude owns native interpretation. A common Host stdio directory owns managed CLI/Controller leases; Relay retains its existing connection control. ARDB reuses the production view and protocol. No new wire variants, daemon changes, package publication, or deployment.

**Runtime:** Pinned Agent SDK 0.3.247, Claude Code 2.1.247. Use isolated configuration directories and deterministic loopback Messages responses for native tests.

## Implementation

- [x] Normalize successful native Edit/Write structuredPatch into existing file_changes JSON, preserve raw fallback, and never render failed intent as a committed diff. Cover malformed/multiple results and streamed finalization.
  - Tests: project a native assistant tool then a user tool_result with structuredPatch; assert exactly one modified/added file. Failed result must not contain file_changes.
- [x] Support session permission grants only from native allow suggestions, normalized to session destination. Reject mode changes and unsupported suggestions; retain once-only fallback and existing question/plan validation.
  - Tests: response includes only the validated suggestion snapshot, once has no updatedPermissions, no suggestions rejects session scope.
- [x] Resolve native cwd by ID through catalog.info and fail closed if cold resume has no directory. Track actual owned Query exit before confirming handoff.
  - Tests: catalog.list may omit the target; info still opens the correct cwd. Missing cwd never starts Query. Shutdown requires actual child exit.
- [x] Reuse a provider-neutral managed stdio directory for Copilot and Claude, retaining the existing connection control protocol and shared Codex exemption.
  - Tests: real loopback lease transfer, stale writer rejection, same native ID resume, overlapping open coalescing, close races and provider isolation.
- [x] Add agent-remote-controller claude resume <id> and --take-over using configured executable/profile and the common managed CLI lifecycle.
  - Tests: argument/profile/credential isolation and unexpected exit; actual SDK -> CLI -> SDK takeover while a request is running.
- [x] Exercise real Claude native tools/approvals/resume through ARDB and the shared mobile Session View; record all normalized variants and honest unsupported capabilities.
  - Tests: actual file diff, approved tool result, page reconnect without duplicate rows, cold resume, no horizontal overflow.
- [x] Run bounded provider/Host/Relay/client regressions, native suites, typecheck/build, compatibility:update and compatibility:check. Review changes and report remaining platform/native limitations.

## Deliberate boundaries

Do not map priority input to steering or promise safe waiting. Do not enable MCP forms that lose constraints or sensitive markers in the pinned runtime. Do not reconstruct lost callbacks from history. Do not expose effort writes without an authoritative native confirmation path. Directly launched unmanaged Claude processes are outside ARC's lease coordination; do not claim external lock detection absent a public native API.

## Acceptance and review notes

Implementation uses the pre-existing Claude SDK adapter, extends normalized projection and extracts Copilot's managed stdio lifecycle for both providers. No public wire variants were added.

- Real Claude 2.1.247 / SDK 0.3.247 tests: 96 passed, using isolated profiles and loopback Messages responses.
- Host regression: 394 passed, 8 platform skips; the legacy native Codex CLI process suite was excluded. Final shared directory cases: 22 passed, including in-flight resume/close races for both new and previously opened IDs. Leases are released by captured owner identity, never by a newer lease sharing the native ID.
- Copilot provider regression: 85 passed. ARDB units: 100 passed. Conformance: 17 passed. Relay connection control: 7 passed.
- Real running SDK → CLI → SDK transfer: 3 passed across Claude and Copilot. Mobile live Session View: 1 passed, covering approval reconnect, actual file diff, reload and width.
- Review caught unconfirmed startup release and permanently rejected close promises. Failed-start runtimes/leases now remain owned until verified cleanup, disposal is retryable/coalesced, and writes stop immediately on shutdown. No-PID spawn failure confirms no writer exists. Failed takeover can be explicitly recovered after the old process exits.
- Claude shutdown confirmation allows 10 seconds, covering the pinned SDK's approximately 7-second forced-exit sequence; expiry still refuses release. A generic failed-open cleanup hook only cleans a provider's own failed start, never an external Copilot writer.
- Native session rules were verified with a repeated ordinary command. Redirection/path checks may still re-prompt; do not promise blanket session approval.
- Cold native history omits structured patches; preserve result text without constructing fictitious diffs.
- Full build, typecheck and compatibility update/check pass. Actual Windows native behavior and online model-service behavior remain unverified.

These acceptance results were captured in the dedicated worktree before release. Controller 0.2.19 carries this integration; release delivery is verified separately.
