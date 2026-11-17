# S5: Relay-owned session control

**State: planned, awaiting owner approval. Nothing in this plan is implemented.** S5 changes the contract between the Relay and every Controller, so the owner approves it first (roadmap S5; [design, Compatibility and rollout](../specs/2026-11-15-im-session-service-design.md); [assessment, Lever B](../specs/2026-11-16-journal-simplification.md)).

S5 is the first slice of P2. It moves the session-control lease and the native-owner fact to the Relay, and it removes the five shims that P1-B2 built so that the Relay could imitate the Controller's session wire: the pending revision, held acquires, the offline-Host amendment, `hostReturned` and the `restoring` override. The operation queue itself (requesters, receipts, preconditions, the outbox, Team and TPM queues) stays in S6.

## 1. For the owner: approve in one read

**What changes for you.** A browser asks the Relay for control and gets the answer at once, whether the Controller is online, offline or just coming back. Today a journal-served view waits for a Controller stream to learn its control state, shows "Restoring" while it opens, and closes and reconnects when a Host returns. After S5 none of that happens: reading and control never need the Controller. The Controller is contacted only when something is sent, and it still decides everything that depends on the native runtime (a terminal in control, provider capabilities).

**What you must do: update every Controller.** The Controller gains one negotiated capability. A Controller that is not updated keeps working through the old path until the window ends (section 5). After the window, the next release deletes the old path. Which of two endings applies to updated Controllers is your decision (section 5.5); a Controller that was not updated can still register, appear in the Hosts list and be updated from the website, but it cannot open sessions.

