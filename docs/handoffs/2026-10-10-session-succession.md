# Session succession implementation handoff

Date: 2026-10-10. Audience: the next implementation session or maintainer.
Status: partially implemented; no usable end-to-end handoff yet.

## Local Worker operating checkpoint (2026-10-11)

Task 9E passed independent spec and quality review after one finalization fix.
Root freshly passed all 24 declared operating sequences, five failure-record
tests and both production/fixture typechecks on the final source. The unchanged
shared accounting fixture had separately passed 27 tests, and the ordinary
test entry passed a focused sample without relying on ignored plan artifacts.

The real Miniflare Worker/SQLite fixture covers six bounded datasets, exact
restart readback, admitted terminal/Favorites/recovery consumption, pre-effect
capacity refusal, transaction rollback and uncertain post-sync publication.
Cleanup failure now retains the primary failure and still attempts to save the
sample; evidence-write failure remains explicit. No production code changed.
Measured values and limitations are in
`docs/current/agent-remote/session-succession-operating-evidence.md`.

Task 10A next separates immutable local fork delivery provenance from current
navigation. Tasks 10B/10C then close Ask target routing and recoverable product
composition. Native D1/D2 evidence, product/browser and whole-branch acceptance
remain open. Production capability, SQL effects and native suppliers stay gated.

## Host grant and cursor implementation checkpoint (2026-10-11)

Task 9D passed independent spec and quality review without retained findings.
Root freshly passed seven scoped Host files / 183 tests and the Host typecheck;
real-file fault/reopen and local HTTP/WebSocket fixtures were used, with no native
provider execution. Source grants reuse the role/context publication helper: private
exclusive temporary-file write, file sync, close, rename, containing-directory
open, sync and close. Pre-rename-attempt failure is rejected publication; any
attempted rename with rejected promise or later barrier failure fences the owner
as unknown. Sync/close and cleanup failures retain the original cause and stage.
Grant get/list and queued writes stop until fresh validated recreation; no schema,
identity, prompt-presence, instructions or opaque native handle is rewritten.

Codex, managed stdio and OpenCode creation retain native completion before grant
publication. Failure cannot grant replay permission; disposal is local-control
cleanup, not native rollback. Both failure causes remain available when disposal
is uncertain, and source callbacks do not gain a reader identity before success.
The separate role-file result requires exact matching grant evidence. Unknown
result publication can recover only its saved exact operation on fresh reopen;
a grant without that result remains unresolved.

The cursor key remains an install-once 32-byte private key using link/EEXIST
readback. Installation and reopening wait for the containing-directory barrier
before readiness, retain the winning key and preserve initialization causes.
Formats remain role6/context2/sourceWitness1, configured Relay10/associations5,
freeze2/exact saved1 and SQL metadata3/record1. Backup requires the existing
coherent owning-service boundary; recovery after native effects proceeds forward.

Implementer evidence uses owned temporary filesystem fixtures, scripted native
protocol peers and real local HTTP/WebSocket tests with both deadlines. It does
not certify OS-crash, power-loss, new ancestor-entry sync, native-provider support
or product readiness. Selected Windows directory-sync exceptions remain explicit.
Task 9E's separate local measurements are recorded above. Production enablement
and native/product acceptance remain pending.

## Terminal and recovery consumption checkpoint (2026-10-11)

Task 9C3 passed independent spec and quality review without retained findings.
The existing terminal projection/Favorites transaction is reused. Current
recovery identities retain complete missing registration/issuance allowances;
actual device overlap and invitation history remain charged. Complete saved
Host/device records do not reserve permanent future rotations. Explicit fresh
pairing/rotation refusals stay pre-effect; terminal and uncertain storage outcomes
retain their original evidence and failure classification.

Credential publication and acknowledgment validate the original Host, connection,
generation and saved key. Reconnect after an interrupted recovery rotation
preserves overlap, refuses another issuance and can require explicit revoke and
targeted recovery. It cannot infer old/new key order from retained rows alone.
Full-budget revoke removes access while retaining complete succession, relation,
Favorites and quota/history evidence.

Root freshly passed 172 Hosted and 90 Cloudflare cases plus both typechecks.
The 42 Node/Worker consumer fault cases are included in the 262 total. Hosted
recovery tests use real HTTP/WebSocket with a direct Broker fixture; terminal
tests use the normal Gateway fixture. Node/Worker storage cases use real SQLite
and Miniflare/workerd with deterministic fake protocol peers. Rejected sync is
unknown durability, not rollback. No native provider was run.

The reviewed 9D/9E checkpoints above are followed by product integration.
Default SQL effects, native suppliers and
production capability remain disabled. No merge, push, deployment, installation
or user-service change is authorized here.

## Atomic source completion checkpoint (2026-10-11)

Task 9C2 passed independent spec and quality review after one scoped fix round.
The existing Broker/outer Relay mutation now saves the complete source binding,
creation key/fingerprint/result, applicable shared quota completion, admission
removal and terminal revision together. Exact unknown recovery uses the saved
source-result and attach; it never repeats native creation. Relation replay
spends only its remaining phase/revision, and ordinary requests cannot consume
durable source claims or another in-flight operation's reserved capacity.

The review fixes recheck current caller/source access immediately before each
native effect, and confirm a successful attach's runtime generation even when
its durable record is unchanged. The latter preserves the no-write behavior
without sending a redundant recovery attach. The queued-revocation regression
proves the exported Broker consumer boundary through a real HTTP/WebSocket
fixture; it does not claim to reproduce Gateway's separate control-proof queue.

