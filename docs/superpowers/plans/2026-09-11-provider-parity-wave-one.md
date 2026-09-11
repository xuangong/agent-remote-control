# Provider Parity Wave One Implementation Plan

> **For agentic workers:** Use test-driven development and dispatch independent Provider tasks with superpowers:dispatching-parallel-agents. Integrate and review each task before claiming support.

**Goal:** Deliver G1/G5 for Claude and G13/G15/G16 for DSH, and characterize G3 against the pinned native client before enabling it. Directly supported Wave 2 subsets G8/G9/G14 may follow the same admission gates.

**Architecture:** Native APIs remain in adapters. Existing settings, planning approvals, steering, compaction and child-session rails carry the new behavior. Root and observer ownership remain separate.

**Tech Stack:** TypeScript, pnpm, Vitest, Claude Agent SDK 0.3.247, DSH 0.1.2-rc.1, Remote 1.4.0 and Host uplink 2.

**Spec:** ../../current/agent-remote/provider-gap-analysis.md

## Global Constraints

- Work in `.worktrees/claude-provider`; preserve running services and untracked material.
- No synthetic queue, approval-scope widening, independent runtime for native children, or source-path dependency.
- Advertise only implemented native semantics; saved and read-only child capabilities remain distinct.
- Per-test and outer deadlines for every test run; pinned CLI for native-process tests.
- Update support evidence and compatibility metadata after implementation; no push or merge.

## Task 1: Claude controls

Files: `packages/agent-provider-claude/src/session.ts`, `interactions.ts`, new focused settings/input helpers and tests; `packages/agent-host/src/claude-directory.ts` if native models need a directory mapping.

- [x] Add failing behavior tests for confirmed model/permissions, planning-mode restoration, exact plan approval/feedback and active-turn steer races.
- [x] Implement native `setModel`, `setPermissionMode` and discovered model choices using existing setting descriptors; retain idle-only mutation and no hot effort update.
- [x] Map `ExitPlanMode` with actual plan body to typed review; perform the explicitly selected/resumed native permission transition before resolving the callback.
- [x] Probe steer against the captured active Query/turn. Verify consumption, queued cancellation and terminal identity with pinned native CLI. Result: equivalence failed; `priority: next` may execute after the original result and survive public interrupt. Keep steer/queue disabled.
- [x] Run adapter tests/typecheck under deadlines and report exact scope/evidence.

## Task 2: DSH effort and compaction

Files: `packages/agent-provider-dsh/src/session-settings.ts`, `projector.ts`, related tests.

- [x] Add failing tests for model-specific effort choices/selection, stale choices and compaction history/live start/end/failure.
- [x] Map native reasoning metadata through `selectModel`; retain session-and-default scope and confirmed selection.
- [x] Normalize native compaction IDs/start/end without changing historical text.
- [x] Run relevant adapter tests/typecheck under deadlines.

## Task 3: DSH read-only children

Files: `packages/agent-remote-dsh/src/session-directory.ts`, focused child directory/view module and tests; `packages/agent-provider-dsh/src/runtime.ts` or live-session only if native observation requires it; plugin uplink child attach routing.

- [x] Trace existing directory, uplink and native session observation APIs.
- [x] Add failing parent ownership/direct-child, independent history, read-only and disposal tests; include a real-transport child attach test.
- [x] Discover native direct children with service-gated descriptors. Open live borrowed views or saved non-activating history views without creating native roots.
- [x] Carry children through existing uplink/catalog attach and Relay projections; reject cross-parent and unavailable native history.
- [x] Run plugin/adapter/transport tests and verify closing a view preserves parent/native work.

## Task 4: Integration and support record

- [x] Review combined changes and run build/typecheck, root tests/conformance plus affected browser routes under root deadlines. See the native parity record for the corrected Lab rerun and exact counts.
- [x] Exercise real Claude process controls with loopback fixtures and DSH native/service boundaries; distinguish fixtures from deployed validation.
- [x] Update baseline, audits and gap dispositions with actual new support and remaining limitations.
- [x] Run `pnpm compatibility:update`, `pnpm compatibility:check`, `git diff --check`; locally commit reviewed changes.

Wave two and research-gated work retain their own admission conditions in the gap ledger. A failed native equivalence probe must be recorded and resolved before enabling a capability.


## Native follow-on subsets

- [x] G6 public callback characterization: ordinary forms work, but upstream schema/sensitivity loss prevents equivalent Remote support. Keep form/external action disabled and remove unused form code.
- [x] G8 native structured results, per-turn main-loop tokens, Query cumulative cost increments and exact native context metadata; include real CLI probes.
- [x] G9 root-owned embedded raster image references with bounded immutable bytes; verify real native Read and persisted-history resume, and keep binary bytes out of Timeline JSON.
- [x] G14 native cancel-only for live continuable children. Verify synchronous lifecycle/authority, parent-offline state, parked input preservation and native terminal events. Do not advertise send/steer/queue from FIFO prompt semantics.

The baseline and native parity record name the remaining research and client-surface gaps individually. A failed native-equivalence probe is a completed investigation, not a supported feature.
