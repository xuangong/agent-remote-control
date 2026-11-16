# Journal subsystem: where the complexity comes from, and what to remove

Status: assessment for the owner's decision, 2026-11-16. Analysis only; no code was changed.
Scope: everything the branch `design/im-session-service` (HEAD `f2c11d53`) added since `main` at `0aaefda9` for session journals.
Method: I read the design, the roadmap, the landed plans and the code listed in the brief, and counted lines, fields and paths by function. Nothing was built or prototyped. Every number below is an estimate from reading, accurate to roughly 10 percent unless stated. Section 8 lists what I am unsure about.

## Summary

### Where the complexity comes from

The branch added 6,478 production lines (103 deleted) and about 12,500 test lines, in 131 commits over 18 hours. 38 commits are features and 40 are fixes. The 40 fixes added 1,985 production lines and removed 753.

Four causes explain almost all of it.

1. **One upstream choice makes the only universal recovery unaffordable.** Today's client treats a new epoch as a reset: it empties the conversation and reloads. So the server was built to avoid a replacement at almost any cost. Avoiding it needs item digests, open and complete states, corrections with revisions, an item index that the Controller pulls page by page, a reconcile planner, and a recovery rule for every way an incremental sync can fail. Meanwhile "reopen and replace with the newest window" is the one rule that is always correct. Each review found a new failure of the incremental path and added a guard for it. This is the largest source of accidental complexity: about 1,240 lines of specialised recovery (R) plus part of the 900 lines of scale mechanisms (S).
2. **The Relay imitates the Controller's session wire for unchanged clients.** Pending control revisions, held and rewritten acquires, an offline-Host amendment, a `restoring` override and an interaction hold exist so that current clients cannot tell a journal-served session from a forwarded one. About 700 lines (P). These are a transition cost and are removable when Relay-owned control arrives.
3. **Scale and bounds were built before any measurement.** P0 measured sessions of 6 to 12 rows. The branch has a shared budget of 64 messages and 16 MiB, a head lane, four open slots, index paging to 100,000 items, a quota ladder of 2,000, 200 and 20 items, a bounded cache, a four-worker deletion pool and Cloudflare reply halving. About 900 lines (S) and 510 lines of deployment shape (D). Nothing has run on real provider data yet: no provider declares the capability.
4. **Process.** Plans carry the code (P1-C1 is 10,090 plan lines for about 1,700 production lines), each plan lists 12 to 17 numbered decisions and almost every decision adds state, and reviews were asked what could go wrong, not what could be deleted. No rule made a fix say whether it adds or removes state.

### Essential and accidental

By my estimate (Section 1):

| Category | Lines | Share |
|---|---:|---:|
| E essential to replicating native history | 2,930 | 45% |
| P protocol emulation for unchanged clients | 700 | 11% |
| R specialised recovery | 1,240 | 19% |
| S scale and bounds ahead of measurement | 900 | 14% |
| D deployment shape (Node and Cloudflare) | 510 | 8% |
| X local patches an invariant could replace | 200 | 3% |

Under half is essential. R, S and X together (about 2,350 lines, 36%) are what a simpler design would not have. P goes away on its own schedule. D stays.

### Recommended path

1. **Stop adding mechanisms now** and adopt the rules in Section 6.
2. **Delete the dead and duplicate pieces** that need no design change: grant levels (nothing shipped with `journal=1`), the head-index load retry loop, the quota fence, the deletion pool. About 300 lines.
3. **Lever A, server half, before any provider is enabled:** the Controller sends its window on open; the Relay compares it; anything other than "identical or extended" becomes one replacement. This deletes about 1,200 lines, takes the publisher from 36 mutable fields to about 18 and from 14 recovery paths to about 5, and drops the index paging, corrections, seals, digests as a gate, the quota ladder and the reset open.
4. **P1-C2 for one provider under the relaxed contract** (stable keys, completion marks, live-only marks; no byte-exact live and reread equality). Measure on `pnpm local`.
5. **P1-D with Lever A, client half:** item keys on the wire behind an opt-in flag, rows keyed by item key, a replacement absorbed by key. About 350 production lines of client work, and it shrinks P1-D's "no holes" task.
6. **Relay-owned session control as the first slice of P2**, before P1-C3 and before the remaining providers. Net deletion is small (about 100 lines), but it removes the shims that P1-C3 Task 7 would otherwise build on.
7. Remaining providers, P1-C3 (defer backfill and observation until measurement shows first-open misses), P3.

### Expected reduction

Server-side production code from about 6,480 lines to about 4,700 to 4,900 (roughly 25 percent less). Including the new client work, about 5,100 to 5,300. Test lines fall by roughly 3,000 to 4,000 of 12,500. The numbers that matter more: publisher mutable fields 36 to about 18, recovery paths 14 to about 5, journal entry operations 10 to 8, refusal reasons 10 to 6, open refusal reasons 3 to 1, and no per-provider byte-exact equality proof.

The saving that is larger than the lines is avoided future work: P1-C2's content alignment per provider, P1-C3 Task 7, and P1-D Task 4.

### What stays complex regardless

Generation fencing, contiguous sequences with the rule never to serve a hole, durable-before-fan-out, live-only items whose only copy is the journal, fills and older history from the native session, retention and eviction, hard byte quotas, the Node and Cloudflare split, and the native-owner rules. Those are about 45 percent of the code and they are the product.

### Decisions needed from the owner

1. Approve the freeze and the rules (Section 6).
2. Approve Lever A as the way to meet T6: unchanged items keep their rendered rows across a new epoch, instead of the epoch never changing. This changes P1-D's design and the P1-C2 contract.
3. Accept that an interrupted partial item that native history never recorded may vanish at the next replacement (it already vanishes in crude mode today). Otherwise `seal` stays.
4. Decide whether Relay-owned control (Lever B) starts P2, which requires every Controller to update.

---

## 1. Inventory

Categories: **E** essential to the approach (replicating native history that the Relay does not own, with asynchronous parties that disconnect), **P** protocol emulation for unchanged clients, **R** specialised recovery path, **S** scale or bounds ahead of measurement, **D** deployment shape, **X** local patch from a review finding that an invariant could replace.

Line counts are production lines in the file or function named. "Cat" is the category of the mechanism; where one file mixes categories, the rows split it.

### 1.1 Totals by component and category (production lines added)

