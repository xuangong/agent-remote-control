# Frontend interaction performance design

Date: 2026-09-22
Status: Proposed; implementation is outside this design task.
Source baseline: `db2df7974d0749ce4475008be3dc54a60f94f658`.

## Outcome

Typing should cost approximately the same in short and long loaded conversations. Reading should remain stable while history, Markdown, images, the keyboard, or viewport dimensions change. Background and inactive UI should perform less work. Reduce unnecessary CPU, storage, and network activity as power-saving proxies; do not claim measured battery savings without device measurements.

Preserve the shared session/activity transports, multiple simultaneous full subscriptions for Main/Side/Ask, content-only filtering before render-model creation, memoized Markdown, and all existing sending/recovery semantics. No provider, Relay, or wire-protocol changes are needed.

## Evidence and limits

A production-mode synthetic App fixture used Chrome at 390 x 844 with 4x CPU slowdown. Twenty characters were entered 70 ms apart. An inert activity transport excluded reconnect noise.

| Loaded timeline entries | DOM elements | Cumulative typing task time | Entry geometry reads |
| --- | ---: | ---: | ---: |
| 100 | 2,260 | 259.5 ms | 2,000 |
| 500 | 10,929 | 710.7 ms | 10,000 |
| 1,000 | 21,760 | 1,227.9 ms | 20,000 |

An uninstrumented geometry run confirmed scaling: 302.5/1,295.1 ms at 100/1,000 entries, predominantly JavaScript work. These are cumulative times, not per-key latency or field INP. Entries are not native turns. This is not an iPhone hardware benchmark.

An image-capable composer with no attached images performed 20 IndexedDB opens and 20 puts for 20 characters. The public login entry loaded approximately 1.07 MB decoded JavaScript (332 KB transfer). Unlimited replica/image retention is confirmed in source; a heap leak has not been demonstrated.

## Approach selection

| Approach | Benefit | Cost / limitation |
| --- | --- | --- |
| Scoped input updates, indexed anchors, bounded persistence and caches | Directly addresses measured work; independently measurable deliveries | Requires careful ownership and lifecycle handling |
| Memoize the current component tree without moving draft ownership | Small patch; may reduce some rendering | App still reruns per key; callback churn and layout effects remain fragile |
| Replace rendering with virtualization and a new application-wide store | Can bound DOM for extremely long histories | Larger compatibility surface for selection, browser search, variable heights, and recovery |

Choose the first approach. Avoid a new state-management dependency. Defer virtualization until the first changes are measured.

## Phase 1A: isolate input from conversation rendering

### Ownership

Introduce a small Lab-owned draft repository, scoped to the existing recovery scope. Its operations are `get(key)`, `set(key, text)`, and `subscribe(key, listener)`. Snapshots must be stable when text is unchanged. Reuse `readDrafts`, `saveDrafts`, and the existing 200 ms recovery-write batching. Repository mutation schedules persistence directly; it does not depend on an App render/effect.

A leaf composer binding subscribes with `useSyncExternalStore` and passes controlled draft props to the existing AgentComposer. Keep the reusable AgentComposer API working for external consumers. App owns repository lifetime, routing, and transport bindings, but does not subscribe to all draft text. Main and Side use the same repository when they refer to the same draft; Ask retains its existing separate scope and clean behavior. Ask orchestration reads snapshots imperatively when starting work.

Use existing storage identities and adapters in this phase. Do not silently rename stored draft keys or conflate host/provider/session identities. Component identity follows the draft session identity, not title or list index. Old asynchronous callbacks retain their original identity and cannot write into a newly selected session.

### Rendering boundary

Extract a memoized conversation timeline pane from LabWorkbench. It owns the timeline viewport, reading hook, history controls, and reveal behavior. Composer dock, drawer, notices, and toast anchors remain independently rendered. Stabilize action and child-session resolver props using explicit semantic dependencies; callback identity stability must not hide changed session, permission, connection, or fork state.

