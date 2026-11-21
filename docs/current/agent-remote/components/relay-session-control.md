# Relay session control
Module: `packages/agent-relay-core/src/domain/session-control/session-control.ts` (pure table) and `packages/agent-relay-core/src/stream-control.ts` (shell); tests: `core/domain/session-control/session-control.test.ts`, `core/stream-control.test.ts`, `core/journal-session-stream.test.ts`, `core/broker-journal-sessions.test.ts`.

| Clauses | Gaps when written | Closed by a test | Not tested, with the reason |
|---:|---:|---:|---:|
| 20 | 4 | 4 | 0 |

## Purpose
- C1. One browser stream holds a control lease that says what the stream may do to its session; the lease is a pure transition table `transition(state, event) -> { state, reply }`.
- C2. The shell (`createStreamControl`) decodes browser frames, mints ids, asks the Controller who holds the session natively, and sends what the table replies; the table owns no socket, clock or id source (the caller passes `fresh`).

## Inputs and outputs
- C3. Events: `announce`, `snapshot`, `acquire { requestId, revision, fresh }`, `mutation { requestId?, token? }`, `refused { code, owner?, fresh }`, `holder { revision, owner? }`. Replies: `none`, `state`, `refuse` (`session_control_changed` or `session_read_only`), `pass`, `ask_holder`.
- C4. `viewOf` is what the browser is told: `access` is `control` and the token is shown only while a token exists and no owner is recorded; `available` is true exactly when no owner is recorded.
- C5. The shell sends `session_control` (the view plus `agentId` and the `requestId` it answers) and refusals as recoverable `protocol_error` with the request id (an interaction answer's `submissionId` counts as one).

## States and transitions
- C6. A new stream is read-only with no token; its first state is announced once, after the Controller's Snapshot (`snapshot` announces only the first time; `announce` always sends).
- C7. `acquire` with the current revision issues the token once and later acquires keep it; it clears the native owner.
- C8. `acquire` with another revision is refused with `session_control_changed` and changes nothing, including a held token.
- C9. A mutation passes only with the stream's live token; otherwise `session_read_only` (no token held, wrong token, no token, or a token revoked by ownership).
- C10. A refusal with code `native_session_owned` revokes the token and starts a new revision; with a named owner it records it and sends the state; without one it asks the Controller (`ask_holder`).
- C11. A `holder` answer counts only for the revision it was asked under; an older revision's answer is dropped and does not undo a later acquire.
- C12. Any other refusal code changes nothing.

## Limits
- C13. No numeric limits: the lease has no clock or count. The revision and token are fresh `randomUUID()` values per event (`stream-control.ts`).

## Errors and refusals
- C14. A control request or mutation frame that does not decode is refused with `invalid_shape` (carrying the request id when readable) and never forwarded; other frames and non-JSON go on untouched.
- C15. If the Controller cannot say who holds the session, the session is shown available and read-only.
- C16. `controllerFrame` forwards every Controller frame first, then reads only `agent_snapshot` (announce) and a `protocol_error` with a string `code` (refusal).

## Guarantees (ordering, no loss, no doubles)
- C17. The first state is sent at most once by Snapshot; a refused acquire never removes a granted token.
- C18. The table reads its arguments and writes nothing to them; the owner object is not shared with the event or the state.
- C19. The two session paths (the journal session stream and the Host-session proxy in `host-session.ts` / `socket-edge.ts`) answer control and refuse a mutation without a live grant themselves, and a mutation with the token goes on to the Controller.
- C20. Native refusal (O48): when the CLI refuses the Controller as a client of the session for its own reason (`nativeRefusal`, another process writes it), the stream is read-only and unavailable and is told the reason; the token is kept and a mutation is refused; an `acquire` with the current revision answers with the state and asks the Relay to attach the session again (`retry_native`); clearing the refusal gives control back under the same revision. The refusal is the Relay's per binding (`session-bindings.ts`): an attach or recovery refused with a reason records it, one that succeeds clears it, and every journal-served stream of the session follows. An attach of a session the Relay reads from its journal is answered with its binding despite the refusal; one it cannot read is refused with the reason in fixed words. Nothing offers a take-over.

| Clause | Test(s) that prove it |
|---|---|
| C1 | `session-control.test.ts` > "the lease transition table" (every row) |
| C2 | `stream-control.test.ts` > "answers an acquire with the request id and the token, and lets a mutation with that token go on", "asks the Controller who holds the session when a refusal names no owner, and shows the answer" |
| C3 | `session-control.test.ts` rows: "announce sends the first state and marks it announced", "acquire with another revision is refused as changed and changes nothing", "a mutation with the live token passes", "an ownership refusal that names no owner revokes the token and asks who holds the session", "the holder of the asked revision is recorded" |
| C4 | `session-control.test.ts` > "the view a browser is told" > "is read-only and available for a new stream", "is control with the token once acquired", "is read-only, unavailable and names the owner while a terminal holds the session, whatever token is left" |
| C5 | `stream-control.test.ts` > "refuses a mutation without the token and keeps the stream open" (recoverable, request id), "refuses an acquire for a revision that is not current", "refuses an interaction answer without the token with its submission id as the request id"; the frames read at the client: seams `S3/session-control-wire.integration.test.ts` > "S3 session control frames: the decoder and the lease of the client" > "%s: every session_control and protocol_error frame decodes, and the lease follows from access and owner" (every S3 transcript), and "S3 session control frames: a real client replays the recorded acquisition" > "acquires control from the recorded lease, answers with the recorded request, and shows the lease the Relay named" |
| C6 | `session-control.test.ts` rows "announce sends the first state...", "the first Snapshot announces", "a later Snapshot says nothing"; `stream-control.test.ts` > "announces a read-only state once, after the first Snapshot" |
| C7 | `session-control.test.ts` rows "acquire with the current revision issues the token and answers the request", "acquire again keeps the first token", "acquire clears the native owner and issues a token" |
| C8 | `session-control.test.ts` rows "acquire with another revision is refused as changed and changes nothing", "a refused acquire does not take away a held token", "acquire on the revision before the owner appeared is refused" |
| C9 | `session-control.test.ts` rows "a mutation before any acquire is refused as read-only", "a mutation with another token is refused", "a mutation without a token is refused while a token is held", "a mutation with a token that was never issued is refused while no token is held", "the revoked token no longer passes", "a refused mutation without a request id carries none" |
| C10 | `session-control.test.ts` rows "an ownership refusal that names the owner revokes the token and records it", "...on a read-only stream records the owner too", "...names no owner revokes the token and asks who holds the session", "a second ownership refusal starts another revision"; `stream-control.test.ts` > "shows the owner a refusal names, takes the token away and tells the browser" |
| C11 | `session-control.test.ts` rows "a holder for an older revision is dropped", "a holder for an older revision does not undo an acquire that came first"; `stream-control.test.ts` > "drops the answer to a question asked under a revision that has moved on" |
| C12 | `session-control.test.ts` row "a refusal that is not about ownership changes nothing" |
| C13 | `stream-control.test.ts` > "never gives two streams, or two acquires and refusals of one stream, the same revision or token" |
| C14 | `stream-control.test.ts` > "refuses a control frame that does not decode and never forwards it", "leaves frames that are neither control nor a mutation to go on" |
| C15 | `stream-control.test.ts` > "shows the session available when the Controller cannot say who holds it"; `session-control.test.ts` row "no holder for the asked revision leaves the session available and says so" |
| C16 | `stream-control.test.ts` > "announces a read-only state once, after the first Snapshot" (forwarded twice), "asks the Controller who holds the session when a refusal names no owner, and shows the answer" |
| C17 | `session-control.test.ts` rows "a later Snapshot says nothing", "a refused acquire does not take away a held token" |
| C18 | `session-control.test.ts` > "reads its arguments and writes nothing to them", "does not share the owner object with the event or the state" |
| C19 | `journal-session-stream.test.ts` > "answers control and refuses a mutation without a live grant itself, never opening the Controller stream", "shows the native owner and revokes control when opening the session is refused for it", "learns the owner after a refusal at delivery, which names none, by asking the Controller once"; `broker-journal-sessions.test.ts` > "shows the native owner and revokes control when the first operation is refused for it, and keeps serving reads". The Host-session proxy path: `host-session.test.ts` > "host session browser streams through the Relay" > "forwards the Controller frames of a stream with a lease, and shows the lease after the Snapshot and after an ownership refusal", "sends a frame of a stream without a lease as it is, addressed with the public session id" |
| C20 | `session-control.test.ts` > "a session the CLI refuses as a client (O48)" (7 rows and the view); `broker-native-refusal.test.ts` (3 tests: the binding answered and the page told why, a Retry that asks the Controller again and gives control, a refusal of a session without a journal); S2 `writer-elsewhere.integration.test.ts` (2 tests, with the CLI simulator) |

Gaps: none. Closed 2026-11-21: C5's `submissionId`, C13 (fresh ids, as a property of the shell), the Host-session proxy path of C19,
and the wire shape of `session_control`: the Relay's frames were checked against the transcripts, but the client read only hand-written
frames; now every recorded `session_control` and refusal frame passes the client's decoder and its lease reading.

Tests that map to no clause: none found.

## Tests added with the statements

| Test | Component and clauses |
|---|---|
| `agent-relay-core/src/domain/session-control/session-control.orderings.test.ts` | Relay session control C4, C6 to C12, C17: every order of four events on one page (14,641 orders), every interleaving of two pages with a terminal's refusal at any point (140 orders); a broken order prints its sequence |

## Gaps closed

Closed on 2026-11-21. The clause table above names each test by its title; this table names the file and the mutations of the rule that the test fails on (each was applied, run and reverted).

| Component, clause | Test file | Mutation caught |
|---|---|---|
| Session control C5 | `stream-control.test.ts`; seams `S3/session-control-wire.integration.test.ts` | the `submissionId` branch of the request id removed; `native_cli` dropped from the protocol's owner kinds; the client not publishing the owner |
| Session control C13 | `stream-control.test.ts` | a constant fresh id; a constant first revision |
| Session control C19 (Host-session proxy) | `host-session.test.ts` | the `stream.control` branch skipped |
