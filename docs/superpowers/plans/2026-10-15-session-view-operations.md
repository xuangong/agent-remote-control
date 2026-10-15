# Standard Session View Operations Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement scoped tasks, with root integration and independent review.

**Goal:** Make send completion and prompt editing consistent across every live standard Session View.

**Architecture:** Shared Session View operations consume exact session identity and confirmed admission. Provider adapters own native edit boundaries. A durable Host replacement transaction preserves role/tool bindings and coordinates Relay association publication before clients follow the replacement.

**Tech Stack:** TypeScript, React, Vitest, Playwright, native Provider adapters, HTTP/WebSocket Relay.

**Spec:** `docs/superpowers/specs/2026-10-15-session-view-operations.md`

## Global Constraints

- Work only in `.worktrees/session-view-rewind`; preserve existing services and sessions.
- Keep Provider SDK, adapters, public Remote protocol, Relay authority, Host ownership, and rendering separate.
- Do not introduce account or Borgee dependencies into standalone Session View or ARDB.
- Do not merge, push, publish, or deploy without a further user request.
- Use observable tests, including real transports for operation/reconnect behavior, with per-test and outer deadlines.
- Update compatibility metadata after implementation review and verify it.

## Task 1: Confirmed-send draft ownership

Files: `packages/agent-remote-web/src/react/useSessionView.ts`, `packages/agent-remote-lab/src/components/SessionFamily.tsx`, `SideConversation.tsx`, relevant composer and mounted-view tests.

- [x] Reproduce a mounted explicit-owner view sending text and receiving the matching ACK while retaining its draft.
- [x] Supply a lifecycle-scoped exact recipient from the standard session consumer to the composer. Preserve explicitly supplied succession recipients.
- [x] Assert the composer and persisted store clear only the submitted revision after ACK. Reject and delayed-ACK cases retain text; a changed draft or recipient is never cleared by the older send.
- [x] Exercise Team's managed window path separately; verify whether the reported symptom is confirmed ACK or unresolved admission.
- [x] Run focused suites and review the complete task diff.

```ts
expect(editor.textContent).toBe('submitted');
receiveMatchingAcknowledgement();
await waitFor(() => expect(editor.textContent).toBe(''));
expect(draftStore.get(owner.key)).toBe('');
```

## Task 2: Native prompt-edit adapter contract

Files: SDK `provider.ts`, `native-evidence.ts`, exports; Codex/OpenCode provider, session, prompt-edit and evidence files and focused tests.

- [x] Pass `AgentSessionExtensions` into first fork/start attachment and preserve tool callbacks and instructions.
- [x] Add read-only `verifyPromptEditBranch(target, handle)` verifying the complete selected native prefix and exact identity/workspace, without input or another fork.
- [x] Add independent optional `AgentPromptEditEvidence` readiness/validity capability; OpenCode generic succession evidence remains unchanged.
- [x] Test first/later prompts, source suffixes, invalid candidate input, first attachment tools, readiness/validity invalidation, and no native input/source mutation.

## Task 3: Durable native-prefix Host preparation

Files: protocol succession request; Host coordinator, store, service, local preparation, boundary, directories, and host integration.

- [x] Extend the existing request with optional native-prefix selection and include it in immutable identity; preserve generic request bytes.
- [x] Reuse reservation/create-started/candidate-known/ready/commit stages; save exact bounded persistence handle and restore it without empty initialization.
- [x] Use mode-specific readiness and prefix verification; never capture, bind, or inject normalized context in this mode.
- [x] Preserve preparation-to-commit source observation and admission fences; changed source activity cannot silently become committable.
- [x] Test one fork, recovery at effect boundaries, exact handle restoration, no context access, candidate readback and source change rejection.

## Task 4: Relay transaction and stable execution routing

Files: protocol succession/uplink contracts; Host enrollment/store/admission; Hosted broker/association/state/projection; Controller negotiation; Cloudflare persistence.

- [x] Add v3 bounded enrollment for native-prefix operations and explicit storage migrations, preserving old state bytes and recovery.
- [x] Add a pure validated native-prefix resolver shared by Host and Relay; generic succession cannot silently transfer execution roles.
- [x] Keep a committed enrolled candidate fenced until Relay durable publication and release; local commits release normally.
- [x] Test old snapshots, immutable receipts, duplicate commit, lost responses, projection gaps, and no role transfer across generic edges.

## Task 5: Ask and Side stable reader bindings

Files: Host directories/source-binding/reference lookup; Hosted relation projection and relation mutation entry points.

- [x] Keep grants and relation participants at their original anchors; resolve current descendant from committed prefix lineage.
- [x] Rebuild source-reader extensions before attachment and use the original signed reader identity; old cursors remain pinned.
- [x] Normalize descendant relation operations to the original binding, then remove the old Ask/Side prompt-edit rejection.
- [x] Test multiple edits/restart, unchanged grants/participants, current-reader authorization, stale tools, and pinned cursors.

## Task 6: Team and TPM role continuity

Files: Host Team/resources/TPM/store/host; public Team receipt schemas; Hosted Team delivery/projection; Cloudflare validation.

