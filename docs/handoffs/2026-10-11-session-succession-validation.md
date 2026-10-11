# Session succession validation: prior OpenCode/common baseline

Date: 2026-10-11. Branch: `feat/session-succession`.
Review base: `cc3f3599479fc578045c1828ee6d56c638b2c84b`.
Inherited HEAD: `f0ff47377b18095263fe6efa5f2e051e45d88952`, plus the
reviewed, uncommitted implementation at this prior source freeze. Its local
verification was complete; release remained a separate operation.

This report preserves the original OpenCode/common baseline. Subsequent Codex,
Claude Code, Copilot and shared-contract changes are tracked in the
[current provider validation](2026-10-11-succession-provider-validation.md), whose
final workspace gates are now complete. None of the old gate results or artifact
hashes below should be attributed to that newer source.

## Delivered behavior

A stable primary role changes its current native session from A to B to C.
The product applies the authorized revision through its existing Session View
attachment path. One composition document retains explicit view and payload
owners, so Track, Side, Ask, draft images and display preferences follow the
intended view without merging independently opened views or tab-local layout.

Handoff is available only with authoritative idle state and no queued input,
approval, active child work or unsettled ARC mutation. Preparation gates ordinary
ARC writes to the source and candidate. Preparation and commitment send no model
input. The first real input to the successor receives the captured normalized
history; subsequent input is ordinary input. Unknown outcomes retain the exact
candidate, input and operation rather than creating or sending again.

The primary Session View exposes Handoff, cancellation and Hide/Recover. Lost
responses and reload retain the original operation. A retained cancellation
prevents a late ready result from committing; an authoritative commit is applied
through normal replay. Source queries and newly admitted TPM sends resolve the
current role; already admitted sends retain their original recipient.

## Native scope at this prior freeze

The supported path at this freeze was OpenCode to OpenCode on the same Host and canonical
working directory. It requires the reviewed OpenCode 1.18.x configuration from
1.18.18, disabled background subagents, supported current selections, connected
observation and the explicit ARC callback plugin for source references.
This freeze did not certify Codex, Claude Code, Copilot or cross-provider
succession; their later implementation and evidence are in the current report.

Exact user message U establishes materialization; its exact non-summary assistant
child R establishes that execution started. HTTP 204, later idle state and an
unrelated response do not establish execution. This is not a process ownership
lock or a claim of deduplication across native restarts.

## Verification layers

| Layer | Verified result | What it establishes |
| --- | --- | --- |
| Composition and product review | Scoped specification and quality reviews passed | One live composition model, checked import, stable payload owners, cancellation and recovery |
| Production Cloudflare entry | 121 affected tests passed | Actual Worker HTTP/WebSocket paths, SQL codec, authorization, Favorites, cold persistence and replay using a controlled Host peer |
| Existing browser consumers | 17 passed; 5 desktop-only cases skipped on mobile | Owner recovery, storage failures, history, independent tabs, Side/Ask, image hydration and attachment retry |
| Joined product, repeated after final Host correction | 6 passed; no skips | Desktop and mobile real Host/Gateway/App paths, A to B to C, first input, two clients, stale A writes, cancellation and restart after lost commit responses |
| Real OpenCode adapter | Passed; 3 creates, 3 prompts, 3 model calls | Built adapter with isolated native process, empty candidates, exact input identity and resume evidence |
| Real OpenCode callbacks | Passed; 3 callbacks | Callback-enabled source access, provider-owner reconstruction, empty successor, prepared first input and unbound denial |

Native runs used OpenCode 1.18.18 on macOS arm64, SDK 1.18.31, isolated profiles
and a deterministic loopback model. The executable SHA-256 was
`4f5979c2dadb06fbff1335335afaaea274e58f92e79aa43cf2ed98618d555422`.
The browser fixture uses a controlled native provider. These are separate
verification layers, not a single native-to-production-browser run or an external
commercial-model test. No Windows or Linux native certification is claimed.

## Findings resolved during final verification

The root recursive runner appended a second scalar hook timeout to packages
that already specified one. Removing that duplicate retained package test/hook
deadlines and the root 540-second process watchdog; it did not exclude tests.

Claude native tests initially selected PATH version 2.1.128 instead of the
installed SDK's 2.1.247. Selecting the bundled executable exposed an independent
test-fixture issue: an auxiliary title request consumed the scripted task reply
and its fixed token usage. The fixture now handles that narrow auxiliary request
separately. Production source and original assertions were unchanged; its focused
validation passed 22 tests with 2 dedicated native experiments intentionally off.

The whole-branch review also found a missing TPM consumer of asynchronous native
acceptance. The correction covers ordinary and prepared first-input dispatch,
preserving the same intent and recipient. Its five affected Host suites passed
181 tests, including queued and user-message-only blocking, late execution proof,
lost acknowledgements, duplicate callbacks, and coordinator replacement. Callback
data is process-local and does not enter public operation parameters or storage.

A subsequent recursive run passed Claude's complete 145-test suite but failed
while deleting a Codex settings fixture directory. A process probe showed that
Codex 0.162.1's unrelated plugin synchronization could leave Git descendants
writing after the owned app-server exited. Both settings fixture configurations
now disable plugins. All four original scenarios and four isolation diagnostics
passed, with original assertions and teardown unchanged. No production process
management behavior was modified.