| Component | Lines | E | P | R | S | D | X |
|---|---:|---:|---:|---:|---:|---:|---:|
| `agent-remote-hosted` | 2,632 | 900 | 700 | 150 | 450 | 330 | 100 |
| `agent-host` | 1,705 | 744 | 0 | 650 | 230 | 0 | 90 |
| `agent-remote-journal` | 1,208 | 760 | 0 | 250 | 200 | 0 | 0 |
| `agent-remote-relay` | 371 | 250 | 0 | 120 | 0 | 0 | 0 |
| `agent-remote-journal-sqlite` | 205 | 150 | 0 | 0 | 0 | 55 | 0 |
| `agent-remote-protocol` | 192 | 90 | 0 | 70 | 20 | 0 | 12 |
| `agent-remote-cloudflare` | 87 | 0 | 0 | 0 | 0 | 87 | 0 |
| `agent-remote-lab`, `agent-provider-sdk` | 78 | 36 | 0 | 0 | 0 | 42 | 0 |
| **Total** | **6,478** | **2,930** | **700** | **1,240** | **900** | **514** | **202** |

The split inside a file is a judgement. Treat each cell as plus or minus 10 percent.

### 1.2 Provider SDK and protocol

| Mechanism | What it does | Why it exists | Cost | Cat |
|---|---|---|---|---|
| Item identity on observations (`ProviderItemIdentity`: `key`, `completes`, `liveOnly`; `supportsJournal`) | An adapter states the native key of the item a row belongs to, whether the row finishes it, and whether history cannot rebuild it | Row source keys do not survive a reopen (Claude `stream:` keys, Codex random delta keys); every later mechanism needs a stable key | 36 lines; one new optional field on every observation | E |
| Publish entries `append`, `complete`, `alias`, `replace`, `prepend`, `head` | The journal's write vocabulary | Replicating history and live rows in order | about 90 lines of schema | E |
| `correct` (with `expectedRevision`) and `seal` | Replace the content of an item the journal already holds; keep a mid-stream item the reread lacks | A reopen finds an open item now complete, or a changed digest; the design's rule is to continue the epoch | 2 entry types, 1 refusal reason (`stale_revision`), revision per item | R |
| `rebind` and `outcome` (grant 2) | Amend a stored row in place when a resource settles or a background activity ends | These settle after the row was published; clients need them | 2 entry types, per-row matching by locator | R |
| `journal_index_request`, `journal_index_page`, `indexAfter` | The Controller pulls the Relay's item index page by page | The Controller computes the reconcile plan, so it needs the Relay's index | 2 messages, 1 field, a cursor in one epoch | S |
| `reset` on `journal_open`, `index_too_large`, `stale_epoch` | A way out when the index passes 100,000 items or a replacement happens between index pages | The Controller cannot replace a journal it cannot open | 1 option, 2 open-refusal reasons | R |
| `journal_unserve`, `journal_request_refused`, 10 refusal reasons | Stop serving a journal the Controller cannot keep current; answer requests the Controller will not fulfil | Never serve a stale or holed journal; do not wait 15 s for a doomed fill | 2 messages; 10 reasons the publisher branches on | R |
| Grant levels `journal=1` and `journal=2`, enforced per connection | Close a connection that sends grant-2 entries under grant 1 | Rolling out grant 2 over a released grant 1 | about 120 lines across `broker.ts`, `journal-uplink.ts`, `journal-partition.ts`; a 3 s capability wait | X |

The grant is dead weight: Roadmap row P1-C1 and Decision 10 of P1-C1 state "no released Controller asks for 1". Under the owner's rule (compatibility only through an upgrade) this is removable now.

### 1.3 Journal core (`agent-remote-journal`, 1,208 lines)

| Mechanism | What it does | Why it exists | Cost | Cat |
|---|---|---|---|---|
| Generations and fencing; watermark; contiguous sequences (`sequence_gap`) | Only the current publisher writes; a refused entry never consumes its sequence, so nothing after it is accepted | A stale connection must not write; never serve a hole | about 100 lines; 2 numbers per journal | E |
| Row folding into items, tail, `before` and `after` pages, head | The journal as a timeline the Relay can serve | The Relay answers reads without the Controller | about 450 lines | E |
| `replace` (new epoch, live-only carried over) and `prepend` (negative sequences) | A genuine rewrite; older history | Native history can be rewritten; older history is read lazily | about 120 lines | E |
| Eviction and fill with a digest check | Bodies outside the latest turns are dropped; they return on demand | Retention is by use; the native session is the ground truth | about 100 lines | E |
| `correct`, `complete`, `seal`, open and complete states, item digests, `planReconcile` | Incremental continuation of an epoch | See 1.2 | `reconcile.ts` 83, `item-digest.ts` 22, `correct` about 35, `seal` 12, `complete` 12, state branches in `append`, `prepend`, `replace` about 80; 1 revision per item | R |
| Incremental byte sizing, live-only drop, `clearHead`, `markIncomplete`, catalog | Keep the journal within its quota without re-measuring it | Quotas; resume after a refused row | about 200 lines; a running total | S |

### 1.4 The Relay's journal service and read path (`agent-remote-hosted`, 2,632 lines)

