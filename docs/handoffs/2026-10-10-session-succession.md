# Session succession implementation handoff

Date: 2026-10-10. Audience: the next implementation session or maintainer.
Status: partially implemented; no usable end-to-end handoff yet.

## Start here

The implementation belongs to **Agent Remote Control**, not Copilot API Gateway.
An inherited shell may start in the gateway repository; set the working directory
explicitly before running commands.

- Repository: `/Volumes/Projects/agent-remote-control`
- Worktree: `/Volumes/Projects/agent-remote-control/.worktrees/session-succession`
- Branch: `feat/session-succession`
- Implementation base: `cc3f359`
- Latest design checkpoint before this document: `3b5dcd6`
- [Approved design](../superpowers/specs/2026-10-10-session-succession-design.md)
- [Implementation checklist](../superpowers/plans/2026-10-10-session-succession.md)

Read this document first, then the design and Task 3 in the checklist. Check live
Git status before editing. The latest user decision supersedes the earlier
Codex-native-fork-first direction: use **project-owned normalized history with
Host-owned deferred first-input injection**. Do not resume native-fork wiring as
the generic handoff implementation.

This work has not been merged, pushed, published or deployed. The feature must
remain unadvertised until the complete contract is wired and verified. This
handoff does not authorize deployment or replacement of a running user Host.

## Prompt for the receiving session

Copy this instruction into the next session (or provide this document's absolute
path and ask it to continue):

> Continue the Session Succession implementation in
> `/Volumes/Projects/agent-remote-control/.worktrees/session-succession` on
> `feat/session-succession`. Read this handoff, the linked design, the implementation
> checklist and applicable AGENTS.md files. Inspect live Git status and preserve
> unrelated work. The approved path is project-owned normalized history with
> Host-owned deferred first-input injection, with same-Host/cwd provider switching
> gated by capabilities. Do not resume native-fork-first preparation. Start with
> Task 3's pending-context storage and unified first-input dispatch contract, then
> complete source reads/provider routing, TPM, product projection and acceptance.
> Mark each checklist item only after verification and keep unknown delivery
> visible without automatic replay. Continue implementation without repeating
> already settled design questions. Do not merge, push, publish, deploy or replace
> user services as part of this continuation. Report progress in Chinese.

The receiving session does not need the original conversation. This document
records the latest accepted direction, historical evidence and outstanding work.
If live code differs, reconcile that difference before editing rather than
assuming the checkpoint is still current.

## Background and intended outcome

The primary session performs the main work and delegates to supporting sessions.
The user wants a new session to inherit that primary role without rebuilding the
workspace UI or its relationships. This is stronger than opening a fork: all
ordinary user-facing references should follow the successor as one coherent
change.

Favourites, Track, the main pane, Side layout, Ask attachments and Task Progress
Manager (TPM) communication follow the new primary. Existing Side, Ask and TPM
identities, history, drafts, layouts and work state remain intact. An Ask attached
to a Side remains attached to that Side. Unlinked sessions are not enrolled.
The predecessor remains available for explicitly selected historical inspection.

The initial mode reuses the same Host machine and canonical working directory.
It transfers no files, processes, credentials, approvals or running children.
Changing agent/provider on that Host is part of the latest design direction,
subject to both adapters satisfying the required capabilities. It is not a claim
that current code already supports a particular provider pair.

Future cross-Host handoff would need workspace/environment migration and a policy
for Side, Ask and TPM placement and access. Preserve the preparation/commit/
projection boundaries; implement no migration service or distributed coordinator
in this iteration.

## Approved architecture

### Stable role and concrete executor

A Controller-owned `PrimaryRole` has a stable ID, monotonically increasing
revision, immutable origin and current executor. Every concrete address is a
`NativeSessionRef` containing Controller ID, provider ID and native session ID.
Workspace placement is separate from role identity.

New reads and admissions resolve the role's current executor. Existing history
cursors and already-admitted sends retain their actual destination. A native ID
alone is insufficient when switching providers, even on one machine.