Further recursive coverage exposed stale test assumptions. Planning acknowledgement
and native-owner fencing now wait for their actual dispatch boundaries rather
than a guessed microtask or fixed delay, and always release their test gates.
Copilot safe-release checks the native assistant reply and turn end instead of
searching cursor-addressed terminal bytes. The mobile Host reconnect fixture uses
the shared contenteditable editor. These corrections retain the original effect,
ownership, acknowledgement and send assertions.

Host setting tests now reflect automatic target retention on first Host admission.
A generic target in the same cache still expires normally, while unresolved Host
settings retain their original operation and prevent handoff past receipt TTL.
Exact retries do not admit or dispatch again; later authoritative settlement
releases the mutation. Private store tests retain migration and admission checks
against the current version 7 format.

Fault injection also reproduced a production shutdown defect. A coverage-cleanup
write could outlive Host close; disposing the operation cache first could make a
late cleanup mistake another unresolved operation for completed work. Shutdown
now closes write admission and drains existing coverage reconciliation before
disposing the cache. Cleanup still has its existing time bound. When that bound
expires, the old boundary permanently loses authority to certify coverage, so a
late callback cannot clear an unknown outcome by observing an emptied cache.
Publication failures remain failures and native cleanup still runs. An operation
that settles only after shutdown unsubscribes may conservatively retain a dirty
marker after restart; this does not add automatic recovery or replay.

The remaining-package run also caught verification-environment errors: concurrent
test-fixture edits invalidated the compatibility digest before Lab startup, and
the native Codex Host test had no explicitly selected executable. Final validation
must freeze source before metadata generation and use the installed standalone
Codex 0.162.0 required by the Lab manifest. These errors do not justify bypassing
the compatibility validator or excluding that native test.

## Completed gates for the prior OpenCode/common baseline

The final build and typecheck passed after the shutdown correction. The build ran
`compatibility:update`; the subsequent check passed with implementation digest
`sha256:d0ab6aa589789fe8747b64b9874855d4364bfedb66c59daaf3fd1737f066f0b1`.
The final recursive suite passed 5,518 tests with 29 skipped across 566 passing
test files and 8 skipped files (340.262 seconds, exit 0). This includes the
Controller's 1,057 tests, Lab's 1,304 tests, Cloudflare's 191 tests and the existing
conformance files. No package was excluded to obtain the result.

The shutdown-correction joined-browser repeat passed all six desktop/mobile
cases with no skips (16.241 seconds, exit 0). The unchanged consumer suite's
17 passing cases and 5 desktop-only mobile skips remain separate coverage.
The independent Controller package smoke passed all three tests with no skips
(173.183 seconds, exit 0). It installed the exact tarball into a fresh prefix
outside the repository using an isolated HOME and Tencent npm cache. It exercised
the launcher, callback plugin packaging, pairing, management authorization,
reconnect and login-service recovery. The test's processes, hashed launchd jobs
and plists were absent after teardown; its temporary HOME/cache was then removed.

The final recursive test command selects the SDK-bundled Claude 2.1.247 executable,
the installed standalone Codex 0.162.0 required by the Lab fixture, and
sets `npm_config_workspace_concurrency=1`. This limits simultaneous workspace
native startups without changing test assertions or native request timeouts.

The artifact is
`.superpowers/sdd/2026-10-10-session-succession/task-controller-package-final-1/orchardworks-agent-remote-controller-0.2.42.tgz`
(625,166 bytes), SHA-256
`cd82e9d91766b349a7efe4b29ce8020185836625fc68565077aa3f8b856c87b0`.
Its build metadata records the inherited HEAD above and `dirty: true`; it is an
isolated validation artifact, not a published release or a remote-update offer.
The compatibility check passed again after packaging. `git diff --check` passed.

Final run labels in the local evidence directory are `final-build-4`,
`final-typecheck-3`, `final-unit-5`, `final-browser-consumer-1`,
`final-browser-joined-2`, `final-controller-package-build-1`,
`final-controller-package-smoke-1` and `final-compatibility-4`. Each run retains
its exact command, deadline, exit code and complete log hash. The final source
freeze binds these results to the reviewed implementation and current documents.

## Recovery and release boundaries

Only live invocation evidence can notify its TPM outbox. A cold restart that
retains an accepted input without execution evidence remains unresolved and may
prevent further handoff. Neither idle state nor a new input can unlock it. This
implementation does not add a receipt ledger, automatic replay or a guarantee
that every uncertain operation can be reconciled.

Controller, Relay and website require a coordinated upgrade. Existing browser
metadata is imported once into the single v2 model. Preserve the complete state
set in [the recovery guide](../current/agent-remote/session-succession-recovery.md).
Testing uses isolated prefixes, state directories and ports; it does not replace
the installed Controller or restart user services. This validation pass does not
authorize or perform commit, merge, push, publication, deployment or installation.

Detailed command metadata, full successful and failed logs, review diagnostics
and source freezes are retained locally under
`.superpowers/sdd/2026-10-10-session-succession/`. This document records the usable
outcomes independently of that ignored evidence directory.
