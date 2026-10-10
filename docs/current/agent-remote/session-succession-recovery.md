# Session succession state and recovery

Status: implementation guidance, not an enabled product capability. No native
provider pair is certified. This document records the current backend formats, including ordinary
postcommit relationship updates. Update the format table when schemas change.

## State ownership

The Controller owns the primary role, actual native recipients, pending context,
and operation outcomes. The authenticated Relay owns relationship metadata and
the projected decision. Browser navigation is a projection of those decisions.
Neither browser storage nor a native session ID alone can reconstruct authority.

The configured succession state directory contains:

| Relative path | Required recovery evidence |
| --- | --- |
| `roles/state.json` | Role lineage, revisions, decisions, enrolled relationships, exact source-creation results, relation-change receipts and unresolved admissions |
| `contexts/context.json` | Captured normalized context and first-input delivery identity/outcome |
| `source-cursor.key` | Signing key for existing source-history and context cursors |

The complete recovery set also includes Controller installation identity, native
source grants, TPM state and the Relay tenant's durable bindings, association
receipts and projections. Native provider transcripts remain separate. Copying
succession state does not copy a workspace, process, credentials or native session.

## Format boundaries

| State | Checkpoint format | Supported upgrade behavior |
| --- | --- | --- |
| Controller role state | Version 5 | Versions 1 through 4 retain explicit migration rules; legacy receipts gain no invented projection budget or creation evidence |
| Pending context | Version 2 | Reads version 1 attachments; new target-independent preparations share attachment capacity, and delivery-state recovery remains independent of role state |
| Relay outer state | Version 9 with association-v5 writers; version 8 adds Host recovery metadata; version 7 adds Favorites succession progress | Legacy outer versions 2 through 8 retain explicit inner-format rules and complete-lineage validation; no applied progress, budget or native result is fabricated |
| Broker association state | Version 5 | Versions 1 through 4 retain explicit migrations and valid complete committed lineage; saved freeze-v1 identities remain unchanged |
| Enrollment freeze | Version 2 for new preparation | Requires an immutable positive safe-integer `maxProjectionBytes`; exact saved version-1 recovery remains supported without retrofitting a budget |
| Favorites succession progress | Version 1, requiring Relay7 or later | Bounded pending/applied acknowledgements identify an exact committed freeze and contiguous role revision; this is store progress, not another commit authority |
| Host recovery metadata | Revoked Host mappings and targeted invitations, requiring Relay8 | Owner recovery binds Host ID, installation ID and revocation ID; previous credentials, bindings and sharing grants are not restored |

An unpublished experimental Controller version-2 file without
`associationResults` is rejected, not migrated. Future or malformed versions also
fail closed. Broker association version 2 requires at least Relay outer version 4; Broker
association version 3 requires outer version 5; version 4 requires outer version 6;
version 5 requires outer version 9. Favorites progress requires outer version 7. New safety fields must not be
hidden behind an older version number. An older writer must not overwrite a newer format. Do not edit a
version number or delete recovery fields to make a previous binary accept them.

## Negotiated projection bound

New preparation requires explicit enrollment-feature v2 acknowledgement, a Relay
allowance selector and a supported adapter's bounded candidate/capture producer
certificate. Authentication authority remains v1 and the uplink envelope remains
v2. An upgraded Host requests feature 2 without silently downgrading on an older
Relay; ordinary connectivity remains available, while succession recovery there
stays unavailable until the Relay is upgraded. A feature-v1 Host on an upgraded
Relay receives no new strict-envelope field and can recover exact saved v1 work,
but cannot start a new preparation.

The ceiling measures the complete UTF-8 serialization of
`JSON.stringify({version:1,role,receipt})`, including repeated references and
optional recovery fields. Host admission checks a conservative bound after the
complete participant snapshot and association revision are staged, then checks
the saved ceiling again before publishing `create-started`. Its separate private
file-growth reservation remains authoritative. A refusal leaves any existing
Relay freeze available to the established cancel/readback/release path.

An output invariant violation after commit reports
`succession_projection_invariant_failed` and preserves the entire committed role
and receipt. Saved prepare/status/reconcile/commit/release cannot conceal that
defect as success. Recovery never creates another candidate to fit a ceiling.
No production allowance supplier or native producer certificate is enabled by
this contract; aggregate SQL admission and complete persistence remain pending.

## Recover from facts, not elapsed time

