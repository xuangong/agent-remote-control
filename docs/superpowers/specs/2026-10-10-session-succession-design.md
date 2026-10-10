# Same-host session succession

Status: Implementation in progress. Durable roles and source binding primitives
and scoped Host/Relay/TPM integrations are implemented. Recovery and native evidence
remain incomplete; production storage and product integration are still pending.

## Approved architecture review adjustments

At `c55661e` the user approved recovery/access corrections first, then native
evidence with one verified provider mode, complete SQL persistence, and product
identity/recovery integration. Existing scope and authority boundaries stay intact.

Unknown native effects are never blindly replayed. Unknown input delivery and
unknown role-commit persistence remain fenced until reconciled. A strictly
zero-input, zero-task candidate creation may instead be explicitly abandoned:
persist the operation's terminal cancellation fence before reopening the source,
retain its request/witness and any known candidate, and accept a late creation
result only as additional orphan evidence. That operation can never commit,
recreate a candidate, dispatch context or silently delete the native candidate.
Keep candidate existence uncertainty visible; cancellation settles the role
transition intent, not the native creation outcome. Distinguish these cases
from a known candidate followed by a failed read, serialization or predictable
capacity check: these local phases need a safe terminal or forward-recovery path
without creating another candidate. Reserve capacity for durable context and
recovery outcomes before native creation. Do not discard retained evidence to
unlock a source. Exact native creation/input reconciliation is a provider evidence
capability, not inference from message text or a later idle snapshot.

Capacity admission follows those separate effects: preparation reserves its
captured context and finite handoff completion/recovery records before native
creation; the first postcommit input reserves its actual serialized content and
finite settlement before native dispatch. Do not reserve a hypothetical maximum
future input per candidate. Insufficient later input capacity rejects before
dispatch and leaves context pending. Arbitrary native reconciliation proof is
size-checked before receipt mutation, preserving existing uncertainty on failure.

Access revocation is independent of retained succession history. Removing Host
credentials and connections must remain possible without deleting committed
receipts or rolling back roles. Late work must not restore the revoked authority.
Recovery can remain pending until explicit authorized access is available again.
For retained succession identities, an owner-targeted recovery invitation may
restore the historical Host mapping with fresh credentials and runtime ownership.
It must not restore old sharing grants or bindings, and does not certify native
session existence or execution outcomes. Ordinary Hosts without retained
succession identity keep the existing revocation and pairing behavior.

Static provider support differs from instance readiness. Optional native evidence
extensions describe input identity/settlement and the coverage and validity of
quiescence through commit, while preserving the current public execution state.
Host role identities do not belong in provider SDK input contracts. Unspecified
acceptance disposition does not prove an input has left the native queue.

The user explicitly narrowed admission to a confirmed idle session with no queued
inputs, pending approvals or active child work. Disconnected, unknown and working
states reject handoff immediately. Do not implement drain-and-wait, native pause,
or automatically start a handoff after work completes. Gate new inputs during
preparation and revalidate before commit; a state change prevents commit. This
restriction does not make a lost native create/input response a definite failure,
nor does it establish exclusive control over an independently shared runtime.

The user approved scoping exclusivity to ARC admission, not a global native-client lock. A shared
native session can qualify for the ARC role transition without promising to stop
independent native clients. Authoritative observed busy, pending or disconnected
state still rejects preparation/commit. The adapter must describe the scope of
its evidence; do not require a cross-process lease merely to certify ARC admission.
External writes outside ARC are outside this exclusion guarantee and may continue
using the concrete predecessor; they never change the ARC role by themselves.

Handoff is an exclusive mutation phase for both source and candidate. All ordinary
ARC session writes, including input, settings, interaction responses, prompt edits,
fork/create-from-source, rename and relationship changes, must enter the same Host
admission boundary. Existing unsettled writes prevent entering handoff; do not
wait for them to drain. Read-only inspection and handoff cancellation/reconciliation
remain available, as do unrelated sessions and security revocation. UI disabling
is only a reflection of the Host gate. Do not claim this gate controls independent
native writers outside ARC.

Product composition separates stable pane identity, ordinary/history target
intent and actual native attachment. Immutable creation/delivery provenance must
not be replaced by a navigation projection. Existing Ask/Side targets keep their
own full native locator even when their main source changes provider. Recovery
belongs to a bounded set of product documents, not to the shared Session View
renderer or a new generic transaction/workflow system.

## Outcome and scope