Keep native interpretation in provider adapters, coordination and durable state
in Controller, authorized projection in Relay, and presentation in the product.
Use `SessionSuccession`; do not repurpose native ownership `SessionHandoff` or
prompt-edit `session_migrated`, which have different semantics.

### Prepare, commit, then deliver with the first real input

1. **Prepare:** reserve an operation, gate source mutation, establish authoritative
   quiescence, freeze relationships, capture bounded normalized history, create an
   idle candidate and durably store its pending context and supported settings.
2. **Commit:** revalidate readiness, source boundary and role/association revisions;
   atomically replace the current executor with its durable operation receipt.
3. **Project:** reconcile references idempotently across Relay and clients. Browser
   storage failure is recoverable projection failure, not reversal of the commit.
4. **First execution:** compose the pending context with the first admitted user,
   multi-device or TPM input at one Host dispatch boundary.

`ready` means the candidate and its context attachment are durably available.
It does **not** mean the model has read the history or that history is already
materialized in the native session. Preparation and commitment start no model
turn and send no synthetic acknowledgement or continuation message. An explicitly
requested continuation is an ordinary postcommit input.

Serialize competing first inputs. Persist input identity, actual recipient and
role revision before dispatch. A definite pre-dispatch rejection leaves context
pending. An accepted or uncertain dispatch cannot be automatically replayed or
retargeted; reconcile native evidence and block later inputs from bypassing the
unresolved delivery. Transport acceptance alone is not durable-history proof.
Execution-capable commands must join this boundary or be rejected while pending.

Ordinary `/fork` already delays its quoted history until the first input. Reuse
that representation and behavior, but move handoff ownership out of browser
storage. Host must cover all senders and survive browser loss and restart.
Normalized history is not full native state: tool output is shortened and hidden
provider state is not preserved. Bound bytes as well as entry count; do not claim
context reduction or automatic target-model fit.

### Why native fork is no longer the default

An earlier implementation experiment used Codex native fork because the shared
provider API cannot preload a message while guaranteeing no task execution.
The user subsequently approved deferred injection instead. No preparation model
turn is necessary, and project-owned context allows provider switching without
requiring compatible native-fork APIs.

The native-fork experiment remains in this branch and has useful isolated tests.
It is neither a prerequisite nor a silent fallback for generic handoff. Review
its public exposure before final integration; do not remove unrelated prompt-edit
fork behavior. A future optional native enhancement must not determine the
product's core role or relationship semantics.

## Implementation checkpoint

| Area | Present in code | Still missing or affected by the new decision |
| --- | --- | --- |
| Protocol and durable store | Full session refs, roles, revisioned operations, atomic role/receipt commit, participant revisions, restart-to-unknown behavior | Production provisioning; pending-context schema and crash consistency |
| Source binding | Dynamic role resolution, signed cursors, lineage checks, grant/relation enrollment, generation cache | Runtime installation; durable signing key; cross-provider routing; pending-context reads |
| Coordinator | Prepare/status/commit/cancel/reconcile logic and admission lookup with fixture tests | Actual Host mutation/dispatch wiring and transport endpoints |
| Local preparation | Readiness checks and create/transfer/verify ports | Remove same-provider restriction only with real target capability/routing support; replace native-fork assumptions |
| Codex native fork | Adapter/directory methods and isolated native test | Optional experiment only; not generic handoff certification |
| TPM | Existing scheduler/work/delivery system | Role-aware reads, subscriptions, leases and all dispatch paths |
| Relay and product | Existing favourites, Track, relations, Ask and composition | Succession projection, replacement/recovery logic and user entry point |

Tasks 1 and 2 were marked complete for their original isolated boundaries.
Task 2's existing implementation is **not complete for cross-provider succession**.
Task 3 is in progress; Tasks 4–6 remain open. Do not interpret checked primitives
as a working product capability.

Local commits, oldest to newest:

- `ba7bf34`: initial same-host succession plan.
- `12195b2`: future migration boundaries.
- `ac7f160`: durable primary role and succession records.
- `96121f9`: source references following primary succession.
- `b4e5459`: local preparation/coordinator and native candidate experiment.
- `3b5dcd6`: approved generic deferred-context design and follow-up checklist.

