# WebSocket abnormal closure diagnostics

## Observation

On 2026-09-23, the local Mac Host recorded 26 registered uplink disconnects
between 13:16 and 21:26 Asia/Shanghai. Fifteen fell within 45 seconds after a
Worker deployment. Four other reconnects used a new Relay instance; seven
returned to the same instance in 0.98–1.42 seconds. These are correlations,
not proof of the cause of every disconnect.

The seven same-instance closures had valid authority and no recorded local
heartbeat timeout, protocol error, or write failure. One received a heartbeat
942 ms before closing. Historical system logs did not establish a corresponding
sleep or Wi-Fi link failure. Code 1006 alone cannot identify the failed hop.

## Added evidence

The authenticated diagnostic RPC continues to deliver records to the owning
Host's existing `relay-diagnostics.log`, with original timestamps and IDs.

- `closeCode`: native close code, including 1006 for an abnormal Node closure.
- `wasClean`: native Worker CloseEvent value. Absent for Node ws and for
  server-initiated retirement recorded before its closing handshake finishes.
- `heartbeatAgeMs`: time since the last acknowledgement, including passive closes.
- `runtimeInstanceId`: random ID created by the Durable Object constructor.
- `workerVersionId`: ID from Cloudflare's version metadata binding.
- `startReason`: `runtime_start` when the constructor creates the core, or
  `core_recovery` when the existing object rebuilds a failed core.

`relayInstanceId` continues to identify the core journal. During internal
recovery it changes while `runtimeInstanceId` stays the same. During object
recreation both change. `workerVersionId` can associate the event with the
exact code version. None of these fields claims to know why Cloudflare
recreated an object (deployment, platform maintenance, or another cause).
A platform termination may prevent the old instance from recording its close.

Only allowlisted metadata is retained. Socket reason text, payloads, credentials,
and arbitrary exception messages are excluded. Diagnostics retain the first
retirement cause and do not change heartbeat, reconnect, or session behavior.

## Compatibility and validation

Diagnostic capability version 3 enables the new fields. Relay strips them for
versions 1 and 2; the public session protocol and uplink version are unchanged.
Existing persisted records remain valid, and replay retains their original
runtime/version association. Full visibility requires both Server and
Controller updates. Updating only the Server still improves close-code records
for older diagnostic-capable Controllers.

Validation covers real Node WebSocket normal and forced closure, reconnect
delivery to a Host log file, Worker close events, persisted Worker restart,
core recovery after storage failure, and version 1/2 delivery.

Cloudflare documents the binding at
<https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/>.