| Mechanism | What it does | Why it exists | Cost | Cat |
|---|---|---|---|---|
| `host-journals.ts` core: a serialized queue per Host, load, persist, open, publish, page, fill | The service behind the store port | One writer per Host; durable before fan-out | about 330 lines; 1 queue per Host | E |
| Bounded cache (64 journals, 128 MiB), per-Host usage, limits, retention window per loaded journal | Bound memory and disk | A Relay must not grow without limit | about 200 lines; 6 maps | S |
| Head index with a load epoch: a listing read across a head loss is discarded and read again, up to 3 times; the gate waits 2 s | Answer "is this session journal-served?" from memory | A stream open must not wait for the store | about 80 lines in `host-journals.ts`, `journal-head-index.ts`, `journal-sessions.ts`; 4 maps | S and X |
| Quota refusal takes the session out of serving, `quotaFenced` per generation, `incomplete`, `JournalIncompleteRefused` | After a refused row, accept only a replacement | A refused row leaves a hole | about 90 lines; 1 map, 1 persisted flag | R |
| Index pages (`indexPage`, 2,000 entries or 1 MiB per page, 100,000 items, `index_too_large`, reset open) | Let the Controller read the index | See 1.2 | about 90 lines; plus `journal-index-pages.ts` 20 | S |
| Durable deletion: `journalDeletions` in broker state, retry at start and on register, a wait on a restored Host, a bound of 1,024, a four-worker pool, batched confirmation | Delete a revoked Host's journals | Revoke must not leave content behind | about 200 lines in `broker.ts`, `host-journals.ts`, `state.ts`; 53 deletion lines in `broker.ts` alone | S |
| Smart-reading switch per Host and provider (persisted, a route, an `onStateChange`) | Choose served or forwarded per provider | Crude mode stays; rollback | about 90 lines | P |
| `journal-uplink.ts`: dispatch, correlation, fill and older requests with 15 s deadlines, diagnostics | The connection's journal protocol | Fills and older history need request and answer | 283 lines; 170 E, 60 R, 20 X, rest S | E |
| `journal-session-stream.ts`, `journal-sessions.ts`, `journal-host-stream.ts` (945 lines) | The journal-served stream: negotiation, Snapshot, subscription, pages, live frames, fill orchestration, the activity observer, the Controller stream | The read path from the journal | E about 350 (pages, live fan-out, fills); the rest is the emulation below | E and P |
| Pending control revision `relay-pending`, held acquires rewritten to the Controller's revision, `heldControl`, `flushControl` | Let a current client reach `ready` without the Controller | Clients request control on the first `session_control`; the Relay must not wait for the Controller | about 70 lines; 2 states, 1 revision rewrite | P |
| Offline-Host amendment, `hostReturned` 1012 close, `waitingForHost` | Answer an acquire with the pending state while the Host is offline; reconnect once the Host returns | Otherwise the client reconnects every 20 s | about 45 lines in the stream plus about 15 in sessions and broker; 1 flag | P |
| Refusal classes (429 capacity close, hopeless 4xx, offline, other) | Choose how a stream behaves when the Controller stream cannot open | Mirror crude mode's behaviour | about 40 lines; 4 classes | P |
| `restoring` override on every Snapshot until the Controller stream is ready, then one `agent_update` | Make current clients defer sends | Current composers wait on `restoring` | about 30 lines; 1 flag | P |
| Interaction hold: park a Controller's `interaction_*` frames until the served head agrees (2 s, 64 frames) | Avoid dropping a new question or reviving a resolved one | Two sources, the head and the frames, race | about 90 lines; 1 queue with timers; plus a publisher rule that a head with a changed pending interaction goes urgently | X |
| Broker gate, delegation, shared admission extraction, grant, `journalRequestTimeoutMs`, `journalService` option | Wire the above into the broker | | +333 lines | P, E and S |
| `journal-partition.ts` (proxy, server side, `estimateCloneBytes`, reply halving to 24 MiB, per-Host ordering, capabilities with a 30 s retry) | Reach journals in a Durable Object from `primary` | Cloudflare's 128 MB isolate, 32 MiB RPC limit and per-object SQLite | 254 lines; 3 contract methods tested by a recorded JSON | D |

### 1.5 Cloudflare and storage

| Mechanism | What it does | Why it exists | Cost | Cat |
|---|---|---|---|---|
| `JournalPartition` Durable Object, partitions Worker, two wrangler files that a test keeps identical, capability negotiation | Journals out of `primary` | Production is Cloudflare; the 16 MiB state bound | 87 lines plus configuration; not deployed | D |
| `SqlJournalStore` over a SQL port; `node:sqlite` binding | One store for both runtimes | Both hosts need it | 205 lines | E (store) and D (binding) |

### 1.6 The Controller (`agent-host`, 1,705 lines) and Relay package (371 lines)

| Mechanism | What it does | Why it exists | Cost | Cat |
|---|---|---|---|---|
| `journal-items.ts`: group rows into items, measure the wire size, chunk at 4 MiB or 256 entries | Turn the manager's timeline into publishable items | One bad row makes a message unencodable | 148 lines | E |
| `journal-reconcile.ts`: `planPublication` (continue, replace with 6 reasons, gap), `outcomeOps`, `rebindOps`, live-only adoption by order | Compare the reread with the Relay's index and say what to publish | Continue the epoch unless history was genuinely rewritten (T6) | 180 lines; 3 plan kinds, 6 reasons; adoption runs the planner again per live-only item | R |
| `SessionPublication` core: open, live batching, head, answers to fill and older requests, `replaced` handling, backoff | One session's publication | Publishing is asynchronous and the connection drops | about 550 lines; 6 phases, a lane, a waiter, a queue, timers | E |
| `SessionPublication` recovery (see 1.7) | Open again on every failure | Each review finding | about 440 lines; about 18 of the 36 fields | R |
| `journal-publisher.ts`: a pool of 64 messages and 16 MiB, head headroom of 16 messages and 2 MiB, four open slots, drain, release | Share one uplink among sessions | The uplink buffers 16 MiB and `send` throws past it | 202 lines; 2 queues; 3 counters | S |
| Agent manager tap (`subscribeJournal`, `identityMissing`, `loadOlderHistory`, `attentionItemKey`), row identity in `timeline-store`, the `controller:` key prefix | The publisher follows a manager without being a viewer | The manager already orders rows | 371 lines in `agent-remote-relay` (parts below) | E |
| Stable resource ids: HMAC under a persisted secret, a persisted index (`resource-id-key.ts` 62, `resource-id-index-file.ts` 82, `resource-id-index.ts` 17, ingestor +94) | A resource's id survives a restart | A journal row's binding must name a readable resource after a restart | about 255 lines; a secret file and an index file | R |
| Diagnostic delivery 4, 9 Controller and 4 Relay journal events | Say why a journal stopped | Operators need it | spread, about 60 lines | E |

### 1.7 The publisher's recovery paths, counted

`SessionPublication` declares 36 private fields that are not `readonly` (the earlier figure of 19 is lower than the class declares), 42 private methods, 6 error classes and 6 phases (`suspended`, `opening`, `live`, `refused`, `gave_up`, `stopped`). The recovery outcomes are:

1. `Reopen` (a `stale_epoch`, a `sequence_gap` after no item refusal, a `stale_revision`): restart at once.
2. Open refused with `index_too_large`: reset open with a forced replacement.
3. Open refused for another reason: phase `refused` until the next connection.
4. Head cannot be encoded: give up and unserve.
5. `quota_exceeded` on a message with a prepend: stop publishing older history and force a replacement.
6. `quota_exceeded` otherwise: narrow the window (2,000, then 200, then 20 items).
7. Quota ladder exhausted: give up.
8. `incomplete`: forced replacement without narrowing.
9. More than three `incomplete` in a row: give up.
10. A per-item refusal (`unknown_item`, `body_missing`, `type_changed`, `duplicate_item`, `invalid`): skip the item, renumber what follows, send it again.
11. Any other refusal, a timeout or a connection loss: restart with backoff (250 ms to 30 s, reset after a minute of sustained publishing).
12. Three replacements in a row: give up (`replace_loop`).
13. Identity breach by the provider: unserve and publish nothing until the next connection.
14. A held-event overflow or a missing acknowledgement after 30 s: restart.

