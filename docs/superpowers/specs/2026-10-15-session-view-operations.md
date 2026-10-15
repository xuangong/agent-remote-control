# Standard Session View Operations

## Accepted behavior

All live standard Session Views share message-send and prompt-edit behavior. Main, independent windows, Team leaders and members, Ask, Side, TPM, and ARDB Live are placements of a session, not separate capability tiers. Actual Provider support, native prompt boundaries, connection/control state, and unresolved effects still determine operation availability. Replay remains read-only.

After confirmed input admission, clear exactly the submitted draft. Retain edits made while the input is in flight, drafts belonging to another session, and input whose admission is unresolved. A Timeline echo alone is not an admission receipt. Explicit image-draft ownership must have a matching recipient; do not weaken existing succession ownership checks to clear text.

Prompt editing retains the current native-prefix fork semantics: preserve the original conversation and workspace files, prepare a new native session before the selected first prompt of a turn, and restore that prompt into its composer without sending it. Support is declared by adapters rather than hardcoded to Codex in a view. Native child restrictions and unsupported input bindings must remain truthful.

## Replacement boundary

An edited session must retain its product role and associations: source readers for Ask/Side, Team member identity and scoped tools, TPM work identity and scheduling, favorites, Track, windows, and draft ownership. Tools must be present at native attachment creation. Durable replacement admission and creation evidence must precede association publication. A failed publication after native creation must recover forward to the same target. An unknown native effect must never be retried as a new fork.

Already dispatched or unknown inputs keep their concrete recipient and receipts. Replacing a session must not retransmit them or import history removed by the edit. Existing succession roles and reader cursor provenance must continue to resolve correctly. Old attachments cannot retain authority to act as the current Team member or TPM after replacement.

## Constraints

- Work only in `.worktrees/session-view-rewind`; preserve existing services and sessions.
- Keep Provider SDK, adapters, public Remote protocol, Relay authority, Host ownership, and rendering separate.
- Do not introduce account or Borgee dependencies into standalone Session View or ARDB.
- Do not merge, push, publish, or deploy without a further user request.
- Use observable tests, including real transports for operation/reconnect behavior, with per-test and outer deadlines.
- Update compatibility metadata after implementation review and verify it.

## Validation

Exercise both legacy and explicit draft owners through real mounted views. Check confirmed send, rejection, delayed ACK, concurrent draft edits, recipient replacement, and unmount/remount. Exercise prompt edit from each placement, first and later native turns, repeated edits, restart after each durable stage, preserved source reads/tools, and unchanged uncertain-delivery recipients. Do not substitute a component render or package smoke test for live Provider acceptance.
