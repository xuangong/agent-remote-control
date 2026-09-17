# Shared Codex recovery and bounded operation safety

## Approved behavior

The Host recovers its connection to an externally owned Codex shared daemon without restarting the Host, replacing session identities, or refreshing the browser. Relay heartbeat recovery is a separate connection lifecycle. Private Codex mode retains its existing lifecycle. The Host never starts, stops, or silently replaces the user's shared daemon.

Keep the root runtime, its child sessions, native thread identifiers, and observation streams alive during temporary disconnection. One recovery loop belongs to each root runtime. Reconnect with exponential jittered backoff starting at 500 ms and capped at 30 seconds; bound connection and restoration attempts, cancel on disposal, fence stale generations, and bound simultaneous restoration across roots. Explicit permanent errors enter unavailable state instead of a tight retry loop.

Runtime connection state is separate from task status. Add optional runtimeInfo.connection with state connected/reconnecting/restoring/unavailable, a safe reason code, attempt and nextRetryAt metadata where useful. Absence retains existing providers' behavior. During recovery the browser retains conversation, drafts, and previews, but disables mutations; the native adapter also rejects mutations.

Reconnect and initialize, attach to the existing native root without replaying stale settings, obtain authoritative native history/status, restore children and input capabilities, invalidate stale interactions, and only then become connected. Never thread/start or replay the previous user message during restoration. A daemon restart need not resume an interrupted native task; report the actual state.

Use the existing timeline_replacement stream item to correct already observed history, not a second history_boundary. Preserve all identity and read-only child semantics. Without a native durable cursor, do not deduplicate deltas by equal text or claim every transient delta can be recovered. Reconcile using native item identity and authoritative history.

Add interaction_invalidated with requestId and a safe reason, removing pending controls without fabricating a user answer or deny/cancel event. A later native request on a new connection needs a fresh public identity; an old answer cannot apply to it.

## Bounded operation safety

Every client mutation has a stable operationId carried unchanged through Relay to Host. Each new user intent creates a new ID, including identical text; retries reuse the same ID. Keep requestId for response correlation and native approval request IDs for native interaction identity. Within the retained cache window, the same operationId with different intent is a conflict.

The Host keeps a bounded in-memory operation cache. Register an entry before invoking a side effect so concurrent duplicates execute once. Fingerprint operation kind, durable native target identity and canonical parameters. Completed duplicates return the saved command result with the current transport request correlation. An error after invocation that cannot be proved unexecuted has an unknown outcome; retained unknown entries are never automatically replayed. Submission acceptance/completion does not mean the agent's entire turn completed.

Protect send, steer, cancel, approvals, settings/planning, execute-command, native session creation and Host batch stop at the Host boundary. Use authenticated owner/Host scope and provider/native target so stream or uplink replacement does not bypass the live Host cache. Do not fabricate an interaction_resolved event as a duplicate acknowledgement.

Host restart intentionally clears the cache. The user accepts manual resubmission after restart and the possibility of duplicate effects when manually submitting again. Expiry also ends the cache guarantee; do not claim durable or exactly-once execution. The client never automatically resends an uncertain mutation, and clearly displays that its result is unconfirmed. Native history may help the user decide what to do, but text similarity is not evidence of operation completion.

Limit cache entry count, retained result bytes and retention time. Never evict in-flight entries into permission for a concurrent duplicate to execute; reject new mutations at capacity while reads and connection recovery continue. Expired settled entries are removed automatically. Do not add SQLite, disk journals, writer leases, durable expiry high-water marks or a new Node minimum for operation safety. Do not log message bodies, approval answers or credentials.

## Validation

Use a real isolated Unix WebSocket fixture for disconnect/reconnect, bounded retry, disposal, stale generations, lost acknowledgements, history correction, children and interaction invalidation. Use a separate temporary Codex daemon and CODEX_HOME for available native integration coverage; never manipulate the user's daemon. Test concurrent duplicates, conflicting fingerprints, cache retention/capacity, execute-then-disconnect unknown behavior, and the explicitly accepted cache reset on Host restart. Test browser disabled controls and preserved drafts/preview state. Synchronize protocol schemas, reducers, fixtures, compatibility metadata and current architecture documentation. No push, deployment, package publication or replacement of running services is authorized by this design approval.

## Bounded storage and cleanup

The user explicitly requires automatic cleanup so logs cannot grow indefinitely. Diagnostic logs and durable operation records have different retention rules. Rotate diagnostic output by size and retain a fixed number of archives; handle inherited launchd/manual daemon output descriptors correctly. Default target is 5 MiB per diagnostic file and three archives. The daemon must enforce cleanup while running as well as at startup, without requiring a restart. Rotation failure must not create an unbounded memory queue or log recursion.

Operation-cache retention is independent of diagnostic-log rotation. Bound entry count and retained bytes, remove expired settled records automatically, and reject new mutations when active entries exhaust capacity. Cache expiry and Host restart end deduplication protection; neither triggers automatic replay. Document exact defaults and test with small limits and controlled time.
