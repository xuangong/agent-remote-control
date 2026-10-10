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
| Controller role state | Version 3 | Committed versions 1 and 2 migrate with empty relation-change arrays; version 1 also receives empty admission/result arrays; ambiguous legacy association fields reject |
| Pending context | Independently versioned context store | Use its validator and delivery-state recovery; never derive it from role state |
| Relay outer state | Version 7 when Favorites succession progress exists; otherwise version 6 with associations | Legacy outer versions 2 through 6 retain explicit inner-format rules and complete-lineage validation; no applied Favorites progress is fabricated |
| Broker association state | Version 4 | Versions 1 through 3 migrate only with valid complete committed lineage; earlier additive relation-change/reset migrations remain explicit |
| Favorites succession progress | Version 1, requiring Relay7 | Bounded pending/applied acknowledgements identify an exact committed freeze and contiguous role revision; this is store progress, not another commit authority |

An unpublished experimental Controller version-2 file without
`associationResults` is rejected, not migrated. Future or malformed versions also
fail closed. Broker association version 2 requires at least Relay outer version 4; Broker
association version 3 requires outer version 5; version 4 requires outer version 6. Favorites progress requires outer version 7. New safety fields must not be
hidden behind an older version number. An older writer must not overwrite a newer format. Do not edit a
version number or delete recovery fields to make a previous binary accept them.

## Recover from facts, not elapsed time

| Persisted situation | Permitted behavior |
| --- | --- |
| Prepared and ready in the same verified runtime | Revalidate source/candidate and capture boundary before commit; cancellation retains the native candidate |
| Ready when the Host restarts | Restore as unknown; reconcile only if the original captured boundary and candidate can be certified again |
| History epoch changed after restart | Keep unknown and the admission fence; do not assume identical-looking history proves the old boundary |
| Host committed, Relay projection failed or response was lost | Read the exact durable decision, persist its projection, then acknowledge the saved association receipt; never roll back to the predecessor |
| Source creation returned and its exact result was durably recorded | Verify scope, operation, parameters, full native identities and original grant; attach that reader without another native create |
| Native effect has no durable result witness | Retain unknown; a matching grant alone is not proof of that operation |
| First-input dispatch accepted or uncertain | Keep its actual recipient and operation identity; do not replay or retarget it automatically |
| TPM recovery rejected before native access | Settle only the rejected recovery admission; retain the original unresolved creation |
| TPM recovery failed after native access or during outcome persistence | Keep the unresolved admission until matching evidence settles it |

Association release follows a durable Relay decision and exact Host acknowledgement.
A terminal Host decision alone does not authorize releasing the other side's
reservation. Old A-to-B status remains A-to-B evidence after a later B-to-C;
current navigation can independently resolve C.

## Authenticated committed replay

The tenant Broker freeze projection is the sole Relay commit authority. A legacy
top-level `sessionSuccessions` mirror migrates only if every full saved projection
exactly matches an authenticated committed freeze for that owner. Missing chain
prefixes, unmatched mirrors and contradictory surviving identities fail closed;
outer versions 6 and 7 forbid that duplicate field. Never synthesize a freeze from
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
recovery. Context writes sync the containing directory where supported; the role
store checkpoint uses a synced temporary file and atomic rename. Do not describe
these different guarantees as a cross-store durable transaction.
