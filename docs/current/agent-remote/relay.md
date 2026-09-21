# Relay — Serialized Remote Session Owner

## Role

`@orchardworks/agent-remote-relay` owns Provider session attachment, current Agent state, ordered canonical Timeline rows, resource ingestion, and public transport composition. Its state engine can run inside a plugin without opening a listener (`packages/agent-remote-relay/src/agent-manager.ts:71-180`, `packages/agent-remote-relay/src/timeline-store.ts:29-68`, `packages/agent-remote-relay/src/transport/plugin-host.ts:36-43`).

## Boundary

The package owns `AgentRemoteRelay`, `AgentManager`, Timeline storage/projection, resource storage interfaces, and the HTTP/WebSocket server factory; it receives Provider adapters through the Provider SDK and maps internal manager events through the remote protocol package (`packages/agent-remote-relay/src/relay.ts:15-27`, `packages/agent-remote-relay/src/agent-manager-events.ts:14-39`).

## Collaborators

| Module | Direction | Responsibility |
| --- | --- | --- |
| Provider SDK | Provider SDK → Relay | Supplies Provider descriptors, sessions, history/live observations, capabilities, and typed controls. |
| Remote protocol | Relay → Remote protocol | Validates serialized request/response schemas and carries only mapped public messages. |
| Web client and Lab | Relay → Web client and Lab | Delivers Snapshots, projected Timeline pages, dedicated interactions, resources, and subscribed live frames. |
| Go broker | Relay → Go broker | Carries Agent or Remote Host uplink responses and independent browser streams after the broker establishes product authorization. |

## Internal Architecture

```mermaid
flowchart LR
  registry["Provider registry"] --> manager["Agent manager"]
  manager --> state["Current Agent Snapshot"]
  manager --> timeline["Canonical Timeline store"]
  timeline --> projection["Projected history pages"]
  manager --> resources["Resource ingestion"]
  manager --> events["Internal AgentManagerEvent"]
  events --> wire["Session wire mapping"]
  projection --> wire
  wire --> transport["HTTP and WebSocket transport"]
  wire --> host["Plugin virtual streams"]
  manager --> executor["Transport-neutral HTTP executor"]
  executor --> transport
  executor --> host
  host --> uplink["Outbound Agent uplink"]
  executor --> remoteHost["Remote Host control and virtual streams"]
```

The relay preserves Provider-neutral boundaries: Provider-native interpretation never enters Relay ownership, and the session wire maps its internal `AgentManagerEvent` values to protocol-encoded messages (`packages/agent-remote-relay/src/session-wire.ts:282-379`).

An attached WebSocket remains protocol-only until exact negotiation succeeds. The session wire then resolves the Agent, subscribes before reading its Snapshot baseline, and bounds manager-event retention during both Snapshot handoff and Timeline-subscription acknowledgement (`packages/agent-remote-relay/src/session-wire.ts:40-69`, `packages/agent-remote-relay/src/session-wire.ts:85-115`, `packages/agent-remote-relay/src/session-wire.ts:217-267`).

Host composition may inject one request access policy for the complete Node HTTP and WebSocket ingress surface. It runs before route decoding and fails closed when the host rejects or throws; the WebSocket principal and per-operation authorizer remain independent requirements. The Relay owns enforcement, while the composing host owns credential meaning (`packages/agent-remote-relay/src/transport/request-access-policy.ts:1-17`, `packages/agent-remote-relay/src/transport/http-router.ts:30-43`, `packages/agent-remote-relay/src/transport/websocket-stream.ts:47-110`).

Node HTTP and the outbound plugin share a socket-free request executor, preserving public codecs and response semantics. Each plugin browser stream owns its own session wire and bounded receive chain; the standalone Node broker supplies authenticated routing while content state remains in the plugin's Relay (`packages/agent-remote-relay/src/transport/http-executor.ts:47-72`, `packages/agent-remote-relay/src/transport/plugin-host.ts:82-117`).

