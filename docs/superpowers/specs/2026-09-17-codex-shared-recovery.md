# Shared Codex recovery and durable operation safety

## Approved behavior

The Host recovers its connection to an externally owned Codex shared daemon without restarting the Host, replacing session identities, or refreshing the browser. Relay heartbeat recovery is a separate connection lifecycle. Private Codex mode retains its existing lifecycle. The Host never starts, stops, or silently replaces the user's shared daemon.

Keep the root runtime, its child sessions, native thread identifiers, and observation streams alive during temporary disconnection. One recovery loop belongs to each root runtime. Reconnect with exponential jittered backoff starting at 500 ms and capped at 30 seconds; bound connection and restoration attempts, cancel on disposal, fence stale generations, and bound simultaneous restoration across roots. Explicit permanent errors enter unavailable state instead of a tight retry loop.

Runtime connection state is separate from task status. Add optional runtimeInfo.connection with state connected/reconnecting/restoring/unavailable, a safe reason code, attempt and nextRetryAt metadata where useful. Absence retains existing providers' behavior. During recovery the browser retains conversation, drafts, and previews, but disables mutations; the native adapter also rejects mutations.

Reconnect and initialize, attach to the existing native root without replaying stale settings, obtain authoritative native history/status, restore children and input capabilities, invalidate stale interactions, and only then become connected. Never thread/start or replay the previous user message during restoration. A daemon restart need not resume an interrupted native task; report the actual state.

Use the existing timeline_replacement stream item to correct already observed history, not a second history_boundary. Preserve all identity and read-only child semantics. Without a native durable cursor, do not deduplicate deltas by equal text or claim every transient delta can be recovered. Reconcile using native item identity and authoritative history.

Add interaction_invalidated with requestId and a safe reason, removing pending controls without fabricating a user answer or deny/cancel event. A later native request on a new connection needs a fresh public identity; an old answer cannot apply to it.

## Durable operation safety

Every client mutation has a stable operationId carried unchanged through Relay to Host. Each new user intent creates a new ID, including identical text; retries reuse the same ID. Keep requestId for response correlation and native approval request IDs for native interaction identity. Same operationId with different intent is a conflict.

Persist an operation record before attempting side effects. Use a fingerprint of operation kind, durable native target identity and canonical parameters. Durable dispatching precedes invocation. States distinguish prepared, dispatching, accepted, completed, rejected and unknown where applicable; accepted/completed refer to the submitted command, never completion of an agent's entire turn. On restart, dispatching without a definitive result becomes unknown. Definitively unattempted prepared operations may be submitted; successful duplicate operations return their saved result. Never replay unknown operations automatically. Reconcile only with reliable native operation/turn evidence, never text similarity. Current native turn/start lacks a business idempotency key, so unresolved cases remain unknown.

Protect send, steer, cancel, approvals, settings/planning, execute-command and native session creation at the Host boundary. Journal validation failures before dispatch may be rejected; failures after invocation that cannot be proved unexecuted are unknown. The journal must survive stream/socket replacement and Host restart and scope records to the paired owner/Host and durable provider/native target. Cloud state alone cannot establish whether a native operation ran.

Store bounded private records separately from diagnostic logs with restrictive permissions, atomic durable writes and a safe retention policy. Never expire unknown entries into permission to redispatch; retained-ID horizons must be explicit. Do not log message bodies, approval answers or credentials. Journal failure before dispatch fails closed. Surface unknown outcomes clearly in the browser; do not claim an uncertain mutation failed or auto retry it.

This is not exactly-once execution of arbitrary shell commands or external APIs. The Host protects its own submitted operations; daemon/tool-side idempotency and authoritative status are required to eliminate the remaining external-effect ambiguity.

## Validation

Use a real isolated Unix WebSocket fixture for disconnect/reconnect, bounded retry, disposal, stale generations, lost acknowledgements, history correction, children and interaction invalidation. Use a separate temporary Codex daemon and CODEX_HOME for available native integration coverage; never manipulate the user's daemon. Test journal restart, duplicate concurrent requests, conflicting fingerprints, durable-write failure, and execute-then-disconnect unknown behavior. Test browser disabled controls and preserved drafts/preview state. Synchronize protocol schemas, reducers, fixtures, compatibility metadata and current architecture documentation. No push, deployment, package publication or replacement of running services is authorized by this design approval.

## Bounded storage and cleanup

The user explicitly requires automatic cleanup so logs cannot grow indefinitely. Diagnostic logs and durable operation records have different retention rules. Rotate diagnostic output by size and retain a fixed number of archives; handle inherited launchd/manual daemon output descriptors correctly. Default target is 5 MiB per diagnostic file and three archives. The daemon must enforce cleanup while running as well as at startup, without requiring a restart. Rotation failure must not create an unbounded memory queue or log recursion.

Completed operation result bodies can expire, but forgetting an operation ID must never authorize a replay. Use an enforced operation-ID validity horizon with expired IDs always rejected, or retained compact deduplication records. Bound record count and bytes; compact and clean automatically. Unknown records require compact replay protection until their identity can no longer be accepted, never blind deletion. Capacity exhaustion fails new mutations closed with a specific actionable error; reads and connection recovery continue. Cleanup and journal writes must serialize safely. Document exact defaults and test them using small limits and controlled time.