| Persisted situation | Permitted behavior |
| --- | --- |
| Prepared and ready in the same verified runtime | Revalidate source/candidate and capture boundary before commit; cancellation retains the native candidate |
| New-format precreate state when the Host restarts | Explicitly settle the interrupted local preparation without creating a candidate |
| New-format candidate-known or ready state when the Host restarts | Restore as unknown; explicitly revalidate the saved context and candidate without creating again, or cancel while retaining candidate evidence |
| Captured history boundary cannot be revalidated before commit | Do not commit; a definite local rejection or supported cancellation retains the unused candidate and releases the source only after terminal persistence |
| Host committed, Relay projection failed or response was lost | Read the exact durable decision, persist its projection, then acknowledge the saved association receipt; never roll back to the predecessor |
| Source creation returned and its exact result was durably recorded | Verify scope, operation, parameters, full native identities and original grant; attach that reader without another native create |
| Certified zero-input/zero-task creation has no result witness | Explicit cancellation may settle the handoff intent after its terminal fence is saved; candidate existence can remain unknown |
| Other native effect has no durable result witness | Retain unknown; a matching grant alone is not proof of that operation |
| First-input dispatch accepted or uncertain | Keep its actual recipient and operation identity; do not replay or retarget it automatically |
| TPM recovery rejected before native access | Settle only the rejected recovery admission; retain the original unresolved creation |
| TPM recovery failed after native access or during outcome persistence | Keep the unresolved admission until matching evidence settles it |

Association release follows a durable Relay decision and exact Host acknowledgement.
A terminal Host decision alone does not authorize releasing the other side's
reservation. Old A-to-B status remains A-to-B evidence after a later B-to-C;
current navigation can independently resolve C.

## ARC mutation admission

The existing process-local operation cache owns mutation target identities and
native-effect or asynchronous-work handles. A fresh operation reserves capacity
and obtains synchronous admission before asynchronous validation. An exact retry
observes the same entry and does not acquire another grant. Source reservation,
candidate registration and the final serialized commit check inspect this shared
evidence. A late recovery result cannot reacquire a durably cancelled reservation.

Only explicitly succession-enabled targets retain unsettled entries beyond
ordinary cache expiry. The reserved budget is the smaller of 125 entries or
one eighth of configured entries, and the smaller of 1 MiB or one eighth of
configured bytes. Target metadata, handles and result reservations count toward
that budget, including later handles for an ordinary target on an already pinned
entry. Capacity refusal preserves existing evidence. This cache does not survive
process restart; native recovery must independently cover that boundary.

Input acceptance settles only when its disposition is started or handled;
queued or absent disposition is still unresolved. TPM catalog and admission use
the same predicate. Prepared TPM intents remain visible but are not yet native
work. Read-only inspection, handoff cancel/reconcile, unrelated sessions and
security revocation remain available during a reservation.

Accepted settings reserve asynchronous work and a reusable future native-effect
slot before acceptance. Every queued/deferred apply restores its original Host
and Manager operation contexts and rechecks current admission/capability/value.
The Host proxy owns the actual effect: void, deferred and definite SDK rejection
settle that call; pending, generic errors and an unfinished promise retain it.
UI confirmation, timeout, replacement or Manager close cannot prove settlement
of an uncorrelated native write. Close cancels undispatched intent work only.

Ordinary receipt expiration does not cancel a live accepted setting. Its original
unpinned slot may continue after expiry without recreating the receipt or borrowing
a same-key replacement. Released/active/closed reservations and newly enabled
targets still fail closed. Live setting work remains part of Host admission.
Wire authorization is checked before acceptance; a later page disconnect or
control-lease replacement does not cancel accepted work. Share revocation prevents
new requests and closes streams, without retroactively undoing accepted intents.

Directory create/rename and source-derived operations use the same entry through
validation, native completion and result/grant publication. Snapshot
`creationSource` is request-only concrete provenance: it authorizes the source on
its own provider, without creating source tools or a role-following association.
Equivalent legacy source/edit provenance preserves existing persisted creation
fingerprints. Changed snapshot provenance still conflicts; unknown receipts do
not permit another native create.

Fresh relation metadata admission captures reader, immutable source, current role
and native-family refs. A superseded source alone does not prevent unlink/relink,
but transient and durable nonterminal reservations do. Trusted metadata attempts
without an exact Host receipt may repeat safe validation after a missing grant is
repaired; the durable operation and reservation never change. Exact saved results
retain their existing forward recovery, and unknown store publication stays closed.

