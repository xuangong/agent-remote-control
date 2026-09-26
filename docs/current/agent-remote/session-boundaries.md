# Public Session Boundaries

The logical Session View includes headless observation, native-derived state, operation admission, recovery and control. React renders that module. Product navigation and ARDB recording controls are consumers of it.

## Consumer contract

`RemoteSessionClient.getSessionState()` and `subscribeSessionState()` expose transport status, replica synchronization, native connection state, control, native handoff progress and per-operation availability. A synchronized read-only session is valid; `ready` does not grant permission to mutate.

`SessionViewActions` describes input, interaction responses, settings, commands, resources and control. `useSessionView` owns a connection lease. A `SessionConnectionSource` can retain an existing connection independently of mounted views. Tracked/Favorites decide retention policy; releasing a view does not decide native process ownership.

Product `LabWorkbench` wraps the shared `SessionWorkbench` with draft storage, reading positions, account error presentation and workspace links. ARDB uses the same renderer and the Web hook directly. Replay remains explicitly read-only even when supplied mutation callbacks. The renderer remains in Lab with its presentation dependencies; package movement is not required to establish the dependency boundary.

## Implementation extensions

| Extension | Implementation supplies | Common module maintains |
| --- | --- | --- |
| Provider `AgentSession` | Normalized observations, native commands, runtime facts, capabilities and native interaction validity | Session transitions, public projection and mutation admission |
| `OperationLifecycle` | Trusted native target, admission, retention and uncertainty resource hooks | Intent matching, concurrent joining, retained outcomes and no automatic replay |
| `SessionBindingExtension` | Native attachment and disposal of a completed late attachment | Identity checks, reservation, publication and shutdown admission |
| Client `SessionControlExtension` | Authorized endpoint to resume the same native binding | Waiting for synchronization and native ownership release, then requesting browser control |

The client native-control extension receives the current owner generation and an abort signal. It must honor the signal and validate the returned binding. `checkOnly` reopens/inspects without requesting another native interruption. Resolving confirms the endpoint operation; the public client still waits for authoritative synchronization and native ownership release. An extension may throw `SessionHandoffRejectedError` only when it guarantees that no interruption occurred. All other failures, including unknown transport error codes, have an uncertain outcome. The common layer does not interpret provider/Host error-code lists. Missing support produces `native_control_unavailable`. Native process mechanics and workspace admission remain in Host/provider implementations. The product supplies endpoint configuration, not an alternate recovery state machine.

`SessionHandoffScope` owns a `SessionHandoff` for each target and retains unconfirmed results by owner generation independently of connection leases. Clients default to `sessionHandoffScope(transport)` and the public agent ID; consumers with stable native identities supply `handoffTarget`. Product connections and pre-attachment consumers use the same host/provider/native target key. Releasing an untracked connection or remounting React with the same transport does not reset the recovery policy. A consumer replacing its transport within the same authority can explicitly reuse `handoffScope`; a new authority must use a separate scope. Scopes are memory-only and their guarantee ends when the consumer/authority scope is discarded, not when a socket closes. No native interruption is automatically replayed.

An uncertain handoff makes subsequent requests for that owner check-only, even if the caller supplies `checkOnly: false`. A failed status check does not clear uncertainty, even when that check was definitely rejected. Successful restoration clears only the matching retained state; a different owner generation permits a new interruption. A rejection after native restoration started cannot retroactively guarantee that no interruption happened. State and progress are subscribable by rendered and headless consumers alike.

An unopened directory target can still expose an attachment error and native-owner notice before a Session View exists. Directory selection and initial attachment belong to the surrounding consumer. Pre-attachment takeover uses the same `SessionHandoff` policy, with identities scoped by target and owner generation; switching targets cannot discard an unconfirmed interruption. Once bound, control and recovery use the common client.

## Shared state and operation rules

`reduceSessionState` is used by AgentManager and the client replica. Native turn events update activity and active-turn identity. Pending interactions overlay activity with `waiting`; their removal reveals the latest native activity. Runtime recovery does not resolve interactions or invent a completed turn. Observation-stream failure marks the native connection unavailable while retaining known activity and history.

| Operation | Required native capability | Additional rule |
| --- | --- | --- |
| Input | `sendMessage` | Working sessions may accept input |
| Next-turn input | `sendMessage` and `queueMessage` | Distinct from the browser's unsent input queue |
| Steer / cancel | Corresponding capability | Native adapter decides whether the current work can accept it |
| Planning / settings | Corresponding capability | Idle, no active turn and no pending interactions |
| Commands | `commands` | Command-specific validation remains authoritative |
| Interaction response | Pending request identity and valid response | A claimed request cannot be submitted again |

All native mutations require native availability. The public client also reports synchronization and write authority. Server dispatch rechecks current authority and native admission after asynchronous validation and after waiting in the Manager command queue. The common executor carries the final admission guard through the Manager operation context. Manager mutations separate preparation from the actual native call: a failure before that call is a definite rejection, while a generic failure after it is uncertain, including a failed metadata refresh. An explicit rejection from the native mutation itself can still guarantee no effect.

Control transfer fences accepted operations that have not yet called the native mutation. It does not cancel or relabel operations already dispatched to the provider. Shared sessions continue to authorize multiple clients independently. Client availability only explains behavior; it cannot authorize a mutation.

A generic native error after dispatch has an unknown outcome. `AgentOperationRejectedError` is an explicit guarantee that the requested effect was not applied. Only that guarantee releases a failed interaction claim for another submission. Resolution or invalidation from the native source retires the claim. Historical interaction text does not reconstruct a live callback.

## Settlement and binding lifetime

Host, DSH uplink, standalone WebSocket and plugin paths use the Relay-owned operation executor. A writable SessionWire without an executor rejects writes. HTTP/plugin create and explicitly identified resume operations use the same service. Trusted authority establishes scope; client fields cannot select another authority's receipt.

The cache retains terminal outcomes for 10 minutes, up to 1,000 entries and 8 MiB, without evicting in-flight work. Repeating an ID with another target, kind or parameters conflicts. Cached success confirms the original operation, not present runtime state. Unknown outcomes never trigger automatic native redispatch. These guarantees end with the service/cache instance and do not survive process restart.

`resume_agent.operationId` is an optional schema extension. Legacy requests remain accepted and default HTTP clients retain their legacy payload. Explicit callers must use identified resume only with receivers supporting the extension; this is not negotiated compatibility with an older strict 1.5 receiver. No new default wire field is sent to existing deployments.

Native creation and public attachment are separate. Host retains a native creation result before binding it. DSH keeps its context-owned native creation identity across transport replacement, records confirmed creation before projection, and retries only attachment after a projection failure. An unconfirmed creation is not dispatched again. This registry is not an expiring public receipt cache.

`SessionBindings` reserves provider/native/public identities before attachment, joins compatible opens and preserves published identity through restore failure. Shutdown rejects work that has not begun and disposes completed late attachments through the integration extension. Borrowed DSH session disposal releases observation resources, not the underlying runtime.

Relay starts cache draining and native disposal together. Native session ownership begins when a provider returns the session, before runtime metadata/history readiness. Late native returns after shutdown are disposed once. Providers remain responsible for canceling opening calls that never return a session; the framework does not invent a universal native cancellation mechanism.

## Validation scope

Contract tests cover all three real transport compositions, lost receipts, repeated/conflicting operations, authority changes, native-state admission, binding races, native-create success followed by projection failure, shutdown during opening and renderer/live/replay parity. Native-provider certification remains separate and requires supported local CLI versions. No live daemon restart is needed for these tests.
