# Agent Provider SDK

`@borgee/agent-provider-sdk` defines the server-internal, provider-neutral adapter boundary for Agent Remote.

Provider adapters create or resume sessions that emit normalized `AgentStreamEvent` values. User, assistant, and reasoning Timeline bodies are strings. Provider-private observation wrappers retain stable source keys and native revisions for history/live correlation, with exactly one `history_boundary` separating history from live delivery.

Sessions expose text commands directly through `sendMessage(text)`, optional `steer(text)` and `cancel()`, and typed `respondToInteraction(requestId, response)`. Questions, plan approvals, and tool approvals are separate closed unions. Capability flags must match the optional methods implemented by a session.

Timeline content stays within the event-specific item structures. Generated files remain provider resources until the Relay acquires them and publishes resource bindings.

## Exports

- `@borgee/agent-provider-sdk` — adapter, session, observation, capability, persistence, runtime, Timeline, interaction, and resource-read types.
- `@borgee/agent-provider-sdk/testing` — reusable provider contract tests, bounded stream collection, and capability validation.
