# @borgee/agent-remote-protocol

`@borgee/agent-remote-protocol` is the exact-version JSON boundary between the Agent Remote relay and a pure Web client.

## Boundary

The package owns strict TypeBox schemas plus JSON codecs for Agent creation and resumption, current state, projected Timeline history, live Timeline delivery, interactions, resource reads, command acknowledgement, and protocol errors. Every public behavior-bearing object rejects additional properties, and every top-level message requires protocol version `1.0.0`.

Provider-native values and server-internal `AgentStreamEvent` or `AgentManagerEvent` unions do not cross this boundary. Public stream values are independently declared even where a server-internal event currently has the same fields.

## Synchronization

`AgentSnapshot` contains current Agent state and authoritative pending interactions. It does not contain Timeline rows, epoch, or cursor.

Timeline history uses projected entries that identify their sequence coverage and any assistant, reasoning, or tool rows collapsed during projection. Public Timeline `agent_stream` events carry `{epoch, seq}`; consecutive assistant-message and reasoning fragments append in sequence, while projected history returns their equivalent merged string. Interactions are synchronized only through Snapshot plus dedicated `interaction_requested` and `interaction_resolved` messages, not through `agent_stream`.

Create and resume requests carry client request identity and a stable relay Agent identity. Creation selects a Provider and supplies its session configuration; resumption supplies the Provider persistence handle. The `agent_session` response correlates the request with relay and Provider session identity. Accepted message, steer, and cancel commands receive `command_acknowledged`; a rejected command receives `protocol_error` with the same `requestId`.

## Resources

Timeline entries bind visible locators to Borgee resource identities. Resource reads distinguish acquisition in progress, immutable available bytes, retryable or terminal ingestion failure, and unavailable Provider sources.

## Exports

- TypeBox schemas and inferred types for every public request, response, Snapshot, Timeline, interaction, and resource value.
- Focused codecs for Snapshot, Timeline page, live stream, resources, Agent creation, Agent resumption, and Agent-session responses.
- Aggregate `decodeClientMessage` / `encodeClientMessage` and `decodeServerMessage` / `encodeServerMessage` codecs.
- `BORGEE_AGENT_REMOTE_PROTOCOL_VERSION` and `ProtocolVersionSchema` for the one accepted wire version.
