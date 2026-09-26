# Public Session Boundaries

Status: implementation authorized; publishing and deployment are not included.
Source baseline: `eef85749c988475098e1b49619ca7a952f9fea8a`.
Evidence: source inspection only; no native Provider or fault-injection certification.

## Objective

A new Provider adapter should supply native operations, observations and truthful capabilities. It should reuse session projection, operation settlement, protocol recovery and the session view. Host and embedded DSH integration must retain ownership of their native environments.

## Alternatives

1. Only inject the existing Host cache into DSH. This closes one gap but leaves standalone WebSocket and plugin paths with different guarantees and introduces a dependency on the Host package.
2. Extract small shared session services and require every writable entry point to use them. Recommended: preserve existing packages, wire shapes and native ownership while testing the same guarantees across integrations.
3. Replace Host and DSH integration with a universal runtime manager. Rejected: creation, workspace admission, process ownership and disposal have materially different semantics. A large optional interface would conceal these differences.

## Two boundary directions

Session View means the logical session module, including headless state and actions, protocol interaction and optional rendering. It is not only a React component and does not require a single package.

There are two different reasons for keeping behavior outside its shared implementation:

1. **Surrounding consumers:** product navigation, Favorites, Tracked retention, account UX, Controller update orchestration and ARDB recording controls use the module. The module exposes enough state, capabilities, actions and lifecycle notifications for them to compose their behavior without inspecting private state. It must not import these consumers or their contexts.
2. **Implementation extensions:** native restore, process ownership, workspace admission, safe detach and native directory operations implement typed framework extension contracts. Their mechanisms differ, but they participate in the same public semantics. Their capability descriptions, outcomes and observations must be understandable without consumer-side Provider branches.

The shared core sits between these boundaries. It owns binding invariants, operation settlement, recovery semantics and authoritative operation eligibility. Implementation variation is not permission to bypass those mechanisms; consumer policy is not a reason to put product behavior into them.

| Concern | Surrounding consumer interface | Shared core responsibility | Implementation extension |
| --- | --- | --- | --- |
| Observation and actions | Headless state, timeline/composer, supported actions and reasons for unavailability | Projection, normalized state and protocol dispatch | Native observations, SDK/RPC interpretation and action execution |
| Operation settlement | Submit intent and observe receipts or uncertainty | Fingerprint, concurrent join, bounded retention, conflict and outcome semantics | Trusted scope/target resolution, execution and evidence of rejection or reconciliation |
| Binding and creation | Select/open/create a target and observe its binding outcome | Reservation, identity/parent invariants, settlement and publication | Workspace admission, native open/create/fork, ownership proof and release |
| Directory | Browse/select using truthful summaries and capabilities | Existing cursors, revisions and `RemoteHostCatalog` | Enumeration, inclusion policy, supported settings and exact-ID lookup |
| Recovery | Observe transport, replica and runtime facts; preserve drafts | History/live handoff, stale callback suppression and action eligibility | Transport dial/backoff and native restore via their respective interfaces |
| Control and takeover | Render control state and invoke a supported takeover action | Shared/exclusive semantics, authority revision, validation and settlement | Native owner inspection and handoff; process release only where supported |
| Retention and disposal | Tracked policy requests retention/release of subscriptions | Subscription/reference lifecycle and consistent detachment | Ownership-aware native detach/release; borrowed processes are not implicitly stopped |
| Security | Account/sign-in UX and presentation of authorization decisions | Trusted request context and per-request control/authorization enforcement | Host admission and authority verification, supplied by the appropriate integration |
| Recording and playback | ARDB manages files, playback and recording controls | Reusable observations/state/actions; playback has no live authority | Native execution is available only through an actual live binding |

One feature can cross all columns. A takeover button consumes a common action; the core applies control and operation rules; an implementation extension performs native handoff. Browser-to-browser transfer may require no native process action. Shared sessions must not inherit exclusive takeover simply because an extension supports process ownership.

Likewise, Controller updates remain surrounding orchestration, while native safe-release facts come from implementation extensions and are exposed through framework lifecycle semantics. Favorites and Tracked can retain a connection without deciding whether a Provider process should be killed.

