# Controller idle subscription release

## Design

Release only Controller-owned, safely detachable shared Codex runtime connections. Preserve native history, stable Relay bindings, native persistence identity, source-reference tools and operation deduplication. Never archive, cancel or stop the daemon. Private runtimes and other providers remain opt-out until their adapters explicitly support safe detachment.

Existing Host virtual streams represent all devices and both full/content and activity-only demand (Main, Side, Ask and Track). Hold a lease from stream admission through asynchronous restoration and pending receive completion. HTTP snapshot/history requests also hold leases. Lease release is idempotent and stream-generation-specific.

Require five uninterrupted minutes of no demand and safe idle state. Running turns, pending interactions, native recovery, history work, child activity and unresolved mutations prevent release. Keep uncertain mutation targets pinned until a read-only native idle reconciliation confirms safe detachment; deduplication retention never decides connection safety. Pause cleanup while the Host uplink is unavailable; start a fresh full grace interval on registration. A brief browser interruption cancels its old lease but does not immediately dispose the native connection.

Serialize release and restoration per binding. Reopening a dormant binding restores its original native session and agent identity, using the existing timeline reset/history protocol. Do not replay messages. Child bindings keep their root runtime alive; after all family projections are idle, detach child projections before the owning root.

Native state interpretation remains in the Codex adapter. Shared socket disposal removes only this client's subscriptions; daemon unloading is independently controlled by Codex and is not promised to occur immediately.

## Execution plan

1. Add behavioral tests for idle leases, disconnected suspension, renewed grace and release/reopen races; implement the Controller lease registry.
2. Add async leased session acquisition to Host transport with pending-open cancellation, HTTP lifetimes and bounded receive queues. Preserve the existing public wire protocol.
3. Integrate safe native guards, operation protection, stable dormant bindings and lazy reattachment; test multiple viewers, activity demand, parent/child and unknown outcomes.
4. Exercise real uplink WebSockets and an isolated real Codex shared server with an independent native subscriber. Never restart the user's daemon.
5. Build, run focused and regression tests with inner/outer deadlines, update and check compatibility metadata, review changes. No merge, push, deploy or service restart is authorized for this task.

## Review refinements

- Pending or failed discovery of a known native child prevents root release until authoritative child state is available.
- Dormant restoration uses native saved settings, not a stale handle snapshot; source grants still restore Controller-owned tools and instructions.

## Verification

- Controller dependency build passed.
- Controller: 255 passed, 7 platform/optional skips.
- Relay: 243 passed; real uplink transport covers content/activity observers, short disconnects and full uplink loss.
- Codex adapter non-local suite: 270 passed. Native daemon client: 8 passed.
- Isolated Codex 0.155.1: all 6 shared-runtime cases passed, including Controller idle disposal/resumption while an independent native client continues. Native image-input and child-session cases also passed (2 tests).
- The legacy `provider.local.test.ts` and `default-questions.local.test.ts` require exactly Codex 0.148.0 and are outside this final passing scope. An initial unconfigured broad run selected PATH Codex 0.46.0; native coverage above explicitly selects the standalone 0.155.1 executable.
- Independent review findings were reproduced with failing regressions and fixed: unresolved child discovery protection and native settings preservation during dormant restoration.
- Compatibility metadata updated and checked; no public Remote wire schema changed. No existing Controller or daemon was restarted.


## Low-frequency reconciliation refinement

- After one minute without demand, reconcile otherwise-blocked idle shared Codex runtimes over their existing connection. Run one reconciliation at a time per Controller. Failed/unsafe checks back off exponentially up to 15 minutes; actual observer demand resets this delay.
- Require the Relay projection and all materialized native sessions to be idle, with no local actions or interactions. Verify native metadata for the entire known family; native notifications, server requests or socket generation changes invalidate the check. Keep running tasks and approvals protected.
- Retry at most one unresolved child discovery per check, rotating failures for fairness. Use the existing latest-ten-turn page and a ten-second request budget. Background discovery must not fall back to full history on older servers. No new socket, resume, mutation or automatic message replay is allowed.
- In-flight reconciliation blocks release. New demand, operations, watch replacement, uplink interruption or shutdown invalidate its result. Partial child discovery remains pinned if the complete check fails. A successful check starts a new full five-minute grace.
- Unknown operation results remain unknown in the existing operation cache; only the idle-release protection is lifted. Cache retention and retry semantics are unchanged. Emit `session_idle_reconciled` for successful checks.
- No force-release deadline: unreadable or still-busy native state remains protected and is checked again later.


### Reconciliation verification

- Controller: 262 passed, 7 platform/optional skips. Codex adapter non-local suite: 283 passed. Native daemon client: 8 passed.
- Isolated real Codex 0.155.1 shared-runtime suite: 6 passed. The updated idle test dispatches a real native message, simulates a lost acknowledgement, then verifies reconciliation, detachment, independent-client continuity, restoration, and no replay of the unknown operation.
- Real Unix WebSocket regressions cover metadata errors, native recovery, activity races, bounded child discovery, unsupported pagination, nested activity-only references, already-loaded ancestors, malformed ancestry, and newer parentage notifications.
- Independent review findings were reproduced as failing tests and fixed. Dependency build/typecheck and compatibility verification passed.
- This refinement changes no public Remote wire schema and does not restart the user's Controller or daemon. It remains on the dedicated worktree branch.