## Next priorities, in implementation order

### 1. Close the context storage and dispatch contract

This is the immediate priority, ahead of UI work or more native-fork adaptation.

- Extract shared normalized-history serialization from Lab without importing
  browser modules into Host. Preserve quoted-context and truncation semantics.
- Define versioned durable attachment and first-input delivery records with
  operation identity, capture boundary, byte limits and explicit unknown state.
  Decide how attachment persistence and role commit remain crash-consistent.
- Implement one serialized first-input composition/dispatch path. Audit messages,
  rich input, commands, TPM and stale/multiple clients for bypasses.
- Connect source/candidate admission to actual mutations and the last native
  dispatch boundary. An HTTP/Relay entry check alone cannot fence queued work.
- Verify creation itself does not start model/task work. Do not substitute a
  prompt, approval setting or read-only mode for this execution contract.

The store already bounds state at 8 MiB, 1,024 roles and 512 operations per role.
These are implementation limits, not a context retention design. Account for
large snapshots and receipts before embedding additional data in that file; do
not silently evict recovery evidence to make space.

### 2. Define reads before native context materialization

After A -> B commits but before B's first input, Ask/Side/TPM must not receive an
apparently empty source history. Expose the captured context with explicit
provenance and a stable cursor namespace. Reading must not execute the model.
Once materialized, do not show the attached history twice. Existing cursors must
retain the representation and source they originally pinned.

B -> C before B's first input must preserve the pending history without nested
prefixes or omission. Unknown B delivery must block another succession until
reconciled. The exact attachment-read API and representation transition still
need implementation design; they are requirements, not existing functionality.

### 3. Complete Controller wiring and capability-gated provider switching

Provision the store and persistent cursor signing key in the Controller's stable
state directory. Install binding readers for existing and newly discovered
providers. Implement real inspection, idle candidate creation and recovery/status
routes. Readiness must cover ownership, active turns, pending inputs/interactions,
children and a trustworthy history boundary; unknown does not mean idle.

Source-binding enrollment and readers currently assume one provider. Replace
those assumptions with full session refs and authorized directory resolution,
including old pinned cursors. Do not pass a successor's ID into the predecessor's
provider. Preserve access checks at each actual read. Resolve supported settings
semantically; do not copy opaque model/permission identifiers or broaden access.
Keep existing auxiliary sessions and their grants while updating role resolution.

### 4. Integrate every TPM work

Preserve work identity, plans, todos, pause and completion state. Include works
without an open page. New main reads, subscriptions, leases and dispatches follow
the role. Record actual destination and role revision in each admitted intent.
Only an intent never admitted to a native recipient may first resolve to B.
Accepted, queued, dispatching or unknown A operations never become B retries.
TPM's first B dispatch must consume context through the same boundary as user input.

### 5. Replace product references and finish acceptance

Implement a dedicated authenticated succession projection with revision replay.
Preserve favourite IDs/folders/order, Track order, pane layout, Ask identity,
preferences, geometry, drafts and outbox state. Handle duplicate successor entries
without losing independent drafts. Preserve nested Ask scope, exact historical
notification targets and existing sharing authorization.

Add the Session View action only after backend behavior is ready. Validate
A -> B -> C, provider switching, desktop/mobile, multiple devices, refresh,
disconnect, lost responses and partial storage failure. Unsupported provider
pairs fail before candidate creation; do not infer support from text-copy ability.
Update fixtures, compatibility metadata and the checklist with actual evidence.

## Source map

All paths below are relative to the worktree root.