Prefer existing SDK capabilities and narrow typed extension points. Distinguish Provider interpretation from Host authority/environment extensions; do not move Host policy wholesale into the Provider SDK. Do not introduce an untyped plugin bag, arbitrary native RPC forwarding, or wire fields without a demonstrated consumer. Public meaning does not require one package or a common native algorithm.

## Operation service

Move the generic bounded cache from `agent-host` into `agent-remote-relay`. Keep `OperationDescriptor`, `OperationWork`, `OperationCache` and `SessionWireOperationExecutor` as the starting interfaces. Remove native-product wording and native error interpretation from the generic cache.

Use one cache per session-service lifetime, shared across its sockets and session projections. The Host may supply that same instance for create/rename and session operations. Standalone Relay owns an instance by default; DSH keeps its instance across uplink reconnects. Closing a socket must not close the cache. A service replacement ends the guarantee even if the OS process survives.

Every production `createSessionWire` entry point must receive a settlement executor, including remote uplink, direct WebSocket, and legacy plugin composition. Remove the silent direct-dispatch fallback from production composition; migrate low-level tests explicitly. Do not instantiate a cache for each wire or recover scope from browser input.

The service guarantees, within the same trusted scope and retention window:

- The same operation ID and normalized intent join one in-flight execution or return its retained result.
- The same ID with a different kind, native target or parameters is rejected.
- Validation rejected before dispatch is distinguished from dispatch with an unknown result.
- Unknown outcomes never trigger an automatic second native dispatch.
- Cached completion is a receipt for the original operation, not a claim about present native state.
- Current authorization and control are checked even when a retained receipt is available. Dispatch checks repeat after asynchronous validation.

Retain the current default terminal retention of 10 minutes, capacity of 1,000 entries and 8 MiB, and no eviction of in-flight entries. Capacity exhaustion rejects before dispatch. Expiry or service/process restart does not provide cross-lifetime deduplication. Document this limitation and preserve explicit reconciliation for uncertain operations; do not describe it as exactly-once execution.

Native target identity uses provider plus native session identity, within the trusted service/authority scope. Opaque public `agentId` rebinding must not accidentally create a different operation identity. An ephemeral native session uses a service-owned incarnation identity; it must not pretend to be durable. Parent identity and current binding still require validation.

Adapter-confirmed rejection needs a narrow typed SDK signal with the documented guarantee that the requested effect was not applied. A generic exception, timeout or disconnected RPC remains unknown. Existing `AgentRuntimeError` codes alone do not prove rejection. Uncertain-agent retention and native reconciliation use explicit runtime lifecycle extensions: implementations supply evidence and resource handling, while the core retains ownership of settlement semantics. Neither product components nor extensions may silently replay an uncertain operation.

No persistent ledger, automatic retry of uncertain mutations, or new operation-status endpoint is proposed. If a future requirement needs clients to recognize cache replacement or expired receipts, design and version an explicit operation-service generation/retention contract rather than inferring it from reconnect.

## Binding and creation

Keep `RemoteHostCatalog`: Host and DSH already use it. Native enumeration and exact-ID access retain their existing policies; a catalog miss is not authorization denial.

Extract a small binding registry with immutable native/public identities, parent identity, in-progress reservations and explicit publish/failure transitions. It must prevent two concurrent opens from publishing conflicting bindings. It must not own native process termination or decide whether disposing a borrowed session is safe.

Expose an internal operation result for native creation separately from projection/binding. If creation succeeds but attachment fails, retry attachment to the known native ID rather than create again. Do not cache an obsolete public binding as if it were the native creation result.

Preserve DSH's registry that allocates a stable native ID for a creation intent as a native integration mechanism. It has different lifetime and identity semantics from public operation settlement, including survival of transport replacement. Shared settlement must not erase this behavior or merge authentication scopes to imitate it.

Do not promote all of `AgentHostDirectory` into the SDK. Split its mixed responsibilities: consumer retention/update policy remains outside the module; native ownership, detach and handoff implement framework lifecycle extensions; native enumeration/create/rename use directory capability contracts; Host tool exposure remains a separately scoped integration. Unsupported creation settings must remain explicit errors. Implementations report truthful capability and ownership facts rather than requiring the product to identify Providers.

## Recovery and mutation eligibility

