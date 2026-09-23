# @orchardworks/agent-remote-protocol

`@orchardworks/agent-remote-protocol` is the exact-version JSON boundary between the Agent Remote relay and a pure Web client.

## Boundary

The package owns strict TypeBox schemas plus JSON codecs for Agent creation and resumption, current state, projected Timeline history, live Timeline delivery, interactions, resource reads, command acknowledgement, and protocol errors. Every public behavior-bearing object rejects additional properties, and every top-level message requires protocol version `1.5.0`.

Provider-native values and server-internal `AgentStreamEvent` or `AgentManagerEvent` unions do not cross this boundary. Public stream values are independently declared even where a server-internal event currently has the same fields.

## Synchronization

`AgentSnapshot` contains current Agent state and authoritative pending interactions. It does not contain Timeline rows, epoch, or cursor.

Timeline history uses projected entries that identify their sequence coverage and any assistant, reasoning, or tool rows collapsed during projection. Public Timeline `agent_stream` events carry `{epoch, seq}`; consecutive assistant-message and reasoning fragments append in sequence, while projected history returns their equivalent merged string. Interactions are synchronized only through Snapshot plus dedicated `interaction_requested`, `interaction_resolved`, and `interaction_invalidated` messages, not through `agent_stream`. Invalidation removes stale pending controls without fabricating a response Timeline entry.

Create and resume requests carry client request identity and a stable relay Agent identity. Creation selects a Provider and supplies its session configuration; resumption supplies the Provider persistence handle. The `agent_session` response correlates the request with relay and Provider session identity. Accepted message, steer, and cancel commands receive `command_acknowledged`; a rejected command receives `protocol_error` with the same `requestId`.

## Resources

Timeline entries bind visible locators to Borgee resource identities. Resource reads distinguish acquisition in progress, immutable available bytes, retryable or terminal ingestion failure, and unavailable Provider sources.

## Exports

- TypeBox schemas and inferred types for every public request, response, Snapshot, Timeline, interaction, and resource value.
- Focused codecs for Snapshot, Timeline page, live stream, resources, Agent creation, Agent resumption, and Agent-session responses.
- Aggregate `decodeClientMessage` / `encodeClientMessage` and `decodeServerMessage` / `encodeServerMessage` codecs.
- `BORGEE_AGENT_REMOTE_PROTOCOL_VERSION` and `ProtocolVersionSchema` for the one accepted wire version.

## Persistent session channels

`/v1/session-channel?observation=session|activity` multiplexes independent existing
session wires over one WebSocket per observation mode. The direct
`/v1/sessions/:id/events` endpoint remains supported. Every outer frame uses
`protocolVersion: "1.5.0"`; nested session messages retain their existing schemas.

| Direction | Type | Additional fields |
| --- | --- | --- |
| Client | `subscribe` | `subscriptionId`, `agentId`, `message` (existing `negotiate`) |
| Client | `message` | `subscriptionId`, `message` (existing client message) |
| Client | `unsubscribe` | `subscriptionId` |
| Client | `ping` | None |
| Server | `ready` | None |
| Server | `message` | `subscriptionId`, `message` (existing server message or incompatible-version error) |
| Server | `closed` | `subscriptionId`, `code`, `reason` |
| Server | `pong` | None |

Subscription IDs are positive safe integers, increase throughout a physical
connection, and identify connection incarnations rather than agents. Replayed or
older subscribe IDs and messages for removed subscriptions are ignored. Closing
or unsubscribing one stream does not close siblings. Unsubscribe takes effect
immediately even while opening or dispatching a long-running command. Frames are
ordered within each subscription; asynchronous preparation never blocks another
subscription. Physical closure disposes all logical sockets without command replay.

Activity channels require `negotiate.observation: "activity"`. Their only client
session message is negotiation; their server messages are negotiation responses,
activity updates, and protocol errors. Session channels reject activity negotiation.
The mode boundary prevents activity subscriptions from downloading content or
issuing commands.

`acceptSessionChannel(socket, mode, openSession)` provides runtime-neutral virtual
`SessionChannelSocket` instances to existing per-session wires. Each injected
`openSession(agentId)` must perform current authorization and return either
`{ accept(socket) }` or `{ code, reason }`. Existing wires remain responsible for
per-message authorization, credential expiry, revocation, and session semantics.
The returned cleanup function closes the owned channel and removes listeners.

