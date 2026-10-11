# Same-host Session Succession Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task in the existing isolated worktree. Steps use checkbox syntax for tracking. No parallel agent work is required.

**Goal:** Replace the primary session with a successor on the same Host and in the same working directory, preserving all user-facing attachments and avoiding duplicate execution.

**Architecture:** One local Controller owns a stable primary role and a recoverable succession operation. Source tools and TPM resolve that role; Relay and browser project the committed revision into existing navigation and preferences. This is not a machine/workspace migration or a distributed workflow engine.

**Tech Stack:** TypeScript, existing provider SDK and Remote contracts, Controller persistence, React, Vitest, Playwright, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-10-session-succession-design.md`

## Global constraints

- V1 requires the same Controller and canonical working directory; switching agent/provider is allowed only when both adapters satisfy the full contract. Native fork is not required.
- No workspace copy, remote file synchronization, machine migration, credential transfer, deployment or distributed execution coordinator.
- Keep native execution in adapters, role coordination in Controller, authorized projections in Relay and presentation in the product.
- Use `SessionSuccession`; do not repurpose native ownership `SessionHandoff` or prompt-edit sibling events.
- Preserve unrelated sessions, services and worktrees. Source, comments and docs remain English.
- New behavior remains unavailable until the full source, dispatch and projection contract is supported.
- No automatic replay after unknown creation/delivery outcomes. No automatic deletion of native sessions.
- No publish, push or deployment in this implementation plan.
- Keep local preparation separate from succession commitment and association projection. Reserve data boundaries for future cross-host migration; implement no cross-host migration policy or service.

## Status and verification setup

The user approved the architecture-review adjustments at `c55661e`. Execute
Tasks 7–10 below before resuming the remaining Task 5/6 work. Earlier scoped
checkpoints remain valid within their scope; they do not certify complete backend
recovery or a production provider. Keep one source implementer and independent
scoped review per slice; read-only preflight may run independently.

- [x] Inspect source ownership, relation persistence, favourites, Track and Ask storage.
- [x] Record the approved design and the same-machine simplification.
- [x] Document future migration seams without expanding the local implementation scope.
- [ ] Implement Tasks 1–6, marking each complete only with recorded evidence.

Base: `cc3f359`; worktree: `.worktrees/session-succession`; branch: `feat/session-succession`.
Implementation started: dependencies installed with the frozen lockfile and Controller dependencies built.
Baseline source-reference and TPM-store suites: 6 tests passed.
At implementation start run `pnpm install --frozen-lockfile`, then build workspace
dependencies and establish the affected suites' baseline. Inspect package-local
AGENTS.md files before modifying their scope.

Use the root test runner for outer and per-test deadlines:

```sh
NODE_OPTIONS=--no-experimental-webstorage pnpm test
pnpm test:conformance
pnpm test:e2e e2e/session-succession.spec.ts
pnpm typecheck
pnpm compatibility:update
pnpm compatibility:check
```

The new browser file is introduced in Task 6. During development use focused
package suites with explicit per-test/hook deadlines and a process deadline;
finish with the root runners. Native tests needing an executable or credentials
must be reported separately from fixture results. Do not replace a running Host
to obtain a passing test.

## Task 1: Role identity and local durable decision

Status: Complete. Protocol suite: 221 tests passed; succession store plus existing
source-reference/TPM-store suites: 13 tests passed. Controller typecheck passed.
The new store is not connected to production admission or UI yet.

**Create:** `packages/agent-remote-protocol/src/session-succession.ts` and `.test.ts`;
`packages/agent-host/src/session-succession-store.ts` and `.test.ts`.
**Modify:** protocol `src/index.ts` to export the new validated contracts.

**Interfaces:** Implement `NativeSessionRef`, `PrimaryRole` and `SourceBinding`
from the spec, including workspace placement separate from immutable role identity.
Define `SuccessionRequest` with `operationId`, `roleId`,
`expectedRevision` and `from`; `SuccessionRecord` carries the request, optional
`to`, `phase`, `resumePhase` for unknown outcomes, capture metadata and public
failure code. Define `SessionSuccessionStore.read(roleId)`,
`begin(request)` and `commit(operationId)`; begin returns the existing same-input
record, rejects conflicting reuse and reserves the expected role revision.

- [x] Write store tests for same-ID retries, conflicting fingerprints, concurrent
  begins, stale revisions, A -> B -> C and reopening persisted committed state.
- [x] Run the new store suite and confirm it fails because the store module is absent.
- [x] Keep complete Controller/provider/native references in before/after records;
  role identity must not be derived from cwd or the current executor.
- [x] Implement validated versioned records, a single-writer serialized mutation
  path and atomic replacement of the role plus operation receipt. Keep indexes
  in memory and preserve recovery records across restart.
- [x] Exercise a torn temporary write: the old committed record remains valid;
  a committed revision is never reconstructed from an uncommitted candidate.
- [x] Run protocol/store suites and commit `feat: persist primary session succession`.

Core observable expectation:

```ts
await store.begin(request);
// After the coordinator has persisted its ready target:
const first = await store.commit(request.operationId);
const duplicate = await store.commit(request.operationId);
expect(duplicate).toEqual(first);
expect(store.read(request.roleId).role.current).toEqual(first.to);
```

## Task 2: Source bindings that follow the primary role

Status: Complete at the source-binding boundary. Six affected Host suites passed
38 tests, including a live scripted native-tool callback and distinct history
transport. The production coordinator will install these readers in Task 3.
Enrollment checks durable grants and the complete relation list; committed role
state keeps a revisioned participant set for later creation/unlink changes.

**Modify:** `packages/agent-host/src/session-reference.ts`, `directory.ts`,
`session-reference.test.ts`, and supported provider directory integrations.
**Create:** `packages/agent-host/src/session-source-binding.ts` and `.test.ts`.

**Interfaces:** `resolveSource(binding, continuation?)` returns the actual
`NativeSessionRef`, role revision and a validated pinned query context.
`enrollSources(roleId, expectedRevision)` prepares a durable overlay for linked
relations, including unloaded grants. Publication occurs only through Task 1's
commit; fixed grants remain supported. New role grants include immutable origin.

- [x] Add tests with one live tool instance reading A, committing A -> B, then
  reading B without recreating the Ask session. A continuation must still read A.
- [x] Add tests for long-text offsets, old turn IDs, nested Side Ask, unlinked
  grants, unauthorized lineage reads and restart of an enrolled grant.
- [x] Implement per-query resolution instead of native-ID capture. Return actual
  source/revision metadata; validate lineage access on each read.
- [x] Enroll linked source grants and share the same resolver with creation.
  Legacy runtime extensions that cannot participate reject preparation clearly.
- [x] Run source-reference/provider regressions and commit
  `feat: follow primary succession in source references`.

Expected behavior, using the test fixture's tool wrapper:

```ts
const pageA = await fixture.readSource({ limit: 1 });
await fixture.commitSuccessor('B');
expect((await fixture.readSource({ limit: 1 })).sourceSessionId).toBe('B');
expect((await fixture.readSource({ cursor: pageA.nextCursor })).sourceSessionId).toBe('A');
```

## Task 3: Local handoff coordinator and admission boundary

Status: In progress. Shared normalized history, durable pending first-input
delivery, full-ref readers, durable cursor-key provisioning and Host admission
fences are implemented. Internal prepare/commit/reconcile routes and the TPM
dispatch integration passed focused runtime verification (`93648f2`). The real
Host TPM test also exposed operation-identity and initialization-race defects;
`9939800` fixes both, with six affected suites passing 79 tests. Trusted complete
relation enrollment, atomic association reservation and exact creation-result
recovery now passed scoped reviews and fixture integration. The final restart/TPM
increment passed 96 tests; whole-workspace typecheck and compatibility checks passed.
Trusted ordinary postcommit relationship edits passed scoped review and local
verification, including exact pre-effect reset and reachable Side recovery. Native
certification and complete product projection remain open. See the latest handoff
checkpoint for current evidence; this does not complete Task 3.
Codex native history fork was experimentally verified but is no longer the
generic handoff preparation path. Do not mark this task complete or expose a
product capability yet. See the continuation checkpoint in the handoff for
current commits and evidence; the following numbers are earlier checkpoints.
Checkpoint verification: seven affected Host suites passed 50 tests; the Codex
suite passed 412 tests with 12 environment-dependent skips before the final
unsettled-candidate regression was added. The final focused fork/prompt-edit/native
run passed 23 tests. Native tests used a temporary profile and loopback service;
no active user daemon or deployed environment was replaced.

**Create:** `packages/agent-host/src/session-succession.ts` and `.test.ts`;
`packages/agent-host/src/local-succession-preparation.ts` and `.test.ts`.
**Modify:** `packages/agent-host/src/host.ts`, `directory.ts`,
`execution-policy.ts`; Codex `src/provider.ts` and `src/session.ts`.
Keep existing normalized `/fork` behavior unchanged and extract its shared history
representation for Host use. Native-fork experiments already exist but are not a
prerequisite or a fallback; review their public exposure before final integration.
Do not send a context-only preparation prompt. `ready` certifies a durable pending
attachment and idle candidate, not model acknowledgement or native materialization.

### Approved direction follow-up

- [x] Extract shared normalized history serialization, byte/entry limits and
  truncation/provenance metadata without a Host dependency on browser modules.
- [x] Persist pending context and first-input delivery state on the Controller;
  retain receipt/attachment consistency across crash and storage failure.
- [ ] Compose context at one serialized dispatch boundary for user, multi-device,
  TPM and execution-capable command input. Fence bypass paths and uncertain sends.
- [ ] Certify zero preparation model turns and zero task execution using a real
  adapter/transport; do not rely on prompts, read-only mode or approval settings.
- [ ] Replace same-provider assumptions in readiness, source binding enrollment,
  history readers and TPM with full session references and capability checks.
  Reject unsupported provider pairs before creation. Preserve native namespaces.
- [ ] Map supported settings with explicit semantics; do not copy opaque provider
  values or silently broaden permissions. Keep auxiliary sessions unchanged.
- [x] Define pending-attachment reads and cursors; preserve context across A -> B
  -> C before B's first input, without duplicate or nested context injection.
- [ ] Test concurrent first inputs, definite rejection, unknown acceptance,
  disconnect, restart and TPM first dispatch. Never automatically replay unknown.
- [ ] Validate same-provider and cross-provider paths separately; do not advertise
  a provider pair on the strength of normalized text serialization alone.

**Interfaces:** `SessionSuccessionCoordinator.prepare(request)`,
`status(operationId)`, `commit(operationId, expectedRevision)` and
`cancel(operationId)`. Mutating methods return the persisted `SuccessionRecord`.
An adapter reports authoritative readiness and a supported context-preparation
path; unsupported or unknown readiness is not success.
`PreparedSuccession` has the exact shape defined in the spec. The concrete local
preparation module produces it after validating the target and participant set;
the coordinator revalidates its role/association revisions at commit. It is internal
state, never a browser-supplied readiness assertion. No strategy registry is needed.

- [ ] Test a complete same-cwd A -> B transition, wrong cwd/Host and unsupported provider rejection,
  creation success followed by attachment failure and a lost creation response.
- [ ] Test source admission against a racing direct send, native queue, approval,
  child work and an independently owned writer. Reserve before capturing context.
- [ ] Persist phase and operation receipts; create a candidate without launching
  implementation work; persist bounded pending context at the frozen source boundary.
- [ ] Isolate same-Host/cwd and provider capability checks and workspace reuse in local preparation.
  Populate Side/Ask/TPM participants with unchanged own native identities and check
  their relation revision. Do not create auxiliary successors in this mode.
- [ ] Verify the durable pending context attachment and candidate readiness before commit.
  Never reuse the context-copy path as proof of full native context inheritance.
- [x] Earlier optional experiment: implement native Codex fork without a model turn; validate its new identity,
  cwd and inherited boundary. Scripted fork/prompt-edit regressions: 22 passed.
- [x] Earlier optional experiment: run an isolated native fork test with the installed Codex binary and loopback
  Responses service: one test passed; three source prompts were retained, model
  request count stayed at three and predecessor history remained unchanged.
- [x] Implement local coordinator recovery tests for unknown creation/transfer,
  changed source boundary, busy target, cancellation and restart revalidation.
- [ ] Add restart/cancellation cases at every phase. Retain unknown effects and
  created candidates; reject mutation to the superseded source after commit.
- [ ] Run Host, fork and native-ownership regressions and commit
  `feat: coordinate same-host session handoff`.

## Task 4: TPM binding and send settlement

**Modify:** `packages/agent-host/src/tpm.ts`, `tpm-store.ts`, their tests and
`packages/agent-remote-protocol/src/tpm.ts`.

**Interfaces:** TPM gains an optional primary role binding. An admitted intent
records `resolvedTarget: NativeSessionRef` and `roleRevision: number`; existing
intent identity/status/acceptance retain their meaning. All main reads and new
send admissions use Task 2's resolver and Task 3's role gate.

- [ ] Test several works sharing A, including a paused work and a work with no
  open browser. After commit, all new main reads/dispatches resolve B.
- [ ] Test `prepared`, `dispatching`, `accepted`, queued and `unknown` intents.
  Only never-admitted intents may acquire B as their first actual destination.
- [ ] Bind and reconcile leases/subscriptions through the role; serialize the
  last dispatch validation with succession commit. Preserve scheduler limits.
- [ ] Prove an unknown A send cannot become a B send after restart or retry.
- [ ] Run TPM transport/store/Host regressions and commit
  `feat: preserve TPM delivery across session succession`.

## Task 5: Relay projection and complete product replacement

Status: In progress. Authenticated hosted replay is implemented and scoped-reviewed:
Broker4/Relay6 single freeze authority, bounded HTTP exact/current replay and
negotiated default-off Remote channel delivery. Real HTTP/WebSocket and durable
fixture Controller recovery passed, including authorization and write failure.
Product store/application replacement and browser acceptance remain outstanding;
this does not complete Task 5 or certify any native provider. See latest handoff.

Server Favorites projection is now implemented and scoped-reviewed: Relay7 adds
exact pending/applied acknowledgements in the same outer transaction as Broker4
freeze evidence. Stable slots and target metadata survive chained replacement;
stale owner predecessor saves/removes conflict. Mapping/capacity failures remain
pending without blocking native commit evidence. Root verified 48 affected Hosted
tests, 12 Cloudflare tests and whole-workspace typecheck. The SQL guard prevents
loss but full SQL persistence and all client stores remain outstanding.

The first client prerequisite is scoped-reviewed: observable terminal text writes,
current-text retry and a failure-only existing Workbench consumer. Root freshly
verified 95 tests in 10 files and whole-workspace typecheck. Draft keys/schema are
unchanged; page-local saved revisions and page-only retention do not establish
cross-reload or multi-store recovery. Cold composition/App integration is next,
then authenticated replay/Track, rich drafts, Ask/Side and historical navigation.

**Create:** hosted `src/session-successions.ts` and `.test.ts`;
Lab `src/session-succession.ts`, `.test.ts`,
`src/hooks/useSessionSuccession.tsx` and `.test.tsx`.
**Modify:** hosted `src/state.ts`, `broker.ts`, `favorites.ts`,
`session-relations.ts`; Lab `src/App.tsx`, `tracking-state.ts`,
`session-composition.ts`, `session-forks.ts`,
`hooks/useSessionTracking.tsx`, `hooks/useAskConversations.ts` and corresponding tests.

**Interfaces:** Relay accepts only authenticated Controller committed projections
and offers revision-based snapshot/replay. The product's
`applySuccession(projection, currentState)` returns one coherent next in-memory
state plus idempotent persistence operations. The hook owns recovery, not the
renderer. Keep prompt-edit `session_migrated` behavior separate.
Reconcile full before/after bindings; do not infer that every replacement must have
the same host ID or that an auxiliary relation ID is its native session ID. The
local preparation policy remains responsible for enforcing the V1 restriction.

- [ ] Add replacement tests that preserve favourite ID/folder/order, Track order,
  Side selections, Ask native ID, preference state, geometry and drafts.
- [ ] Test A -> B -> C with stale A -> B replay, disconnected devices and a crash
  between local-store writes. Current roles never revert from stale snapshots.
- [ ] Implement authorized shared projections and local revision-based recovery.
  Preserve each device's layout and scope updates to the enrolled role.
- [ ] Add duplicate B entries and conflicting drafts. Keep A's navigation slot;
  preserve independent drafts and native-bound pending sends visibly.
- [ ] Ordinary navigation resolves the successor; explicit history resolves A.
  Old notifications retain exact event identity. Sharing does not grant B access.
- [ ] Run favourites, relations, Track, Ask, composition and prompt-edit suites;
  commit `feat: replace session references after handoff`.

## Task 6: Entry point, end-to-end recovery and release evidence

**Create:** `packages/agent-remote-lab/e2e/session-succession.spec.ts` and
`packages/agent-remote-lab/src/server/session-succession-transport.test.ts`.
**Modify:** the existing primary Session View action wiring in `App.tsx`,
`docs/current/agent-remote/lab.md`, `session-boundaries.md`, provider capability
documentation, recorded fixtures and `compatibility.json`.

- [ ] Expose Handoff for an eligible primary session, state the same Host/cwd and
  context-copy semantics, and display progress plus recoverable failures.
  Disable unsupported combinations based on capabilities, not guessed versions.
- [ ] Real-transport tests cover broker/Controller reconnect, lost responses,
  authorization, stale requests, two racing clients and late old-source input.
- [ ] Desktop/mobile tests cover Favourites -> primary -> Side -> Ask -> Track,
  handoff, reload and second handoff, asserting preserved auxiliary identities.
- [ ] Validate a supported native provider in an isolated profile/workspace.
  Record actual context recall, source-tool retargeting and no duplicate execution.
- [ ] Run the verification commands above; distinguish environment-dependent
  native tests from fixture success. Record every unresolved failure explicitly.
- [ ] Implement and verify complete Cloudflare SQL succession persistence before
  enabling that backend: preserve outer version, Broker associations and per-store
  recovery progress atomically. The existing Relay2 codec does not encode these;
  a fail-closed guard is protection, not implementation or production acceptance.
- [ ] Document durable-state version compatibility, backups, precommit cancel and
  postcommit forward recovery before considering a separately authorized release.
- [ ] Update this checklist with evidence and commit
  `feat: expose and verify same-host session handoff`.

## Review coverage

Tasks 1/3 own authority, quiescence, operation identity and recovery. Task 2 owns
source semantics and access. Task 4 owns all TPM works and settled destinations.
Task 5 owns every visible reference and device-local preservation. Task 6 verifies
the complete user path, compatibility and native behavior. No task adds file or
environment migration. Do not mark the feature complete with only UI replacement.
The extension review checks that workspace placement, participant bindings and
local preparation are separate from stable relationship identity. It does not
certify cross-host readiness, execution authority transfer or migration recovery.

## Task 7: Recovery and access-revocation boundaries

Status: Scoped implementation and independent review complete. Task7A covers
revocation/recovery; Task7B covers local preparation, cancellation and capacity.
Root verified Task7B with 137 tests / 12 files and Controller typecheck. Native
certification and complete mutation admission remain Task8.

- [x] Keep Host access revocation independent of immutable succession history.
  Revoke credentials/connections without deleting committed evidence or restoring
  predecessor authority. Define pending-operation and late-response behavior;
  no old credential may publish or recover new access after revocation.
- [x] Distinguish definite preparation failures from unknown native effects.
  A known candidate followed by failed bounded read/serialization must not leave
  the source permanently reserved. Retain candidates and original operation IDs.
- [x] Preflight/reserve bounded context and recovery capacity before native create.
  Keep committed/unknown evidence intact; never remove records merely to unlock.
- [x] Support safe cancellation/forward recovery at justified local phases,
  including restart. For certified zero-task creation, allow explicit durable
  abandonment retaining native uncertainty and late orphan evidence; fence the
  cancelled operation permanently from commit or replay. Unknown input and commit
  persistence still require reconciliation, never a blind retry.
- [x] Run affected real-transport, capacity and recovery tests with both deadlines,
  obtain scoped review, update compatibility and commit locally.

## Task 8: Native evidence and one real provider mode

Status: Task8A's isolated Claude crash evidence is reviewed and verified. Empty
postcommit B fails exact cold resume; lost-ack U survives in public history.
Claude durable succession is not certified. Task8C's isolated OpenCode 1.18.18
existing `/session` API probe passed both empty-B and lost-ack-U crash cuts,
independent review and Root's fresh verification. It proves raw native feasibility,
not callback-enabled provider readiness. Task8B1 common operation/reservation is
reviewed and verified, including its four review fixes. Root ran 280 tests in
15 files before review and 174 tests in eight files after the fixes; affected
build/typechecks passed. Task8B2A setting intent/effect lifetime is also reviewed,
including the ordinary receipt-expiry fix. Root freshly ran 153 tests before
review and 60 affected tests after the fix; build/typechecks passed. Task8B2B
directory/provenance/association/owner wiring and its compatibility/fixture fixes
passed independent review. Root's initial Host 419/420 exposed a TPM rename
fixture reading revision before acceptance publication; the controlled uplink
regression now verifies that ordering. Root freshly passed 134 affected tests
after the fix, in addition to Hosted 122, Protocol 236 and Lab 13 beforehand;
affected builds/typechecks passed. Task9A's projection-ceiling contract also passed
independent review and Root's fresh 211 tests across 16 files, three builds and two
typechecks. Native readiness integration and later storage/product gates remain;
no production capability is enabled by these scripted fixtures.

- [x] Add entry-bound synchronous admission, bounded opt-in mutation retention,
  source/candidate reservation and final serialized recheck to the existing
  operation cache and succession boundary; preserve exact retry identity.
- [x] Keep TPM accepted queued/unspecified intents unsettled in catalog/readiness,
  with prepared intents visible but nonblocking.
- [x] Retain setting intent/effect lifetime and restore each intent's Host and
  manager operation contexts; UI timeout is not native-effect settlement.
- [x] Complete directory/provenance, association and native-owner admission.

- [ ] Enforce idle-only admission: reject working, queued, approval, active-child,
  disconnected and unknown states immediately. No draining, native pause or
  automatic waiting handoff; revalidate under the input gate before commit.
- [ ] Make source and candidate exclusive for ordinary session/association writes
  through one Host admission boundary. Existing unsettled writes reject admission;
  allow read-only inspection, handoff recovery/cancel and security revocation.
  Verify multiple clients/TPM cannot bypass it and unrelated sessions remain usable.
- [x] Define optional provider-neutral empty-creation, input witness/reconciliation
  and attachment-local validity contracts without Host role identities. D1's
  OpenCode implementation passed independent spec/quality review after one scoped
  repair. Root freshly passed 97 OpenCode tests, both original validity regressions
  and the source typecheck; unchanged SDK retains its verified 40 tests/typecheck.
  Inspection accounts for in-flight reads and relevant Session metadata changes.
  Owned HTTP/SSE fixtures and disabled private authority do not certify production.
- [ ] Complete native readiness evidence and D2 Host consumption. D2A adds durable
  original creation outcomes, nested witness/proof admission and the in-mutation
  assertion; D2B wires verified attachment and the original effect/readback route.
- [ ] Treat unspecified acceptance as unknown disposition in TPM; settle native
  queued inputs from authoritative evidence, not later idle or text matching.
- [ ] Preserve operation/candidate/input evidence across lost responses and restart.
  Verify zero-task creation for Task7 abandonment; exact input materialization
  and unknown commit recovery remain mandatory. Native create-result lookup can
  be optional when explicit abandonment is the supported recovery path.
- [ ] Verify a concrete provider/runtime mode using isolated profiles/services.
  Evidence must cover zero-turn preparation, first input, queued work and the
  validity of readiness through commit. Record unsupported facts explicitly.
- [ ] Keep production capability off until complete product and durable gates pass.

## Task 9: Complete deployed storage support

- [x] Establish negotiated freeze-v2 projection ceilings, exact legacy recovery,
  bounded Host pre-effect checks and explicit old-writer fences. Task9A keeps
  aggregate admission, complete SQL storage and real provider enablement gated.
- [x] Implement complete versioned Cloudflare SQL encode/decode for Broker
  associations, relation changes/resets, exact freeze evidence and Favorites
  progress, preserving the existing outer transaction and durability boundary.
  Task9B uses SQL format 3 and record format 1 with 262144-byte BLOB chunks;
  headers retain complete identities/order and use the same bounded encoding.
- [x] Test old-format migration, exact roundtrip, restart, rollback on failed
  write and authorization removal without deleting historic evidence. Root
  freshly passed all 102 Cloudflare tests, both affected typechecks and actual
  baseline-reader rejection. Independent spec/quality review approved the slice.
  Sync failure remains unknown durability, not rollback. Production effect guards
  remain closed; isolated codec success is not admission or native certification.
- [x] Reserve complete Host source-result witnesses before qualified creation,
  bind the producer certificate to the actual directory and preserve exact recovery.
  Task9C0 uses role-file 6 and a restart-derived complete-witness allowance. Source
  review and quality passed; Root freshly passed 163 Host tests, 19 Relay tests,
  both typechecks and the actual prior-writer rejection check. The broad run was
  not all-green and accidentally included native fixtures; retain that execution
  incident and the unverified cleanup boundary in whole-branch acceptance.
- [x] Derive the Relay feature envelope using the sole codec's complete costs and
  finite outcome/slot/revision allowances. Task9C1 adds immutable fresh-freeze
  admission and the configured outer10 fence; independent source/quality review
  passed, with 147 fresh scoped tests, actual prior-reader validation and affected
  build/typechecks. The quote-test independence suggestion remains on the final
  review list. This slice does not enable effectful SQL succession.
- [x] Complete atomic source/relation consumers and pre-effect contention (9C2).
  Independent review approved the slice after fixing current-access revalidation
  across queued work and runtime confirmation for no-write attach. Root freshly
  passed 117 Hosted and 47 Cloudflare tests plus both typechecks on the final
  source, including five new transport regressions. Default production gates
  remain closed; the direct Broker revoke test does not claim the same Gateway
  control-proof schedule.
- [x] Complete terminal/Favorites/recovery consumption and fault acceptance (9C3).
  Independent spec/quality review approved the slice without findings. Root
  freshly passed 172 Hosted and 90 Cloudflare cases, including 42 Node/Worker
  consumer fault cases, and both typechecks. Complete terminal evidence and
  Favorites progress share the existing outer commit; current recovery claims
  and actual key overlap survive uncertain publication. Restarted overlap can
  require explicit recovery rather than another automatic key issuance.
- [x] Review role/context/grant durable-file write consistency and cursor
  install-once readiness (9D). Independent spec/quality review approved the slice
  without findings; Root freshly passed 183 Host tests and typecheck. Attempted
  rename uncertainty fences the owner, and cleanup preserves the first cause.
  Controlled fault/reopen evidence does not certify OS crash, power loss, Windows
  equivalence, ancestor-directory persistence or live multi-process writers.
- [x] Complete the separate local Worker operating-envelope checkpoint (9E),
  reporting measured cases and unavailable telemetry without production limits.
  Independent spec/quality review passed after preserving sample evidence across
  cleanup failures. Root freshly passed all 24 declared sequences, five finalizer
  checks and both production/fixture typechecks; the unchanged shared fixture and
  portable default entry had separately passed 27 tests and one focused sample.
  Real Worker SQLite and a fake Host peer do not certify native providers,
  production resource limits, OS crash or power-loss behavior.

## Task 10: Product identities and recoverable composition

- [x] Split immutable ForkStore delivery source from projected navigation source;
  mutations read checked raw delivery records, not projected view records.
  Task 10A passed independent spec/quality review after two scoped fix rounds;
  Root freshly passed 153 tests and the e2e typecheck. The separate Task 10V
  fixture repair cleared the pre-existing Lab typecheck error: independent review
  and fresh 20 revocation / 21 history tests plus complete Lab typecheck passed.
  Stable Side edit navigation survives source changes without retargeting unknown
  input. Ask native routing and full state migration remain separate below.
- [x] Route existing Ask targets by their own complete native locator; confirm
  attachment and fence saved question delivery to its original recipient/operation.
  Task 10B passed independent spec/quality review after one scoped fix round;
  Root freshly passed 131 tests and complete Lab main/e2e typecheck. Transport
  replacement preserves saved input for explicit Retry; mismatched or unowned
  questions remain visible with a checked per-question Discard action.
- [x] Preserve complete nested attachment and draft/window state across provider
  change using the stable owners and recovery in Task 10C.
  The callable 10C1 layer is implemented and independently approved after one
  scoped fix round. Root freshly passed 264 Lab tests and main/e2e typechecks;
  unchanged Web retains 71 tests and its typecheck from the verified round0.
  Unknown window reads, checkpoint-completion edits and absent display defaults
  have regressions. Task 10C2 product wiring passed independent spec/quality review
  after one scoped correction round. Root freshly passed 106 affected App tests,
  main/e2e typechecks, eight desktop and five applicable mobile Chromium cases;
  three desktop-only cases were explicitly skipped on mobile. Owned HTTP/WS
  fixtures verify composition replacement, not native-provider certification.
- [x] Introduce stable pane slots and target intent independent of attachment;
  attach failure keeps B as target without displaying A as B or resetting layout.
- [x] Complete scoped replay/Track/navigation, independent text/image conflicts,
  Favorites progress/history intent and actual desktop/mobile refresh acceptance.
  Use a bounded set of product documents rather than a generic transaction engine.
- [x] Keep native outbox/attention/cursors concrete; keep role resolution and
  recovery in the composition layer, outside the ordinary Session View renderer.
  First cold A-to-B-to-C recovery retains the origin owner; same-role reopening
  preserves confirmed/failed outcomes, access suspension preserves desired B,
  and newer Favorites progress triggers checked HTTP recovery without relying on
  tree revision. No unresolved Important finding remains from scoped 10C2 review.
- [ ] Complete remaining Task 5/6 acceptance and whole-branch review before any
  capability enablement. No deployment, merge or installation is authorized here.
