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
| Relay outer state | Version 5 when association state exists | Legacy outer versions 2, 3 and 4 remain readable under their original inner-format rules; the next mutation containing associations upgrades the outer and inner state together |
| Broker association state | Version 3 | Versions 1 and 2 migrate with empty pre-effect reset records; version 1 also receives an empty relation-change list; legacy files containing newer safety fields reject |

An unpublished experimental Controller version-2 file without
`associationResults` is rejected, not migrated. Future or malformed versions also
fail closed. Broker association version 2 requires at least Relay outer version 4; Broker
association version 3 requires outer version 5. New safety fields must not be
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