The user hands the primary session's role to a newly created session. Favourites,
Track, the primary pane, Side layout, Ask attachment and TPM communication follow
the successor without manual reconstruction. Existing auxiliary conversations
retain their native identities, history and drafts. The predecessor remains
available as explicitly selected history.

This is a simplified handoff on the same Host machine and in the same working
directory. Existing files, Git state, dependencies and local environment stay in
place. There is no workspace copy, remote file synchronization, machine migration,
credential transfer, deployment or distributed execution coordinator.

V1 requires the same Controller and canonical working directory. The successor
may use a different agent/provider when both adapters satisfy the complete local
succession contract. Provider identity is a routing address, not role identity.
The first session establishes a stable primary role; it is not permanently the
executor. A role can have several TPM works and does not require TPM to exist.
Only providers advertising the complete required capability can perform succession.
Same-directory reuse does not transfer processes, approvals or native child ownership.
Cross-provider succession transfers normalized conversation context, not native
provider state, credentials, pending approvals or child ownership. Unsupported
targets must be rejected before creation; provider switching is capability-gated.

The confirmed scope is product-level succession, with a Session View action and
progress surface. It is not deployment, generic workflow scheduling, machine
migration or takeover of an independently running CLI.

## Current source and boundaries

- `packages/agent-remote-lab/src/session-forks.ts`: `/fork` copies a bounded,
  normalized history projection. It does not export full native context.
- `packages/agent-host/src/session-reference.ts`: source grants persist a concrete
  native ID; running source tools capture that ID in their closure.
- `packages/agent-remote-hosted/src/session-relations.ts`: navigation relations
  are distinct from native ancestry and currently identify concrete sources.
- `packages/agent-host/src/tpm.ts`: main-session reads, leases and dispatch use
  `mainNativeSessionId`; changing only UI relations cannot redirect them.
- `packages/agent-remote-hosted/src/session-migrations.ts`: prompt-edit branches
  may be siblings. Their events do not assert exclusive succession.
- `packages/agent-remote-lab/src/hooks/useAskConversations.ts`: preferences,
  windows, drafts and preparation are keyed by the source session.

Keep native execution in adapters, role coordination in Controller, authorized
projections in Relay and presentation in the product. Do not repurpose the existing
native ownership `SessionHandoff` state machine or prompt-edit migration semantics.
Use `SessionSuccession` for this feature's code and contracts.

## Identity contracts

Use a Controller-owned role with an immutable ID and monotonically increasing revision:

```ts
type NativeSessionRef = {
  controllerId: string;
  providerId: string;
  nativeSessionId: string;
};
type PrimaryRole = {
  id: string;
  revision: number;
  origin: NativeSessionRef;
  current: NativeSessionRef;
  workspace: { controllerId: string; canonicalCwd: string };
};
type SourceBinding =
  | { kind: 'fixed'; source: NativeSessionRef }
  | { kind: 'primary_role'; roleId: string; origin: NativeSessionRef };
```

Relay host IDs and agent IDs are resolved transport addresses, not durable native
identities. Role IDs use an immutable issuing Controller namespace and existing
authority; that namespace is not a requirement that the executor remain there
forever. V1 still stores and resolves the role on its one local Controller.
No new account system is introduced for standalone operation. Workspace placement
is separate from role identity; equal path strings on different machines do not
identify the same workspace.

`origin` is immutable provenance. Role resolution changes the current read or
dispatch target, never historical attribution. Each committed transition records
operation ID, from/to identities, previous/new revision, capture boundary and time.
No cycles or duplicate current executors are allowed. Returning to a predecessor
requires a new checked transition, not deletion of a committed record.

On first succession, enroll the source's currently linked Side/Ask relations and
TPM main bindings under the role. Enrollment includes the Controller's persisted
source grants, not just the browser's mounted windows. Unlinked relations and
unrelated conversations remain fixed. Subsequent children of the role's current
executor inherit the role binding. An Ask attached to a Side stays attached to
that Side; nested associations are not flattened.

## Extension boundary: preparation, succession and projection

The current scope is deliberately the simplified local mode. Conditions for
designing a cross-machine migration are not established. Preserve these seams
without implementing a migration service, cross-host transport or plugin registry:

1. **Prepare the successor.** Local preparation reuses the workspace and creates
   a candidate plus a durable context attachment without a model turn. Keep
   same-Controller/cwd and source/target capability checks in this local preparation
   policy, rather than in the generic role identity or UI projection.
   A future migration would have additional preparation work before a target is
   ready. Its file, environment, authority and recovery rules are not defined here.
