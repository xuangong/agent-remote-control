# S5: Relay-owned session control

**State: planned, awaiting owner approval. Nothing in this plan is implemented.** S5 changes the contract between the Relay and every Controller, so the owner approves it first (roadmap S5; [design, Compatibility and rollout](../specs/2026-11-15-im-session-service-design.md); [assessment, Lever B](../specs/2026-11-16-journal-simplification.md)).

S5 is the first slice of P2. It moves the session-control lease and the native-owner fact to the Relay, and it removes the five shims that P1-B2 built so that the Relay could imitate the Controller's session wire: the pending revision, held acquires, the offline-Host amendment, `hostReturned` and the `restoring` override. The operation queue itself (requesters, receipts, preconditions, the outbox, Team and TPM queues) stays in S6.

## 1. For the owner: approve in one read

**What changes for you.** A browser asks the Relay for control and gets the answer at once, whether the Controller is online, offline or just coming back. Today a journal-served view waits for a Controller stream to learn its control state, shows "Restoring" while it opens, and closes and reconnects when a Host returns. After S5 none of that happens: reading and control never need the Controller. The Controller is contacted only when something is sent, and it still decides everything that depends on the native runtime (a terminal in control, provider capabilities).

**What you must do: update every Controller.** The Controller gains one negotiated capability. A Controller that is not updated keeps working through the old path until the window ends (section 5). After the window, the next release deletes the old path, and a Controller that was not updated can still register, appear in the Hosts list and be updated from the website, but it cannot open sessions.