Root freshly passed 117 Hosted and 47 Cloudflare tests plus both typechecks on
the revised source. The five new regressions are included in those totals.
The source/relation SQL tests cover transaction rollback, held sync and rejected
sync/reopen through actual Node and isolated workerd consumers. Unknown sync
durability is not described as rollback. The unchanged capacity-only tests retain
their earlier 14-test verification; no native fixture was run in this slice.

The terminal/Favorites/recovery continuation is now covered by the checkpoint
above. Host grant barriers, local Worker measurements and product integration
remain separate gates; none of these scoped checks enables production.

## Relay accounting checkpoint (2026-10-11)

Task9C1 passed independent source-spec and quality review with no blocking
finding. The configured accounting runtime derives retained evidence and complete
remaining outcomes from each complete staged snapshot. One internal two-method
cost interface uses the actual SQL codec; each record costs its logical-envelope
bytes plus exact manifest bytes. The shared 8,388,608-byte feature envelope spans
tenants and is not a whole-state quota or a physical storage reservation.

Fresh freeze admission saves one immutable projection ceiling before Host
preparation. A stale quote can be refused at the final outer mutation without
reselection, publication or forwarding. Only explicitly pre-effect policy
refusals keep both queues available; native-outcome and storage uncertainty retain
their failure/recovery boundaries. Source/relation/recovery/Favorites consumers
still require the following slices.

Accounting configuration performs a no-write preflight. Every successful durable
mutation under that configuration writes outer Relay10 monotonically; restore10
without the complete cost interface refuses before runtime availability. Old
Hosted and complete SQL readers reject10 on restore. This is not a live-writer
CAS guarantee. No-cost outer<=9 ordinary and exact saved recovery remain available;
Hosted fresh preparation requires the full accounting configuration.

Root freshly passed 109 Hosted tests, 38 Cloudflare tests, an actual frozen-BASE
prior-reader check, both affected typechecks and the Hosted build. These include
real HTTP/WebSocket admission and isolated workerd SQLite transaction/sync/reopen
checks. Review suggestion T9C1-M1 remains on the whole-branch list: independently
measure payload bytes in the all-record escaped-tuple quote test rather than
derive them from the quote helper's framing. No incorrect current quote was found.

The later checkpoints above complete 9C2's atomic source/relation consumers and
9C3's terminal/Favorites/recovery consumers. They are followed by 9D/9E and
product integration. Default SQL effects, native suppliers and production
capability remain disabled. The9C0 execution incident below remains unresolved
as an independent cleanup claim; no native fixture was run for9C1.

## Host source-witness checkpoint (2026-10-10)

Task9C0 passed independent source-spec and quality review. Role-file 6 retains a
versioned source-witness descriptor and recomputes its complete future-result
allowance on every mutation and restart. Qualified v2 creation uses the same
policy-wrapped directory for certification, creation and grant verification;
exact saved results recover before fresh certification. The existing binding
owner validates the actual canonical result without changing ordinary aliases.

Root verified the 15-file freeze and freshly passed 163 Host tests, 19 Relay
tests, both affected typechecks, the Relay build and the actual role-file5
writer rejection of version 6. No real directory received a producer certificate.
Post-effect canonical projection failure retains the exact witness and remains
unknown; it cannot repeat native creation. Relay aggregate/atomic completion,
source-grant durability, native readiness and product work remain separate gates.

The implementer's broad Host command accidentally collected real-native local
fixtures despite the slice's no-native constraint. The report preserves that
incident, the failed broad results and missing independent descendant/temporary
resource cleanup evidence. Later validation uses explicit test-file lists. Four
stale v1 Host fixtures were migrated and revalidated; the unchanged Relay
planning-command and Copilot local interrupt failures remain whole-branch
acceptance concerns. Source approval does not erase those historical failures.

Next is 9C1's derived Relay capacity and immutable freeze admission, followed by
9C2/9C3 terminal/recovery consumers, 9D durable grant barriers and 9E local Worker
acceptance. Production capability and SQL effect guards remain closed. No merge,
push, deployment, installation or user-service change is authorized here.

## Complete SQL codec checkpoint (2026-10-10)

Task9B passed independent spec/quality review without findings. SQL metadata
format 3 and record format 1 retain complete domain evidence and collection order,
including chunked headers, recovery history and Favorites. Exact UTF-8 records
use BLOB chunks of at most 262144 bytes. Format-2 migration, legacy writer fencing,
full integrity/coverage validation and per-record cost reporting are implemented.

One existing transaction owns all rows and the format marker. Cache and runtime
publication await `sync()`; sync rejection remains unknown durability and fences
writes until reopening. The production effect guard remains closed on both
restore and commit. The isolated constructor token has no production supplier.

Root verified all seven frozen sources and freshly passed the complete Cloudflare
suite (20 files / 102 tests), Cloudflare/Hosted typechecks and the actual baseline
format-2 reader rejection test. Evidence is in the plan workspace and
`.tmp/root-task9b-*.log`. The implementer's earlier diagnostic alias build failure
is retained separately; the final Root run passed all collections.

