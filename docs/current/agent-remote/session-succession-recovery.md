# Session succession state and recovery

Status: current implementation and recovery contract. The product action, Host
coordinator and production Relay storage are connected. Codex, Claude Code and
Copilot implement the evidence contract; each requested provider pair must pass
current Host capability and readiness checks. The current OpenCode 2.x adapter
reports Handoff unavailable because default native history cannot establish all
required execution selections. The [prior validation report](../../handoffs/2026-10-11-succession-provider-validation.md)
records the earlier pinned provider versions, not support for the new 2.x contract.
This does not imply deployment. Update the format table when schemas change.

## Supported configuration and product entry

Succession stays on the same Host and canonical working directory. Codex,
Claude Code and Copilot provide native evidence v2; ordinary provider
discovery alone does not establish Handoff eligibility. Both ends must provide
the required evidence, source access and bounded projections. Cross-provider
handoff transfers normalized context, not native credentials or runtime state.

OpenCode 2.0.25 or newer within 2.x remains available for ordinary shared sessions,
native prompt-edit forks and source references with the explicit
[Host callback plugin](../../opencode-callbacks.md). It rejects Handoff preparation
before effects. Public message sequence can prove an ordinary input began execution,
but it cannot prove its complete historical system-instruction selection, and the
experimental native event log is not persisted by default. See
[OpenCode native boundaries](../../opencode-native-boundaries.md) for the exact gap.

Enter `/handoff` in the primary Session View composer, or `/handoff <provider>`
to request a target provider. The compact chooser defaults to the current provider
and shows the working directory. `claude` also matches an available Claude Code
provider. An unavailable requested provider leaves the choice empty until the
user selects an available target. Choose **Hand off** to prepare and commit;
progress then appears above the composer. Successful handoff opens the current
conversation and closes the chooser automatically.
Pending messages block a new preparation until they are sent or removed; they
do not block status checks, reconciliation, or cancellation of a retained operation.

The authorized Host describes the current role, revision, cwd, target providers
and eligibility; preparation checks these facts again. It requires confirmed idle,
no queued input, approval, active child work or unsettled ARC mutation. It rejects
immediately rather than waiting for work to finish. Ordinary ARC writes to the
source and candidate are gated while the operation is active; this does not lock
independent native clients outside ARC.

Readiness comes from the adapter's current native observation, not a historical
idle marker. Claude combines a complete Stop task/cron snapshot with the result
for the exact input reporting no queued turns. Claude runs Stop hooks only after
a turn that ended normally, so the adapter also enables Claude's session state
events: their idle state ends a turn the model API rejected or the user
interrupted. Session crons are listed only by a Stop snapshot; after a cron tool
runs, an unknown wakeup counts as active work until the next snapshot. Every Stop
of the main agent updates the task/cron snapshot, including the Stop of a turn
Claude started itself, such as a fired one-shot cron that has deleted itself.
Without it, the deleted cron would block a prompt edit until the user's next turn.
The hook's `cwd` is the Bash tool's current directory, so it does not identify the
session. The other
adapters use their corresponding live native evidence. Reading a saved transcript
alone cannot establish that a runtime is idle or that an old interaction remains
actionable.

For a prompt edit, which stays with the current provider, the description reports
that provider's reason when it cannot prepare one, for example that Claude is
still working, instead of the general provider-pair message.

Preparation and commit send no model input. The first real successor input
receives the captured normalized history once. That first input must be plain
text with immediate delivery; image attachments and queued delivery are not
supported until its context delivery is confirmed. Subsequent inputs follow the
provider's ordinary capabilities. An uncertain first input keeps its actual
recipient and operation identity and is never automatically resent.

The website requests `succession/status` with `includeContext: true` to read the
Host's current context delivery evidence for that operation and native target.
This optional observation is not stored in the frozen succession receipt.
Offline or unavailable evidence preserves the first-input attachment restriction;
only a confirmed `materialized` state removes it. Ordinary status recovery does
not require this additional observation. The chooser also checks this browser's
pending messages before preparation, since the Host cannot observe unsent local
inputs.

