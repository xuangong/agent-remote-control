# Controller idle subscription release

## Design

Release only Controller-owned, safely detachable shared Codex runtime connections. Preserve native history, stable Relay bindings, native persistence identity, source-reference tools and operation deduplication. Never archive, cancel or stop the daemon. Private runtimes and other providers remain opt-out until their adapters explicitly support safe detachment.

Existing Host virtual streams represent all devices and both full/content and activity-only demand (Main, Side, Ask and Track). Hold a lease from stream admission through asynchronous restoration and pending receive completion. HTTP snapshot/history requests also hold leases. Lease release is idempotent and stream-generation-specific.

Require five uninterrupted minutes of no demand and safe idle state. Running turns, pending interactions, native recovery, history work, child activity and unresolved mutations prevent release. Keep uncertain mutation targets pinned for the Host lifetime, even if deduplication entries expire. Pause cleanup while the Host uplink is unavailable; start a fresh full grace interval on registration. A brief browser interruption cancels its old lease but does not immediately dispose the native connection.

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