Five of these end in `giveUp` with a different reason. Items 2, 5 to 10 and 12 exist because the incremental path can fail in ways that only a replacement mends; the code's own header says so: "Everything that can go wrong ends in opening the journal again".

### 1.8 Where the headline numbers come from

- 6,478 added and 103 deleted production lines: `git diff --numstat 0aaefda9 HEAD -- packages`, excluding tests, fixtures, JSON, Markdown, performance scripts.
- 12,505 test lines added. Test to production is about 2 to 1.
- 40 fix commits (+1,985, -753 production lines), 38 feature commits (+5,381, -240).

---

## 2. Lever A: the client absorbs replacements by item identity

### 2.1 The idea

Today `timeline_replacement` makes the client clear its timeline (`applyTimelineReplacement` in `replica/reducer.ts`: empty entries, `initialized: false`). Row keys are `${epoch}:${providerId}:${seqStart}:${identity}` (`replica/timeline-entry-key.ts`), so a new epoch re-keys every row, and the lab keeps showing the previous display only through `retainedDisplay` in `SessionConversation.tsx`.

Suppose the client instead lined up a new epoch's entries by item key. Entries would carry an item key (an opt-in channel flag; the identity fields in `AgentTimelineItem` are not enough, because `reasoning`, `todo`, `error` and `compaction` have no native id). A row would be keyed by item key. After a replacement the client would keep its entries on screen, fetch the new tail, and for each new entry reuse the held entry and its React key when the key matches and the content is equal.

This satisfies T6 as the design defines it ("no frame without rows, no label, and unchanged items keep their rendered rows"), without requiring that the epoch never change.

