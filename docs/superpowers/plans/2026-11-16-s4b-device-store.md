# S4b: the device store, labels, T1 and the return budget

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. This plan states interfaces, deletions and acceptance tests, not full code.

**Depends on** [S4a](2026-11-16-s4-client-absorbs-replacements.md) having landed: item keys, `pendingEpoch`, absorption by key, the latency proxy and the control results. **Supersedes**, with S4a, `2026-11-15-p1d-client-device-store.md` and `2026-11-15-p1d2-client-measurement.md`; S4a section 1 lists what survives here.

**Goal.** A conversation this device opened before shows its rows from the first frame, with no blank timeline and no opening label; a return with live sockets makes at most 2 HTTP requests; T1 and T2 are measured at 4x CPU and 100 ms round trip against P0 and the control. Stored content is private to the principal that read it.

**Commands.** As in S4a: per-test and outer deadlines, Node 22 for lab tests, rebuild packages dependents import, local checks per `prepare-arc-local` with `ARC_LOCAL_JOURNALS=1`.

---

## 1. The device store (IndexedDB)

Kept from the old plan: `browser-database.ts` (database `agent-remote-image-drafts`, version 3; the upgrade only creates `sessions` and `session_index` and never opens a cursor on `drafts` or `images`; the 11 places that open it at version 2 open it without a version), `session-record.ts`, `device-store.ts` with its own subpath `@orchardworks/agent-remote-web/device-store`, preload at start with the application chunk waiting at most one second, write-behind of 50 ms (the lab's observer writes at most once per 2 s per session and on page hide), pinning of mounted sessions, and the entry chunk's gzip budget.

**What it caches.** One record per public session: agent id, the journal `epoch` and `nextSeq` of the last applied page, `hasOlder`, the newest entries (at most 200 and 1 MiB of JSON, each with its `itemKey` when it has one), the last Snapshot without `activeTurn`, `pendingInteractions` and `runtimeInfo.connection`, and the update time. A window whose newest entry alone exceeds the limit is not stored.

**Keyed by principal.** The key is `JSON.stringify([relayUrl, principalId, [hostId, providerId, nativeSessionId]])`. A record of another principal on the same Relay URL is never read, written or listed.

**Keyed by epoch and sequence, and why the stored cursor is safe.** A record's position is `(epoch, nextSeq)`. On connect the client asks for `after` `{epoch, nextSeq - 1}`. The journal's epoch survives Relay restarts and changes only on a replacement. A cursor that is wrong for any reason (an epoch the Relay no longer holds, a sequence beyond its head, a trimmed range) gets a page with `staleCursor`; S4a's reduction turns that into `replaced`, and the tail is merged by key. A stored cursor therefore cannot produce a hole or a wrong row: it either continues exactly or becomes a replacement.

**A replacement invalidates nothing visibly.** The record is a display cache validated by the connection's first page: confirmed (same epoch) or replaced by key (S4a 3.4). Nothing is deleted before content arrives. `restoredFromDevice` is set when the replica is seeded and cleared when the first page confirms or replaces it. The save after each applied page rewrites the record in the new epoch's coordinates.

**Last write wins.** Two tabs may save one session; the later `save` wins and the next connection validates it.

**Bounds.** One byte cap on the disk records, evicting whole least-recently-used unpinned records, and one preload budget in bytes. They start at 32 MiB and 4 MiB and Task 5 replaces them with measured values (record bytes of the S3 session and of a 150-item session, preload time per MiB at 4x CPU, the browser's granted storage). A quota error evicts least-recently-used records until the write fits and retries once; a second failure keeps the content in memory. Nothing reaches the interface.

**Older history** reads through `readTimeline` (the session wire for a transport that recovers over it, HTTP otherwise), so a journal-served session scrolls back without its Controller; the timeline search keeps its own admission budget at the Relay.

## 2. Privacy (decided)

- **Principal scope** as above.
- **Rows show only while the auth lease is valid.** The preload and the first render read the store only when the locally known lease has not expired. When it has, stored rows stay hidden until `GET /auth/status` confirms the lease; if it fails, nothing is shown and the records are purged. A lease that expires while rows are shown hides them and runs the same check.
- **Purge** every record on sign-out, on a principal change, on a lost access to a session (old Task 10a), and on "Clear cache on close" (memory copies only when that preference is on).
- **The old localStorage display cache is deleted.** `packages/agent-remote-lab/src/workspace-cache.ts` (keys `agent-remote:recovery:<scope>:workspace*`, six sessions, 150 entries, no principal) goes with its readers (`readWorkspaceSnapshot` and `workspaceDisplayState` in `App.tsx`, `EarlierConversation.tsx`, `useSessionSuccession.ts`, `SessionConversation.tsx`, and `workspace-display-cache.ts`'s save path), which read the device store instead. At start the store's preload removes any key with that prefix once; that removal is the only remaining reference to the old keys and is dropped one release later (the roadmap records it).
- Tests: a record of principal A is invisible to principal B on the same Relay URL; an expired lease shows no stored row and a failed check purges; sign-out and a principal change leave no record and no old localStorage key; a lost access forgets its record.

## 3. Labels while rows are held (T1)

The old label rule gains S4a's pending replacement. While rows are shown and not yet confirmed current, because they came from the store (`restoredFromDevice`) or a replacement is pending (`pendingEpoch !== null`), `Opening session`, `Synchronizing` and `Checking access` give way to the session's last business label. A `disconnected` connection is never hidden. A conversation with no rows at all (a first open on this device) shows the neutral empty conversation shell with no connection word. The other T5 labels stay P2's. Replica +1 field (`restoredFromDevice`).

## 4. The return budget: at most 2 HTTP requests

P0 counted 14 requests on every return with both sockets alive: `auth/status`, `teams`, `controller-release`, `session-migrations`, `favorites`, `successions`, `relations`, `hosts`, per Host `previews`, `vscode-tunnel`, `session/refs`, `tpm`, plus `GET /` and `POST session-reads`. Each list loader listens for `visibilitychange` or the page-resume signal.

**Invariant instead of a guard.** A list loader does not refetch because the page became visible. It refetches (a) on mount, (b) on its own timer while visible (its current interval, or 5 minutes where it has none), and (c) when the shared feed socket reopens. `watchPageResume` keeps two jobs: confirm the access lease (`GET /auth/status`, the first request; it also serves section 2) and ping the sockets so a socket a suspended browser kept alive is found dead and reopened, which triggers (c). The second request is the `session-reads` mark.

- A list changed on another device while this one was hidden shows its old value until the loader's next tick; conversation content is current through the sockets.
- The budget applies while sockets are alive. The dead-socket case (the proxy closes every WebSocket while hidden) is recorded without a budget.
- Task 3 starts with an inventory of every `visibilitychange`, `pageshow`, `online` and `watchPageResume` listener in the lab (`App.tsx` ~288 and ~1568, `GatewayController.tsx`, `session-references.ts`, `TeamMenu.tsx`, `HostCodexDaemon.tsx`, `Toast.tsx`, `recovery-writes.ts`, `workspace-display-cache.ts` and the rest of the grep), saying for each: refetch (removed), write-out on hide (kept), or UI-only (kept).

## 5. Measurement

Arms, conditions, proxy, journal-served signal and sample counts are S4a section 5. Scenarios added here:

| Scenario | Target | Counted or timed | Pass |
|---|---|---|---|
| `open-known` (reload, then navigate by URL) | T1 | opening-label states, row-less states, `contentSinceMountMs` | 0 opening-label and 0 row-less states (maximum over all samples, every condition); content within 100 ms (p95) at 4x CPU |
| `open-fresh` (device storage cleared, journal exists) | T2 | `contentSinceAttachMs`, since navigation, journal-served flag | 500 ms p50 and 1,500 ms p95 at 4x CPU and 100 ms; no slower at p50 than the control; at least 20 journal-served samples per condition. The attach still reaches the Controller until S5; T2's "without reaching the Controller" is S5's gate |
| `return` (30 s hidden; 300 s frozen; sockets closed while hidden) | T3 budgets | HTTP requests by endpoint, opening-label states, time until current | at most 2 requests while sockets are alive, 0 opening-label states, current within 1 s (p95) |
| `switch` | none | warm switch, opening-label states, HTTP requests | 0 opening-label states warm; recorded |

The store's caps come from the same runs. Results go to `2026-11-16-s4b-results.md` with build, machine, date, sample counts and the P0, control and S4 columns; a miss is recorded, not worked around.

## 6. Tasks

1. **Database, record and store.** Section 1, from old P1-D Tasks 1 to 3, with the principal key, last-write-wins and the single cap. `fake-indexeddb` tests: an upgrade that preserves drafts and images, trimming, write-behind, quota, pinning, preload, principal isolation.
2. **Restore and catch-up.** `replica` restore with `restoredFromDevice`, `readTimeline`, search admission at the Relay (`broker.ts` and its test). Tests over a fake transport: same epoch continues with only an `after` request; a stale cursor becomes `replaced` and the tail merges by key; older history over the socket.
3. **The return budget.** Section 4: inventory first (committed as a table in the results file), then the invariant. Lab test counting `fetch` over a simulated hide and return with live fake sockets: at most 2, both named; a dead socket reopens the feed and its loaders refetch once; a timer still refreshes.
4. **Lab: store, privacy, labels.** Sections 2 and 3; the old Tasks 8, 9, 10, 10a; delete `workspace-cache.ts` and move its readers (section 2). Counted-state tests for a mounted-from-store conversation and a first open.
5. **Acceptance tests and measurement.** Real transports: a journal-served Relay fixture with a fake Controller (`journal-relay.ts`): a record in epoch E1, the Relay in E2, rows on the first frame, restored rows that are unchanged stay mounted, no frame without rows, no connection word; an expired lease shows nothing; a hide and return stays within the budget. Real browser (Playwright): a reload of a known conversation shows rows in the first frame and no label; a hide and return under a fetch counter stays within the budget. Then the runs of section 5, the caps, and the results file.
6. **Deletions, documents, the local check.** Delete: `workspace-cache.ts` and its keys (one-release purge noted), the localStorage preview paths of `workspace-display-cache.ts`, listeners that refetch on visibility, tests that pin a blank frame, a label flash or the six-session preview. Documents: `web.md` (store schema, privacy), the performance README, the roadmap. Local check with Copilot journal-served: reload shows rows at once and no "Opening session"; hide and return makes at most 2 requests; sign out and in as another account shows no stored rows of the first; a Controller restart keeps rows (S4a); record the evidence.

## 7. State accounting and budgets

| Area | Fields | Paths |
|---|---|---|
| Device store | 5 inside one module (records, index, pinned set, write queue, quota flag); 2 constants (byte cap, preload budget) | +1 (quota: evict and retry once); the old plan's five limits -5 |
| Replica | +1 (`restoredFromDevice`) | 0 |
| Lab | the localStorage display cache -1 module (six sessions, its index and keys); visibility listeners -N | refetch on every visibility change -1 |
| Wire | 0 | 0 |

Client budgets: one disk cap and one preload budget, each cited to a measurement; memory copies are what the preload loaded plus mounted sessions; no timer in the store, writes only after a change; the entry chunk stays within its gzip budget. A number raised above its measured value says why in the results file or goes to the owner.

## 8. Risks and what is not in S4b

- Lists can be stale for up to their interval after a return; the dead-socket case refetches.
- A purge on a failed lease check discards the cache for a network blip that fails the check; the next open reads through the Relay as a first open.
- Not in S4b: the attach shortcut (S5), connection labels beyond the narrow rule (P2), demand leases and retention (P3), the Controller's item keys (S6).

## 9. Results

Recorded in [2026-11-16-s4b-results.md](2026-11-16-s4b-results.md): section 4 of the results (after review): T1 met (0 opening-label, 0 row-less states), the return budget met in every condition (2 requests against 13 to 14), T2 p50 of 500 ms missed at 100 ms round trip in both arms; departures listed there. The lease gate shows stored rows on the cached lease until its own expiry.