Source references and TPM follow the stable role; concrete history and already
admitted deliveries retain their
original native targets. Favorites, Track and the primary pane follow the new
current session while existing Side/Ask sessions retain their own histories.
The current conversation's **Continued from** link opens its predecessor, with
older sessions under **Earlier history**. Opening that history retains the
concrete old session and disables sending there; choose **Return to current**
to continue.

One workspace-scoped, tab-local intent retains the original operation, source and
cancellation request across reload. Cancellation remains requested even when its
HTTP response fails; a late ready response cannot make that page commit. An
authoritative committed result still wins. A retained operation appears as an
inline notice after reload, even when its old source is offline or retired.
Automatic recovery performs bounded status checks while the page is visible and
Host access is available. It never creates a new candidate, reconciles or retries
commit automatically. Generic 409/404 responses do not prove non-admission and
never authorize another create or automatic resend.
When the bounded checks are exhausted, the notice says automatic checks stopped
and directs the user to Details. Focus and visibility changes do not restart an
exhausted round; the retained operation requires an explicit recovery action.

Open **Details** for **Check status**, **Reconcile**, an explicitly available
**Commit Handoff**, or **Cancel Handoff**. Cancellation is available while
preparation is still pending. Hiding details preserves the notice and operation.
Cancellation carries the complete original preparation identity: operation ID,
source provider and native session, expected role revision, and target provider
when selected. It also works when a projection-capacity or role-revision refusal
left no Broker freeze. The authenticated Broker first retains a cancellation-only
fence, then requires the Host's durable cancellation, readback and release. A 404
alone never clears the operation or permits another preparation.

A terminal decision is only the first part of recovery. After commit, authorized
replay and local projection must be applied and the current native binding must
be confirmed and synchronized. After cancellation or rejection, the original
conversation must be usable again. If a separately verified committed lineage
has already moved that role forward, recovery follows that lineage and confirms
its current binding; terminal response metadata alone cannot redirect the view.
Until these checks finish, sending or deferring messages, changing settings,
executing native commands and starting another Handoff remain disabled for the
affected primary conversation.
Draft editing remains available.

Refresh and native-binding confirmation have deadlines. A failed or timed-out
refresh retains the terminal decision and offers **Retry refresh**, which repeats
only observation, projection and connection restoration. It never repeats prepare,
commit or cancel. A cancelled or rejected operation offers **Done** only after
these checks succeed; an unknown or timed-out operation cannot be dismissed as
complete. Hiding the notice's details preserves its gate and original operation.

Upgrade the Controller, Relay and website together. The browser imports old
composition metadata once, then uses one v2 view document and explicit owner
pointers. Layout, text drafts and Ask open state remain tab-local; retained image
and preference ownership follows the configured storage policy. Do not maintain
parallel live composition models or clear unknown operations during upgrade.

## State ownership

The Controller owns the primary role, actual native recipients, pending context,
and operation outcomes. The authenticated Relay owns relationship metadata and
the projected decision. Browser navigation is a projection of those decisions.
Neither browser storage nor a native session ID alone can reconstruct authority.

The configured succession state directory contains:

| Relative path | Required recovery evidence |
| --- | --- |
| `roles/state.json` | Role lineage, revisions, decisions, enrolled relationships, exact source-creation results, relation-change receipts and unresolved admissions |
| `contexts/context.json` | Captured normalized context, first-input witness/outcome, mutation coverage and latest confirmed recovery handle |
| `source-cursor.key` | Signing key for existing source-history and context cursors |

The complete recovery set also includes Controller installation identity, native
source grants, TPM state and the Relay tenant's durable bindings, association
receipts and projections. Native provider transcripts remain separate. Copying
succession state does not copy a workspace, process, credentials or native session.

## Format boundaries

The table describes the current file parsers and retained recovery formats. It
does not promise mixed-version live writers or a rolling upgrade. Deploy all
components together; do not add compatibility branches for intermediate
development files or a second browser runtime model.