2. **Commit succession.** Consume a checked preparation result and the expected
   role/association revisions. V1 has one local durable decision. The contract
   exposes actual before/after session references, not an assumption that only a
   native session ID can change. Cross-machine decision ownership, fencing and
   failure recovery require a separate design; the local atomic write is not
   claimed to solve those problems.
3. **Project associations.** Reconcile stable relationship identities and actual
   bindings into source reads, TPM communication, Favourites, Track, Side and Ask.
   Keep this separate from creating or copying native sessions. Preparation must
   account for persisted participants, not only currently visible panes.

Use a small internal result at the preparation/commit boundary:

```ts
type PreparedSuccession = {
  operationId: string;
  roleId: string;
  expectedRevision: number;
  associationRevision: number;
  from: NativeSessionRef;
  to: NativeSessionRef;
  workspace: PrimaryRole['workspace'];
  capture: { epoch: string; seq: number; capturedAt: string };
  participants: Array<{
    relationId: string;
    kind: 'side' | 'ask' | 'tpm';
    before: NativeSessionRef;
    after: NativeSessionRef;
  }>;
};
```

This result is Controller-owned checked state, not a browser assertion of readiness
or a transferable authorization token. For V1 each participant's `before` equals
`after`: its own native session stays put while its primary-role reference follows
the successor. The association revision makes concurrent enrollment changes visible.
Do not create replacement Side/Ask/TPM sessions in the local mode.

Future cross-host work must decide how every Side, Ask and TPM participant remains
usable: migrating/recreating a participant versus authorized access to a remote
one cannot be decided from a UI relink. It may change participant bindings and TPM
coordinator ownership as well as the primary executor. Keep that distinction in
the relationship model, but implement none of those policies now. Always preserve
participant provenance and historical message destinations when bindings change.

Implement one concrete local preparation module and its result type. No alternative
mode, remote endpoint, empty migration implementation or configurable migration
framework is needed for this release.

## Context preparation

The approved generic path uses the project's normalized `/fork` history-copy
semantics with deferred first-input injection. Native provider fork is not a
prerequisite, default strategy or silent fallback for this feature. Existing
experimental native-fork code is not evidence of generic handoff readiness.

After source admission is gated and execution is quiescent, capture a bounded,
normalized history snapshot with its source reference and timeline boundary.
Create a new, idle session on the selected provider in the same canonical cwd.
Persist the snapshot, target identity and effective supported settings before
reporting `ready`. Preparation starts no model turn and sends no synthetic
"understand this history" input. Session creation itself must be certified not
to launch task execution. Readiness means the context is durably available for
delivery; it does not mean the native session already contains that context.

Reuse the existing normalized history format, quoted-context semantics and
explicit truncation metadata. Extract shared serialization instead of importing
browser code into Host. This representation is not a full native context export:
non-text content and hidden provider state are not implicitly preserved. Bound
snapshot bytes as well as entry counts and reject unsupported captures explicitly.
Do not claim guaranteed context reduction or target-model fit. Settings are
mapped only when supported and semantically equivalent; never copy opaque model,
permission or reasoning identifiers across providers or silently elevate access.

The Controller owns a durable pending context attachment, separate from browser
navigation and the role commit receipt. The first admitted substantive input from
any supported path (user, another device or TPM) is composed with this attachment
at the unified Host dispatch boundary. Preparation and commitment send neither
history nor a continuation prompt to the model. If an explicit continuation is
requested, it is a normal postcommit input with the same delivery contract.

Serialize competing first inputs and persist the composed input identity, actual
recipient and role revision before native dispatch. A definite pre-dispatch
rejection leaves the attachment pending. An accepted or uncertain dispatch is
never automatically resent, rebound or reconstructed from a newer source.
Reconcile against authoritative native evidence; transport acceptance alone is
not proof of durable history. Until resolved, block later inputs from bypassing
context delivery. Commands that can execute work must use this boundary or be
explicitly rejected while context is pending. Ordinary read-only inspection must
not consume the attachment. Restart and browser loss must preserve these rules.

Before native materialization, source-history reads must expose the captured
context with explicit provenance and a stable cursor namespace, not an apparently
empty history or a claim that the entries belong to native B. Reading must not
trigger a model turn. Once materialized, avoid returning the attachment twice;
pinned reads must retain their original representation. A B -> C succession while
B still has pending context must preserve that attachment without nesting or
silently omitting history. Uncertain B delivery blocks that next succession.
Define and test this read/capture contract before enabling successive handoffs.