Continue with Host source-witness capacity/certification routing (9C0), Relay
feature-envelope admission and atomic source completion (9C), then the durable
grant boundary (9D) and product composition. These remaining gates and real
provider certification still prevent end-to-end enablement. No merge, push,
deployment, install or user-service change is authorized by this checkpoint.

## Bounded projection checkpoint (2026-10-10)

Task9A passed independent spec/quality review with no findings. New enrollment
requires feature-v2 acknowledgement, an immutable freeze-v2 byte ceiling, a Relay
allowance selector and an adapter-backed bounded producer certificate. Authority
v1, uplink v2, context v2 and committed projection v1 remain unchanged. Host role
file v5, Broker associations v5 and outer Relay v9 fence older writers while
preserving exact legacy freeze-v1 recovery without invented budgets.

The Host measures the complete conservative committed projection after staging
all participants and the association revision, then rechecks the saved ceiling
before `create-started`. Private file growth is a separate check. Committed
output invariant failures retain full evidence and remain explicit on saved
authenticated recovery paths; they cannot cause repeated native creation.

Root verified all 24 frozen source files and the complete patch, then freshly
passed 161 tests in 11 files and 50 adjacent tests in 5 files. Protocol/Relay/Hosted
builds, Host/Hosted typechecks and diff checks passed. Reports, source manifest
and scoped review are in the plan workspace; fresh logs use
`.tmp/root-task9a-*.log`. Real producer certification, Relay aggregate allowance,
SQL codec and product integration remain separate gates. Next is Task9B's complete
SQL representation, followed by Host source-witness admission and Relay admission.
Production capability and effectful SQL succession remain disabled.

## Shared mutation admission checkpoint (2026-10-10)

Task8B1 and its first fix round passed independent spec/quality review. The
existing operation cache now owns entry-bound native and asynchronous mutation
handles. Admission is synchronous before asynchronous validation; an exact retry
observes the original entry without acquiring another grant or repeating effects.
Only succession-enabled targets pin unsettled entries, within the reserved entry
and byte budgets. This is process-local retention, not a durable generic ledger.

Source reservation, synchronous candidate registration and the serialized final
commit check share this boundary. Terminal cancellation cannot resurrect those
reservations through a late recovery result. Session writes, the stop route's
complete deduplicated target set and enrolled association admission use it; TPM
catalog/readiness agree that accepted queued or unspecified input is unsettled.
Prepared TPM intents remain visible without blocking handoff.

Root verified the frozen source hashes and freshly ran 280 tests in 15 files
before review, then 174 tests in eight files after the four review fixes. Relay
build, affected typechecks and diff checks passed. The plan workspace preserves
the reports, scoped fix review and source manifest; Root logs are
`.tmp/root-task8b1-{build,tests,typecheck}.log` and
`.tmp/root-task8b1-fix1-{tests,typecheck}.log`.

Task8B2A and its first fix round also passed independent spec/quality review.
Accepted setting intents reserve their work and future native slot in the same
operation entry. Each later apply restores both asynchronous contexts and
revalidates current Host admission, Manager capability and value. UI confirmation,
timeout, replacement and close cannot settle an uncorrelated pending native effect.
Ordinary expired receipts still allow their accepted work to continue using its
original slot; this never borrows a newer entry or opts all settings into pinning.
Full wire authorization precedes acceptance; page lease changes do not cancel
accepted settings. Host/Manager close cancels only undispatched intent work.

Root freshly verified 153 tests before review and 60 affected tests after I1's
fix, plus Relay build and both package typechecks. Source/report/patch hashes and
the four-file fix diff were verified. Logs are
`.tmp/root-task8b2a-{build,relay-tests,host-tests,runtime-tests,typecheck}.log`
and `.tmp/root-task8b2a-fix1-*.log`; the plan workspace retains both reviews.

Task8B2B and its first fix round passed independent spec/quality review.
Directory create/rename, source-derived operations, relationship reservations and
native owner transfer now use the same cache/boundary. Request-only snapshot
provenance authorizes the concrete source provider without adding source grants.
Equivalent legacy source/edit provenance preserves old persisted create identities;
unknown shared creation receipts still cannot replay native creation.

Metadata-only relation changes retain immutable source references after succession
but reject every affected active reservation. Exact saved relation recovery keeps
its durable identity. Native owner transfer obtains a synchronous grant before
owner fields or stop change; ordinary immediate takeover can still interrupt
working, while succession requires idle admission.

Root verified all 30 frozen sources and the four-file fix diff. Fresh verification
passed Hosted 122, Protocol 236 and Lab 13 tests; the initial Host run was 419/420.
The failure was TPM rename using a revision read before initial acceptance was
published. A controlled real-uplink test proves stale revision refusal and fresh
revision success. Root then freshly passed all 134 affected tests in five files,
the Hosted build and both affected typechecks; earlier four-package typechecks
and builds also passed. No production revision check was weakened. Logs are
`.tmp/root-task8b2b-*.log` and `.tmp/root-task8b2b-fix1-*.log`; reviews and source
manifests remain in the plan workspace.

Task9A's negotiated projection ceiling is recorded above; the prepared SQL and
product slices follow. Native readiness/evidence integration remains a separate gate;
no complete provider, production capability or end-to-end handoff is certified.

## Native crash evidence checkpoint (2026-10-10)