| State | Checkpoint format | Supported upgrade behavior |
| --- | --- | --- |
| Controller role state | Version 7 | Versions 1 through 6 retain explicit migration rules; legacy receipts gain no invented projection budget, source-witness reservation or optional native creation evidence |
| Pending context | Version 3 | Reads valid versions 1 and 2; optional prepared-input records use attachment version 3. Preparations share attachment capacity, and delivery-state recovery remains independent of role state |
| Relay outer state | Version 10 for configured succession accounting; version 9 with association-v5 writers; version 8 adds Host recovery metadata; version 7 adds Favorites succession progress | Restore10 requires complete encoding costs; successful accounting writes retain10. No-cost versions 2 through 9 preserve ordinary and exact saved recovery with explicit inner-format rules; no applied progress, budget or native result is fabricated |
| Cloudflare SQL snapshot | Metadata format 3; record/envelope/manifest format 1 | Format 2 migrates atomically on the first complete commit; old readers reject 3. The production entry installs the complete codec and cost-backed enrollment |
| Broker association state | Version 5 | Versions 1 through 4 retain explicit migrations and valid complete committed lineage; saved freeze-v1 identities remain unchanged. An optional `cancelOnly: true` on a Broker row identifies a v1 cancellation-only obligation and forbids a committed projection |
| Enrollment freeze | Version 2 for new preparation | Requires an immutable positive safe-integer `maxProjectionBytes`; exact saved version-1 recovery and cancellation-only v1 enrollment remain supported without retrofitting a budget. A new v1 receipt cannot prepare a native candidate |
| Favorites succession progress | Version 1, requiring Relay7 or later | Bounded pending/applied acknowledgements identify an exact committed freeze and contiguous role revision; this is store progress, not another commit authority |
| Host recovery metadata | Revoked Host mappings and targeted invitations, requiring Relay8 | Owner recovery binds Host ID, installation ID and revocation ID; previous credentials, bindings and sharing grants are not restored |

An unpublished experimental Controller version-2 file without
`associationResults` is rejected, not migrated. Future or malformed versions also
fail closed. Broker association version 2 requires at least Relay outer version 4; Broker
association version 3 requires outer version 5; version 4 requires outer version 6;
version 5 requires outer version 9. Favorites progress requires outer version 7.
An extension must preserve older readers' fail-closed behavior; incompatible
safety semantics require a new format version. An older writer must not overwrite
a newer format. Do not edit a version number or delete recovery fields to make a
previous binary accept them.

Role7 retains the original optional native creation outcome; context3 retains an
evidence-v2 nested prepared-input witness and bounded latest confirmed recovery
handle. The witness separates adapter `inputId`, proven `nativeInputId` and
optional execution `nativeExecutionId`; the unpublished earlier witness schema
is not a parallel supported writer. Older layouts carrying these new fields
are rejected as ambiguous. The actual role6/context2 readers reject files written
by the new stores and cannot overwrite them. This format support alone does not
connect an optional native producer or enable succession.

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
The production Relay installs the existing allowance and atomic terminal
consumers. Native producer readiness remains a separate adapter fact; the
projection bound itself does not certify a native session.

## Relay accounting admission

Configured accounting performs a pure startup preflight and asserts the complete
staged snapshot immediately before storage. It measures actual retained feature
records and conservatively quotes all remaining outcome, header, slot and revision
growth. The sole SQL codec owns envelopes, manifests and per-record chunk counts.
The 8,388,608-byte shared feature envelope charges logical-envelope bytes plus
manifest bytes across tenants; unrelated ordinary data is not charged wholesale.
This does not measure physical SQL allocation or guarantee a memory limit.

New freeze selection uses the real Host, authenticated tenant and complete
post-increment Broker draft. The saved ceiling never shrinks or changes on retry.
The final outer gate may refuse a stale fresh quote before persistence or Host
preparation; exact queued duplicates perform no write or revision increment.
Branded admission failure alone proves no earlier native-effect disposition:
only explicitly pre-effect callers may report a safe, non-poisoning refusal.
Post-native or unknown-durability failures preserve existing reconciliation rules.