Split timeline data from composer-only state at this boundary. Actual timeline/resource/interaction changes still render immediately. Input edits and pending-countdown ticks must not map timeline entries or run positioning when viewport geometry is unchanged. Composer height changes still notify the viewport observer.

Do not debounce visible typing, use delayed state as the editor source, or use deep comparisons of the full replica. Preserve IME composition, selection, image tags, upload progress, and undo behavior.

Question drafts should be subscribed at their affected interaction entry rather than invalidating unrelated entries. This is a follow-up within this phase only if the same measurement demonstrates the problem in question forms.

### Sending boundary

Keep the existing pending-send owner and state machine. Draft edits are immediate in memory; submitting takes an immutable content snapshot. A pending send retains that snapshot and its session identity. Clear a draft only under the existing revision/content checks so a later edit is never cleared by an earlier completion.

Normal messages remain eligible for the existing 10-second recovery wait. Background time, retry/cancel, and uncertain outcomes retain their current semantics. Controls and slash commands do not acquire a pending queue. Disabled/read-only permissions remain authoritative.

## Phase 1B: incremental reading anchors

Keep the current distinction between following latest and reading history. Keep text-line anchors from `reading-text-anchor.ts`; preserving only entry top would regress Markdown and image reflow.

Maintain an ordered index of rendered top-level entry elements plus a key-to-element map. Register/unregister elements at the timeline boundary. Rebuild ordering only on entry order/filter changes, never on composer edits. Clear detached elements and separate indexes by mounted pane and timeline identity.

Anchor capture first checks the last visible entry and its neighbors. For a large scroll jump, binary-search the ordered, vertically non-overlapping entry bounds. Ignore unmounted/hidden elements. An index refresh is an exceptional structural path; the steady path does not query and scan every entry. Restore a known anchor through the key map.

Following latest uses a direct bottom calculation and stores `following: true`; it does not capture a text anchor on every update. Capture a reading anchor when the user leaves following mode.

Replace the unconditional layout effect with explicit invalidation for session/epoch, visible state, rendered content revision, display mode, reveal requests, and history prepend. Invalidation includes resource/expansion changes that can move text even when the outer content height stays constant. Viewport/content ResizeObserver handles geometry changes outside those commits.

Coalesce scroll observations to one capture per animation frame. Content commits and resize corrections that preserve the saved text line run before paint; do not delay all corrections to a later frame and introduce visible jumps. Use a dirty/scheduled guard and read-before-write ordering to avoid duplicate work and observer loops. Cancel scheduled work on identity change/unmount. Capture immediately before a user action or navigation when postponing would lose the last valid anchor.

History prepend restores the saved anchor before capturing a new one. Keep expected-scroll suppression and native iOS bounce handling. An absent anchor during reconnect does not erase the saved reading position.

## Phase 1C: batch draft persistence

Retain immediate in-memory edits and the current durable record format first. Use a 250 ms fixed window starting at the first dirty edit, merging subsequent edits into the latest snapshot. Continuous typing cannot indefinitely postpone a write. Allow one write in flight per draft; after completion, save any newer dirty revision without an overlapping transaction. The timing bound is a scheduling target, not a guarantee while the event loop/storage is stalled.

Reuse a lazily opened IndexedDB connection. Invalidate it on close/error and close on `versionchange` so another tab can upgrade. An unsuccessful open must be retryable, not cached forever. Do not create empty draft records merely because a composer mounted; record deletion/empty tombstones must still prevent old saved content from returning after a clear.

Flush on session transition, page visibility loss, pagehide, and relevant send/clear operations. A scheduler owned outside the mounted leaf completes queued work after that leaf unmounts. These lifecycle flushes are best effort: asynchronous IndexedDB writes cannot be guaranteed after iOS terminates a page. Retain the synchronous text recovery path and never report an image as locally saved until its transaction commits.