Task8A passed scoped independent spec/quality review after isolating its native
experiment entry and output path. Claude SDK 0.3.247 / bundled native 2.1.247
cannot resume the exact empty B after the tested zero-input postcommit crash.
The independent lost-ack case does retain one exact user UUID/recipient/content
in public history. Passing tests assert these observed classifications; they do
not certify Claude durable succession. No seed, resend or replacement B was added.

Root verified five frozen source files and retained artifact hashes, then freshly
ran the dedicated entry: two cases passed in 8.38 seconds. Ordinary collection
with the generic executable configured skipped both cases and wrote no output.
Claude typecheck and diff check passed. The dedicated entry has a 120-second
process-group deadline; cases/hooks are 30/10 seconds with one worker. Root's
separate evidence is `.tmp/root-task8a-fix1-native-observations.json`; final
independent review is the plan workspace's `task-8a-fix1-review.md`.
Compatibility update/check passed with
`b4b43a629a5dfbde13afb4adc84892f80b71a9fd3bd26e94090a2e4df17eadde`.

Task8C is also complete: isolated OpenCode 1.18.18 / SDK 1.18.31, using the
existing `/session` API, passed empty committed-B crash recovery and exact
first-U materialization after response loss and crash. Independent spec/quality
review found no issues. Root freshly ran both cases in 3.15 seconds (Node reports
three passes including the parent), verified ordinary collection skips without
creating output, and checked syntax/source/artifact hashes. Root's separate
evidence is `.tmp/root-task8c-native-observations.json`; retained implementation
evidence and review live in the plan workspace. There was one create and one
input, U appeared once, and reconciliation issued zero model requests.
No callback-enabled production profile or complete readiness was certified.

The common admission, setting and directory/ownership slices are now reviewed as
recorded above. Continue with the prepared Task9A storage contract.
Native readiness/evidence integration,
complete SQL persistence and client composition still block release. No merge,
push, deployment, package publication, global install or user-service changes
are authorized by this checkpoint.

## Local preparation checkpoint (2026-10-10)

Task7B passed independent scoped spec/quality review. Role v4 and context v2 save
captured history and finite recovery capacity before one native create. Explicit
cancellation can settle certified zero-task unknown creation while preserving
late orphan evidence. Known candidates can be revalidated after restart without
another create. Both stores separate pre-publication failure from uncertain
post-rename publication and poison the latter until reopening. Legacy records gain
no inferred zero-task evidence. First-input capacity remains a separate admission.

Root verified all 13 frozen source hashes, 137 tests across 12 files, Controller
typecheck and diff check. The real HTTP/WS cases use scripted native ports; they
do not certify a production provider. Logs: `.tmp/root-task7b-tests.log` and
`.tmp/root-task7b-typecheck.log`. Review: the plan workspace's `task-7b-review.md`.
Compatibility update/check passed with
`992563ea276c95d46691c0dca51f4a7a41ef1085429e7cd34c98f9f8d2e1eb48`.

Next is Task8A's isolated native evidence probe. Reuse earlier Claude public UUID
history/reinitialize findings and test the unverified postcommit-before-first-input
crash window, then lost-ack first-input materialization. The exact brief is
`task-8a-implementation-brief.md` in the plan workspace. Full ARC gate, native
evidence integration, complete SQL codec and client composition remain incomplete.
SQL capacity evidence is recorded in `task-9-capacity-evidence.md`; a pending row
fitting storage does not prove its later full committed evidence will fit.

## Host revocation checkpoint (2026-10-10)

Task7A passed independent scoped review after correcting legacy pre-effect
relation-reset/re-pair compatibility. Revocation removes access while retaining
history; owner-targeted recovery restores the logical Host with fresh credentials
and no previous bindings/shares. Relay8 gates the recovery metadata. Ordinary
and reset-only Hosts keep ordinary revoke/re-pair behavior. Late RPC publication
checks the captured Host object, generation and relevant binding.

Root verified the frozen source manifest, ran 139 tests across 10 files before
the compatibility fix, then reran the 40 tests across 3 files covering that fix.
Affected-package typechecks and compatibility update/check passed. The final
compatibility hash is `ec8161d6b15e89132fbebc960940a34137e39ad26d13bec01d10be4a1c9a01fd`.
These are scripted native ports over real HTTP/WS and durable file restart, not
native provider certification. Root logs are `.tmp/root-task7a-*.log`.

Task7B subsequently completed capture/reserve before create, justified local
failure recovery and explicit zero-task unknown-create abandonment; see above.

## Architecture review adjustment in progress (2026-10-10)

The user approved the review's order after `c55661e`. Tasks 7–10 in the existing
plan supersede the older immediate-next recommendation to implement cold App
composition first. Do not restart completed slices.

1. Correct local recovery/capacity and Host revocation boundaries. Known read-only
   failures must not become permanently fenced native uncertainty; revoke access
   while retaining history and preventing late authority resurrection.
2. Add minimal optional provider evidence and exact native input reconciliation,
   certify zero-task creation, fix TPM unspecified/queued settlement, and verify
   one native mode. Exact candidate lookup is optional when certified creation
   can be explicitly abandoned under the durable cancellation fence.
3. Implement complete Cloudflare SQL persistence and clarify durable-file semantics.
4. Separate ForkStore ledger/navigation, existing Ask target routing and stable
   pane intent; finish the outstanding client/desktop/mobile acceptance.

Task7's sole source implementer is assigned via the existing plan ledger. A
separate read-only Task8 feasibility preflight may run concurrently; it may not
modify source or start native services. Keep all capability/UI off. No merge,
push, publication, deployment, installation or user-service replacement is included.

