# Session State Authority

## Approved design

Native execution state is supplied by AgentSession.runtimeInfo and live runtime_updated observations. Turn events describe turn identity and results; they do not determine session execution state. Pending interactions remain a separate collection and may overlay the display status without overwriting native activity. Clearing an interaction restores the native status without guessing from activeTurn.

Each AgentSession observation stream belongs to one native identity and attachment lifetime. Adapters serialize native queries and events and must discard stale native results. The Manager ignores historical runtime/interactions for live admission, fences asynchronous metadata refresh against intervening native observations and shutdown, and uses its existing per-attachment lifetime. The Remote client retains its connection generation guard and must prevent an older asynchronous snapshot from replacing newer live facts. No wall-clock timestamp is a causal ordering authority.

The existing runtime_updated wire representation is sufficient. Adapters must publish changes explicitly, including activeTurnId when known; lack of a turn ID does not imply idle. Native runtime loss retains last-known activity and closes mutation admission. Operation success retains the documented delivery-channel acceptance semantics; no new acknowledgement or replay promise is introduced.

## Work plan

1. Add failing behavior tests for execution/turn separation, matching turn completion, interaction overlays, history isolation and delayed runtime queries.
2. Update the shared reducer and Manager/client synchronization where evidence demonstrates missing fences.
3. Update built-in native adapters and executable fixtures to publish authoritative runtime transitions; retain provider-specific interpretation inside adapters.
4. Verify real WebSocket observation and reconnect, provider regressions, replay/view parity, schemas and compatibility metadata. Record any native certification limitations.

## Acceptance

- A completed/failed/canceled turn cannot end an ongoing session run or clear another turn.
- Pending interaction resolution never guesses native execution state.
- Historical state cannot manufacture a live interaction or regress current execution.
- An older async runtime query cannot overwrite a newer runtime observation, nor reopen a closed attachment.
- Built-in adapters still update rendered and headless activity through the same source.
- No second provider-specific execution state machine is introduced in Relay or View.