Keep ordinary `/fork` behavior unchanged while sharing its history representation.
Generic handoff does not depend on an adapter exposing native fork. No provider
is advertised until preparation, deferred delivery, source reads, TPM and product
projection pass the complete contract. A creation timeout remains unknown and
does not authorize another candidate under that operation. Explicit abandonment
may end a certified zero-task creation attempt without resolving candidate
existence, under the durable terminal fence described above. Cancellation retains
the unused candidate and receipt; it does not automatically send pending context.

## Coordinator and commit

Persist the operation before any native creation. State progresses through:

```text
preparing -> quiescing -> transferring -> ready -> committed
                 \           \           \
                  rejected / unknown / cancelled
```

Use a stable operation ID and request fingerprint. Repeated identical requests
observe the same operation; conflicting reuse is rejected. `unknown` retains its
last attempted phase and admitted effects. Recovery reconciles those effects and
does not blindly recreate sessions or replay messages.

One attempt has one fresh candidate and one fixed settings/target selection.
Changing the selection requires ending the attempt and making a new explicit
request. Do not schedule a handoff for later, wait until the source becomes idle,
or automatically retry a failed attempt. Transport retry with the same operation
identity may observe the saved decision; it must not start another native effect.
Role commitment ends handoff independently of later first-input settlement and
device-local projection recovery.

Implement this as one local Controller coordinator and a durable role record.
The existing Relay transports its decision and the existing product applies it.
Do not introduce distributed consensus, a workflow engine, a new service or a
cross-machine prepare/commit protocol. Browser synchronization is recovery of a
local committed decision, not participation in its transaction.

1. Validate authority, provider capability, source role revision and canonical cwd.
   Persist intent and reserve one succession for the role before native creation.
2. Acquire exclusive mutation admission for the source, including TPM and stale
   browsers. Reject if active turns, pending interactions, queued input, owned
   child work or unsettled writes exist; do not wait for them to settle or cancel
   them. Adapters report the required facts; unknown state rejects the attempt.
   Extend the same gate to the new candidate before ordinary access is possible.
3. Freeze the association set against new source-bound creation/unlink races;
   concurrent changes receive a retryable conflict. Create the idle candidate and
   retain its native identity before attaching it. Verify the durable context attachment,
   verify target readiness and recheck the source generation and role revision.
4. Atomically persist the new `current`, revision and committed receipt in one
   Controller record. Durable prepared overlays allow enrolled grants and TPM
   bindings to resolve through this single decision without rewriting every file
   as a distributed transaction. All precommit readers use A, all postcommit
   new admissions use B. Serialize the final admission check with commitment.
5. Publish the committed projection. Relay and browser apply it idempotently and
   reconcile after reconnect. Release role admission only with the committed
   target. Browser failure cannot undo a Controller decision.

Persisted source gates survive Controller restart. Before commit, cancellation or
definite failure restores source admission and retains a created candidate for
inspection; do not delete native sessions automatically. Creation uncertainty
remains visible after explicit zero-task abandonment; unknown input delivery and
commit persistence still require reconciliation. After commit, transport
failure is projection recovery, not a failed succession or an automatic rollback.

Old direct Controller mutation requests to A are rejected as superseded with the
current role revision. Explicit historical viewing stays available. Independent
native writers are outside ARC exclusion; observed native activity still prevents
commit. Missing authoritative session facts make capability unavailable, while
absence of a global native writer lock alone does not.

## Source reading and permissions

Change `read_source_session` execution to resolve a durable source binding on each
new query. Updating a saved grant alone does not fix live captured closures; enrolled
tools must already support role resolution, or be safely reattached at a provider-
confirmed boundary. A running legacy tool is an explicit readiness blocker.

Return the actual native source, role revision and observation boundary. A query
continuation pins its source identity and revision, including long-text offsets.
Never apply an A cursor to B or combine the two histories silently. Outstanding A
reads can finish as A reads. A fresh query resolves B. Old turn IDs require an
explicit historical target/cursor rather than being reinterpreted against B.

Permit bounded predecessor history reads only within the recorded authorized role
lineage. Source content is quoted data and never grants permissions. Handoff does
not allow the model to select an arbitrary source ID, broaden a share, copy an
approval callback or bypass the successor's current access checks.

Existing Ask/Side prompt text may mention A. Supply authoritative role metadata
through supported runtime instructions/tool results, without rewriting historical
messages or automatically starting an auxiliary model turn. Report current source
identity on every read so cached model context cannot masquerade as current data.

## TPM and delivery