The user further simplified handoff admission: only confirmed idle, no queued
inputs/approvals/active child work/unsettled ARC writes; no drain/wait or automatic
handoff. Source and candidate are exclusive to ordinary ARC mutations until the
decision settles. Read-only inspection, handoff recovery/cancel, unrelated sessions
and security revocation remain available. The user approved ARC-only exclusion:
shared native providers do not require
a global external-client lock, but observed native activity or lost evidence still
prevents commit. See the latest spec and ledger rulings rather than older preflight
reports which required native global exclusion. The user also approved explicit
abandonment of a certified zero-task creation: terminal cancellation must persist
before releasing A, preserve known/unknown/late orphan evidence, and prevent every
late commit or dispatch by that operation. Task7B implements this local recovery
path; real provider certification remains open. Unknown input and role commit/persistence
cannot use it. Each attempt fixes its new candidate and settings; no automatic
waiting/retry, rollback after commit, or delayed continuation is introduced.

Capacity follows the same two-effect boundary: reserve actual captured context
and finite handoff completion/recovery before creating the candidate; reserve
the actual first input and finite settlement before dispatching it. A future
input may reject for capacity while leaving context pending. Do not reserve a
hypothetical maximum-size message for every candidate or claim arbitrary native
proof capacity. The exact Task7B execution brief is in the existing plan ledger.

## Client text persistence checkpoint (2026-10-10)

The first client prerequisite passed independent scoped spec/quality review.
Check Git for the checkpoint after `6a4ed7d`. Recovery writes expose terminal
results for actual storage completion, failure, cancellation and supersession.
Successful page-only retention is distinguished from session/local storage writes.
Partial writes remain failures. Generation fences prevent retired scope writes
and late results; retry serializes current text, not a failed older snapshot.

The existing Workbench shows a small nonblocking failure notice and Retry only
when text saving fails. Normal editing keeps the existing batching and per-key
subscriptions. Draft keys/schema are unchanged. This is not succession store
projection, cross-reload revision accounting or a claim of physical disk durability.

Evidence: `.tmp/succession-client-writes-report.md`, eight-file frozen manifest and
`.tmp/succession-client-writes-review.md` (spec PASS, quality Approved, no confirmed
findings). Implementer ran 218 tests in 14 files. Root freshly verified all hashes,
95 tests in 10 files and whole-workspace typecheck. Root logs are
`.tmp/succession-client-writes-root-{tests,typecheck}.log`. Mounted jsdom Workbench
coverage is not actual-browser or native provider certification.

Next: cold composition intent and its actual App consumer, followed by scoped
authenticated replay/Track/navigation, rich draft collision recovery, Ask/Side
attachment preservation and historical Favorites/browser acceptance. The detailed
preflight is `.tmp/succession-client-projection-preflight.md`; its first slice is
now complete, not the full client plan. SQL codec and native readiness remain
release gates. Capability/UI stays disabled; no merge, push, deployment or service
replacement is included.

## Atomic server Favorites checkpoint (2026-10-10)

Task5's server Favorites slice passed independent scoped spec/quality review.
Check Git for the checkpoint after `86455aa`. Relay7 stores bounded schema1
pending/applied acknowledgements tied to exact committed Broker4 freezes. These
are recovery progress, not another role or commit authority. Broker snapshot,
favorite replacement and acknowledgement share the outer durable transaction.

A-to-B-to-C preserves A's stable favorite slot, folder and timestamp, retaining
B's target metadata before duplicate removal. No-star/target-only creates no new
favorite tree. One aggregate change increments revision once. Missing mapping,
authority or favorite capacity remains pending without preventing native commit
evidence. Owner predecessor save and remove reject generic conflict, including
current-revision requests. Shared-only A neither moves nor gains B access.

Legacy freezes are recovered through authenticated Favorites/stars requests and
Host/provider publication, without polling or native attachment. Failed or lost
write acknowledgement recovers the original operation without new native effects.
The Cloudflare SQL codec now fails closed before writes for unsupported succession
state; a complete SQL codec remains mandatory before enabling that backend.

Evidence: `.tmp/succession-favorites-report.md`, frozen eight-file manifest and
`.tmp/succession-favorites-review.md` (spec/quality PASS, no confirmed findings).
Implementer ran all Hosted 236 tests and 12 affected Cloudflare tests. Root freshly
verified all hashes, Hosted build, 48 affected Hosted tests, 12 Cloudflare tests
and whole-workspace typecheck. Root logs: `.tmp/succession-favorites-root-*.log`.
These are fixture/transport/storage results, not native provider certification.

Next: read `.tmp/succession-client-projection-brief.md` for the client preflight,
plus `.tmp/succession-product-store-next-brief.md`. No client replacement/App opt-in
is implemented by this checkpoint. Cold successor target intent, actual storage
acknowledgement, independent draft collisions, native-bound inputs, nested Ask,
ordinary/history navigation and desktop/mobile acceptance still need work. Keep
capability/UI disabled. No merge, push, deployment, install or user-service change.

## Authenticated hosted replay checkpoint (2026-10-10)

