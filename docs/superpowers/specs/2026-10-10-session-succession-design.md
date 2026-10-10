# Same-host session succession

Status: Implementation in progress. Durable roles and source binding primitives
are implemented; production coordination, TPM and product integration are pending.

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

V1 requires the same Controller, provider and canonical working directory.
The first session establishes a stable primary role; it is not permanently the
executor. A role can have several TPM works and does not require TPM to exist.
Only providers advertising the complete required capability can perform succession.
Same-directory reuse does not transfer processes, approvals or native child ownership.
The same-provider restriction keeps the initial context-transfer path bounded;
it does not imply that future handoff must move machines or workspaces.

The confirmed scope is product-level succession, with a Session View action and
progress surface. It is not deployment, generic workflow scheduling, cross-provider
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
   and primes a session. Keep same-Controller/provider/cwd checks in this local
   preparation policy, rather than in the generic role identity or UI projection.
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

Implementation inspection found that the shared provider API cannot preload a
normalized-history message while guaranteeing that tools will not start work.
The implementation therefore prioritizes a verified native history fork for Codex.
This working choice was disclosed during implementation; no provider is enabled
in the product until the complete handoff contract is wired and verified.

Fork only after source admission is gated and execution is quiescent. Verify a new
native identity in the same cwd and the inherited latest settled turn boundary.
The native fork must not send `turn/start`, modify the predecessor or claim to
transfer native children, callbacks or running work. Preserve native settings and
recheck the actual successor's readiness. A creation timeout remains unknown and
does not authorize another fork. Preparing a native fork includes copying history;
the following transfer stage verifies it rather than sending that history again.

The existing `/fork` command retains its normalized-history copy behavior. A
normalized-copy handoff fallback remains unavailable until its preparation can
be guaranteed not to start implementation work. Other providers and authored
handover summaries need their own validated preparation strategies. Neither native
forking nor normalized copying promises reduced context size.

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

Implement this as one local Controller coordinator and a durable role record.
The existing Relay transports its decision and the existing product applies it.
Do not introduce distributed consensus, a workflow engine, a new service or a
cross-machine prepare/commit protocol. Browser synchronization is recovery of a
local committed decision, not participation in its transaction.

1. Validate authority, provider capability, source role revision and canonical cwd.
   Persist intent and reserve one succession for the role before native creation.
2. Gate new source input at Controller admission, including TPM and stale-browser
   requests. Wait for active turns, pending interactions, native queued input and
   owned child work to settle. Do not force-cancel work or assume idle proves this.
   Adapters must report the required facts; unknown state blocks commitment.
3. Freeze the association set against new source-bound creation/unlink races;
   concurrent changes receive a retryable conflict. Create the native fork and
   retain its native identity before attaching it. Verify the copied context,
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
inspection; do not delete native sessions automatically. Unknown creation or
delivery remains visible and requires reconciliation. After commit, transport
failure is projection recovery, not a failed succession or an automatic rollback.

Old direct Controller mutation requests to A are rejected as superseded with the
current role revision. Explicit historical viewing stays available. Independent
native writers cannot be fenced by UI logic; an unmanaged writer or unverifiable
ownership makes this capability unavailable until ownership is reconciled.

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
- Lost creation, context-delivery and commit responses do not duplicate effects.
- Existing and newly created Side/Ask sources resolve B; A cursors remain pinned.
- Nested Side/Ask relationships and unlinked sessions remain correctly scoped.
- All TPM works follow B; accepted/unknown operations never change recipient.
- Pending approvals, child work, native queues and unmanaged writers block unsafe commit.
- Favourite/Track duplicates, multiple drafts and stale projections lose no state.
- Unauthorized and shared-only access cannot obtain new successor privileges.
- Legacy prompt editing still creates siblings and native takeover keeps its semantics.
- Desktop/mobile browser flows cover in-place replacement and refresh recovery.
- Native-provider certification is separate from fixtures and mocked transports.

Implementation follows the companion plan. This document records the agreed
contract, not a claim that any runtime behavior has been implemented or verified.