The adapter limits frames to 16 MiB of UTF-8, concurrent subscriptions and
unsettled work to 128, open attempts to 120 per minute, and opening time to
35 seconds. Unresolved open factories retain their capacity reservation after
cancellation or timeout. Pending input is limited to 64 frames / 16 MiB per stream
and 16 MiB across the channel; physical outbound buffering is limited to 16 MiB.
Stream preparation, response validation, mode, and pending-queue failures close
only the affected stream. Invalid outer frames, binary input, oversized inbound
frames, physical errors, and shared outbound backpressure close the channel.

The frame limit accommodates a 10 MiB input image encoded as a base64 resource
response. Hosted Worker and Node sockets use the same 16 MiB frame limit;
the Host uplink retains its 32 MiB limit. HTTP mutation body limits are unchanged.

The package exports `SessionChannelClientMessage` and `SessionChannelServerMessage`
as schemas and types, with matching `decodeSessionChannel*Message` and
`encodeSessionChannel*Message` codecs using the standard wire-result convention.


`agent_activity.payload.cursor` (`epoch`, `seq`) carries the canonical content
boundary captured with that activity snapshot. Unchanged activity does not produce
cursor traffic. A cursor is not a state version and does not order the two
connections. Deploy the Controller and Relay with the matching protocol schema.

When opening an observed session, the workbench freezes that cursor for the
navigation. The tracking button edge advances only as the replica applies content
and closes immediately at the target, even if newer history still awaits Ready.
Buffered out-of-order events, matching status labels, and timers cannot complete
it. Already caught-up cache completes immediately; an absent cursor omits the
indicator. A different content epoch hides the indicator without claiming success;
the fixed target can resume if that epoch later arrives. Retired target epochs
remain unavailable. Normal Ready gating for commands remains independent.

### Historical positions

On-demand native history can prepend rows before the initially loaded Timeline. Timeline page cursors, projected row positions, sequence ranges, and resource-binding replacement positions therefore accept signed safe integers. Initially loaded and live rows keep their original positions. Historical rows use `0, -1, -2, ...` in reverse insertion order. Live event and activity cursors remain nonnegative; backfill never advances or rewinds the live cursor. Timeline `window.minSeq` can be negative, while `maxSeq` and `nextSeq` retain the live high-water mark.

This extends the unreleased protocol snapshot. Deploy matching Controller and web codecs together; an older client that only accepts nonnegative historical positions cannot decode backfilled pages. Compatibility metadata identifies the matching implementation.

## Optional Host diagnostic delivery

The Host uplink RPC allowlist includes the exact `POST /remote/diagnostics/relay`
path with a required body and no session target, query, or trailing path. Its
`{entries}` body is validated by the shared hosted diagnostic contract (1–32
allowlisted records), and 204 acknowledges a local append. Relay must first probe
`GET /remote/controller-update` and require `diagnosticDelivery: 1`; old strict
uplink decoders must never receive this new path. A 404 or successful response
without the capability disables delivery until reconnect. Transient failures
retry after 30 seconds. A failed updater-status response may still advertise the
independent diagnostic capability while preserving its original error status. Public session protocol 1.5.0 and uplink version 2 are
unchanged; no register/registered fields are added. Codec fixtures live in
`src/relay-diagnostics.test.ts`; real transport coverage also verifies legacy
capability discovery and reconnect delivery.

Diagnostic delivery versions are independent of the public session protocol:

- Version 1 accepts connection and stream diagnostics.
- Version 2 additionally accepts authority renewal events and lease/retry timing.
- Version 3 additionally accepts `wasClean`, `runtimeInstanceId`, `workerVersionId`,
  and `startReason` (`runtime_start` or `core_recovery`, on `relay_started` only).

Relay removes unsupported optional fields/events before sending to older
Controllers. `closeCode` records the native socket close code; `wasClean` is
included only when exposed by the runtime. Node ws does not expose `wasClean`,
so it remains absent rather than being inferred from the code. Raw close reasons
are never logged. Server-initiated retirement retains its first cause and code;
a later native close event does not replace it or emit a duplicate disconnect.
