# Host-local connection diagnostics

## Approved scope

Keep Controller and Server diagnostic logs separately on each Host. Every record retains its event timestamp and source. Server buffers bounded Host-specific evidence while disconnected and delivers it after registration. No merged chronology, clock synchronization, offline troubleshooting UI, automatic native session creation, or extra toasts. A local diagnostic session can read these logs on demand. Preserve timestamps rather than replacing them with delivery time.

## Delivery and safety

Use existing authenticated Host RPC (`POST /remote/diagnostics/relay`) with `{entries: RelayDiagnostic[]}`; a successful 204 acknowledges that records were appended locally. The public session protocol and uplink envelope versions stay unchanged. The internal uplink RPC path allowlist gains this exact POST path, with a required body and no session target or query. Before using it, Relay probes the existing GET `/remote/controller-update` route and requires `diagnosticDelivery: 1` in its response. A 404 or a successful response without that capability disables delivery until reconnect; transient probe failures retry after 30 seconds. This prevents old strict-schema Controllers from receiving an unknown RPC path. Delivery is bounded, asynchronous, one batch per Host in flight, with a 30-second retry delay. Both capability probing and delivery yield while business RPCs exceed 16 or the transport reports any buffered bytes. An updater-status error may still advertise the independent diagnostic capability without changing its error status. Diagnostic failures cannot fail the business state or close session channels. An unacknowledged batch may repeat with the same event IDs; analysis can identify duplicates. No exact-once mechanism is required.

Server retains at most 256 events per Host, 4096 globally, for 24 hours. Batches contain at most 32 events. Prune before persistence. Cloudflare uses an independent SQLite table, Node uses a private file alongside its state file. Their diagnostic storage does not participate in authorization/session commits. Only the registered Host receives its own events; no arbitrary URL or client log submission endpoint is added.

Records are allowlisted metadata: `id`, `timestamp` (ISO), `source: 'relay'`, `hostId`, `relayInstanceId`, `event`, and optional connection/request/stream/agent identifiers, operation, reason, status, close code, duration and count fields. Never include raw errors, URLs with query strings, credentials, message bodies, workspace paths or session titles. Record registration/disconnection, heartbeat failure, RPC timeout/failure, stream opening/readiness/closure, and Relay instance startup for retained Hosts. Avoid successful RPC and heartbeat traffic.

Controller writes `relay-diagnostics.log` separately from `agent-host.log`, private permissions, bounded rotation. Expose a `diagnostics` CLI command with source/time/limit filters and paths, so a local agent can find/read the records without private connection configuration. Logging works in foreground/container and managed modes. Acknowledgement follows successful append; file errors return failure so Server retains the batch.

## Validation

Behavior tests cover retention, failure isolation, retry/ack, Host isolation, timestamp preservation, redaction and Controller file write failure. Real WebSocket tests cover registration, disconnect, replay after reconnect and legacy Controller behavior. Test persisted Server restart in Node/Workers. Run package tests with inner/outer deadlines, typechecks, builds, compatibility update/check. Do not merge, push, deploy, install, or restart running services without subsequent authorization.