What a replacement then costs: one tail request per client (today's crude path pays that on every open), and one window rewrite in the store. What it saves: every recovery path whose only job is to avoid one.

### 2.2 What must not collapse

These are correctness invariants and stay as they are:

- **Live-only items**: their only copy is the journal; a replacement carries them over (the core already does this in `replace`; `carriedOnReplace`).
- **Generation fencing** and **contiguous sequences**, so a stale or partial publisher cannot write or leave a hole.
- **Durable before fan-out**, and acknowledgement as the durability signal.
- **Unserve**: a journal that cannot be kept current must stop being served.
- **Hard byte quotas** per session and per Host (a simple cap, not a ladder).
- **Fills and older history**, read from the native session on demand.

### 2.3 The proposed rule

On every open, the Controller sends the newest window of its timeline that fits one message (as `replacementPlan` already builds it). The Relay compares it with what it holds, in one place in the core:

- the window's keys and content equal the journal's tail: no change, the epoch continues;
- the window equals the journal's tail plus new items at the end: append them, the epoch continues;
- anything else (an open item became complete, a digest differs, an item is missing, order changed, a gap, an anomaly of any kind): replace the journal with the window, carrying live-only items, new epoch.

On any refusal, timeout or anomaly during publication: reopen and send the window again. There is no other recovery.

Two sub-options for the window and the comparison:

- **A-min (replace on every open).** Simplest, but each wake rewrites up to a window, and a replacement discards older history the Relay had prepended. A Host that is offline then cannot serve it until it is back. Not recommended as the only rule.
- **A-mid (recommended).** The comparison above, done by the Relay, which already holds the index and the digests. The Controller no longer needs the index, so index paging, `reset`, `index_too_large`, `stale_epoch` and the Controller-side digest memoisation go. A wake with identical history is a no-op, so retained older history survives the common case.

For a quota, the Relay trims a `replace` to the newest items that fit its budget plus the live-only items, and says how many it dropped. That replaces the 2,000/200/20 ladder and the `quota_exceeded` loop on replacement.

### 2.4 What collapses

| Today | Under A-mid |
|---|---|
| Quota windows and `quotaStep`, `forceReplace`, `incomplete` streak, `olderBlocked` | One rule: the Relay trims a replacement to fit. `incomplete` remains as one persisted flag: "accept only a replacement" (this is the invariant that stops a hole) |
| Reset open (`resetOpen`, `index_too_large`) | Gone: the Controller never reads the index |
| Per-item skip and renumbering (`skipped`, `refusedItems`, `checked`, `ITEM_REFUSALS`, `withoutItem`, `namesItem`) | One local validation before sending (the wire-size check that already exists in `journal-items.ts`); a per-item refusal from the Relay drops that item from the window and reopens |
| `replace_loop` guard (`replaceStreak`, `MAX_REPLACEMENTS_IN_A_ROW`) | Gone: a replacement is an ordinary outcome, not an anomaly. A flapping Controller is bounded by backoff |
| Corrections and abandon (`correct`, `seal`, `expectedRevision`, `stale_revision`, open and complete as a reconcile state, `planReconcile`'s `correct` and `abandon` lists) | Gone. An open item whose history now differs triggers a replacement. `complete` stays only so that the digest exists for the comparison |
| The live-only ordering rule (adoption of a native copy only where the order agrees: the extra planner run per live-only item in `planPublication`) | Gone. The Relay carries live-only items through a replacement (already implemented); a reread that also contains one replaces the journal's copy |
| The empty and forced replacement distinction (never publish an empty rewrite; a forced one may be empty; read older pages first) | One rule: never replace with an empty window unless native history is exhausted |
| Rebind re-sending (`unacknowledgedRebinds`, `carriedRebinds`, `MAX_UNACKNOWLEDGED_REBINDS`, `remember`) | Gone: a replacement carries the current bindings; a live rebind for an item the Relay does not hold is passed over and the next replacement carries it |
| `outcome` re-sending after each reconcile (`outcomeOps`) | Stays: backgrounds learned after the rows were published are not in a reread |
| Content alignment between live and reread forms, byte for byte (P1-C2) | Becomes a quality metric, not a gate. A mismatch costs a replacement, which the client absorbs |

What a failure of A-mid costs: a replacement. Before, it cost a recovery path.

### 2.5 Bandwidth, writes and visible behaviour

- **Bandwidth.** The Controller sends the whole window on each open, not an index and deltas. The window fits one message (4 MiB cap). A wake of an unchanged session costs the window upstream once. If this proves too much for sessions with large tool outputs, the Controller can send keys and digests first and bodies only for what the Relay lacks. That is the same exchange as today with the planner moved to the Relay; do it only if measured.
- **Writes.** A no-op or an append writes only what changed. A replacement rewrites up to one window in chunks of 256 KiB, once per open at worst.
- **Visible behaviour.** For a client that sets the flag: no blank frame, no label, unchanged rows kept. After a replacement the client holds only the new tail window and asks for older history again on scroll. A person reading far above the tail when a replacement happens may lose scroll position. A client without the flag gets today's behaviour (reset once), which is the transition path.
- **Worst case equals today.** Today's crude open reloads the latest 100 entries every time.

### 2.6 Client work

- Entries gain an optional `itemKey` behind an opt-in channel flag; the Relay already has the key in the item index and puts it on projected entries in `journal-pages.ts` (about 30 lines).
- `timelineEntryKey` uses the item key for flagged sessions. It has 8 production call sites (`App.tsx`, `session-communication.ts`, `timeline-search.ts`, `remote-session-client.ts`, `timeline-render-model.ts`, `TimelineSearch.tsx`, `AgentTimeline.tsx`, the export in `index.ts`). Trace, search jumps and source references use the key; P1-D Decision 7 kept the old format for them. They must accept the new format.
- Reducer: a replacement for a flagged session does not clear entries; it marks the epoch pending, and the arrival of the new tail aligns by key, reusing objects when content is equal.
- The pending-message ledger compares `message.epoch === state.timeline.epoch` (`remote-session-client.ts:482`); it must survive an epoch change.
- The device store keys a window by epoch and `nextSeq`. A stored window with an old epoch is restored for display, then replaced by the new tail with key alignment. No schema change.
- Estimate: about 250 to 400 production lines and a comparable amount of tests.

### 2.7 Interaction with P1-D

- P1-D Decision 9 (the replica clears, `retainedDisplay` holds the last display) becomes a true one-step replacement by key instead of a visual patch. Rewrite its replacement task.
- P1-D Task 4 ("no holes in the window, rows keep their identity") exists because corrections make an `after` page return an item older than the client's window. If `correct` is gone, that source of holes is gone; amendments change items in place at their own sequence. The fold rule shrinks to a safety check. Verify before deleting it.
- The stored record, write-behind, preload, labels and T1 tasks are unchanged.
- P1-D's risk note ("a row is re-keyed if an adapter changes an item's native id") disappears for flagged sessions, because the key is the item key.

### 2.8 Estimated deletions

| File | Today | After | Change |
|---|---:|---:|---:|
| `agent-host/src/journal-publication.ts` | 990 | about 560 | -430 |
| `agent-host/src/journal-reconcile.ts` | 180 | about 90 | -90 |
| `agent-host/src/journal-items.ts` | 148 | about 120 | -30 |
| `agent-remote-journal/src/reconcile.ts` and `session-journal.ts` (`correct`, `seal`, state branches) | 83 and 621 | about 40 and 500 | -165 |
| `agent-remote-hosted/src/host-journals.ts` (index pages, reset, quota ladder support, fence) | 727 | about 580 | -150 |
| `journal-index-pages.ts`, index parts of `journal-uplink.ts`, protocol (2 messages, `reset`, 4 reasons, 2 entry types) | 20, 283, 192 | | -150 |
| Relay-side comparison in the core (new) | 0 | about 80 | +80 |
| **Production total** | | | **about -1,000 to -1,400** |

Tests fall by about 2,000 to 2,500 lines (`journal-publisher.test.ts` is 1,334 lines, `journal-reconcile` tests 393, `host-journals-bounds.test.ts` 682, part of `journal-amendments`, `journal-robustness`).

The publisher goes from 36 mutable fields to about 18, and from 14 recovery paths to about 5 (reopen with backoff; refused open; head cannot be encoded; identity breach; Relay trims or unserves on a hard quota).

Client work adds about 250 to 400 lines, so the net is roughly -700 to -1,100.

### 2.9 Risks

- The no-op comparison depends on equal digests between a live-built item and its reread. With A-mid a mismatch causes a replacement, not a bug, but frequent mismatches on one provider would make replacements frequent. Measure replacements per open per provider in the one-provider step.
- A replacement discards older prepended history. A person reading it while the Host is offline is affected only when a replacement happens.
- Part of Lever A's value assumes that sessions interrupted mid-stream are rare enough that dropping an unsealed partial item is acceptable. Section 7 asks the owner.
- The wire flag adds one more opt-in to the protocol surface; it is the single protocol addition and replaces more than it adds.

---

## 3. Lever B: the Relay issues session control

### 3.1 Today

The Controller owns session control. Each Controller stream has a lease with a random revision and a token (`agent-remote-relay/src/session-control.ts`). A native-owner change clears tokens and changes the revision. A mutation carries the token. P1-B2 keeps that and hides the Controller from the read path, so the Relay has to cover for it. P2 plans to move token issue to the Relay. This section asks what disappears if that comes first.

### 3.2 Shims that disappear

| Shim (P1-B2 decision) | Lines | Gone if the Relay issues control? |
|---|---:|---|
| Pending control revision `relay-pending`; held acquires rewritten to the Controller's real revision (`heldControl`, `flushControl`, `controlRevision`) | about 70 | Yes. The Relay's own lease is the revision |
| Holding and answering acquires while the Controller stream opens | included above | Yes |
| Offline-Host amendment: answer an acquire with the pending state, `waitingForHost`, `hostReturned` 1012 close, the `session_control` answer in `ensureHost`'s error branch | about 60 across the stream, `journal-sessions.ts` and the broker | Yes. An acquire is granted by the Relay; a mutation is queued or shown as waiting for the Host |
| Refusal classes (429 close, hopeless 4xx, offline, other) | about 40 | Mostly. A mutation still needs a Controller, so the refusal of a mutation remains, but reads and control never depend on it |
| `restoring` override and the `agent_update` on ready | about 30 | Yes, once sends are queued by the Relay (P2, T4). Before P2, current composers still wait on `restoring`, so the override stays until then |
| Interaction hold | about 90 | Not through Lever B alone. See 3.3 |

Gross deletion: about 250 production lines, plus about 400 test lines (`journal-session-stream.test.ts` 563 and `-amendments` 179, parts of `broker-journal-sessions.test.ts` 401).

The Relay must gain what it now borrows: a lease per journal-served stream (revision, token, access) and the native-owner rule. That is about 100 to 150 lines, similar to the Controller's 99-line registry. Net deletion on its own is therefore small, about 100 to 150 lines. The value is elsewhere: the Controller leaves the read and control path entirely, which is the design's principle 2, and P1-C3 Task 7 (reopening the Controller stream after a native resume so a journal-served browser can take control) is no longer needed in that form.

### 3.3 The interaction hold is a separate, cheaper fix

The hold parks the Controller's `interaction_requested`, `interaction_resolved` and `interaction_invalidated` frames until the served head agrees. The reducer already takes `pendingInteractions` from every Snapshot and `agent_update` (`applyAgentSnapshot`). If a journal-served stream stops forwarding the Controller's interaction frames and the head is the only source of pending interactions, the race (head older than frame) cannot occur, and the hold, its timers and its 64-frame bound go. The publisher already sends a head with a changed pending interaction urgently.

I did not verify that no client behaviour depends on the dedicated frames (a notification, a sound, attention). That check is the prerequisite. It does not need Lever B and could go in the first cleanup step if the check passes.

### 3.4 Prerequisites

1. **Every Controller is updated.** The Controller must accept a mutation vouched for by the Relay instead of a per-stream token. The owner must be told when every Controller has to update, and crude mode for old Controllers keeps today's path until then. This is the owner's rule: compatibility only through an upgrade.
2. **A mutation envelope the Controller can trust.** The uplink is authenticated per Host. The Relay already authorizes every request with `sessionAllowed`, `hostAllowed` and `requireOwner`, and stamps the requester. The Controller needs to take the requester from the envelope and keep its own checks (a session cannot answer its own request or loosen its own permissions, `session-routes.ts`; recent sign-in for permission changes). This is the P2 operation envelope; Lever B should not invent a second one.
3. **The native owner stays at the Controller.** The Controller detects a native owner change and publishes it (in the head's presence). The Relay revokes its tokens and refuses mutations. The Controller checks again at delivery (`native-owner-admission.ts`) and answers `native_session_owned` for a mutation that raced the change. A take-over is a mutation of its own kind that the Controller executes (interrupt, then resume); the Relay shows it as pending.
4. **Unchanged clients keep working.** They still send `acquire` and expect `session_control` frames with a revision and a token. The Relay produces those frames, so no client change is needed. The client rule that a `session_control` with its `requestId` resolves an acquire stays valid.

### 3.5 Risks

- It is security-sensitive: the Controller stops checking a token it issued. The safe shape is "Relay-vouched envelope plus the Controller's own owner and requester checks", not "no checks".
- Terminal-driven sessions: a mutation that races a native owner appearing is the case to test over real transports.
- Rollback: while a Host has any old Controller, the Relay must still forward the old flow. Two paths exist until the last Controller updates.
- Only half of the gain arrives before P2's queue: sends still wait on `restoring` and the composer still depends on connection state until T4 lands.

### 3.6 B-lite

A smaller change achieves part of the effect without moving the lease: let the Controller treat an `acquire` that names `relay-pending` as "whatever the current revision is" and keep refusing when a native owner exists. That deletes the Relay's `heldControl` rewrite (about 70 lines) for a few Controller lines. It needs every Controller updated too, and it is throwaway once the Relay owns the lease, so I would only take it if Lever B is delayed past P1-C3.

### 3.7 Estimate

Gross -250 production lines, net about -100 to -150 after the Relay's own lease. Plus the avoided P1-C3 Task 7 shims. Most of the value is moving P2 forward, not deletion.

---

## 4. Lever C: scale and deployment mechanisms

Rule: keep what correctness needs; freeze what only matters at a scale nobody has measured; remove what duplicates an invariant that exists.

| Mechanism | Verdict | Why |
|---|---|---|
| Grant levels `journal=1` and `journal=2`, per-connection enforcement, capability wait and retry, `VERSION_ONE_PARTITION` | **Remove** (about 120 lines) | Nothing shipped with `journal=1`; compatibility only through an upgrade. One version, checked at the handshake |
| Head index load epoch and the three-read discard | **Remove the discard** (about 60 lines); keep the in-memory head set | A false positive already self-corrects: a journal-served stream that finds no head calls `unserve` and closes with 1012, so the client reconnects crude (P1-B3a Decision 7). A false negative serves crude, which is safe. The machinery guards only a case that is already safe |
| `quotaFenced` | **Remove after checking** (about 25 lines and tests) | A refused entry never consumes its sequence, so every later entry of that generation is already refused as `sequence_gap`. The fence changes the reason to `quota_exceeded`. Verify with the existing sequence-gap test |
| Durable deletion pool (four workers, batched confirmation, bound 1,024, wait on restore) | **Simplify** (about -80 lines) | Keep `journalDeletions` and a retry; make deletion idempotent and sequential. The bound, the pool and batching answer a scale (many Hosts revoked at once) that does not exist |
| Shared budget of 64 messages and 16 MiB | **Keep the byte cap, drop the rest** | `send` throws past 16 MiB buffered on the uplink (`host_backpressure`), so a byte cap is correctness. The 64-message count is arbitrary |
| Head lane (headroom of 16 messages and 2 MiB) | **Remove** (about 60 lines) | Nothing measured shows contention. One in-flight message per session already bounds a head's wait to one acknowledgement. Under Lever A, long prepend streams shrink as well |
| Four open slots | **Remove** (about 30 lines) | They bound index pulls. With no index pull, an open is one small message |
| Index paging to 100,000 items, 2,000-entry pages, `index_too_large`, reset open | **Removed by Lever A** (counted there) | If A is not done, replace with a hard cap that a journal above it is not served |
| Journal cache (64 journals, 128 MiB) and per-Host usage maps | **Freeze** | A cache bound is needed on a Relay. Measure the hit rate before tuning. On Node the store is synchronous and fast; a smaller or absent cache is possible |
| Retention window (latest 50 turns or 200 items), incremental eviction | **Keep** | It is the design's retention rule |
| Byte quotas per session (64 MiB) and per Host (1 GiB); eviction ladder to 5, 1, 0 turns | **Keep the caps, simplify the ladder** | A cap is correctness. The ladder (evict to 5 turns, then 1, then 0) could be a single "evict to the retention window, then refuse" |
| 100,000-item cap and the 2,000 live-only cap | **Keep the live-only cap; drop the item cap** with the index | Live-only items are the only copy and need a bound; the item cap exists only for the index message |
| Cloudflare partition: `estimateCloneBytes`, reply halving, 2-journal cache, 24 MiB bound, recorded contract JSON, journals-enabled wrangler files | **Freeze** | Production is Cloudflare, so the partition is needed, but it is not deployed and nobody has measured a real reply. Do not extend it or tune it; revisit with the first real data. If tool outputs are capped inline (the design's large-output rule), the estimator can go |
| Smart-reading switch per Host and provider | **Keep** | It is the rollback path while crude mode stays |
| Publisher chunk caps (4 MiB, 256 entries), `MAX_*` constants | **Keep** | They keep a message encodable |
| Backfill and read-only observation (P1-C3 Tasks 4 and 6) | **Defer** | Both answer T2 first-open misses and terminal-driven currency. Decide after the one-provider measurement shows how often a first open has no journal |

Estimated deletion for Lever C outside Lever A: about 380 production lines (grant 120, head-index discard 60, fence 25, deletion simplification 80, head lane 60, open slots 30) and about 600 test lines. Cloudflare's roughly 330 production lines are frozen, not removed.

---

## 5. What happens to the roadmap's carried notes

| Note carried to later plans | Fate |
|---|---|
| P1-D: measure under latency against the same runner | Unchanged. Stays |
| P3: preemption skips streams with no Controller stream | Unchanged; superseded by P3's retirement of the live budget |
| P1-C: paged index, quota and evicted bodies | The paged index is removed by Lever A. Quota becomes "the Relay trims a replacement". Fills of evicted bodies stay |
| P1-C: an incomplete journal takes a replacement before any head | Stays as the one persisted `incomplete` flag |
| P1-C: contiguous sequences and per-item refusals | Contiguity stays. Per-item skip and renumber is replaced by a local check and "drop the item and reopen" |
| P1-C: a journal whose index is too large | Gone: no index goes to the Controller |
| P3: use-based retention (windows, sweep, retries, prepended eviction, orphan sweep) | Keep the windows and sweep; retries and the orphan sweep shrink with idempotent deletion. Not before measurement |
| P1-B2 and P1-D: no holes in a client's window | Mostly gone with `correct`. Keep the check only as a client safety rule |
| P1-B3: bounds and deletion | See Lever C |
| P1-C: chunk large rereads | Stays |
| P1-C: advertise diagnostic delivery 4 | Done |
| P1-C: amendments and runtime events | Done. `rebind` and `outcome` stay |
| P1-C: forwarded frames and older heads | Removed if the interaction frames stop being forwarded (3.3) |
| P1-C: native owners of journal-served sessions | Lever B |
| P1-C: validate rows before batching | Stays; under Lever A it is the only per-item rule |

Eight of fourteen notes shrink or disappear under the levers. None grows.

---

## 6. Process causes and rules

### 6.1 Why reviews added guards instead of removing causes

Observed on this branch:

1. **The fallback was expensive, so nobody reached for it.** Every review of the incremental path asked "what if this fails?" The honest answer was always "replace", and replace was the one thing the client could not afford. Each finding therefore got a local guard. 40 fix commits followed, adding 1,985 production lines against 753 removed (and the removals were mostly rewrites of the same feature).
2. **Plans carry code, so a plan is a design frozen too early.** P1-C1 is 10,090 lines for about 1,700 production lines. 12 to 17 numbered decisions per plan, most adding state. Landing a mechanism was a task; removing one was never a task.
3. **"Each task leaves the repository green" prevents cross-task deletion.** A guard added in task 4 cannot be removed by task 9 even when task 9 makes it unnecessary.
4. **Failure scenarios were imagined, not observed.** No provider declares the capability. The scenarios (index of 100,000 items, a quota ladder, 64 in-flight messages) have no recorded occurrence.
5. **Reviewers had no deletion mandate.** A review asks for correctness; "this could be deleted" was never the question.
6. **One decision shaped three layers without being questioned.** "A new epoch is a reset" drove the Relay design (avoid replacement), the Controller design (digests, corrections, index) and the adapter design (byte-exact equality). Nobody owns a decision that spans layers.

### 6.2 Rules for future work

1. **State accounting.** Every plan decision and every fix commit states "State: +N fields, -M. Paths: +N, -M." A change that adds without removing says why in one sentence. The reviewer checks the sentence.
2. **Invariant before guard.** For each failure a review names, first ask: what invariant makes it impossible, or what single fallback makes it harmless? Only if neither exists, add a guard, and cite the failure's reachability (a log, a recorded fixture, a reproducible test over a real transport). An imagined failure gets a comment and the universal fallback, not a branch.
3. **One universal fallback per protocol.** Name it in the design ("reopen and replace with the newest window that fits"). Any special case needs a measured reason that the fallback is too expensive.
4. **Complexity budgets.** A module declares a budget in its header: at most N mutable fields, N recovery outcomes, N protocol message types. `SessionPublication` should be at most 20 fields and 6 recovery outcomes. A change over budget needs a deletion elsewhere or the owner's approval.
5. **Prototype and measure before planning.** A one-day spike with the real provider on `pnpm local` comes before a plan. The plan's gate is real data, not a fake provider. Plans stay under 1,000 lines and give interfaces, not code.
6. **Scale mechanisms need a measurement record.** A bound, pool, lane, cache or ladder cites a measurement in the plan (as P0 does for the client) or becomes one hard cap with a refusal.
7. **Protocol surface budget.** A new message, entry type, refusal reason or flag must replace one, or the plan states why it cannot.
8. **A deletion task in every plan.** The last task lists what earlier plans made unnecessary and removes it. Skipped only with a reason.
9. **A layer-spanning decision has an owner and a re-check.** When a plan depends on a client or protocol property ("epoch change is a reset"), the plan states it as a decision with its cost and the alternative of changing it.
10. **Reviews ask two questions.** "What can go wrong" and "what can this make unnecessary".

---

## 7. Recommendation

### 7.1 Steps, in order

Each step is shippable on its own and keeps the repository green (tests, `pnpm compatibility:update`, `pnpm compatibility:check`; Lab on Node 22). Nothing in these steps enables journals for a user: no provider declares the capability yet.

**Step 0. Freeze and adopt the rules.** No new journal mechanism, no P1-C2 plan work, until step 2 lands. The plan for P1-C2 that another agent is rewriting should wait for step 2: its central contract (byte-exact digests between live and reread) is what Lever A relaxes. Deletes nothing. Needs the owner's approval.

**Step 1. Remove dead and duplicate pieces (about -300 lines, about -500 test lines).**
- Grant levels and the capability wait and retry (about 120).
- Head-index three-read discard (about 60).
- `quotaFenced`, after confirming the `sequence_gap` test covers it (about 25).
- Durable deletion simplified to idempotent sequential retries (about 80).
- If the check in 3.3 passes: stop forwarding interaction frames on journal-served streams and delete the hold (about 90, with a small publisher change).
Needs: nothing. Order within the step is free. Needs the 3.3 verification for the last item only.

**Step 2. Lever A, server half (about -1,000 to -1,400 lines, about -2,000 to -2,500 test lines).**
- The Controller sends its window on open; the Relay compares (identical, extended, otherwise replace); a replacement is trimmed by the Relay to fit.
- Delete `correct`, `seal`, `expectedRevision`, index paging, reset open, the quota ladder, `incomplete` streaks, per-item skip and renumber, `replace_loop`, rebind re-sending, the live-only adoption by order.
- Update fixtures, the protocol README and the design's reconcile text.
Needs: step 1 is not required, but the head lane and open slots go here too (about -90). Must land before any provider is enabled. A client without item keys sees a reset on each replacement, as today.

**Step 3. P1-C2 for one provider under the relaxed contract.**
- The adapter supplies keys, completion marks and live-only marks. The continuity fixture reports content mismatches as a count, not a failure.
- Pick the provider whose identities are simplest. The plan's order starts with OpenCode; Claude needs three separate content alignments, so it should come last.
- Enable on `pnpm local` with the smart-reading switch on and measure: replacements per open, bytes per open, first-open misses.
Needs: step 2. Deletes nothing; it avoids the digest-alignment work of the other three providers.

**Step 4. P1-D with Lever A, client half (about +250 to +400 client lines, minus P1-D's Task 4 fold work).**
- Item keys on entries behind an opt-in flag; rows keyed by item key for flagged sessions; replacement absorbed by key; pending-message ledger survives an epoch change.
- Rewrite the replacement parts of the P1-D plan before executing it.
- Measure T1, T2 and T6 against the P0 baselines under 4x CPU and 100 ms round trip, with today's path as the control group.
Needs: steps 2 and 3 (a real journal-served session to test against).

**Step 5. Relay-owned session control, as the first slice of P2 (about -250 gross, -100 to -150 net).**
- The Relay's lease and the Relay-vouched mutation envelope (the P2 operation envelope, not a second one).
- Delete the pending revision, held acquires, offline-Host amendment, `hostReturned`, the `restoring` override once sends are queued.
Needs: every Controller updated; tell the owner when. It replaces P1-C3 Task 7.

**Step 6. Remaining providers, P1-C3, P3.**
- Remaining providers under the relaxed contract.
- P1-C3: the read-only history capability and behind-marking first; defer backfill and observation until step 3's measurement shows first-open misses.
- P3: the retention sweeps and idempotent deletion as already simplified.

### 7.2 Revised roadmap order

| Order | Plan | Change from the roadmap |
|---|---|---|
| 1 | Freeze, rules, removals (steps 0 and 1) | New |
| 2 | Lever A server half (step 2) | New, before any provider |
| 3 | P1-C2, one provider | Was all four; relaxed contract |
| 4 | P1-D with item-key absorption | Was "device store with epoch stability" |
| 5 | Relay-owned session control, with the first P2 slice | Was late in P2; moved ahead of P1-C3 |
| 6 | P1-C2 remaining providers, P1-C3 reduced | Backfill and observation deferred |
| 7 | P2 operation queue (rest) | After control |
| 8 | P3 scheduling | Unchanged, with simplified retention |
| 9 | P4 and P5 | Unchanged |

Why this order: Lever A first because it removes the failure modes that the providers would otherwise exercise; one provider before the rest because it is the first real data; P1-D after the server half because the client change needs the keys; control before P1-C3 because P1-C3 builds on the shims control removes.

### 7.3 Expected end state, against today

| Measure | Today | After steps 1 to 5 |
|---|---:|---:|
| Journal production lines, server side | about 6,480 | about 4,700 to 4,900 |
| Including new client work | | about 5,100 to 5,300 |
| Test lines | about 12,500 | about 8,500 to 9,500 |
| `SessionPublication` mutable fields | 36 | about 18 |
| Publisher recovery paths | 14 | about 5 |
| Entry operations | 10 | 8 (no `correct`, no `seal`) |
| Refusal reasons | 10 | about 6 |
| Open refusal reasons | 3 | 1 |
| Controller to Relay messages that carry an index | 2 | 0 |
| Per-provider requirement | byte-exact live and reread digest equality | stable keys, completion and live-only marks |
| Journal grant levels | 2 | 1 |

The deletions add up as: step 1 about 300 to 390, step 2 about 1,000 to 1,400 (the lower number nets out the Relay-side comparison), step 5 about 100 to 150 net, plus about 90 of head lane and open slots. Roughly 1,600 to 2,000 net lines fewer on the server, about 350 more on the client.

### 7.4 What stays complex regardless

- Generation fencing, contiguous sequences, the rule never to serve a hole, durable-before-fan-out and acknowledgement.
- Live-only items and their carry through a replacement.
- Fills, older history, eviction, retention and hard quotas, including their interaction with a replacement.
- The publisher's live path: batching, head ordering, flow control on an uplink that drops.
- Resource ids that survive a restart and amendments (`rebind`, `outcome`).
- The Node and Cloudflare split, including the 32 MiB RPC bound.
- The read path for unchanged clients until crude mode is removed, then less.
- Native-owner semantics, especially for terminal-driven sessions.
- Provider adapters: keys per item type per provider, and the rule that a provider that breaks the identity contract stops its journal.

About 45 percent of today's code is this and should be expected to stay.

---

## 8. What I am unsure about

1. **All numbers are from reading, not from a prototype.** Line counts per mechanism are by function and judged; the category totals (45, 11, 19, 14, 8, 3 percent) are plus or minus 10 points. The deletion estimates for Lever A are the least certain, because they assume the Relay-side comparison needs about 80 lines and that `correct` can be removed without breaking the amendments that depend on it.
2. **The earlier headline of 19 mutable fields** is lower than what I count (36 private non-readonly fields in `SessionPublication`). I may be counting timers, queues and caches that the earlier figure left out. The recovery paths are 14 by my list; the earlier figure was about 10.
3. **Lever A and the client.** I read the reducer and the row key function, not the full conversation rendering (scroll anchoring, search, trace). The item-key row key may touch more places than the 8 call sites found. A one-day client spike should confirm before step 4.
4. **Dropping `seal`.** If a person must keep a partial item that native history never recorded, `seal` and the live-only carry of sealed items stay (about 60 lines). Crude mode loses such an item today.
5. **Interaction frames (3.3).** I did not verify that no client behaviour needs the dedicated `interaction_*` frames when the head carries the same information.
6. **`quotaFenced` (Section 4).** I judged it redundant with contiguity from reading `host-journals.ts` and the plan, not from running the test.
7. **Bandwidth of A-mid.** I assumed windows of at most one 4 MiB message are acceptable per open. P0 sessions were tiny; a long session with large tool outputs may not be, in which case keys and digests go first.
8. **Cloudflare.** The partition is not deployed. Nothing about its real reply sizes or latency is known; "freeze" is a judgement, not a measurement.
9. **P1-C2 and P1-D** are plans, not code. Savings there are avoided work, not deletions, and I did not size them.