Session state maintenance is part of the shared abstraction, not merely a collection of display fields. Native extensions report authoritative runtime facts; the core owns their public transitions, observation failure, interaction lifetime and operation admission. Client recovery owns transport/subscription generations and synchronization, and exposes a common session experience to headless and rendered consumers. Product code must not independently reconstruct native readiness. Native internal state machines remain implementation-specific.

Keep three independent facts: transport connection, synchronized replica, and native runtime state. Control ownership and capability are additional operation-specific inputs. `RemoteSessionStatus.ready` remains synchronized observation, not universal permission to mutate.

Existing public mechanisms are preserved: `history_boundary`, buffered live handoff, `timeline_replacement`, epoch/cursor recovery, generation checks, subscription/history/control handshake, and pending-interaction validation.

Define operation-specific eligibility from authoritative server state: capability, control, native availability, binding, and interaction validity. Centralize shared checks before native dispatch; adapters retain the final native check. Do not apply one blanket idle/connected requirement to send, steer, cancel, settings and approvals. Working sessions can accept supported input; observations and history remain usable without write permission. UI decisions are advisory and cannot replace server checks.

Old connection callbacks and revoked control proofs expire. `operationId` survives reconnect within its service scope. A native interaction remains valid only if the adapter still recognizes it; native restart does not recover a process-local callback from historical text. Preserve still-live interactions across browser reconnects.

Keep ordinary unsent browser input separate from uncertain dispatched operations and native next-turn queueing. Only the former automatically flushes when authoritative readiness returns. Recording playback carries no live authority.

## Reusable view

Retain the actual product timeline and composer in ARDB. Extract only boundaries revealed by current imports:

- Public session state/actions and connection subscriptions consume `RemoteSessionClient` and `AgentReplica`.
- Product composition supplies account readiness, reauthentication presentation, persistent recovery scope, links and Tracked retention policy through the consumer boundary. Takeover uses the common control state/action; native owner inspection and handoff are implementation extensions, not product callbacks that bypass dispatch.
- ARDB supplies process-local session selection, live/replay/record controls and protocol tracing without account dependencies.

Initially introduce explicit props/services inside the existing composition. Move the proven session-only component/hook into `agent-remote-web/react` only after it no longer imports Lab/product contexts. Do not move `LabWorkbench`, `ConversationConnections` or their CSS wholesale merely to change their package address.

## Delivery boundaries

Before implementation, map each affected behavior to its consumer interface, shared invariant and implementation extension. Reuse existing contracts first; identify who supplies authoritative facts and who executes side effects.

1. Shared operation settlement and complete writable-entry-point integration, with explicit runtime lifecycle extensions and contract tests.
2. Operation-specific rejection/eligibility semantics, preserving normalized events and native differences.
3. Binding invariants and creation recovery, retaining existing catalog reuse.
4. Session-view composition isolation after the core semantics are stable.

Each phase must be independently reviewable and testable. Update fixtures, schema compatibility metadata and `pnpm compatibility:update/check` with the affected implementation. Internal factoring does not justify a wire version bump; actual schema or negotiated-guarantee changes require coordinated version/compatibility review.

Host/Relay runtime changes require a new Controller package and an updated DSH integration, plus rebuilt ARDB. A website-only deployment cannot supply these guarantees. During staggered rollout do not advertise uniform guarantees that old integrations do not have. Publishing/deployment is a separate authorized action.

## Acceptance

Run the same real-transport scripts against Host, DSH and standalone ARDB: concurrent duplicate input, lost receipt, conflicting parameters/target, scope isolation, cache expiry/replacement, delayed validation with control revoked, disconnect during dispatch, binding race, create success with attach failure, native restore failure, history/live handoff, valid/stale interaction and replacement epochs.

Assert native dispatch counts, receipt outcomes and replica contents, not only UI labels. A headless client must observe the same decisions as the page. Native fixtures prove contract behavior; opt-in real Provider runs separately certify native mechanisms. Use per-test and outer process deadlines, isolated state and free ports. Never restart an active user daemon as part of validation.

Also verify both boundary directions: the same consumer operates shared, exclusive and borrowed-runtime fixtures through capabilities rather than Provider names; unsupported extensions produce explicit unavailable behavior; changing product retention policy does not change operation settlement or native ownership; ARDB and product use the same control path. Dependency checks must reject core imports of product/ARDB shells and renderer access to native process details.