## Key Flows

```mermaid
flowchart LR
  client["WebSocket client"] --> negotiation{"Exact version negotiated?"}
  negotiation -->|"no"| protocolFailure["Protocol error or connection close"]
  negotiation -->|"yes"| attach["Resolve Agent and subscribe"]
  attach --> snapshot["Snapshot baseline"]
  observation["Provider observation"] --> boundary["History boundary and live buffer"]
  boundary --> manager["Agent manager"]
  manager --> row["Append Timeline row"]
  row --> frame["Subscribed serialized live frame"]
  snapshot --> frame
  manager --> page["Fetch projected history page"]
  manager --> interaction["Dedicated interaction message"]
  manager --> diagnostic["Provider failure state"]
```

## Invariants

- A relay session becomes visible only after its Provider history boundary is ready; live observations before it remain buffered (`packages/agent-remote-relay/src/agent-manager.ts:250-279`).
- Resume reattaches a Relay-owned session when the complete persistence handle matches, preserving its Agent identity, epoch, history, and native owner. The response identity is authoritative; the requested Agent identity is a candidate for a cold restore and cannot replace another Agent (`packages/agent-remote-relay/src/relay.ts:93-126`).
- Concurrent cold restores of the same complete persistence handle share one Provider attachment. Failed restores release their reservation for retry, and a restore that completes after Relay closure is disposed before it can become visible (`packages/agent-remote-relay/src/relay.ts:101-150`).
- A Provider observation iterator that fails or finishes while its manager remains open settles as failed Agent/runtime state and emits a `provider_observation_failed` diagnostic; explicit manager close is not reclassified as a Provider failure (`packages/agent-remote-relay/src/agent-manager.ts:238-312`).
- A Provider session that fails attachment is disposed, and a closed manager disposes its owned session before settling its observer (`packages/agent-remote-relay/src/agent-manager.ts:151-171`, `packages/agent-remote-relay/src/agent-manager.ts:238-247`).
- An interaction response may reach a Provider only while the matching request is pending. Host-backed wires validate that state before dispatch and retain the accepted operation result, so a duplicate operation receives an acknowledgement without fabricating an `interaction_resolved` event; native resolution remains authoritative (`packages/agent-remote-relay/src/agent-manager.ts`, `packages/agent-remote-relay/src/session-wire.ts`, `packages/agent-host/src/operation-cache.ts`).
- Planning changes and message submission share one command queue; a planning change requires an idle Agent with no active turn or pending interaction, and publishes Provider runtime state only after the native change completes (`packages/agent-remote-relay/src/agent-manager.ts:198-241`).
- Explicit planning creation fails and disposes the created session when its capabilities cannot honor that request (`packages/agent-remote-relay/src/agent-manager.ts:150-158`).
- A normalized interaction resolution creates a completed Timeline row only when a matching pending request of the same kind exists; native completion owns pending removal, while history/live deduplication prevents duplicate completed rows (`packages/agent-remote-relay/src/agent-manager.ts:351-359`, `packages/agent-remote-relay/src/agent-manager.ts:408-440`, `packages/agent-remote-relay/src/agent-manager.ts:489-503`).
- Snapshot state is reduced separately from Timeline rows; projected history is fetched from the ordered Relay-owned Timeline store (`packages/agent-remote-relay/src/agent-manager.ts:307-380`, `packages/agent-remote-relay/src/timeline-projector.ts:50-120`).
- Backward Timeline pagination selects a projected entry by its first contributing sequence, so an entry remains reachable when later lifecycle updates cross the page cursor (`packages/agent-remote-relay/src/timeline-projector.ts:77-88`).
- Forward Timeline pagination bounds a page by raw sequences before projection, and its cursors and newer-history flag advance only through that raw window, so a coalesced lifecycle entry cannot skip unseen rows (`packages/agent-remote-relay/src/timeline-projector.ts:89-107`, `packages/agent-remote-relay/src/timeline-projector.ts:110-140`).
- Resource bytes are requested by Agent/resource identity; a composed session wire may authorize that request before delegating it, while bindings and lifecycle changes remain public metadata (`packages/agent-remote-relay/src/session-wire.ts:34-42`, `packages/agent-remote-relay/src/session-wire.ts:164-179`, `packages/agent-remote-relay/src/resources/resource-ingestor.ts:88-204`).
- The attached-session wire resolves and subscribes to no Agent before successful exact-version negotiation; its handoff queues have one configured bound, and either overflow or manager-event delivery failure unsubscribes the listener and closes the transport. WebSocket transport preserves retry-later semantics for overflow and uses internal-error semantics for delivery failure without exposing the underlying error (`packages/agent-remote-relay/src/session-wire.ts:40-94`, `packages/agent-remote-relay/src/session-wire.ts:228-280`, `packages/agent-remote-relay/src/transport/websocket-stream.ts:105-145`).
- The attached-session wire emits strict protocol errors for malformed input and unavailable commands (`packages/agent-remote-relay/src/session-wire.ts:85-121`, `packages/agent-remote-relay/src/session-wire.ts:128-214`).
- The Lab creates its HTTP/WebSocket server through exported Relay APIs rather than a Relay-internal transport seam (`packages/agent-remote-lab/src/server.ts:1-23`).
- An uplink binds one Agent, rejects foreign Agent requests and native-session import, and bounds outstanding requests and browser streams (`packages/agent-remote-relay/src/transport/plugin-host.ts:40-45`, `packages/agent-remote-relay/src/transport/plugin-host.ts:120-154`, `packages/agent-remote-relay/src/transport/plugin-host.ts:156-179`).
- An uplink disconnect closes virtual wires and retires response delivery while preserving the Relay and native sessions; reconnection registers again without replaying dispatched operations (`packages/agent-remote-relay/src/transport/plugin-host.ts:48-55`, `packages/agent-remote-relay/src/transport/uplink-client.ts:53-83`).
- Every Remote Host registration includes the Relay's heartbeat interval and reply timeout. After registration, the Relay sends a correlated application `heartbeat` every 30 seconds by default and requires the matching `heartbeat_ack` within 10 seconds. Missing acknowledgement immediately marks the Host offline and retires its old connection, pending requests, and browser streams. The Controller replies to Relay heartbeats and reconnects if no heartbeat arrives within the advertised interval plus timeout, 40 seconds by default. Ordinary business messages do not renew either deadline; connection retirement and explicit closure clear the timers, and authorization rejection still stops automatic reconnect. Native sessions and uncertain operation reservations survive uplink replacement (`packages/agent-remote-hosted/src/broker.ts`, `packages/agent-remote-relay/src/transport/remote-host-uplink-client.ts`).
- Remote Host virtual streams resolve an opaque binding supplied by the product broker. Catalog and creation control are kept outside public Relay routes, while Provider, Snapshot, and Timeline requests resolve only after that binding is available (`packages/agent-remote-relay/src/transport/remote-host-plugin.ts:20-22`, `packages/agent-remote-relay/src/transport/remote-host-plugin.ts:105-157`).
- The independent Agent Host retains Provider directories, native sessions, Relay projections, and a bounded operation cache across uplink replacement. The cache fingerprints operation kind, native target and canonical parameters within an authenticated uplink scope; concurrent duplicates share one dispatch, completed results are retained for ten minutes by default, and unknown outcomes are not redispatched while retained. Entry count, bytes and result sizes are bounded, with in-flight entries pinned and new mutations rejected at capacity. A Host process restart clears this cache by design (`packages/agent-host/src/host.ts`, `packages/agent-host/src/operation-cache.ts`, `packages/agent-remote-relay/src/session-wire.ts`).
- A proven Host admission rejection releases a shared recipient's creation reservation and discards the broker's rejected creation promise for both recipients and owners. This includes cache capacity, oversized result reservation, invalid operation ID and explicit pre-dispatch validation rejection. A manual retry of the same intent can reach the Host after admission recovers. Unknown outcomes, conflicting intents, cache closure, invalid clocks and invalid canonical intent remain conservatively reserved because they do not establish that no earlier effect exists. Successful creation and uncertain-result persistence retain their existing quota semantics (`packages/agent-remote-hosted/src/broker.ts`, `packages/agent-host/src/operation-cache.ts`).
- `AgentManager` applies an optional authoritative `runtime_updated.activeTurnId` independently of task status: `null` clears the old turn, a different ID replaces it, and the same ID preserves `startedAt`. Idle status alone does not change another provider's active turn. SessionWire carries the correction and the resulting Snapshot to clients without fabricating a terminal turn event (`packages/agent-remote-relay/src/agent-manager.ts`, `packages/agent-remote-relay/src/session-wire.ts`).
- On macOS, Controller `start` enables a per-state-directory LaunchAgent by default, reusing saved configuration after login and restarting an exited process. `autostart disable` persists the opt-out and stops the managed service; a later manual `start` respects that preference. `stop` unloads the service and releases owned resources without disabling the next login start. Shared native daemons are not terminated. LaunchAgent metadata contains executable and configuration paths, while enrollment credentials stay in private state files (`packages/agent-host/src/cli.ts`, `packages/agent-host/src/launchd.ts`).
- On Linux, Controller `start` enables a per-state-directory systemd user service when the user manager is available. The service preserves absolute executable paths and PATH, restarts exited processes, writes the bounded Controller log, and uses mixed cgroup cleanup after graceful shutdown. Login startup, explicit stop/disable, and saved connection settings follow the same lifecycle as macOS. A missing user manager permits a warned manual fallback only without an existing systemd installation; explicit enable fails. Pre-login startup requires administrator-managed user lingering. Private startup settings are shared by both supervisors, including reading pending macOS startup settings (`packages/agent-host/src/systemd.ts`, `packages/agent-host/src/autostart-state.ts`).
- Controller uplink diagnostics record connection attempts, registration, the first local disconnect cause, scheduled retries, terminal retry cancellation, and deliberate closure. The CLI writes timestamped JSON lines to its existing daemon log, with process, uplink-generation, and connection identifiers for correlation. Heartbeat deadlines, close codes, HTTP statuses, safe network-error codes, and a fixed set of classified peer reports provide observations without recording payloads, credentials, or raw peer text. Diagnostic callbacks cannot interrupt transport recovery (`packages/agent-remote-relay/src/transport/remote-host-uplink-client.ts`, `packages/agent-host/src/host.ts`, `packages/agent-host/src/cli.ts`).
- Outbound transport queues have message-count, byte, and write-deadline bounds; exhaustion retires the connection instead of silently dropping a public message (`packages/agent-remote-relay/src/transport/uplink-writer.ts:40-76`).