**The session protocol stays at 1.8.0.** No bridge release and no multi-hop update (the runbook's intermediate releases) is needed. Any Controller that runs 1.8.0 updates in one step. The change is an opt-in uplink capability, as for outbox, journal and Team recipients.

**Deploy order** (section 5.4): publish the Controller release; deploy the Relay and website (the `primary` Worker; the journal partitions Worker is untouched); ask you to update every Controller from the Hosts page; you confirm; the next release removes the old path. Nothing here needs two Workers to be deployed in a given order.

**Risks, in order of weight.**
1. The change also routes ordinary (crude) sessions through the Relay's control gate, so every updated Controller is affected, not only journal-served sessions. Journal-served sessions exist only where you turned smart reading on, which is off by default. Mitigation: an updated Controller falls back to the old path against a Relay that does not acknowledge the capability, and redeploying the previous Relay is the rollback.
2. A terminal that already owns a session the Controller has not opened is learned by the Relay only when the first send is refused. The composer then turns read-only, the draft stays, and take-over works. P1-C3's read-only observation closes this gap later.
3. A Controller that is updated but whose uplink drops while a send is in flight ends that stream, as today; the client's uncertain-send handling is unchanged.

**Your decisions, recorded in section 11:** no fixed window (R2 waits for your word that every Controller is updated); R2 requires a Relay at R1 or later; machines that cannot update can register but not open sessions.

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
| Whether a session is in a terminal's hands (`nativeOwner`) | **Controller decides; the Relay holds it only as a per-stream fact** | The Controller's refusal (at open or at delivery) carries it. The Relay keeps it in that stream's lease, shows `read_only` with the owner, and clears it at the stream's next `acquire`. There is no shared owner table: ownership is a pid record checked with `alive(pid)` and no one reports a terminal's exit, so a table could show "Native CLI has control" after the terminal is gone. |
| The check at delivery that no terminal owns the session | Controller | A mutation that raced an owner change is refused `native_session_owned` and never reaches the native runtime. This replaces the token check, which was the only per-mutation check the Controller made for control. |
| Provider capability, operation cache, succession admission, recent sign-in rules, a session answering its own request | Controller (unchanged) | Native and policy facts stay with the adapters and the Host. |
| Take-over mechanics (interrupt the terminal, attach) | Controller | The Relay shows it as the owner field disappearing. |
| Runtime connection state (`reconnecting`, `restoring`, `unavailable`) | Adapters, through the Controller | The Relay never writes this field again. |

Invariants:
- **I1.** For a Host that acknowledged the capability, lease state exists only in the Relay.
- **I2.** A mutation reaches a Controller only from a stream with a live control lease, and the Controller still refuses it if a terminal owns the session.
- **I3.** The Relay synthesizes no runtime state.
- **I4.** A journal-served stream opens a Controller stream only for a mutation, a command, an interaction answer or an upload, and keeps it until the browser leaves; reading and control never open one. Crude streams are unchanged: they hold a Controller stream from the open.

### 3.2 Flows

**Host online.** The browser opens the session socket. The Relay answers `negotiated` with `sessionControl: true`, the Snapshot (journal head, or the Controller's Snapshot on a crude stream) and a `session_control` frame, read-only and `available: true`. The client sends `acquire`; the Relay grants a token in the same round trip. The page can send. The first mutation opens a Controller stream, wakes the session if it was released (`recoverForJournalStream`), and is held (at most 32 messages and 1 MiB, as today) until the stream is ready. Journal-served views hold no Controller stream until then.

**Host offline.** The same, with no change in what the Relay answers: the lease is granted. The offline fact reaches the page as a Host fact (the Hosts list and feeds, which the composer's "Send when the Host is back" path already uses); it is not a control state. A mutation that needs the Controller is refused at once with the recoverable `host_offline`, and the stream stays open and keeps reading. Nothing waits and nothing is amended.

**Host returning.** The stream was never tied to the Controller, so nothing closes and nothing is reopened. The next mutation opens a Controller stream normally. A stream that already had a Controller stream open when the Host went away ends as it does today (the Controller stream's end closes the browser stream); the client's reconnect and uncertain-send handling is unchanged, and the new stream gets a new lease. When the Host fact on the page lags behind (the page still thinks the Host is online), the first send is refused `host_offline`; the client recovery in 3.5 handles it.

**A terminal drives the session.**
- *A terminal owns the session:* the Relay cannot know until the Controller says so, and that happens on the first send in every case. The Controller refuses `native_session_owned` with the owner, at the Controller stream's open (a session it has not opened) or at delivery (a session a terminal took while it was open). A refusal at delivery names no owner on the wire, so the Relay answers the refused request, revokes that stream's lease, and opens the Controller stream once more; the existing open refusal returns the owner. The Relay sets the owner on that stream's lease and sends `session_control` with `read_only` and the owner. Other streams of the session learn it at their own first send. A terminal that has since exited is never shown: nothing keeps the fact beyond the stream.
- *The terminal exits, or never owned it:* the fact lives only in that stream's lease; the next `acquire` clears it, and the next send finds out again if it is still true.

**Take-over.** The page offers "Take over" when its stream's lease shows an owner. The client calls HTTP `attach` with the owner's generation as today (the Controller interrupts the terminal and attaches). When `attach` returns, the client sends `acquire` at once instead of waiting for a `session_control` without the owner, which the Relay no longer pushes. The Relay clears the stream's owner, replaces the lease (new revision) and grants. If a terminal took the session again, the next send is refused and the cycle repeats. This is a client change (3.5).

### 3.3 The contract

One addition, opt-in and on the Host uplink. No change to the browser-facing session protocol (1.8.0) or to `REMOTE_HOST_UPLINK_VERSION` (2). There is no new message.

1. **Capability `control`.** The Controller offers `control=1` in its uplink URL; the Relay acknowledges `control: 1` in `registered` only for that offer (the Team-recipient pattern in the runbook). The acknowledgement is per connection, never stored.
   - With the acknowledgement: the Relay owns the leases of every stream of that Host, crude and journal-served. The Controller's uplink streams attach no lease, ignore `controlToken`, and run the native-owner check at delivery.
   - Without it (an old Controller, or an old Relay): both sides behave exactly as today.


Rule 5 (protocol surface): one capability, no new message, no new refusal reason, no schema field. The Relay stops forwarding `session_control` frames, which is a behaviour change with no schema change.

Wire fields that become dead (`resumeToken`, `retainOnDisconnect`, `clientKind`, `ownerKind`, the `take_over` action) stay in the schema until the next session-protocol bump, because removing a schema field is a bump and the runbook's staged release. Clients stop sending them in S5. They are listed in section 8.

The `token` and `controlToken` stay: the Relay issues and checks them per stream, so unchanged clients (cached pages, the command line, ARDB, an older `RemoteSessionClient`) work. Removing them also waits for the bump.

### 3.4 What the Relay and the Controller each get

**Relay (`agent-remote-hosted`).**
- `stream-control.ts` (new): a gate used by both accept paths. Inputs: a `SessionControlRegistry` per Relay, the stream's authorization, the Host's acknowledgement. Behaviour: answers `session_control_request` itself (the existing registry semantics, stale revision gives `session_control_changed`, a native owner gives `native_session_owned`); checks a mutation's token before it is forwarded; on a Controller-to-browser frame, drops any `session_control` and adds `sessionControl: true` to `negotiated`; emits the lease state after `negotiated`.
- The lease: the existing `SessionControlRegistry` holds its owner per session, which this design no longer wants, so Task 2 either uses one registry instance per stream or writes the lease (about 20 lines: revision, token, access, owner). The owner is one field of the stream's lease (+1 field), cleared by `acquire`.
- `journal-session-stream.ts` loses the five shims (section 4) and opens the Controller stream lazily.
- `registered` carries `control: 1` when offered. The acknowledgement is held on the Host's connection; there is no Hosts-list field, because the owner reads the Controller's version in the Hosts list, which already exists.
- The smart-reading switch, and the journal gate (`serves`), require `control` on the Host. A Host without it is served crude, and the switch shows the existing "Update the Controller" message.

**Controller (`agent-host`, `agent-remote-relay`).**
- The uplink client offers `control=1` and records the acknowledgement.
- `remote-host-plugin` passes no `sessionControls` to the session wire of an acknowledged connection; the wire's per-mutation control check becomes the native-owner check (`native_session_owned`). Direct-serve transports (the lab server, DSH shared web, `websocket-stream`) are their own Relay and keep the registry unchanged.
- A refusal at delivery that is `native_session_owned` is one more outcome of the existing wire; no owner reporting goes to the uplink.

**Client (`agent-remote-web`, `agent-remote-lab`).** No behaviour change is required. It stops sending the dead fields, always sends `acquire`, and loses the `controlProofs` and `resumeToken` handling and the never-sent `ownerKind` string. It still waits for `session_control` with no owner after a take-over.

### 3.5 The draft-kept recovery (client)

Today no web or lab code handles `native_session_owned`, and when the Host fact lags the composer gets `host_offline` from a send. Since the first send is where the Relay and the page learn the owner in every case, the page must handle both refusals:
- The text stays in the composer, with its focus and content (T4's rule), when a send is refused for `native_session_owned`, `session_read_only`, `host_offline` or `session_control_changed`.
- `native_session_owned`: the composer is read-only with the existing notice and offers "Take over" (the existing take-over action, then `acquire`).
- `host_offline`: the page treats the Host as offline for this session and offers "Send when back" with the same text where the Host's Controller supports the outbox; where it does not, it shows the existing "Update the Controller" hint.
Budget: about 80 lines and one flag per composer send; tests in Task 6.

### 3.6 Revocation and queued `next_turn` sends

Today a lease revoked after a `next_turn` send is queued in the Controller stops that send at dispatch (`assertControl` in `dispatch`). With Relay-owned leases the Controller no longer holds the lease, so without a replacement a revoked stream's queued send would still dispatch. Decision: restore the check cheaply, with no new state. The Relay ends a stream's Controller stream whenever it revokes the lease or the browser stream ends (the share is revoked, access expires, the lease is replaced), and the Controller's dispatch check becomes "my uplink stream is still open", which the wire already tracks as its `closed` state. A native-owner change is the Controller's own check, as before. Task 5 confirms that the wire stops dispatch on a closed stream; if it does not, it adds that one check. Test: queue a `next_turn` send, revoke the lease, and assert the provider receives no call.

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

Added: one uplink capability, one registry instance or lease (per stream), one gate module, one lease handle and one owner field per stream, and the client recovery of 3.5. Each is named in section 3 and replaces the Controller round trip it makes unnecessary. Not added after review: `session_owners`, the owners map, its 1024 cap, the family fan-out, the Hosts-list `control` field, the operator switch.

**Budgets (rule 3).**
- `createJournalSessionStream` mutable fields: 19 today (phase, activityOnly, keyed, subscribed, hostReady, stale, hostState, hostStream, waitingForHost, controlRevision, held, heldControl, queued, activitySnapshot, activityCursor, lastActivity, lastStatus, lastActivityCursor, activityTimer). After: at most 16 (minus hostReady, waitingForHost, controlRevision and heldControl; plus the lease handle).
- Its recovery and refusal paths: 7 (429 close, hopeless 4xx, offline wait, other refusal, `hostReturned` close, held-control rewrite, `restoring` to ready update) to at most 2: refuse held messages with the refusal; the Controller stream ended, so close as `hostEnded` does today.
- `journal-session-stream.ts` ends shorter than its 530 lines today.
- Production lines in `packages/` over the whole step (R1 and R2), tests excluded: net negative. At R1 alone: at most zero net. Tests fall by about 600 lines (the control parts of `journal-session-stream.test.ts` 563, `-amendments` 179, `broker-journal-sessions.test.ts` 401, and the control emulation in `test-utils/journal-session-fixture.ts`) and rise by the new suites; the plan only requires that the removed behaviour has no test left that asserts it.
- No new rate limit, pool, timer, cache or table. The one cap is the held messages: 32 and 1 MiB (unchanged).

## 5. Version, upgrade order and compatibility window

### 5.1 The change in one paragraph

No session protocol bump (1.8.0 stays; `ProtocolVersionSchema` unchanged; no intermediate Controller releases). One negotiated capability, `control=1` offered by the Controller and acknowledged by the Relay. The uplink version stays 2. Fixtures, schemas, the uplink decoder and `compatibility.json` are updated together (`pnpm compatibility:update`, then `pnpm compatibility:check`). There is no operator switch: redeploying the previous Relay is the rollback, and updated Controllers fall back per connection.

### 5.2 Who talks to whom during the window

| Pair | Result |
|---|---|
| Old Controller, new Relay (R1) | Registration, heartbeat, Hosts list and Controller update work as before. The Relay sees no offer and does not acknowledge. Crude sessions run exactly as today: the pass-through code is untouched and the Controller issues the leases. Journal-served reading is not offered for that Host: the journal gate requires `control`, so its sessions are served crude, and the smart-reading switch shows "Update the Controller". The five shims are gone from the Relay for every Host, because only acknowledged Hosts can be journal-served. |
| New Controller, old Relay | The Relay does not acknowledge. The Controller attaches leases and checks tokens as today, and behaves as before. Verified by a test, not assumed. |
| New Controller, new Relay | Relay-owned control, for crude and journal-served streams. |
| Mixed Hosts on one Relay | Per Host: the acknowledgement is stored on the Host's connection state and never persisted. |

### 5.3 Is a window with both paths needed, and how short?

Yes, and only on the Relay's crude pass-through and the Controller's uplink-stream branch. Both are the code that exists today; the window adds no new code for old Controllers. **The window has no fixed length.** It lasts from the R1 deployment until the owner says that every Controller is updated; R2 lands only after that statement (the Hosts list shows each Controller's version). An update is one step, with no bridge, because the session protocol is unchanged.

Old paths are deleted in R2, a separate release after the owner confirms (design rule, runbook phase 2):
- The Relay refuses a stream of a Host without `control` with 409 `controller_upgrade_required` and the "Update the Controller" message, and stops forwarding session-control frames. Registration and management stay.
- The Controller's uplink streams drop the lease branch (the registry fallback stays only for direct-serve transports). A Controller whose `registered` has no `control` serves no sessions on that connection and shows "Update the Relay"; management stays.
- The client's dead-field handling that survived for old pages is deleted.
- No Hosts-list field was added, so none is deleted.

### 5.4 Cloudflare and deploy order

Control state is per connection and in memory in the `primary` Durable Object, which already owns every socket. S5 changes nothing the journal partitions Worker (`agent-remote-control-journals`) or the RPC contract between them (`journal-partition.contract.json`) sees, so no cross-Worker ordering is introduced. If a deployment has journals enabled, the standing rule applies and is a no-op here: partitions Worker first, then `primary`.

Order (the runbook's phase 1, steps 5 to 8):
1. Build from a clean reviewed commit; publish the Controller release (tag, manifest, tarball checksum) and verify the public bytes. The release's declared session protocol is 1.8.0, so the website offers it as an ordinary update to every Controller on 1.8.0.
2. Deploy the `primary` Worker and the website together. The Relay acknowledges `control`; old Controllers keep working.
3. Tell the owner: update every Controller (Hosts page, "Update Host" for each). The owner confirms each as it reconnects and shows the new version. Offline machines are not retired because they are offline. The owner says when every Controller is updated; R2 waits for that.
4. After the owner confirms, R2 ships on the same order (Controller first, then the Relay). A Controller that is not updated by then keeps management and shows the reason.

Rollback: redeploy the previous Relay; updated Controllers fall back per connection with no loss. A Controller rollback needs nothing on the Relay.

### 5.5 R2 requires a Relay at R1 or later (owner decision, option b)

**Decided by the owner.** R2 Controllers drop the registry fallback for uplink streams. A Controller whose `registered` carries no `control` serves no sessions on that connection and shows "Update the Relay"; management stays.
- **Accepted consequence:** rolling the Relay back below R1, or running an older self-hosted Relay, stops sessions for every R2 Controller. Before R2 the rollback is still safe (redeploy the previous Relay; R1 Controllers fall back).
- The R2 release notes and the Hosts page say "Relay R1 or later first".
- `deploy/self-hosted` and `docs/self-hosted-deployment.md` are updated in R2: upgrade the Relay first and never roll it back below R1 once Controllers are on R2; the Relay-first order is added to the deploy steps.
- **Machines that cannot update.** After R2 they can still register, appear in the Hosts list and be updated, but cannot open sessions. The Hosts page shows "Update required" on such a Host, with manual-update instructions (the existing installer and `controller-updates.md` steps for the Host's platform), and a session open for it answers 409 `controller_upgrade_required` with the same words. This message is part of Task 6 (client) and Task 11 (R2); it needs no new Hosts-list field, because the Relay knows the Host has no acknowledgement and the Hosts page already reads the Controller's version.

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
- A terminal takes the session while the Controller holds it, and a send follows: the Controller refuses `native_session_owned` at delivery; the provider receives zero native calls; the Relay revokes that stream's lease, re-reads the owner through the open refusal, and the page gets `read_only` plus the owner; the text stays in the composer.
- A terminal owns a session the Controller has not opened: the first send is refused at the Controller stream's open with the owner; same result.
- Take-over: HTTP `attach` with the owner's generation, then `acquire` at once; the lease is replaced with a new revision and granted; the first message after take-over is delivered. If the terminal took the session again, the next send is refused again.
- Take-over with a stale generation: `native_owner_changed`, state unchanged.
- The terminal exits: no frame reports it; the stale owner on a stream clears at its next `acquire`, and a stream opened afterwards never shows it. Assert that a new stream of that session starts with no owner.
- Two streams of one session: only the stream whose send was refused shows the owner until its own first send or `acquire`.

**E. Reconnects.**
- Browser socket drops and returns: a new lease, the old token is invalid, reads resume from the cursor.
- Relay restart in process: Controllers register again, send the full owner report, pages reconnect and acquire; no stale lease survives.
- Control-message and capacity limits: a view that never sends occupies no Controller stream (the Host's and the account's stream counts do not change when journal-served views open); a send refused for capacity (429) refuses that message only, and does not close the browser stream.

**F. Authorization.**
- A read-only share recipient: `acquire` returns `read_only`, mutations are refused at the Relay, nothing reaches the uplink. The gate applies the same rule as the Relay's existing message admission; the test proves `session_control_request` is covered by it.
- A revoked or expired session ends the socket and the lease with it.

**G. Compatibility matrix** (section 5.2), including the old Controller built from the commit before S5 in a temporary worktree and run against the new Relay on a free port, and the new Controller against a Relay build before S5. Each row shows a send, a take-over and a reconnect. The existing crude and journal suites run unchanged for old Controllers: they must pass without edits.

**H. Management.** Old and new Controllers register, heartbeat, appear in the Hosts list and accept a Controller update request on the new Relay (the runbook's "Old Controller, new Relay" row).

**I. Contract.** Schema and fixture tests for the capability offer and the acknowledgement; replay fixtures and `pnpm compatibility:check`.

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
- `available` in the session control state (the Relay grants control whatever the Host's state, and the fact is no longer used).
- `token` in `session_control` and `controlToken` on mutations, once no client needs them (the Relay knows each stream's lease and the token is redundant).
- The Controller's `SessionControlRegistry` lease code, if the direct-serve transports are given a Relay-side registry; until then it is the lease owner of a process that is its own Relay.

## 9. The 429 control-request limit seen in S4b

**What it is.** The limit is `gateway.ts:741`: 60 non-GET HTTP requests per minute per account (`mutation:<subject>`), shared by every route. Rapidly opening fresh sessions registers a window each time (`POST windows/:id/operations`) and also posts the open itself, so about 20 to 30 fresh opens a minute exhaust it. The 404s on `GET windows/:id/operations/:id` and the 10 second `GET windows/:id/changes` polls are window routes. None of them is session control.

**Does S5 change it? No.** Session control travels on the session WebSocket (`session_control_request`), where it is already outside this limit, and S5 puts the acquire on that same path and adds no HTTP request. The per-stream message limit (`admitClientMessages`: 120 control messages and 600 timeline requests per minute) is unchanged.

**What S5 changes nearby.** The Controller-stream capacity refusals (`HOST_STREAM_LIMIT`, `USER_STREAM_LIMIT`, close code 4029) are a different 429. Journal-served views no longer hold a Controller stream until they send, so those refusals stop for them; the stream-preemption note in the roadmap (preemption cannot free a slot from a view that holds none) is partly met for journal-served views, and P3 finishes it.

**Decision.** Keep the limit. A person cannot open 60 sessions in a minute, and a layout write is a real write. The queue (S6) must not submit operations by HTTP on this bucket: operations go over the session socket, or get a bucket of their own like drafts and reads. The runner is fixed instead (Task 8): it spaces fresh opens by more than the refill interval, and reads a 429 as a pause, not as a hang. **Follow-up outside S5:** move window writes (`POST windows/:id/operations`) to the ambient rate bucket, as drafts and read positions already are, so layout writes follow the user's actions and no longer use up the budget for control requests. Not part of this step.

## 10. Tasks

Each task ends with its tests passing and, from Task 3 on, the existing suites unchanged and green. Run `pnpm compatibility:update` and then `pnpm compatibility:check` after Task 5. Work in the worktree `.worktrees/im-session-service`; use free ports; keep existing local services.

1. **Contract.** `control` offer and acknowledgement (URL query, `registered`); decoder, fixtures and replay. Tests: schema, decoder, replay (section 6 I). State: +1 capability, no message, no list field.
2. **The gate and the lease (Relay).** `stream-control.ts`; the per-stream lease with its owner field; refusal handling (re-read the owner through the open refusal); `session_control` answers. Unit tests with fakes, then the real-transport suites A and D against a scripted Controller.
3. **Journal-served stream.** Use the gate; open the Controller stream lazily; one refusal rule; drop the five shims and the eager open; remove `hostReturned` through `JournalSessions` and the broker; require `control` in the journal gate and the smart-reading switch. Tests: A, B, C, E; delete the tests that assert removed behaviour.
4. **Crude path.** The same gate in the pass-through for acknowledged Hosts (`negotiated` rewrite, drop of Controller `session_control`, token check before forwarding); unacknowledged Hosts keep today's pass-through untouched. Tests: A and D for crude; G for the legacy rows with the pre-S5 Controller.
5. **Controller.** Offer `control=1`; no lease on uplink streams after the acknowledgement; the native-owner check at delivery replaces the token check, and the dispatch check of I5 (section 3.6) uses the Controller stream's own open state; legacy branch kept. Tests: D with a real fake provider (zero native calls on a raced mutation), the `next_turn` revocation test, G.
6. **Client.** Stop sending the dead fields; always `acquire`; remove `controlProofs`, `resumeControlToken`, `retainControlOnDisconnect`, the `ownerKind` string and the `resumeToken` redactions. Plus the Hosts-page "Update required" state with manual-update instructions for a Host whose Controller has no `control` acknowledgement (shown from R1 where smart reading is requested, for every such Host from R2), and the draft-kept recovery of 3.5: budget about 80 lines in `agent-remote-web` and `agent-remote-lab`, no new state beyond one flag per composer send. Tests: web and lab suites; component and real-transport tests that the text stays in the composer after a refused send; that "Take over" is offered for `native_session_owned` and "Send when back" for `host_offline` (also when the Host fact lags); the same client suite runs against crude and journal-served Hosts.
7. **Acceptance and compatibility suite.** Sections 6 F, G, H over real transports, including the pre-S5 Controller and Relay builds.
8. **Measurement.** `pnpm local up`; the runner's S4b pacing fix; section 7 at 1x, 4x CPU, 100 ms and both against the control arm; plus a Host offline-and-return scenario (stop and restart the Controller with views open: labels, closes, first send afterwards) and a Relay-side count of Controller streams opened before the first send (target 0 on journal-served views; read from the Host's stream table through the Relay's diagnostics); record results.
9. **Deletion task (rule 7).** Delete what Tasks 3 to 6 made unnecessary, and record the measured accounting: `PENDING_CONTROL_REVISION`, `CAPACITY_CLOSE_REASON`, `RESTORING_REASON`, `hostReturned` (three places), the control emulation in `test-utils/journal-session-fixture.ts` and its tests, client dead-field code. Check the budgets of section 4. Also look for anything else the step made unnecessary: the eager-open comments in `broker.ts` (`acceptJournalServed`), the `recoverForJournalStream` call at negotiation, the roadmap note on stream preemption for journal-served views. List what remains and why.
10. **Owner gate, then wait for the owner's go for R2.** Update the roadmap (S5 row, progress), the design's compatibility paragraph, and the runbook (a "negotiated session control" paragraph, as for Team recipients). Tell the owner to update every Controller. Do nothing further until the owner says every Controller is updated; that statement is the go for R2. There is no time limit.
11. **R2: delete the old path.** After the owner's go: the Relay refuses streams of Hosts without `control` with 409 `controller_upgrade_required`; the Controller's uplink streams drop the lease branch; the Hosts page "Update required" state with manual-update instructions; release notes and `deploy/self-hosted` documentation ("Relay R1 or later first"); records updated. It has its own review, its own deploy and the same acceptance suites minus the legacy rows, plus a row that proves an old Controller can still register, appear and be updated, and a row that shows "Update required".

## 11. Open questions, and decisions made

**Decided by the owner (2026-11-17).**
1. The transition window has no fixed length; R2 lands only after the owner says every Controller is updated.
2. R2 requires a Relay at R1 or later (5.5, option b); rolling the Relay back below R1 after R2, or an old self-hosted Relay, stops sessions. Accepted.
3. Machines that cannot update can still register after R2 but cannot open sessions; the Hosts page shows "Update required" with manual-update instructions (Tasks 6 and 11).

**No open questions remain for the owner.**

**Decided here (technical).**
- No session protocol bump; an opt-in uplink capability, as the design says.
- The lease is the existing registry or a 20-line lease per stream (Task 2); no second lease implementation of any size, no new envelope. The requester envelope belongs to S6's queue; S5 needs none because the uplink is already Host-authenticated and the Relay forwards only messages from streams it authorized.
- Control is granted whether the Host is online or not; Host presence is a separate fact.
- The Controller stream opens on the first mutation, not at negotiation; a terminal-owned session is learned on the first refusal, in every case, as a per-stream fact with no shared table.
- A Controller stream that ends closes the browser stream, as today, so the client's uncertain-send handling is unchanged.
- Tokens stay on the wire until the next bump.
- The 429 limit stays; the runner is paced.
- T4 and T5 are claimed only for the Relay-made blockers; the full T4 (runtime states never disable the composer, queued sends) stays with S6.

## 12. Results

To be filled in after Task 8 and Task 9: measured accounting, T4 and T5 counts, compatibility matrix evidence, suites run.
