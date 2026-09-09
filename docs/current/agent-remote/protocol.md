# Agent Remote Protocol — Strict Public Remote Contract

## Role

`@borgee/agent-remote-protocol` defines the versioned public messages exchanged by a Remote client and Relay; it is neither a Provider-native event model nor the Relay's internal manager bus (`packages/agent-remote-protocol/src/messages.ts:150-176`, `packages/agent-remote-relay/src/agent-manager-events.ts:14-39`).

## Boundary

The package owns `protocolVersion`, strict runtime schemas, client/server message unions, Agent Snapshot, Timeline page, interactions, and resources (`packages/agent-remote-protocol/src/version.ts:3-10`, `packages/agent-remote-protocol/src/messages.ts:22-176`).

Independently versioned Agent and Remote Host uplink envelopes carry registration, request correlation, and virtual browser streams between a plugin and the standalone Node broker. Public protocol JSON stays an opaque string inside either transport envelope; the uplink does not redefine or normalize public content (`packages/agent-remote-protocol/src/uplink.ts:5-40`, `packages/agent-remote-protocol/src/remote-host-uplink.ts:18-40`).

## Collaborators

| Module | Direction | Responsibility |
| --- | --- | --- |
| Provider SDK | Provider SDK → Protocol | Supplies TypeScript values that Relay translates before they cross the public boundary. |
| Relay | Relay → Protocol | Decodes client input and encodes only the declared ServerMessage union. |
| Web | Protocol → Web | Supplies the sole values that the headless replica and React DOM client reduce. |

## Internal Architecture

```mermaid
flowchart LR
  version["Protocol version"] --> schemas["Strict runtime schemas"]
  schemas --> client["ClientMessage union"]
  schemas --> server["ServerMessage union"]
  snapshot["Agent Snapshot"] --> server
  history["Timeline page"] --> server
  interaction["Interaction messages"] --> server
  resource["Resource messages"] --> server
```

The public union is an explicit composition of independently strict schemas, so a Relay cannot expose an internal `AgentManagerEvent` merely because it has a related shape (`packages/agent-remote-protocol/src/messages.ts:150-176`).

## Key Flows

```mermaid
flowchart LR
  connect["WebSocket opens"] --> negotiate["Negotiate protocol version"]
  negotiate --> snapshot["Receive Agent Snapshot"]
  snapshot --> subscribe["Subscribe to selected Timeline"]
  subscribe --> acknowledged["Receive subscription acknowledgement"]
  acknowledged --> page["Fetch tail or after cursor"]
  page --> live["Reduce public live stream"]
  live --> gap{"Gap or replacement?"}
  gap -->|"yes"| page
  gap -->|"no"| render["Render replica state"]
```

The wire requires negotiation before an attached session sends its Snapshot, and it serializes Timeline subscription acknowledgement before queued Timeline delivery (`packages/agent-remote-relay/src/session-wire.ts:74-109`, `packages/agent-remote-relay/src/session-wire.ts:142-153`).

## Invariants

- Protocol negotiation requires exactly version `1.1.0`; planning controls and completed interaction history belong to this public contract rather than an implicit fallback (`packages/agent-remote-protocol/src/version.ts:3-6`, `packages/agent-remote-protocol/src/messages.ts:74-82`, `packages/agent-remote-protocol/src/timeline.ts:54`).
- Planning is an optional capability with an explicit creation preference and authoritative runtime state; clients cannot infer planning support or activity from permission settings or a command acknowledgement (`packages/agent-remote-protocol/src/snapshot.ts:19-55`, `packages/agent-remote-protocol/src/messages.ts:71-87`, `packages/agent-remote-protocol/src/messages.ts:124-135`).
- `AgentSnapshot` contains current Agent state and pending interactions, not Timeline entries (`packages/agent-remote-protocol/src/snapshot.ts:47-72`).
- Timeline recovery uses `timeline_page` with an epoch and cursors; a stale or forward cursor is represented explicitly rather than inferred from Snapshot (`packages/agent-remote-protocol/src/history.ts:13-48`, `packages/agent-remote-relay/src/timeline-projector.ts:50-88`).
- Interaction requests and responses have closed, kind-specific structures (`packages/agent-remote-protocol/src/interactions.ts:22-134`).
- Plan rejection may carry feedback; approval responses cannot carry rejection feedback, and completed interaction rows retain the typed request and response for Timeline recovery (`packages/agent-remote-protocol/src/interactions.ts:87-109`, `packages/agent-remote-protocol/src/timeline.ts:54`).
- Public resource bindings expose a visible locator, resource ID, and lifecycle state; Provider read identities are absent from the schema (`packages/agent-remote-protocol/src/resources.ts:22-30`).
- Uplink envelopes reject undeclared fields, unsupported transport versions, invalid response statuses, and invalid stream-close values without parsing their nested public JSON. Remote Host catalog reads, including a current native-session summary, carry neither a binding target nor a request body; content reads and mutations retain their binding target (`packages/agent-remote-protocol/src/uplink.ts:42-69`, `packages/agent-remote-protocol/src/remote-host-uplink.ts:59-73`).

## Non-Goals

- The package does not interpret Provider-native values or own Relay-internal manager events; those values enter only through Relay mapping into the declared public message union (`packages/agent-remote-protocol/src/messages.ts:150-176`, `packages/agent-remote-relay/src/session-wire.ts:208-311`).

## See also

- [Agent Remote](README.md) — the area boundary that composes this public contract.
- [Relay](relay.md) — the owner that maps internal manager events to this wire.
- [Web](web.md) — the public-wire consumer.

## Implementation Anchors

- `packages/agent-remote-protocol/src/messages.ts:22-176`
- `packages/agent-remote-protocol/src/snapshot.ts:47-72`
- `packages/agent-remote-protocol/src/history.ts:13-48`
- `packages/agent-remote-protocol/src/interactions.ts:22-134`
- `packages/agent-remote-protocol/src/resources.ts:22-94`
- `packages/agent-remote-protocol/src/uplink.ts:5-69`
- `packages/agent-remote-protocol/src/remote-host-uplink.ts:18-76`