TPM retains its work identity, documents, todo revisions and conversation. Bind
main reads, subscriptions and future dispatch to the primary role. Release old
leases only after the transition is known and acquire the new executor normally.

Every admitted send records its actual destination and role revision in addition
to the existing operation ID. The commit and dispatch admission share the role gate.
Prepared but never admitted intents can resolve B after commit. Dispatching,
accepted, queued or unknown intents remain attached to A; they cannot be resent
to B under a new identity. Unknown source delivery prevents commit until settled.
All works attached to the role participate, including ones not open in the browser.
Preserve user pause/completion and normal scheduler limits.

## Visible replacement

Apply one committed role projection to all affected product surfaces:

| Surface | Required behavior |
| --- | --- |
| Primary pane | Replace executor in place; retain container, focus and display preferences. |
| Favourites | Retarget the existing item; preserve favorite ID, folder, order and supported user metadata. |
| Track | Retarget in place; preserve order and device-local remembered composition. |
| Side tree | Replace the root role executor and retain linked children, selected path and collapsed/expanded state. |
| Ask | Retain native Ask identity, history, draft, outbox, enabled state, dock and window geometry under the role attachment. |
| TPM | Preserve work identity and display; reflect the new main binding. |
| Current navigation | Resolve ordinary role navigation to the latest successor; offer explicit predecessor history. |
| Other pages/devices | Reconcile committed revisions without overwriting newer local drafts or unrelated layout changes. |

If B is already favourited/tracked, keep A's stable slot and deduplicate B's normal
navigation entry. Do not discard a separate draft or an explicit historical pane.
Resolve collisions visibly when independent drafts cannot be merged losslessly.
Only remove a duplicate after its state has been retained.

Persist a last-applied role revision and a recoverable mapping for local state.
Do not mark the whole projection complete until all required stores are applied.
On storage denial, retain the in-memory correct target and show synchronization
failure; never restore A as current from stale storage. A stale server snapshot
cannot reverse a newer committed revision. Shared revisions synchronize identity;
each device preserves its own layout.

Unsent primary drafts can follow the role. Inputs already being transmitted or
queued are native-session operations and remain bound to their recorded receiver.
Attention history and old notifications preserve actual session/turn identity;
new activity observes B. A history link never silently becomes a different event.
Old ordinary session links may follow a known authorized lineage; explicit history
links open A. Shared links do not automatically gain access to B. Unauthorized
viewers receive the existing access boundary without successor identity leakage.

## Compatibility, cost and release

Legacy fixed bindings remain readable and unchanged until an explicit succession.
Keep old prompt-edit sibling behavior and native ownership takeover tests intact.
Advertise a versioned complete succession capability, not a UI-only flag. Mixed
versions reject unsupported coordination before creating B. Durable formats need
version checks: an older writer must refuse incompatible role state rather than
overwrite it. Retain backups and a documented forward recovery/rollback boundary
before any separately authorized deployment.

Resolve roles through an in-memory Controller index invalidated by revision;
avoid a disk read per token/tool chunk, eager reads of all predecessor histories,
per-Side duplicated context and new polling loops. Bound history pages and use
existing subscriptions. Persist at operation/transition boundaries.

## Acceptance and evidence

- A -> B -> C updates every listed surface while retaining auxiliary identities.
- Two devices racing at the same revision commit at most one successor.
- Disconnect/restart at every phase restores the correct gate and decision.
- Lost creation, first-input delivery and commit responses do not duplicate effects.
- Preparation and commit produce zero model turns or task execution.
- First user/TPM/device input receives context through one durable dispatch boundary.
- Pending context survives restart, source reads and B -> C succession without loss.
- Same-Host/cwd provider switching uses full session references for reads and sends;
  unsupported capabilities/settings fail before creation without privilege changes.
- Existing and newly created Side/Ask sources resolve B; A cursors remain pinned.
- Nested Side/Ask relationships and unlinked sessions remain correctly scoped.
- All TPM works follow B; accepted/unknown operations never change recipient.
- Observed pending approvals, child work, native queues and unknown session state
  block commit; ARC admission does not promise to lock external native clients.
- Favourite/Track duplicates, multiple drafts and stale projections lose no state.
- Unauthorized and shared-only access cannot obtain new successor privileges.
- Legacy prompt editing still creates siblings and native takeover keeps its semantics.
- Desktop/mobile browser flows cover in-place replacement and refresh recovery.
- Native-provider certification is separate from fixtures and mocked transports.

Implementation follows the companion plan. This document records the agreed
contract, not a claim that any runtime behavior has been implemented or verified.