Task 5's hosted/protocol/Remote transport slice passed independent scoped review
and a lifecycle correction. Check Git for the checkpoint following `9434d0d`.
Broker freeze projections are now the sole replay authority. Broker4 / Relay6
validate complete lineage and migrate only exact redundant legacy mirrors;
unmatched or contradictory records reject without deleting source evidence.
Missing current Host/provider metadata suppresses access rather than invalidating
historical state. Offline owner history requires valid identity and authority.

Authenticated bounded HTTP replay, exact-operation and separate current lookup
use native locators without agentId or native attachment. Explicit channel opt-in
and ready negotiation deliver `session_succession_committed`; default remains off
and old clients retain the existing channel shape. Old A-to-B stays B after current
C. Page cursors are traversal positions; recovery restarts from page one rather
than treating a cursor as a permanent global watermark.

Real loopback HTTP/WebSocket plus authenticated fixture Controller uplink tests
cover publication, owner/shared isolation, cold targets, restart and persistence
failure without duplicate native effects. No actual provider is certified by
these fixture results. Dispose now retires succession cache/listeners/late
callbacks; active reconnect retains exact duplicate handling. Relay rejects fresh
role operations at capacity before native prepare, retaining existing recovery.

Evidence: `.tmp/succession-hosted-replay-report.md`, original scoped review and
`.tmp/succession-hosted-replay-fix1-review.md`. Root verified all 19 frozen files,
ran protocol 13 tests and original affected hosted/Remote checks, then freshly ran
five hosted suites (68 tests) and three Remote suites (65 tests) after the fix.
Whole-workspace typecheck passed before the local correction; see final scoped
validation logs for that correction. Compatibility is generated after review.

Next is product-store projection and App composition/recovery. Read
`.tmp/succession-product-store-next-brief.md` and the broader product brief; they
record actual store/acknowledgement seams and draft/cold-target limits. Do not use
legacy best-effort delayed storage writes as proof that a store revision is saved.
No Favorites/Track/Ask/draft replacement or App opt-in is included yet. Keep native
capability and the product entry disabled until the entire contract is verified.
No merge, push, deployment, global install or user-service replacement occurred.

## Claude managed source-directory checkpoint (2026-10-10)

The managed stdio integration passed independent scoped review after one correction
for post-await source/reader authorization. Check Git for its checkpoint after
`6396b09`. Claude factory now provisions a canonical-profile-scoped durable source
store; source support requires both that store and a public history reader.

Creation confirms actual runtime/provider/persistence identity and saves the grant
before activating source callbacks. Cold open rebuilds source tools and saved base
instructions, composes caller/TPM callbacks, preserves native saved settings, and
rejects conflicting tool/prompt contracts. Arbitrary JavaScript callbacks are not
persisted; callers supply them again. Startup source callbacks explicitly reject
until real identity is confirmed. Managed content input now respects the existing
native ownership fence, including Copilot's shared directory path.

Reads use the current router each time and verify exact reader/session ownership
before and after awaited results. Local source access is rechecked after history
and validation awaits. Disposal, transfer, same-ID reopen or revocation cannot
release the old callback's result. No read is silently retried or retargeted.

Evidence: `.tmp/claude-managed-directory-report.md`, initial scoped review and
`.tmp/claude-managed-directory-fix1-review.md`. Root verified all eight frozen files,
ran nine Host suites (122 tests), three Claude/MCP suites (21 tests), and whole-
workspace typecheck. MCP uses a mocked Query with the real provider/MCP bridge;
this is not native producer certification. The catalog/history checkpoint below
remains unchanged.

Next work is Task 5 authenticated hosted replay/projection, then store/App
replacement and native evidence. Prepared briefs are
`.tmp/succession-hosted-replay-brief.md` and
`.tmp/product-succession-projection-brief.md`. Resolve the duplicate unused replay
helper versus saved Broker projections before implementing a single authority.
General succession remains disabled; no complete native provider pair is certified.

## Claude source-history checkpoint (2026-10-10)

The adapter-only public history reader passed independent scoped spec/quality
review. Check live Git for its commit after baseline `889954b`. It reuses Claude
normalized projection in an isolated catalog worker, without opening/resuming a
source or starting a model request. Only small pages cross the worker boundary.
Raw rows, bytes, blocks, normalized projection, output and time are bounded;
oversized histories reject explicitly. SDK internal parsing is not constant-memory.

Public history has message UUIDs but no verified root turn grouping. Entries keep
native message identity with empty turnId; turn filters explicitly reject.
User/assistant search, recent entries and tool context are supported. Two matching
bounded observations detect some changes; they do not establish atomic snapshots
or quiescence. An incoming page cursor detects changed fingerprints; first-page
textOffset without a cursor remains a fresh observation.

Evidence: `.tmp/claude-source-reader-report.md` and
`.tmp/claude-source-reader-review.md`. Implementer ran 114 Claude and 45 SDK tests;
Root verified the six-file manifest and freshly ran nine affected suites (62 tests)
and Claude typecheck. Native-named tests use isolated transcripts and the real
public SDK worker, not a native CLI/model or a user session.

The later managed checkpoint above implements brief items 3–5 in `.tmp/claude-source-reader-slice-brief.md`:
managed stdio durable grants, restored/composed extensions, dynamic source routing,
and the content-send ownership fence. Adapt tool guidance for unavailable turn
identity. No source-reference directory capability or succession readiness is
certified by the adapter-only checkpoint.

## Ordinary relationship update checkpoint (2026-10-10)