## Non-Goals

- The Relay does not import a Provider-native SDK or projector (`packages/agent-remote-relay/src/agent-manager.ts:1-24`, `packages/agent-remote-relay/src/relay.ts:1-13`).
- The standalone store is injected and in-memory by default; it does not decide product authorization, retention, garbage collection, or deployment topology (`packages/agent-remote-relay/src/relay.ts:23-27`, `packages/agent-remote-relay/src/resources/resource-store.ts:34-94`).

## See also

- [Agent Remote](README.md) — area boundary and related modules.
- [Protocol](protocol.md) — strict public wire that this package maps to.
- [Providers](providers.md) — native interpretation that remains above the Relay boundary.
- [Web](web.md) — browser consumer of the serialized relay boundary.

## Implementation Anchors

- `packages/agent-remote-relay/src/relay.ts:15-27`
- `packages/agent-remote-relay/src/agent-manager.ts:71-380`
- `packages/agent-remote-relay/src/agent-manager-events.ts:14-39`
- `packages/agent-remote-relay/src/timeline-store.ts:29-68`
- `packages/agent-remote-relay/src/timeline-projector.ts:21-120`
- `packages/agent-remote-relay/src/session-wire.ts:40-379`
- `packages/agent-remote-relay/src/transport/http-executor.ts:36-118`
- `packages/agent-remote-relay/src/transport/plugin-host.ts:36-184`
- `packages/agent-remote-relay/src/transport/uplink-client.ts:25-125`
- `packages/agent-remote-relay/src/transport/remote-host-plugin.ts:20-184`
- `packages/agent-remote-relay/src/transport/remote-host-uplink-client.ts:14-145`
- `packages/agent-remote-relay/src/transport/uplink-writer.ts:12-78`

