# Persistent Session Channels

## Approved behavior
The browser owns two persistent WebSocket channels: full sessions and activity. Full-session subscriptions coexist for the primary window and side windows. Focus changes never replace another window subscription. Replacing or closing a window removes only its subscription. Activity observes tracked sessions plus all displayed/open session windows; current windows remain excluded from the floating tracking list. Background activity never downloads history.

Ordinary switching retains one full subscription: unsubscribe the previous session, then subscribe the next. Only additional open side windows add full subscriptions. The goal is stable mobile navigation without repeated physical handshakes, not increased throughput.

Each full subscription retains the existing RemoteSessionClient, AgentReplica, epoch/cursor recovery, and operation identity. Cached content displays immediately when revisiting. Full-session state is authoritative for its window after its snapshot arrives. Activity provides an initial status hint only; a disconnected full session keeps its last state and an explicit connection indicator. No cross-channel status versions are introduced.

Cached content and a ready physical channel do not authorize interaction. Each target subscription must finish negotiation, snapshot, and required timeline synchronization before sending, approval, cancellation, settings, or console commands become available. Draft editing remains available when a cached agent exists. One window synchronizing does not disable a ready sibling.

On mobile resume, recover the two shared channels and restore the active subscriptions as one page recovery. Later session switches reuse those recovered connections. This reduces repeated interruption across navigation; it does not promise that the operating system will keep sockets alive during sleep. Browser resume events are covered by automated tests; real cellular behavior remains a manual acceptance boundary.

## Transport contract
Add `/v1/session-channel?observation=session|activity` without replacing `/v1/sessions/:id/events`. Outer frames carry protocolVersion 1.4.0. A monotonically increasing numeric subscriptionId isolates each logical connection incarnation. Client frames: subscribe(subscriptionId, agentId, message=negotiate), message(subscriptionId, message=existing ClientMessage), unsubscribe(subscriptionId), ping. Server frames: ready, message(subscriptionId, message=existing ServerMessage), closed(subscriptionId, code, reason), pong. Activity channels enforce activity negotiation and prohibit content/control traffic. Session channels prohibit activity negotiation. Nested messages retain their existing public schemas.

The channel is a transport adapter, not a new runtime interpreter. Server subscriptions use existing authenticated single-session endpoints/wires. Hosted subscriptions re-check current user access for every subscription and retain per-message checks, expiry, revocation, and native binding recovery. Host uplink and provider APIs remain unchanged. One failed subscription does not close siblings. Physical disconnect closes all logical streams; existing clients reconnect their own subscriptions. Idle channels are bounded and explicitly disposed with their owner. Browser-resume detection restores both channels. Stale frames are ignored after unsubscribe, without silently replaying commands.

## Implementation boundaries
Pure schema and framing lifecycle live in agent-remote-protocol; runtime authorization is injected. Hosted gateway routes each subscription through its existing broker. Standalone relay authenticates the channel and authorizes every subscription. HttpWebSocketTransport optionally uses the channel pool; the application opts in. Existing callers and old single-session endpoints remain supported. A channel rejected before ready falls back to the direct endpoint for compatibility, with no command replay after ready.

## Verification
Schema rejection and round trips; logical stream isolation and cancellation during async attach; malformed/oversized traffic; authorization per stream; real WebSockets for channel reuse, reconnect, and parallel sessions; client cleanup and no stale delivery; UI primary/side switching, cache reuse, activity coverage, current exclusion. Tests have per-test and process deadlines. Build dependencies before browser tests. Update/check compatibility metadata and document framing. No changes to running Host/daemon configuration are required.