The trusted enrollment/native-result recovery baseline is committed as `00f6af9`.
The ordinary postcommit relationship slice passed scoped review and local
verification. Check Git and the plan ledger for its checkpoint commit.
This checkpoint supersedes older statements below that ordinary edits simply fail.

- Host preserves immutable grants and updates one exact reader participant through
  reserved/applied/released receipts. Source reads recheck gates across awaited I/O.
  Native sends, TPM participants and admitted recipients are not retargeted.
- Broker serializes reservation, metadata commitment and exact Host readback/release.
  Current-B reader creation starts fixed B and joins the next B-to-C enrollment.
  An old A grant is not silently promoted to B authority.
- Browser recovery identities use complete reader/Host/relation scope. A pending
  Side edit remains reachable after refresh and exposes its existing recovery
  action. Pending navigation is separate from immutable source/read authorization.
- An absent operation alone cannot retire an in-flight request. Only an exact
  durable pre-effect reset record fences a never-reserved intent. Any existing
  reservation remains reconcile-only, with no rollback or automatic replay.
- Host role state is version 3, Broker associations version 3 and Relay outer state
  version 5. Explicit migrations preserve older valid formats; ambiguous versions
  fail closed. See the [recovery guide](../current/agent-remote/session-succession-recovery.md).

The final review packages are the slice-4 and slice-5 increments;
`.tmp/association-updates-navigation-review.md` closes the final navigation finding.
Root ran 265 affected tests across the frozen backend/client and final navigation
checks; whole-workspace typecheck and compatibility update/check passed.
Exact commands are recorded in `.tmp/association-updates-slice-4.md` and
`.tmp/association-updates-slice-5.md`.
Root verification logs use `.tmp/association-root-final-*.log`. These remain
fixture/transport evidence; no native provider pair or complete product workflow
is certified. General succession capability and its user entry point stay disabled.

Continue sequentially with the bounded Claude source-reader/managed
stdio extension brief, authenticated product projection and native certification.
The native pending-work/queue evidence gap remains explicit; do not infer it from
idle or a successful history read. No merge, push, deployment or user-service
replacement is authorized by this continuation.

## Continuation checkpoint (2026-10-10)

This section supersedes the older implementation checkpoint and next-priority
ordering below. The approved design and release restrictions remain unchanged.
Inspect live Git status before continuing: later commits may extend this checkpoint.

Implemented and committed since the original handoff:

- `9d903d9`, `9bdbe7f`, `660aa91`: shared bounded normalized history, durable
  pending context and first-input dispatch, identity-safe receipts, actual
  started/queued/handled acceptance, and explicit unknown delivery after restart.
- `3c139a5`, `419d032`, `ace82e9`: full-reference routed source history, signed
  pinned cursors, attachment reads, cross-provider preparation checks, durable
  service/signing-key provisioning, and non-nested B-to-C pending context.
- `8439a02`: validated committed projection schema and hosted persistence helper.
  The actual broker/product projection is not wired yet.
- `57039ce`, `e44a30b`: real WebSocket receipt/restart tests and complete Host
  prepare/commit/first-input tests using a native fixture.
- `6254dec`: final native mutation fencing, in-flight mutation accounting and
  stable complete normalized timeline capture. Fresh focused verification:
  17 Host tests and 5 operation-settlement tests passed.
- `86a6932`, `875be25`: role-aware TPM reads/admissions, pinned actual recipient
  and role revision, queued receipt retention under capacity pressure, independent
  per-work routing recovery and handled background scheduler failures. Repair
  verification: 68 tests and Controller typecheck passed; scoped re-review passed.

No real provider pair has been certified. Explicit native evidence ports exist,
but `idle` alone must not enable succession. Fixture success demonstrates Host
coordination/transport behavior, not Codex, Copilot, Claude or OpenCode readiness.
TPM accepted/queued intents now correctly retain their blocking evidence; a
native-evidence reconciliation path for those ordinary TPM queue receipts is
still required before enabling the feature. A later idle snapshot must not be
used to erase that evidence or reinterpret queued acceptance as completion.

The Host/TPM integration is now committed in `93648f2`: routed source reads,
internal control routes, final mutation/first-input integration, and a full Host
TPM-first-input regression. The helper preserves bounded/filterable legacy pages
and their actual source snapshot (without persistence handles). Signed cursors
inherit omitted query fields and reject explicit mismatches.

`9939800` fixes two concrete TPM integration defects discovered by that regression:
non-UUID tool intent IDs are mapped deterministically at the execution boundary
without changing durable outbox identity, and accepted native creation plus the
initial intent are published in one store transaction so a review cannot race
ahead of the user's initial requirement. Deterministic race tests cover creation
with and without a requirement. Final focused verification: six suites, 79 tests
passed; Controller typecheck and scoped reviews passed. Compatibility update/check
also passed. These tests use a native fixture, not a certified real provider.

Trusted association enrollment/freeze is now verified locally after `552e507`.
Its scoped reviews passed; inspect live Git before continuing.
Relay freezes its durable Side/Ask catalog
through its existing mutation queue. A negotiated, authenticated uplink context
supplies authority separately from request JSON; Host reconciles native grants and
TPM records through atomic `beginEnrolled`. Controller identity is the persistent
installation identity, not the ephemeral Host socket identifier.