Native owner transfer obtains a synchronous grant before owner fields, stop or
projection cleanup change, holding its family through publication. Its bounded
receipt timeout retains uncertain effects, including later known completion.
Ordinary immediate takeover can interrupt working; it does not inherit succession's
idle requirement. Read attachment and security cleanup retain their existing paths.

These reviewed slices cover the Host entry points, but do not certify complete
native readiness or independent writers. Native evidence, SQL persistence and
product recovery remain separate gates; production succession stays disabled.

## Native evidence checkpoint

An isolated macOS experiment on 2026-10-10 used Claude Agent SDK 0.3.247 and
its bundled Claude Code 2.1.247 with a loopback model fixture. Empty initialization
sent no input or model request. After saving a probe-local role decision and
killing the owned native process, one fresh exact-ID resume failed with
`No conversation found with session ID`. The committed role/context remained
recorded. This mode does not satisfy the empty-candidate crash-recovery contract;
missing public metadata alone was not treated as proof of non-creation.

A separate input experiment persisted the exact user UUID, recipient and composed
content before one dispatch, held the substantive response and killed the owned
process. Fresh public history returned exactly that user record without resume
or resend. This establishes positive text-input materialization for the tested
cut, not completed task execution, generic queue readiness or provider certification.
Do not use that result to waive empty-candidate recovery or enable succession.

The dedicated `test:claude:succession-evidence` entry requires explicit executable
and a new evidence output path; ordinary test collection skips it. Its supported
platform/runtime and fixed versions are checked before native startup. Each run
keeps separate evidence. Full Host admission, native readiness integration,
deployed storage and product acceptance remain release gates.

A separate isolated experiment used OpenCode 1.18.18 with SDK 1.18.31's
`client.session` API (`/session`, not `/api/session`). After one empty create,
the saved exact B survived SIGKILL and a fresh same-profile server returned its
identity, canonical cwd and empty history without model requests. After one
caller-identified U, a proxy withheld the native response and the fixture held
the substantive model stream incomplete. Following another SIGKILL, exact public
GET B/U returned the original user identity and ordered text parts; bounded
history contained U once, and reconciliation produced no new model requests.

Both cuts passed independent review and a fresh Root run. The opt-in
`test:opencode:succession-evidence` entry uses an explicit reviewed executable,
isolated profile, restricted loopback sandbox and a 120-second outer deadline;
an optional evidence output must be a new absolute path. Ordinary collection
skips it. These results do not certify queue/work coverage, callback-enabled
production configuration, multipart input, native completion, Host integration
or power-loss durability. Capability remains disabled.

## Local preparation and cancellation

Preparation saves bounded normalized history before calling native create. The
private role record distinguishes not-started, create-started and candidate-known,
and saves the exact creation identity and zero-task guarantee for that attempt.
Legacy phases alone cannot supply those facts. Binding moves the saved context
preparation into an attachment; it does not capture again or send native input.

Cancellation can settle a certified create while its call is still pending. The
terminal decision must persist before releasing the source. A late result only
adds bounded orphan evidence; it cannot bind context, commit, recreate, send input
or automatically delete the unused native session. A failed terminal write keeps
the prior reservation. Unknown role publication and first-input delivery do not
use this cancellation rule.

Both local stores retain their 8 MiB limit. Preparations and attachments share 512
slots; each attachment retains at most 512 input deliveries. Preparation admits
actual context plus finite binding/terminal/recovery growth. First input separately
admits its actual serialized content and finite settlement before dispatch, with
the existing 1 MiB raw-input limit. Capacity rejection leaves context pending for
a smaller explicitly submitted input. Native proof is checked at its actual size;
an oversized proof leaves the old accepted/unknown receipt unchanged. No retained
history is deleted to make room, and no arbitrary future-input capacity is promised.

## Authenticated committed replay

The tenant Broker freeze projection is the sole Relay commit authority. A legacy
top-level `sessionSuccessions` mirror migrates only if every full saved projection
exactly matches an authenticated committed freeze for that owner. Missing chain
prefixes, unmatched mirrors and contradictory surviving identities fail closed;
outer versions 6 and later forbid that duplicate field. Never synthesize a freeze from
browser state or remove recovery evidence to make an older writer accept it.

