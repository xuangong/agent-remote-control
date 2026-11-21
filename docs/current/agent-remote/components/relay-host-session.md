# Relay host-session
Module: `packages/agent-relay-core/src/host-session.ts`; tests: `core/host-session.test.ts`, `core/broker-heartbeat.test.ts`, `core/broker.test.ts`, `core/broker-state.test.ts`, `packages/agent-remote-seams/tests/S2/uplink-wire.integration.test.ts`, `packages/agent-remote-seams/tests/S2/controller-on-relay.integration.test.ts`.

| Clauses | Gaps when written | Closed by a test | Not tested, with the reason |
|---:|---:|---:|---:|
| 23 | 6 | 6 | 0 |

The header says the module owns one Host's connection: the registration handshake, the credential rotation that follows it, the heartbeat, the requests the Relay sends the Host and their answers, and how the connection ends. It writes the connection's live fields on the Host record and the timers of each connection; it saves records only through `BrokerState.commit`.

## Purpose
- C1. One Host has one live connection; the module owns its registration, credential rotation, heartbeat, `rpc` and end of connection.
- C2. It touches the world only through ports (scheduler, clock, `RelayIds`, `BrokerState`, journal service and deletion, previews, Team broker host calls, outbox, diagnostics) and saves records only through `BrokerState.commit`.

## Inputs and outputs
- C3. `register(socket, credential, context, credentialHash, grants)` takes the server end of an upgraded socket; `registered` acknowledges only the grants the Relay can serve (heartbeat interval and timeout, `control: 1`, `journal`, `outbox`, session states, and so on).
- C4. `rpc(host, method, path, sessionId?, body?)` sends `rpc_request` and resolves with the matching `rpc_response` by request id; `send`, `disconnected`, `closeAll` and `stopTimers` are the other entry points.
- C5. Messages after registration are routed by type: `rpc_response`, `stream_opened`, `stream_message`, `stream_close`, `provider_snapshot`, `preview_snapshot`, `session_states`, journal messages, `outbox_request`, `team_request`, `credential_saved`, `heartbeat_ack`.

## States and transitions
- C6. Until the Host's `register` message is committed (credential claimed and record saved), nothing else is accepted; a first message that is not a registration, an undecodable message, or a revoked or expired credential closes with 1008.
- C7. A newer registration closes the older connection (1012 `connection_replaced`) and bumps the Host's `generation`; requests that began on the older generation fail instead of being answered (`host_reconnected`).
- C8. The heartbeat starts only after registration is complete, sends a nonce every `intervalMs`, and the Host must acknowledge the current nonce within `timeoutMs`, else the connection closes (1012 `heartbeat_timeout`); acknowledgements of an old nonce do not count; a replacement connection keeps its own schedule.
- C9. Credential rotation: an invitation registering with a rotation gets a `credential_issued`, and the Host is registered once it answers `credential_saved`; a device that rotates registers at once and gets a credential only when it asks; one device credential is kept per installation.
- C10. `disconnected` ends one connection exactly once: rejects pending requests (`host_offline`), closes the Host's streams (1012, or 1008 `Host access revoked` when access ended), closes the journal connection and previews, and clears connection-only fields (session states, tunnel token, the journal and the control grant; the other grants, such as status and outbox, stay on the record until the next registration sets them).
- C11. A Host that returns with the id of a revoked Host waits for that id's journal deletion, at most `journalDeletionWaitMs` (default 5000), then registers without journals.

## Limits
- C12. Registration deadline `registrationDeadlineMs`, default 10 000 ms: no registration in time closes 1008 `Registration deadline exceeded`.
- C13. A Host holds at most 128 pending requests; the 129th is refused 429 `host_busy`.
- C14. Request deadlines: `rpcTimeoutMs` (default 30 000 ms; 45 000 for `/remote/provider-settings`), `creationTimeoutMs` 180 000 ms for `/remote/create`, 5 000 ms for diagnostic requests; at the deadline the Relay sends `rpc_cancel` and rejects 504 (`session_attach_timeout` for attach, `host_read_timeout` for GET, `host_timeout` otherwise).
- C15. Backpressure: a Host socket with `bufferedAmount` over `BROKER_MAX_FRAME_BYTES` (16 MiB) refuses sends with 503 `host_backpressure`; a slow browser stream over the same bound is closed 1013; diagnostics are not delivered while backed up or more than 16 requests are pending.
- C16. At most 128 Hosts (429 `host_capacity`) and 128 device credentials (429 `capacity_exceeded`, 1013 close for a 429).

## Errors and refusals
- C17. A request while the Host is offline fails 503 `host_offline`; unexpected, un-acknowledged messages close 1008 (`Provider management was not advertised`, `Session states were not acknowledged`, `Journals were not acknowledged`, `The outbox was not acknowledged`, `Unexpected uplink message`).
- C18. A failed save makes the state unavailable and retires the connection and its timers; a socket send failure retires the registration (1011); 401 maps to 1008, 429 to 1013, other errors to 1011.
- C19. A browser stream is not opened (and its buffered frames are not sent) until the page may use it; a `stream_message` whose session identity is invalid closes the stream 1008.