The first scoped review found and verified fixes for mutable caller references
and JSON-key-order-sensitive receipt comparisons. The release review then found
a concurrent same-operation/different-input race. The next fixed review snapshot
adds a shared inner/outer fingerprint check with real uplink tests, pre-enrollment
cancellation tombstones, cold/nested/unlinked grant coverage, and provider-scoped
reader identities. Its review found that invalid expected revisions could freeze
before Host rejection; a pre-freeze revision check now prevents that case. The
TPM checkpoint scoped re-review passed this fix and exact TPM recovery. See
`.tmp/enrollment-association-checkpoint.md` and its fixed diff/evidence file;
`.tmp/enrollment-tpm-checkpoint.md` and `.tmp/enrollment-tpm-review.md` supersede
that snapshot for revision and TPM behavior. The fixed source-result snapshot
also passed scoped review (`.tmp/enrollment-source-review.md`): exact durable
recovery, canonical parameter matching, grant validation, both creation/freeze
fences, and pre-dispatch result-slot reservation. Later live edits belong to full
Host reconstruction tests and the TPM recovery-action rejection boundary.

Host retains an enrollment reservation until Relay has durably saved the terminal
decision/projection and acknowledges the exact receipt. A lost response, unknown
outcome, or storage failure does not release it. Old A-to-B status replay retains
its original projection even after B-to-C; current navigation may report C.
Host state uses version 2 with explicit version-1 migration. Relay uses outer
version 3 when association state exists; legacy writers must reject newer state.
Version-1 migration supplies empty enrollment/admission/result state. An earlier
unpublished version-2 experiment without `associationResults` fails closed; it is
not a supported migration input. Final incremental spec/quality review passed
(`.tmp/enrollment-final-review.md`). Root reran four Host/runtime/store/TPM suites:
96 tests passed. Whole-workspace typecheck and compatibility update/check passed.
The initial typecheck failure was missing dist exports; building DSH provider,
Controller and DSH workspace packages resolved it without unrelated source changes.

Ordinary link/unlink/create/import on a committed reader overlay currently fails
explicitly instead of reporting success with a stale Host binding. This is a
temporary implementation gate, not the intended product behavior. Complete trusted
overlay updates before enabling succession. A first cancelled reservation without
any committed overlay must permit ordinary relationship changes after release.
Exact TPM creation/action recovery and paused/completed cold-work inclusion have
passed focused verification and scoped review. Native source-creation recovery
now persists the exact operation result together with admission settlement; a
native grant alone does not identify its creating operation. Broker retries attach
that recorded reader instead of invoking native creation again. No witness means
unknown, with the reservation retained. Full Host reconstruction and the TPM
rejection regression passed. The latter repairs a confirmed pre-native stale-
revision rejection that otherwise leaked an extra unresolved association admission;
native recovery and subsequent persistence failures remain unknown and fenced.
Do not expose internal succession control routes as a usable feature.

Full Host restart has a deliberate recovery limit: a previously ready operation
becomes unknown. If the recreated history epoch cannot certify the captured
boundary, reconcile rejects and retains the fence. This must not be reported as
automatic recovery of a prepared operation. A durable committed decision has a
different forward-projection recovery path. Neither path certifies a real provider.

Next implement trusted ordinary postcommit relationship updates using
`.tmp/association-updates-implementation-brief.md`, then real adapter
evidence/certification, authenticated broker projection,
product reference replacement/recovery, then browser/native acceptance. No merge,
push, publish, deployment, or user-service replacement has occurred.

## Native evidence follow-up (2026-10-10)

Isolated public-SDK probes have now run against the local default Claude CLI
2.1.128 and the separately selected, already installed SDK-bundled CLI 2.1.247
(SDK 0.3.247). These probes used empty temporary profiles/workspaces, a loopback
Anthropic fixture and OS network restrictions; no user runtime or installed
command was changed. The default binary is below the current Host registration
minimum. The bundled binary is a test target, not the current product default.

Both persisted the exact supplied user UUID, root identity and text body, readable
through public `getSessionMessages` while running and after exit. The bundled
producer also correlated first stream/result messages to the input UUID. Empty
initialization made no model request in the bounded probe window. Neither baseline
produced `session_state_changed`; SDK source inspection confirmed it does not
filter that subtype. The producer itself is binary-only in the installed package.

Correction to the earlier preflight: public `Query.reinitialize()` exists. A
separate empty-profile bundled probe observed a complete empty background level
after it, plus `session_state: idle` in the response. That response field is not
declared in `SDKControlInitializeResponse`. Reinitialize can re-register hooks
and replay/settle callbacks, so it is not a general readonly readiness getter.
The full internal pending-work predicate remains unproven. Do not enable a real
provider from these positive persistence/snapshot results alone.

Read the retained local artifacts before further native work:
`.tmp/claude-succession-implementation-brief.md`,
`.tmp/claude-native-succession-probe.md`, and
`.tmp/claude-readiness-contract-followup.md`. The implementation brief was corrected
to remove the mistaken claim that no public reinitialize method exists.

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

## Historical implementation checkpoint

This table records the original handoff. Use the continuation checkpoint above
for current status; do not repeat work solely because this table lists it missing.

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

The Host admission and final native-dispatch boundaries now include succession
gating. `SessionWireAgent.timelineCursor()` supplies the projection boundary;
native readiness still requires explicit adapter evidence. `SessionSuccessionService`
loads and provisions the durable 32-byte source-cursor signing key. Neither this
wiring nor its fixture tests certify a production provider pair.

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