- [x] Keep seats/work as stable anchors, bind tools to actual recipient and current authority, and refresh leases when the resolved native session changes.
- [x] Pin delivery receipts to actual recipients and place claim/dispatch persistence inside existing admitted execution.
- [x] Block rewind for dispatching/unknown or accepted-but-not-started inputs; never retarget historical receipts.
- [x] Test leader/member/TPM continuity, stale tools, resource chunk fencing, both claim/freeze race orders, queue deferral, and restart.

## Task 7: Standalone local entry points

Files: ARDB server/replay-server/owned-adapter; local Lab session-directory; shared local Host service seam only if required.

- [x] Reuse durable local succession with configurable persistent state, no account/Hosted/Borgee dependency.
- [x] Commit and recover the exact owned live locator and handle, keeping authorization/recording association consistent.
- [x] Preserve original history, cancellation behavior, and read-only replay.
- [x] Test HTTP/WebSocket routing and restart using configurable free ports.

## Task 8: Shared prompt-edit operation and view following

Files: Session View operations; App, family/window, Ask, Side, Team/TPM compositions, ARDB Live.

- [x] Expose one capability-aware edit operation in all eligible standard placements using each view's exact client/session/draft owner.
- [x] Prepare and commit via succession once; only then follow the durable locator and restore selected text/images without sending.
- [x] Preserve unrelated drafts and concurrent edits; failure/unknown leaves a recoverable original.
- [x] Use advertised native support rather than Codex-only conditions, with truthful unsupported reasons.
- [x] Test every wrapper, repeated edits, refresh/reconnect, and original session history.

## Task 9: Integration and delivery evidence

- [x] Run real HTTP/WebSocket operation and recovery tests, mounted-view suites, and isolated browser scenarios.
- [x] Run affected typechecks/builds; independently review complete branch and address verified findings.
- [x] Run `pnpm compatibility:update` followed by `pnpm compatibility:check` after review.
- [x] Report exact coverage and native-runtime limits; do not claim push, merge, or deployment.


## Task 10: Supplemental merge-readiness corrections

Authorized by the user's explicit instruction to modify after the supplemental review. BASE: `f667eb348dcb553924b1a7a75ee82d4abf774a96`. Worktree: `/Volumes/Projects/agent-remote-control/.worktrees/session-view-rewind`.

Read these scoped findings and evidence before implementation: `.superpowers/sdd/2026-10-15-session-view-operations/merge-readiness-review.md`, `merge-readiness-native-review.md` in the same directory, and `merge-compatibility-probe.mjs`. The exact old schema is extracted under `merge-legacy-schema/`. The native report contains a runnable HTTP fixture probe. Do not reread or redo Tasks 1-9.

- [x] R1/P1: Explicitly negotiate the recipient-aware Team contract. New Controller versus old Relay and old Controller versus new Relay must keep management registration, heartbeat and update reachable. Unacknowledged peers must receive legacy-safe shapes or only the unsupported Team operation must fail with an actionable upgrade requirement. Cover ordinary claims/polling, not only native-prefix enrollment.
- [x] Persist exact recipients and unresolved delivery evidence. Legacy projections must never authorize unsafe successor dispatch or role replacement. Do not merely strip fields and keep the unsafe operation enabled. Include legacy unresolved receipts, actual mixed-version WebSocket/HTTP transports in both directions, and current/current behavior. Consider cached legacy browsers and persisted state compatibility at the same public boundary.
- [x] R2/P2: Retain an exact bounded usable candidate outcome/handle as soon as native creation returns it, before fallible prefix readback, tools or observation setup. Reuse the existing candidate-known persistence/recovery path. Keep input and commit fenced until all validation succeeds; retry verification of the same candidate, never re-fork.
- [x] Add OpenCode actual-provider-to-Host coverage of first/later fork followed by transient read failure, same-candidate read-only recovery, and restart. Audit the analogous Codex bootstrap window; distinguish source audit from reproduced defect and cover changed paths if corrected.
- [x] Preserve RED evidence, then focused GREEN tests with per-test/hook timeouts and outer deadlines. Use real local transports and deterministic fixtures, never real native fork/input. Preserve existing services, sessions and user documents. Use filtered builds/typechecks only; root build regenerates compatibility too early.
- [x] Self-review and commit only scoped product/test/docs changes locally, writing the full report and logs to `.superpowers/sdd/2026-10-15-session-view-operations/task-10-report.md`. Do not commit the preexisting untracked plan/spec or ignored evidence. Report exact commands/output and remaining limits. No push, merge, publish or deployment.
- [x] Independent scoped review of the fix diff, then root compatibility update/check and one workspace typecheck. Compatibility source digest is not runtime negotiation. Root records current merge readiness with native acceptance limits retained.

Implementation uses one agent, no subagents or delegated reviewers. Root owns independent review and final compatibility regeneration. Use `node .superpowers/sdd/2026-10-15-session-view-operations/run-deadline.mjs <milliseconds> <command> ...` for outer deadlines. For mounted Node 26 tests use `env -u NO_COLOR -u FORCE_COLOR NODE_OPTIONS=--no-experimental-webstorage` when applicable. Questions about architecture go to root while continuing independent work. This task authorizes small necessary contract changes within existing boundaries, not a new recovery subsystem or unrelated broad refactoring.