Replay uses a version-1 envelope containing the immutable committed projection
and authorized `from`/`to` Host, provider and native-session locators. A locator is
not an attached session and contains no guessed agent ID. Reading replay performs
no native open, prepare or model input. Owner authorization covers both endpoints;
shared-only accounts gain no successor access. Offline owned Hosts can expose
durable history while identity/provider metadata and owner authority remain valid.
Missing current Host/provider metadata suppresses access without invalidating or
deleting stored evidence; contradictory identity mappings still reject.

The owner-scoped `v1/session-successions` endpoint returns bounded pages. Its
`operation` endpoint replays an exact immutable operation; `current` separately
resolves the latest visible role. After A-to-B-to-C, old A-to-B still names B while
current names C. Page cursors are owner/selection-scoped positions, not global
watermarks: recovery starts a fresh traversal so newly inserted roles are not
missed. Inaccessible records do not prove a contiguous visible chain.

Live delivery requires explicit `successions=1` channel opt-in and the
`ready.successions=1` marker. The separate `session_succession_committed` frame
never substitutes for prompt-edit `session_migrated`. Default transport opt-in is
off. Old ready frames retain normal session traffic and report succession as
unsupported. Delivery and HTTP reads consume already persisted outer state and
recheck current access; a failed outer write cannot publish a new projection.

The transport cache is not durable authority or proof that every product store
has applied a revision. Server Favorites progress is described below; client
Track/Ask/draft replacement and browser acceptance remain separate work.

## Host access revocation and explicit recovery

Revoking a Host removes its credentials, connections, bindings and previews and
revokes its sharing grants. It retains succession freezes, relation history,
pending admissions and quota evidence. Revocation does not classify pending
operations as cancelled or erase a committed role decision. Old callbacks check
their original Host object, connection generation and relevant binding inside
the durable publication stage; equal string IDs do not restore old authority.

For a retained succession identity, the authenticated owner can create a targeted
invitation with `POST /v1/remote/pairings` and
`{ "purpose": "host-only", "recoverHostId": "..." }`. It binds the current
revocation ID and stored installation identity. Recovery reuses the logical Host
ID with a fresh credential and runtime Host object. It restores no old sharing
grants or native bindings and provides no proof of native session existence or
operation outcome. Pending native recovery still requires its own evidence.

Ordinary Hosts without retained succession authority keep ordinary revoke and
re-pair behavior. A historical `pre_effect` relation reset is an exact-intent
denial record, not recovery authority: preserve its original Host ID while
allowing a later ordinary pairing of that installation. It cannot authorize
recovery of that historical Host. Recovery identity capacity is reserved when
admitting new succession authority so access revocation does not need a new slot.
Do not delete historical records to free capacity.

## Client text persistence boundary

Queued recovery writes are not saved acknowledgements. A write result identifies
completed wrapper calls and reports serialization or partial storage failures.
Cancelled/superseded writes cannot acknowledge recovery. Protected clear-on-close
policy reports page-only retention, not refresh or disk durability. Draft-store
revisions are page-local and must not be reused as cross-reload recovery revisions.

On text save failure the existing Workbench keeps editing available and shows
Retry. Keep the page open until recovery succeeds; retry saves the current text.
Scope retirement fences both writes and late result publication. This prerequisite
does not yet move drafts between native sessions or complete multi-store projection.

## Atomic server Favorites projection

The owning tenant's committed Broker snapshot, Favorites replacement and exact
store acknowledgement share one outer state transaction. A's favorite ID, folder,
timestamp and slot survive A-to-B-to-C. A duplicate normal B slot yields to A;
confirmed B title and B's own parent/workspace metadata are retained. Inherited
display text never causes a native rename or transplants A's native parent to B.
Target-only and unstarred cases create no new favorite or tree. One aggregate
observable change advances the tree revision once; repeated replay does not.

Tenant `favoritesSuccession` version 1 records pending/applied acknowledgements
against exact existing freeze evidence. Legacy valid freezes acquire no fabricated
applied status. Missing authority/mapping, tree capacity or exhausted revision
retains pending progress without blocking durable native commit evidence.
Authenticated Favorites/stars requests and Host/provider publication can recover
that progress; no polling or native attachment is required. A failed outer write
publishes neither replacement nor acknowledgement. Recover the original operation
after uncertain persistence, never repeat native creation or input.

Ordinary owner saves and removes for a committed predecessor reject with generic
conflict, including current-tree-revision requests and unavailable successor
mapping. A shared-only viewer retains its separately authorized concrete A; it
acquires no B identity or access. Historical favorite schema and its navigation UI
must be implemented together in the client slice. Other explicit historical
addresses remain concrete.