## Interaction response boundaries

Before invoking a Provider, the manager validates each response against the pending request and claims that request for a single responder. Native failure releases the claim for deliberate retry. Native resolutions and hydrated completed interaction rows pass through request-aware redaction before reaching public events or history, including records supplied by a Provider that did not redact its own receipt (`packages/agent-remote-relay/src/agent-manager.ts`, `packages/agent-provider-sdk/src/interactions.ts`).

## Session setting selection

`setSessionSetting` shares the existing command serialization with message and planning operations. It checks capability, idle status, active turn, pending interactions and the latest advertised mutable choice before invoking the Provider. On completion it reads fresh native runtime state and publishes the Snapshot update before command acknowledgement. The wire rejects foreign Agent identities and preserves native errors as operation failures (`packages/agent-remote-relay/src/agent-manager.ts`, `packages/agent-remote-relay/src/session-wire.ts`).

## Provider command routing

`listCommands` checks the optional Provider capability and validates unique opaque IDs and names in the returned directory. `executeCommand` shares serialization with message, planning, and session-setting operations, reads a fresh directory, rejects an unavailable command ID, and forwards the untouched argument string to the Provider. The Provider owns native availability and busy-state checks. Successful execution refreshes runtime state before returning the result; it can still leave a pending native menu interaction (`packages/agent-remote-relay/src/agent-manager.ts`, `packages/agent-provider-sdk/src/commands.ts`).

