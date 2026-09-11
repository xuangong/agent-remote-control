# Codex delta occurrence handling

## Diagnosis

The repeated-delta defect is present at `e4561056ff9a9c1fad03dc333f0b23d2628e2bcd`.
`CodexEventProjector` previously hashed a native delta payload into its observation
source key. It emitted every notification but accumulated equal payloads only
once. Legitimate streams such as `e`, `e` or `e`, `a`, `e`, `b` therefore produced
an incomplete private accumulator and a spurious completion suffix or correction.
Relay also deduplicates observation source keys, so it could drop the repeated
fragment before delivery to the client.

Codex app-server's `AgentMessageDeltaNotification` and `PlanDeltaNotification`
carry thread, turn, item, and delta fields, with no occurrence identifier or text
offset. Reasoning summary deltas additionally identify a summary part, which
still does not identify an individual occurrence. Equal payloads cannot prove
retransmission. This was checked against the local Codex Rust protocol definitions
in `codex-rs/app-server-protocol/src/protocol/v2/item.rs`.

A separate completion issue was reproduced: completing a fully streamed item
removed its accumulator without recording that the item was final. A second
completion could then emit the full text again.

## Fix and boundaries

- Every accepted assistant, plan, or reasoning-summary delta contributes text and
  receives a new UUID observation identity. IDs remain distinct when a history
  refresh creates another projector. Replaying an already projected observation
  retains its original identity and is still deduplicated by Relay.
- Text completion is terminal for its turn, item ID, and native item type, even
  when it emits no text. Repeating that completion emits nothing. Reusing an item
  ID in a later turn remains supported by the projector.
- Equal final text emits nothing; prefix extension emits only the missing suffix.
  Genuine non-prefix assistant/plan differences retain the separate correction
  message. Reasoning differences retain the existing visible diagnostic.
- History item comparison and character-coverage trimming are unchanged. A partial
  history snapshot can absorb covered characters while retaining equal uncovered
  delta occurrences.
- The public append-only text contract, Relay deduplication, renderer coalescing,
  and public epoch/sequence replay behavior are unchanged. No schema or protocol
  version change is needed.

This does not infer native retransmission from text equality or repair previously
stored incorrect timeline rows. Native deltas have no stable replay identity;
replaying raw notifications as new occurrences is different from replaying an
existing provider observation or public sequence. Reasoning-summary formatting
and genuine final-text correction semantics are outside this fix.

## Regression evidence

Before the fix, seven projector regressions, the partial-history child regression,
and all four real-transport cases failed. After the fix, the focused projector,
session, and child suite passes 71 tests; the transport suite passes four cases.

- `projector.test.ts`: consecutive/nonconsecutive repeated fragments, whitespace,
  punctuation, repeated substrings, assistant/plan/reasoning, distinct source
  identities across items/turns/projector lifetimes, and repeated completion after
  matching, suffix, correction, or unstreamed final text.
- `session.test.ts`: buffered repeated characters and matching completed items
  already covered by a concurrent history read.
- `child-sessions.test.ts`: history advances from `e` to `ee`; buffered `ee`, `e`
  retain exactly two uncovered `e` occurrences, and final `eeee` adds no text.
- `codex-delta-transport.test.ts`: actual HTTP/WebSocket server, Relay, remote
  client, and replica. Equal native occurrences survive, replayed observation
  identities and public sequences are consumed once, and reconnect/history
  produce the same single message.

Tests use local transports and native-shaped fixtures without a model request.
All test runs impose per-test and outer process deadlines.

Workspace validation passed 1,330 tests, with seven existing opt-in tests skipped.
The first concurrent run timed out in the unchanged native Codex process test;
that test passed alone and in the subsequent serial workspace run. The Lab run
initially rejected the stale compatibility digest; after regenerating it, the
entire Lab suite passed (264 tests, six skipped). Workspace typecheck and build,
plus `pnpm compatibility:update` and `pnpm compatibility:check`, also passed.