| Concern | Entry points |
| --- | --- |
| Public identity/operation schema | `packages/agent-remote-protocol/src/session-succession.ts` |
| Durable state | `packages/agent-host/src/session-succession-store.ts` |
| Coordination/readiness | `packages/agent-host/src/session-succession.ts`, `local-succession-preparation.ts` |
| Source resolution/grants | `packages/agent-host/src/session-source-binding.ts`, `session-reference.ts` |
| Runtime and provider directories | `packages/agent-host/src/host.ts`, `directory.ts`, `opencode-directory.ts`, `execution-policy.ts` |
| Actual operation scheduling | `packages/agent-remote-relay/src/operation-settlement.ts`; inspect `lifecycle.admit`, `runOperation` and `beforeDispatch` |
| Existing context capture/delivery | `packages/agent-remote-lab/src/session-forks.ts`, `fork-actions.ts` |
| TPM | `packages/agent-host/src/tpm.ts`, `tpm-store.ts` |
| Relay relations and projections | `packages/agent-remote-hosted/src/broker.ts`, `session-relations.ts`; keep prompt-edit `session-migrations.ts` separate |
| Product references | `packages/agent-remote-lab/src/App.tsx`, `tracking-state.ts`, `session-composition.ts`, `hooks/useSessionTracking.tsx`, `hooks/useAskConversations.ts` |
| Optional native fork experiment | `packages/agent-provider-codex/src/session-fork.ts`, `session.ts`, `provider.ts` and fork tests |

The Host `operationLifecycle.admit` currently checks draining; succession gating
is not wired there. Inspect `SessionWireAgent.timelineCursor()` for a projection
boundary and the native snapshot/runtime fields for authoritative readiness.
`SessionSourceBindings` requires a supplied signing key of at least 32 bytes;
production persistence/loading is still missing.

## Verification evidence and how to continue

The following results are recorded from the earlier implementation checkpoints
in the plan. They were **not rerun for this documentation handoff**, and do not
validate the newly approved deferred-input or cross-provider paths.

- Protocol suite: 221 passed.
- Affected Host suites: seven files, 50 passed.
- Codex suite: 412 passed, 12 environment-dependent skips before the final
  unsettled-candidate regression was added.
- Final focused Codex fork/prompt-edit/native run: three files, 23 passed.
- Codex build, Controller typecheck and compatibility update/check passed.
- The isolated native-fork test used a temporary profile/workspace and loopback
  model service. Three source prompts survived, model requests remained at three
  during fork, and predecessor history was unchanged. This validates that specific
  native experiment, not product handoff or real-service provider switching.

Use focused tests for the changed boundaries, then integration and browser
acceptance. Every test run requires both per-test and outer process deadlines.
The current worktree has an ignored `.tmp/run-bounded.py` helper; verify it exists
before use. For example, from the worktree root:

```sh
python3 .tmp/run-bounded.py 90 pnpm --filter @orchardworks/agent-remote-controller exec vitest run src/session-succession.test.ts src/session-succession-store.test.ts src/session-source-binding.test.ts --testTimeout=10000 --hookTimeout=15000 --maxWorkers=1
pnpm --filter @orchardworks/agent-remote-controller typecheck
pnpm compatibility:update
pnpm compatibility:check
```

Some Node 26 browser/jsdom runs may require
`NODE_OPTIONS=--no-experimental-webstorage`. Root test runners also provide bounded
execution; consult the plan for full acceptance commands. Do not use a passing
fixture as proof of native runtime behavior. Do not repeatedly run unrelated full
suites instead of resolving the missing contracts.

## Working rules and completion boundary

Read repository and package-local `AGENTS.md` instructions. Use this isolated
worktree and pnpm. Keep source, comments and repository documentation in English;
user-facing progress and replies are Chinese. Preserve other worktrees, user
sessions and services. Use isolated profiles and configurable free ports for tests.
Do not restart the user's daemon or replace an installed Host to get a test pass.

Update the existing checklist as each item is completed; retain failed or
unverified items explicitly. No push, merge, publication or deployment is part of
this handoff. Before any separately authorized release, document durable-format
compatibility, backups and recovery: precommit cancellation and postcommit forward
recovery are different operations.

The next meaningful milestone is a real Host path that prepares without model
execution, durably commits succession, injects history exactly once at first
admission or visibly blocks an uncertain outcome, and remains correct after
restart. UI completion follows that milestone; it cannot replace it.