The session wire returns `command_list` for `list_commands` and `command_result` for `execute_command`, preserving `requestId` and the bound `agentId`. Neither path sends an extra `command_acknowledged`; wrong-Agent requests, missing capabilities, and native failures use the existing error path. Command-owned questions and forms enter the same pending-interaction state and response validation as other Provider requests. Interaction responses remain outside the command queue so a command waiting on user input can continue (`packages/agent-remote-relay/src/session-wire.ts`, `packages/agent-remote-relay/src/agent-manager.ts`).

Message delivery intent passes unchanged through the existing send operation. Relay rejects `next_turn` without `queueMessage` capability before calling native code. Once a native command execution has been accepted, immediate and next-turn sends fail promptly until it settles, including when the command itself is waiting behind another control operation. This prevents a long native command from implicitly retaining later user messages in the control serialization chain. Cancellation and interaction responses remain independent (`packages/agent-remote-relay/src/agent-manager.ts`, `packages/agent-remote-relay/src/session-wire.ts`).

Command descriptors can expose a short description and an optional Provider-owned documentation locator. The Relay binds that locator to a session-specific resource ID without reading content during discovery. A resource request revalidates the current directory, acquires the document through the Provider reader and existing resource ingestion checks, and responds under the advertised resource ID. Removed commands and unregistered resource IDs are unavailable; documentation reads do not enter the command execution queue (`packages/agent-remote-relay/src/agent-manager.ts`).


Runtime updates retain native child relationship summaries and refresh the session capability snapshot before publishing `agent_update`. Child observations use separate AgentManagers and the ordinary session wire, so their Timeline and pending interaction identities remain isolated. A parent summary is not a copy of its children's pending requests.