A new cancellation-only Broker row retains `cancelOnly: true` beside its v1
receipt. It reserves the actual remaining cancellation bytes and association
revision, without a projection or Favorites obligation. Unmarked unresolved v1
receipts still lack a finite projection bound and fail accounting preflight.
Another unreleased freeze on the lineage blocks a new cancellation fence before
it is saved; the same original cancellation can be retried after that operation
settles. Insufficient storage or revision headroom cannot produce cancellation
success. A saved fence survives restart and prevents a late prepare from creating
a candidate, even if the cancellation acknowledgement was lost.

Configuration alone does not write storage. Its successful mutations, including
ordinary-only changes, write outer10 without downgrading. Restore10 without both
cost methods refuses before runtime availability; prior readers reject10 on
restore/reload. No cross-version live-writer CAS is promised. No-cost outer<=9
ordinary and exact legacy recovery remain supported, without fresh Hosted
preparation. Source/relation and terminal succession/Favorites consumers use the
atomic boundaries below. The production entry uses configured accounting.

## Atomic Relay source completion

A participating source creation saves its complete admission and applicable
shared reservation before native dispatch. Its terminal mutation retains the
complete binding and creation tuple, completes the exact shared receipt, removes
the admission and increments the association revision once. Broker maps and
successful replies wait for that same outer mutation and required storage sync.
Source completion releases only its future growth allowance; complete ordinary
binding, creation and quota records remain saved.

Exact unresolved recovery reads the saved source-result and attaches the proven
native identity without another create. Missing or contradictory evidence stays
unresolved. Only an explicit fresh Host rejection can enter the safe terminal
release path; access revocation, transport failure and uncertain storage do not
provide that proof. Caller and source access are rechecked after queued work and
immediately before native dispatch, including after source-result readback.

Durable admissions and owned in-flight claims protect collection/revision
capacity before ordinary create or attach. Exact relation replay leaves order
and revision unchanged; a lost release response advances only the remaining
terminal phase. A successful attach with an identical durable record still
confirms its current runtime generation, without another write or attach.

## Source-witness admission

Fresh qualified source-reader creation retains
`sourceWitness: { version: 1, scope, operationId }` in the existing Host admission.
The role-file owner reserves the complete future result plus one array comma,
without credit for the admission removed at completion. Every mutation and
restart recomputes that allowance alongside local-preparation reservations;
ordinary mutations cannot spend it. Complete result and admission removal share
one awaited file mutation. Unknown publication remains fenced until reopen.

The trusted acknowledged-v2 route requires a separate certificate from the
actual policy-wrapped directory before native creation. Concrete Codex, Claude,
Copilot and OpenCode adapters declare a native ID bound for ordinary creation;
their directories certify only that path while open. Codex custom `spawn`
producers, absent or invalid bounds, and edit/native-fork inputs are not
certified. Source history, callbacks and durable grants remain independent
requirements. Ordinary routes retain their existing policy; an exact saved
result and matching grant recover before fresh certification. Old pending
admissions receive no invented descriptor or permission to recreate.

The bounded native ID has at most 512 UTF-16 units and at most 3074 JSON bytes.
The binding owner checks the actual canonical result for fresh qualified output,
preserving legal aliases. This post-effect check does not guarantee successful
projection: a wider existing canonical identity leaves the witness retained and
the operation unresolved. Exact recovery never silently rewrites its identity.
Atomic Relay source completion and Host grant publication remain separate files.
The grant write now awaits private exclusive temporary-file write, file sync and
close, rename, then containing-directory open, sync and close. The original
hashed filename, opaque native handle, prompt-presence marker and instructions
are unchanged; no grant format or capacity allowance is added. Only then may the
role-file owner publish the complete exact source result and remove admission.
Matching grant alone never proves which admitted operation created its reader.

