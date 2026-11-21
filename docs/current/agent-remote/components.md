# Components of the session path: design clauses and their tests

Each component on the session path states its design as numbered clauses (purpose, inputs and outputs, states and transitions,
limits, errors and refusals, guarantees), and every clause names the tests that prove it. A clause without a test is a gap: close it
at the lowest tier (a unit test with mock data, a vector row, a recording or a seam test), or say why not. A test that proves no
clause is a candidate for deletion (the redundancy rule of `.agents/skills/write-tests/SKILL.md`). The seams (`seams.md`) check how
the components compose; smoke and e2e check the assembled system, and a smoke failure is explained by the first violating event and
the clause it broke.

The statements were written on 2026-11-21 from the module headers, `seams.md` and sections 1 to 4 of the target architecture, and
checked against the code; the test mapping follows test titles and their assertions. Clause numbers are per component.

| Component | Clauses | Gaps |
|---|---:|---:|
| Journal: window decision and quota | 24 | 3 |
| Relay session control | 19 | 4 |
| Relay host-session | 22 | 6 |
| Controller session core | 20 | 8 |
| Controller publisher | 20 | 4 |
| Codex and Claude adapter item identity | 18 | 4 |
| Client replica and send state | 25 | 7 |
| Client session presentation | 18 | 4 |
| Timeline turns, process mode and work line | 21 | 3 |
| **All** | **187** | **43** |

## Tests added with these statements

| Test | Component and clauses |
|---|---|
| `agent-relay-core/src/domain/session-control/session-control.orderings.test.ts` | Relay session control C4, C6 to C12, C17: every order of four events on one page (14,641 orders), every interleaving of two pages with a terminal's refusal at any point (140 orders); a broken order prints its sequence |
| `agent-client/src/replica/send-state.orderings.test.ts` | Client replica and send state C4 to C10: every order of four events reaching one pending message (6,561 orders) |
| `agent-controller/src/transcript-divergence.test.ts` | Controller session core C10, at its bounds: 1,999, 2,000 and 2,001 ms after the last write; 29,999, 30,000 and 30,001 ms of quiet |
| `agent-controller/src/provider-faults.test.ts` with `test-utils/faulty-provider.ts` | Controller session core C16 and C17 against a provider CLI that misbehaves: Codex's single writer is surfaced as `session_in_use` in fixed words, a slow resume within the deadline opens, a hung resume is refused at the Relay's deadline, an item kind the adapter does not know is dropped and the known rows kept. Two gaps it shows: no error says how long to wait after a usage limit (`AgentRuntimeError` names none), and nothing on the Controller's side gives up a hung resume, which holds the binding until it answers |

## How the smoke failures of 2026-11-21 map to clauses

- **M1** (`first-paint-from-device-store` at 1,500 ms): no component clause broke. The probe closed the first page before the
  device store had written the opened session's record (Client replica C1: the store paints only a kept record of the same
  session); a harness defect, fixed and pinned by `smoke/lib/probe.test.ts` (section 10, O51).
- **M2** (`message-settles-once`, rounds 8 and 10): the product kept Client replica and send state C6 and C10 (a send cut off by a
  Controller stop is `unconfirmed`, and the composer holds later messages behind it until the person checks it). The harness landed
  the fault on the send instead of mid-turn; fixed and pinned by `smoke/lib/restart-round.test.ts` (O52).
- **M6, Claude terminal** (`no-lost-or-doubled-message`, `terminal-rows-appear`): Controller session core C10 at its limit: a
  terminal turn that ends within 2,000 ms of the page's turn is not divergence, and Claude Code forks the transcript (O49).
- **M6, separate Codex process** (`page-stays-live-when-codex-refuses`): Relay host-session (the journal-served stream is refused
  when the attach at open is refused) and Controller session core C16 and C17 (Codex's single writer becomes a native owner with
  the private-writer takeover); the page shows no rows and no Codex reason (O48).

## Journal: the window decision and the quota
Module: `packages/agent-remote-journal/src/window-decision.ts` (pure decision, vectors in `window-vectors.ts`) and `packages/agent-relay-core/src/host-journals.ts` (quota admission); tests: `journal/window-decision.test.ts`, `journal/journal-bytes.test.ts`, `journal/journal-size-invariant.test.ts`, `core/host-journals-bounds.test.ts`, `core/host-journals-window.test.ts`, `core/host-journals-amendments.test.ts`, `core/journal-uplink.test.ts`, `packages/agent-remote-seams/tests/S2/journal-uplink.integration.test.ts`, `packages/agent-remote-seams/tests/S5/Relay-to-Cloudflare-partition.integration.test.ts`, `packages/agent-controller/src/publisher/journal-publisher.test.ts`.

### Purpose
- C1. `decideWindow(tail, window, room?)` says whether the journal already holds the newest window a Controller offers on open (`unchanged`), only needs items added (`extend`), or must start a new epoch (`replace` with a reason).
- C2. The decision is pure: it reads its arguments and returns data; no clock, storage or sockets, and it does not mutate `tail` or `window`.
- C3. The quota keeps one session and one Host inside byte limits, and keeps live-only items bounded; the limits are safety bounds, not the retention policy.

### Inputs and outputs
- C4. Input is the journal's `WindowTail` (items in order, lookup by key, `incomplete`, `residentBytes()`), the window of `JournalItemInput`, and an optional `{ roomBytes }`. `extend` returns the `append` keys, the `update` keys (held live-only items rewritten in place) and `bytes`, the UTF-8 size of the JSON of only the items it writes.
- C5. One vector table, `windowVectors`, is the single source of truth for the rule; `SessionJournal.sync` and `decideWindow` both run every row.
- C6. A publication is checked per entry by `admission` in `host-journals.ts`; the Relay refuses with `journal_refused` reason `quota_exceeded` and the diagnostic `journal_quota_exceeded`.

### States and transitions
- C7. `unchanged`: every native item of the window is held, equal and in place, and every live-only item is held and equal or updatable; nothing is written. Items older than the first shared key are not a change, since older history comes on request.
- C8. `extend`: the window adds native items after the journal's last native item, adds live-only items with new keys, or updates a held live-only item of type `tool_call` or `todo` (`CONTENT_REPLACING_TYPES`). The epoch stays.
- C9. `replace` reasons: `new` (journal holds no native item), `incomplete` (journal missing rows, even for an equal window), `open_item` (the first difference involves an open item), `changed` (a complete item differs, is missing or is out of order; an empty window over native items).
- C10. Live-only items take no part in the positional comparison; a live-only item the journal holds and the window lacks stays; a key whose live-only mark differs between journal and window is `changed`.
- C11. Equality of a complete item is its digest; equality of an open item is its resident content, so an open item whose body was evicted is never equal. A changed live-only item of another type, or with an evicted body, is `changed` (`open_item` when it is open).