## Guarantees (ordering, no loss, no doubles)
- C20. Request answers are matched by request id; an answer on a replaced generation is never resolved, and outbox or Team answers are delivered only on the connection and generation that asked.
- C21. Every timer of a connection (registration, heartbeat, deadlines, expiry) is cleared on close, error, shutdown and revocation.
- C22. A connection whose credential expires or is revoked is retired before waiting for its pending heartbeat deadline.
- C23. Visibility (O47): a Controller that asked with `journalShown=1` on a journal connection is sent `journal_shown`, the complete set of its sessions that pages show, once it registered and at every change, which happens when the first content stream of a session starts and when the last one ends (an activity observer does not count); each shown session it does not hold on that connection is attached again. A Controller that did not ask is sent nothing (`broker.ts` `showSessions`, `journal-sessions.ts` `shown`).

| Clause | Test(s) that prove it |
|---|---|
| C1 | `host-session.test.ts` > "acknowledges the registration with the heartbeat deadlines and session control, and records the Host online", "closes the older connection of a Host that registers again, and fails what began on it" |
| C2 | `host-session.test.ts` (whole file runs on `hostSessionFixture` with a fake clock and scheduler); "host session saves records only through the state commit" > "changes no live field of the credential or the Host when the save of a registration fails", "keeps the providers of a Host live record when the save of its provider snapshot fails" |
| C3 | `host-session.test.ts` > "acknowledges the registration with the heartbeat deadlines and session control, and records the Host online", "acknowledges the outbox only when the Controller asked for it and the Relay serves one"; `broker-journal-grant.test.ts` > "is not acknowledged for a Controller that does not ask or asks for another version" |
| C4 | `host-session.test.ts` > "sends a request, matches its response by id, and refuses the 129th pending request" |
| C5 | partly: `host-session.test.ts` > "ignores a provider snapshot from a Host that did not advertise provider management, and takes one from a Host that did", "does not open a browser stream the page may no longer use, and sends what it buffered once it may"; `broker-journals.test.ts`, `journal-uplink.test.ts` for journal messages; S2 `uplink-wire.integration.test.ts` > each recorded wire scenario (register, heartbeat, rpc-attach, rpc-native-owner, outbox). "host session routing of messages after registration" > "hands a preview snapshot to the previews of that Host", "takes session states into the Host record and tells the sharing hook, once the Host asked for them", "closes the browser stream the Controller closed, with its code and reason, and forgets it", "answers a Team request on the connection that asked, with the Team broker's answer" |
| C6 | `host-session.test.ts` > "refuses a registration whose credential is gone, and a first message that is not a registration", "closes with 1008 and the reason when a registration is no longer authorized, and not with a server failure"; `broker.test.ts` > "binds a temporary credential to only one installation during concurrent registration" |
| C7 | `host-session.test.ts` > "closes the older connection of a Host that registers again, and fails what began on it"; `broker-state.test.ts` (assertHostCurrent throws `host_reconnected`, line 111); `broker-journal-sessions.test.ts` (stream outcome `host_reconnected`, line 430) |
| C8 | `host-session.test.ts` > "sends the first heartbeat only after registration, and keeps its cadence whatever the acknowledgement latency", "requires the acknowledgement of the current nonce, not of an earlier one", "marks a silent Host offline and rejects its pending requests before the socket reports a close", "keeps the heartbeat of a replacement connection apart from the callbacks and close of the old one"; `broker-heartbeat.test.ts` > "starts after enrollment is saved and preserves the schedule across device credential rotation" |
| C9 | `host-session.test.ts` > "issues a device credential after an invitation registers with a rotation, and registers the Host once the Controller saved it", "registers a device that rotates at once and issues no credential before it asks", "keeps one device credential per installation when a device registers, and no other installation loses its key" |
| C10 | `host-session.test.ts` > "closes the browser streams of a Host that disconnects, and clears them and their opening deadlines", "closes streams with the revoked wording when the Host's access ended", "marks a silent Host offline and rejects its pending requests before the socket reports a close"; `broker-heartbeat.test.ts` > "closes virtual browser streams and clears their opening deadline when the Host heartbeat expires"; `host-session.test.ts` > "host session ending releases what the connection held" > "closes the journal connection and the previews once, and clears the fields only a connection holds" |
| C11 | `host-session.test.ts` > "host session registration with a journal deletion pending" > "waits for the deletion of its own id for at most 5000 ms, then registers without journals and leaves the id pending" (4,999 and 5,000 ms), "registers with journals as soon as the deletion ends, before the deadline" |
| C12 | `host-session.test.ts` > "closes a connection that sends no registration within the deadline, and leaves one that registered in time" (50 ms in the test); the default: "host session registration deadline default" > "closes a connection with no registration after 10 000 ms and not before" |
| C13 | `host-session.test.ts` > "sends a request, matches its response by id, and refuses the 129th pending request" |
| C14 | `host-session.test.ts` > "times out an attach with its own wording after telling the Controller to cancel"; "host session request deadlines" > "%s is cancelled and rejected 504 at its deadline, not a millisecond before" (a read 30 000 ms `host_read_timeout`, another method 30 000 ms, provider settings 45 000 ms and a creation 180 000 ms `host_timeout`, a diagnostic request 5 000 ms) |
| C15 | `host-session.test.ts` > "refuses a request while the Host is offline or its output is backed up", "refuses diagnostic delivery while the connection is backed up, without asking the Controller"; `broker-heartbeat.test.ts` > "defers diagnostic capability probing while the Host has buffered business traffic", "defers diagnostics when business requests accumulate %s the capability probe". The slow browser stream: "host session browser streams through the Relay" > "closes a slow browser stream 1013 above 16 MiB of buffered output, and keeps one at the bound" |
| C16 | `host-session.test.ts` > "refuses a new device credential at 128 and issues one at 127"; "host session capacity and the close codes of a failed message" > "refuses the 129th Host with 429 and the close code 1013, and registers the 128th and a Host it already knows" |
| C17 | `host-session.test.ts` > "refuses a request while the Host is offline or its output is backed up", "ignores a provider snapshot from a Host that did not advertise provider management, and takes one from a Host that did" (1008 reason); "host session messages from a Host that did not ask for what it sends" > "closes with 1008 on %s" (session states, a journal message, an outbox request, a message only the Relay sends) |
| C18 | `host-session.test.ts` > "retires the connection and its timers when a save fails and the state becomes unavailable", "retires the registration when the socket reports a synchronous send %s"; `broker-heartbeat.test.ts` > "clears outstanding heartbeats when durable storage fails before a close event"; `host-session.test.ts` > "closes a message that failed with status: %s" (401 to 1008, 429 to 1013, another status and none to 1011) |
| C19 | `host-session.test.ts` > "does not open a browser stream the page may no longer use, and sends what it buffered once it may"; "host session browser streams through the Relay" > "closes a stream 1008 when a frame names another session than its own, and sends nothing of it" |
| C20 | `host-session.test.ts` > "delivers an outbox answer only on the connection and generation that asked", "sends a request, matches its response by id, and refuses the 129th pending request" (unrelated id ignored in "marks a silent Host offline..."); a response on a replaced generation rejected: "closes the older connection of a Host that registers again, and fails what began on it" |
| C21 | `host-session.test.ts` > "clears the heartbeat timers on %s" (close, error, close all), "closes the browser streams of a Host that disconnects, and clears them and their opening deadlines"; `broker-heartbeat.test.ts` > "clears heartbeat timers on %s", "clears outstanding heartbeats when the device is revoked" |
| C22 | `host-session.test.ts` > "retires a device whose credential expires before waiting for its pending heartbeat deadline" |
| C23 | `broker-journal-shown.test.ts` > "tells a Controller that asked which sessions pages show: none at registration, then each change as pages open and close", "does not count a page that only observes activity", "tells a Controller that did not ask nothing, so a Controller from before visibility keeps its connection", "attaches a shown session again on the Controller that replaced the one holding it, so it stays resident"; `journal-sessions.test.ts` > "the sessions pages show" (3 tests); S2 `session-residency.integration.test.ts` |