Before a rename attempt, a file-publication failure is rejected publication and
keeps the preceding saved file. Once rename is attempted, rejection or a failed
directory barrier is unknown publication; get/list and queued grant mutations
are fenced in that store instance. Fresh recreation validates the complete file
the filesystem exposes. Missing, malformed or conflicting grant/result evidence
stays unresolved without replay or restoration of predecessor authority. Native
creation already preceded the grant, so even rejected grant publication cannot
become safe native rejection. Local-control disposal is not native rollback;
its failure retains both publication and disposal causes.

Cursor initialization writes and syncs a private 32-byte temporary key and links
it without replacement. EEXIST reads the winning original key. Both installation
and existing-key reopening validate that key and await the containing-directory
barrier before service readiness; failure never rotates the historical key.
Cleanup cannot hide the original initialization cause.

## Recover from facts, not elapsed time

| Persisted situation | Permitted behavior |
| --- | --- |
| Browser retains a preparation intent but the Broker has no freeze | Explicit cancellation supplies the original identity and retains a cancellation-only fence before Host cancellation; status 404 alone never releases the browser gate |
| Terminal decision is known but the affected primary binding is not synchronized | Retain the decision and mutation gate; a failed or timed-out refresh offers an explicit observation/connection retry without repeating the mutation |
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

The original live TPM invocation subscribes to native acceptance through both
ordinary sends and prepared first-input delivery. Late exact execution evidence
updates its existing outbox intent without changing recipient, role revision or
operation identity. Duplicate evidence and a later transport failure cannot undo
confirmed execution. The callback is dispatch-local and is not serialized into
public operation parameters, fingerprints or durable records.

This notification is not a cross-restart receipt guarantee. If the Controller
restarts with an accepted intent but no retained started/handled evidence, that
intent remains unsettled and can prevent another handoff. Closed coordinators
ignore old callbacks. There is no automatic replay, inference from later idle
state, or new manual override for accepted-without-execution evidence. Preserve
the record; do not delete it to force eligibility.

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

These boundaries cover Host entry points, not independent native writers. Native
readiness, SQL admission and product recovery remain separate checks; passing one
does not bypass another.

## Role routing and role extensions

Two routings resolve where work addressed to a session goes after its committed
successions. Native-prefix routing (`resolveNativePrefix`) follows prompt-edit
branches only and fails across a generic succession, whose successor starts from
captured context instead of the native history; source-reader ancestry, prompt-edit
metadata, TPM and Ask use it. Role routing (`resolveRoleSuccession`) follows every
committed succession of the role, including a handoff to another provider; Team
seats use it on the Controller and the Relay, so a Team member's seat, messages and
roster entry follow a handoff. Both validate the complete committed lineage first.

Some sessions get Controller tools from a role, such as a Team seat. On the
Controller each such role implements `SessionRole`
(`packages/agent-host/src/session-role-succession.ts`): it gives the extensions of
the role a session holds, bound to the session that runs them, and decides whether
a generic succession may keep the role. A Team seat may move when the Relay
acknowledged Team succession and the target provider runs session instructions and
tools; a TPM session may not, and its handoff is refused before preparation with the
role's reason. Sessions without a role move freely; a Side or Ask keeps reading its
source through the source relation.

A generic successor takes its source's role from creation. The Controller passes the
role's extensions to `createEmpty`, where a provider that fixes tools at native
creation registers their definitions (Codex), and attaches the successor, before and
after commit, with the extensions of its source's role bound to the successor. The
role's tools check routing on every call, so they run only on the session that holds
the role: the successor's are fenced until commit, the predecessor's afterwards.

## Provider evidence and recovery

Native evidence uses either a trusted service namespace or an owned runtime.
One native observation serves both ordinary session state and evidence. Exact
input materialization and positively correlated execution start are distinct;
neither idle nor an uncorrelated assistant record settles an unknown input.

Claude and Copilot allocate bounded empty descriptors without a model request.
Only explicit Host `initializeEmpty` permission allows initializing that exact
identity when its durable context is pending, all prior deliveries were rejected
before dispatch, and mutation coverage is intact. Missing native history alone
never authorizes initialization. Existing native history resumes normally.

