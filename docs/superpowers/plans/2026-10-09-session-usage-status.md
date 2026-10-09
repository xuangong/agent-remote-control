# Session Usage Status

## Scope

Show the latest native cumulative usage snapshot in the existing composer Session status panel, shared by primary, Ask, Side, and child Session Views. Keep session totals, current-runtime totals, legacy latest-turn/latest-call tokens, and current context occupancy distinct. Do not add historical charts, accounting ledgers, event-by-event accumulation, model distributions, cost UI, or another entry point.

## Contract

- Add optional `tokenScope` (`session`, `runtime`, `turn`, `call`), `contextScope` (`current`), `cacheCreationInputTokens`, and `totalTokens` to SDK and Remote usage.
- Claude reads cumulative `modelUsage` for the current Query with `runtime` scope; native resume and clear reset its accounting. Copilot reads the native session aggregate from `session.rpc.usage.getMetrics()` with `session` scope. Neither substitutes turn/call counts for totals.
- Scoped token buckets are disjoint: uncached input, cache read, cache write, and output. Missing values remain unknown; zero is a known value.
- Token and context updates replace their own group while retaining the other group. Undefined properties behave like absent wire properties. Empty updates preserve the current snapshot. Never sum updates.
- Reuse the same reducer for live delivery and retained history facts. Reconnection restores the latest snapshot; no new persistence or historical reconstruction is added.
- Token and context scope are independent; existing unscoped usage remains decodable but is not presented as normalized tokens or current context.

## Implementation

1. Add contract/reducer regressions, shared usage snapshot update, SDK/protocol documentation, and wire round-trip coverage.
2. Normalize Codex, OpenCode, Claude, and Copilot at their adapter boundaries using native evidence. Preserve native scope and independent context values.
3. Render compact usage facts within existing Session status, including unavailable and last-known states.
4. Verify native fixtures, a real WebSocket snapshot/reconnect flow, replica replay, and desktop/mobile SessionWorkbench rendering.
5. Review the final changes, update and check compatibility metadata, and run relevant builds/typechecks.

## Boundaries

Cold attach shows only what the provider exposes; a retained Relay snapshot does not imply persistence across Host restarts. Copilot's experimental metrics RPC uses the pinned SDK/CLI pair and must fail without blocking interaction. Historical usage collection is outside this change. Do not modify native Codex, restart user daemons, or publish/deploy as part of implementation.