Image insert/replace and explicit clear are immediate persistence boundaries. Preserve read-failure protection, write retries, generation guards on sign-out, revision checks on restore, and Safari Blob-to-ArrayBuffer fallback. A failed write leaves the latest draft in memory and dirty for explicit/lifecycle retry without a tight retry loop. Successful storage clears the warning. Upload state and local persistence state remain separate.

This phase reduces write frequency without a schema migration. Splitting image bytes from metadata follows separately because migration and cleanup deserve independent verification.

## Phase 2: bound retained data

### Image metadata and bytes

Upgrade the local draft database to store document/attachment metadata separately from immutable image bytes. A text edit updates metadata only. Image insert/replace writes new bytes and referencing metadata atomically; prepare any Safari binary conversion before opening that transaction. Upload progress is ephemeral and does not write blobs repeatedly.

Read version-1 records and migrate each draft transactionally when accessed. Keep its previous representation until the replacement commits; storage failure must not destroy the recoverable draft. The upgrade must coordinate open tabs through `versionchange` handling. A blocked upgrade preserves in-memory editing and reports the existing recoverability warning only when recovery is actually impaired.

Byte cleanup must consider persisted drafts, live editors, bounded undo history, pending/uncertain sends, and active image previews. Do not delete a blob merely because its tag was removed while undo can still restore it. On-disk orphan collection uses references read in the same transaction as deletion. Externally copied image tags may outlive cache retention; their existing unavailable-image behavior must remain explicit rather than pasting broken content silently.

### Replica cache

Introduce a cache manager at the existing `replicaFor` boundary. Proposed initial limits for evictable replicas are six inactive sessions or 24 MiB of estimated retained payload, whichever is reached first. These are adjustable engineering defaults, not measurements of JavaScript heap usage. Update estimates from changed payloads; never stringify an entire replica on every event or keystroke.

Pin replicas with a live full subscription, current Main/Side/Ask ownership, a catch-up/attach in progress, an in-flight operation, or unsent/failed/uncertain messages requiring reconciliation. Mounted but temporarily hidden panes retain their required state. Pin before obtaining/binding a replica, release after detaching owners, and evict least-recently-used eligible entries only. Ask clean may release its old session once operation obligations end.

Keep draft persistence and reading positions outside the replica cache. An unsaved draft/image owner pins its recovery data; it pins a replica only if that replica still owns recovery obligations. A safely persisted draft does not require retaining the entire conversation history.

Eviction removes local references/listeners and revokes unused object URLs; it never deletes a native session, changes favorites/tracking, or cancels an operation. Reopening an evicted session uses the existing initial synchronization, with no stale cursor treated as proof of complete cached content. Recently used sessions still benefit from reuse. Pinned data can exceed the soft budget; correctness takes priority and diagnostics should expose that condition.

Use a separate 32 MiB soft budget for evictable local image blobs. Protected editor/undo/send/preview references can exceed it. After byte storage is separated, rehydrate persisted images on demand through the image resolver/import path; retain explicit unavailable-image handling. Counts, estimates, evictions, and protected bytes are development diagnostics, not new product UI.

## Phase 3: idle work and initial loading

Load the full App only after the authentication gate requires it. Keep standalone workbench behavior intact and avoid introducing an account dependency into reusable renderer packages. Defer optional inspector/QR/editor modules only after bundle analysis demonstrates that they are outside the critical path. Arbitrary vendor splitting alone does not reduce required JavaScript.

For host discovery, preserve 5-second polling while discovery/new-host UI is visible or an operation needs fresh availability; use 30 seconds during ordinary foreground chat with that UI closed. Refresh immediately on opening it or returning to foreground. Reuse hidden-page pause and no-overlap scheduling. Active session disconnect detection continues through its existing transport; a slower catalog poll must not control session readiness.

Working-duration labels subscribe to a shared one-second clock only while their document and pane are visible. Stop the clock with no subscribers. Compute elapsed time from timestamps on resume, rather than replaying missed ticks. Preserve visible catch-up and state-change animations, but stop work when they are hidden or completed and respect reduced motion.