**The session protocol stays at 1.8.0.** No bridge release and no multi-hop update (the runbook's intermediate releases) is needed. Any Controller that runs 1.8.0 updates in one step. The change is an opt-in uplink capability, as for outbox, journal and Team recipients.

**Deploy order** (section 5.4): publish the Controller release; deploy the Relay and website (the `primary` Worker; the journal partitions Worker is untouched); ask you to update every Controller from the Hosts page; you confirm; the next release removes the old path. Nothing here needs two Workers to be deployed in a given order.

**Risks, in order of weight.**
1. The change also routes ordinary (crude) sessions through the Relay's control gate, so every updated Controller is affected, not only journal-served sessions. Journal-served sessions exist only where you turned smart reading on, which is off by default. Mitigation: an updated Controller falls back to the old path against a Relay that does not acknowledge the capability, and an operator switch on the Relay stops the acknowledgement (deleted with the old path).
2. A terminal that already owns a session the Controller has not opened is learned by the Relay only when the first send is refused. The composer then turns read-only, the draft stays, and take-over works. P1-C3's read-only observation closes this gap later.
3. A Controller that is updated but whose uplink drops while a send is in flight ends that stream, as today; the client's uncertain-send handling is unchanged.

**Decisions only you can make** (section 11): the length of the window, and what to do with machines that cannot be updated.

## 2. How control works today, and why

| Piece | Where | What it does | Why it exists |
|---|---|---|---|
| Lease registry | `agent-remote-relay/src/session-control.ts` (99 lines), attached per stream in `session-wire.ts:216-230`, checked by `assertControl` before every mutation (`session-wire.ts:258`) | One lease per Controller stream: a random `revision`, a `token` after `acquire`, `access: control or read_only`. Grants are connection-local and not exclusive: every authorized page can hold control at once. A native-owner change clears every token and changes every revision. The `resumeToken`, `retainOnDisconnect`, `clientKind` and `ownerKind` fields are accepted and ignored; `take_over` behaves as `acquire`. | The Controller was the only place that knew about the session. |
| Native owner | `agent-host/src/host.ts:654` (a terminal takes the session: `setNativeOwner`, then `closeAgent` for the whole family), `host.ts:1004` (the Controller attaches: owner cleared); `native-owner-admission.ts` and the directory leases decide who owns | The owner (`native_cli` or `controller`, with a `generation`) lives in the Controller. At open, a terminal-owned session refuses with `native_session_owned` and the owner. A take-over is an HTTP `attach` with the owner's generation: the Controller interrupts the terminal and attaches. | Native runtime interpretation belongs to adapters. |
| Take-over from the page | `remote-session-client.ts:272-330`, `App.tsx:390` (`resumeNative`) | The client calls attach with the owner's generation, waits until `session_control` shows no owner, then sends `acquire` with the new revision. | One state machine in the client; the Controller executes the interruption. |
| Pending revision `relay-pending` | `journal-session-stream.ts:12,286` | A journal-served stream shows this revision and `read_only, available: false` at open. | The client sends `acquire` on its first `session_control`, before any Controller stream exists. |
| Held acquires | `heldControl`, `flushControl`, `controlRevision` (`:135,139,375`) | An `acquire` naming the pending revision waits, is rewritten to the Controller's real revision once the Controller reports one, then forwarded. | Same reason: the revision belongs to the Controller. |
| Offline-Host amendment | `waitingForHost`, error branch of `ensureHost` (`:322-346`), `hostReturned` in the stream, `journal-sessions.ts:57,178`, `broker.ts:902` | If the Controller stream cannot open because the Host is offline, the acquire is answered `read_only, available: false` (with the native owner when the refusal names one), and when the Host registers again every waiting stream closes with 1012 so its client reconnects and acquires. | Otherwise the client would sit read-only for ever, or retry every 20 seconds. |
| `restoring` override | `snapshotPayload` (`:197`), `hostIsReady` (`:350`) | Until the Controller stream is ready, every Snapshot says `runtimeInfo.connection: restoring`; when it is ready, one `agent_update` follows. | Composers treat `native_runtime_restoring` as "cannot send" (`sessionOperationAvailability`), which kept them from sending into a stream that was not open. |
| Refusal classes | `ensureHost` error branch | 429 closes the browser with 4029; a 4xx other than 408 leaves the stream reading; `host_offline` waits; anything else refuses the held messages. | Four outcomes of one background open. |
| Control windows and operations endpoints | `window-routes.ts`, `window-workspaces.ts`, `gateway.ts:749` | Window layout: `POST windows/:id/operations`, `GET windows/:id/operations/:id`, long-poll `GET windows/:id/changes`. | They are not session control. They store where views sit. They share the HTTP rate limit (section 9). |

The journal-served path is where all five shims live. Journal-served streams exist only for a Host and provider whose smart-reading switch is on (default off) and only for a session with a journal head. Crude streams are a pass-through: the browser's frames go to the Controller's session wire, which owns the lease.

## 3. Target model

### 3.1 Who owns what

| Fact or decision | Owner after S5 | Notes |
|---|---|---|
| Lease: revision, token, `access`, `available` for each browser stream | **Relay** | One class, the existing `SessionControlRegistry`, used by the hosted Relay as the Controller's wire uses it today. No Controller round trip. |
| Who may hold control (account, share permission, expiry, revocation) | Relay | The same `sessionAllowed` and message-admission rules that already guard every request. A read-only share recipient gets `read_only`. |
| Whether a session is in a terminal's hands (`nativeOwner`) | **Controller decides, Relay holds the last report** | The Controller detects and reports it (`session_owners`, 3.3). The Relay revokes the leases of that session and answers `read_only` with the owner. |
| The check at delivery that no terminal owns the session | Controller | A mutation that raced an owner change is refused `native_session_owned` and never reaches the native runtime. This replaces the token check, which was the only per-mutation check the Controller made for control. |
| Provider capability, operation cache, succession admission, recent sign-in rules, a session answering its own request | Controller (unchanged) | Native and policy facts stay with the adapters and the Host. |
| Take-over mechanics (interrupt the terminal, attach) | Controller | The Relay shows it as the owner field disappearing. |
| Runtime connection state (`reconnecting`, `restoring`, `unavailable`) | Adapters, through the Controller | The Relay never writes this field again. |

Invariants:
- **I1.** For a Host that acknowledged the capability, lease state exists only in the Relay.
- **I2.** A mutation reaches a Controller only from a stream with a live control lease, and the Controller still refuses it if a terminal owns the session.
- **I3.** The Relay synthesizes no runtime state.
- **I4.** Reading and control never open a Controller stream. Only a mutation, a command, an interaction answer or an upload does, and the stream stays open until the browser leaves.

### 3.2 Flows

**Host online.** The browser opens the session socket. The Relay answers `negotiated` with `sessionControl: true`, the Snapshot (journal head, or the Controller's Snapshot on a crude stream) and a `session_control` frame, read-only and `available: true` unless a terminal is known to own the session. The client sends `acquire`; the Relay grants a token in the same round trip. The page can send. The first mutation opens a Controller stream, wakes the session if it was released (`recoverForJournalStream`), and is held (at most 32 messages and 1 MiB, as today) until the stream is ready. Journal-served views hold no Controller stream until then.

**Host offline.** The same, with no change in what the Relay answers: the lease is granted. The offline fact reaches the page as a Host fact (the Hosts list and feeds, which the composer's "Send when the Host is back" path already uses); it is not a control state. A mutation that needs the Controller is refused at once with the recoverable `host_offline`, and the stream stays open and keeps reading. Nothing waits and nothing is amended.

**Host returning.** The stream was never tied to the Controller, so nothing closes and nothing is reopened. The next mutation opens a Controller stream normally. A stream that already had a Controller stream open when the Host went away ends as it does today (the Controller stream's end closes the browser stream); the client's reconnect and uncertain-send handling is unchanged, and the new stream gets a new lease.

**A terminal drives the session.**
- *The Controller holds the session when the terminal takes it:* the Controller reports the owner, the Relay revokes every lease of the session (new revisions, no tokens) and sends each stream a `session_control` with `read_only` and the owner. The page shows "Native CLI has control". A mutation already in flight is refused at the Controller's delivery check.
- *The Controller does not hold it:* the Relay does not know yet. The first send is refused `native_session_owned` with the owner; the Relay records the owner and updates every stream of that session as above. The composer turns read-only, the draft stays. P1-C3's read-only observation (journal presence) will make this known earlier.

**Take-over.** The client's existing flow is unchanged: HTTP `attach` with the owner's generation, then wait until the owner is gone, then `acquire`. The Controller clears the owner on attach and reports it before it answers the `attach` RPC; the Relay receives both on one ordered uplink, so the owner is cleared in the Relay before the page sees the RPC result. The new revision comes with the `session_control` the Relay sends when the owner clears, and `acquire` with it is granted.

### 3.3 The contract

Two additions, both opt-in and both on the Host uplink. No change to the browser-facing session protocol (1.8.0) or to `REMOTE_HOST_UPLINK_VERSION` (2).

1. **Capability `control`.** The Controller offers `control=1` in its uplink URL; the Relay acknowledges `control: 1` in `registered` only for that offer (the Team-recipient pattern in the runbook). The acknowledgement is per connection, never stored.
   - With the acknowledgement: the Relay owns the leases of every stream of that Host, crude and journal-served. The Controller's uplink streams attach no lease, ignore `controlToken`, and run the native-owner check at delivery.
   - Without it (an old Controller, or an old or switched-off Relay): both sides behave exactly as today.
2. **Uplink message `session_owners`** (Controller to Relay, only after the acknowledgement): `{ full, owners: [{ providerId, nativeSessionId, nativeOwner }], removed }`, bounded to 1024 entries. It has the shape of `session_states`: a full report replaces what the Relay held for that Host; a delta changes and removes the listed ones. The Controller sends a full report right after `registered` and a delta whenever it changes an owner (`host.ts:654,1004`). A full report on every connection is what makes stale owners impossible after a Controller restart, with no separate clearing rule.

Rule 5 (protocol surface): `session_owners` adds one message and replaces none. It cannot replace the stream refusal or the head, because the first needs a Controller stream and the second needs a journal and a published head, and the owner changes while neither exists. In exchange the Relay stops forwarding `session_control` frames, which is a behaviour change with no schema change.

Wire fields that become dead (`resumeToken`, `retainOnDisconnect`, `clientKind`, `ownerKind`, the `take_over` action) stay in the schema until the next session-protocol bump, because removing a schema field is a bump and the runbook's staged release. Clients stop sending them in S5. They are listed in section 8.

The `token` and `controlToken` stay: the Relay issues and checks them per stream, so unchanged clients (cached pages, the command line, ARDB, an older `RemoteSessionClient`) work. Removing them also waits for the bump.

### 3.4 What the Relay and the Controller each get

**Relay (`agent-remote-hosted`).**
- `stream-control.ts` (new): a gate used by both accept paths. Inputs: a `SessionControlRegistry` per Relay, the stream's authorization, the Host's acknowledgement. Behaviour: answers `session_control_request` itself (the existing registry semantics, stale revision gives `session_control_changed`, a native owner gives `native_session_owned`); checks a mutation's token before it is forwarded; on a Controller-to-browser frame, drops any `session_control` and adds `sessionControl: true` to `negotiated`; emits the lease state after `negotiated`.
- The owners map: Host and native session to owner, at most 1024 per Host, replaced by a full report, applied to every binding of the native session (the same family rule as `nativeFamily`).
- `journal-session-stream.ts` loses the five shims (section 4) and opens the Controller stream lazily.
- `registered` carries `control: 1` when offered; the Hosts list carries `control` so the page and the owner can see which Controllers are updated.
- The smart-reading switch, and the journal gate (`serves`), require `control` on the Host. A Host without it is served crude, and the switch shows the existing "Update the Controller" message.

**Controller (`agent-host`, `agent-remote-relay`).**
- The uplink client offers `control=1` and records the acknowledgement.
- `remote-host-plugin` passes no `sessionControls` to the session wire of an acknowledged connection; the wire's per-mutation control check becomes the native-owner check (`native_session_owned`). Direct-serve transports (the lab server, DSH shared web, `websocket-stream`) are their own Relay and keep the registry unchanged.
- The registry reports owner changes it receives (`setNativeOwner`) to the uplink as `session_owners`.

**Client (`agent-remote-web`, `agent-remote-lab`).** No behaviour change is required. It stops sending the dead fields, always sends `acquire`, and loses the `controlProofs` and `resumeToken` handling and the never-sent `ownerKind` string. It still waits for `session_control` with no owner after a take-over.

## 4. Removed, replaced, and the state accounting

Rule 1: every row states the change. Line counts are judged from reading, not measured; Task 9 records the measured numbers.

| Removed | Replaced by | State and paths |
|---|---|---|
| Pending revision `relay-pending` and the first `read_only, available: false` frame | The Relay's own lease state, emitted after `negotiated` | constant -1 |
| Held acquires: `heldControl`, `flushControl`, `controlRevision`, the revision rewrite | `acquire` answered by the gate at once | fields -2, function -1, recovery path -1 |
| Offline-Host amendment: `waitingForHost`, the `session_control` answer in `ensureHost`'s error branch | A mutation is refused with `host_offline`; control is a Relay fact | field -1, path -1 |
| `hostReturned` (stream, `JournalSessions`, broker call) and the 1012 close | Nothing: a stream never waits for the Host | methods -3, path -1 |
| `restoring` override, `hostReady`, `RESTORING_REASON`, the `agent_update` on ready (`hostIsReady`) | Nothing: the Relay never writes runtime state (I3) | field -1, constant -1, path -1 |
| Refusal classes in `ensureHost` (429 close with 4029, hopeless 4xx, offline wait, other) and `CAPACITY_CLOSE_REASON` | One rule: refuse the held messages with the refusal's code; the browser stream stays | paths 4 to 1 |
| The eager Controller stream at negotiation | Lazy open on the first mutation (I4) | Controller streams held by journal-served views: one per view to zero |
| Controller-issued leases on uplink streams of acknowledged Hosts | The Relay's registry | Controller state per stream -1 lease |
| Client: `controlProofs`, `resumeControlToken`, `retainControlOnDisconnect`, `clientKind` sending, the `take_over` action, `ownerKind` display, `resumeToken` redaction (transport, ARDB) | Always `acquire`; no resume proof | client fields -5 |

Added: one uplink capability, one uplink message (`session_owners`), one Hosts-list field (`control`), the Relay's owners map (at most 1024 per Host, replaced by a full report), one registry instance, one gate module, one lease handle per stream, and a temporary operator switch (see 5.1). Each is named in section 3 and replaces the Controller round trip they make unnecessary.

**Budgets (rule 3).**
- `createJournalSessionStream` mutable fields: 19 today (phase, activityOnly, keyed, subscribed, hostReady, stale, hostState, hostStream, waitingForHost, controlRevision, held, heldControl, queued, activitySnapshot, activityCursor, lastActivity, lastStatus, lastActivityCursor, activityTimer). After: at most 16 (minus hostReady, waitingForHost, controlRevision and heldControl; plus the lease handle).
- Its recovery and refusal paths: 7 (429 close, hopeless 4xx, offline wait, other refusal, `hostReturned` close, held-control rewrite, `restoring` to ready update) to at most 2: refuse held messages with the refusal; the Controller stream ended, so close as `hostEnded` does today.
- `journal-session-stream.ts` ends shorter than its 530 lines today.
- Production lines in `packages/` over the whole step (R1 and R2), tests excluded: net negative. At R1 alone: at most zero net. Tests fall by about 600 lines (the control parts of `journal-session-stream.test.ts` 563, `-amendments` 179, `broker-journal-sessions.test.ts` 401, and the control emulation in `test-utils/journal-session-fixture.ts`) and rise by the new suites; the plan only requires that the removed behaviour has no test left that asserts it.
- No new rate limit, pool, timer or cache. Bounded structures cite their cap: 1024 owners per Host (a Host reports at most `SESSION_STATE_LIMIT` = 4096 session states; owners are a small subset), 32 held messages and 1 MiB (unchanged).

## 5. Version, upgrade order and compatibility window

### 5.1 The change in one paragraph

No session protocol bump (1.8.0 stays; `ProtocolVersionSchema` unchanged; no intermediate Controller releases). One negotiated capability, `control=1` offered by the Controller and acknowledged by the Relay, and one uplink message, `session_owners`. The uplink version stays 2. Fixtures, schemas, the uplink decoder and `compatibility.json` are updated together (`pnpm compatibility:update`, then `pnpm compatibility:check`). The Relay gets a temporary operator switch for rollback: by default it acknowledges `control`; when the switch is set it does not, so every Controller behaves as today. It is deleted in R2.

### 5.2 Who talks to whom during the window

| Pair | Result |
|---|---|
| Old Controller, new Relay (R1) | Registration, heartbeat, Hosts list and Controller update work as before. The Relay sees no offer and does not acknowledge. Crude sessions run exactly as today: the pass-through code is untouched and the Controller issues the leases. Journal-served reading is not offered for that Host: the journal gate requires `control`, so its sessions are served crude, and the smart-reading switch shows "Update the Controller". The five shims are gone from the Relay for every Host, because only acknowledged Hosts can be journal-served. |
| New Controller, old Relay | The Relay does not acknowledge. The Controller attaches leases and checks tokens as today, sends no `session_owners`, and behaves as before. Verified by a test, not assumed. |
| New Controller, new Relay | Relay-owned control, for crude and journal-served streams. |
| New Controller, Relay with the operator switch set | As "old Relay", per connection. A Relay rollback needs no Controller change. |
| Mixed Hosts on one Relay | Per Host: the acknowledgement is stored on the Host's connection state and never persisted. |

### 5.3 Is a window with both paths needed, and how short?

Yes, and only on the Relay's crude pass-through and the Controller's uplink-stream branch. Both are the code that exists today; the window adds no new code for old Controllers. It lasts from the R1 deployment until the owner confirms every Controller shows `control` in the Hosts list (the owner reads the same field the website shows). The window can be a few days: an update is one step, with no bridge, because the session protocol is unchanged. The owner sets the date (section 11); this plan proposes seven days after the R1 deployment.

Old paths are deleted in R2, a separate release after the owner confirms (design rule, runbook phase 2):
- The Relay refuses a stream of a Host without `control` with 409 `controller_upgrade_required` and the "Update the Controller" message, and stops forwarding session-control frames. Registration and management stay.
- The Controller's uplink streams stop attaching leases. A Controller whose `registered` has no `control` acknowledges nothing and serves no sessions on that connection, shows "Update the Relay", and keeps management.
- The operator switch and the client's dead-field handling that survived for old pages are deleted.
- The Hosts-list field stays one more release, then goes.

### 5.4 Cloudflare and deploy order

Control state is per connection and in memory in the `primary` Durable Object, which already owns every socket. S5 changes nothing the journal partitions Worker (`agent-remote-control-journals`) or the RPC contract between them (`journal-partition.contract.json`) sees, so no cross-Worker ordering is introduced. If a deployment has journals enabled, the standing rule applies and is a no-op here: partitions Worker first, then `primary`.

Order (the runbook's phase 1, steps 5 to 8):
1. Build from a clean reviewed commit; publish the Controller release (tag, manifest, tarball checksum) and verify the public bytes. The release's declared session protocol is 1.8.0, so the website offers it as an ordinary update to every Controller on 1.8.0.
2. Deploy the `primary` Worker and the website together. The Relay acknowledges `control`; old Controllers keep working.
3. Tell the owner: update every Controller (Hosts page, "Update Host" for each). The owner confirms each as it reconnects; the Hosts list shows `control` for it. Offline machines are not retired because they are offline.
4. After the owner confirms, R2 ships on the same order (Controller first, then the Relay). A Controller that is not updated by then keeps management and shows the reason.

Rollback: set the operator switch or redeploy the previous Relay; updated Controllers fall back per connection with no loss. A Controller rollback needs nothing on the Relay.

## 6. Acceptance tests, over real transports

Each test runs a real hosted Relay in process (the existing broker with real WebSocket upgrades), a real Controller uplink client and `agent-host` with a fake provider, and a real `RemoteSessionClient` over a real WebSocket, with the repository's per-test and outer deadlines. They assert observable frames and provider calls, not source text. A "Controller stream" is counted on the uplink as `stream_open`.

**A. Host online.**
- Journal-served and crude, new Controller: `acquire` is granted with no Controller frame sent (zero `stream_open`); the page reaches control with the Controller's uplink silent. A `send_message` then opens one Controller stream, is delivered once, and its echo reaches the page. Zero frames contain `restoring` that the provider did not report. `negotiated` carries `sessionControl: true`; `session_control` follows it.
- Stale revision gives `session_control_changed`; a mutation without a live token is refused at the Relay and never appears on the uplink; a forged or old `controlToken` is refused.
- Two pages on one session both hold control; revoking one does not change the other.

**B. Host offline.**
- Page open on a journal-served session, Host disconnected: control is granted, reads continue, `send_message` is refused `host_offline` (recoverable), the stream stays open, no 1012 closes it, the draft is kept, the composer's "send when back" path is the offered action.
- Page opened while the Host is offline: reads served from the journal; control granted.

**C. Host returning.**
- Idle page, Host disconnects and registers again: the browser socket is never closed (assert zero close frames), no `Reconnecting`, `Restoring` or `Checking access` frame or label appears, and the next send opens a Controller stream and is delivered.
- Page with a Controller stream open when the uplink drops: the browser stream ends as today, the client reconnects, gets a new lease, and a send that was in flight follows the client's existing uncertain-send path (no resend by the Relay).

**D. A terminal drives the session (native owner).**
- The Controller holds the session; a terminal takes it: owner reported, every stream of the session gets `read_only` plus the owner within one frame, tokens revoked; a mutation sent at that moment is refused `native_session_owned` and the provider receives zero native calls.
- The Controller does not hold the session: the first send is refused `native_session_owned` with the owner; the Relay then updates all streams of that session; the draft stays.
- Take-over: HTTP `attach` with the owner's generation; the owner is cleared in the Relay before the page sees the RPC result (ordering asserted on the uplink); the page gets `session_control` without the owner, a new revision, and `acquire` is granted; the first message after take-over is delivered.
- Take-over with a stale generation: `native_owner_changed`, state unchanged.
- Controller restart: its full `session_owners` report replaces the Relay's owners for the Host; a stale owner is gone without any clearing rule.
- Family case: an owner reported for a native session applies to every binding of it.

**E. Reconnects.**
- Browser socket drops and returns: a new lease, the old token is invalid, reads resume from the cursor.
- Relay restart in process: Controllers register again, send the full owner report, pages reconnect and acquire; no stale lease survives.
- Control-message and capacity limits: a view that never sends occupies no Controller stream (the Host's and the account's stream counts do not change when journal-served views open); a send refused for capacity (429) refuses that message only, and does not close the browser stream.

**F. Authorization.**
- A read-only share recipient: `acquire` returns `read_only`, mutations are refused at the Relay, nothing reaches the uplink. The gate applies the same rule as the Relay's existing message admission; the test proves `session_control_request` is covered by it.
- A revoked or expired session ends the socket and the lease with it.

**G. Compatibility matrix** (section 5.2), including the old Controller built from the commit before S5 in a temporary worktree and run against the new Relay on a free port, and the new Controller against a Relay build before S5. Each row shows a send, a take-over and a reconnect. The existing crude and journal suites run unchanged for old Controllers: they must pass without edits.

**H. Management.** Old and new Controllers register, heartbeat, appear in the Hosts list (with `control` set for new ones) and accept a Controller update request on the new Relay (the runbook's "Old Controller, new Relay" row).

**I. Contract.** Schema and fixture tests for the capability offer and the acknowledgement, and for `session_owners` (full, delta, bounds, rejection before the acknowledgement); replay fixtures and `pnpm compatibility:check`.

## 7. Measurement on `pnpm local` (T4 and T5, the part S5 can claim)

T4 and T5 are completed in S6 with the queue. S5 owns the blockers that came from the Relay's own shims. The runner is `packages/agent-remote-lab/performance/local-baselines.mjs` with the latency proxy, at 1x, 4x CPU, 100 ms round trip and both, as in S4b; the control arm is this branch before S5, on this checkout's instance, journals on for Copilot (the S3 setup). The instance and its Controller come from `pnpm local up` (`.agents/skills/prepare-arc-local/SKILL.md`), with free ports.

| Counted condition (deterministic) | Target | Control |
|---|---|---|
| Journal-served open: labels `Restoring` and `Checking access` (30 opens, plus a Controller restart and a Host offline and return) | 0 | today's counts recorded |
| Journal-served open: Controller streams held by the view before the first send | 0 | 1 |
| Time from the socket's `negotiated` to the composer accepting a send (control granted) | one Relay round trip; no Controller frame in between | recorded |
| Host returns while a view is open: socket closes, label cycles | 0, 0 | recorded |
| A send with the Controller stream not yet open: "sending" shown | within 100 ms at 4x CPU | recorded |
| The same send accepted by the Controller, resident session | within 1 s p95 at 100 ms and 4x CPU; the measured stream-open time is reported separately | recorded |

Clock figures use the runner only, never the unit suites. The runner also takes the S4b `open-fresh` fix (section 9) so that its fresh opens are paced and the 429 does not hide the measurement. Results go into this plan's section 12 and the roadmap.

## 8. Deferred removals (written down, not done in S5)

These wait for the next session-protocol bump, which needs the runbook's staged release:
- Schema fields `resumeToken`, `retainOnDisconnect`, `clientKind` (request); `ownerKind` (state); the `take_over` action value.
- `token` in `session_control` and `controlToken` on mutations, once no client needs them (the Relay knows each stream's lease and the token is redundant).
- The Controller's `SessionControlRegistry` lease code, if the direct-serve transports are given a Relay-side registry; until then it is the lease owner of a process that is its own Relay.

## 9. The 429 control-request limit seen in S4b

**What it is.** The limit is `gateway.ts:741`: 60 non-GET HTTP requests per minute per account (`mutation:<subject>`), shared by every route. Rapidly opening fresh sessions registers a window each time (`POST windows/:id/operations`) and also posts the open itself, so about 20 to 30 fresh opens a minute exhaust it. The 404s on `GET windows/:id/operations/:id` and the 10 second `GET windows/:id/changes` polls are window routes. None of them is session control.

**Does S5 change it? No.** Session control travels on the session WebSocket (`session_control_request`), where it is already outside this limit, and S5 puts the acquire on that same path and adds no HTTP request. The per-stream message limit (`admitClientMessages`: 120 control messages and 600 timeline requests per minute) is unchanged.

**What S5 changes nearby.** The Controller-stream capacity refusals (`HOST_STREAM_LIMIT`, `USER_STREAM_LIMIT`, close code 4029) are a different 429. Journal-served views no longer hold a Controller stream until they send, so those refusals stop for them; the stream-preemption note in the roadmap (preemption cannot free a slot from a view that holds none) is partly met for journal-served views, and P3 finishes it.

**Decision.** Keep the limit. A person cannot open 60 sessions in a minute, and a layout write is a real write. The queue (S6) must not submit operations by HTTP on this bucket: operations go over the session socket, or get a bucket of their own like drafts and reads. The runner is fixed instead (Task 8): it spaces fresh opens by more than the refill interval, and reads a 429 as a pause, not as a hang. Window registration at every open is a separate question for the window workspace, recorded here and not decided in S5.

## 10. Tasks

Each task ends with its tests passing and, from Task 3 on, the existing suites unchanged and green. Run `pnpm compatibility:update` and then `pnpm compatibility:check` after Task 5. Work in the worktree `.worktrees/im-session-service`; use free ports; keep existing local services.

1. **Contract.** `control` offer and acknowledgement (URL query, `registered`); `session_owners` in the uplink schema with decoder, fixtures, replay and bounds; the `control` field in the Hosts list. Tests: schema, decoder, replay (section 6 I). State: +1 capability, +1 message, +1 list field.
2. **The gate and the owners map (Relay).** `stream-control.ts` over `SessionControlRegistry`; the owners map with full and delta reports and family application; revocation and `session_control` fan-out. Unit tests with fakes, then the real-transport suites A and D against a scripted Controller.
3. **Journal-served stream.** Use the gate; open the Controller stream lazily; one refusal rule; drop the five shims and the eager open; remove `hostReturned` through `JournalSessions` and the broker; require `control` in the journal gate and the smart-reading switch. Tests: A, B, C, E; delete the tests that assert removed behaviour.
4. **Crude path.** The same gate in the pass-through for acknowledged Hosts (`negotiated` rewrite, drop of Controller `session_control`, token check before forwarding); unacknowledged Hosts keep today's pass-through untouched. Tests: A and D for crude; G for the legacy rows with the pre-S5 Controller.
5. **Controller.** Offer `control=1`; no lease on uplink streams after the acknowledgement; the native-owner check at delivery replaces the token check; `session_owners` full and delta; legacy branch kept. Tests: D with a real fake provider (zero native calls on a raced mutation), G.
6. **Client.** Stop sending the dead fields; always `acquire`; remove `controlProofs`, `resumeControlToken`, `retainControlOnDisconnect`, the `ownerKind` string and the `resumeToken` redactions; show "Update the Controller" for a Host without `control` where smart reading is requested. Tests: web and lab suites; the same client suite runs against crude and journal-served Hosts.
7. **Acceptance and compatibility suite.** Sections 6 F, G, H over real transports, including the pre-S5 Controller and Relay builds.
8. **Measurement.** `pnpm local up`; the runner's S4b pacing fix; section 7 at 1x, 4x CPU, 100 ms and both against the control arm; record results.
9. **Deletion task (rule 7).** Delete what Tasks 3 to 6 made unnecessary, and record the measured accounting: `PENDING_CONTROL_REVISION`, `CAPACITY_CLOSE_REASON`, `RESTORING_REASON`, `hostReturned` (three places), the control emulation in `test-utils/journal-session-fixture.ts` and its tests, client dead-field code. Check the budgets of section 4. Also look for anything else the step made unnecessary: the eager-open comments in `broker.ts` (`acceptJournalServed`), the `recoverForJournalStream` call at negotiation, the roadmap note on stream preemption for journal-served views. List what remains and why.
10. **Owner gate and records.** Update the roadmap (S5 row, progress), the design's compatibility paragraph, and the runbook (a "negotiated session control" paragraph, as for Team recipients). Tell the owner to update every Controller and wait for the confirmation. Nothing below runs before it.
11. **R2: delete the old path.** After the owner confirms: the Relay refuses streams of Hosts without `control`; the Controller's uplink streams drop their lease branch; the operator switch goes; records updated. It has its own review, its own deploy and the same acceptance suites minus the legacy rows, plus a row that proves an old Controller can still register, appear and be updated.

## 11. Open questions, and decisions made

**For the owner.**
1. **How long is the window?** This plan proposes seven days from the R1 deployment, longer if any machine is offline. Offline is not retirement.
2. **Machines that cannot or will not update.** After R2 they keep management and cannot open sessions. Confirm that this is acceptable, or name them so they are updated first.

**Decided here (technical).**
- No session protocol bump; an opt-in uplink capability, as the design says.
- The Relay's lease is the existing registry; no second lease implementation, no new envelope. The requester envelope belongs to S6's queue; S5 needs none because the uplink is already Host-authenticated and the Relay forwards only messages from streams it authorized.
- Control is granted whether the Host is online or not; Host presence is a separate fact.
- The Controller stream opens on the first mutation, not at negotiation; a terminal-owned session the Controller has not opened is learned on the first refusal.
- A Controller stream that ends closes the browser stream, as today, so the client's uncertain-send handling is unchanged.
- Tokens stay on the wire until the next bump.
- The 429 limit stays; the runner is paced.
- T4 and T5 are claimed only for the Relay-made blockers; the full T4 (runtime states never disable the composer, queued sends) stays with S6.

## 12. Results

To be filled in after Task 8 and Task 9: measured accounting, T4 and T5 counts, compatibility matrix evidence, suites run.