The current Cloudflare SQL codec supports ordinary Relay2 only. It rejects newer
outer formats, Broker associations and Favorites progress before SQL writes.
This prevents silent loss; it is not SQL succession support. Complete durable SQL
encoding/decoding and restart acceptance are mandatory before enabling that backend.

## Ordinary relationship changes

A postcommit Side link edit has its own bounded durable operation identity. The
Broker reserves the request, the Host validates the complete native grant catalog
and gates the affected reader, then the Broker commits relationship metadata.
Only the exact acknowledged Host overlay update releases the reader gate. Pending
edits block conflicting succession and source-bound creation/import. Native sends,
TPM participants and already admitted recipient identities do not move.

Before reservation, a changed catalog invalidates an earlier Host description;
retry requires current facts. Duplicate operation identities retain their original
request and receipt. After metadata commit, recovery only proceeds forward through
status, exact apply and release. A timeout must not replace the operation identity
or be interpreted as a definite pre-effect rejection.

An absent status response alone does not prove that a timed-out request cannot
reserve later. Reset requires an exact durable pre-effect record in the same
Broker queue as reservation. Only a request with no reservation can receive that
record; an older in-flight request must observe it before reserving. A saved
reservation, even before metadata commit, remains reconcile-only. Failed reset
persistence cannot authorize clearing browser recovery state.

The browser retains operation identity by workspace and complete reader/relation
scope. A delayed response may clear only the exact operation it settles, never a
newer edit. Pending unlink remains reachable in the existing Side controls and
does not remove the local layout until the operation settles. Its authenticated
pending navigation source retains the current B management location even when
read authorization has returned to the immutable A grant. That navigation field
grants no source access and disappears from settled responses.

Unlink restores the reader's immutable source grant. A fixed A grant cannot read B
through an old signed B cursor. A fixed B grant can still read B's authorized
pending-context attachment, with matching durable succession provenance. Source
reads recheck gates and authorization after awaited I/O; retained cursors never
silently switch native targets.

A new reader created from current B may initially retain a fixed B binding. The
next B-to-C freeze validates and enrolls its real grant. Importing an old A reader
alone does not grant it current-B authority.

## Managed Claude source grants

Claude source grants are scoped by the canonical native profile and provider.
The optional explicit reference directory is useful for isolated Host deployments
and tests. Include it with the complete recovery set. Grants contain the actual
native persistence identity and saved base prompt/instructions, not arbitrary
JavaScript callbacks or a native readiness certificate.

New private grants distinguish an omitted base system prompt from an explicitly
empty prompt with `systemPromptProvided`. Legacy grants without that marker keep
their previous truthy-string interpretation. Invalid marker types/combinations
reject; do not edit fields to force recovery. Caller/TPM callbacks must be supplied
again after restart, while source callbacks are rebuilt from the grant. Native
saved model/permission settings are not overwritten from the grant handle.

Startup callbacks reject until actual native identity is confirmed and the grant
is saved. Read results are gated again after awaited history/routing and validation:
a disposed, transferred, replaced or unauthorized reader cannot release old data.
This preserves source-read authority; it does not settle native sends or certify
that the native session has no pending work.

## Backup and rollback boundary

Before any separately authorized deployment, preserve a coherent backup of the
complete recovery set and record its Controller installation and Relay authority.
The current stores provide no cross-store live-backup transaction. Independently
copying changing JSON files is not a certified coherent snapshot. Arrange a
quiescent backup boundary through the owning services rather than deleting locks
or restarting an active provider to obtain one.

Before a known commit, use the supported cancellation/reconciliation path where
its phase permits it. After a commit, recovery proceeds forward. Restoring an
older role or Relay file alone could forget an actual successor or native input;
it is not a supported rollback. Package rollback requires a writer compatible
with all retained state versions and must not undo native effects.

Current tests cover process reconstruction, exact replay, lost responses and
selected persistence failures. They do not certify abrupt power loss, arbitrary
filesystem failure, automatic backup restoration or native-provider process
recovery. Both role and context writes sync the file and containing directory
where supported. Pre-publication failure is distinct from uncertain publication
after rename; the latter poisons reads and writes in that process until durable
reopening. Windows keeps the existing unsupported-directory-sync exception and
does not gain a stronger power-loss guarantee. These separate files, TPM state
and Relay storage are not a cross-store durable transaction.