Gaps: none. Closed 2026-11-21: C11, C17 with C5's routing, C14's other deadlines, C15 and C19 on the `stream_message` path, C10,
C16, C2, and the inline gaps of C12 (the default) and C18 (the close-code mapping). C10's text was corrected: a disconnect clears the
control grant, not every grant.

Tests that map to no clause: none found; `broker-heartbeat.test.ts` > "retains exact server heartbeat cause and startup/connection identity for later Host delivery" covers diagnostics content, not a clause of this module's contract.

## Gaps closed

Closed on 2026-11-21. The clause table above names each test by its title; this table names the file and the mutations of the rule that the test fails on (each was applied, run and reverted).

| Component, clause | Test file | Mutation caught |
|---|---|---|
| Host-session C2 | `host-session.test.ts` | the credential's installation, or the Host's providers, assigned before the commit |
| Host-session C5 (routing) | `host-session.test.ts` | each handler call removed (previews, session states, stream close, Team) |
| Host-session C10 | `host-session.test.ts` | the journal close, the previews' disconnect, each field clear removed |
| Host-session C11 | `host-session.test.ts` | the deletion wait 4,000 and 6,000 ms |
| Host-session C12 (default) | `host-session.test.ts` | 9,000 ms |
| Host-session C14 | `host-session.test.ts` | each deadline 1,000 ms shorter; `host_read_timeout` merged into `host_timeout` |
| Host-session C15, C19 (`stream_message`) | `host-session.test.ts` | the buffered bound one byte lower; 1013 and 1008 replaced |
| Host-session C16, C18 | `host-session.test.ts` | `>= 128` as `> 128`; each close code of the 401, 429 and other mapping |
| Host-session C17 | `host-session.test.ts` | each acknowledgement guard disabled; a reason shortened |