The original creation handle proves candidate identity. A separate latest
confirmed handle retains subsequent settings throughout the lineage. Host
reserves bounded storage before a setting change, then saves current adapter
readback through the existing observation/runtime-info path. Native refusal can
still confirm a different applied value; that value is retained before the error
settles. Persistence failure remains uncertain. Shutdown drains admitted setting
and recovery work before native cleanup. Pending setting targets are not saved as
confirmed configuration.

Codex binds native `clientId` to its user record and containing turn. Claude binds
its exact user UUID and uses positive live correlation for execution; cold history
can prove materialization without proving start. Copilot's native send receipt
binds its user and turn-start events only in the original attachment; losing that
binding can leave cold recovery unknown. No provider may replay merely to obtain
missing evidence. See the current [provider validation](../../handoffs/2026-10-11-succession-provider-validation.md)
for exact tested versions and separate validation layers.

## Prior native research and OpenCode/common baseline

These experiments explain the original constraints; the empty-descriptor
implementation above supersedes the earlier Claude feasibility limit.

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

Both cuts passed independent review and a fresh Root run. At that 1.18.x baseline,
the opt-in `test:opencode:succession-evidence` entry used an explicit reviewed
executable, isolated profile, restricted loopback sandbox and a 120-second outer
deadline; an optional evidence output had to be a new absolute path. Ordinary
collection skipped it. These historical results do not certify queue/work
coverage, callback-enabled production configuration, multipart input, native
completion, Host integration or power-loss durability. They do not establish
OpenCode 2.x Handoff support. The current entry instead verifies ordinary input
recovery and rejection of unsupported Handoff before native effects; see
[OpenCode native boundaries](../../opencode-native-boundaries.md).

The prior baseline's actual-adapter test separately used the installed OpenCode binary and
the built production adapter, without an injected native verifier. It covered
ordinary A input, empty B with exact selections, prepared first B input, ordinary
B input, empty C and exact C resume through a new provider instance. Empty
creation/attachment made no model request. A callback-enabled native test also
created an empty B, restored its Host tools and sent one prepared input through
the real plugin. Both used isolated profiles and a loopback model fixture, not a
commercial model. Host/Gateway/browser and Cloudflare production-entry transport
tests are separate evidence, not one combined native full-stack run.

In that OpenCode baseline, authority is a trusted service namespace, never a
process or database ownership assertion. Exact user U proves materialization only; a non-summary
assistant R in B with parent U proves execution started, not task completion.
HTTP 204, idle and an unrelated assistant message do not settle an input. The
existing context store saves a dirty ARC-coverage marker before native effects.
After a cold restart, an ordinary unknown marker fences handoff and prompt edits of
its session for five minutes (`RESTART_SETTLE_MS`). Succession separately requires
the native session to be idle with no pending input, approval or child work, so the
fence then lifts and settlement removes the clean marker; the Controller also
reconciles markers of sessions nobody reopens once the restart settles. While fenced,
eligibility reports `succession_restart_settling` with the remaining time. Markers
used to remain permanently: every restart during active work locked that session,
and the shared marker list could fill and reject ordinary mutations of every session.
The residual risk is an input a surviving runtime (shared Codex daemon, OpenCode
server) accepted before the restart but starts more than five minutes later while
reporting idle; that turn would land in the predecessor. A prepared first input
still recovers only from its original persisted identity and exact native evidence
and keeps its fence. Process-local operation deduplication is not a restart guarantee.

## Local preparation and cancellation

Preparation saves bounded normalized history before calling native create. The
private role record distinguishes not-started, create-started and candidate-known,
and saves the exact creation identity and zero-task guarantee for that attempt.
Legacy phases alone cannot supply those facts. Binding moves the saved context
preparation into an attachment; it does not capture again or send native input.

Optional native evidence preserves the complete original creation result in local
progress, separately from the ordinary runtime persistence handle. Successful
creation retains its verified-resume handle. Known rejection retains the actual
candidate but does not authorize opening it. Unknown outcome identifies no
candidate; only a typed definite pre-request rejection can use the separate
`not_dispatched` terminal result. Exact repeats cannot replace these outcomes.