Full timeline virtualization is a separate decision after Phase 1 measurements. If DOM/layout still dominates at representative history sizes, prototype it with explicit acceptance for text selection, browser find, variable-height Markdown/images, and prepend/reveal continuity. Do not silently truncate history or disable browser search as an optimization.

## Verification and acceptance

Before implementation, promote the synthetic production-mode fixture and measurement scripts into reproducible test tooling, including their inert activity source. Record the baseline commit, browser/version, viewport, CPU setting, sample text, warm-up, and loaded-entry count. Run timing comparisons five times and compare medians on the same machine. Separate instrumented structural counters from uninstrumented timings. Preserve artifacts outside production bundles.

The following timing thresholds are targets to validate, not current results or promised device speedups:

| Scenario | Acceptance target |
| --- | --- |
| Twenty characters, fixed-height composer, 1,000 loaded entries | At least 60% lower cumulative typing task time than the matched baseline |
| Same input at 100 versus 1,000 entries | 1,000-entry median no more than 1.5x the 100-entry median; no history-wide iteration caused by input alone |
| Composer edit with no geometry change | Zero timeline entry geometry reads or timeline remaps attributable to the edit |
| Scroll with 1,000 entries | No full scan per event; at most one scheduled anchor capture per frame, with local or logarithmic entry lookup |
| Twenty characters at 70 ms, image-capable composer | At most six scheduled metadata transactions after hydration and final flush, absent lifecycle/image events; one normal database open per connection lifetime |
| Text edit with existing images, after Phase 2 | Zero image-byte rewrites |
| Visit 50 inactive sessions | Evictable cache respects configured count/payload limits; all protected operation/draft state survives |
| Backgrounded or hidden working labels | No recurring duration ticks; correct elapsed value on resume |

Use behavioral render/geometry/storage counters for deterministic regression tests. Keep noisy wall-clock thresholds in a dedicated benchmark, not as ordinary unit-test gates. Report missed targets honestly and use the profile to decide whether further changes are justified.

Regression coverage must include:

- Main, multiple Side panes, and Ask independently editing; Ask clean/disable; changing hosts and sessions with identical titles.
- Plain text, Chinese IME, selection/undo, paste/upload/replace/delete of images, upload failure, and storage read/write failure.
- Draft change during hydration/write/send; switching session during in-flight persistence; sign-out during an asynchronous write; database upgrade with another tab open.
- Disconnect before send, automatic pending recovery, timeout/manual retry/cancel, foreground/background transitions, and uncertain outcomes with no automatic replay. Controls and permission errors keep their existing behavior.
- Reading near the beginning/middle/end, following latest, history prepend, streamed Markdown, late images, same-height content replacement, expansion/collapse, and reconnect with a temporarily absent anchor.
- iPhone portrait/landscape and keyboard open/close in standalone home-screen mode; desktop selection and browser find; drawer/toast positioning.

Use real WebSocket transports for reconnect/pending scenarios. Run focused unit/browser tests with per-test and outer process deadlines, then typecheck/build and `pnpm compatibility:update` / `pnpm compatibility:check` for implementation changes. Build before browser suites that consume its output. Perform real iPhone standalone acceptance before claiming mobile readiness; Chrome emulation alone cannot verify keyboard, suspension, or battery behavior.

## Delivery and rollback

Deliver independently: (1) draft/render isolation, (2) anchor indexing, (3) batched persistence, (4) byte separation and cache budgets, (5) idle work and bundle loading. Rebenchmark after the first three deliveries before choosing additional rendering changes. Each delivery includes its focused regression coverage and can be reviewed separately.

The first three deliveries are schema-preserving. For the IndexedDB upgrade, provide a tested reader-compatible rollback build that understands both storage representations before release; an arbitrary pre-upgrade bundle is not a safe rollback. Do not downgrade a database version or delete drafts to resolve an upgrade issue.

Design work is confined to a dedicated worktree. Implementation, merge, push, installation, and deployment are not performed by this proposal.
