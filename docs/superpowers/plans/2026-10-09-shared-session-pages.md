# Shared Session Pages Implementation Plan

**Goal:** Allow authorized browser and headless clients to operate the same Host-owned native session without transferring control between clients.

**Architecture:** The Host retains one native session and observation stream. The common session registry grants an independent proof to each authorized connection, while a native-owner transition revokes every proof for that session. Provider transport and process ownership do not select a browser writer policy.

**Approved scope:** The user approved shared operation within one Host. Independent native CLI ownership remains an explicit implementation-side handoff. Cross-site Host federation is out of scope.

## Constraints

- Preserve protocol 1.6 wire compatibility and decoding of older recordings.
- Keep mutation authorization, operation settlement, interaction claims, and native admission checks.
- Keep native ownership and process termination in existing implementation extensions.
- Preserve observe-only and activity-only clients, replay, and unsupported provider operations.
- Do not publish, deploy, or restart the user's services for this implementation.
- Run tests with Node 22, per-test deadlines, and an outer process deadline.

## Implementation

- [x] Replace mutually exclusive page ownership and disconnect grace with connection-local grants in `session-control.ts`.
  - Both legacy request actions authorize only the requesting connection.
  - Tokens cannot be borrowed by another connection or reused after close.
  - A native-owner transition invalidates all connection grants and notifies all listeners.
  - Releasing the native owner allows each page to acquire a fresh grant independently.
- [x] Route every full session stream through this registry in `session-wire.ts`; keep activity streams read-only.
- [x] Publish shared client access from `AgentManager.effectiveCapabilities`; retain the legacy capability only for compatibility and remove adapter writer-policy declarations.
- [x] Keep client automatic access acquisition and native handoff handling. Rename the initial progress message to `Checking access` and retain compatibility with older Controllers.
- [x] Update the current protocol/provider documentation; do not rewrite historical design records.

## Verification

- [x] First demonstrate failure of regressions for independent grants and legacy adapter flags.
- [x] Exercise two real WebSocket clients sending to one session, sharing results, reconnecting, and closing independently.
- [x] Confirm another page's access request cannot invalidate a queued operation.
- [x] Confirm native ownership changes reject queued/prepared mutations before dispatch and invalidate old proofs after release.
- [x] Confirm concurrent answers to one interaction settle once and both clients observe the result.
- [x] Confirm Host attachment is reused and native observation/disposal is not multiplied by page count.
- [x] Cover Web/ARDB shared access and initial access UI, including read-only observers and native CLI conflicts.
- [x] Run affected package regressions, typecheck, build, `pnpm compatibility:update`, and `pnpm compatibility:check`.
- [x] Independently review the diff and resolve confirmed findings before reporting completion.


## Validation results

Validated on 2026-10-09 with Node 22.23.2 in the dedicated worktree. Every test run had per-test/hook deadlines and an outer process deadline.

- Regression failures were confirmed against the old implementation: the second page could not acquire access in registry, Host uplink, and client transport tests.
- Relay: all 326 tests passed; Protocol: all 207 tests passed; Web: all 588 tests passed.
- Host attachment and operation tests: all 84 tests in `host.test.ts` passed.
- Provider and capability-focused verification: 161 tests passed across Manager, Codex, OpenCode, Host directory, and Protocol tests. Some overlap the full package totals above.
- Lab: 50 component tests, four real transport cases, five foreground-recovery cases, and one native CLI handoff case passed.
- ARDB: one Chromium mobile-viewport test passed with the real Copilot SDK/CLI connected to an isolated local model fixture. It covered shared output, independent drafts, reload, and sending after the other page closes. This was not a physical iPhone test.
- Full workspace typecheck and build passed. `pnpm build` ran `pnpm compatibility:update`; `pnpm compatibility:check` passed with digest `sha256:6372be426c5709c59e9fdb488da01761f1c236b6edcbc656f9f120bb410bb591`.
- Independent code review found no blocking issues. Remaining legacy control fields and UI fallbacks support older Controllers; they do not allocate a page owner in the updated implementation.

No production deployment, package publication, or running Controller/native daemon update was performed. Host-side behavior takes effect when the Controller containing these changes is installed.