Host consumes that same original envelope before candidate workspace lookup or
attachment, including a cancelled late candidate retained only as an orphan.
Known rejection remains non-resumable after restart. Explicitly opening a
successful orphan requires the original verified handle and never revives the
cancelled role transition.

Optional first-input preparation composes context and text once, persists its
witness, then dispatches under the original Host mutation identity. Restored
unknown delivery is inspected without preparing or resending. The actual leased
source/candidate facades and observation tokens stay current through the final
synchronous store assertion; materialization does not settle their queued effects.

Cancellation can settle a certified create while its call is still pending. The
terminal decision must persist before releasing the source. A late result only
adds bounded orphan evidence; it cannot bind context, commit, recreate, send input
or automatically delete the unused native session. A failed terminal write keeps
the prior reservation. Unknown role publication and first-input delivery do not
use this cancellation rule.

For a known candidate, context binding precedes native readiness inspection so
the Host can authorize zero-input initialization of an empty descriptor. A
cancellation settled before binding prevents both binding and inspection. If
binding has already completed, its durable context is retained across restart;
late inspection cannot make the operation ready or committed. The retained
descriptor does not grant input authority: first dispatch still requires the
committed current role and revision and otherwise reports
`succession_not_committed` without sending anything to the provider.

Both local stores retain their 8 MiB limit. Preparations and attachments share 512
slots; each attachment retains at most 512 input deliveries. Preparation admits
actual context plus finite binding/terminal/recovery growth. First input separately
admits its actual serialized content and finite settlement before dispatch, with
the existing 1 MiB raw-input limit. Capacity rejection leaves context pending for
a smaller explicitly submitted input. Native proof is checked at its actual size;
an oversized proof leaves the old accepted/unknown receipt unchanged. No retained
history is deleted to make room, and no arbitrary future-input capacity is promised.

For optional evidence, admission reserves the complete remaining original-result
growth, including a late cancelled candidate. A prepared input stores its witness
as a nested object and reserves the exact maximum proof allowed by that witness,
including enclosing JSON escaping and settlement state. Accepted, unknown and
restored deliveries retain that reserve; unrelated writes cannot consume it.
Positive materialization must match the original context, input, native target,
witness and selections. It does not prove execution completion, settle queued
work or permit replay. Legacy evidence retains its previous meaning.

## Authenticated committed replay

The tenant Broker freeze projection is the sole Relay commit authority. A legacy
top-level `sessionSuccessions` mirror migrates only if every full saved projection
exactly matches an authenticated committed freeze for that owner. Missing chain
prefixes, unmatched mirrors and contradictory surviving identities fail closed;
outer versions 6 and later forbid that duplicate field. Browser state cannot
certify a preparation freeze or committed projection. The cancellation-only path
validates the original selection against Host-owned lineage before retaining its
fence. Never remove recovery evidence to make an older writer accept it.

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
has applied a revision. Server Favorites progress is described below; the client
applies authorized revisions through its single composition owner. Stable view
and payload owners preserve Track, Ask and drafts without retargeting queued sends.

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

Current recovery completion is derived from the complete credential identity or
used invitation matching the current Host, installation and revocation marker.
Missing Host metadata or a device key retains the applicable full construction
and collection/header allowance. Complete saved Host/device records end only
that future construction allowance. Actual distinct recovery device rows and
invitation history remain fully charged; historical use alone does not reserve
every future rotation or grant new authority. Contradictory identities require
reconciliation rather than silently dropping their evidence.

Each requested rotation admits its full old/new-key overlap before publishing
the new credential. Only the original connection's exact pending credential,
Host generation and saved key row can acknowledge completion and remove old
keys. Reconnect/restart preserves retained recovery overlap; possession of one
key does not prove which key is newer. When the original volatile identity is
lost, further issuance reports `rotation_pending` and explicit revoke followed
by targeted recovery can be required. No secret is persisted to guess that order.

