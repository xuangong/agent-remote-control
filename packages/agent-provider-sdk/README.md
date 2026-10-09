# Agent Provider SDK

`@orchardworks/agent-provider-sdk` defines the server-internal, provider-neutral adapter boundary for Agent Remote.

Provider adapters create or resume sessions that emit normalized `AgentStreamEvent` values. User, assistant, and reasoning Timeline bodies are strings. Provider-private observation wrappers retain stable source keys and native revisions for history/live correlation, with exactly one `history_boundary` separating history from live delivery.

Providers can expose native recovery independently from task status through optional `runtimeInfo.connection`. A disconnected runtime invalidates stale interactions with `interaction_invalidated`; invalidation removes the pending request without recording an answer or denial.

After readiness, an adapter can emit a `ProviderTimelineReplacement` containing the complete ordered Timeline observations when native history fills an earlier gap. This server-internal item carries Timeline events only and does not replay runtime state or interactions. Relay mints a fresh epoch and reuses the existing public `timeline_replacement` flow; adapters must preserve native identity and avoid emitting replacements for unchanged history.

Sessions expose text commands directly through `sendMessage(text)`, optional `steer(text)` and `cancel()`, and typed `respondToInteraction(requestId, response)`. Questions, plan approvals, and tool approvals are separate closed unions. Capability flags must match the optional methods implemented by a session.

Timeline content stays within the event-specific item structures. Generated files remain provider resources until the Relay acquires them and publishes resource bindings.

## Exports

- `@orchardworks/agent-provider-sdk` — adapter, session, observation, capability, persistence, runtime, Timeline, interaction, and resource-read types.
- `@orchardworks/agent-provider-sdk/testing` — reusable provider contract tests, bounded stream collection, and capability validation.

An optional `olderCursor` on `history_boundary` or `timeline_replacement` advertises earlier Timeline history. Sessions implementing `readTimelineHistory(cursor)` return chronological, history-delivery Timeline observations plus an optional `nextCursor`. The Relay commits the cursor only after successful ingestion, coalesces concurrent requests, and ignores pages belonging to a replaced Timeline epoch. The reader must not mutate live runtime status, replay input, or advance its own cursor before the Relay accepts the result.


### Input acceptance

`AgentSession.sendMessage`, `sendMessageContent`, and `steer` resolve to `AgentInputAcceptance | void`. Return `{ disposition: 'started' | 'queued' | 'handled' }` only when the native receipt establishes that outcome for the submitted input. `handled` means no run starts for this input; independent work may still be active. `queued` does not promise that input remains queued. `started` does not establish current execution or completion. Return `void` if disposition is unknown; do not infer it from a successful write, timeline, or runtime snapshot.

Execution remains authoritative through `runtimeInfo` and `runtime_updated`. A handled input may produce no user-message echo or turn events. Delivery uncertainty remains an unknown operation outcome, never a fabricated acceptance disposition or rejection.

### Current usage

`usage_updated` and `turn_completed.usage` report snapshots, never deltas to accumulate. Optional `tokenScope` distinguishes cumulative native session tokens (`session`), cumulative tokens during the current native execution lifetime (`runtime`), the latest native turn (`turn`), and the latest model invocation (`call`). Runtime totals restart when the provider starts or resumes a runtime, or explicitly clears its accounting; they do not promise the persisted session's lifetime total. When scope is known, `inputTokens` excludes cache reads and writes; `cachedInputTokens`, `cacheCreationInputTokens`, and `outputTokens` are separate buckets. `totalTokens` is the total from that same snapshot, provided directly or computed only when the native fields establish it completely. All token values are nonnegative safe integers. Missing values are unknown; zero is a valid measurement.

Token counters (including scope and total), current context (`contextScope`, `contextWindowUsedTokens`, and `contextWindowMaxTokens`), and the legacy `totalCostUsd` field form independent replacement groups. `contextScope: 'current'` confirms current context occupancy independently of `tokenScope`; context-only measurements are valid. Reporting any defined value in a group replaces that group, including removal of omitted fields; other groups remain last known. An empty update or an undefined property has no effect. Context occupancy is not cumulative consumption and may decrease after compaction. Unscoped legacy counters remain accepted but do not establish normalized token or current-context semantics.

Adapters interpret native scope and cache semantics. The public state reducer preserves only the latest measurements; it does not construct history or a billing ledger. Cold attach can restore usage only when the native runtime exposes it. Retained Remote snapshots do not promise usage persistence across Host restarts.

## Session setting application

`setSessionSetting` may be called while a turn is active. Keep native scheduling and policy checks inside the adapter. Return `void` after native application, `{ status: 'pending' }` after native queue acceptance, or `{ status: 'deferred' }` only when no mutation was submitted and a later native readiness event permits retry. Publish actual selections through runtime settings; a request acknowledgement alone must not optimistically change them. Emit a runtime observation when a private readiness lock is released, even when the visible settings are unchanged.

`runtimeInfo({ refreshSettings: true })` requests a fresh native settings read when the adapter has a read-only native getter. Unsupported fields retain their last native confirmation; do not resume or mutate a session just to read them. Guard asynchronous readbacks against newer native observations.

The public relay owns accepted intent identities, supersession, deadlines and failure notices. It does not cancel active turns or resolve approval requests to apply a setting, and never retries a native mutation whose result is uncertain.