### Limits
- C12. Room for an extension: when `room` is given and resident bytes plus the extension bytes exceed `roomBytes`, the result is `replace` (`changed`); without `room` there is no size check (`window-decision.ts`).
- C13. Per-session bytes: `SESSION_MAX_BYTES` = 64 MiB by default (`host-journals.ts`, option `limits.sessionBytes`; the Cloudflare partition uses `JOURNAL_PARTITION_LIMITS.sessionBytes` = 12 MiB in `journal-partition.ts`). A growing entry first evicts bodies (`shrink` keeps 5, then 1, then 0 latest) and is refused with `quota_exceeded` if it still does not fit; an entry larger than the room is refused before anything is evicted.
- C14. Per-Host bytes: `HOST_MAX_BYTES` = 1 GiB (`limits.hostBytes`, same in the partition). A session's room is `min(sessionBytes, hostBytes - bytes of the Host's other sessions)`; only that Host's sessions count, and other Hosts are untouched.
- C15. Live-only item count: `LIVE_ONLY_MAX_ITEMS` = 2000 per session (`limits.liveOnlyItems`). Beyond it `dropOldestLiveOnly` removes the oldest complete live-only items with their bodies and `droppedLiveOnly` is reported; an open one is never removed, so open items can keep the count above 2000. Items prepended count too.
- C16. Live-only byte cap: `liveOnlyBytesMax = sessionBytes - min(JOURNAL_MESSAGE_MAX_BYTES, floor(sessionBytes / 2))` (`JOURNAL_MESSAGE_MAX_BYTES` = `UPLINK_MAX_FRAME_BYTES / 4` = 8 MiB), so a replacement window always fits beside the live-only items it carries. When a window is admitted, open live-only items over the cap are dropped as well.
- C17. Sizes are UTF-8 bytes (`utf8ByteLength`), and the running size equals a full recomputation after every operation and reload. Limits must be whole numbers.

### Errors and refusals
- C18. A window is refused only when the whole window plus what a replacement keeps does not fit the room; otherwise it is admitted whole (bodies evicted first so an extension fits). A refused window or live append marks the journal incomplete, clears its head, takes it out of serving (`unserved`), and bodies stop holding room.
- C19. After a quota refusal the rest of the message is dropped, the next sequence is `sequence_gap`, later appends and heads at the refused number are `incomplete`, and a window from the same generation (or a reopened one) rebuilds the journal. The incomplete mark survives a Relay restart.
- C20. A `prepend` over the quota leaves the journal complete, served and unreplaced (`prependRefused`): there is no more older history to take; live rows continue. A `rebind` is never refused for quota; a gap is refused as `sequence_gap` even when over the limits.
- C21. The Relay sends `journal_refused` with the reason `quota_exceeded` to the Host, reports `journal_quota_exceeded` even when the connection is no longer current, and the Controller backs off: an unchanged refused window is not sent again, a changed one is.

### Guarantees (ordering, no loss, no doubles)
- C22. A refused entry consumes no sequence and the watermark stays at the last applied entry; entries before the refused one are kept and acknowledged.
- C23. A publication of a fenced generation does not count against the limits.
- C24. A window the journal already holds writes no item, epoch or sequence however often it is reopened, even when other sessions fill the Host and bodies were evicted.

| Clause | Test(s) that prove it |
|---|---|
| C1 | `window-decision.test.ts` > "decideWindow" > every row of `windowVectors`; "has a vector for every outcome and every reason" |
| C2 | `window-decision.test.ts` > "reads its arguments and writes nothing to them" |
| C3 | `host-journals-bounds.test.ts` > "evicts bodies to make room for a row, and refuses a row that still does not fit" |
| C4 | `window-decision.test.ts` > "sizes an extension by the items it writes, and nothing else"; vector rows "a rewrite in place and an extension are one append" |
| C5 | `window-decision.test.ts` > "SessionJournal.sync over the window vectors" (same table as "decideWindow") |
| C6 | `journal-uplink.test.ts` > "reports a publication the journal refused for its limits, and refuses it to the Host" |
| C7 | vector rows "the same items in the same order change nothing", "a window that reaches further back than the journal changes nothing, since older history comes on request", "a live-only item the window lacks stays and changes nothing", "an equal open live-only item changes nothing" |
| C8 | vector rows "one item after the last shared item is appended", "a live-only item with a new key is appended", "a changed tool call is rewritten in place", "a changed board is rewritten in place" |
| C9 | vector rows "a window over a journal with no native item is a replacement: new", "a journal that is missing rows is replaced even by an equal window", "a complete item with another digest is a replacement: changed", "a complete item that is open in the window is a replacement: open_item", "an empty window over a journal that has native items is a replacement: changed"; `window-decision.test.ts` > "has a vector for every outcome and every reason" |
| C10 | vector rows "a live-only item the Controller re-adds at the end of its window changes nothing, wherever the journal holds it", "a key that is live-only in the journal and native in the window is a replacement: changed", "a key that is native in the journal and live-only in the window is a replacement: changed" |
| C11 | vector rows "an open item whose body was evicted is a replacement: open_item", "a live-only item whose body was evicted is a replacement: changed", "a live-only item with other content that cannot be rewritten is a replacement: changed", "an open live-only item with other content is a replacement: open_item", "a live-only item that changes kind is a replacement: changed" |
| C12 | vector rows "an extension that fits the room is appended", "an extension that does not fit the room is a replacement: changed" |
| C13 | `host-journals-bounds.test.ts` > "evicts bodies to make room for a row, and refuses a row that still does not fit", "refuses an entry larger than the room before it evicts anything"; `host-journals-window.test.ts` > "admits a window whole when the session has room for it, and appends an extension after evicting bodies for it"; S5 > "refuses growth over the session limit with quota_exceeded, and consumes no sequence". The default 64 MiB and partition 12 MiB values: gap |
| C14 | `host-journals-bounds.test.ts` > "refuses growth of a Host over its quota without touching another Host", "evicts bodies of the session to make room under the Host quota before it refuses", "does not fill past the Host quota, counting what the Host's other sessions hold even before any publication loaded them"; `host-journals-window.test.ts` > "refuses the window of a Host whose other sessions fill its budget, and serves nothing from the session". The default 1 GiB value: gap |
| C15 | `host-journals-bounds.test.ts` > "removes the oldest complete live-only items beyond the cap, with their bodies, and reports how many", "never removes an open live-only item, so the count may stay above the cap, and removes the excess when an item completes"; `host-journals-amendments.test.ts` > "counts prepended live-only items against the live-only cap"; `journal-bytes.test.ts` > "removes the oldest beyond the cap, item and body, and tells the store"; `journal-size-invariant.test.ts` > "with %i kept, drops exactly the oldest complete ones needed and none that is open". The default 2000: gap |
| C16 | `host-journals-window.test.ts` > "caps the live-only items by bytes so that a window always fits beside them", "drops an open live-only item over the byte cap when the window is admitted, so the session settles instead of staying refused"; `journal-bytes.test.ts` > "removes the oldest beyond the byte cap as well, and an open one only when asked". The exact formula value: gap |
| C17 | `host-journals-bounds.test.ts` > "measures appended and prepended rows in UTF-8 bytes", "rejects limits that are not whole numbers"; `journal-size-invariant.test.ts` > "equals a full recomputation after every kind of operation and after a reload", "counts UTF-8 bytes: two for an accented or Cyrillic letter, three for a Chinese character and four for an emoji" |
| C18 | `host-journals-window.test.ts` > "refuses a window that the room cannot hold whole, and leaves the journal incomplete and out of serving instead of keeping part of it", "marks the journal incomplete when a live append is refused for quota, and a window from the same generation recovers it", "refuses a live row too large for the room without emptying the journal, and the next window rebuilds it whole" |
| C19 | `host-journals-bounds.test.ts` > "applies nothing after a quota refusal: the rest of the message is dropped, the next sequence is a gap, the refused sequence is incomplete, and a window from the same generation recovers", "takes the session out of serving, persisted, and serves it again only after a window and a head from a reopened publisher", "refuses the head of an incomplete journal on its own, without fencing the reopened generation, and accepts the window that follows"; `host-journals-window.test.ts` > "keeps an incomplete journal incomplete and unserved across a Relay restart" |
| C20 | `host-journals-window.test.ts` > "refuses a prepend that passes the quota alone: the head stays, nothing is replaced, live rows continue and a rebind is never refused"; `host-journals-amendments.test.ts` > "does not count a rebind as growth: it replaces a binding in place and is never refused for the quota"; `host-journals-bounds.test.ts` > "refuses a gap as a gap even when the entry is over the limits, and neither fences the generation nor marks the journal incomplete" |
| C21 | `journal-uplink.test.ts` > "reports a publication the journal refused for its limits, and refuses it to the Host", "reports a quota refusal even when the connection is no longer current, because the journal already left serving"; `journal-publisher.test.ts` > "a window the Relay refused for its quota" (describe block) and "opens again with backoff and sends the window again after the Relay refuses a live row ..."; S2 > "quota-refuses-window" scenario (transcript `quota-refuses-window.jsonl`, `sessionBytes: 9_000`) |
| C22 | `host-journals-bounds.test.ts` > "evicts bodies to make room for a row, and refuses a row that still does not fit" (refused events empty); `host-journals.test.ts` > "stops at the first refused entry and keeps and acknowledges the ones before it"; S5 > "refuses growth over the session limit with quota_exceeded, and consumes no sequence" (`watermark: 1`) |
| C23 | `host-journals-bounds.test.ts` > "does not count a publication of a fenced generation against the limits" |
| C24 | `host-journals-window.test.ts` > "writes no item, epoch or sequence for the same window after any number of reopens, and tells subscribers only the head", "leaves a window the journal already holds unchanged and served when other sessions fill the Host and bodies were evicted" |

Gaps:
- C13, C14, C15, C16 default values (64 MiB, 1 GiB, 2000, the live-only byte formula) and the 12 MiB partition value: every test sets its own limit. A unit test with `createHostJournals({ store })` and no `limits`, publishing just under and just over each default using a stubbed small `JOURNAL_MESSAGE_MAX_BYTES`-free probe, or an exported constants test, would close it; at minimum assert `JOURNAL_PARTITION_LIMITS` equals the documented values.
- C12 "without `room` there is no size check": the vectors with no `room` imply it but no row states it; add a vector row with a huge extension and no `room`.
- C21 frame-level wire: `journal_refused` reasons for `quota_exceeded` at host scope (not only session scope) have no transcript; add an S2 scenario with `hostBytes` small (the S2 doc already lists other reasons as "Not yet").

Tests that map to no clause (deletion candidates): none found; `journal-size-invariant.test.ts` random-seed runs overlap C17 and could be reduced.

## Relay session control
Module: `packages/agent-relay-core/src/domain/session-control/session-control.ts` (pure table) and `packages/agent-relay-core/src/stream-control.ts` (shell); tests: `core/domain/session-control/session-control.test.ts`, `core/stream-control.test.ts`, `core/journal-session-stream.test.ts`, `core/broker-journal-sessions.test.ts`.

### Purpose
- C1. One browser stream holds a control lease that says what the stream may do to its session; the lease is a pure transition table `transition(state, event) -> { state, reply }`.
- C2. The shell (`createStreamControl`) decodes browser frames, mints ids, asks the Controller who holds the session natively, and sends what the table replies; the table owns no socket, clock or id source (the caller passes `fresh`).

### Inputs and outputs
- C3. Events: `announce`, `snapshot`, `acquire { requestId, revision, fresh }`, `mutation { requestId?, token? }`, `refused { code, owner?, fresh }`, `holder { revision, owner? }`. Replies: `none`, `state`, `refuse` (`session_control_changed` or `session_read_only`), `pass`, `ask_holder`.
- C4. `viewOf` is what the browser is told: `access` is `control` and the token is shown only while a token exists and no owner is recorded; `available` is true exactly when no owner is recorded.
- C5. The shell sends `session_control` (the view plus `agentId` and the `requestId` it answers) and refusals as recoverable `protocol_error` with the request id (an interaction answer's `submissionId` counts as one).

### States and transitions
- C6. A new stream is read-only with no token; its first state is announced once, after the Controller's Snapshot (`snapshot` announces only the first time; `announce` always sends).
- C7. `acquire` with the current revision issues the token once and later acquires keep it; it clears the native owner.
- C8. `acquire` with another revision is refused with `session_control_changed` and changes nothing, including a held token.
- C9. A mutation passes only with the stream's live token; otherwise `session_read_only` (no token held, wrong token, no token, or a token revoked by ownership).
- C10. A refusal with code `native_session_owned` revokes the token and starts a new revision; with a named owner it records it and sends the state; without one it asks the Controller (`ask_holder`).
- C11. A `holder` answer counts only for the revision it was asked under; an older revision's answer is dropped and does not undo a later acquire.
- C12. Any other refusal code changes nothing.

### Limits
- C13. No numeric limits: the lease has no clock or count. The revision and token are fresh `randomUUID()` values per event (`stream-control.ts`).

### Errors and refusals
- C14. A control request or mutation frame that does not decode is refused with `invalid_shape` (carrying the request id when readable) and never forwarded; other frames and non-JSON go on untouched.
- C15. If the Controller cannot say who holds the session, the session is shown available and read-only.
- C16. `controllerFrame` forwards every Controller frame first, then reads only `agent_snapshot` (announce) and a `protocol_error` with a string `code` (refusal).

### Guarantees (ordering, no loss, no doubles)
- C17. The first state is sent at most once by Snapshot; a refused acquire never removes a granted token.
- C18. The table reads its arguments and writes nothing to them; the owner object is not shared with the event or the state.
- C19. The two session paths (the journal session stream and the Host-session proxy in `host-session.ts` / `socket-edge.ts`) answer control and refuse a mutation without a live grant themselves, and a mutation with the token goes on to the Controller.

| Clause | Test(s) that prove it |
|---|---|
| C1 | `session-control.test.ts` > "the lease transition table" (every row) |
| C2 | `stream-control.test.ts` > "answers an acquire with the request id and the token, and lets a mutation with that token go on", "asks the Controller who holds the session when a refusal names no owner, and shows the answer" |
| C3 | `session-control.test.ts` rows: "announce sends the first state and marks it announced", "acquire with another revision is refused as changed and changes nothing", "a mutation with the live token passes", "an ownership refusal that names no owner revokes the token and asks who holds the session", "the holder of the asked revision is recorded" |
| C4 | `session-control.test.ts` > "the view a browser is told" > "is read-only and available for a new stream", "is control with the token once acquired", "is read-only, unavailable and names the owner while a terminal holds the session, whatever token is left" |
| C5 | `stream-control.test.ts` > "refuses a mutation without the token and keeps the stream open" (recoverable, request id), "refuses an acquire for a revision that is not current". The `submissionId` rule: gap |
| C6 | `session-control.test.ts` rows "announce sends the first state...", "the first Snapshot announces", "a later Snapshot says nothing"; `stream-control.test.ts` > "announces a read-only state once, after the first Snapshot" |
| C7 | `session-control.test.ts` rows "acquire with the current revision issues the token and answers the request", "acquire again keeps the first token", "acquire clears the native owner and issues a token" |
| C8 | `session-control.test.ts` rows "acquire with another revision is refused as changed and changes nothing", "a refused acquire does not take away a held token", "acquire on the revision before the owner appeared is refused" |
| C9 | `session-control.test.ts` rows "a mutation before any acquire is refused as read-only", "a mutation with another token is refused", "a mutation without a token is refused while a token is held", "a mutation with a token that was never issued is refused while no token is held", "the revoked token no longer passes", "a refused mutation without a request id carries none" |
| C10 | `session-control.test.ts` rows "an ownership refusal that names the owner revokes the token and records it", "...on a read-only stream records the owner too", "...names no owner revokes the token and asks who holds the session", "a second ownership refusal starts another revision"; `stream-control.test.ts` > "shows the owner a refusal names, takes the token away and tells the browser" |
| C11 | `session-control.test.ts` rows "a holder for an older revision is dropped", "a holder for an older revision does not undo an acquire that came first"; `stream-control.test.ts` > "drops the answer to a question asked under a revision that has moved on" |
| C12 | `session-control.test.ts` row "a refusal that is not about ownership changes nothing" |
| C13 | gap (no behavior to test beyond fresh ids; see Gaps) |
| C14 | `stream-control.test.ts` > "refuses a control frame that does not decode and never forwards it", "leaves frames that are neither control nor a mutation to go on" |
| C15 | `stream-control.test.ts` > "shows the session available when the Controller cannot say who holds it"; `session-control.test.ts` row "no holder for the asked revision leaves the session available and says so" |
| C16 | `stream-control.test.ts` > "announces a read-only state once, after the first Snapshot" (forwarded twice), "asks the Controller who holds the session when a refusal names no owner, and shows the answer" |
| C17 | `session-control.test.ts` rows "a later Snapshot says nothing", "a refused acquire does not take away a held token" |
| C18 | `session-control.test.ts` > "reads its arguments and writes nothing to them", "does not share the owner object with the event or the state" |
| C19 | `journal-session-stream.test.ts` > "answers control and refuses a mutation without a live grant itself, never opening the Controller stream", "shows the native owner and revokes control when opening the session is refused for it", "learns the owner after a refusal at delivery, which names none, by asking the Controller once"; `broker-journal-sessions.test.ts` > "shows the native owner and revokes control when the first operation is refused for it, and keeps serving reads". The Host-session proxy path (`host-session.ts` line using `stream.control.controllerFrame`): gap |

Gaps:
- C5: an interaction answer is refused with its `submissionId` as request id; add a `stream-control.test.ts` case with an `interaction_response` frame and no token.
- C13: not a behavior; either drop the clause or add a unit case that two streams (and two acquires) never share a revision or token.
- C19 proxy path: `host-session.ts` forwards Controller `stream_message` through `stream.control.controllerFrame`; add a `host-session.test.ts` case where a stream with `control` receives an `agent_snapshot` and a `native_session_owned` error and the browser socket sees the forwarded frames plus the control state.
- The wire shape of `session_control` payload against the public schema (S3): the seams test only emits it; add a fixture row consumed by both ends.

Tests that map to no clause: none found.

## Relay host-session
Module: `packages/agent-relay-core/src/host-session.ts`; tests: `core/host-session.test.ts`, `core/broker-heartbeat.test.ts`, `core/broker.test.ts`, `core/broker-state.test.ts`, `packages/agent-remote-seams/tests/S2/uplink-wire.integration.test.ts`, `packages/agent-remote-seams/tests/S2/controller-on-relay.integration.test.ts`.

The header says the module owns one Host's connection: the registration handshake, the credential rotation that follows it, the heartbeat, the requests the Relay sends the Host and their answers, and how the connection ends. It writes the connection's live fields on the Host record and the timers of each connection; it saves records only through `BrokerState.commit`.

### Purpose
- C1. One Host has one live connection; the module owns its registration, credential rotation, heartbeat, `rpc` and end of connection.
- C2. It touches the world only through ports (scheduler, clock, `RelayIds`, `BrokerState`, journal service and deletion, previews, Team broker host calls, outbox, diagnostics) and saves records only through `BrokerState.commit`.

### Inputs and outputs
- C3. `register(socket, credential, context, credentialHash, grants)` takes the server end of an upgraded socket; `registered` acknowledges only the grants the Relay can serve (heartbeat interval and timeout, `control: 1`, `journal`, `outbox`, session states, and so on).
- C4. `rpc(host, method, path, sessionId?, body?)` sends `rpc_request` and resolves with the matching `rpc_response` by request id; `send`, `disconnected`, `closeAll` and `stopTimers` are the other entry points.
- C5. Messages after registration are routed by type: `rpc_response`, `stream_opened`, `stream_message`, `stream_close`, `provider_snapshot`, `preview_snapshot`, `session_states`, journal messages, `outbox_request`, `team_request`, `credential_saved`, `heartbeat_ack`.

### States and transitions
- C6. Until the Host's `register` message is committed (credential claimed and record saved), nothing else is accepted; a first message that is not a registration, an undecodable message, or a revoked or expired credential closes with 1008.
- C7. A newer registration closes the older connection (1012 `connection_replaced`) and bumps the Host's `generation`; requests that began on the older generation fail instead of being answered (`host_reconnected`).
- C8. The heartbeat starts only after registration is complete, sends a nonce every `intervalMs`, and the Host must acknowledge the current nonce within `timeoutMs`, else the connection closes (1012 `heartbeat_timeout`); acknowledgements of an old nonce do not count; a replacement connection keeps its own schedule.
- C9. Credential rotation: an invitation registering with a rotation gets a `credential_issued`, and the Host is registered once it answers `credential_saved`; a device that rotates registers at once and gets a credential only when it asks; one device credential is kept per installation.
- C10. `disconnected` ends one connection exactly once: rejects pending requests (`host_offline`), closes the Host's streams (1012, or 1008 `Host access revoked` when access ended), closes the journal connection and previews, and clears connection-only fields (session states, tunnel token, grants).
- C11. A Host that returns with the id of a revoked Host waits for that id's journal deletion, at most `journalDeletionWaitMs` (default 5000), then registers without journals.

### Limits
- C12. Registration deadline `registrationDeadlineMs`, default 10 000 ms: no registration in time closes 1008 `Registration deadline exceeded`.
- C13. A Host holds at most 128 pending requests; the 129th is refused 429 `host_busy`.
- C14. Request deadlines: `rpcTimeoutMs` (default 30 000 ms; 45 000 for `/remote/provider-settings`), `creationTimeoutMs` 180 000 ms for `/remote/create`, 5 000 ms for diagnostic requests; at the deadline the Relay sends `rpc_cancel` and rejects 504 (`session_attach_timeout` for attach, `host_read_timeout` for GET, `host_timeout` otherwise).
- C15. Backpressure: a Host socket with `bufferedAmount` over `BROKER_MAX_FRAME_BYTES` (16 MiB) refuses sends with 503 `host_backpressure`; a slow browser stream over the same bound is closed 1013; diagnostics are not delivered while backed up or more than 16 requests are pending.
- C16. At most 128 Hosts (429 `host_capacity`) and 128 device credentials (429 `capacity_exceeded`, 1013 close for a 429).

### Errors and refusals
- C17. A request while the Host is offline fails 503 `host_offline`; unexpected, un-acknowledged messages close 1008 (`Provider management was not advertised`, `Session states were not acknowledged`, `Journals were not acknowledged`, `The outbox was not acknowledged`, `Unexpected uplink message`).
- C18. A failed save makes the state unavailable and retires the connection and its timers; a socket send failure retires the registration (1011); 401 maps to 1008, 429 to 1013, other errors to 1011.
- C19. A browser stream is not opened (and its buffered frames are not sent) until the page may use it; a `stream_message` whose session identity is invalid closes the stream 1008.

### Guarantees (ordering, no loss, no doubles)
- C20. Request answers are matched by request id; an answer on a replaced generation is never resolved, and outbox or Team answers are delivered only on the connection and generation that asked.
- C21. Every timer of a connection (registration, heartbeat, deadlines, expiry) is cleared on close, error, shutdown and revocation.
- C22. A connection whose credential expires or is revoked is retired before waiting for its pending heartbeat deadline.

| Clause | Test(s) that prove it |
|---|---|
| C1 | `host-session.test.ts` > "acknowledges the registration with the heartbeat deadlines and session control, and records the Host online", "closes the older connection of a Host that registers again, and fails what began on it" |
| C2 | `host-session.test.ts` (whole file runs on `hostSessionFixture` with a fake clock and scheduler) ; no test states that records are saved only via `BrokerState.commit`: gap |
| C3 | `host-session.test.ts` > "acknowledges the registration with the heartbeat deadlines and session control, and records the Host online", "acknowledges the outbox only when the Controller asked for it and the Relay serves one"; `broker-journal-grant.test.ts` > "is not acknowledged for a Controller that does not ask or asks for another version" |
| C4 | `host-session.test.ts` > "sends a request, matches its response by id, and refuses the 129th pending request" |
| C5 | partly: `host-session.test.ts` > "ignores a provider snapshot from a Host that did not advertise provider management, and takes one from a Host that did", "does not open a browser stream the page may no longer use, and sends what it buffered once it may"; `broker-journals.test.ts`, `journal-uplink.test.ts` for journal messages; S2 `uplink-wire.integration.test.ts` > each recorded wire scenario (register, heartbeat, rpc-attach, rpc-native-owner, outbox). `preview_snapshot`, `session_states`, `stream_close`, `team_request` routing: gap |
| C6 | `host-session.test.ts` > "refuses a registration whose credential is gone, and a first message that is not a registration", "closes with 1008 and the reason when a registration is no longer authorized, and not with a server failure"; `broker.test.ts` > "binds a temporary credential to only one installation during concurrent registration" |
| C7 | `host-session.test.ts` > "closes the older connection of a Host that registers again, and fails what began on it"; `broker-state.test.ts` (assertHostCurrent throws `host_reconnected`, line 111); `broker-journal-sessions.test.ts` (stream outcome `host_reconnected`, line 430) |
| C8 | `host-session.test.ts` > "sends the first heartbeat only after registration, and keeps its cadence whatever the acknowledgement latency", "requires the acknowledgement of the current nonce, not of an earlier one", "marks a silent Host offline and rejects its pending requests before the socket reports a close", "keeps the heartbeat of a replacement connection apart from the callbacks and close of the old one"; `broker-heartbeat.test.ts` > "starts after enrollment is saved and preserves the schedule across device credential rotation" |
| C9 | `host-session.test.ts` > "issues a device credential after an invitation registers with a rotation, and registers the Host once the Controller saved it", "registers a device that rotates at once and issues no credential before it asks", "keeps one device credential per installation when a device registers, and no other installation loses its key" |
| C10 | `host-session.test.ts` > "closes the browser streams of a Host that disconnects, and clears them and their opening deadlines", "closes streams with the revoked wording when the Host's access ended", "marks a silent Host offline and rejects its pending requests before the socket reports a close"; `broker-heartbeat.test.ts` > "closes virtual browser streams and clears their opening deadline when the Host heartbeat expires". Journal connection and preview close, and the clearing of tunnel token and grants: gap |
| C11 | gap |
| C12 | `host-session.test.ts` > "closes a connection that sends no registration within the deadline, and leaves one that registered in time" (50 ms in the test; the 10 000 ms default: gap) |
| C13 | `host-session.test.ts` > "sends a request, matches its response by id, and refuses the 129th pending request" |
| C14 | `host-session.test.ts` > "times out an attach with its own wording after telling the Controller to cancel" (attach only). GET and generic wording, 45 000 ms and 180 000 ms and 5 000 ms deadlines: gap |
| C15 | `host-session.test.ts` > "refuses a request while the Host is offline or its output is backed up", "refuses diagnostic delivery while the connection is backed up, without asking the Controller"; `broker-heartbeat.test.ts` > "defers diagnostic capability probing while the Host has buffered business traffic", "defers diagnostics when business requests accumulate %s the capability probe". The 1013 close of a slow browser stream in `stream_message`: gap |
| C16 | `host-session.test.ts` > "refuses a new device credential at 128 and issues one at 127". Host capacity 128 and the 1013 mapping: gap |
| C17 | `host-session.test.ts` > "refuses a request while the Host is offline or its output is backed up", "ignores a provider snapshot from a Host that did not advertise provider management, and takes one from a Host that did" (1008 reason). The other un-acknowledged closes (`session_states`, journal, `Unexpected uplink message`): gap |
| C18 | `host-session.test.ts` > "retires the connection and its timers when a save fails and the state becomes unavailable", "retires the registration when the socket reports a synchronous send %s"; `broker-heartbeat.test.ts` > "clears outstanding heartbeats when durable storage fails before a close event". The 401/429/other code mapping: gap |
| C19 | `host-session.test.ts` > "does not open a browser stream the page may no longer use, and sends what it buffered once it may". The 1008 on invalid session identity: gap (only `journal-host-stream.test.ts` closes with that reason on its own path) |
| C20 | `host-session.test.ts` > "delivers an outbox answer only on the connection and generation that asked", "sends a request, matches its response by id, and refuses the 129th pending request" (unrelated id ignored in "marks a silent Host offline..."); a response on a replaced generation rejected: "closes the older connection of a Host that registers again, and fails what began on it" |
| C21 | `host-session.test.ts` > "clears the heartbeat timers on %s" (close, error, close all), "closes the browser streams of a Host that disconnects, and clears them and their opening deadlines"; `broker-heartbeat.test.ts` > "clears heartbeat timers on %s", "clears outstanding heartbeats when the device is revoked" |
| C22 | `host-session.test.ts` > "retires a device whose credential expires before waiting for its pending heartbeat deadline" |

Gaps:
- C11 (revoked-Host id waits for journal deletion up to 5000 ms, then registers without journals): add a `host-session.test.ts` case with `brokerState.journalDeletions` holding the id, a deletion port that never resolves, and the fake clock advanced 5000 ms.
- C17 / C5 un-acknowledged closes: add one `it.each` in `host-session.test.ts` over `session_states`, a journal message, `outbox_request` and an unknown message from a Host that did not ask, expecting close 1008 with the reasons listed.
- C14 deadlines other than attach: add cases for GET (`host_read_timeout`, 30 000 ms), POST (`host_timeout`), `/remote/provider-settings` (45 000 ms) and `/remote/create` (180 000 ms), each with `rpc_cancel` sent.
- C15/C19 `stream_message` path: add cases in `host-session.test.ts` for a slow browser socket (close 1013) and an invalid identity (close 1008), and one where the stream has a `control` and the frame goes through `controllerFrame`.
- C10 journal and previews closed on disconnect, and C16 Host capacity 128: unit cases with a stub journal connection and 128 Hosts.
- C2 commit-only saves: cover by a case where a save fails and no live field of the credential or Host changes before `publish`.

Tests that map to no clause: none found; `broker-heartbeat.test.ts` > "retains exact server heartbeat cause and startup/connection identity for later Host delivery" covers diagnostics content, not a clause of this module's contract.

## Controller session core
Module: `agent-controller/src/session-core/` (`attachment.ts`, `idle-release.ts`, `admission.ts`, `bound-sessions.ts`, `requests.ts`, `control-routes.ts`), `agent-controller/src/idle-sessions.ts`, `agent-controller/src/transcript-divergence.ts` (used by `stdio-directory.ts`); tests: `agent-controller/src/session-core/{admission,idle-release,bound-sessions,requests,control-routes}.test.ts`, `agent-controller/src/idle-sessions.test.ts`, `agent-controller/src/transcript-divergence.test.ts`, `agent-controller/src/host.test.ts`, `agent-controller/src/journal-terminal-refresh.journal.test.ts`, `agent-controller/src/host-journal.test.ts`.

### Purpose
- C1. The core binds each native session once to a public agent id, gives it a runtime on demand (attach), keeps it while anyone holds it, and releases it after an idle grace, journal first, then runtime, then directory.
- C2. Control requests (`/remote/...`) from the Relay and the local command line enter through `control`, which parses, admits, routes and answers them; the core owns no session state beyond bindings, idle entries and the start backoff.

### Inputs and outputs
- C3. `parseCreateRequest` takes a provider, an operation id and a proposed identity (request `sessionId`); a creation source is the explicit one or the legacy source read as one of the same provider. `parseAttachRequest` takes proposed identity, provider and native session; a child attach also needs its parent; a takeover needs a UUID owner generation.
- C4. `project` binds and attaches a session once: it reuses a live runtime whose creation evidence matches, otherwise opens the native session, annotates it and registers it with the Relay's runtime; the answer is the binding without its provider (`publicBinding`).
- C5. `acquireSession` returns a lease that releases the runtime and its parent exactly once; it holds the parent of a child first, waits for a release in progress, and re-reads a diverged quiet session before a send continues from it.

### States and transitions
- C6. Admission has three states: `open`, `draining` (refuses `POST`/mutations with `controller_updating`, reads still answer) and `closed` (refuses everything with `host_closed`, never reopens). `beginDrain` works only from `open`; `cancelDrain` returns draining to open; `close` always ends closed (`admission.ts`).
- C7. A binding is made once per native session; while it is made the native session is pending and the agent id reserved; afterwards the agent id stays reserved; a bind after `close` is refused (`bound-sessions.ts`).
- C8. An idle session is released only when the Controller is open, the session is certain (no unsettled operation, no unfinished family check), its binding is complete, its directory allows it, its runtime says it can be released idle, and no child bound under it has a runtime or a holder (`mayReleaseIdle`, `hasHeldChild` for one provider only).
- C9. An uncertain session is reconciled first (directory can reconcile, runtime releasable, no held child); a successful check clears the uncertainty but never settles or replays the unknown operation (`mayReconcileIdle`, `attachment.ts` `watch`).
- C10. Transcript divergence: a native update counts as another writer's only when it is more than 2000 ms after this process's last write (`DIVERGENCE_TOLERANCE_MS`); a diverged session may be released only when nothing runs for it and its transcript was quiet for 30 s (`DIVERGENCE_QUIET_MS`) (`transcript-divergence.ts`, wired in `stdio-directory.ts` as `divergedAt`, `canReleaseSession`, `checkDivergence`).
- C11. Idle grace: a session with no lease and a safe state is released after `graceMs` (default 5 minutes, `idle-sessions.ts`); every lease, touch, reconnect or unsafe observation restarts the full grace; the grace is suspended while the uplink is disconnected; a returning lease waits for a started release and never causes a second release; a failed release retries after a new grace.

### Limits
- C12. `graceMs` and `reconcileMs` (default 60 s) must be positive safe integers, else `RangeError` (`idle-sessions.ts`). Reconcile backoff doubles per failure, capped at 10 failures and 15 minutes; one reconcile runs at a time.
- C13. A creation source identity and each edit identity are at most 256 characters (`requests.ts` `parseCreateRequest`); a canonical identity chosen after a qualified source create must pass `boundedSourceIdentity` (non-blank, at most 512 characters) or the attach fails (`attachment.ts`). A rename title is at most 512 characters, no control characters.
- C14. Native start backoff: a recent native start failure is repeated instead of starting again until it expires; an explicit takeover always tries (`control-routes.ts` with `native-start-backoff.ts`).

### Errors and refusals
- C15. Every malformed request is a `HostRequestError` 400 `invalid_request`; nothing is read from a request before it is validated; unknown routes and non-JSON bodies are refused.
- C16. `failureResponse`: typed errors keep their status and code; a failed GET is `catalog_unavailable`, a failed attach `session_attach_failed`, anything else `mutation_outcome_unknown`; generic answers carry only the class and code of the cause, never its text. `operationErrorStatus`: conflict 409, capacity 429, unknown outcome / closed cache / native file limit / bad clock 503, others 400.
- C17. A provider returning another native identity is closed and refused; a Controller that closed meanwhile disposes what it opened and answers 503 `host_closed`; a disabled provider is refused with `provider_disabled` unless the session is already live under the same identity (uplink recovery).
- C18. Diagnostics (request diagnostics, `session_idle_*` lifecycle events) can never fail a request or change a session's lifetime; a request diagnostic carries a digest of the native session id, never the id.

### Guarantees
- C19. `all` lists bindings in the order made and is a snapshot; `family` is the session, its children and grandchildren of one provider, in bind order; `live` omits bindings with no runtime; `bindingOf` throws `invalid_operation_target` for an unbound runtime.
- C20. A release goes in the order journal, runtime, directory, and a restored session keeps the same binding; a repeated attach keeps one projection; a stop cancels every live session and reports cancelled, unsupported and failed apart, bounded by the cancel deadline.

| Clause | Test(s) that prove it |
|---|---|
| C1 | `agent-controller/src/host.test.ts` > "releases an idle shared projection after grace and restores the same binding over real uplink streams" |
| C2 | `session-core/control-routes.test.ts` > "binds the proposed identity and answers the binding without its provider"; "refuses a request no route knows, and a malformed body" |
| C3 | `session-core/requests.test.ts` > "keeps the provider, operation, proposed identity and the settings it names"; "reads a Side's source as a creation source of the same provider"; "takes an explicit creation source, and refuses one that contradicts the native source identity"; "names the session to bind"; "needs the parent of a child attach, and ignores a parent on a plain one"; "takes over only with a native owner generation, and never on a child attach" |
| C4 | `host.test.ts` > "keeps one projection for repeated attach and rejects child ownership changes"; `session-core/control-routes.test.ts` > "binds the proposed identity and answers the binding without its provider" (answer shape; `project` itself is stubbed there) |
| C5 | `journal-terminal-refresh.journal.test.ts` > "releases a held session whose transcript something else wrote to before a send continues from it, and reads it again" (re-read before a send); `host.test.ts` > "detaches idle child projections before their parent and restores the family on demand" (parent held for a child). Lease releases once: gap |
| C6 | `session-core/admission.test.ts` > all six titles ("takes everything while open", "refuses new mutations while draining, and still answers reads", "begins a drain only from open", "returns a draining Controller to open when the restart is cancelled", "refuses every method once closed, and never reopens", "closes from a drain, and keeps reporting the drain as stopped"); `session-core/control-routes.test.ts` > "refuses everything while closed and names the request in the error", "refuses mutations while draining, and keeps answering reads"; `host.test.ts` > "closes admission immediately while an admitted create operation settles" |
| C7 | `session-core/bound-sessions.test.ts` > "reserves the agent id of a bind in progress and marks its native session pending, then keeps only the reservation"; "refuses a bind after close"; "finds a binding by its agent id and by its native identity" |
| C8 | `session-core/idle-release.test.ts` > "releases a session nothing holds when its provider and runtime allow it"; the `it.each` "keeps a session when %s" (closed, uncertain, pending, directory, runtime, child held); "is a child of the same provider that the caller says is held"; "is not a child of another provider, nor of another parent, nor one nobody holds"; `host.test.ts` > "detaches idle child projections before their parent and restores the family on demand" |
| C9 | `session-core/idle-release.test.ts` > "needs a directory that reconciles, a runtime that can be released idle and no held child"; `host.test.ts` > "reconciles uncertain idle operations without confirming or replaying their result"; "keeps partial child reconciliation pinned until the complete native check succeeds" |
| C10 | `transcript-divergence.test.ts` > "is diverged %i ms after the last write: %s" (1999/2000/2001), "is not diverged without a native update time", "misses a terminal turn that ended within the tolerance of the page's own turn: the fork of O49", "%i ms after the transcript went quiet: %s" (29999/30000/30001), "never while something runs for it, nor when it did not diverge". Wiring in `stdio-directory.ts`: gap (the integration tests stub `divergedAt`/`checkDivergence`; `journal-terminal-refresh.claude.local.test.ts` uses the real Claude, local tier) |
| C11 | `idle-sessions.test.ts` > "requires a full grace after the last lease, including reconnect churn"; "suspends while disconnected and gives a new grace after registration or unsafe activity"; "lets returning demand wait for an already-started release without releasing twice"; `host.test.ts` > "preserves sessions through extended uplink outages and resets the whole grace on registration"; "retries a failed dormant restoration without changing the binding or poisoning later opens". The 5-minute default itself: gap |
| C12 | `idle-sessions.test.ts` > "backs off failed checks and pauses them while disconnected or observed" (backoff times 12 s, 16 s, 24 s with `reconcileMs` 2 s); "serializes low-frequency checks and starts a full grace only after a check finishes". RangeError on bad values and the 15-minute and 10-failure caps: gap |
| C13 | `session-core/requests.test.ts` > "bounds the source identity to 256 characters"; "refuses a title that is empty, too long or holds control characters, a session address and unknown fields"; the 512 `boundedSourceIdentity` check in `attachment.ts`: gap |
| C14 | `session-core/control-routes.test.ts` > "repeats a native start failure instead of starting the session again, until a takeover asks"; `native-start-backoff.test.ts` (backoff policy) |
| C15 | `session-core/requests.test.ts` > "needs a non-empty string field, and a JSON object body"; "needs a provider, an operation and a proposed identity"; "needs the proposed identity, a provider and a native session"; "takes a prompt edit only as a complete native prompt identity that is not also a source"; "stops with an operation identity only"; `session-core/control-routes.test.ts` > "refuses a request no route knows, and a malformed body" |
| C16 | `session-core/requests.test.ts` > "maps the operation cache codes to statuses"; the `it.each` under "answering a failure"; "shows the owner of a refused native session"; "answers any other failure generically, and records its class and code, never its text"; "records the class of an error that is not an Error, and ignores a code that is not a plain identifier"; `session-core/control-routes.test.ts` > "records the class of a generic failure, never its text" |
| C17 | `session-core/control-routes.test.ts` > "refuses a provider that is disabled, unless the session is already live under that identity". Provider returns another native identity; Controller closes during attach (503 `host_closed` and dispose): gap |
| C18 | `session-core/control-routes.test.ts` > "is not failed by a diagnostic sink that throws"; "records a started and a completed diagnostic, with the status and a digest of the native session, never the session itself"; `host-journal.test.ts` > lifecycle `session_idle_released` is observed; a throwing lifecycle sink: gap |
| C19 | `session-core/bound-sessions.test.ts` > "lists bindings in the order they were made, as a snapshot"; "returns a session's family: itself, its children and grandchildren in the order they were bound, of one provider only"; "returns the family of a session that is not bound as the children bound under it"; "pairs a binding with its runtime and leaves out bindings with none"; "finds the binding a runtime belongs to"; "throws the invalid_operation_target error for a runtime that has no binding" |
| C20 | `host.test.ts` > "releases an idle shared projection after grace and restores the same binding over real uplink streams"; `host-journal.test.ts` (journal published before the idle release; see "idle release" test at line 83); `session-core/control-routes.test.ts` > "cancels every live session and reports cancelled, unsupported and failed apart"; `host.test.ts` > "keeps one projection for repeated attach and rejects child ownership changes". Order journal then runtime then directory asserted by a unit test: gap |

Gaps:
- C5 lease releases once, parent released with it: unit test of `acquireSession` with stub context (counts `release` calls, calls the lease's `release` twice).
- C10 wiring: unit test of `createManagedStdioDirectory` with a stub `sessionState` and `sessionNativeUpdatedAt` that checks `divergedAt`, `canReleaseSession` and `checkDivergence` at 2000/30000 ms boundaries.
- C11 default grace 5 minutes: `createIdleSessions()` with fake timers, no release at 299 s, release at 300 s.
- C12 `RangeError` for `graceMs: 0` and `reconcileMs: 0`; backoff cap of 15 minutes and 10 failures: unit test with fake timers.
- C13 `boundedSourceIdentity` 512 bound (and the 256 vs 512 split between `parseCreateRequest` and `attachment.ts`, which the header documents only as 256): unit test in `requests.test.ts`.
- C17 provider returns another native identity (closed and refused); Controller closed during attach disposes the session: unit test of `project` with stub relay and directory.
- C18 lifecycle sink that throws does not change release: unit test of `attachment.watch` with a throwing `onSessionLifecycleDiagnostic`.
- C20 release order journal, runtime, directory: unit test of the release callback registered by `watch` with ordered stubs.

Candidates for deletion: none found; `host.test.ts` ("reports a native writer conflict over the uplink...", line 293) is outside these clauses but covers native owner refusal, not a session-core clause.

## Controller publisher
Module: `agent-controller/src/publisher/` (`journal-publisher.ts`, `journal-publication.ts`, `journal-items.ts`, `journal-reconcile.ts`, `terminal-refresh.ts`); tests: `agent-controller/src/publisher/{journal-publisher,journal-publisher.relay,journal-items,journal-reconcile,terminal-refresh}.test.ts`, `agent-controller/src/journal-terminal-refresh.journal.test.ts`, `agent-controller/src/journal-continuity.recordings.test.ts`, `agent-controller/src/host-journal.test.ts`, `agent-remote-seams/tests/S2/controller-on-relay.integration.test.ts`.

### Purpose
- C1. For each followed session the publisher sends the Controller's timeline to the Relay's journal: on every open, the newest window, the outcomes and rebinds of the whole timeline, and the head; then it publishes what the session emits, one acknowledged message at a time.
- C2. `terminal-refresh.ts` keeps a session current when a terminal CLI wrote to it while the Controller held no runtime: a listing newer than the session's journal coverage makes the Controller attach it, read native history and release it again.

### Inputs and outputs
- C3. Input is the manager's journal tap (rows, completions, rebinds, outcomes, head); output is journal messages over the uplink writer held while the Relay's grant holds; a provider without journal support is not published (`attach` returns false).
- C4. `releaseJournal` publishes what is queued, stops following, and returns whether the journal was serving, so the Relay holds what it held; terminal-refresh then records the session's coverage as the release start time, or the diverged last-write time, never less than a listing already told.

### States and transitions
- C5. A publication is `suspended`, `opening`, `live`, `gave_up` or `stopped`; any refusal, refused open, timeout, lost connection, held-event overflow or unencodable message reopens with backoff and sends the window again; a provider that replaces its timeline reopens at once.
- C6. A head that the wire refuses, or a provider that breaks the identity contract (no `itemIdentity`, or a key starting `controller:`), gives up and sends `journal_unserve`; it publishes nothing until a connection returns.
- C7. After a `quota_exceeded` refusal of a window, an unchanged window is not sent again on that connection (the reopens back off without opening); a changed window, an open item that grew, or a new connection is sent again.
- C8. Terminal refresh: a listing summary is due when the session is remembered, has no runtime and no demand, its update time is newer than its coverage, and that time is at least `JOURNAL_REFRESH_QUIET_MS` (30 s) old; due sessions are attached newest first and released at once. The coverage moves to the summary time before the attach, so a failed attach waits for the next change; an attach refused because a terminal owns the session, or because it is in use, restores the old coverage.
- C9. A resident session whose transcript something else wrote to is expired (even with no journal grant) so the next attach reads it again; only sessions without demand, whose provider can release them, are expired.

### Limits
- C10. Timing and size limits (`DEFAULT_PUBLISHER_LIMITS`, `journal-publication.ts`): batch window 50 ms; Relay response timeout 30 s (then reopen); backoff 250 ms doubling to 30 s; backoff restarts after 60 s of sustained publishing; held events while opening at most 10 000, past it the session reopens; at most 8 older pages read to find items for the first window; bytes in flight across all sessions 16 MiB (one message is always admitted when none is in flight).
- C11. Message size: one publication message at most 4 MiB (`MESSAGE_BUDGET_BYTES`, `journal-items.ts`); a window takes the newest items that fit one message (at least one); items the wire refuses are left out and named in diagnostics; entries are chunked by count (`JOURNAL_PUBLISH_MAX_ENTRIES`, `JOURNAL_ITEMS_PER_ENTRY_MAX`) and bytes.
- C12. Requests of the Relay: at most 32 wait for a session to be live (`MAX_PENDING_REQUESTS`); past that the oldest is refused at once with `not_ready`; at most 3 older-history reads per request (`OLDER_READS_PER_REQUEST`); `release` drains for at most 5000 ms.
- C13. Item key at most 4096 characters, never `controller:` prefixed, never a delta source key (enforced in `agent-session-runtime/src/agent-manager.ts` at the identity check).
- C14. Terminal refresh: at most 20 remembered sessions (`JOURNAL_REFRESH_SESSIONS`, oldest release dropped, re-release counts as most recent); at most 4 concurrent summary reads (`JOURNAL_REFRESH_READS`) for a directory whose listing is read only on request; one refresh at a time.

### Errors and refusals
- C15. A request for a session not followed is refused at once (`not_followed`), one for a session followed but not live or whose cycle ended is refused as `not_ready`; the Relay waits for each answer, so none is dropped silently.
- C16. A row the wire refuses is dropped and told once to diagnostics; diagnostics carry no content and a sink that throws cannot stop publishing; a refresh never fails the listing it rides on; nothing starts while the Controller stops.

### Guarantees
- C17. Entries are numbered from the Relay's watermark and each message waits for the acknowledgement of the one before; a row that arrives while opening or reading older history is held and published after the window and head, in order, once.
- C18. An item is the rows of one key in first-appearance order; it is complete when its last row completes; a content row reopens a complete item; an item without identity or under `controller:` is live-only; the merge matches the journal's, so live deltas and a reread have one digest; an open item has no digest.
- C19. No loss and no doubles across restarts and reconnects: the epoch and every row survive a Controller restart with nothing published for an unchanged session; a reconnect keeps the journal as it was; a new epoch starts only when native history was rewritten, carrying live-only items over.
- C20. Terminal refresh attaches the same update time once, and touches nothing it never published, nothing for a provider without journal support, and nothing held (runtime or demand).

| Clause | Test(s) that prove it |
|---|---|
| C1 | `publisher/journal-publisher.test.ts` > "opens the journal, publishes the newest items as one window, and ends with the head"; "sends the window again on every open, and asks for no index"; `publisher/journal-reconcile.test.ts` > "sends the newest items that fit one message as one window, oldest first, complete ones with their digest and open ones without", "says the outcome of every background of the items again, with the strongest status", "says the settled bindings of the items again, and leaves a pending one to the event that settles it"; `publisher/journal-publisher.relay.test.ts` > "builds the journal of a session from its history, with digests, a head and its epoch" |
| C2 | `journal-terminal-refresh.journal.test.ts` > "shows the turn after the next listing without a send, as one appended window, and releases the runtime again"; "is reached by the revision check the page repeats, not only by a listing"; `journal-terminal-refresh.claude.local.test.ts` (real Claude, local tier) |
| C3 | `publisher/journal-publisher.test.ts` > "does not publish a session of a provider that does not declare journal support"; "merges consecutive deltas of one item into a row, completes it with the digest of the whole item, and keeps a still-open item open"; "publishes a head that carries a new pending interaction at once, not after the batch window"; "publishes a background outcome in order with the rows, and leaves the other runtime events to the head"; "publishes a replaced resource binding as an amendment of the item it belongs to"; `agent-controller/src/journal-terminal-refresh.journal.test.ts` > "touches nothing of a provider that declares no journal support" |
| C4 | `publisher/journal-publisher.test.ts` > "publishes what is queued before it stops following"; `publisher/terminal-refresh.test.ts` > "covers the time the release started, or the diverged write when the session was behind its transcript"; "never covers less than what a listing already told"; "remembers nothing when the journal was not serving the session" |
| C5 | `publisher/journal-publisher.test.ts` > "opens again and sends the window again after the Relay refuses a publication"; "opens again when the Relay does not acknowledge in time"; "opens again when the Relay answers sequence_gap"; the `it.each` "opens again with backoff and sends the window again after the Relay refuses a live row as %s"; "keeps reopening with backoff while the Relay keeps refusing, and never gives up or narrows the window"; "opens again after the provider replaces its timeline, and publishes nothing of the rows in between"; "opens again with backoff when the Relay refuses the open, and goes live without unserving"; "starts over when the connection returns, from the manager's timeline and the Relay's watermark" |
| C6 | `publisher/journal-publisher.test.ts` > "stops, tells the Relay to stop serving the journal and says why when the Snapshot cannot be published"; "stops, tells the Relay to stop serving the journal and records the breach when the provider emits an observation without identity"; "stops a session whose provider uses the key prefix reserved for the Controller, and unserves it on the first open, which holds the head of an earlier connection"; "unserves a session whose identity is missing when the connection comes back, if it could not before"; "keeps publishing nothing for a session it gave up on until a connection returns, then tries it again"; `publisher/journal-publisher.relay.test.ts` > "unserves a session whose provider broke the identity contract, so the Relay stops serving its journal" |
| C7 | `publisher/journal-publisher.test.ts` > "is not sent again while it is unchanged: the reopens back off without opening the journal"; "is sent again once it changed"; "is sent again when an open item grew, with the same keys"; "is sent again on a new connection, whose Relay may have room"; "is not held after a refusal for another reason, or after a quota refusal of a live row" |
| C8 | `publisher/terminal-refresh.test.ts` > "attaches a published session once its listed update is newer than its coverage and the terminal has been quiet"; "attaches nothing for an update that is not newer than the coverage"; "attaches the same update time once: the coverage moves to it before the attach"; "leaves a session a terminal wrote to only seconds ago, and attaches it once the terminal has been quiet"; "attaches the due sessions newest first"; "waits for the next change when it failed for any other reason, and tries again when the update time changes"; "is tried again at the next listing, with the same update time, when %s" (terminal owns, in use) |
| C9 | `publisher/terminal-refresh.test.ts` > "is expired when its transcript diverged, it has no demand and its provider can release it"; "is left alone when nothing diverged, or when the provider cannot release it"; "is expired even while the connection holds no journal grant"; `journal-terminal-refresh.journal.test.ts` > "releases a held session whose transcript something else wrote to before a send continues from it, and reads it again" |
| C10 | `publisher/journal-publisher.test.ts` > "collects rows for the batch window before it publishes them"; "opens again when the Relay does not acknowledge in time"; "doubles the backoff when failures follow each other closely"; "starts the backoff over only after the session published for a sustained time"; "keeps no more bytes in flight than the shared budget allows, across sessions, and admits one message when none is in flight"; "reads older pages before it sends a window, so an empty newest page does not empty the journal". `heldEventsMax` 10 000 overflow and `gapReadsMax` 8: gap |
| C11 | `publisher/journal-items.test.ts` > "measures an entry, and refuses one the schema or the limits do not allow"; "sizes items for a message and names the ones it refuses"; "cuts items into blocks that each fit one message and keep their order"; "takes the newest items that fit one message, at least one"; "counts an entry by its own bytes, so 3,000 short replies fit one block"; "refuses an item that only fits the wire under a short session key"; "chunks operations by entry count and bytes, keeping their order"; `publisher/journal-publisher.test.ts` > "drops a row the wire refuses, tells the diagnostics once, and keeps publishing the rest"; "leaves an item the wire refuses out of every window, and tells the diagnostics once"; "sends an empty window when the wire refuses every item of a session whose history is exhausted" |
| C12 | `publisher/journal-publisher.test.ts` > "refuses at once the oldest request when more than 32 wait for the session to be live, instead of dropping it"; "takes room from the shared budget for a fill, like a publication". 3 older reads per request and the 5000 ms release drain: gap |
| C13 | `publisher/journal-publisher.test.ts` > "stops a session whose provider uses the key prefix reserved for the Controller, ..."; `publisher/journal-items.test.ts` > "keeps every item under the reserved controller key prefix live-only, whatever the row says". The 4096-character bound in `agent-manager.ts`: asserted in the provider projector tests only (`agent-provider-codex/src/projector-identity.test.ts`, `agent-provider-claude/src/projector-identity.test.ts`, "gives every timeline observation a key..."); a manager unit test with a 4097 key: gap |
| C14 | `publisher/terminal-refresh.test.ts` > "keeps only the sessions released most recently, a re-release counting as most recent"; "reads the remembered sessions one by one, in batches, and ignores a read that fails"; "runs one refresh at a time and starts the next after it ends" |
| C15 | `publisher/journal-publisher.test.ts` > "refuses at once a fill or an older-history request for a session it does not follow"; "refuses a request for a session it follows but cannot answer, as not ready"; "refuses a request at once while the session waits to open again, well inside the Relay's deadline"; "refuses a request that arrives after the open was sent and before the Relay answered it"; "refuses a request it had queued when the cycle that queued it ends before the session is live" |
| C16 | `publisher/journal-publisher.test.ts` > "drops a row the wire refuses, tells the diagnostics once, and keeps publishing the rest"; `publisher/terminal-refresh.test.ts` > "starts nothing while the Controller stops, and never fails the listing it rides on"; "stops attaching once the Controller stops". Throwing diagnostic sink: gap |
| C17 | `publisher/journal-publisher.test.ts` > "numbers its entries from the Relay's watermark and waits for each acknowledgement before the next message"; "sends the messages of one flush one at a time, each after the acknowledgement of the one before"; "holds the rows that arrive while it opens, and publishes them after the window and the head are acknowledged"; "publishes a row that arrives while it reads older history once, after the head"; "keeps a head change that arrives while the window is in flight, and publishes it once the session is live"; "publishes a live row that arrives between two chunks of older history before the next chunk" |
| C18 | `publisher/journal-items.test.ts` > "groups rows by item key in the order the items first appear, and tells complete from open"; "reopens a complete item when a later row adds content, as the journal does"; "gives a row without identity a key of its own, completes it at once and keeps it live-only"; "marks an item live-only when any of its rows says so"; "merges the rows of an item the way the journal merges them, so live deltas and a reread have one digest"; "takes the time, source and turn of the first row, and the resources of all of them"; "keeps the time, source, turn and live-only mark of the first row, whatever the later rows say"; "gives an item that is still open no digest" |
| C19 | `publisher/journal-publisher.relay.test.ts` > "keeps the epoch and every row across a Controller restart, and publishes nothing for an unchanged session"; "starts a new epoch only when native history was rewritten, carrying its live-only items over"; "keeps the journal as it was across a reconnect, with nothing duplicated and the epoch kept"; "ends with the settled binding in the journal's row when the connection dropped inside the batch window that carried it"; "keeps the id of an image across a Controller restart, so the journal's row still names a resource that can be read"; `journal-continuity.recordings.test.ts` > "%s: opened five times adds no item after the first, and leaves none open" (every recording of Codex and Claude), "a tool that completed while the Controller was away replaces the journal once, as an open item", "a session that grew while the Controller was away appends the newest items of its reread", "a session whose reread lost an item the journal holds replaces the journal, as a changed item" |
| C20 | `publisher/terminal-refresh.test.ts` > "attaches the same update time once: the coverage moves to it before the attach"; "touches nothing it never published, nor a summary with no readable time"; "leaves a held session to itself: neither a runtime nor demand lets the refresh attach it"; "does nothing for a provider that has no directory, or while the connection holds no journal grant"; `journal-terminal-refresh.journal.test.ts` > "attaches nothing for a listing that is not newer, and once only for the same update time listed again"; "leaves a held session to itself: no attach while a manager follows it"; "touches nothing of a session this Controller never published"; "forgets what it published when the Controller restarts, so a turn written meanwhile shows at the next open through the Controller" |

Gaps:
- C10 `heldEventsMax` (10 000) overflow reopens, and `gapReadsMax` (8) bound: unit test in `journal-publisher.test.ts` with small `limits` overrides.
- C12 3 older-history reads per request and the 5000 ms `release` drain: unit test with a scripted Relay that never acknowledges and the injected scheduler.
- C13 manager-side 4096 key bound: unit test of `agent-manager` identity check with a 4097-character key, expecting the breach event.
- C16 a diagnostic sink that throws does not stop publishing: unit test in `journal-publisher.test.ts`.
- Drift in the header of `journal-publication.ts`: it says "at most 20 mutable fields and 6 recovery outcomes" but lists 4 outcomes; fix text or add the missing ones (not testable).

Candidates for deletion: none clearly redundant; `journal-publisher.relay.test.ts` > "many sessions over one connection" overlaps "keeps no more bytes in flight than the shared budget allows" in `journal-publisher.test.ts` but runs the real Relay journal service, so it is kept as a seam test.

## Codex and Claude adapter item identity
Module: `agent-provider-codex/src/projector.ts` (live notifications and `projectCodexThreadHistory` in `history.ts`; interactions in `session.ts`), `agent-provider-claude/src/projector.ts` (`ClaudeEventProjector`, `delivery` is `'live'` or `'history'`; interactions in `interactions.ts`); tests: `agent-provider-codex/src/projector-identity.test.ts`, `agent-provider-codex/src/projector.test.ts`, `agent-provider-claude/src/projector-identity.test.ts`, `agent-controller/src/journal-continuity.recordings.test.ts` (recording rows), `agent-provider-codex/src/journal-recording.local.test.ts` and `agent-provider-claude/src/journal-recording.local.test.ts` (record the fixtures, local tier). Design source: section 4 of `docs/superpowers/plans/2026-11-17-s6a-claude-codex-journals.md`.

### Purpose
- C1. Every timeline observation of a journal-capable provider carries `itemIdentity { key, completes?, liveOnly? }`, so the Controller groups rows into items without reading native meaning. Live and history delivery give the same key for the same item, so a reopen finds an unchanged journal.

### Inputs and outputs
- C2. Keys are type-prefixed, at most 4096 characters, never a delta source key, never `controller:`. Codex uses the native `item.id`; Claude uses the message id plus block index, the `tool_use_id`, or the record uuid.
- C3. Codex keys (`projector.ts`): user message `user:<id>`; assistant text and plan item `assistant:<id>`; correction `assistant:<id>:correction`; reasoning `reasoning:<id>`; tool (command, file change, MCP, dynamic, web search, collab) `tool:<id>`; agent communication `comm:<id>`; image `image:<id>`; compaction `compaction:<id>`; turn failure `turn-error:<turnId>`; unknown item type `error:unsupported-item:<id>`; failing MCP start-up `startup:<name>`; other error `error:<sha256 prefix of the message>`; plan update `todo`; interaction `interaction:<itemId>` or `interaction:<turnId>:<requestId>`.
- C4. Claude keys (`projector.ts`): user row `user:<uuid>` (a folded input, an interrupt notice and a withdrawn input are keyed by their own uuid); assistant text `assistant:<message.id>:<block index>`; correction `...:correction`; thinking `reasoning:<message.id>:<block index>`; tool `tool:<tool_use_id>`; tool image `tool:<tool_use_id>:image:<index>`; TodoWrite `todo:<tool_use_id>`; compaction `compaction:<status uuid>` (the boundary completes it; a boundary alone keys by its own uuid); interaction `interaction:<requestId>` (`interactions.ts`).

### States and transitions
- C5. Completion: a streamed assistant text or reasoning is open until its final record, which completes it with an empty body when the stream was whole, the suffix when it extended the stream, or the whole text when nothing streamed; an empty final with nothing streamed gives no item (Codex), an empty record after streamed text still completes (Claude).
- C6. A final that does not continue the stream cannot rewrite it: the base item completes with an empty body and the corrected text becomes a complete `...:correction` item beside it (Codex assistant text only; Claude assistant text only; reasoning gets none).
- C7. A tool is one item: the started or `tool_use` row is open (`running`); the completed row repeats the whole content with `completes`. A Codex compaction is open `loading`, then completed; a Claude compaction is open at the status row and completes at the boundary; user messages, images, communications, turn errors and todo are complete at emit.
- C8. When a turn ends, items still open are finished: streamed text and reasoning with an empty body, a compaction as `failed`; a tool stays as it was (`finishOpenItems`).
- C9. Codex reasoning with several summary parts streams a `\n\n` delta at each `summaryPartAdded` above index 0, so the stream equals what history joins; reasoning with only `content[]` arrives whole at completion.

### Limits
- C10. A bounded-length rule for diagnostics text: unsupported or invalid Codex notification messages are cut to 640 characters (`MAX_UNSUPPORTED_MESSAGE_LENGTH`).
- C11. Key length at most 4096 is a contract of the SDK (`provider-sdk/src/observation.ts`) enforced by the manager (`agent-manager.ts`); projectors only emit short keys.

### Errors and refusals
- C12. Live-only marks (native history cannot rebuild the item): Codex `todo` (plan update, a kind key), `error:<hash>` (an error history never holds; same message is one item), `startup:<name>` (failing MCP server) and every interaction; Claude interactions, and the text of a local command printed by a synthetic record (`<synthetic>` model, live delivery only; the history delivery of the same record has no mark). Nothing else is live-only: a Claude TodoWrite and thinking are rebuilt from history.
- C13. Not projected: Codex `thread/compacted` notice (repeats the compaction item), thread read-state changes, `codex/event/*` mirrors and thread-less start-up notices that are not failures; a Claude sidechain message (`parent_tool_use_id`) and records of other sessions. An unknown Codex item type becomes one error item at completion, never at start.
- C14. A Codex item type with no identity rule throws instead of emitting an unkeyed row.

### Guarantees
- C15. Same key live and in history for the same item, for the whole conversation of each provider; reading the same history five times adds no item after the first.
- C16. A history delivery finishes every item it emits (Codex: every history row has `completes`; Claude: all but the tool's open row), because native history holds finished items.
- C17. Each item is finished once: a repeated completion of the same text item emits nothing more (Codex `completedTextItems`); a Claude record uuid seen twice is ignored.
- C18. A withdrawn Claude input stays under its own uuid and is dropped by the next replacement, because no transcript holds it.

| Clause | Test(s) that prove it |
|---|---|
| C1 | `agent-provider-codex/src/projector-identity.test.ts` > "gives every timeline observation a key, equal for the same items live and in history, and never a controller or delta source key"; `agent-provider-claude/src/projector-identity.test.ts` > same title; `journal-continuity.recordings.test.ts` > "gives every row an identity and none a key the Controller keeps for itself" (every recording) |
| C2 | the two "gives every timeline observation a key..." tests above (key length at most 4096, no `controller:` or delta key) |
| C3 | Codex `projector-identity.test.ts` > "gives every timeline observation a key..." (`user:`, `reasoning:`, `assistant:`, `tool:` for command, file change, MCP, web search, `compaction:`); "keys a failed turn the same in both paths, and an item type it does not know once, when it completes" (`turn-error:`, `error:unsupported-item:`); "marks as live-only exactly what native history cannot rebuild..." (`todo`, `error:*`); `projector.test.ts` > "projects plan deltas as one appendable assistant message"; recordings > codex "errors: a failed turn is one error item in both, and a failing MCP server is one live-only item" (`startup:`), "approval: ..." (`interaction:`). Keys `comm:<id>`, `image:<id>` and the interaction key fallback `interaction:<turnId>:<requestId>`: gap |
| C4 | Claude `projector-identity.test.ts` > "gives every timeline observation a key..." (`user:`, `reasoning:`, `assistant:`, `tool:`); "keys a user row by its uuid, equal live and in history, for input folded into a turn and for an interrupt notice"; "marks as live-only nothing the projector makes: a TodoWrite is rebuilt from its tool row, and reasoning from its record" (`todo:`); "makes a compaction one item: the status row opens it, the boundary completes it, and a boundary alone is an item of its own"; recordings > claude "approval: ..." (`interaction:`), "parallel-tools: two tool calls of one message keep their order and block indices"; tool image key `tool:<id>:image:<n>`: gap (the `images` recording row asserts continuity only) |
| C5 | Codex `projector-identity.test.ts` > "finishes every item once: a tool and a compaction repeat their whole content, a streamed text finishes with what it lacks"; `projector.test.ts` > the `it.each` "finalizes %s once for matching, extended, corrected, and unstreamed text"; Claude `projector-identity.test.ts` > "finishes a streamed block with its record: an empty body when the stream was whole, a tool result with the whole row"; "finishes the text of a record the stream never showed with the whole text, and an empty record with nothing" |
| C6 | Codex `projector.test.ts` > "preserves corrected final text without appending it to the streamed message"; "retires streamed state after projecting a corrected completion"; recordings > codex "correction: a final that does not continue the stream replaces the journal once, as a changed item, and the correction item is gone"; Claude `projector-identity.test.ts` > "ends a final that does not continue the stream as it streamed, with the corrected text beside it" |
| C7 | Codex `projector-identity.test.ts` > "finishes every item once..." (tool running then completed, compaction loading then completed); Claude `projector-identity.test.ts` > "finishes a streamed block with its record..." (tool) and "makes a compaction one item..."; recordings > codex "compaction: the compaction is one item, and history keeps everything before it"; claude "compaction: the compaction costs one changed replacement, because the chain restarts at the boundary, and then settles" |
| C8 | Codex `projector-identity.test.ts` > "ends what a turn left open when it ends: streamed text and reasoning with an empty body, a compaction as failed, a tool as it was"; Claude > "ends what a turn left open when it ends: streamed text and thinking with an empty body, a compaction as failed"; recordings > claude "failed-compaction: a compaction that never reached its boundary ends failed, beside the error the CLI printed, which is live-only", codex "interrupted: nothing streamed stays open, the command that was under way stays open until history reports it failed, then one changed and settled" |
| C9 | Codex `projector-identity.test.ts` > "streams a reasoning of several summary parts as the text history joins, so the reread equals it"; "keeps a reasoning of one part and a reasoning with only content equal to history too"; recordings > codex "reasoning: two summary parts streamed with their blank line equal what history joins" |
| C10 | Codex `projector.test.ts` > "projects unsupported notifications and live items as bounded diagnostics" |
| C11 | see C13 of the publisher section; adapter side asserted by the two "gives every timeline observation a key..." tests (length at most 4096) |
| C12 | Codex `projector-identity.test.ts` > "marks as live-only exactly what native history cannot rebuild: the plan board and errors it does not hold"; recordings > codex "approval: the question and the approval, which native history does not hold, stay in the journal as live-only items", "todos: two plan updates are one live-only item, and the reread holds none", "the live-only items of the recordings are the plan board and the interactions, and an error that history does not hold"; Claude `projector-identity.test.ts` > "keeps the output of a local command live-only, since the SDK read omits it, and gives a recorded synthetic record no mark"; "marks as live-only nothing the projector makes..."; recordings > claude "approval: the question and the permission prompt, which the transcript never held, stay in the journal as live-only items", "slash-command: a built-in that prints its own output keeps it as a live-only item the SDK read omits, and the typed row equals the transcript row", "thinking: the thinking block the SDK read keeps is not live-only", "the live-only items of the recordings are the interactions and what a local command prints, and nothing else" |
| C13 | Codex `projector-identity.test.ts` > "does not project the deprecated compaction notice, which repeats the compaction item"; "does not turn the read position of a thread into an error"; "keys a failed turn the same in both paths, and an item type it does not know once, when it completes"; `projector.test.ts` > "uses canonical item lifecycle notifications and ignores legacy mirrors"; "ignores Codex remote control availability notifications"; recordings > claude "subagent: the sidechain is absent and the parent tool row has equal keys, and the wake-up row the stream never shows is not in the reread" |
| C14 | gap |
| C15 | the "gives every timeline observation a key, equal for the same items live and in history..." test of each provider; Claude `projector-identity.test.ts` > "reads the same history five times and adds no item after the first", "reads the envelope of a typed slash command as the command was typed, so the transcript row equals the live row"; recordings > every provider's "%s: reopening gives unchanged..." `it.each` over the recordings (codex: settled, restart, reasoning, steer, after-reopen, plan-mode, approval, todos, compaction, errors; claude: settled, restart, after-reopen, thinking, approval, plan-approval, todos, steer, queued, interrupted, ...), "plan-mode: the plan shown as a message while it streamed is the item history lists, so a plan turn reopens unchanged" |
| C16 | Codex `projector-identity.test.ts` > "finishes every item once..." (last assertion: every history row has `completes`); Claude > "finishes a streamed block with its record..." (last assertion); Codex "reads history in the order items started when their lifetimes overlap, and in native order when a start time is missing" |
| C17 | Codex `projector.test.ts` > "finalizes %s once for matching, extended, corrected, and unstreamed text"; "keeps equal fragments distinct across items, turns, and projector lifetimes"; Claude: duplicate uuid ignored: gap (only five-history-reads covers it indirectly) |
| C18 | Claude `projector-identity.test.ts` > "keeps the rows of a withdrawn input under its own uuid, which no transcript holds"; recordings > claude "withdrawn: input removed from the native queue stays visible until the next reopen, which replaces once and drops it" |

Differences between the plan table (section 4) and the code, to settle in the document, not in tests:
- Plan 4.1 says a failing start-up notice is dropped from the timeline; the code emits `startup:<name>` as a live-only error item for `mcpServer/startupStatus/updated` failures (and nothing for hooks), and the recording row "errors" asserts it. The plan row is stale.
- Plan 4.1 lists `thread/compacted` as `compaction:<turnId>` when no item was seen; the code never projects it (`compactionItemTurns` is gone; test "does not project the deprecated compaction notice").
- Plan 4.2 says folded input is keyed `user-text:<hash16>:<n>` with a shared `messageId`; the code keys every user row `user:<uuid>` (the history row of folded input carries the uuid the Controller gave it; `transcript-extras.ts` attaches it) and the test is titled accordingly. The plan row is stale.
- Plan 4.2 says Claude reasoning is live-only if the reread lacks it; the code and recording ("thinking") say it is not. Plan 4.2 says the interaction mark is by `interaction_resolved`; the Claude code does the same (`interactions.ts` line 93).
- Codex plan-approval interaction key is `interaction:plan:<threadId>:<planId>` (a plan has no item id), seen in the `plan-mode` fixture; the plan table does not list it.

Gaps:
- C3 Codex `comm:<id>` and `image:<id>` keys and the `interaction:<turnId>:<requestId>` fallback: unit rows in `projector-identity.test.ts` (an `agentCommunication` item, an `imageView` item, a request without `itemId`).
- C4 Claude `tool:<id>:image:<n>` key: unit row in `projector-identity.test.ts` with a tool result carrying an image block.
- C14 Codex item with no identity rule throws: unit row (a mapped type outside the switch is unreachable today, so decide whether to keep the `default` branch; delete it if unreachable).
- C17 Claude duplicate record uuid emits nothing the second time: unit row in `projector-identity.test.ts`.
- Claude `TodoWrite` and Codex `todo` kinds differ (`todo:<tool_use_id>` per call vs one kind key `todo`): covered per provider, but a test stating that a later Codex update replaces the board in place (same key) is only in the recording row, not at unit tier.

Candidates for deletion: none.

## Client replica and send state
Module: `agent-client/src/replica/` (`send-state.ts`, `pending-messages.ts`, `store.ts`, `reducer.ts` = `snapshot-apply.ts` + `live-fold.ts` + `page-fold.ts`, `window-absorption.ts`, `timeline-entry-key.ts`), the echo watcher `agent-client/src/client/message-echo-sync.ts`, the retry path in `agent-client/src/client/remote-session-client.ts`, and the composer queue `agent-client-web/src/react/usePendingSend.ts` + `PendingSendQueue.tsx`; tests: `ac/replica/send-state.test.ts`, `ac/replica/message-ledger.test.ts`, `ac/replica/reducer.test.ts`, `ac/replica/window-absorption.test.ts`, `ac/replica/timeline-entry-key.test.ts`, `ac/replica/restored.test.ts`, `ac/replica/resource-pending-messages.test.ts`, `ac/client/remote-session-client.test.ts`, `acw/AgentComposer.pending.test.tsx`, `acw/OutgoingMessageItem.test.tsx`, `agent-remote-seams/tests/S3/message-echo-sync.integration.test.ts`, `agent-remote-seams/tests/S6/client-replica-to-renderer.integration.test.tsx`.

### Purpose
- C1. The replica holds one session's display state (Snapshot, timeline rows, interactions, resources, diagnostics, retired epochs) and a ledger of the messages this client sent and has not yet seen echoed (`OutgoingMessage`, `replica/types.ts`).
- C2. The send state of a ledger message is one pure table, `transition(state, event)`, over `sending`, `awaiting_echo`, `unconfirmed`, `failed`, with no clock, storage or transport; `describe(state, delivery)` gives the one label, `settled` and `deliveryState` a reader sees.

### Inputs and outputs
- C3. Inputs are Snapshot, stream, history page, interaction, resource, device-restore and replacement calls on `AgentReplica`, plus `beginMessage`, `acknowledgeMessage`, `updateMessage`, `retryMessage`, `deleteMessage`, `restoreMessages`. Output is an immutable `AgentReplicaState`; every change goes through `replace`, which reconciles the ledger and notifies subscribers once.
- C4. A message leaves the ledger (`delivered`) only by its echo row in the timeline, or at once when the Host handled it as a command (`disposition: handled`).

### States and transitions
- C5. `sending` + acknowledged becomes `awaiting_echo` and clears the error; `awaiting_echo` stays; `unconfirmed` stays `unconfirmed`; `failed` stays `failed`.
- C6. A send that ends without acknowledgement becomes `unconfirmed` when delivery is uncertain and `failed` (with the Host's words) when refused; a send the Host will not run again also sets `retryRequiresNewOperation` and the "may not have arrived" words.
- C7. An echo settles `sending`, `awaiting_echo` and `unconfirmed`; it never settles `failed` (an echo of a failed message is not matched).
- C8. A history rewrite that removes the anchor row makes `sending` and `awaiting_echo` `unconfirmed` with the "history changed" words; `unconfirmed` and `failed` are left as they are. Applied by `PendingMessages.reconcile` only after the timeline is initialized and no replacement epoch is pending.
- C9. A ledger loaded from storage becomes `unconfirmed` with the reload words (a saved error is kept); `failed` stays `failed`. A ledger written before row keys is read once as `unconfirmed` and written back in the new form.
- C10. Only `failed` and `unconfirmed` may be retried or deleted (`canSettle`); retry moves to `sending`, clears the error and the new-attempt debt. Only `awaiting_echo` waits for an echo (`awaitsEcho`).
- C11. Composer queue item phases: `waiting` -> `preparing` -> `sending` (dispatched) -> removed, or `error`. The composer chip is hidden once dispatched, so the conversation shows one "Sending" (`PendingSendQueue.tsx`).

### Limits
- C12. A message's echo is a later `user_message` row after its anchor row (`afterKey`: row key, `epoch-start:<epoch>`, or `epoch-seq:<epoch>:<seq>` for streams without item keys); an older row with the same text is never taken (`pending-messages.ts`).
- C13. Accepted-but-unechoed messages are looked for in history after 10 s, then 30 s, then 60 s and on (`message-echo-sync.ts`); each scan reads at most 8 pages, has a 15 s deadline, and a failed read only backs off. It reads forward only and never resends.
- C14. Background outcomes kept by id: at most 2048; the oldest id is dropped beyond it (`applyBackgroundOutcome`, `snapshot-apply.ts`).
- C15. The composer's pending-send queue has no length bound and no timeout: a waiting message stays "Sending" for any time until the session can take it (`usePendingSend.ts`; no constant). Device-store byte and window limits belong to S7 and are not part of this component.

### Errors and refusals
- C16. A queued message the session refused for good (terminal in control, read-only, control changed, Host or Controller offline: `NOT_DELIVERED` in `usePendingSend.ts`) is un-dispatched and says "Not sent" with Retry; any other failure after dispatch says "Check delivery" and offers only dismiss, never Retry.
- C17. A queued message held because the session cannot take it (ended, failed, read-only, unopened) says "Not sent" and is sent only by Retry (`hold`).
- C18. `retryMessage` refuses a message that is not `failed` or `unconfirmed`, and refuses while the connection is not open (`connection_not_ready`).

### Guarantees (ordering, no loss, no doubles)
- C19. Retry repeats the same operation only for an `unconfirmed` message that does not owe a new attempt, still holds its anchor row and has an operation; otherwise it is a new operation, with prepared-text evidence and consumed-echo keys cleared and the anchor moved to the newest row (`retriesSameOperation`, `AgentReplica.retryMessage`).
- C20. An echo row is assigned to at most one message, including replay and echo-before-acknowledgement; consumed keys are kept across reload and a late acknowledgement.
- C21. A late acknowledgement never lifts `unconfirmed` and never touches `failed`; delivery is never resent automatically (reconnect, epoch change or lost acknowledgement).
- C22. The composer queue delivers FIFO, one in flight; later messages pause behind an unknown outcome until the reader dismisses it; two composers for one session never deliver the same message twice; a message dispatched under one lifetime is not re-dispatched by another.
- C23. Timeline: one row per item key; a live event updates the held row in place and keeps its position; a duplicate sequence adds nothing; a forward gap pauses and drains after the filling `after` page; an older page prepends without losing the live head.
- C24. A replacement epoch keeps the held rows on screen until its tail is read, buffers frames of the new epoch, ignores retired epochs (`stale_epoch`), and takes the tail by key without an empty state (`absorbWindow`: unchanged rows keep the same object, a repeated key counts once, rows older than the window leave).
- C25. Rows restored from the device seed only a replica that has read nothing, are display only, and are confirmed by the first page that reads forward from them or replaced by the tail of a new epoch; a send over them waits and is dispatched only after confirmation.

| Clause | Test(s) that prove it |
|---|---|
| C1 | `ac/replica/reducer.test.ts` > "replaces Agent snapshot state without clearing an independently loaded Timeline" (state parts); `ac/replica/message-ledger.test.ts` > "names the newest row as the anchor of a message" (ledger) |
| C2 | `ac/replica/send-state.test.ts` > "the send state table" rows, "has a row for every state and every event", "the words a reader sees" |
| C3 | `ac/replica/restored.test.ts` > "is announced to subscribers once, and a repeated restore changes nothing"; `agent-remote-seams/tests/S6/...` > "gives the same timeline object when a page repeats what the replica holds" |
| C4 | `send-state.test.ts` > "a command the Host handled leaves the list at once, whatever its state"; `message-ledger.test.ts` > "confirms the message by its echo when a replacement keeps the anchor row"; `remote-session-client.test.ts` > "shows local sends immediately and keeps them until a new user echo, independently of acknowledgement"; S6 > "shows what the reader sent in the words of the send state: sending, then sent and waiting, and nothing once the echo arrives" |
| C5 | `send-state.test.ts` rows "a sending message that is acknowledged waits for its echo...", "a message already waiting stays waiting...", "an unconfirmed message stays unconfirmed when acknowledged...", "a failed message is not changed by an acknowledgement" |
| C6 | `send-state.test.ts` rows "a refused send fails with the Host's words", "an uncertain send is unconfirmed...", "an uncertain send the Host will not run again needs a new attempt...", "a send that fails after it was accepted can still become unconfirmed", "a retry that is refused fails again"; `OutgoingMessageItem.test.tsx` > "explains a retry the Host could not settle in plain words..." |
| C7 | `send-state.test.ts` rows "an echo settles a sending/waiting/unconfirmed message", "an echo never settles a failed message" (the failed-message echo-not-matched case at ledger level: gap, see below) |
| C8 | `send-state.test.ts` rows "a rewritten history ..." (4 rows); `message-ledger.test.ts` > "marks the message unconfirmed when a replacement rewrote its anchor row"; `remote-session-client.test.ts` > "does not erase delivery uncertainty after history replacement when a late acknowledgement arrives" |
| C9 | `send-state.test.ts` rows "...loaded after a reload...", "an unconfirmed message keeps the words it was saved with", "a failed message stays failed after a reload..."; `message-ledger.test.ts` > "reads a ledger written before row keys once as unconfirmed and writes it back in the new form" |
| C10 | `send-state.test.ts` > "lets only a failed or an unconfirmed message be retried or deleted", "looks for an echo only for a message that waits for one", rows "a failed/an unconfirmed message is retried as sending", "a sending/waiting message cannot be retried"; `AgentComposer.pending.test.tsx` > "lets a message the session refused for certain be retried, and sends it again only on Retry" (delete half of C10 at replica level: gap) |
| C11 | `AgentComposer.pending.test.tsx` > "serializes pending sends while accepting more input during an outstanding send" (chip leaves when dispatched), "keeps a waiting message Sending while its view cannot take messages yet, however long, and sends it once the session is ready" |
| C12 | `message-ledger.test.ts` > "does not take an older message with the same text for the echo", "anchors a stream without item keys by position, so a row folded into an earlier one cannot make the message unconfirmed", "names the newest row as the anchor of a message"; `resource-pending-messages.test.ts` (both tests: echo matching by resource identity and with the reference note) |
| C13 | `remote-session-client.test.ts` > "silently synchronizes overdue acknowledged messages together without resending", "does not synchronize messages that have already echoed or are still awaiting send acknowledgement", "preserves newer live projections and cursors while scanning earlier pages for a missing echo"; S3 > "recovers an omitted live echo through HTTP without reconnecting or resending" (the 10/30/60 s steps, the 8-page and 15 s bounds: gap) |
| C14 | gap |
| C15 | `AgentComposer.pending.test.tsx` > "queues multiple messages, keeps editing available and drains FIFO without changing the new draft" (no bound is shown only for 2 items; the absence of a bound is not tested) |
| C16 | `AgentComposer.pending.test.tsx` > "does not automatically retry an operation whose delivery became uncertain" ("Check delivery"), "lets a message the session refused for certain be retried, and sends it again only on Retry" |
| C17 | `AgentComposer.pending.test.tsx` > "waits for confirmed control, and holds a waiting message as Not sent when a terminal takes the session, sending it only on Retry", "says Not sent, with Retry and Cancel, for a waiting message when the session ended / the agent failed", "says Not sent for a waiting message when the view could not open its session, and sends it only on Retry" |
| C18 | gap |
| C19 | `remote-session-client.test.ts` > "retries an unconfirmed send manually with the same operation identity and one local message", "starts a new attempt after the current cursor instead of reusing a consumed plain echo", "keeps prepared input uncertain after an epoch change and clears its evidence for a new retry", "retains exact ordered content through failure and retry without mutating its outbox snapshot"; `send-state.test.ts` > "who may retry or delete, and what Retry repeats" (5 rows) |
| C20 | `remote-session-client.test.ts` > "consumes identical user echoes once, including replay and echo-before-acknowledgement races", "persists prepared-text evidence and does not reuse an echo consumed before its acknowledgement", "does not reuse one confirmed echo for identical retained input after a page restart", "does not confirm an image send from a plain-text lookalike or a missing image digest" |
| C21 | `remote-session-client.test.ts` > "retains a prepared echo with lost acknowledgement and never resends it automatically", "retains disconnected input for late history recovery without resending it", "reconciles a late echo after a generic command failure"; `AgentComposer.pending.test.tsx` > "does not automatically retry an operation whose delivery became uncertain" |
| C22 | `AgentComposer.pending.test.tsx` > "queues multiple messages, ... drains FIFO ...", "pauses FIFO behind an unknown outcome until the user checks and dismisses it", "serializes pending sends while accepting more input during an outstanding send", "keeps the concrete waiting queue visible and recoverable when only the native client lifetime changes", "retains a session queue while switching without sending to the other session"; two composers never deliver twice: gap |
| C23 | `reducer.test.ts` > "suppresses duplicate live sequence delivery without duplicating content", "pauses a forward gap and drains the buffered head after an after page fills it", "prepends an older page while preserving the live head and chronological order", "buffers live rows before the tail fetch and converges with the authoritative page", "holds one row per key: a live event updates the held row in place and keeps its position", "drops the keys an older page repeats, ...", "updates a held row in place without moving it when an after page carries its new content", "leaves a live frame for an item above the window to the older page, ..." |
| C24 | `reducer.test.ts` > "keeps the held rows on a replacement epoch until its tail is read, buffers the new epoch and ignores the old one", "treats an authoritative tail page from a new epoch as a replacement boundary", "takes the tail of a pending epoch as the new timeline, retires the old epoch and clears the pending mark", "drops rows older than the new window and never passes through an empty state", "retires the old epoch only when the tail is applied", "retargets a second replacement while one is pending, with no queue", "buffers every frame of the pending epoch, a gap included, and applies them after the tail", "answers a page that says the cursor is stale or ahead with one replaced reduction that keeps the rows", "absorbs rows without keys, ...", "applies only the tail of the pending epoch: ..."; `window-absorption.test.ts` > all 4; `timeline-entry-key.test.ts` > all 3; S6 > "keeps unchanged rows mounted through a replacement in a new epoch, and never shows an empty timeline between" |
| C25 | `reducer.test.ts` > "seeds only a replica that has read nothing", "are confirmed by the first page that reads forward from them, and not by one that reads older rows", "are replaced by the tail of the new epoch when the Relay does not hold the stored position, and then confirmed"; `restored.test.ts` > all 4; S6 > "paints the rows of a restored replica by item key before any frame arrives", "keeps every unchanged row mounted when the first server tail confirms a restored window", "takes a send over a restored replica, shows it as Sending, and sends it only after the first server page confirms the state" |

Gaps:
- C7 (ledger level): a failed message whose text appears as a later row stays `failed` and the row is not consumed; a `message-ledger.test.ts` unit with a `failed` message and an echo row would close it.
- C10 (delete): `deleteMessage` in `remote-session-client.ts` refuses a `sending` or `awaiting_echo` message; a `remote-session-client.test.ts` unit would close it.
- C13: the 10 s / 30 s / 60 s back-off, the 8-page scan bound and the 15 s deadline have no fake-timer unit on `watchMessageEchoes`; add one in `ac/client/` with a stub transport.
- C14: the 2048 cap on `backgroundActivities` has no test; a `reducer.test.ts` unit applying 2049 outcomes would close it.
- C15: no test shows the queue stays unbounded or what happens with many items; either add a unit with 50 queued sends (drains FIFO) or set a real bound.
- C18: `retryMessage` refusals (not settle-able, connection not open) have no test; add two `remote-session-client.test.ts` units.
- C22 (two composers): no test mounts two composers on one session key and checks one delivery; add one to `AgentComposer.pending.test.tsx`.

Tests that map to no clause (candidates for deletion): none found. `message-ledger.test.ts` > "names the newest row as the anchor of a message" overlaps C12 with the anchor tests; keep it unless the two others are merged.

## Client session presentation
Module: `agent-client/src/client/session-presentation.ts` and `agent-client/src/client/lease-view.ts`; tests: `agent-client/src/client/session-presentation.test.ts` (vector table `agent-client/src/testing/session-presentation-vectors.ts`), `agent-client/src/client/lease-view.test.ts`, `agent-client/src/client/session-state.test.ts`, `agent-client/src/client/session-states.test.ts`, `agent-client-web/src/react/AgentComposer.pending.test.tsx`.

### Purpose
- C1. One pure function set says what a person sees of a session: its one business notice (`sessionNotice`), whether the composer takes input and whether a send goes now (`composerAvailability`), and the activity label (`sessionActivityLabel`). Views read these and never read connection phase, control check, synchronization or runtime recovery for words or enablement (target T5).
- C2. `leaseView(control)` is one table from the replica's control state to `{ state, readOnly, checking, native }`; the renderer never reads `access`, `available` or `nativeOwner` itself.

### Inputs and outputs
- C3. Input is `SessionFacts` (`RemoteSessionState`, Host online and name as the Relay last said, and the replica read only for failure words). Output is a `SessionNotice` or none, a `ComposerAvailability`, a label or none, and plain words (`sessionNoticeWords`, `leaseNoticeLabel`) through a translator (English default, Chinese in the catalogue). No clock, no I/O.
- C4. Notice precedence, first match wins: connection `unavailable`; activity `failed`; activity `closed`; Host offline; lease (terminal, other Controller, read-only); runtime `unavailable`.

### States and transitions
- C5. Lease states: no control channel `unknown`; `checking` (not read-only, `checking: true`); `control`; read-only with owner `native_cli` -> `native_cli`; read-only with another Controller -> `other_controller`; read-only with no owner -> `read_only`. A control check has no words.
- C6. R1: connection phase, control checking, synchronization, held rows and a recovering runtime never produce a notice, a disabled composer or a label of their own; they only decide whether a send goes now or waits. Stale non-recoverable diagnostics never speak for a later attempt (only `connection: unavailable` shows them).
- C7. R2: the composer is disabled only for a business reason: read-only lease (`read_only`, `terminal_in_control`, `other_controller`), `ended`, `failed`, `unavailable` (refused for good), or an agent without `sendMessage` (`unsupported`).
- C8. R3: when enabled, `dispatch` is `now` exactly when `operations.send_message.allowed` (synchronized, control check over, send allowed), otherwise `when_ready` (the send waits in the queue).
- C9. R4: an offline Host is a notice and leaves the composer enabled. A runtime `unavailable` is a notice (`agent_unavailable`) and also leaves it enabled; sends wait.
- C10. Activity label: none before a Snapshot or for a refused session; the native owner's words for `native_cli`, "Native control transferred" for `other_controller`; then `failed`, `closed`, `waiting`, `running` (Working), else Starting / Ready, or Executing command while a command is pending and the session is idle or starting.

### Limits
- C11. No numeric limit, no clock, no size bound in these two modules. The only fixed text is the fallback words: `UNAVAILABLE` ("This session is unavailable."), `FAILED` ("The agent failed without error details."), `ITS_HOST`; the client's own fallbacks are translated, a failure described by the agent, Relay or Controller is shown as sent.

### Errors and refusals
- C12. A failure notice takes the runtime failure message, else the last error, else the fallback; an `unavailable` notice takes the last non-recoverable diagnostic, else the fallback.
- C13. R5: the words for a native owner come only from `leaseNoticeLabel`; no other path words a lease.

### Guarantees (ordering, no loss, no doubles)
- C14. The same facts always give the same outputs (pure, no hidden state); every vector row fixes notice, composer and label together.
- C15. Over every cross of connection phase x lease x runtime connection x activity x Host x restored, no output contains a T5 word (connecting, checking, synchronizing, restoring, reconnecting).
- C16. Without a business fact the outputs are no notice, an enabled composer and a business label or none.
- C17. A refused (`unavailable`) session is never treated as recovering, so input is not held for a reconnect that will not happen.
- C18. A send over a restored replica waits and is dispatched only once the first server page confirms the state (R3 consumed by the composer).

| Clause | Test(s) that prove it |
|---|---|
| C1 | `session-presentation.test.ts` > "the presentation of a session, row by row" (all vector rows) |
| C2 | `lease-view.test.ts` > "the lease view table" (6 rows) |
| C3 | `session-presentation.test.ts` > "words a notice in business terms"; vector rows; Chinese words: gap |
| C4 | vector rows only (single facts per row, e.g. "ready, closed", "ready, failed with a runtime failure", "ready, Host offline"); the order between two coexisting facts: gap |
| C5 | `lease-view.test.ts` > "the lease view table" (all six rows, including the notice and activity words) |
| C6 | `session-presentation.test.ts` > "R1: ... say nothing" > "gives no T5 word in any output, over N combinations"; vector rows "connecting again, a stale refusal in the diagnostics", "restored running turn, catching up, checking", "ready, runtime reconnecting" |
| C7 | `session-presentation.test.ts` > "R2 and R3: the composer" > "is disabled only with a business fact present"; vector rows "ready, closed", "ready, a terminal has control", "ready, sendMessage unsupported" (the converse: each business fact does disable: vector rows only) |
| C8 | `session-presentation.test.ts` > "sends now exactly when synchronized, the control check is over and send_message is allowed" |
| C9 | `session-presentation.test.ts` > "keeps an offline Host enabled (R4)"; vector rows "ready, runtime unavailable", `AgentComposer.pending.test.tsx` > "keeps an agent that takes no messages blocked, and lets a message wait while the runtime is unavailable" |
| C10 | `session-presentation.test.ts` > "says a pending command while the session is idle, and nothing before the Snapshot"; vector rows (labels); `lease-view.test.ts` activity column |
| C11 | `session-presentation.test.ts` > vector rows "unavailable, no Snapshot, no reason", "ready, failed ..." (fallback words); no limit to test |
| C12 | vector rows "ready, failed with a runtime failure", "unavailable, session deleted", "unavailable, no Snapshot, no reason" |
| C13 | `lease-view.test.ts` > "the lease view table" (notice column) |
| C14 | `session-presentation.test.ts` > vector rows (determinism is implied, not asserted by a repeat call) |
| C15 | `session-presentation.test.ts` > "gives no T5 word in any output, over N combinations" |
| C16 | `session-presentation.test.ts` > "gives no notice, an enabled composer and a business label or none when no business fact is present" |
| C17 | `session-state.test.ts` > "does not treat a refused session as recovering, so input is not held for a reconnect that will not happen" |
| C18 | `agent-remote-seams/tests/S6/client-replica-to-renderer.integration.test.tsx` > "takes a send over a restored replica, shows it as Sending, and sends it only after the first server page confirms the state"; `AgentComposer.pending.test.tsx` > "waits for confirmed control, and holds a waiting message as Not sent when a terminal takes the session, sending it only on Retry" |

Gaps:
- C3 (Chinese words): `sessionNoticeWords` and `leaseNoticeLabel` with the `zh` translator are not asserted; add a unit with `translator('zh')` for each notice kind.
- C4 (precedence): no vector row has two business facts at once (for example closed and Host offline, or unavailable and read-only lease); add vector rows to `session-presentation-vectors.ts`.
- C7 (converse): the test only checks "disabled implies business fact"; the vector rows cover "business fact implies disabled" for four of the seven reasons; add rows for `other_controller` and `failed` with a pending diagnostic if missing.
- C14: no assertion that a repeat call or a new equal object gives the same result (stable output for selectors, S6 "same object when content is equal" covers the timeline only); add a unit on `composerAvailability`.
- Header drift to fix: R3 says "synchronized, the control check is over and `send_message` is allowed" but the code reads only `session.operations.send_message.allowed`; the test asserts equality with the three-part rule, which holds today because `operations` is derived in `session-state.ts`. Keep the test; reword the header.

Tests that map to no clause (candidates for deletion): none found.

## Timeline turns, process mode and work line
Module: `agent-client/src/presentation/turns.ts` (`foldTurns`), `process-mode.ts` (`workDisclosure`, `effectiveProcessMode`, `assistantProcessChoice`, `readProcessMode`), `work-summary.ts` (`workSummary`, `liveStatus`, `fileName`), `assistant-name.ts` (`assistantNames`, `assistantNameIndex`); tests: `agent-client/src/presentation/turns.test.ts` (vectors `agent-client/src/testing/turn-vectors.ts`), `process-mode.test.ts`, `work-summary.test.ts`, `assistant-name.test.ts` (vectors `assistant-name.vectors.ts`), `agent-remote-seams/tests/S6/recorded-turns.integration.test.ts`.

### Purpose
- C1. A loaded timeline folds into turns: a person's message and everything after it up to their next message. The answer is the run of assistant messages after the last work step; everything before it is work. Letters between agents stay beside the conversation. All of it is pure (replica entries and the agent's active turn only).
- C2. The process mode decides how much of a turn's work shows; the work summary and the live line say what the work is in one line each.

### Inputs and outputs
- C3. `foldTurns(entries, activeTurn, agentStatus?, pendingInteractions = 0)` returns `Turn[]` with `key`, `turnId?`, `prompt?`, `work: WorkStep[]` (kind, state, entries), `answer`, `letters`, `state: running | ended`.
- C4. `workDisclosure(mode, turn, choice?, revealed?)` returns `{ line: open | closed, steps: summary | preview }`. `workSummary(steps, t)` returns `{ text, failed, running }`; `liveStatus(name, turn, t)` returns `{ sentence, progress? }`.

### States and transitions
- C5. T-2: a person's message opens a turn; a background check's message does not (it stays in its background step).
- C6. T-3: assistant messages after the last non-background step are the answer; those before a step are `narration` steps; background activity never moves the split.
- C7. T-4: consecutive runtime notices are one `notice` step and consecutive rows of a background check are one `background` step; a letter between two notices separates them.
- C8. T-5: a step is `running` while its tool call or compaction runs, `failed` when its tool call or compaction failed or it is a notice, else `done`; each tool kind (shell, read, edit/write, search, fetch, other) is its own step kind.
- C9. T-6: only the last turn can run: when a request waits for the person, when the active turn is one of its turn ids, or, when its rows carry no turn id, when the agent is `running` or `waiting`.
- C10. T-7: rows before the first person's message of the loaded window form a turn without a prompt.
- C11. Disclosure table: Concise closed; Process open while the turn runs and closed when ended; Full open with every step at preview; the reader's toggle wins for that turn until the mode changes; a search hit opens the line at preview level.
- C12. Mode choice: the assistant's own mode, else the device default, else Concise; picking the device default stores nothing for the assistant; a stored value that is not one of `concise`, `process`, `full` reads as none.

### Limits
- C13. Work summary shows at most 3 clauses, then "and N more" (`work-summary.ts`, `all.slice(0, 3)`); one clause per kind of work in the order the turn first did it.
- C14. A single file is named by the last path segment (`fileName`); several are counted; edits that only wrote new files say "wrote"; remarks, notices and answered interactions add no clause; steps with no clause say how many steps ("N steps"); no steps is empty text.
- C15. Assistant names: 25 default names (`ASSISTANT_NAME_IDS`, `assistant-name.ts`), in English and Chinese; when all are taken further assistants are numbered ("Dango 2"). No bound on the number of turns or steps is enforced in these modules (the window size is the loaded window of the replica).

### Errors and refusals
- C16. Unknown input never throws: an unknown item type reads as a `narration` step; an unreadable stored mode reads as none; a failed background check's own steps stay visible instead of grouping into its background step; a turn the replica has not read yet (active turn id not in the loaded rows) leaves the last loaded turn ended.
- C17. A step failure is shown through `failed` (count in the summary: failed steps, a notice group as one), never as a thrown error.

### Guarantees (ordering, no loss, no doubles)
- C18. T-1: every entry appears in exactly one turn, once, in order (prompt, work, answer, letters), for every kind of row and for recorded conversations, live and re-read.
- C19. A turn's `key` is its turn id when its rows carry one and no earlier turn took it, otherwise `pos:<first entry key>`; keys are unique in a fold, so views keep identity across folds.
- C20. Names are stable: a name is picked by the FNV-1a hash of the assistant's key, so every device and both languages call the same assistant the same name, and no two assistants of an account share a name.
- C21. The live line says what the assistant is doing now (tests, command, reading/editing/writing a named file, searching, fetching, a tool, compaction, background, thinking, planning, writing a reply, working) and the progress of the latest todo ("2 of 5 done"); in Chinese in the design voice.

| Clause | Test(s) that prove it |
|---|---|
| C1 | `turns.test.ts` > "folds the every-kind conversation as a person reads it"; `TURN_VECTORS` rows T-2, T-3 |
| C2 | `work-summary.test.ts` > "workSummary", "liveStatus" tables; `process-mode.test.ts` > "workDisclosure" table |
| C3 | `turns.test.ts` > "foldTurns" vector rows (turn shapes), "is empty for an empty timeline" |
| C4 | `process-mode.test.ts` > "workDisclosure"; `work-summary.test.ts` > "counts failed steps, a notice group as one", "adds the progress of the latest todo" |
| C5 | `turns.test.ts` > "T-2: a person's message opens a turn", "T-2: a background check's message stays in its step" (vector rows) |
| C6 | `turns.test.ts` > T-3 vector rows: "remarks before a step are narration, the messages after the last step the answer", "a turn without steps is all answer", "a turn that ends in a step has no answer", "a background check after the answer leaves the answer in place", "a failed check's own steps do not move the split either", "a visible check's reply is an answer bubble" |
| C7 | `turns.test.ts` > T-4 vector rows: "consecutive notices are one step", "a letter between two notices separates them and stays in the conversation", "checks in a row are one background step" |
| C8 | `turns.test.ts` > T-5 vector rows: "a step runs, fails or is done with its tool call, compaction or notice", "each tool kind is its own step kind" |
| C9 | `turns.test.ts` > T-6 vector rows (5) and "T-6: only the last turn can run, whatever the activity says" |
| C10 | `turns.test.ts` > T-7 vector row "rows before the first message of the window are a turn without a prompt" |
| C11 | `process-mode.test.ts` > "workDisclosure" (6 base rows and 24 choice and reveal rows) |
| C12 | `process-mode.test.ts` > "the stored mode" (reads %j as %j, "takes the assistant's own mode, then the device's default, then Concise", "stores nothing for an assistant whose reader picks the default, and the choice otherwise") |
| C13 | `work-summary.test.ts` > "clauses in the order the turn did them", "more than three kinds", "summarises the every-kind turn in at most three clauses" |
| C14 | `work-summary.test.ts` > "one read names the file", "reads of several files count them", "a new file is written", "remarks and notices alone count steps", "is no line for a turn without work, and answered interactions add no clause", "names a file by the last segment of its path" |
| C15 | `assistant-name.test.ts` > "has twenty-five names, each in English and Chinese", `ASSISTANT_NAME_VECTORS` rows (numbering of a full account: depends on the rows); turn or step count bound: gap |
| C16 | `turns.test.ts` > T-6 row "a turn the replica has not read yet leaves the last loaded one ended"; T-3 row "a failed check's own steps do not move the split either"; `process-mode.test.ts` "reads %j as %j" (unreadable stored values); unknown item type to `narration`: gap |
| C17 | `work-summary.test.ts` > "counts failed steps, a notice group as one" |
| C18 | `turns.test.ts` > "T-1: every entry is in one turn, once" (all vectors), "T-1: every kind of row of a whole conversation is in one turn, once"; `agent-remote-seams/tests/S6/recorded-turns.integration.test.ts` > "every entry is in one turn, once" (recordings, live and re-read) |
| C19 | `turns.test.ts` > vector row "key: a turn is keyed by its id, a second turn of the same id and a turn without one by its first entry", and "T-1: every kind of row ..." (unique keys) |
| C20 | `assistant-name.test.ts` > "gives every assistant of an account a different name, the same in each language and order", "names one assistant among the others of its account, and alone by default", vector rows |
| C21 | `work-summary.test.ts` > "liveStatus" (12 rows), "adds the progress of the latest todo", "speaks Chinese in the design voice" |

Gaps:
- C15: no test for turns and steps at scale (a 1000-row window folds in one pass, keys unique); add a unit with a generated timeline in `turns.test.ts`, and a numbering row ("Dango 2") in `assistant-name.vectors.ts` if it is not there already.
- C16 (unknown item type): `stepKind` falling back to `narration` for an unexpected item type has no vector row; add one row to `turn-vectors.ts`.
- C19: no test that the fold of the same entries twice gives equal keys and that appending a row keeps the earlier turns' keys; add a unit to `turns.test.ts`.
- Not covered by any clause: no test shows the work line, process mode and turn fold rendered together in the Workbench (component tier); out of scope for this module, noted for the browser layer.

Tests that map to no clause (candidates for deletion): none found.