Terminal projection and Favorites progress remain one outer mutation, with
runtime publication, successful reply and Host release after storage completion.
Transaction abort retains the preceding complete snapshot. Rejected sync is
unknown durability: keep the original identity and validate the complete state
exposed by fresh reopening, without repeating creation or credential issuance.
The isolated Node/Worker consumer tests verify these publication boundaries;
they do not establish physical reservation, external Gateway rollback or
power-loss durability.

## Client text persistence boundary

Queued recovery writes are not saved acknowledgements. A write result identifies
completed wrapper calls and reports serialization or partial storage failures.
Cancelled/superseded writes cannot acknowledge recovery. Protected clear-on-close
policy reports page-only retention, not refresh or disk durability. Draft-store
revisions are page-local and must not be reused as cross-reload recovery revisions.

On text save failure the existing Workbench keeps editing available and shows
Retry. Keep the page open until recovery succeeds; retry saves the current text.
Scope retirement fences both writes and late result publication. This primitive
reports text persistence; the composition application owns draft-owner retention
and the complete replacement projection described below.

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
acquires no B identity or access. Historical favorite records and navigation retain
explicit history intent. Other explicit historical addresses remain concrete.

The complete Cloudflare SQL codec retains validated Relay/domain versions,
ordered complete identities, optional presence, recovery credentials/history and
hash-sensitive freeze/Favorites evidence. Both records and order headers use
BLOB chunks of at most 262144 bytes. Restore verifies exact bytes, identity,
coverage and original domain validators; it never reconstructs evidence from
current bindings. Format-2 migration cannot recover data that the old codec had
already omitted.

All rows, legacy removal and the format marker share one `transactionSync`.
Awaited `sync()` precedes cache/current/Broker/reply publication. Transaction
failure rolls back the SQL changes; sync rejection instead fences further writes
until validated reopen of the complete snapshot actually exposed by storage.
Neither outcome authorizes repeated native creation or input.

The production `RelayObject` installs this complete codec and its trusted cost
functions with succession enrollment enabled. The development-only constructor
gate is removed. Default store validation, legacy SQL import, transaction and
unknown-sync fences remain in the same implementation. Actual production-entry
Miniflare tests exercise public prepare/commit, cold HTTP/WebSocket replay and
Favorites continuity using a deterministic Host peer. They do not establish
native-provider readiness, production resource limits or deployed availability.

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

## Prepared first-input echo recovery

The first input keeps the complete history prefix in the authoritative native
user message. The Host adds `command_acknowledged.payload.submittedTextSha256`
from the durably validated prepared-input witness before the shared operation
cache retains the result. This evidence is independent of native input
acceptance, including adapters returning `void`. This is
the SHA-256 of the exact submitted UTF-8 text, without trimming or newline
normalization. It does not change `started`, `queued`, or `handled`, and is not
native materialization, execution, or completion evidence.

The Remote outbox retains the digest with the caller's original input and waits
for the complete text-only native echo in the same agent and timeline epoch,
after the saved sequence cursor. A prefix/suffix match, different whitespace,
an image-containing message, or a matching echo in a replacement epoch cannot
confirm that delivery. Echoes consumed by other local sends remain excluded
across reload and late acknowledgements. Browser digest computation rechecks
the current replica before settlement.

A lost acknowledgement leaves the original uncertain input visible; the client
does not resend automatically. A new explicit operation clears old submission
evidence. Ordinary sends without a submitted-text digest retain their existing
matching behavior. The optional acknowledgement field requires compatible
strict-schema receivers throughout the route.

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
recovery. Role, context and source-grant writes sync the file and containing
directory where supported. Failure before a rename attempt is distinct from
uncertainty after that attempt; the latter fences reads and writes until validated
fresh reopening. Cursor readiness also waits for its containing-directory
barrier. Sync/close and cleanup errors retain the first cause. Windows keeps the
existing unsupported-directory-sync exception and
does not gain a stronger power-loss guarantee. These separate files, TPM state
and Relay storage are not a cross-store durable transaction. New ancestor
directory entries are not individually synced; application restart and controlled
fault/reopen evidence does not certify OS-crash or power-loss behavior.
