# Session succession implementation handoff

Updated: 2026-10-11. Worktree: `.worktrees/session-succession`.
Branch: `feat/session-succession`; inherited HEAD: `f0ff47377b18095263fe6efa5f2e051e45d88952`.
Merge base: `cc3f3599479fc578045c1828ee6d56c638b2c84b`.

The common/product implementation and prior OpenCode baseline passed their
frozen local gates. Codex, Claude Code and Copilot evidence implementations and
production source-registration corrections are cross-reviewed. Final workspace
gates for this provider expansion are complete. The current record is
[provider validation](2026-10-11-succession-provider-validation.md).
Earlier results remain in the [prior baseline report](2026-10-11-session-succession-validation.md)
and `.superpowers/sdd/2026-10-10-session-succession/`.
The changes remain uncommitted. No merge, push, publication, deployment,
installation into the user's environment or user-service restart has been
performed for this implementation pass.

## Approved model

A stable primary role retains its identity while `current` changes A -> B -> C.
One v2 composition document owns explicit view bindings; ordinary navigation and
succession use the existing Session View attachment path and connection owner.
Track/Ask refer to stable view/payload owners. Upgrade all components together,
import old browser metadata once, then use one live model. Do not reopen the
retired old/new reader matrix, dual-write layouts or native-owner inference.

Admission is idle-only, with no queued input, approval, active child work or
unsettled ARC mutation. Handoff gates ordinary ARC writes to source and candidate.
There is no wait-idle/drain loop or global lock on independent native clients.
Prepare/commit create no model turn; only the first real successor input receives
normalized history. Keep unknown candidate/input/operation identities; never
recreate or replay to obtain a convenient result.

Adapters interpret native facts. Host owns role/dispatch coordination. Relay owns
authorized durable projections. The product applies them through composition;
the shared Session View consumes ordinary state and actions.

## Implemented checkpoints

- **Client:** `CompositionDocument` v2 is the only live model. One checked importer
  handles old composition/Track/Ask metadata. Persistent owner pointers preserve
  image and preference data; layout, text and Ask open remain tab-local. A's view
  owner follows B while an independently opened B retains its own owner. Import
  and storage failures preserve original data and expose retry.
- **Native/Host:** one evidence-v2 contract with trusted-service or owned-runtime
  authority; exact empty identity and confirmed selections; separate input
  correlation, materialization and execution evidence; existing operation-cache
  admission plus durable coverage and latest recovery handles in the context store.
  Cold ordinary unknown coverage cannot be cleared from an idle snapshot. The
  production CLI enables enrollment using its saved installation identity.
- **Relay:** actual Cloudflare `RelayObject` installs the complete SQL codec and
  accounting-backed enrollment. Public replay, current-role resolution and
  Favorites application share the established durable authority.
- **Product:** primary Handoff describes Host eligibility, retains one operation,
  prepares/commits and applies authorized replay. Cancellation intention survives
  failed replies and reload. Hide/Recover retains uncertain operations even when
  the source is offline or retired; generic 409/404 cannot authorize replacement.
- **Source/TPM:** source queries resolve the stable role while historical cursors
  remain pinned. New sends resolve current; already admitted sends retain their
  original native recipient. Late native acceptance reaches the same live TPM
  intent through ordinary and prepared first-input paths. Auxiliary sessions are
  not recreated during handoff.

## Native scope

At this prior validation baseline, Codex, Claude Code, Copilot and OpenCode
implemented native evidence v2. Admission required the complete source/target
contract on the same Host/canonical cwd; provider names alone did not enable a
pair. The OpenCode result applied to its reviewed 1.18.x configuration and
callback-plugin requirement for source references. It does not establish current
2.x Handoff support: OpenCode 2.x reports that capability as unavailable. See the
[current supported configuration](../current/agent-remote/session-succession-recovery.md#supported-configuration-and-product-entry).

`inputId` is adapter correlation; `nativeInputId` identifies the proven native
user record; `nativeExecutionId` positively establishes execution start. These
facts never imply task completion or cross-restart deduplication. Claude/Copilot
empty descriptors require explicit permission to initialize the same identity;
Host saves the latest confirmed recovery handle separately from original creation
evidence. The existing native observation is reused.

Real adapter validation used Codex 0.162.0, Claude SDK 0.3.247/native 2.1.247 and
Copilot SDK 1.0.11/native 1.0.83 with isolated profiles and loopback models.
The Host matrix passed 16/16 real-WebSocket cases with controlled native sessions;
it is separate from real-provider validation. Exact results and cold-correlation
limits are in the current provider report.

## Prior OpenCode/common baseline evidence

Evidence below lives under `.superpowers/sdd/2026-10-10-session-succession/`.

| Boundary | Evidence and result |
| --- | --- |
| Composition | `task-5-g2g3-validation/composition-v2-owner-final-review.md`: Spec/Quality PASS; focused storage and browser regressions retained |
| Native/Host | `task-current-native-final-review.md`: Spec/Quality PASS for 35 frozen files; actual adapter and callback evidence assessed |
| Product UI | `task-product-ui-fix1-review.md`: Spec/Quality PASS; sticky cancellation and Hide/Recover findings resolved |
| Cloudflare production entry | `task-cloudflare-activation-review.md`: PASS; affected 121 tests with actual Worker HTTP/WS and cold SQL reopen |
| Joined product | `task-5-g2g3-root-validation/final-browser-joined-2.json`: desktop 3 + mobile 3 PASS, zero skip, repeated after the final Host shutdown correction; real Host/Gateway/browser with controlled fake native evidence |
| Native adapter | `task-native-current-validation/actual-native-production-entry-1`: PASS; real OpenCode, built adapter, 3 creates / 3 prompts / 3 model calls; empty B/C and exact resume |
| Native callbacks | `task-native-current-validation/actual-native-callbacks-3`: PASS; 3 callbacks, provider-owner reconstruction, empty B, prepared first input and unbound denial |
| Whole-branch review | `task-final-whole-branch-review.md`: PASS; TPM acceptance finding corrected, 181 Host tests and independent diagnostic passed |
| Final shutdown correction | `task-host-test-fixtures/independent-review.md`: PASS; bounded drain and permanent evidence retirement preserve unresolved outcomes |
| Full workspace | `task-5-g2g3-root-validation/final-unit-5.json`: 5,518 passed / 29 skipped; build, typecheck and compatibility checks also passed |
| Independent Controller package | `task-5-g2g3-root-validation/final-controller-package-smoke-1.json`: 3 passed / 0 skipped; temporary installation, paired daemon and lifecycle cleanup |

The native runs use isolated profiles and a loopback model. The joined product
uses a fake provider. These are separate layers, not one native full-stack run or
commercial-model acceptance. Owned native/browser services have been cleaned up.
These prior frozen results are recorded in the
[baseline validation report](2026-10-11-session-succession-validation.md); failed
attempts remain preserved. They do not certify the later provider expansion.

## Completion and release rules

Provider evidence, production source integration and cross-review are complete.
Final gates passed: full workspace 5,616 tests with 35 skips; browser 23 tests with
five desktop-only mobile skips; isolated Controller package three tests. Build,
typecheck and compatibility also passed. Exact source identities, native evidence,
results and artifact are in the current provider report. Prior source freezes
remain baseline evidence only.

A separately authorized release must upgrade Controller, Relay and website
together. Preserve the complete recovery set described in
[Session succession state and recovery](../current/agent-remote/session-succession-recovery.md).
Package creation or local Worker acceptance is not publication or installation.
After native commit, recovery proceeds forward; restoring an old role file cannot
roll back native effects. Do not stop or replace active user services for testing.
