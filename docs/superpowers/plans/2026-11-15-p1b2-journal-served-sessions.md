# P1-B2 Journal-served sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For a session whose journal exists with a head, the hosted Relay answers the browser's read path from the journal, so the Controller is no longer on it. The Relay answers `negotiate` with `negotiated` and the Snapshot from the journal head, acknowledges `timeline_subscription`, answers `timeline_request` from the journal (asking the Controller to fill evicted bodies and to read older history when needed), and fans out live rows, replacements and head changes to subscribers. Operations, session control and every other message still reach the Controller, through a Controller stream the Relay opens in the background. A session without a journal head behaves exactly as today. No production path enables journals until P1-B3 and P1-C, so this plan is exercised only by tests and by a fake Controller.

**Architecture:** Four small modules in `agent-remote-hosted`, each with one job, and a thin delegation in `broker.ts`. `host-journals.ts` and `journal-uplink.ts` (landed in P1-B1) gain the two things fan-out needs: an ordered list of what subscribers see for each stored publication (`events`) and `status` (cursor and head). `journal-host-stream.ts` opens and owns the Controller stream (today's `stream_open` path) as a port with a sink, so a journal-served browser stream never waits for it. `journal-session-stream.ts` is the per-browser-stream protocol: negotiation, Snapshot, subscription, pages, live frames, activity observation, and the routing of every other message to the Controller stream. `journal-sessions.ts` owns what is shared per session: the subscriber registry fed by the broker's publication handling, the single in-flight fill and older-history read, and whether older history may still exist. `broker.ts` gains the gating (does a journal with a head exist?), the delegation (`acceptJournalServed`) and a shared per-message admission function extracted from the existing stream code.

**Tech Stack:** TypeScript 5.7 (ES2022, Node16 modules, strict, `noUncheckedIndexedAccess`), TypeBox through `@orchardworks/agent-remote-protocol`, Vitest 4.1.11, pnpm workspace.

**Design reference:** `docs/superpowers/specs/2026-11-15-im-session-service-design.md`, sections Architecture (Data flows), Session journal, Answering the client protocol in smart mode, and Failure handling. Roadmap: `docs/superpowers/plans/2026-11-15-im-session-service-roadmap.md` (row P1-B, and "Notes carried to later plans"). Predecessor: `2026-11-15-p1b1-relay-journal-service.md`, which must have landed completely (`host-journals.ts`, `journal-uplink.ts`, the broker grant and dispatch, `requestFill`, `requestOlder`).

**Commands.** Every test command below sets a per-test deadline (`--testTimeout`). Run each with an outer deadline: the Bash tool timeout of at most 300000 ms. Hosted tests import `@orchardworks/agent-remote-protocol` and `@orchardworks/agent-remote-journal` from `dist`; this plan changes neither package, so only the final verification rebuilds anything.

**Decisions made in this plan** (not stated in the design or the brief):

1. **The gate is the store, not the live capability.** A session is journal-served when `journals.status(hostId, "${providerId}:${nativeSessionId}")` reports a head. The Host's `journal` handle exists only while its Controller is connected (it is never persisted), and reads must work while the Host is offline, so the capability cannot be part of the gate. A journal with a head can only have been published by a journal-capable Controller. P1-B3 adds the persisted per-provider switch ("smart reading off") in front of this gate. A journal with rows but no head is not served: crude mode applies until the Controller publishes a head.
2. **`timeline_subscribed` carries no cursor.** The brief asks for it, but `TimelineSubscriptionResponse` is `{ requestId, agentIds }` and is strict. A new field would be a protocol change for no gain: the client learns the journal cursor from the page `window` and from the live rows' `epoch` and `seq`, as it does today. The acknowledgement is sent before any live row, exactly as `session-wire.ts` does.
3. **The Relay shows a pending control state and rewrites its revision.** `negotiated` must say `sessionControl: true` (mutations need a token; `requireSessionControl` is set by every Lab client). In `remote-session-client.ts` the first `session_control` frame is what makes the client request control, and `beginSocketRecovery` holds the timeline load back until then. Waiting for the Controller's frame would put the Controller back on the read path and leave reads unavailable while the Host is offline. So after the Snapshot the Relay sends a `session_control` of its own (`read_only`, not available, revision `relay-pending`). The client then asks to acquire control with that revision. The Relay holds the request until the Controller stream reports its real revision (its first `session_control`, which is forwarded to the client like every later one), rewrites the revision in the request, and forwards it. Tokens, revisions after that point and native owners are still the Controller's; the Relay issues nothing (P2 moves token issue to the Relay).
4. **The Relay negotiates the Controller stream itself.** The browser's `negotiate` is answered locally and never forwarded. When the Controller stream opens, the Relay's own `negotiate` is its first message (the session wire refuses everything before it). The Controller's `negotiated` and Snapshot are dropped like the other read-path frames.
5. **The Controller stream opens at negotiation, lazily and again on demand.** Activity observers (`observation: "activity"`) never open one; they cannot operate. For other streams it opens as soon as negotiation completes and again when an operation arrives and no stream is open. A stream that fails to open answers every message waiting for it with a recoverable `protocol_error` carrying the message's `requestId` and the failure's code (`host_offline`, `session_attach_failed`, `session_stream_capacity`, …). A Controller stream that ends (the Host disconnected, the share was revoked, the Controller closed it) closes the browser stream with the same code, as in crude mode: the client then reconnects, reads from the journal at once, and redoes control with the new Controller connection, whose tokens are per connection.
6. **Runtime state for current clients.** Until the Controller stream is ready, every Snapshot and `agent_update` sent from a head carries `runtimeInfo.connection = { state: "restoring" }`. `AgentComposer` then has `ready === false` and `canWait === true`, so sends wait in the client's pending queue. When the Controller stream becomes ready, the Relay sends one `agent_update` from the current head with no override, so the state never sticks even if the head was published before the stream was ready.
7. **Identity.** The Snapshot served from the head has its `id` replaced by the public session id; the head's other fields, including `attention.cursor`, are served as published (the Controller publishes a head in P1-C that is consistent with the journal's epoch).
8. **What subscribers receive.** `JournalPublished` gains `events`, ordered as applied: `row` for each appended row, `replaced` for a new epoch, `head` for a head that was not already applied. Correction rows and prepended rows are in `rows` but never in `events`, so they are never sent live. A correction consumes a sequence number, so the client sees a gap and fetches `after`, whose page carries the corrected entry. **The roadmap's client-side window-hole issue** (an `after` page can return a corrected item whose `seqStart` is older than the client's window, so the client's next older page could skip history) **is handled in P1-D**; P1-B2 adds no client flag and no filtering.
9. **Pages.** Tail and `after` pages never wait for the Controller. A page whose items lack bodies asks the Controller to fill them, in chunks of at most `JOURNAL_FILL_MAX_ITEMS`. Fills are chained per session, so one is in flight at a time and each stream's own keys are requested. A page takes at most `ceil(limit / JOURNAL_FILL_MAX_ITEMS) + 1` rounds, and stops early when a round makes no progress. A `before` page that reaches the journal's start while older history may exist asks the Controller for older history (one request per session at a time, `limit` is the page limit capped at `JOURNAL_OLDER_MAX_LIMIT`), then answers again. "May exist" is true until a Controller answers `olderAvailable: false`; that is remembered in memory for the session and reset on a replacement. If a fill cannot be done the client gets a recoverable `timeline_unavailable` protocol error; if older history cannot be read the page is served as the journal holds it. A requested page limit is capped at 500.
10. **Activity observers** are served from the head and the journal cursor: `agent_activity` carries the status derived from the head as `session-wire.ts` derives it and the journal cursor (not the head's attention cursor, which is in the Controller's epoch). Content bursts are coalesced into one update per 500 ms as the session wire does.
11. **Rationing.** A journal-served stream holds no Controller stream slot while it only reads. Its Controller stream, once opened, is an entry in `host.streams` and counts against the per-Host and per-account stream limits like any other; a stream that would exceed them is refused for operations only.
12. **Admission is shared.** The per-message limits and authorization of a browser stream (binary refusal, rate windows, reauthentication, owner-only resource resolution, credential expiry) move unchanged from `accept` into `admitClientMessages`, which both the crude path and the journal-served path call before anything else, so a locally answered `timeline_request` is limited and authorized exactly like a forwarded one.
13. **Unchanged routes.** `GET /v1/sessions/:id/snapshot` and `/timeline` keep going to the Controller. The browser reads pages over the WebSocket (`timelineRecovery: 'websocket'`), which this plan serves.
14. **Frames dropped from the Controller stream** are `negotiated`, `agent_snapshot`, `agent_update`, `agent_stream`, `agent_activity`, `timeline_subscribed`, `timeline_page`, `timeline_replacement` and `timeline_resource_binding_replaced` (its epoch and sequence belong to the Controller's timeline; the journal has no amendment path yet). Everything else, including interaction and resource frames, is forwarded.

---

**Amendments from the plan owner** (they override the code below where they differ):

- **Offline Host and session control.** While the Host is offline, a current client's automatic acquire must not send it into a reconnect loop. How `packages/agent-remote-web/src/client/remote-session-client.ts` treats an acquire:
  - It has no operation deadline of its own. But `fetchTimeline` waits for it (`controlReady`) before it clears the 20-second connection deadline. An acquire held unanswered while the Host is offline therefore makes the client reconnect every 20 seconds with a `connection_timeout` diagnostic.
  - When it is refused with a `protocol_error` carrying its `requestId`, the client reconnects at once (`restartDisconnected`, then its normal backoff). The one exception is the code `session_control_changed`.
  - A `session_control` frame carrying its `requestId` resolves it, whatever access the frame states. The client then reaches `ready` read-only. Until it holds a token, it refuses mutations itself (`session_read_only`).

  So, in Task 5:
  - While the Controller stream is opening, a held acquire waits as Decision 3 says.
  - Suppose the Controller stream cannot open because the Host is offline (refusal code `host_offline`). Each held `acquire` is then answered with the Relay's pending control state, carrying its `requestId`: `read_only`, not available, revision `relay-pending`, no token. Held `take_over` requests and every other held message are refused with the recoverable `protocol_error`, as in Decision 5. While the Host stays offline, a later `acquire` naming the pending revision is answered the same way at once. The stream remembers that it is waiting for the Host.
  - Other failures to open (`session_attach_failed`, `session_stream_capacity`, …) are refused as in Decision 5. The client reconnects with its backoff, as it does from a crude stream, and so retries until the condition clears.
  - When the Host's Controller connects again, every journal-served stream of that Host that is waiting for it closes with 1012 `Remote Host reconnected`. The client reconnects once and acquires control over the new Controller stream. `JournalSessions.hostReturned(hostId)` does this (Task 5); the broker calls it where it sets `host.ready = true` (Task 6).
- **Why the Controller stream could not open.** Each failure is handled as crude mode handles it, but reads keep working wherever crude mode would not have stopped retrying. `HostStreamRefusal` carries the HTTP `status` and the `nativeOwner` of the broker's error. Its capacity refusal has status 429.
  - `host_offline`: as above.
  - Capacity (status 429): the browser stream closes with `SESSION_CAPACITY_CLOSE_CODE` and the refusal's message, as `sessionSubscriptionRefusal` does. Hidden views then pause, and active views say why they wait and retry with their backoff.
  - Any other 4xx except 408 (for example `native_session_owned`, `session_unavailable` or `workspace_unavailable`) cannot be helped by retrying. Held `acquire` requests are answered with the pending state, which includes `nativeOwner` when the refusal has one. Every other held message is refused with a `protocol_error` whose `recoverable` is false. The stream stays open for reads and does not retry by itself. The next message that needs the Controller tries again.
  - 5xx, 408 and failures without a status are refused with a recoverable `protocol_error`, as Decision 5 says. The client reconnects with its backoff, as it does after a crude 1013.
- **Follow-ups recorded in the roadmap**, not built here:
  - Resource-binding amendments, and non-timeline `agent_stream` events, reach journal-served clients in P1-C.
  - The head's `attention.cursor` uses the journal epoch (P1-C).
  - Gating without a store read per stream open (P1-B3).

## File structure

| File | Responsibility |
|---|---|
| `packages/agent-remote-hosted/src/host-journals.ts` | Modify: `JournalLiveEvent`, `JournalStatus`, `JournalPublished.events`, `HostJournals.status`. |
| `packages/agent-remote-hosted/src/host-journals.test.ts` | Modify: tests for events and status; one expectation gains `events`. |
| `packages/agent-remote-hosted/src/journal-uplink.ts` | Modify: `published` option called with every stored publication. |
| `packages/agent-remote-hosted/src/journal-uplink.test.ts` | Modify: test for `published`. |
| `packages/agent-remote-hosted/src/journal-host-stream.ts` | New: `HostStreamEntry`, `HostStreamOpener` and the Controller stream port. |
| `packages/agent-remote-hosted/src/journal-host-stream.test.ts` | New: tests with a fake context. |
| `packages/agent-remote-hosted/src/journal-session-stream.ts` | New: the per-browser-stream read-path protocol. |
| `packages/agent-remote-hosted/src/journal-session-stream.test.ts` | New: tests over a real `SessionJournal` with fake sockets. |
| `packages/agent-remote-hosted/src/journal-sessions.ts` | New: subscriber registry, shared fill and older-history state, gating, `hostReturned`. |
| `packages/agent-remote-hosted/src/journal-sessions.test.ts` | New: `hostReturned`, chained fills, shared-state lifetime, late older-history answers. |
| `packages/agent-remote-hosted/src/broker.ts` | Modify: `admitClientMessages` extraction, gating, `acceptJournalServed`, wiring, `onReady` hook. |
| `packages/agent-remote-hosted/src/test-utils/journal-session-fixture.ts` | New: in-memory transports, a fake Controller and a browser helper. |
| `packages/agent-remote-hosted/src/broker-journal-sessions.test.ts` | New: end-to-end tests over the in-memory transport and the session channel. |
| `packages/agent-remote-hosted/src/index.ts` | Modify: export the two new types. |
| `packages/agent-remote-lab/compatibility.json` | Generated. |

Protocol fixtures and schemas: no wire message changes in this plan (it uses messages that exist today and none of the journal uplink messages change), so no fixture entry is needed; the tests in Task 6 are the contract for the served frames.

---

### Task 1: The live events of a publication and the status of a journal

**Files:**
- Modify: `packages/agent-remote-hosted/src/host-journals.ts`
- Modify: `packages/agent-remote-hosted/src/index.ts`
- Test: `packages/agent-remote-hosted/src/host-journals.test.ts`

- [ ] **Step 1: Write the failing tests.** In `packages/agent-remote-hosted/src/host-journals.test.ts`, inside `describe('createHostJournals', …)` after the test `'stores the head and reports the new epoch of a replacement'`, add:

```ts
  it('lists what subscribers see, in order: appended rows, replacements and new heads, but no corrections or prepends', async () => {
    const { journals, store } = fixture();
    await openSession(journals, HOST, SESSION, 'controller-1');
    const first = await journals.publish(HOST, SESSION, 1, [
      append(1, 'm1', 'Hello'), complete(2, 'm1'),
      { sequence: 3, op: 'head', head: { snapshot, observedAt: 5 } }, append(4, 'm2', 'World'),
    ]);
    expect(first.events).toEqual([
      { kind: 'row', row: expect.objectContaining({ itemKey: 'm1', seq: 1 }) },
      { kind: 'head', head: { snapshot, observedAt: 5 } },
      { kind: 'row', row: expect.objectContaining({ itemKey: 'm2', seq: 2 }) },
    ]);
    const revision = (await store.load(KEY))!.items.find(item => item.itemKey === 'm1')!.revision;
    const second = await journals.publish(HOST, SESSION, 1, [
      { sequence: 5, op: 'correct', row: row('m1', 'Hello!'), digest: 'digest-new', expectedRevision: revision },
      { sequence: 6, op: 'prepend', items: [{ row: row('m0', 'Earlier'), digest: 'digest-m0' }] },
    ]);
    expect(second.rows).toHaveLength(2);
    expect(second.events).toEqual([]);
    const third = await journals.publish(HOST, SESSION, 1, [{ sequence: 7, op: 'replace', items: [{ row: row('x1', 'Fresh'), digest: 'digest-x1' }] }]);
    expect(third.events).toEqual([{ kind: 'replaced', epoch: third.replacedEpoch }]);
  });

  it('does not report a head of a publication it already applied', async () => {
    const { journals } = fixture();
    await openSession(journals, HOST, SESSION, 'controller-1');
    const entries: JournalPublishEntry[] = [{ sequence: 1, op: 'head', head: { snapshot, observedAt: 5 } }];
    expect((await journals.publish(HOST, SESSION, 1, entries)).events).toHaveLength(1);
    expect((await journals.publish(HOST, SESSION, 1, entries)).events).toEqual([]);
  });

  it('reports the cursor and head of a session, and nothing for a session without a journal', async () => {
    const { journals } = fixture();
    expect(await journals.status(HOST, SESSION)).toBeUndefined();
    const opened = await openSession(journals, HOST, SESSION, 'controller-1');
    expect(await journals.status(HOST, SESSION)).toEqual({ cursor: { epoch: opened.epoch, seq: 0 } });
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello'), { sequence: 2, op: 'head', head: { snapshot, observedAt: 5 } }]);
    expect(await journals.status(HOST, SESSION)).toEqual({ cursor: { epoch: opened.epoch, seq: 1 }, head: { snapshot, observedAt: 5 } });
  });
```

In the same file change the expectation of the test `'refuses a fenced generation and a session that was never opened, without changing anything'`:

```ts
    expect(unopened).toEqual({ rows: [], watermark: 0, refusal: { sequence: 5, reason: 'fenced' } });
```

to

```ts
    expect(unopened).toEqual({ rows: [], events: [], watermark: 0, refusal: { sequence: 5, reason: 'fenced' } });
```

- [ ] **Step 2: Run them and see them fail.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/host-journals.test.ts --testTimeout=10000`
Expected: FAIL: `first.events` is `undefined` (the `toEqual` comparison fails), `journals.status is not a function`, and the changed expectation fails because `events` is missing.

- [ ] **Step 3: Implement.** In `packages/agent-remote-hosted/src/host-journals.ts`:

Add `type JournalHead` to the import from `@orchardworks/agent-remote-journal` (the import list currently ends with `type JournalIndexEntry, type JournalPageRequest, type JournalPageResult, type JournalPublication, type JournalRow, type JournalStore,`):

```ts
  type JournalHead, type JournalIndexEntry, type JournalPageRequest, type JournalPageResult, type JournalPublication, type JournalRow, type JournalStore,
```

After the `JournalRefusal` interface add:

```ts
/** What a subscriber of the session sees of a publication, in the order its entries were applied. */
export type JournalLiveEvent =
  /** An appended row; it is delivered live with its epoch and sequence. Corrections and prepended rows are never events. */
  | { kind: 'row'; row: JournalRow }
  /** A replacement started a new epoch. */
  | { kind: 'replaced'; epoch: string }
  /** A head that was not already applied. */
  | { kind: 'head'; head: JournalHead };

/** The journal's cursor, and its head once the Controller has published one. */
export interface JournalStatus {
  cursor: TimelineCursor;
  head?: JournalHead;
}
```

In `JournalPublished`, after the `rows` property add:

```ts
  /** What live subscribers see of the publication, in order. */
  events: JournalLiveEvent[];
```

In the `HostJournals` interface, before `forget`, add:

```ts
  /** The cursor and head of the session's journal, or undefined when it has none. */
  status(hostId: string, sessionKey: string): Promise<JournalStatus | undefined>;
```

In `apply`, replace the `append` case:

```ts
      case 'append': { const row = journal.append(publication, entry.row); if (row) published.rows.push(row); break; }
```

with

```ts
      case 'append': { const row = journal.append(publication, entry.row); if (row) { published.rows.push(row); published.events.push({ kind: 'row', row }); } break; }
```

replace the line `        if (epoch !== before) published.replacedEpoch = epoch;` with

```ts
        if (epoch !== before) { published.replacedEpoch = epoch; published.events.push({ kind: 'replaced', epoch }); }
```

and replace `      case 'head': journal.setHead(publication, entry.head); break;` with

```ts
      case 'head': {
        const fresh = (journal.publisher?.watermark ?? 0) < entry.sequence;
        journal.setHead(publication, entry.head);
        const head = journal.head;
        if (fresh && head) published.events.push({ kind: 'head', head });
        break;
      }
```

In `publish`, replace

```ts
      const fenced = (): JournalPublished => ({ rows: [], watermark: 0, refusal: { sequence: entries[0]?.sequence ?? 0, reason: 'fenced' } });
```

with

```ts
      const fenced = (): JournalPublished => ({ rows: [], events: [], watermark: 0, refusal: { sequence: entries[0]?.sequence ?? 0, reason: 'fenced' } });
```

and replace `      const published: JournalPublished = { rows: [], watermark: 0 };` with

```ts
      const published: JournalPublished = { rows: [], events: [], watermark: 0 };
```

In the returned object, before `forget`, add:

```ts
    status: (hostId, sessionKey) => serialized<JournalStatus | undefined>(hostId, async () => {
      const journal = await load(hostId, sessionKey, false);
      if (!journal) return undefined;
      const head = journal.head;
      return { cursor: journal.cursor, ...(head ? { head } : {}) };
    }),

```

In `packages/agent-remote-hosted/src/index.ts` extend the line that exports from `./host-journals.js` with `type JournalLiveEvent` and `type JournalStatus`:

```ts
export { createHostJournals, type HostJournals, type HostJournalsOptions, type JournalFilled, type JournalLiveEvent, type JournalOpened, type JournalOpenRefusal, type JournalPublished, type JournalRefusal, type JournalStatus } from './host-journals.js';
```

- [ ] **Step 4: Run the tests and see them pass.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/host-journals.test.ts --testTimeout=10000`
Expected: PASS for every test in the file.

- [ ] **Step 5: Typecheck.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted run typecheck`
Expected: exit code 0. (`journal-uplink.test.ts` builds a `JournalPublished` without `events`, but test files are excluded from `tsc`; Task 2 fixes that literal.)

- [ ] **Step 6: Commit.**

```bash
git add packages/agent-remote-hosted/src/host-journals.ts packages/agent-remote-hosted/src/host-journals.test.ts packages/agent-remote-hosted/src/index.ts
git commit -m "feat(hosted): report what subscribers see of a journal publication and the status of a session journal" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Hand every stored publication to the broker

**Files:**
- Modify: `packages/agent-remote-hosted/src/journal-uplink.ts`
- Test: `packages/agent-remote-hosted/src/journal-uplink.test.ts`

- [ ] **Step 1: Write the failing test.** In `packages/agent-remote-hosted/src/journal-uplink.test.ts`:

Change the `fixture` signature and its `createJournalConnection` call so a test can observe publications:

```ts
function fixture(options: { journals?: HostJournals; diagnostic?(event: 'journal_message_unencodable' | 'journal_store_failed'): void; published?(sessionKey: string, result: JournalPublished): void } = {}) {
```

and in the `createJournalConnection({ … })` call add `published: options.published,` after `diagnostic: options.diagnostic,`.

Change the import `import { createHostJournals, type HostJournals } from './host-journals.js';` to

```ts
import { createHostJournals, type HostJournals, type JournalPublished } from './host-journals.js';
```

In the test `'does not send a message that fails to encode and reports it'` change the stub to include `events: []`:

```ts
    const broken: HostJournals = { ...base, publish: async () => ({ rows: [], events: [], watermark: -1, cursor: { epoch: 'e', seq: 0 } }) };
```

Inside `describe('a journal connection', …)` add:

```ts
  it('hands every stored publication to the broker, also after the connection is no longer current, but not a fenced one', async () => {
    const reported: Array<{ sessionKey: string; events: number; cursorSeq?: number }> = [];
    const f = fixture({ published: (sessionKey, result) => reported.push({ sessionKey, events: result.events.length, cursorSeq: result.cursor?.seq }) });
    await f.open();
    await f.publish([{ sequence: 1, op: 'append', row: row('m1', 'Hello') }]);
    f.endConnection();
    await f.publish([{ sequence: 2, op: 'append', row: row('m2', 'World') }]);
    expect(reported).toEqual([{ sessionKey: SESSION, events: 1, cursorSeq: 1 }, { sessionKey: SESSION, events: 1, cursorSeq: 2 }]);
    await f.publish([{ sequence: 3, op: 'append', row: row('m3', 'Fenced') }], 9);
    expect(reported).toHaveLength(2);
  });

  it('keeps a stored publication acknowledged when the broker fails to hand it on', async () => {
    const f = fixture({ published: () => { throw new Error('subscriber failed'); } });
    await f.open();
    await f.publish([{ sequence: 1, op: 'append', row: row('m1', 'Hello') }]);
    expect(f.sent.at(-1)).toMatchObject({ type: 'journal_ack', watermark: 1 });
  });
```

- [ ] **Step 2: Run it and see it fail.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/journal-uplink.test.ts --testTimeout=10000`
Expected: FAIL: `reported` is `[]` in the first new test (the option is ignored).

- [ ] **Step 3: Implement.** In `packages/agent-remote-hosted/src/journal-uplink.ts`:

Change `import type { HostJournals, JournalFilled } from './host-journals.js';` to

```ts
import type { HostJournals, JournalFilled, JournalPublished } from './host-journals.js';
```

In `JournalConnectionOptions`, after `diagnostic?(…)`, add:

```ts
  /**
   * Called with the result of every publication the journal stored, after the store holds it and whether or not this
   * connection is still current: the rows are durable, so subscribers must see them. A failure here changes nothing.
   */
  published?(sessionKey: string, result: JournalPublished): void;
```

In `receive`, in the `journal_publish` case, replace

```ts
          const result = await journals.publish(hostId, sessionKey, generation, message.entries);
          if (!options.current()) return;
```

with

```ts
          const result = await journals.publish(hostId, sessionKey, generation, message.entries);
          try { options.published?.(sessionKey, result); }
          catch { /* A subscriber's failure does not undo a stored publication. */ }
          if (!options.current()) return;
```

- [ ] **Step 4: Run the tests and see them pass.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/journal-uplink.test.ts src/host-journals.test.ts --testTimeout=10000`
Expected: PASS for both files.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-hosted/src/journal-uplink.ts packages/agent-remote-hosted/src/journal-uplink.test.ts
git commit -m "feat(hosted): hand every stored publication to the broker for fan-out" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: The Controller stream of a journal-served session

**Files:**
- Create: `packages/agent-remote-hosted/src/journal-host-stream.ts`
- Test: `packages/agent-remote-hosted/src/journal-host-stream.test.ts`

The module is the broker's existing `stream_open` path as a port: it registers an entry in the Host's `streams` map (so the broker's `stream_opened`, `stream_message` and `stream_close` handlers, Host disconnect and share revocation keep working unchanged) whose `socket` is a virtual one that forwards to a sink instead of to a browser.

- [ ] **Step 1: Write the failing tests.** `packages/agent-remote-hosted/src/journal-host-stream.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { createHostStreamOpener, HostStreamRefusal, type HostStreamContext, type HostStreamEntry, type HostStreamSink } from './journal-host-stream.js';

function fixture(overrides: Partial<Pick<HostStreamContext, 'recover' | 'capacity' | 'write'>> = {}) {
  const streams = new Map<string, HostStreamEntry>();
  const written: Array<Record<string, unknown>> = [];
  const timers = new Map<number, () => void>();
  const diagnostics: string[] = [];
  let nextTimer = 0;
  const opener = createHostStreamOpener({
    streams, publicAgentId: 'public-1', runtimeAgentId: () => 'runtime-1', subject: 'alice', authorized: () => true,
    recover: overrides.recover ?? (async () => undefined), capacity: overrides.capacity ?? (() => undefined),
    write: message => { overrides.write?.(message); written.push(message as unknown as Record<string, unknown>); },
    scheduler: { setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout: timer => { timers.delete(timer as number); } },
    openTimeoutMs: 30_000, diagnostic: details => diagnostics.push(details.event),
  });
  const seen = { frames: [] as string[], ready: 0, ended: [] as Array<[number, string]> };
  const sink: HostStreamSink = { frame: raw => seen.frames.push(raw), ready: () => { seen.ready += 1; }, ended: (code, reason) => seen.ended.push([code, reason]) };
  /** What the broker does when the Controller accepts the stream. */
  const accept = () => {
    const [streamId, entry] = [...streams][0]!;
    entry.ready = true;
    for (const buffered of entry.buffered) written.push({ uplinkVersion: 2, type: 'stream_message', streamId, message: buffered });
    entry.buffered = [];
    entry.onReady?.();
  };
  return { opener, streams, written, timers, diagnostics, seen, sink, accept };
}

const cancel = JSON.stringify({ type: 'cancel', payload: { agentId: 'public-1', requestId: 'r1' } });

describe('a Controller stream', () => {
  it('registers an entry, rewrites identities and holds messages until the Controller accepts the stream', async () => {
    const f = fixture();
    const stream = await f.opener.open(f.sink);
    const [streamId, entry] = [...f.streams][0]!;
    expect(f.written).toEqual([{ uplinkVersion: 2, type: 'stream_open', streamId, sessionId: 'runtime-1' }]);
    expect(entry).toMatchObject({ publicAgentId: 'public-1', runtimeAgentId: 'runtime-1', subject: 'alice', ready: false });
    expect(f.diagnostics).toEqual(['stream_opening']);
    stream.send(cancel);
    expect(f.written).toHaveLength(1);
    f.accept();
    expect(f.seen.ready).toBe(1);
    expect(f.written.at(-1)).toEqual({ uplinkVersion: 2, type: 'stream_message', streamId, message: JSON.stringify({ type: 'cancel', payload: { agentId: 'runtime-1', requestId: 'r1' } }) });
    stream.send(cancel);
    expect(f.written).toHaveLength(3);
  });

  it('passes the Controller\'s frames and its end to the sink', async () => {
    const f = fixture();
    await f.opener.open(f.sink);
    const [, entry] = [...f.streams][0]!;
    entry.socket.send('frame-1');
    expect(f.seen.frames).toEqual(['frame-1']);
    expect(entry.socket.readyState).toBe(1);
    entry.socket.close(1012, 'Remote Host disconnected');
    expect(f.seen.ended).toEqual([[1012, 'Remote Host disconnected']]);
    expect(entry.socket.readyState).not.toBe(1);
    entry.socket.send('late');
    expect(f.seen.frames).toEqual(['frame-1']);
  });

  it('refuses with the reason when the session cannot be recovered, a limit is reached or the Host cannot be written, and leaves nothing behind', async () => {
    const offline = Object.assign(new Error('The Remote Host is offline.'), { code: 'host_offline' });
    const recovery = fixture({ recover: async () => { throw offline; } });
    await expect(recovery.opener.open(recovery.sink)).rejects.toMatchObject({ code: 'host_offline', message: 'The Remote Host is offline.' });
    const full = fixture({ capacity: () => 'host' });
    await expect(full.opener.open(full.sink)).rejects.toMatchObject({ code: 'session_stream_capacity' });
    const account = fixture({ capacity: () => 'account' });
    await expect(account.opener.open(account.sink)).rejects.toBeInstanceOf(HostStreamRefusal);
    const unwritable = fixture({ write: () => { throw offline; } });
    await expect(unwritable.opener.open(unwritable.sink)).rejects.toMatchObject({ code: 'host_offline' });
    for (const each of [recovery, full, account, unwritable]) { expect(each.streams.size).toBe(0); expect(each.timers.size).toBe(0); }
  });

  it('carries the status and the native owner of the broker\'s refusal, and 429 for a reached limit', async () => {
    const nativeOwner = { kind: 'native_cli' as const, generation: 'g1' };
    const owned = fixture({ recover: async () => { throw Object.assign(new Error('The session is owned.'), { status: 409, code: 'native_session_owned', nativeOwner }); } });
    await expect(owned.opener.open(owned.sink)).rejects.toMatchObject({ code: 'native_session_owned', status: 409, nativeOwner });
    const full = fixture({ capacity: () => 'account' });
    await expect(full.opener.open(full.sink)).rejects.toMatchObject({ code: 'session_stream_capacity', status: 429 });
  });

  it('closes the stream and tells the Controller when the browser leaves', async () => {
    const f = fixture();
    const stream = await f.opener.open(f.sink);
    const [streamId] = [...f.streams][0]!;
    stream.close();
    expect(f.written.at(-1)).toEqual({ uplinkVersion: 2, type: 'stream_close', streamId, code: 1000, reason: 'Browser disconnected' });
    expect(f.streams.size).toBe(0);
    expect(f.timers.size).toBe(0);
    expect(f.seen.ended).toEqual([]);
    expect(() => stream.send(cancel)).toThrow(HostStreamRefusal);
  });

  it('never reports an end for a stream the browser closed, even when the broker closes its socket afterwards', async () => {
    const f = fixture();
    const stream = await f.opener.open(f.sink);
    const [, entry] = [...f.streams][0]!;
    stream.close();
    const closes = f.written.filter(message => message.type === 'stream_close').length;
    entry.socket.close(1008, 'Invalid Remote Host session identity');
    expect(f.seen.ended).toEqual([]);
    expect(f.written.filter(message => message.type === 'stream_close')).toHaveLength(closes);
  });

  it('ends the stream when the Controller does not accept it in time', async () => {
    const f = fixture();
    await f.opener.open(f.sink);
    [...f.timers.values()][0]!();
    expect(f.seen.ended).toEqual([[1013, 'Remote stream opening timed out']]);
    expect(f.streams.size).toBe(0);
    expect(f.written.filter(message => message.type === 'stream_close')).toHaveLength(1);
    expect(f.written.at(-1)).toMatchObject({ type: 'stream_close', code: 1000, reason: 'Browser disconnected' });
    expect(f.diagnostics).toEqual(['stream_opening', 'stream_open_timeout', 'stream_closed']);
  });

  it('holds at most 32 messages before the Controller accepts the stream', async () => {
    const f = fixture();
    const stream = await f.opener.open(f.sink);
    for (let at = 0; at < 32; at++) stream.send(cancel);
    let refusal: unknown;
    try { stream.send(cancel); } catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ code: 'host_stream_not_ready' });
  });
});

describe('a Controller stream and the Host\'s stream accounting', () => {
  it('counts against the per-Host and per-account limits while it is open and frees its slot when it ends', async () => {
    const streams = new Map<string, HostStreamEntry>();
    const limits = { host: 2, account: 1 };
    const make = (subject: string) => createHostStreamOpener({
      streams, publicAgentId: 'public-1', runtimeAgentId: () => 'runtime-1', subject, authorized: () => true, recover: async () => undefined,
      capacity: () => streams.size >= limits.host ? 'host' : [...streams.values()].filter(entry => entry.subject === subject).length >= limits.account ? 'account' : undefined,
      write: () => undefined, scheduler: { setTimeout: () => 0, clearTimeout: () => undefined }, openTimeoutMs: 30_000, diagnostic: () => undefined,
    });
    const sink: HostStreamSink = { frame: () => undefined, ready: () => undefined, ended: () => undefined };
    const first = await make('alice').open(sink);
    await expect(make('alice').open(sink)).rejects.toMatchObject({ code: 'session_stream_capacity' });
    await make('bob').open(sink);
    await expect(make('carol').open(sink)).rejects.toMatchObject({ code: 'session_stream_capacity' });
    first.close();
    await expect(make('alice').open(sink)).resolves.toBeDefined();
  });

  it('frees its slot when the Controller ends the stream, as the broker does by deleting the entry and closing the socket', async () => {
    const streams = new Map<string, HostStreamEntry>();
    const opener = createHostStreamOpener({
      streams, publicAgentId: 'public-1', runtimeAgentId: () => 'runtime-1', authorized: () => true, recover: async () => undefined,
      capacity: () => streams.size >= 1 ? 'host' : undefined, write: () => undefined,
      scheduler: { setTimeout: () => 0, clearTimeout: () => undefined }, openTimeoutMs: 30_000, diagnostic: () => undefined,
    });
    const sink: HostStreamSink = { frame: () => undefined, ready: () => undefined, ended: () => undefined };
    await opener.open(sink);
    await expect(opener.open(sink)).rejects.toMatchObject({ code: 'session_stream_capacity' });
    const [streamId, entry] = [...streams][0]!;
    streams.delete(streamId);
    entry.socket.close(1000, 'Closed by the Controller');
    await expect(opener.open(sink)).resolves.toBeDefined();
  });

  it('ends once and tells the Controller once when the broker closes the socket while the entry is registered', async () => {
    const f = fixture();
    const stream = await f.opener.open(f.sink);
    const [streamId, entry] = [...f.streams][0]!;
    entry.socket.close(1008, 'Invalid Remote Host session identity');
    expect(f.streams.size).toBe(0);
    expect(f.written.filter(message => message.type === 'stream_close')).toEqual([{ uplinkVersion: 2, type: 'stream_close', streamId, code: 1000, reason: 'Browser disconnected' }]);
    expect(f.seen.ended).toEqual([[1008, 'Invalid Remote Host session identity']]);
    expect(f.timers.size).toBe(0);
    stream.close();
    expect(f.written.filter(message => message.type === 'stream_close')).toHaveLength(1);
    expect(() => stream.send(cancel)).toThrow(HostStreamRefusal);
  });

  it('writes no stream_close of its own when access is revoked and the broker already removed the entry and told the Controller', async () => {
    const f = fixture();
    const stream = await f.opener.open(f.sink);
    const [streamId, entry] = [...f.streams][0]!;
    f.streams.delete(streamId);
    entry.socket.close(1008, 'Host share revoked');
    expect(f.streams.size).toBe(0);
    expect(f.seen.ended).toEqual([[1008, 'Host share revoked']]);
    expect(f.written.filter(message => message.type === 'stream_close')).toEqual([]);
    expect(f.timers.size).toBe(0);
    stream.close();
    expect(f.written.filter(message => message.type === 'stream_close')).toEqual([]);
  });

  it('ends with 1012 and does not throw when the Host disconnects while the entry is registered and the Host cannot be written', async () => {
    let offline = false;
    const f = fixture({ write: () => { if (offline) throw new Error('offline'); } });
    await f.opener.open(f.sink);
    offline = true;
    for (const entry of f.streams.values()) entry.socket.close(1012, 'Remote Host disconnected');
    f.streams.clear();
    expect(f.seen.ended).toEqual([[1012, 'Remote Host disconnected']]);
    expect(f.streams.size).toBe(0);
    expect(f.timers.size).toBe(0);
  });

  it('refuses a frame that pushes the held bytes over 1 MiB while fewer than 32 messages are held', async () => {
    const f = fixture();
    const stream = await f.opener.open(f.sink);
    const big = JSON.stringify({ type: 'cancel', payload: { agentId: 'public-1', requestId: 'x'.repeat(400 * 1024) } });
    stream.send(big);
    stream.send(big);
    expect(() => stream.send(big)).toThrow(expect.objectContaining({ code: 'host_stream_not_ready' }));
    expect(f.streams.values().next().value!.buffered).toHaveLength(2);
  });

  it('refuses a frame that addresses another session', async () => {
    const f = fixture();
    const stream = await f.opener.open(f.sink);
    const other = JSON.stringify({ type: 'cancel', payload: { agentId: 'someone-else', requestId: 'r1' } });
    expect(() => stream.send(other)).toThrow(expect.objectContaining({ code: 'invalid_session_target' }));
    expect(f.streams.values().next().value!.buffered).toHaveLength(0);
  });

  it('refuses a message the identity rewrite cannot read without holding it', async () => {
    const f = fixture();
    const stream = await f.opener.open(f.sink);
    expect(() => stream.send('not json')).toThrow();
    f.accept();
    expect(f.written).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it and see it fail.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/journal-host-stream.test.ts --testTimeout=10000`
Expected: FAIL: cannot resolve `./journal-host-stream.js`.

- [ ] **Step 3: Implement.** `packages/agent-remote-hosted/src/journal-host-stream.ts`:

```ts
import { randomUUID } from 'node:crypto';

import type { NativeSessionOwner, RemoteHostUplinkMessage } from '@orchardworks/agent-remote-protocol';

import { sessionIdentityMessage } from './session-identity.js';
import { RELAY_SOCKET_OPEN, type BrokerScheduler, type RelaySocket } from './transport.js';

/** The messages and bytes a stream holds for the Controller before it accepts the stream. */
const BUFFER_MAX_MESSAGES = 32;
const BUFFER_MAX_BYTES = 1024 * 1024;
const SOCKET_CLOSED = 3;
const encoder = new TextEncoder();

/** One session stream a Host holds open for a browser; the broker's `stream_*` handlers read and change these entries. */
export interface HostStreamEntry {
  publicAgentId: string;
  runtimeAgentId: string;
  socket: RelaySocket;
  subject?: string;
  authorized?(): boolean;
  ready: boolean;
  buffered: string[];
  timer?: unknown;
  /** Called by the broker after the Controller accepted the stream and the buffered messages were written. */
  onReady?(): void;
}

/** Where the frames of one Controller stream go. */
export interface HostStreamSink {
  /** A frame from the Controller session, addressed with the public session id. */
  frame(raw: string): void;
  /** The Controller accepted the stream. */
  ready(): void;
  /**
   * The stream ended: the Controller closed it, the Host went away, access was revoked, or it was never accepted.
   * Called once, and never after `HostStream.close()`.
   */
  ended(code: number, reason: string): void;
}

export interface HostStream {
  /**
   * Sends a frame addressed with the public session id; holds it until the Controller accepts the stream. Throws a
   * HostStreamRefusal (`invalid_session_target` when the frame addresses another session) or the Host write error.
   */
  send(raw: string): void;
  /** The browser left: ends the stream and tells the Controller. */
  close(): void;
}

export interface HostStreamOpener {
  /** Opens a stream; rejects with a HostStreamRefusal that names why not. */
  open(sink: HostStreamSink): Promise<HostStream>;
}

/**
 * Why a Controller stream could not be opened or written. `code` is the code a browser can show; `status` is the HTTP
 * status of the broker's refusal and `nativeOwner` the native owner it reported, when it had them.
 */
export class HostStreamRefusal extends Error {
  constructor(readonly code: string, message: string, readonly status?: number | undefined, readonly nativeOwner?: NativeSessionOwner | undefined) {
    super(message);
    this.name = 'HostStreamRefusal';
  }
}

export type HostStreamDiagnostic =
  | { event: 'stream_opening'; streamId: string; agentId: string }
  | { event: 'stream_open_timeout'; streamId: string }
  | { event: 'stream_closed'; streamId: string };

export interface HostStreamContext {
  /** The Host's open streams. */
  streams: Map<string, HostStreamEntry>;
  publicAgentId: string;
  /** The id the Controller knows the session by; read when the stream opens. */
  runtimeAgentId(): string;
  subject?: string;
  authorized(): boolean;
  /** Makes the Controller know the session; rejects with the reason when it cannot. */
  recover(): Promise<void>;
  /** Which stream limit is reached, if any. */
  capacity(): 'host' | 'account' | undefined;
  /** Writes to the Host's uplink; throws when the Host is offline or busy. */
  write(message: RemoteHostUplinkMessage): void;
  scheduler: BrokerScheduler;
  openTimeoutMs: number;
  diagnostic(details: HostStreamDiagnostic): void;
}

/** A refusal for an error from the broker: its code when it has one. */
function refusalOf(error: unknown): HostStreamRefusal {
  if (error instanceof HostStreamRefusal) return error;
  if (error instanceof Error) {
    const { code, status, nativeOwner } = error as { code?: unknown; status?: unknown; nativeOwner?: NativeSessionOwner };
    return new HostStreamRefusal(typeof code === 'string' ? code : 'host_unavailable', error.message, typeof status === 'number' ? status : undefined, nativeOwner);
  }
  return new HostStreamRefusal('host_unavailable', 'The Controller session is unavailable.');
}

export function createHostStreamOpener(context: HostStreamContext): HostStreamOpener {
  return {
    async open(sink) {
      try { await context.recover(); }
      catch (error) { throw refusalOf(error); }
      const full = context.capacity();
      if (full) {
        throw new HostStreamRefusal('session_stream_capacity', full === 'host'
          ? 'This Host has too many sessions open in browsers. Close session views you no longer use; operations on this session work again when a slot is free.'
          : 'Too many sessions are open across your browsers and devices. Close tabs, windows or session views you no longer use; operations on this session work again when a slot is free.', 429);
      }
      const streamId = randomUUID();
      let closed = false;
      const none = () => undefined;
      /** What a browser stream does when it ends: free the slot and tell the Controller, unless the broker already did. */
      const release = () => {
        context.scheduler.clearTimeout(entry.timer);
        if (context.streams.get(streamId) !== entry) return;
        context.streams.delete(streamId);
        context.diagnostic({ event: 'stream_closed', streamId });
        try { context.write({ uplinkVersion: 2, type: 'stream_close', streamId, code: 1000, reason: 'Browser disconnected' }); }
        catch { /* The Host may already be offline. */ }
      };
      const socket: RelaySocket = {
        get readyState() { return closed ? SOCKET_CLOSED : RELAY_SOCKET_OPEN; },
        bufferedAmount: undefined,
        send: data => { if (!closed) sink.frame(data); },
        close: (code = 1000, reason = '') => {
          if (closed) return;
          closed = true;
          release();
          sink.ended(code, reason);
        },
        onMessage: () => none,
        onClose: () => none,
        onError: () => none,
      };
      const entry: HostStreamEntry = {
        publicAgentId: context.publicAgentId, runtimeAgentId: context.runtimeAgentId(), socket,
        ...(context.subject === undefined ? {} : { subject: context.subject }), authorized: context.authorized,
        ready: false, buffered: [], onReady: () => sink.ready(),
      };
      context.streams.set(streamId, entry);
      context.diagnostic({ event: 'stream_opening', streamId, agentId: context.publicAgentId });
      entry.timer = context.scheduler.setTimeout(() => {
        context.diagnostic({ event: 'stream_open_timeout', streamId });
        socket.close(1013, 'Remote stream opening timed out');
      }, context.openTimeoutMs);
      try { context.write({ uplinkVersion: 2, type: 'stream_open', streamId, sessionId: entry.runtimeAgentId }); }
      catch (error) {
        context.scheduler.clearTimeout(entry.timer);
        context.streams.delete(streamId);
        closed = true;
        throw refusalOf(error);
      }
      return {
        send(raw) {
          if (closed) throw new HostStreamRefusal('host_stream_closed', 'The Controller session closed.');
          let outgoing: string;
          try { outgoing = sessionIdentityMessage(raw, entry.publicAgentId, entry.runtimeAgentId, 'client'); }
          catch { throw new HostStreamRefusal('invalid_session_target', 'The message addresses another session.'); }
          if (!entry.ready) {
            const held = entry.buffered.reduce((sum, value) => sum + encoder.encode(value).byteLength, 0);
            if (entry.buffered.length >= BUFFER_MAX_MESSAGES || held + encoder.encode(outgoing).byteLength > BUFFER_MAX_BYTES) {
              throw new HostStreamRefusal('host_stream_not_ready', 'The Controller session is not ready.');
            }
            entry.buffered.push(outgoing);
            return;
          }
          context.write({ uplinkVersion: 2, type: 'stream_message', streamId, message: outgoing });
        },
        close() {
          if (closed) return;
          closed = true;
          release();
        },
      };
    },
  };
}
```

- [ ] **Step 4: Run the tests and see them pass.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/journal-host-stream.test.ts --testTimeout=10000`
Expected: PASS, 16 tests.

- [ ] **Step 5: Typecheck.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted run typecheck`
Expected: exit code 0.

- [ ] **Step 6: Commit.**

```bash
git add packages/agent-remote-hosted/src/journal-host-stream.ts packages/agent-remote-hosted/src/journal-host-stream.test.ts
git commit -m "feat(hosted): open a Controller stream for a browser stream that reads from a journal" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Share the per-message admission of session streams

A pure refactor: the per-message limits and authorization of a browser session stream move from `accept` into one function that the crude path and (in Task 6) the journal-served path both call. Existing broker tests guard it.

**Files:**
- Modify: `packages/agent-remote-hosted/src/broker.ts`

- [ ] **Step 1: Run the guarding suites first.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/broker.test.ts src/session-security.test.ts src/stream-preemption.test.ts --testTimeout=10000`
Expected: PASS (this is the baseline; the tests exercise rate limits, reauthentication, owner-only resolution, expiry and capacity).

- [ ] **Step 2: Extract.** In `packages/agent-remote-hosted/src/broker.ts`, immediately before `  async function upgrade(request: Request, context: BrokerRequestContext, url: URL) {` add:

```ts
  /**
   * The limits and authorization every message of a browser session stream passes before anything else happens to it.
   * Returns a function that is true when the message may proceed; otherwise it already closed the stream or answered.
   */
  function admitClientMessages(client: RelaySocket, context: BrokerRequestContext, subject: string | undefined, expiry: () => number | undefined): (raw: string, binary: boolean) => boolean {
    let messageWindow = now(); let messageCount = 0; let imageChunkCount = 0; let imageChunkBytes = 0; let resourceCount = 0; let resourceBytes = 0;
    const refuse = (code: number, reason: string) => { client.close(code, reason); return false; };
    return (raw, binary) => {
      if (binary) return refuse(1003, 'Text protocol required');
      if (now()-messageWindow >= 60_000) { messageWindow=now(); messageCount=0; imageChunkCount=0; imageChunkBytes=0; resourceCount=0; resourceBytes=0; }
      let publicMessage: { type?: string; payload?: { locator?: unknown } };
      try { publicMessage = JSON.parse(raw.toString()); } catch { return refuse(1008, 'Invalid session message'); }
      if (publicMessage?.type === 'image_upload_chunk') {
        const bytes = Buffer.byteLength(raw.toString());
        imageChunkBytes += bytes;
        if (bytes > 48 * 1024 || ++imageChunkCount > 2048 || imageChunkBytes > 48 * 1024 * 1024) return refuse(1008, 'Image upload rate exceeded');
      } else if (publicMessage?.type === 'resource_upload_chunk' || publicMessage?.type === 'resource_download_request'
        // A conversation's images and a previewed file's local resources resolve and read one message each.
        || publicMessage?.type === 'resource_resolve_request' || publicMessage?.type === 'resource_request') {
        const bytes = Buffer.byteLength(raw.toString()); resourceBytes += bytes;
        if (bytes > 48 * 1024 || ++resourceCount > 8192 || resourceBytes > 192 * 1024 * 1024) return refuse(1008, 'Resource transfer rate exceeded');
      } else if (++messageCount > 120) return refuse(1008, 'Control message rate exceeded');
      if (context.authorizeMessage?.(raw.toString()) === false) {
        const decoded = decodeClientMessage(raw.toString());
        if (decoded.status !== 'ok' || !('payload' in decoded.value) || !('requestId' in decoded.value.payload)) return refuse(1008, 'Invalid session message');
        client.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'protocol_error', payload: {
          requestId: decoded.value.payload.requestId, code: 'reauthentication_required',
          message: 'Sign in again before changing session permissions. Then retry the change.', recoverable: true,
        } }));
        return false;
      }
      if (!owner(subject)) {
        try { if (publicMessage.type === 'resource_resolve_request' && !(typeof publicMessage.payload?.locator === 'string' && /^input-image:[a-f0-9-]{36}$/.test(publicMessage.payload.locator))) return refuse(1008, 'Only the Host owner can resolve local files'); }
        catch { return refuse(1008, 'Invalid session message'); }
      }
      const expiresAt = expiry();
      if (expiresAt !== undefined && expiresAt <= now()) return refuse(1008, 'Credential expired');
      return true;
    };
  }
```

Then in `accept`, replace this block (from `let messageWindow` through the expiry check, which sits between `client.onError(() => undefined);` and `let outgoing: string;`):

```ts
      let messageWindow = now(); let messageCount = 0; let imageChunkCount = 0; let imageChunkBytes = 0; let resourceCount = 0; let resourceBytes = 0;
      client.onMessage((raw, binary) => {
        if (binary) return client.close(1003, 'Text protocol required');
        if (now()-messageWindow >= 60_000) { messageWindow=now(); messageCount=0; imageChunkCount=0; imageChunkBytes=0; resourceCount=0; resourceBytes=0; }
        let publicMessage: { type?: string; payload?: { locator?: unknown } };
        try { publicMessage = JSON.parse(raw.toString()); } catch { return client.close(1008, 'Invalid session message'); }
        if (publicMessage?.type === 'image_upload_chunk') {
          const bytes = Buffer.byteLength(raw.toString());
          imageChunkBytes += bytes;
          if (bytes > 48 * 1024 || ++imageChunkCount > 2048 || imageChunkBytes > 48 * 1024 * 1024) return client.close(1008, 'Image upload rate exceeded');
        } else if (publicMessage?.type === 'resource_upload_chunk' || publicMessage?.type === 'resource_download_request'
          // A conversation's images and a previewed file's local resources resolve and read one message each.
          || publicMessage?.type === 'resource_resolve_request' || publicMessage?.type === 'resource_request') {
          const bytes = Buffer.byteLength(raw.toString()); resourceBytes += bytes;
          if (bytes > 48 * 1024 || ++resourceCount > 8192 || resourceBytes > 192 * 1024 * 1024) return client.close(1008, 'Resource transfer rate exceeded');
        } else if (++messageCount > 120) return client.close(1008, 'Control message rate exceeded');
        if (context.authorizeMessage?.(raw.toString()) === false) {
          const decoded = decodeClientMessage(raw.toString());
          if (decoded.status !== 'ok' || !('payload' in decoded.value) || !('requestId' in decoded.value.payload)) return client.close(1008, 'Invalid session message');
          client.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'protocol_error', payload: {
            requestId: decoded.value.payload.requestId, code: 'reauthentication_required',
            message: 'Sign in again before changing session permissions. Then retry the change.', recoverable: true,
          } }));
          return;
        }
        if (!owner(subject)) {
          try { if (publicMessage.type === 'resource_resolve_request' && !(typeof publicMessage.payload?.locator === 'string' && /^input-image:[a-f0-9-]{36}$/.test(publicMessage.payload.locator))) return client.close(1008, 'Only the Host owner can resolve local files'); }
          catch { return client.close(1008, 'Invalid session message'); }
        }
        const expiresAt = expiry();
        if (expiresAt !== undefined && expiresAt <= now()) return client.close(1008, 'Credential expired');
```

with

```ts
      const admit = admitClientMessages(client, context, subject, expiry);
      client.onMessage((raw, binary) => {
        if (!admit(raw, binary)) return;
```

The lines after it (`let outgoing: string;`, the identity rewrite, the buffering and the send) stay as they are.

- [ ] **Step 3: Run the guarding suites and the typecheck.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/broker.test.ts src/session-security.test.ts src/stream-preemption.test.ts --testTimeout=10000`
Expected: PASS, the same tests as in Step 1.

Run: `pnpm --filter @orchardworks/agent-remote-hosted run typecheck`
Expected: exit code 0.

- [ ] **Step 4: Commit.**

```bash
git add packages/agent-remote-hosted/src/broker.ts
git commit -m "refactor(hosted): share the per-message limits and authorization of session streams" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: The read path of a journal-served stream

**Files:**
- Create: `packages/agent-remote-hosted/src/journal-session-stream.ts`
- Create: `packages/agent-remote-hosted/src/journal-sessions.ts`
- Test: `packages/agent-remote-hosted/src/journal-session-stream.test.ts`, `packages/agent-remote-hosted/src/journal-sessions.test.ts`

`journal-session-stream.ts` is one browser stream's protocol; everything it needs from the outside comes through three small interfaces (`JournalReads`, `HostStreamOpener`, the client socket), so its tests use a real `SessionJournal` and fake sockets. `journal-sessions.ts` supplies the shared per-session state behind `JournalReads` and the subscriber registry.

- [ ] **Step 1: Write the failing tests.** `packages/agent-remote-hosted/src/journal-session-stream.test.ts`:

```ts
import { bodyFromRow, SessionJournal } from '@orchardworks/agent-remote-journal';
import { PROTOCOL_VERSION, SESSION_CAPACITY_CLOSE_CODE, type AgentSnapshotPayload } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it, vi } from 'vitest';

import type { JournalPublished } from './host-journals.js';
import type { HostStream, HostStreamOpener, HostStreamSink } from './journal-host-stream.js';
import { createJournalSessionStream, PENDING_CONTROL_REVISION, type JournalReads } from './journal-session-stream.js';
import { BROKER_MAX_FRAME_BYTES } from './transport.js';

type Wire = Record<string, any>;
const DIGEST = 'a'.repeat(64);
const OPERATION = '00000000-0000-4000-8000-000000000001';
const row = (itemKey: string, text: string) => ({
  itemKey, providerId: 'codex', sourceKey: `${itemKey}:${text}`, occurredAt: 1_725_000_000_000, turnId: 'turn-1',
  item: { type: 'assistant_message' as const, text, messageId: itemKey },
});
const snapshot = (status: 'idle' | 'running' = 'idle'): AgentSnapshotPayload => ({
  id: 'native-id', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status, activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'native-id', status },
});
const message = (fields: Wire) => JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...fields });
const negotiate = message({ type: 'negotiate' });
let counter = 0;
const pageRequest = (direction: 'tail' | 'before' | 'after', cursor?: { epoch: string; seq: number }, limit = 100) =>
  message({ type: 'timeline_request', payload: { requestId: `page-${++counter}`, agentId: 'agent', direction, limit, ...(cursor ? { cursor } : {}) } });
const sendMessage = message({ type: 'send_message', payload: { requestId: 'send-1', operationId: OPERATION, agentId: 'agent', text: 'Hi' } });

interface FixtureOptions {
  head?: boolean; evictBodies?: boolean; hostOpen?: Error; hostHang?: boolean; olderFails?: boolean;
  /** Extra items after the two default ones. */
  extraRows?: number;
  /** The fill does not bring the bodies back. */
  fillBringsNothing?: boolean;
  pageFails?: Error;
  /** Negotiation reads the journal status, which resolves only when this promise does. */
  statusGate?: Promise<void>;
  /** The fill waits for this promise before it brings bodies back. */
  fillGate?: Promise<void>;
  /** The browser socket's close throws like a WebSocket's for a reason over 123 bytes, or for every close. */
  closeThrows?: 'long reason' | 'always';
}

function fixture(options: FixtureOptions = {}) {
  const journal = SessionJournal.create('host-1:codex:thread-1');
  const { generation } = journal.claim('controller-1');
  let sequence = 0;
  const at = () => ({ publisherId: 'controller-1', generation, sequence: ++sequence });
  const texts = new Map<string, string>([['m1', 'Hello'], ['m2', 'World']]);
  for (let index = 0; index < (options.extraRows ?? 0); index++) texts.set(`x${index}`, `Extra ${index}`);
  for (const [key, text] of texts) { journal.append(at(), row(key, text)); journal.complete(at(), key, DIGEST); }
  if (options.head !== false) journal.setHead(at(), { snapshot: snapshot(), observedAt: 5 });
  if (options.evictBodies) journal.evict(0);
  let olderBeyondJournal = true;
  const calls = { fill: [] as string[][], older: [] as number[], pages: [] as Array<{ limit: number }>, hostOpens: 0 };
  const reads: JournalReads = {
    status: async () => {
      const read = { cursor: journal.cursor, ...(journal.head ? { head: journal.head } : {}) };
      await options.statusGate;
      return read;
    },
    page: async request => {
      calls.pages.push({ limit: request.limit });
      if (options.pageFails) throw options.pageFails;
      return journal.page(request, { olderBeyondJournal });
    },
    fill: async keys => {
      calls.fill.push(keys);
      await options.fillGate;
      if (options.fillBringsNothing) return;
      for (const key of keys) journal.fill(key, bodyFromRow(row(key, texts.get(key)!)), DIGEST);
    },
    older: async limit => {
      calls.older.push(limit);
      if (options.olderFails) throw new Error('The Host is offline.');
      olderBeyondJournal = false;
      journal.prepend(at(), [{ row: row('m0', 'Before'), digest: DIGEST }]);
    },
    olderBeyondJournal: () => olderBeyondJournal,
  };
  const sent: Wire[] = [];
  const closed: Array<[number | undefined, string | undefined]> = [];
  const client = { readyState: 1, bufferedAmount: 0 as number | undefined, send: (data: string) => { sent.push(JSON.parse(data)); }, close: (code?: number, reason?: string) => {
    if (options.closeThrows === 'always' || (options.closeThrows === 'long reason' && Buffer.byteLength(reason ?? '') > 123)) throw new RangeError('The reason must not exceed 123 bytes.');
    closed.push([code, reason]);
  } };
  const hostWrites: Wire[] = [];
  let sink: HostStreamSink | undefined;
  let hostClosed = false;
  const hostStreams: HostStreamOpener = {
    async open(next) {
      calls.hostOpens += 1;
      if (options.hostHang) return new Promise<HostStream>(() => undefined);
      if (options.hostOpen) throw options.hostOpen;
      sink = next;
      const stream: HostStream = { send: raw => { hostWrites.push(JSON.parse(raw)); }, close: () => { hostClosed = true; } };
      return stream;
    },
  };
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const scheduler = { setTimeout: (callback: () => void) => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout: (timer: unknown) => { timers.delete(timer as number); } };
  const stream = createJournalSessionStream({ publicAgentId: 'agent', client, reads, hostStreams, scheduler });
  const published = (events: JournalPublished['events']): JournalPublished => ({ events, watermark: sequence, cursor: journal.cursor });
  return {
    journal, stream, client, sent, closed, calls, hostWrites, sink: () => sink!, hostClosed: () => hostClosed,
    types: () => sent.map(frame => frame.type),
    runTimers() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } },
    appendLive(itemKey: string, text: string): JournalPublished {
      const stamped = journal.append(at(), row(itemKey, text))!;
      return published([{ kind: 'row', row: stamped }]);
    },
    setHead(status: 'idle' | 'running'): JournalPublished {
      journal.setHead(at(), { snapshot: snapshot(status), observedAt: 6 });
      return published([{ kind: 'head', head: journal.head! }]);
    },
    async negotiated(raw = negotiate) { this.stream.receive(raw); await vi.waitFor(() => expect(this.sent.length).toBeGreaterThanOrEqual(2)); },
  };
}

describe('a journal-served session stream', () => {
  it('answers negotiation from the journal head and opens the Controller stream in the background', async () => {
    const f = fixture();
    f.stream.receive(negotiate);
    await vi.waitFor(() => expect(f.types()).toEqual(['negotiated', 'agent_snapshot', 'session_control']));
    expect(f.sent[0]).toMatchObject({ sessionControl: true });
    expect(f.sent[1]!.payload).toMatchObject({ id: 'agent', status: 'idle', runtimeInfo: { connection: { state: 'restoring' } } });
    expect(f.sent[2]!.payload).toEqual({ agentId: 'agent', revision: PENDING_CONTROL_REVISION, access: 'read_only', available: false });
    await vi.waitFor(() => expect(f.hostWrites).toEqual([{ protocolVersion: PROTOCOL_VERSION, type: 'negotiate' }]));
  });

  it('requires negotiation first, and closes when the journal has no head any more', async () => {
    const f = fixture();
    f.stream.receive(pageRequest('tail'));
    expect(f.sent).toEqual([{ protocolVersion: PROTOCOL_VERSION, type: 'protocol_error', payload: { code: 'negotiation_required', message: 'Protocol negotiation must be the first message.', recoverable: false } }]);
    expect(f.calls.hostOpens).toBe(0);
    const headless = fixture({ head: false });
    headless.stream.receive(negotiate);
    await vi.waitFor(() => expect(headless.closed).toEqual([[1012, 'Session journal unavailable']]));
    expect(headless.sent).toEqual([]);
  });

  it('acknowledges the subscription before any live row and delivers appended rows with the journal\'s sequences', async () => {
    const f = fixture();
    await f.negotiated();
    f.stream.deliver(f.appendLive('m3', 'before the subscription'));
    expect(f.types()).toEqual(['negotiated', 'agent_snapshot', 'session_control']);
    f.stream.receive(message({ type: 'timeline_subscription', payload: { requestId: 'sub-1', agentIds: ['agent'] } }));
    f.stream.deliver(f.appendLive('m3', ' and live'));
    f.stream.deliver(f.appendLive('m4', 'next'));
    expect(f.sent.slice(3).map(frame => frame.type)).toEqual(['timeline_subscribed', 'agent_stream', 'agent_stream']);
    expect(f.sent[3]!.payload).toEqual({ requestId: 'sub-1', agentIds: ['agent'] });
    expect(f.sent.slice(4).map(frame => [frame.payload.epoch, frame.payload.seq, frame.payload.agentId])).toEqual([[f.journal.epoch, 4, 'agent'], [f.journal.epoch, 5, 'agent']]);
    expect(f.sent[4]!.payload.event).toMatchObject({ type: 'timeline', providerId: 'codex', item: { type: 'assistant_message', text: ' and live' } });
  });

  it('announces a replacement to subscribers and ignores rows that nobody subscribed to', async () => {
    const f = fixture();
    await f.negotiated();
    f.stream.deliver({ ...f.appendLive('m3', 'x'), events: [{ kind: 'replaced', epoch: 'epoch-2' }] });
    expect(f.sent).toHaveLength(3);
    f.stream.receive(message({ type: 'timeline_subscription', payload: { requestId: 'sub-1', agentIds: ['agent'] } }));
    f.stream.deliver({ ...f.appendLive('m4', 'y'), events: [{ kind: 'replaced', epoch: 'epoch-2' }] });
    expect(f.sent.at(-1)).toEqual({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_replacement', payload: { agentId: 'agent', epoch: 'epoch-2' } });
  });

  it('sends head changes as updates, showing the runtime as restoring until the Controller stream is ready', async () => {
    const f = fixture();
    await f.negotiated();
    await vi.waitFor(() => expect(f.hostWrites).toHaveLength(1));
    f.stream.deliver(f.setHead('running'));
    expect(f.sent.at(-1)).toMatchObject({ type: 'agent_update', payload: { id: 'agent', status: 'running', runtimeInfo: { connection: { state: 'restoring' } } } });
    f.sink().ready();
    await vi.waitFor(() => expect(f.sent.at(-1)!.payload.runtimeInfo.connection).toBeUndefined());
    expect(f.sent.at(-1)).toMatchObject({ type: 'agent_update', payload: { id: 'agent', status: 'running' } });
    f.stream.deliver(f.setHead('idle'));
    expect(f.sent.at(-1)).toMatchObject({ type: 'agent_update', payload: { status: 'idle' } });
    expect(f.sent.at(-1)!.payload.runtimeInfo.connection).toBeUndefined();
  });

  it('serves a tail page from the journal, and does not ask the Controller for older history for it', async () => {
    const f = fixture();
    await f.negotiated();
    f.stream.receive(pageRequest('tail'));
    await vi.waitFor(() => expect(f.sent.at(-1)?.type).toBe('timeline_page'));
    const { payload } = f.sent.at(-1)!;
    expect(payload).toMatchObject({ agentId: 'agent', epoch: f.journal.epoch, direction: 'tail', hasOlder: true, hasNewer: false, window: { minSeq: 1, maxSeq: 2, nextSeq: 3 } });
    expect(payload.entries.map((entry: Wire) => entry.item.text)).toEqual(['Hello', 'World']);
    expect(f.calls.older).toEqual([]);
  });

  it('asks for missing bodies and answers the page once they are back', async () => {
    const f = fixture({ evictBodies: true });
    await f.negotiated();
    f.stream.receive(pageRequest('tail'));
    await vi.waitFor(() => expect(f.sent.at(-1)?.type).toBe('timeline_page'));
    expect(f.calls.fill).toEqual([['m1', 'm2']]);
    expect(f.sent.at(-1)!.payload.entries.map((entry: Wire) => entry.item.text)).toEqual(['Hello', 'World']);
  });

  it('asks for older history when a before page reaches the start of the journal, then answers with what came back', async () => {
    const f = fixture();
    await f.negotiated();
    f.stream.receive(pageRequest('before', { epoch: f.journal.epoch, seq: 1 }));
    await vi.waitFor(() => expect(f.sent.at(-1)?.type).toBe('timeline_page'));
    expect(f.calls.older).toEqual([100]);
    expect(f.sent.at(-1)!.payload).toMatchObject({ direction: 'before', hasOlder: false });
    expect(f.sent.at(-1)!.payload.entries.map((entry: Wire) => entry.item.text)).toEqual(['Before']);
  });

  it('serves the page as the journal holds it when older history cannot be read', async () => {
    const f = fixture({ olderFails: true });
    await f.negotiated();
    f.stream.receive(pageRequest('before', { epoch: f.journal.epoch, seq: 1 }));
    await vi.waitFor(() => expect(f.sent.at(-1)?.type).toBe('timeline_page'));
    expect(f.sent.at(-1)!.payload).toMatchObject({ entries: [], hasOlder: true });
  });

  it('drops the read-path frames of the Controller session, forwards the rest and rewrites the pending control revision', async () => {
    const f = fixture();
    await f.negotiated();
    await vi.waitFor(() => expect(f.hostWrites).toHaveLength(1));
    const fromController = (fields: Wire) => f.sink().frame(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...fields }));
    const before = f.sent.length;
    fromController({ type: 'negotiated', sessionControl: true });
    fromController({ type: 'agent_snapshot', payload: snapshot('running') });
    fromController({ type: 'agent_update', payload: snapshot('running') });
    fromController({ type: 'agent_stream', payload: { agentId: 'agent', timestamp: 't', event: { type: 'turn_started', providerId: 'codex' } } });
    fromController({ type: 'timeline_subscribed', payload: { requestId: 'x', agentIds: ['agent'] } });
    expect(f.sent).toHaveLength(before);
    fromController({ type: 'command_acknowledged', payload: { requestId: 'send-1', agentId: 'agent', command: 'send_message' } });
    expect(f.sent.at(-1)).toMatchObject({ type: 'command_acknowledged' });
    f.stream.receive(message({ type: 'session_control_request', payload: { agentId: 'agent', requestId: 'control-1', revision: PENDING_CONTROL_REVISION, action: 'acquire' } }));
    expect(f.hostWrites).toHaveLength(1);
    fromController({ type: 'session_control', payload: { agentId: 'agent', revision: 'rev-1', access: 'read_only', available: true } });
    expect(f.sent.at(-1)).toMatchObject({ type: 'session_control', payload: { revision: 'rev-1' } });
    expect(f.hostWrites.at(-1)).toMatchObject({ type: 'session_control_request', payload: { requestId: 'control-1', revision: 'rev-1', action: 'acquire' } });
    f.stream.receive(message({ type: 'session_control_request', payload: { agentId: 'agent', requestId: 'control-2', revision: 'rev-1', action: 'take_over' } }));
    expect(f.hostWrites.at(-1)).toMatchObject({ payload: { requestId: 'control-2', revision: 'rev-1' } });
  });

  it('holds operations for the Controller stream, behind the Relay\'s own negotiation', async () => {
    const f = fixture();
    await f.negotiated();
    f.stream.receive(sendMessage);
    await vi.waitFor(() => expect(f.hostWrites.map(frame => frame.type)).toEqual(['negotiate', 'send_message']));
    expect(f.hostWrites[1]).toMatchObject({ payload: { requestId: 'send-1', agentId: 'agent', text: 'Hi' } });
    expect(f.types().filter(type => type === 'agent_snapshot')).toHaveLength(1);
  });

  it('answers operations with the reason when the Controller stream cannot open, and keeps serving reads', async () => {
    const f = fixture({ hostOpen: Object.assign(new Error('The Remote Host is offline.'), { code: 'host_offline' }) });
    await f.negotiated();
    f.stream.receive(sendMessage);
    await vi.waitFor(() => expect(f.sent.at(-1)).toEqual({ protocolVersion: PROTOCOL_VERSION, type: 'protocol_error',
      payload: { requestId: 'send-1', code: 'host_offline', message: 'The Remote Host is offline.', recoverable: true } }));
    f.stream.receive(pageRequest('tail'));
    await vi.waitFor(() => expect(f.sent.at(-1)?.type).toBe('timeline_page'));
    expect(f.closed).toEqual([]);
  });

  const offline = () => Object.assign(new Error('The Remote Host is offline.'), { code: 'host_offline' });
  const controlRequest = (action: 'acquire' | 'take_over', requestId: string) =>
    message({ type: 'session_control_request', payload: { agentId: 'agent', requestId, revision: PENDING_CONTROL_REVISION, action } });
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  it('answers an acquire with the pending control state while the Host is offline, and keeps the stream open', async () => {
    const f = fixture({ hostOpen: offline() });
    await f.negotiated();
    await vi.waitFor(() => expect(f.calls.hostOpens).toBe(1));
    await settle();
    f.stream.receive(controlRequest('acquire', 'control-1'));
    await vi.waitFor(() => expect(f.sent.at(-1)).toEqual({ protocolVersion: PROTOCOL_VERSION, type: 'session_control',
      payload: { agentId: 'agent', revision: PENDING_CONTROL_REVISION, access: 'read_only', available: false, requestId: 'control-1' } }));
    expect(f.calls.hostOpens).toBe(2);
    expect(f.types()).not.toContain('protocol_error');
    f.stream.receive(sendMessage);
    await vi.waitFor(() => expect(f.sent.at(-1)).toMatchObject({ type: 'protocol_error', payload: { requestId: 'send-1', code: 'host_offline', recoverable: true } }));
    expect(f.closed).toEqual([]);
  });

  it('refuses a take over while the Host is offline', async () => {
    const f = fixture({ hostOpen: offline() });
    await f.negotiated();
    f.stream.receive(controlRequest('take_over', 'control-2'));
    await vi.waitFor(() => expect(f.sent.at(-1)).toEqual({ protocolVersion: PROTOCOL_VERSION, type: 'protocol_error',
      payload: { requestId: 'control-2', code: 'host_offline', message: 'The Remote Host is offline.', recoverable: true } }));
  });

  it('refuses an acquire when the Controller stream fails to open for another reason', async () => {
    const f = fixture({ hostOpen: Object.assign(new Error('The session could not be attached.'), { code: 'session_attach_failed' }) });
    await f.negotiated();
    await vi.waitFor(() => expect(f.calls.hostOpens).toBe(1));
    await settle();
    f.stream.receive(controlRequest('acquire', 'control-3'));
    await vi.waitFor(() => expect(f.sent.at(-1)).toMatchObject({ type: 'protocol_error', payload: { requestId: 'control-3', code: 'session_attach_failed', recoverable: true } }));
    expect(f.sent.filter(frame => frame.type === 'session_control' && frame.payload.requestId)).toEqual([]);
    f.stream.hostReturned();
    expect(f.closed).toEqual([]);
  });

  it('closes a stream that waits for the Host when the Host returns, and leaves every other stream alone', async () => {
    const waiting = fixture({ hostOpen: offline() });
    await waiting.negotiated();
    await vi.waitFor(() => expect(waiting.calls.hostOpens).toBe(1));
    await settle();
    waiting.stream.hostReturned();
    expect(waiting.closed).toEqual([[1012, 'Remote Host reconnected']]);
    waiting.stream.hostReturned();
    expect(waiting.closed).toHaveLength(1);

    const connected = fixture();
    await connected.negotiated();
    await vi.waitFor(() => expect(connected.hostWrites).toHaveLength(1));
    connected.stream.hostReturned();
    expect(connected.closed).toEqual([]);

    const observer = fixture();
    observer.stream.receive(message({ type: 'negotiate', observation: 'activity' }));
    await vi.waitFor(() => expect(observer.types()).toEqual(['negotiated', 'agent_activity']));
    observer.stream.hostReturned();
    expect(observer.closed).toEqual([]);

    const left = fixture({ hostOpen: offline() });
    await left.negotiated();
    await vi.waitFor(() => expect(left.calls.hostOpens).toBe(1));
    await settle();
    left.stream.close();
    left.stream.hostReturned();
    expect(left.closed).toEqual([]);
  });

  it('closes the browser stream when the Controller stream ends, and the Controller stream when the browser leaves', async () => {
    const ended = fixture();
    await ended.negotiated();
    await vi.waitFor(() => expect(ended.hostWrites).toHaveLength(1));
    ended.sink().ended(1012, 'Remote Host disconnected');
    expect(ended.closed).toEqual([[1012, 'Remote Host disconnected']]);
    const left = fixture();
    await left.negotiated();
    await vi.waitFor(() => expect(left.hostWrites).toHaveLength(1));
    left.stream.close();
    expect(left.hostClosed()).toBe(true);
    expect(left.closed).toEqual([]);
    left.stream.deliver(left.appendLive('m3', 'ignored'));
    expect(left.sent).toHaveLength(3);
  });

  it('serves an activity observer from the head and the journal cursor, without a Controller stream', async () => {
    const f = fixture();
    f.stream.receive(message({ type: 'negotiate', observation: 'activity' }));
    await vi.waitFor(() => expect(f.types()).toEqual(['negotiated', 'agent_activity']));
    expect(f.sent[1]!.payload).toEqual({ agentId: 'agent', status: 'idle', cursor: { epoch: f.journal.epoch, seq: 2 } });
    f.stream.deliver(f.appendLive('m3', 'next'));
    expect(f.types()).toHaveLength(2);
    f.runTimers();
    expect(f.sent.at(-1)).toMatchObject({ type: 'agent_activity', payload: { status: 'idle', cursor: { seq: 3 } } });
    f.stream.deliver(f.setHead('running'));
    expect(f.sent.at(-1)).toMatchObject({ type: 'agent_activity', payload: { status: 'running' } });
    f.stream.receive(pageRequest('tail'));
    expect(f.sent.at(-1)).toMatchObject({ type: 'protocol_error', payload: { code: 'activity_only', recoverable: false } });
    expect(f.calls.hostOpens).toBe(0);
  });
});

describe('the reasons a Controller stream cannot open', () => {
  const refusal = (code: string, status?: number, extra: Wire = {}) => Object.assign(new Error(`Refused: ${code}.`), { code, ...(status === undefined ? {} : { status }), ...extra });
  const acquire = (requestId: string) => message({ type: 'session_control_request', payload: { agentId: 'agent', requestId, revision: PENDING_CONTROL_REVISION, action: 'acquire' } });

  it('closes the browser stream with the capacity code when the limit of streams is reached', async () => {
    const f = fixture({ hostOpen: refusal('session_stream_capacity', 429), closeThrows: 'long reason' });
    f.stream.receive(negotiate);
    await vi.waitFor(() => expect(f.closed).toEqual([[SESSION_CAPACITY_CLOSE_CODE, 'Remote stream capacity reached']]));
  });

  it('cuts a close reason to 123 bytes of whole characters, and survives a socket whose close throws', async () => {
    const long = fixture({ closeThrows: 'long reason' });
    await long.negotiated();
    await vi.waitFor(() => expect(long.hostWrites).toHaveLength(1));
    long.sink().ended(1012, '\u754c'.repeat(100));
    expect(long.closed).toHaveLength(1);
    expect(Buffer.byteLength(long.closed[0]![1]!)).toBe(123);
    expect(long.closed[0]![1]).toBe('\u754c'.repeat(41));
    const broken = fixture({ closeThrows: 'always' });
    await broken.negotiated();
    await vi.waitFor(() => expect(broken.hostWrites).toHaveLength(1));
    expect(() => broken.sink().ended(1012, 'Remote Host disconnected')).not.toThrow();
  });

  it('answers an acquire with the pending state and the native owner, refuses the rest for good, and tries again on the next message', async () => {
    const nativeOwner = { kind: 'native_cli', generation: 'g1' };
    const f = fixture({ hostOpen: refusal('native_session_owned', 409, { nativeOwner }) });
    await f.negotiated();
    await vi.waitFor(() => expect(f.calls.hostOpens).toBe(1));
    await new Promise(resolve => setTimeout(resolve, 0));
    f.stream.receive(acquire('control-1'));
    await vi.waitFor(() => expect(f.sent.at(-1)).toEqual({ protocolVersion: PROTOCOL_VERSION, type: 'session_control',
      payload: { agentId: 'agent', revision: PENDING_CONTROL_REVISION, access: 'read_only', available: false, requestId: 'control-1', nativeOwner } }));
    f.stream.receive(sendMessage);
    await vi.waitFor(() => expect(f.sent.at(-1)).toMatchObject({ type: 'protocol_error', payload: { requestId: 'send-1', code: 'native_session_owned', recoverable: false } }));
    expect(f.calls.hostOpens).toBe(3);
    f.stream.hostReturned();
    expect(f.closed).toEqual([]);
  });

  it('refuses the held messages with a recoverable error for a server failure and for a timeout', async () => {
    for (const status of [503, 408, undefined]) {
      const f = fixture({ hostOpen: refusal('session_attach_failed', status) });
      await f.negotiated();
      f.stream.receive(acquire('control-1'));
      f.stream.receive(sendMessage);
      await vi.waitFor(() => expect(f.sent.filter(frame => frame.type === 'protocol_error').map(frame => frame.payload))
        .toEqual(expect.arrayContaining([expect.objectContaining({ requestId: 'send-1', recoverable: true })])));
      expect(f.sent.filter(frame => frame.type === 'session_control' && frame.payload.requestId)).toEqual([]);
      expect(f.closed).toEqual([]);
    }
  });
});

describe('the activity of an observer', () => {
  const observer = async () => {
    const f = fixture();
    f.stream.receive(message({ type: 'negotiate', observation: 'activity' }));
    await vi.waitFor(() => expect(f.types()).toEqual(['negotiated', 'agent_activity']));
    return f;
  };

  it('sends one update with the latest cursor for several publications within the window', async () => {
    const f = await observer();
    f.stream.deliver(f.appendLive('m3', 'a'));
    f.stream.deliver(f.appendLive('m4', 'b'));
    f.stream.deliver(f.appendLive('m5', 'c'));
    expect(f.sent).toHaveLength(2);
    f.runTimers();
    expect(f.sent).toHaveLength(3);
    expect(f.sent.at(-1)!.payload).toEqual({ agentId: 'agent', status: 'idle', cursor: { epoch: f.journal.epoch, seq: 5 } });
    f.runTimers();
    expect(f.sent).toHaveLength(3);
  });

  it('sends a status change at once, with the cursor of its own publication', async () => {
    const f = await observer();
    const appended = f.appendLive('m3', 'a');
    const changed = f.setHead('running');
    f.stream.deliver({ ...changed, events: [...appended.events, ...changed.events] });
    expect(f.sent.at(-1)!.payload).toEqual({ agentId: 'agent', status: 'running', cursor: { epoch: f.journal.epoch, seq: 3 } });
    const count = f.sent.length;
    f.runTimers();
    expect(f.sent).toHaveLength(count);
  });

  it('sends nothing at once for a burst of rows with heads of the same status, and one update with the latest cursor after the window', async () => {
    const f = await observer();
    for (const key of ['m3', 'm4', 'm5']) {
      const appended = f.appendLive(key, key);
      const same = f.setHead('idle');
      f.stream.deliver({ ...same, events: [...appended.events, ...same.events] });
    }
    expect(f.sent).toHaveLength(2);
    f.runTimers();
    expect(f.sent).toHaveLength(3);
    expect(f.sent.at(-1)!.payload).toEqual({ agentId: 'agent', status: 'idle', cursor: { epoch: f.journal.epoch, seq: 5 } });
  });

  it('waits for the window when a head changes nothing the observer shows', async () => {
    const f = await observer();
    f.stream.deliver(f.setHead('idle'));
    expect(f.sent).toHaveLength(2);
  });
});

describe('a journal-served stream under load', () => {
  it('answers every page failure with the fixed timeline_unavailable error and no raw code', async () => {
    for (const code of ['unavailable', 'in_flight', 'busy', 'timeout', 'store_failed']) {
      const f = fixture({ pageFails: Object.assign(new Error(`internal ${code}`), { code }) });
      await f.negotiated();
      f.stream.receive(pageRequest('tail'));
      await vi.waitFor(() => expect(f.sent.at(-1)).toMatchObject({ type: 'protocol_error', payload: { code: 'timeline_unavailable', recoverable: true } }));
      expect(JSON.stringify(f.sent.at(-1))).not.toContain('internal');
      expect(f.sent.at(-1)!.payload.code).not.toBe(code);
    }
  });

  it('serves a 300-item tail whose bodies are all evicted, in several fill rounds', async () => {
    const f = fixture({ evictBodies: true, extraRows: 298 });
    await f.negotiated();
    f.stream.receive(pageRequest('tail', undefined, 300));
    await vi.waitFor(() => expect(f.sent.at(-1)?.type).toBe('timeline_page'));
    expect(f.sent.at(-1)!.payload.entries).toHaveLength(300);
    expect(f.calls.fill.map(keys => keys.length)).toEqual([64, 64, 64, 64, 44]);
  });

  it('stops filling when a round brings nothing back', async () => {
    const f = fixture({ evictBodies: true, fillBringsNothing: true });
    await f.negotiated();
    f.stream.receive(pageRequest('tail'));
    await vi.waitFor(() => expect(f.sent.at(-1)).toMatchObject({ type: 'protocol_error', payload: { code: 'timeline_unavailable' } }));
    expect(f.calls.fill).toHaveLength(1);
  });

  it('asks the Controller for no more bodies once the browser has left', async () => {
    let release!: () => void;
    const f = fixture({ evictBodies: true, extraRows: 298, fillGate: new Promise<void>(resolve => { release = resolve; }) });
    await f.negotiated();
    f.stream.receive(pageRequest('tail', undefined, 300));
    await vi.waitFor(() => expect(f.calls.fill).toHaveLength(1));
    f.stream.close();
    release();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.calls.fill).toHaveLength(1);
    expect(f.calls.pages).toHaveLength(1);
    expect(f.types()).not.toContain('timeline_page');
  });

  it('caps a requested page at 500 items', async () => {
    const f = fixture();
    await f.negotiated();
    f.stream.receive(pageRequest('tail', undefined, 1000));
    await vi.waitFor(() => expect(f.sent.at(-1)?.type).toBe('timeline_page'));
    expect(f.calls.pages[0]).toEqual({ limit: 500 });
  });

  it('handles messages that arrive behind negotiate in order, after the Snapshot', async () => {
    const f = fixture();
    f.stream.receive(negotiate);
    f.stream.receive(message({ type: 'timeline_subscription', payload: { requestId: 'sub-1', agentIds: ['agent'] } }));
    f.stream.receive(pageRequest('tail'));
    f.stream.receive(sendMessage);
    await vi.waitFor(() => expect(f.types()).toContain('timeline_page'));
    expect(f.types().slice(0, 4)).toEqual(['negotiated', 'agent_snapshot', 'session_control', 'timeline_subscribed']);
    expect(f.types()).not.toContain('protocol_error');
    await vi.waitFor(() => expect(f.hostWrites.map(frame => frame.type)).toEqual(['negotiate', 'send_message']));
  });

  it('counts held control requests against the limit of held messages', async () => {
    const f = fixture({ hostHang: true });
    await f.negotiated();
    const acquire = (id: number) => message({ type: 'session_control_request', payload: { agentId: 'agent', requestId: `control-${id}`, revision: PENDING_CONTROL_REVISION, action: 'acquire' } });
    for (let index = 0; index < 16; index++) { f.stream.receive(sendMessage); f.stream.receive(acquire(index)); }
    expect(f.closed).toEqual([]);
    f.stream.receive(acquire(99));
    expect(f.closed).toEqual([[1013, 'Remote stream is not ready']]);
  });

  it('refreshes the head it sent when something was published while negotiation was being answered', async () => {
    let release!: () => void;
    const f = fixture({ statusGate: new Promise<void>(resolve => { release = resolve; }) });
    f.stream.receive(negotiate);
    f.stream.deliver(f.setHead('running'));
    release();
    await vi.waitFor(() => expect(f.sent.at(-1)).toMatchObject({ type: 'agent_update', payload: { status: 'running' } }));
    expect(f.types().slice(0, 3)).toEqual(['negotiated', 'agent_snapshot', 'session_control']);
  });

  it('closes a stream whose browser connection cannot keep up', async () => {
    const f = fixture();
    await f.negotiated();
    f.stream.receive(message({ type: 'timeline_subscription', payload: { requestId: 'sub-1', agentIds: ['agent'] } }));
    f.client.bufferedAmount = BROKER_MAX_FRAME_BYTES + 1;
    f.stream.deliver(f.appendLive('m3', 'x'));
    expect(f.closed).toEqual([[1013, 'Slow browser connection']]);
  });
});
```

- [ ] **Step 2: Run it and see it fail.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/journal-session-stream.test.ts --testTimeout=10000`
Expected: FAIL: cannot resolve `./journal-session-stream.js`.

- [ ] **Step 3: Implement the stream.** `packages/agent-remote-hosted/src/journal-session-stream.ts`:

```ts
import type { JournalHead, JournalPageRequest, JournalPageResult, JournalRow } from '@orchardworks/agent-remote-journal';
import {
  decodeClientMessage, encodeServerMessage, JOURNAL_FILL_MAX_ITEMS, JOURNAL_OLDER_MAX_LIMIT, PROTOCOL_VERSION, SESSION_CAPACITY_CLOSE_CODE,
  type AgentSnapshotPayload, type AgentStatus, type ClientMessage, type HistoryPage, type NativeSessionOwner, type ServerMessage, type TimelineCursor,
} from '@orchardworks/agent-remote-protocol';

import type { JournalPublished, JournalStatus } from './host-journals.js';
import type { HostStream, HostStreamOpener } from './journal-host-stream.js';
import { BROKER_MAX_FRAME_BYTES, RELAY_SOCKET_OPEN, type BrokerScheduler, type RelaySocket } from './transport.js';

/** The control revision the Relay shows before the Controller session reports its own; a request naming it is rewritten. */
export const PENDING_CONTROL_REVISION = 'relay-pending';
const PAGE_DEFAULT_LIMIT = 100;
const PAGE_MAX_LIMIT = 500;
const HELD_MAX_MESSAGES = 32;
const HELD_MAX_BYTES = 1024 * 1024;
const CLOSE_REASON_MAX_BYTES = 123;
const ACTIVITY_COALESCE_MS = 500;
const TIMELINE_UNAVAILABLE = 'This part of the conversation is not available right now. It is shown again when the computer that holds it is reachable.';
const RESTORING_REASON = 'The Controller session is not connected yet.';
/** Frames of the Controller session that the journal answers instead; they never reach the browser. */
const READ_PATH_FRAMES = new Set([
  'negotiated', 'agent_snapshot', 'agent_update', 'agent_stream', 'agent_activity',
  'timeline_subscribed', 'timeline_page', 'timeline_replacement', 'timeline_resource_binding_replaced',
]);
const NEGOTIATE_FRAME = JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'negotiate' });
const encoder = new TextEncoder();

type TimelineRequestPayload = Extract<ClientMessage, { type: 'timeline_request' }>['payload'];
type ControlRequest = Extract<ClientMessage, { type: 'session_control_request' }>;
type Phase = 'new' | 'negotiating' | 'live' | 'closed';

/** What one stream reads from its session's journal; the shared state behind it lives in journal-sessions.ts. */
export interface JournalReads {
  status(): Promise<JournalStatus | undefined>;
  /** A page of the journal; the implementation says whether older history may still exist beyond it. */
  page(request: JournalPageRequest): Promise<JournalPageResult | undefined>;
  /** Asks the Controller to read these bodies again; resolves when the journal took them, rejects when it cannot be done. */
  fill(itemKeys: string[]): Promise<void>;
  /** Asks the Controller to read up to `limit` older items and publish them; rejects when it cannot be done. */
  older(limit: number): Promise<void>;
  olderBeyondJournal(): boolean;
}

export interface JournalSessionStreamOptions {
  publicAgentId: string;
  client: Pick<RelaySocket, 'readyState' | 'bufferedAmount' | 'send' | 'close'>;
  reads: JournalReads;
  hostStreams: HostStreamOpener;
  scheduler: BrokerScheduler;
}

export interface JournalSessionStream {
  /** One message from the browser; it has already passed the stream's limits and authorization. */
  receive(raw: string): void;
  /** What a stored publication changed in the session's journal. */
  deliver(result: JournalPublished): void;
  /** The browser stream ended. */
  close(): void;
  /** The Host's Controller connected again: a stream that waits for it closes so the client reconnects and acquires control. */
  hostReturned(): void;
}

function protocolError(code: string, message: string, recoverable: boolean, requestId?: string): ServerMessage {
  return { protocolVersion: PROTOCOL_VERSION, type: 'protocol_error', payload: { ...(requestId === undefined ? {} : { requestId }), code, message, recoverable } };
}

interface Refusal { code: string; message: string; status?: number; nativeOwner?: NativeSessionOwner }

/** The reason a Controller stream or a Host request failed: the error's own code, status and native owner when it has them. */
function refusalOf(error: unknown): Refusal {
  if (error instanceof Error) {
    const { code, status, nativeOwner } = error as { code?: unknown; status?: unknown; nativeOwner?: NativeSessionOwner };
    return {
      code: typeof code === 'string' ? code : 'host_unavailable', message: error.message,
      ...(typeof status === 'number' ? { status } : {}), ...(nativeOwner === undefined ? {} : { nativeOwner }),
    };
  }
  return { code: 'host_unavailable', message: 'The Controller session is unavailable.' };
}

function requestIdOf(message: ClientMessage): string | undefined {
  if (message.type === 'interaction_response') return message.payload.submissionId;
  const payload = (message as unknown as { payload?: { requestId?: unknown } }).payload;
  return typeof payload?.requestId === 'string' ? payload.requestId : undefined;
}

/** True when the page holds the oldest item of the journal (or the journal holds none) and claims older history. */
function reachesJournalStart(page: HistoryPage): boolean {
  const { entries, window, hasOlder } = page.payload;
  return hasOlder && (entries.length === 0 || entries[0]!.seqStart <= window.minSeq);
}

function activityStatus(snapshot: AgentSnapshotPayload): AgentStatus {
  return snapshot.status === 'closed' || snapshot.status === 'failed' ? snapshot.status
    : snapshot.pendingInteractions.length || snapshot.status === 'waiting' ? 'waiting'
    : snapshot.activeTurn || snapshot.status === 'running' ? 'running' : snapshot.status;
}

/**
 * One browser stream of a session that is read from its journal. It answers negotiation, the Snapshot, subscriptions and
 * pages itself, delivers what publications change, and sends every other message to a Controller stream that it opens in
 * the background. Reads never wait for the Controller.
 */
export function createJournalSessionStream(options: JournalSessionStreamOptions): JournalSessionStream {
  const { publicAgentId, client, reads, hostStreams, scheduler } = options;
  let phase: Phase = 'new';
  const isPhase = (expected: Phase): boolean => phase === expected;
  let activityOnly = false;
  let subscribed = false;
  let hostReady = false;
  /** Something was published while the Snapshot was being read; the head and cursor are read again once it is sent. */
  let stale = false;
  let hostState: 'idle' | 'opening' | 'open' = 'idle';
  let hostStream: HostStream | undefined;
  /** The last attempt to open the Controller stream failed because the Host is offline. */
  let waitingForHost = false;
  /** The control revision of the Controller session, once it has reported one. */
  let controlRevision: string | undefined;
  /** Messages for the Controller stream that wait for it to open. */
  const held: Array<{ raw: string; bytes: number; requestId?: string }> = [];
  /** Requests to acquire control that name the pending revision and wait for the Controller's own. */
  const heldControl: Array<{ request: ControlRequest; bytes: number }> = [];
  /** Messages that arrived while negotiation was being answered; they are handled in order once it is done. */
  const queued: Array<{ raw: string; bytes: number }> = [];
  let activitySnapshot: AgentSnapshotPayload | undefined;
  let activityCursor: TimelineCursor | undefined;
  let lastActivity: string | undefined;
  /** What the observer was last told, to tell a status change (sent at once) from a content burst (coalesced). */
  let lastStatus: string | undefined;
  let lastActivityCursor: TimelineCursor | undefined;
  let activityTimer: unknown;

  /** Holds one more message against the limits shared by everything that waits; false when it would exceed them. */
  function hasRoomFor(bytes: number): boolean {
    const waiting = [...held, ...heldControl, ...queued];
    return waiting.length < HELD_MAX_MESSAGES && waiting.reduce((sum, item) => sum + item.bytes, bytes) <= HELD_MAX_BYTES;
  }

  function sendRaw(json: string): void {
    if (isPhase('closed') || client.readyState !== RELAY_SOCKET_OPEN) return;
    if (client.bufferedAmount !== undefined && client.bufferedAmount > BROKER_MAX_FRAME_BYTES) { shutdown(1013, 'Slow browser connection'); return; }
    client.send(json);
  }

  function sendServer(message: ServerMessage): void {
    const encoded = encodeServerMessage(message);
    if (encoded.status === 'rejected') { shutdown(1011, 'Invalid journal message'); return; }
    sendRaw(encoded.json);
  }

  /** Closes the browser socket with a reason a WebSocket close frame can carry (at most 123 bytes of UTF-8); a failing close is ignored. */
  function closeClient(code: number, reason?: string): void {
    let fitted = '';
    let bytes = 0;
    for (const character of reason ?? '') {
      bytes += encoder.encode(character).byteLength;
      if (bytes > CLOSE_REASON_MAX_BYTES) break;
      fitted += character;
    }
    try { client.close(code, fitted); }
    catch { /* The socket is already going away. */ }
  }

  function shutdown(code?: number, reason?: string): void {
    if (isPhase('closed')) return;
    phase = 'closed';
    scheduler.clearTimeout(activityTimer);
    activityTimer = undefined;
    const stream = hostStream;
    hostStream = undefined;
    hostState = 'idle';
    stream?.close();
    held.length = 0;
    heldControl.length = 0;
    queued.length = 0;
    if (code !== undefined) closeClient(code, reason);
  }

  /** The Snapshot of the head. While the Controller stream is not ready, the runtime shows as not connected yet. */
  function snapshotPayload(head: JournalHead): AgentSnapshotPayload {
    const payload = structuredClone(head.snapshot);
    payload.id = publicAgentId;
    if (!hostReady) payload.runtimeInfo = { ...payload.runtimeInfo, connection: { state: 'restoring', reason: RESTORING_REASON } };
    return payload;
  }

  const snapshotMessage = (type: 'agent_snapshot' | 'agent_update', head: JournalHead): ServerMessage => type === 'agent_snapshot'
    ? { protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: snapshotPayload(head) }
    : { protocolVersion: PROTOCOL_VERSION, type: 'agent_update', payload: snapshotPayload(head) };

  const streamFrame = (row: JournalRow): ServerMessage => ({
    protocolVersion: PROTOCOL_VERSION, type: 'agent_stream',
    payload: {
      agentId: publicAgentId, epoch: row.epoch, seq: row.seq, timestamp: row.timestamp,
      event: { type: 'timeline', providerId: row.providerId, item: row.item, ...(row.turnId === undefined ? {} : { turnId: row.turnId }), resources: row.resources },
    },
  });

  function publishActivity(): void {
    scheduler.clearTimeout(activityTimer);
    activityTimer = undefined;
    if (!activitySnapshot) return;
    const background = activitySnapshot.attention?.background;
    const status = activityStatus(activitySnapshot);
    const payload = {
      agentId: publicAgentId, status,
      ...(activityCursor ? { cursor: activityCursor } : {}),
      ...(background ? { background: { id: background.id, kind: background.kind, status: background.status } } : {}),
    };
    const key = JSON.stringify(payload);
    if (key === lastActivity) return;
    lastActivity = key;
    lastStatus = JSON.stringify({ status, background: payload.background });
    lastActivityCursor = activityCursor;
    sendServer({ protocolVersion: PROTOCOL_VERSION, type: 'agent_activity', payload });
  }

  function scheduleActivity(): void {
    if (activityTimer !== undefined || !activitySnapshot) return;
    if (activityCursor?.epoch === lastActivityCursor?.epoch && activityCursor?.seq === lastActivityCursor?.seq) return;
    // Status is sent at once; content bursts share one bounded metadata update.
    activityTimer = scheduler.setTimeout(() => { activityTimer = undefined; publishActivity(); }, ACTIVITY_COALESCE_MS);
  }

  /** Takes a new head and cursor for the observer: a changed status or background goes out now, anything else waits for the window. */
  function observe(snapshot: AgentSnapshotPayload | undefined, cursor: TimelineCursor | undefined): void {
    if (cursor) activityCursor = cursor;
    if (snapshot) activitySnapshot = snapshot;
    if (!activitySnapshot) return;
    const background = activitySnapshot.attention?.background;
    const state = JSON.stringify({
      status: activityStatus(activitySnapshot),
      background: background ? { id: background.id, kind: background.kind, status: background.status } : undefined,
    });
    if (state !== lastStatus) publishActivity();
    else scheduleActivity();
  }

  /** Sends the head as it is now: an update for a content stream, activity for an observer. */
  async function refreshHead(): Promise<void> {
    const status = await reads.status();
    if (isPhase('closed')) return;
    if (!status?.head) { shutdown(1012, 'Session journal unavailable'); return; }
    if (activityOnly) observe(status.head.snapshot, status.cursor);
    else sendServer(snapshotMessage('agent_update', status.head));
  }

  async function negotiate(): Promise<void> {
    const status = await reads.status();
    if (!isPhase('negotiating')) return;
    if (!status?.head) { shutdown(1012, 'Session journal unavailable'); return; }
    sendServer({ protocolVersion: PROTOCOL_VERSION, type: 'negotiated', sessionControl: true });
    if (activityOnly) {
      observe(status.head.snapshot, status.cursor);
    } else {
      sendServer(snapshotMessage('agent_snapshot', status.head));
      sendServer({ protocolVersion: PROTOCOL_VERSION, type: 'session_control', payload: { agentId: publicAgentId, revision: PENDING_CONTROL_REVISION, access: 'read_only', available: false } });
    }
    if (!isPhase('negotiating')) return;
    phase = 'live';
    if (stale) { stale = false; refreshHead().catch(() => shutdown(1011, 'Session journal could not be read')); }
    if (!activityOnly) ensureHost();
    for (const item of queued.splice(0)) receive(item.raw);
  }

  function refuse(requestIds: ReadonlyArray<string | undefined>, error: unknown, final = false): void {
    const { code, message } = refusalOf(error);
    for (const requestId of requestIds) sendServer(protocolError(code, message, !final, requestId));
  }

  /** Opens the Controller stream when none is open or opening; what waits for it is sent once it is open. */
  function ensureHost(): void {
    if (hostState !== 'idle' || isPhase('closed')) return;
    hostState = 'opening';
    hostStreams.open({ frame: hostFrame, ready: hostIsReady, ended: hostEnded }).then(stream => {
      if (isPhase('closed')) { stream.close(); return; }
      hostStream = stream;
      hostState = 'open';
      waitingForHost = false;
      try { stream.send(NEGOTIATE_FRAME); }
      catch (error) {
        const requestIds = [...held.map(item => item.requestId), ...heldControl.map(item => item.request.payload.requestId)];
        held.length = 0;
        heldControl.length = 0;
        refuse(requestIds, error);
        return;
      }
      for (const item of held.splice(0)) {
        try { stream.send(item.raw); }
        catch (error) { refuse([item.requestId], error); }
      }
      flushControl();
    }, error => {
      hostState = 'idle';
      if (isPhase('closed')) return;
      const refusal = refusalOf(error);
      const messages = held.splice(0);
      const requests = heldControl.splice(0).map(item => item.request);
      const { status } = refusal;
      if (status === 429) { shutdown(SESSION_CAPACITY_CLOSE_CODE, 'Remote stream capacity reached'); return; }
      // A refusal that retrying cannot change leaves the stream reading; one that depends on the Host waits for it.
      const hopeless = status !== undefined && status >= 400 && status < 500 && status !== 408;
      const offline = refusal.code === 'host_offline';
      waitingForHost = offline;
      if (!offline && !hopeless) {
        refuse([...messages.map(item => item.requestId), ...requests.map(item => item.payload.requestId)], error);
        return;
      }
      refuse(messages.map(item => item.requestId), error, !offline);
      for (const request of requests) {
        if (request.payload.action === 'acquire') {
          sendServer({ protocolVersion: PROTOCOL_VERSION, type: 'session_control', payload: {
            agentId: publicAgentId, revision: PENDING_CONTROL_REVISION, access: 'read_only', available: false, requestId: request.payload.requestId,
            ...(refusal.nativeOwner === undefined ? {} : { nativeOwner: refusal.nativeOwner }),
          } });
        } else refuse([request.payload.requestId], error, !offline);
      }
    });
  }

  function hostIsReady(): void {
    hostReady = true;
    if (!activityOnly) refreshHead().catch(() => shutdown(1011, 'Session journal could not be read'));
  }

  function hostEnded(code: number, reason: string): void {
    hostState = 'idle';
    hostStream = undefined;
    shutdown(code, reason);
  }

  /** A frame from the Controller session: the read path belongs to the journal, the rest goes to the browser. */
  function hostFrame(raw: string): void {
    let parsed: { type?: unknown; payload?: { revision?: unknown } } | undefined;
    try { parsed = JSON.parse(raw); } catch { return; }
    const type = parsed?.type;
    if (typeof type !== 'string' || READ_PATH_FRAMES.has(type)) return;
    sendRaw(raw);
    if (type === 'session_control' && typeof parsed?.payload?.revision === 'string') {
      controlRevision = parsed.payload.revision;
      flushControl();
    }
  }

  /** Sends the held control requests with the Controller's own revision, once it is known and the stream is open. */
  function flushControl(): void {
    if (controlRevision === undefined || hostState !== 'open') return;
    for (const { request } of heldControl.splice(0)) {
      forward(JSON.stringify({ ...request, payload: { ...request.payload, revision: controlRevision } }), request.payload.requestId);
    }
  }

  /** Sends a message to the Controller stream, holding it until the stream is open. */
  function forward(raw: string, requestId: string | undefined): void {
    const stream = hostStream;
    if (hostState === 'open' && stream) {
      try { stream.send(raw); }
      catch (error) { refuse([requestId], error); }
      return;
    }
    const bytes = encoder.encode(raw).byteLength;
    if (!hasRoomFor(bytes)) { shutdown(1013, 'Remote stream is not ready'); return; }
    held.push({ raw, bytes, ...(requestId === undefined ? {} : { requestId }) });
    ensureHost();
  }

  async function servePage(payload: TimelineRequestPayload): Promise<void> {
    if (payload.agentId !== publicAgentId) {
      sendServer(protocolError('agent_identity_mismatch', 'Client message identifies a different Agent.', true, payload.requestId));
      return;
    }
    const query: JournalPageRequest = {
      requestId: payload.requestId, agentId: publicAgentId, direction: payload.direction,
      ...(payload.cursor === undefined ? {} : { cursor: payload.cursor }),
      limit: Math.min(payload.limit ?? PAGE_DEFAULT_LIMIT, PAGE_MAX_LIMIT),
    };
    try {
      let result = await reads.page(query);
      if (isPhase('closed')) return;
      const rounds = Math.ceil(query.limit / JOURNAL_FILL_MAX_ITEMS) + 1;
      let previouslyMissing = Number.POSITIVE_INFINITY;
      for (let round = 0; result?.kind === 'missing' && round < rounds && result.itemKeys.length < previouslyMissing; round++) {
        previouslyMissing = result.itemKeys.length;
        await reads.fill(result.itemKeys.slice(0, JOURNAL_FILL_MAX_ITEMS));
        if (isPhase('closed')) return;
        result = await reads.page(query);
        if (isPhase('closed')) return;
      }
      if (result?.kind === 'page' && query.direction === 'before' && reachesJournalStart(result.page) && reads.olderBeyondJournal()) {
        const served = result;
        try {
          await reads.older(Math.min(query.limit, JOURNAL_OLDER_MAX_LIMIT));
          if (isPhase('closed')) return;
          result = (await reads.page(query)) ?? served;
        } catch { result = served; }
      }
      if (result?.kind === 'page') sendServer(result.page);
      else sendServer(protocolError('timeline_unavailable', TIMELINE_UNAVAILABLE, true, payload.requestId));
    } catch {
      sendServer(protocolError('timeline_unavailable', TIMELINE_UNAVAILABLE, true, payload.requestId));
    }
  }

  function receive(raw: string): void {
    if (isPhase('closed')) return;
    if (isPhase('negotiating')) {
      const bytes = encoder.encode(raw).byteLength;
      if (!hasRoomFor(bytes)) { shutdown(1013, 'Remote stream is not ready'); return; }
      queued.push({ raw, bytes });
      return;
    }
    const decoded = decodeClientMessage(raw);
    if (decoded.status === 'rejected') {
      const issue = decoded.issues[0];
      sendServer(protocolError(issue?.code ?? 'invalid_shape', issue?.message ?? 'Client message was rejected.', !isPhase('new')));
      return;
    }
    const message = decoded.value;
    if (isPhase('new')) {
      if (message.type !== 'negotiate') {
        sendServer(protocolError('negotiation_required', 'Protocol negotiation must be the first message.', false));
        return;
      }
      phase = 'negotiating';
      activityOnly = message.observation === 'activity';
      negotiate().catch(() => shutdown(1011, 'Session journal could not be read'));
      return;
    }
    if (message.type === 'negotiate') {
      sendServer(protocolError('already_negotiated', 'Protocol version has already been negotiated.', true));
      return;
    }
    if (activityOnly) {
      sendServer(protocolError('activity_only', 'This connection observes activity only. Open the session to use content and controls.', false));
      return;
    }
    switch (message.type) {
      case 'timeline_subscription': {
        const agentIds = message.payload.agentIds.includes(publicAgentId) ? [publicAgentId] : [];
        sendServer({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds } });
        subscribed = agentIds.length === 1;
        return;
      }
      case 'timeline_request':
        void servePage(message.payload);
        return;
      case 'session_control_request':
        if (message.payload.revision !== PENDING_CONTROL_REVISION) { forward(raw, message.payload.requestId); return; }
        {
          const bytes = encoder.encode(raw).byteLength;
          if (!hasRoomFor(bytes)) { shutdown(1013, 'Remote stream is not ready'); return; }
          heldControl.push({ request: message, bytes });
        }
        ensureHost();
        flushControl();
        return;
      default:
        forward(raw, requestIdOf(message));
    }
  }

  function deliver(result: JournalPublished): void {
    if (isPhase('closed') || isPhase('new')) return;
    if (isPhase('negotiating')) { stale = true; return; }
    if (activityOnly) {
      // The publication's cursor is taken first, so a head published with it already carries the cursor it belongs to.
      let head: AgentSnapshotPayload | undefined;
      for (const event of result.events) if (event.kind === 'head') head = event.head.snapshot;
      if (result.events.length > 0) observe(head, result.cursor);
      return;
    }
    for (const event of result.events) {
      if (event.kind === 'head') { sendServer(snapshotMessage('agent_update', event.head)); continue; }
      if (!subscribed) continue;
      sendServer(event.kind === 'row' ? streamFrame(event.row)
        : { protocolVersion: PROTOCOL_VERSION, type: 'timeline_replacement', payload: { agentId: publicAgentId, epoch: event.epoch } });
    }
  }

  function hostReturned(): void {
    if (waitingForHost && !isPhase('closed')) shutdown(1012, 'Remote Host reconnected');
  }

  return { receive, deliver, close: () => shutdown(), hostReturned };
}
```

- [ ] **Step 4: Implement the shared state.** `packages/agent-remote-hosted/src/journal-sessions.ts`:

```ts
import type { JournalPageRequest, JournalPageResult } from '@orchardworks/agent-remote-journal';

import type { HostJournals, JournalFilled, JournalPublished } from './host-journals.js';
import type { HostStreamOpener } from './journal-host-stream.js';
import { createJournalSessionStream, type JournalReads, type JournalSessionStream } from './journal-session-stream.js';
import type { BrokerScheduler, RelaySocket } from './transport.js';

/** The key of a session's journal within its Host. */
export const journalSessionKey = (providerId: string, nativeSessionId: string): string => `${providerId}:${nativeSessionId}`;

export interface JournalSessionsOptions {
  journals: Pick<HostJournals, 'status' | 'page'>;
  /** Asks the Host's Controller to read bodies again; rejects when it is offline or cannot. */
  requestFill(hostId: string, sessionKey: string, itemKeys: string[]): Promise<JournalFilled>;
  /** Asks the Host's Controller to read older history and publish it; rejects when it is offline or cannot. */
  requestOlder(hostId: string, sessionKey: string, limit: number): Promise<{ olderAvailable: boolean }>;
  scheduler: BrokerScheduler;
}

export interface JournalSessionAttachment {
  hostId: string;
  sessionKey: string;
  publicAgentId: string;
  client: Pick<RelaySocket, 'readyState' | 'bufferedAmount' | 'send' | 'close'>;
  hostStreams: HostStreamOpener;
}

export interface JournalSessions {
  /** Whether the session's reads are served from its journal: a journal with a head exists. */
  serves(hostId: string, sessionKey: string): Promise<boolean>;
  /** Starts serving one browser stream; the caller routes the stream's messages to it and closes it when the stream ends. */
  attach(attachment: JournalSessionAttachment): JournalSessionStream;
  /** Delivers what a stored publication changed to the streams subscribed to the session. */
  published(hostId: string, sessionKey: string, result: JournalPublished): void;
  /** The Host's Controller connected again: streams of the Host that wait for it close so their clients reconnect. */
  hostReturned(hostId: string): void;
}

/** What the streams of one session share. */
interface SharedSession {
  hostId: string;
  streams: Set<JournalSessionStream>;
  /** True once a Controller said it holds no history older than the journal; reset by a replacement. */
  olderExhausted: boolean;
  /** How many replacements the journal had; an answer about older history that began before one says nothing about the new epoch. */
  replacements: number;
  /** The last queued fill: fills of a session run one after another, each with its own items. */
  fillTail: Promise<void>;
  older?: Promise<void>;
  /** Fills and older-history reads that have not settled; the state stays while any is pending. */
  pending: number;
}

export function createJournalSessions(options: JournalSessionsOptions): JournalSessions {
  const sessions = new Map<string, SharedSession>();
  const keyOf = (hostId: string, sessionKey: string) => JSON.stringify([hostId, sessionKey]);
  /** The shared state goes when no stream uses it and no read is pending; it is checked again whenever either changes. */
  function release(key: string, shared: SharedSession): void {
    if (shared.streams.size === 0 && shared.pending === 0 && sessions.get(key) === shared) sessions.delete(key);
  }

  return {
    async serves(hostId, sessionKey) {
      return (await options.journals.status(hostId, sessionKey))?.head !== undefined;
    },

    attach(attachment) {
      const { hostId, sessionKey } = attachment;
      const key = keyOf(hostId, sessionKey);
      const shared = sessions.get(key) ?? { hostId, streams: new Set<JournalSessionStream>(), olderExhausted: false, replacements: 0, fillTail: Promise.resolve(), pending: 0 };
      sessions.set(key, shared);
      const reads: JournalReads = {
        status: () => options.journals.status(hostId, sessionKey),
        page: (request: JournalPageRequest): Promise<JournalPageResult | undefined> => options.journals.page(hostId, sessionKey, request, !shared.olderExhausted),
        fill(itemKeys) {
          // One fill per session at a time, each asking for its own items.
          shared.pending += 1;
          const run = shared.fillTail.then(() => options.requestFill(hostId, sessionKey, itemKeys)).then(() => undefined);
          shared.fillTail = run.catch(() => undefined);
          return run.finally(() => { shared.pending -= 1; release(key, shared); });
        },
        older(limit) {
          if (shared.older === undefined) {
            const began = shared.replacements;
            shared.pending += 1;
            shared.older = options.requestOlder(hostId, sessionKey, limit)
              .then(({ olderAvailable }) => { if (!olderAvailable && shared.replacements === began) shared.olderExhausted = true; })
              .finally(() => { shared.older = undefined; shared.pending -= 1; release(key, shared); });
          }
          return shared.older;
        },
        olderBeyondJournal: () => !shared.olderExhausted,
      };
      const stream = createJournalSessionStream({ publicAgentId: attachment.publicAgentId, client: attachment.client, reads, hostStreams: attachment.hostStreams, scheduler: options.scheduler });
      shared.streams.add(stream);
      return {
        receive: stream.receive,
        deliver: stream.deliver,
        hostReturned: stream.hostReturned,
        close() {
          stream.close();
          shared.streams.delete(stream);
          release(key, shared);
        },
      };
    },

    published(hostId, sessionKey, result) {
      const shared = sessions.get(keyOf(hostId, sessionKey));
      if (!shared) return;
      if (result.events.some(event => event.kind === 'replaced')) { shared.olderExhausted = false; shared.replacements += 1; }
      for (const stream of [...shared.streams]) {
        try { stream.deliver(result); }
        catch { /* One stream's failure does not stop the others. */ }
      }
    },

    hostReturned(hostId) {
      for (const shared of [...sessions.values()]) {
        if (shared.hostId !== hostId) continue;
        for (const stream of [...shared.streams]) {
          try { stream.hostReturned(); }
          catch { /* One stream's failure does not stop the others. */ }
        }
      }
    },
  };
}
```

- [ ] **Step 5: Run the tests and see them pass.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/journal-session-stream.test.ts --testTimeout=10000`
Expected: PASS, 35 tests.

Then add `packages/agent-remote-hosted/src/journal-sessions.test.ts`, which checks that `hostReturned(hostId)` reaches only the streams of that Host, and the shared state of a session (chained fills, its lifetime while a fill is pending, a late older-history answer after a replacement):

```ts
import { bodyFromRow, SessionJournal } from '@orchardworks/agent-remote-journal';
import { PROTOCOL_VERSION, type AgentSnapshotPayload } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it, vi } from 'vitest';

import type { HostStream, HostStreamOpener } from './journal-host-stream.js';
import { createJournalSessions } from './journal-sessions.js';

const headSnapshot = { id: 'native-id', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle', activeTurn: null, capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } }, pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'native-id', status: 'idle' } } as AgentSnapshotPayload;

function socket() {
  const closed: Array<[number | undefined, string | undefined]> = [];
  const sent: Array<Record<string, any>> = [];
  const client = {
    readyState: 1, bufferedAmount: 0,
    send: (data: string) => { sent.push(JSON.parse(data)); },
    close: (code?: number, reason?: string) => { closed.push([code, reason]); },
  };
  return { closed, sent, client };
}

describe('the journal sessions of a Relay', () => {
  it('tells only the waiting streams of the returned Host that it is back', async () => {
    const head = { snapshot: headSnapshot, observedAt: 1 };
    const sessions = createJournalSessions({
      journals: { status: async () => ({ cursor: { epoch: 'e', seq: 0 }, head } as never), page: async () => undefined },
      requestFill: async () => ({}) as never,
      requestOlder: async () => ({ olderAvailable: false }),
      scheduler: { setTimeout: () => 0, clearTimeout: () => undefined },
    });
    const offline: HostStreamOpener = { open: async () => { throw Object.assign(new Error('The Remote Host is offline.'), { code: 'host_offline' }); } };
    const attach = (hostId: string, sessionKey: string) => {
      const { client, closed } = socket();
      const stream = sessions.attach({ hostId, sessionKey, publicAgentId: 'agent', client, hostStreams: offline });
      stream.receive(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'negotiate' }));
      return { stream, closed };
    };
    const first = attach('host-1', 'codex:a');
    const second = attach('host-1', 'codex:b');
    const other = attach('host-2', 'codex:a');
    await new Promise(resolve => setTimeout(resolve, 20));
    sessions.hostReturned('host-1');
    expect(first.closed).toEqual([[1012, 'Remote Host reconnected']]);
    expect(second.closed).toEqual([[1012, 'Remote Host reconnected']]);
    expect(other.closed).toEqual([]);
  });

  /** A session over a real journal whose bodies can be evicted, with fills and older reads that wait for the test. */
  async function journalSessions(options: { evict?: boolean } = {}) {
    const journal = SessionJournal.create('host-1:codex:thread-1');
    const { generation } = journal.claim('controller-1');
    let sequence = 0;
    const at = () => ({ publisherId: 'controller-1', generation, sequence: ++sequence });
    const row = (itemKey: string) => ({ itemKey, providerId: 'codex', sourceKey: itemKey, occurredAt: 1_725_000_000_000, turnId: 'turn-1', item: { type: 'assistant_message' as const, text: itemKey, messageId: itemKey } });
    for (const key of ['k1', 'k2']) { journal.append(at(), row(key)); journal.complete(at(), key, 'a'.repeat(64)); }
    journal.setHead(at(), { snapshot: headSnapshot, observedAt: 1 });
    if (options.evict !== false) journal.evict(0);
    const fills: Array<{ keys: string[]; finish(): void }> = [];
    const olderReads: Array<{ answer(olderAvailable: boolean): void }> = [];
    const olderArguments: boolean[] = [];
    const sessions = createJournalSessions({
      journals: {
        status: async () => ({ cursor: journal.cursor, head: journal.head! }),
        page: async (_host, _key, request, olderBeyondJournal) => { olderArguments.push(olderBeyondJournal); return journal.page(request, { olderBeyondJournal }); },
      },
      requestFill: (_host, _key, keys) => new Promise(resolve => {
        fills.push({ keys, finish: () => { for (const key of keys) journal.fill(key, bodyFromRow(row(key)), 'a'.repeat(64)); resolve({ filled: keys, mismatched: [], unknown: [] }); } });
      }),
      requestOlder: () => new Promise(resolve => { olderReads.push({ answer: olderAvailable => resolve({ olderAvailable }) }); }),
      scheduler: { setTimeout: () => 0, clearTimeout: () => undefined },
    });
    const open = async (limit: number, direction: 'tail' | 'before' = 'tail') => {
      const { client, closed, sent } = socket();
      const stream = sessions.attach({ hostId: 'host-1', sessionKey: 'codex:thread-1', publicAgentId: 'agent', client, hostStreams: { open: () => new Promise<HostStream>(() => undefined) } });
      stream.receive(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'negotiate' }));
      await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(3));
      stream.receive(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_request', payload: { requestId: `page-${limit}-${sent.length}`, agentId: 'agent', direction, limit, ...(direction === 'before' ? { cursor: { epoch: journal.epoch, seq: 1 } } : {}) } }));
      return { stream, sent, closed };
    };
    return { sessions, fills, olderReads, olderArguments, journal, open };
  }

  it('asks for the bodies of one session one fill at a time, each stream for its own items', async () => {
    const f = await journalSessions();
    const first = await f.open(1);
    await vi.waitFor(() => expect(f.fills).toHaveLength(1));
    const second = await f.open(2);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.fills.map(fill => fill.keys)).toEqual([['k2']]);
    f.fills[0]!.finish();
    await vi.waitFor(() => expect(f.fills).toHaveLength(2));
    expect(f.fills[1]!.keys).toEqual(['k1', 'k2']);
    f.fills[1]!.finish();
    await vi.waitFor(() => expect(first.sent.at(-1)?.type).toBe('timeline_page'));
    await vi.waitFor(() => expect(second.sent.at(-1)?.type).toBe('timeline_page'));
  });

  it('keeps the shared state of a session while a fill is pending, so a reload waits for it', async () => {
    const f = await journalSessions();
    const first = await f.open(2);
    await vi.waitFor(() => expect(f.fills).toHaveLength(1));
    first.stream.close();
    const reloaded = await f.open(2);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.fills).toHaveLength(1);
    f.fills[0]!.finish();
    await vi.waitFor(() => expect(f.fills).toHaveLength(2));
    f.fills[1]!.finish();
    await vi.waitFor(() => expect(reloaded.sent.at(-1)?.type).toBe('timeline_page'));
  });

  it('does not mark a replaced journal as exhausted because of an answer about the one it replaced', async () => {
    const f = await journalSessions({ evict: false });
    await f.open(100, 'before');
    await vi.waitFor(() => expect(f.olderReads).toHaveLength(1));
    f.sessions.published('host-1', 'codex:thread-1', { events: [{ kind: 'replaced', epoch: 'epoch-2' }], watermark: 0 });
    f.olderReads[0]!.answer(false);
    await vi.waitFor(() => expect(f.olderArguments.length).toBeGreaterThanOrEqual(2));
    await f.open(100, 'before');
    await vi.waitFor(() => expect(f.olderArguments.at(-1)).toBe(true));
    expect(f.olderArguments.at(-1)).toBe(true);
  });
});
```

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/journal-sessions.test.ts --testTimeout=10000`
Expected: PASS, 4 tests.

- [ ] **Step 6: Typecheck.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted run typecheck`
Expected: exit code 0.

- [ ] **Step 7: Commit.**

```bash
git add packages/agent-remote-hosted/src/journal-session-stream.ts packages/agent-remote-hosted/src/journal-session-stream.test.ts packages/agent-remote-hosted/src/journal-sessions.ts packages/agent-remote-hosted/src/journal-sessions.test.ts
git commit -m "feat(hosted): serve a session's reads from its journal" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Serve journaled sessions from the broker

**Files:**
- Create: `packages/agent-remote-hosted/src/test-utils/journal-session-fixture.ts`
- Create: `packages/agent-remote-hosted/src/broker-journal-sessions.test.ts`
- Modify: `packages/agent-remote-hosted/src/broker.ts`

The tests run a real broker over the in-memory socket transport with a fake Controller that opens and publishes a journal, answers the background Controller stream, and answers fills and older-history requests; one test goes through `acceptSessionChannel` as the browser channel does. `src/test-utils` is excluded from the build by the package's `tsconfig.json`.

- [ ] **Step 1: Write the fixture.** `packages/agent-remote-hosted/src/test-utils/journal-session-fixture.ts`:

```ts
import { MemoryJournalStore, SessionJournal } from '@orchardworks/agent-remote-journal';
import { PROTOCOL_VERSION, type AgentSnapshotPayload } from '@orchardworks/agent-remote-protocol';

import { createHostBroker, type BrokerRequestContext, type RelaySocket, type RemoteHostBrokerState } from '../index.js';

export type Wire = Record<string, any>;
export const HOST_ID = 'host';
export const PUBLIC_ID = 'agent';
export const SESSION_KEY = 'codex:native-session';
export const STORE_KEY = `${HOST_ID}:${SESSION_KEY}`;
export const DIGEST = 'a'.repeat(64);

export const row = (itemKey: string, text: string) => ({
  itemKey, providerId: 'codex', sourceKey: `${itemKey}:${text}`, occurredAt: 1_725_000_000_000, turnId: 'turn-1',
  item: { type: 'assistant_message' as const, text, messageId: itemKey },
});

export const snapshot = (status: 'idle' | 'running', id: string): AgentSnapshotPayload => ({
  id, providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status, activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'native-session', status },
});

/** A paired Host that is offline, with one bound session; the credential `arc_fixture` is the Host's. */
const savedState = (): RemoteHostBrokerState => ({
  keys: [['7a8ce1c8927a74e75f9bc855677bd2cb361d6b19a58f85296a8777022d022a14', { expires: 20_000, installationId: 'restored-installation' }]],
  hosts: [{ id: HOST_ID, installationId: 'restored-installation', name: 'Restored Host', providers: [{ providerId: 'codex', displayName: 'Codex' }], legacyDsh: false }],
  bindings: [{ hostId: HOST_ID, providerId: 'codex', nativeSessionId: 'native-session', agentId: PUBLIC_ID }],
  creations: [],
});

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Polls until the read returns something; a deadline of two seconds, so a failure names what never happened. */
export async function until<T>(read: () => T | undefined, label: string): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = read();
    if (value !== undefined) return value;
    await sleep(5);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

export function socketPair(closers: Array<() => void | Promise<void>>) {
  class Socket implements RelaySocket {
    readyState = 1; bufferedAmount = 0; closeCode?: number; peer!: Socket;
    messages = new Set<(data: string, binary: boolean) => void | Promise<void>>(); closes = new Set<() => void>();
    send(data: string) {
      if (this.readyState !== 1) throw new Error('Socket is closed');
      queueMicrotask(() => { if (this.peer.readyState === 1) for (const listener of this.peer.messages) listener(data, false); });
    }
    close(code?: number) {
      if (this.readyState !== 1) return;
      this.readyState = 3; this.closeCode = code;
      for (const listener of this.closes) listener();
      this.peer.close(code);
    }
    onMessage(listener: (data: string, binary: boolean) => void | Promise<void>) { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
    onClose(listener: () => void) { this.closes.add(listener); return () => { this.closes.delete(listener); }; }
    onError() { return () => {}; }
  }
  const server = new Socket(), native = new Socket();
  server.peer = native; native.peer = server;
  closers.push(() => server.close());
  return { server, native };
}

/** Records what arrives on a socket: `all` in order, and `take` to wait for the next message of a kind and remove it. */
export function collect(native: RelaySocket) {
  const all: Wire[] = [];
  const pending: Wire[] = [];
  native.onMessage(data => { const value = JSON.parse(data); all.push(value); pending.push(value); });
  return {
    all,
    take: (match: (message: Wire) => boolean, label: string): Promise<Wire> =>
      until(() => { const at = pending.findIndex(match); return at < 0 ? undefined : pending.splice(at, 1)[0]; }, label),
  };
}

/** A journal of one complete row `m1` ("Hello") under the fixture's session, written straight into the store. */
export async function seedJournal(store: MemoryJournalStore, options: { head?: boolean; evict?: boolean } = {}): Promise<void> {
  const journal = SessionJournal.create(STORE_KEY);
  const { generation } = journal.claim('controller-1');
  let sequence = 0;
  const at = () => ({ publisherId: 'controller-1', generation, sequence: ++sequence });
  journal.append(at(), row('m1', 'Hello'));
  journal.complete(at(), 'm1', DIGEST);
  if (options.head !== false) journal.setHead(at(), { snapshot: snapshot('idle', 'native-session'), observedAt: 5 });
  if (options.evict) journal.evict(0);
  await store.apply(journal.takeChanges()!);
}

export async function startRelay(options: { requestTimeoutMs?: number; seed?(store: MemoryJournalStore): Promise<void> } = {}) {
  const closers: Array<() => void | Promise<void>> = [];
  const store = new MemoryJournalStore();
  await options.seed?.(store);
  const broker = createHostBroker({ origin: 'https://relay.example', initialState: savedState(), now: () => 10_000, rpcTimeoutMs: 1000,
    journals: store, journalRequestTimeoutMs: options.requestTimeoutMs ?? 1000 });
  closers.push(() => broker.close());

  /** The Host's Controller, connected with `journal=1`. It answers the attach of the session and the streams the Relay opens. */
  async function connectController(behavior: { answerStreams?: boolean } = {}) {
    const prepared = await broker.prepareUpgrade(new Request('https://relay.example/ws/remote-host?journal=1', { headers: { authorization: 'Bearer arc_fixture' } }));
    if (!prepared || prepared instanceof Response) throw new Error('Host upgrade rejected');
    const pair = socketPair(closers);
    const inbox = collect(pair.native);
    prepared.accept(pair.server);
    pair.native.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'restored-installation', name: 'Restored Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
    await inbox.take(message => message.type === 'registered', 'registered');
    const send = (fields: Wire) => pair.native.send(JSON.stringify({ uplinkVersion: 2, ...fields }));
    const streams: Array<{ streamId: string; received: Wire[] }> = [];
    const attaches: Wire[] = [];
    const toStream = (streamId: string, fields: Wire) => send({ type: 'stream_message', streamId, message: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...fields }) });
    const acceptStream = (streamId: string) => send({ type: 'stream_opened', streamId });
    pair.native.onMessage(data => {
      const message = JSON.parse(data);
      if (message.type === 'rpc_request' && message.path === '/remote/attach') {
        attaches.push(message);
        send({ type: 'rpc_response', requestId: message.requestId, status: 200, body: JSON.stringify({ agentId: PUBLIC_ID, nativeSessionId: 'native-session' }) });
      } else if (message.type === 'stream_open') {
        streams.push({ streamId: message.streamId, received: [] });
        if (behavior.answerStreams !== false) acceptStream(message.streamId);
      } else if (message.type === 'stream_message') {
        const stream = streams.find(item => item.streamId === message.streamId);
        if (!stream) return;
        const inner = JSON.parse(message.message);
        stream.received.push(inner);
        if (inner.type === 'negotiate') {
          toStream(stream.streamId, { type: 'negotiated', sessionControl: true });
          toStream(stream.streamId, { type: 'agent_snapshot', payload: snapshot('running', PUBLIC_ID) });
          toStream(stream.streamId, { type: 'session_control', payload: { agentId: PUBLIC_ID, revision: 'rev-1', access: 'read_only', available: true } });
        } else if (inner.type === 'session_control_request') {
          if (inner.payload.revision !== 'rev-1') toStream(stream.streamId, { type: 'protocol_error', payload: { requestId: inner.payload.requestId, code: 'session_control_changed', message: 'Session access changed.', recoverable: true } });
          else toStream(stream.streamId, { type: 'session_control', payload: { agentId: PUBLIC_ID, revision: 'rev-1', access: 'control', available: true, token: 'token-1', requestId: inner.payload.requestId } });
        } else if (inner.type === 'send_message') {
          toStream(stream.streamId, { type: 'command_acknowledged', payload: { requestId: inner.payload.requestId, agentId: PUBLIC_ID, command: 'send_message', inputAcceptance: { disposition: 'started' } } });
        }
      }
    });
    let generation = 0;
    let sequence = 0;
    /** Opens the session's journal; later publications continue from the watermark it reports. */
    async function open() {
      send({ type: 'journal_open', requestId: `open-${Math.random()}`, sessionKey: SESSION_KEY, publisherId: 'controller-1' });
      const opened = await inbox.take(message => message.type === 'journal_opened', 'journal_opened');
      generation = opened.generation; sequence = opened.watermark;
      return opened;
    }
    /** Publishes entries without their sequence numbers and waits for the acknowledgement. */
    async function publish(entries: Wire[]) {
      const stamped = entries.map(entry => ({ sequence: ++sequence, ...entry }));
      send({ type: 'journal_publish', sessionKey: SESSION_KEY, generation, entries: stamped });
      const watermark = sequence;
      await inbox.take(message => message.type === 'journal_ack' && message.watermark === watermark, 'journal_ack');
    }
    return { pair, inbox, streams, attaches, send, toStream, acceptStream, open, publish, disconnect: () => pair.native.close(1000) };
  }

  /** A browser's per-session stream (`/v1/sessions/:id/events`), as the Relay sees it. */
  async function openBrowser(context: BrokerRequestContext = {}) {
    const prepared = await broker.prepareUpgrade(new Request(`https://relay.example/v1/sessions/${PUBLIC_ID}/events`, { headers: { origin: 'https://relay.example' } }), context);
    if (!prepared || prepared instanceof Response) throw new Error(`Session stream rejected: ${prepared instanceof Response ? prepared.status : 'not handled'}`);
    const pair = socketPair(closers);
    const inbox = collect(pair.native);
    prepared.accept(pair.server);
    return { pair, frames: inbox.all, take: inbox.take, send: (fields: Wire) => pair.native.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...fields })) };
  }

  return {
    broker, store, closers, connectController, openBrowser,
    async dispose() { for (const close of closers.splice(0).reverse()) await close(); },
  };
}
```

- [ ] **Step 2: Write the failing tests.** `packages/agent-remote-hosted/src/broker-journal-sessions.test.ts`:

```ts
import { acceptSessionChannel, PROTOCOL_VERSION } from '@orchardworks/agent-remote-protocol';
import { afterEach, expect, it } from 'vitest';

import { collect, DIGEST, PUBLIC_ID, row, seedJournal, SESSION_KEY, sleep, snapshot, socketPair, startRelay, STORE_KEY, until, type Wire } from './test-utils/journal-session-fixture.js';

const started: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => { for (const relay of started.splice(0)) await relay.dispose(); });
async function relay(options: Parameters<typeof startRelay>[0] = {}) {
  const value = await startRelay(options);
  started.push(value);
  return value;
}
type Relay = Awaited<ReturnType<typeof relay>>;
type Browser = Awaited<ReturnType<Relay['openBrowser']>>;

const OPERATION = '00000000-0000-4000-8000-000000000001';
const texts = (page: Wire) => page.payload.entries.map((entry: Wire) => entry.item.text);
const tail = (requestId: string) => ({ type: 'timeline_request', payload: { requestId, agentId: PUBLIC_ID, direction: 'tail', limit: 100 } });

/** A Controller that opened the session's journal and published two complete rows and a head. */
async function publishedController(r: Relay, behavior: { answerStreams?: boolean } = {}) {
  const controller = await r.connectController(behavior);
  const opened = await controller.open();
  await controller.publish([
    { op: 'append', row: row('m1', 'Hello') }, { op: 'complete', itemKey: 'm1', digest: DIGEST },
    { op: 'append', row: row('m2', 'World') }, { op: 'complete', itemKey: 'm2', digest: DIGEST },
    { op: 'head', head: { snapshot: snapshot('idle', 'native-session'), observedAt: 5 } },
  ]);
  return { controller, epoch: opened.epoch as string };
}

/** Negotiates and subscribes, and waits for the acknowledgement. */
async function subscribed(browser: Browser) {
  browser.send({ type: 'negotiate' });
  await browser.take(message => message.type === 'agent_snapshot', 'Snapshot');
  browser.send({ type: 'timeline_subscription', payload: { requestId: 'sub-1', agentIds: [PUBLIC_ID] } });
  await browser.take(message => message.type === 'timeline_subscribed', 'subscription acknowledgement');
}

it('serves negotiation, the Snapshot, the subscription and a page from the journal while the Host is offline', async () => {
  const r = await relay();
  const { controller, epoch } = await publishedController(r);
  controller.disconnect();
  await sleep(20);
  const browser = await r.openBrowser();
  browser.send({ type: 'negotiate' });
  await browser.take(message => message.type === 'agent_snapshot', 'Snapshot');
  expect(browser.frames.map(frame => frame.type)).toEqual(['negotiated', 'agent_snapshot', 'session_control']);
  expect(browser.frames[0]).toMatchObject({ sessionControl: true });
  expect(browser.frames[1]!.payload).toMatchObject({ id: PUBLIC_ID, status: 'idle', runtimeInfo: { connection: { state: 'restoring' } } });
  expect(browser.frames[2]!.payload).toMatchObject({ agentId: PUBLIC_ID, revision: 'relay-pending', access: 'read_only', available: false });
  browser.send({ type: 'timeline_subscription', payload: { requestId: 'sub-1', agentIds: [PUBLIC_ID] } });
  expect(await browser.take(message => message.type === 'timeline_subscribed', 'acknowledgement')).toMatchObject({ payload: { requestId: 'sub-1', agentIds: [PUBLIC_ID] } });
  browser.send(tail('page-1'));
  const page = await browser.take(message => message.type === 'timeline_page', 'page');
  expect(page.payload).toMatchObject({ agentId: PUBLIC_ID, epoch, hasOlder: true, hasNewer: false, window: { minSeq: 1, maxSeq: 2, nextSeq: 3 } });
  expect(texts(page)).toEqual(['Hello', 'World']);
  expect(controller.streams).toEqual([]);
  expect(browser.pair.server.readyState).toBe(1);
});

it('delivers live rows to subscribers in order, after the subscription is acknowledged, with the journal\'s dense sequences', async () => {
  const r = await relay();
  const { controller, epoch } = await publishedController(r);
  const browser = await r.openBrowser();
  await subscribed(browser);
  await controller.publish([
    { op: 'append', row: row('m3', 'Hel') }, { op: 'append', row: row('m3', 'lo') },
    { op: 'complete', itemKey: 'm3', digest: DIGEST }, { op: 'append', row: row('m4', 'Next') },
  ]);
  await until(() => browser.frames.filter(frame => frame.type === 'agent_stream').length === 3 ? true : undefined, 'three live rows');
  const live = browser.frames.filter(frame => frame.type === 'agent_stream');
  expect(live.map(frame => [frame.payload.epoch, frame.payload.seq])).toEqual([[epoch, 3], [epoch, 4], [epoch, 5]]);
  expect(live.map(frame => frame.payload.event.item.text)).toEqual(['Hel', 'lo', 'Next']);
  expect(browser.frames.findIndex(frame => frame.type === 'timeline_subscribed')).toBeLessThan(browser.frames.findIndex(frame => frame.type === 'agent_stream'));
});

it('does not send a correction live; the next page after the client\'s cursor carries it', async () => {
  const r = await relay();
  const { controller, epoch } = await publishedController(r);
  const browser = await r.openBrowser();
  await subscribed(browser);
  const revision = (await r.store.load(STORE_KEY))!.items.find(item => item.itemKey === 'm1')!.revision;
  await controller.publish([
    { op: 'correct', row: row('m1', 'Hello corrected'), digest: DIGEST, expectedRevision: revision },
    { op: 'append', row: row('m3', 'Next') },
  ]);
  await until(() => browser.frames.some(frame => frame.type === 'agent_stream') ? true : undefined, 'the live row');
  expect(browser.frames.filter(frame => frame.type === 'agent_stream').map(frame => frame.payload.seq)).toEqual([4]);
  browser.send({ type: 'timeline_request', payload: { requestId: 'page-2', agentId: PUBLIC_ID, direction: 'after', cursor: { epoch, seq: 2 }, limit: 100 } });
  expect(texts(await browser.take(message => message.type === 'timeline_page', 'page'))).toEqual(['Hello corrected', 'Next']);
});

it('announces a replacement to subscribers and serves the new epoch', async () => {
  const r = await relay();
  const { controller, epoch } = await publishedController(r);
  const browser = await r.openBrowser();
  await subscribed(browser);
  await controller.publish([{ op: 'replace', items: [{ row: row('x1', 'Fresh'), digest: DIGEST }] }]);
  const replaced = await browser.take(message => message.type === 'timeline_replacement', 'replacement');
  const stored = (await r.store.load(STORE_KEY))!;
  expect(stored.meta.epoch).not.toBe(epoch);
  expect(replaced.payload).toEqual({ agentId: PUBLIC_ID, epoch: stored.meta.epoch });
  browser.send(tail('page-2'));
  const page = await browser.take(message => message.type === 'timeline_page', 'page');
  expect(page.payload.epoch).toBe(stored.meta.epoch);
  expect(texts(page)).toEqual(['Fresh']);
});

it('forwards head changes as updates and shows the runtime as restoring until the Controller stream is ready', async () => {
  const r = await relay();
  const { controller } = await publishedController(r, { answerStreams: false });
  const browser = await r.openBrowser();
  await subscribed(browser);
  const stream = await until(() => controller.streams[0], 'the Controller stream');
  await controller.publish([{ op: 'head', head: { snapshot: snapshot('running', 'native-session'), observedAt: 6 } }]);
  const update = await browser.take(message => message.type === 'agent_update', 'update');
  expect(update.payload).toMatchObject({ id: PUBLIC_ID, status: 'running', runtimeInfo: { connection: { state: 'restoring' } } });
  controller.acceptStream(stream.streamId);
  const ready = await browser.take(message => message.type === 'agent_update', 'update once the stream is ready');
  expect(ready.payload).toMatchObject({ id: PUBLIC_ID, status: 'running' });
  expect(ready.payload.runtimeInfo.connection).toBeUndefined();
});

it('asks the Controller to fill a missing body before answering a page', async () => {
  const r = await relay({ seed: store => seedJournal(store, { evict: true }) });
  const controller = await r.connectController();
  const browser = await r.openBrowser();
  browser.send({ type: 'negotiate' });
  await browser.take(message => message.type === 'agent_snapshot', 'Snapshot');
  browser.send(tail('page-1'));
  const request = await controller.inbox.take(message => message.type === 'journal_fill_request', 'fill request');
  expect(request).toMatchObject({ sessionKey: SESSION_KEY, itemKeys: ['m1'] });
  controller.send({ type: 'journal_fill', requestId: request.requestId, sessionKey: SESSION_KEY, items: [{ row: row('m1', 'Hello'), digest: DIGEST }] });
  expect(texts(await browser.take(message => message.type === 'timeline_page', 'page'))).toEqual(['Hello']);
});

it('asks the Controller for older history when a before page reaches the start, and answers with what it published', async () => {
  const r = await relay();
  const { controller, epoch } = await publishedController(r);
  const browser = await r.openBrowser();
  await subscribed(browser);
  browser.send({ type: 'timeline_request', payload: { requestId: 'older-1', agentId: PUBLIC_ID, direction: 'before', cursor: { epoch, seq: 1 }, limit: 50 } });
  const request = await controller.inbox.take(message => message.type === 'journal_older_request', 'older request');
  expect(request).toMatchObject({ sessionKey: SESSION_KEY, limit: 50 });
  await controller.publish([{ op: 'prepend', items: [{ row: row('m0', 'Before'), digest: DIGEST }] }]);
  controller.send({ type: 'journal_older_done', requestId: request.requestId, sessionKey: SESSION_KEY, olderAvailable: false });
  const page = await browser.take(message => message.type === 'timeline_page', 'page');
  expect(page.payload).toMatchObject({ direction: 'before', hasOlder: false });
  expect(texts(page)).toEqual(['Before']);
});

it('sends operations and control to the Controller stream, returns its acknowledgements and drops its read frames', async () => {
  const r = await relay();
  const { controller } = await publishedController(r);
  const browser = await r.openBrowser();
  await subscribed(browser);
  const stream = await until(() => controller.streams[0], 'the Controller stream');
  await until(() => stream.received.some(message => message.type === 'negotiate') ? true : undefined, 'the Relay\'s negotiation');
  await browser.take(message => message.type === 'session_control' && message.payload.revision === 'rev-1', 'the Controller\'s control state');
  browser.send({ type: 'session_control_request', payload: { agentId: PUBLIC_ID, requestId: 'control-1', revision: 'relay-pending', action: 'acquire' } });
  expect(await browser.take(message => message.type === 'session_control' && message.payload.requestId === 'control-1', 'control')).toMatchObject({ payload: { access: 'control', token: 'token-1' } });
  browser.send({ type: 'send_message', controlToken: 'token-1', payload: { requestId: 'send-1', operationId: OPERATION, agentId: PUBLIC_ID, text: 'Hi' } });
  expect(await browser.take(message => message.type === 'command_acknowledged', 'acknowledgement')).toMatchObject({ payload: { requestId: 'send-1', command: 'send_message' } });
  controller.toStream(stream.streamId, { type: 'agent_update', payload: snapshot('running', PUBLIC_ID) });
  controller.toStream(stream.streamId, { type: 'agent_stream', payload: { agentId: PUBLIC_ID, timestamp: 't', event: { type: 'turn_started', providerId: 'codex' } } });
  controller.toStream(stream.streamId, { type: 'timeline_subscribed', payload: { requestId: 'x', agentIds: [PUBLIC_ID] } });
  await sleep(50);
  expect(browser.frames.filter(frame => frame.type === 'negotiated')).toHaveLength(1);
  expect(browser.frames.filter(frame => frame.type === 'agent_snapshot')).toHaveLength(1);
  expect(browser.frames.filter(frame => frame.type === 'agent_snapshot' || frame.type === 'agent_update').every(frame => frame.payload.status === 'idle')).toBe(true);
  expect(browser.frames.filter(frame => frame.type === 'agent_stream' || frame.type === 'timeline_subscribed')).toHaveLength(1);
  expect(stream.received.map(message => message.type)).toEqual(['negotiate', 'session_control_request', 'send_message']);
  expect(stream.received[1]!.payload.revision).toBe('rev-1');
  expect(controller.attaches).toHaveLength(1);
});

it('closes the Controller stream when the browser stream ends', async () => {
  const r = await relay();
  const { controller } = await publishedController(r);
  const browser = await r.openBrowser();
  await subscribed(browser);
  const stream = await until(() => controller.streams[0], 'the Controller stream');
  await until(() => stream.received.some(message => message.type === 'negotiate') ? true : undefined, 'the Relay\'s negotiation');
  browser.pair.native.close(1000);
  expect(await controller.inbox.take(message => message.type === 'stream_close', 'stream_close')).toMatchObject({ streamId: stream.streamId, code: 1000 });
});

it('answers an operation with the reason when the Host is offline, and keeps serving reads', async () => {
  const r = await relay();
  const { controller } = await publishedController(r);
  controller.disconnect();
  await sleep(20);
  const browser = await r.openBrowser();
  await subscribed(browser);
  browser.send({ type: 'send_message', payload: { requestId: 'send-1', operationId: OPERATION, agentId: PUBLIC_ID, text: 'Hi' } });
  expect(await browser.take(message => message.type === 'protocol_error' && message.payload.requestId === 'send-1', 'refusal')).toMatchObject({ payload: { code: 'host_offline', recoverable: true } });
  expect(browser.pair.server.readyState).toBe(1);
  browser.send(tail('page-1'));
  expect(texts(await browser.take(message => message.type === 'timeline_page', 'page'))).toEqual(['Hello', 'World']);
});

it('limits and authorizes the messages it answers itself like the ones it forwards', async () => {
  const r = await relay({ seed: store => seedJournal(store) });
  const browser = await r.openBrowser({ authorizeMessage: () => false });
  browser.send(tail('page-1'));
  expect(await browser.take(message => message.type === 'protocol_error' && message.payload.requestId === 'page-1', 'refusal')).toMatchObject({ payload: { code: 'reauthentication_required' } });
  const limited = await r.openBrowser();
  limited.send({ type: 'negotiate' });
  await limited.take(message => message.type === 'agent_snapshot', 'Snapshot');
  for (let at = 0; at < 125; at++) limited.send({ type: 'timeline_subscription', payload: { requestId: `sub-${at}`, agentIds: [PUBLIC_ID] } });
  await until(() => limited.pair.server.readyState !== 1 ? true : undefined, 'the stream to close');
  expect(limited.pair.server.closeCode).toBe(1008);
});

it('leaves a session without a journal head to the Controller, as before', async () => {
  const r = await relay();
  const controller = await r.connectController();
  const browser = await r.openBrowser();
  const stream = await until(() => controller.streams[0], 'the Controller stream');
  browser.send({ type: 'negotiate' });
  await until(() => stream.received.some(message => message.type === 'negotiate') ? true : undefined, 'the forwarded negotiation');
  const forwarded = await browser.take(message => message.type === 'agent_snapshot', 'the Controller\'s Snapshot');
  expect(forwarded.payload.status).toBe('running');
  expect(controller.attaches).toHaveLength(1);
});

it('does not serve a journal that has rows but no head, and refuses an offline Host as before', async () => {
  const r = await relay({ seed: store => seedJournal(store, { head: false }) });
  const prepared = await r.broker.prepareUpgrade(new Request(`https://relay.example/v1/sessions/${PUBLIC_ID}/events`, { headers: { origin: 'https://relay.example' } }));
  expect(prepared).toBeInstanceOf(Response);
  expect((prepared as Response).status).toBe(503);
  expect(await (prepared as Response).json()).toMatchObject({ code: 'host_offline' });
});

it('answers a session channel subscription from the journal', async () => {
  const r = await relay({ seed: store => seedJournal(store) });
  const channel = socketPair(r.closers);
  const inbox = collect(channel.native);
  const dispose = acceptSessionChannel(channel.server, 'session', async () => {
    const prepared = await r.broker.prepareUpgrade(new Request(`https://relay.example/v1/sessions/${PUBLIC_ID}/events`, { headers: { origin: 'https://relay.example' } }), { principalSubject: () => 'alice' });
    if (!prepared || prepared instanceof Response) throw new Error('Session stream rejected');
    return prepared;
  });
  r.closers.push(dispose);
  const frame = (fields: Wire) => channel.native.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...fields }));
  frame({ type: 'subscribe', subscriptionId: 1, agentId: PUBLIC_ID, message: { protocolVersion: PROTOCOL_VERSION, type: 'negotiate' } });
  await inbox.take(item => item.type === 'message' && item.message.type === 'agent_snapshot', 'Snapshot');
  expect(inbox.all.filter(item => item.type === 'message').map(item => item.message.type)).toEqual(['negotiated', 'agent_snapshot', 'session_control']);
  frame({ type: 'message', subscriptionId: 1, message: { protocolVersion: PROTOCOL_VERSION, ...tail('page-1') } });
  const page = await inbox.take(item => item.type === 'message' && item.message.type === 'timeline_page', 'page');
  expect(texts(page.message)).toEqual(['Hello']);
});
```

- [ ] **Step 3: Run them and see them fail.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/broker-journal-sessions.test.ts --testTimeout=10000`
Expected: FAIL. The tests that depend on journal serving time out waiting for the Snapshot (the broker still forwards to a Controller that is offline, so `openBrowser` throws `Session stream rejected: 503` for the offline tests, and the live tests never see `negotiated` from the Relay itself). The two crude tests may already pass.

- [ ] **Step 4: Wire the broker.** All edits are in `packages/agent-remote-hosted/src/broker.ts`.

(a) After `import { createJournalConnection, isJournalHostMessage, type JournalConnection } from './journal-uplink.js';` add:

```ts
import { createHostStreamOpener, type HostStreamEntry } from './journal-host-stream.js';
import { createJournalSessions, journalSessionKey } from './journal-sessions.js';
```

(b) In the `Host` type replace the `streams` line

```ts
  streams: Map<string, { publicAgentId: string; runtimeAgentId: string; socket: RelaySocket; subject?: string; authorized?(): boolean; ready: boolean; buffered: string[]; timer?: unknown }>;
```

with

```ts
  streams: Map<string, HostStreamEntry>;
```

(c) In the `stream_opened` handler replace

```ts
message: buffered }); stream.buffered = []; }
```

with

```ts
message: buffered }); stream.buffered = []; stream.onReady?.(); }
```

(d) Immediately after the `requireJournal` definition (the block ending `    return connection;\n  };`) add:

```ts
  /** Serves the reads of sessions that have a journal head from their journals; see journal-sessions.ts. */
  const journalSessions = journals && createJournalSessions({
    journals, scheduler,
    requestFill: async (hostId, sessionKey, itemKeys) => requireJournal(hostId).requestFill(sessionKey, itemKeys),
    requestOlder: async (hostId, sessionKey, limit) => requireJournal(hostId).requestOlder(sessionKey, limit),
  });
```

(e) In `register`, replace

```ts
          send: message => send(journalHost, message), diagnostic: event => diagnostic(journalHost, { event }) })
```

with

```ts
          send: message => send(journalHost, message), diagnostic: event => diagnostic(journalHost, { event }),
          published: (sessionKey, result) => journalSessions?.published(journalHost.id, sessionKey, result) })
```

(f) Immediately before `  async function upgrade(request: Request, context: BrokerRequestContext, url: URL) {` (after `admitClientMessages`, added in Task 4) add:

```ts
  /**
   * A browser stream whose session is read from its journal. Reads never touch the Controller; the Controller stream for
   * operations and control opens in the background through the Host's stream table, so limits, revocation and Host
   * disconnects apply to it like to any other stream.
   */
  function acceptJournalServed(host: Host, binding: Binding, context: BrokerRequestContext) {
    const subject = principal(context);
    return { accept(client: RelaySocket) {
      if (!sessionAllowed(binding, principal(context))) { client.close(1008, 'Session access is unavailable'); return; }
      track(client);
      const expiry = () => sessionAllowed(binding, principal(context)) ? context.connectionExpiresAt?.() : 0;
      expire(client, expiry);
      if (client.readyState !== RELAY_SOCKET_OPEN) return;
      client.onError(() => undefined);
      const admit = admitClientMessages(client, context, subject, expiry);
      const userStreams = () => subject === undefined ? 0 : options.userStreamCount?.(subject) ?? activeStreamCount(subject);
      const stream = journalSessions!.attach({
        hostId: host.id, sessionKey: journalSessionKey(binding.providerId, binding.nativeSessionId), publicAgentId: binding.agentId, client,
        hostStreams: createHostStreamOpener({
          streams: host.streams, publicAgentId: binding.agentId, runtimeAgentId: () => runtimeAgentId(host, binding), subject,
          authorized: () => { const end = expiry(); return end === undefined || end > now(); },
          recover: () => recoverBinding(host, binding),
          capacity: () => host.streams.size >= HOST_STREAM_LIMIT ? 'host' : userStreams() >= USER_STREAM_LIMIT ? 'account' : undefined,
          write: message => send(host, message), scheduler, openTimeoutMs: options.rpcTimeoutMs ?? 30_000,
          diagnostic: details => diagnostic(host, details),
        }),
      });
      client.onMessage((raw, binary) => { if (admit(raw, binary)) stream.receive(raw); });
      client.onClose(() => stream.close());
    } };
  }
```

(g) In `upgrade`, between the line

```ts
    if (!binding || !sessionAllowed(binding, principal(context)) || !await permitted(context) || request.headers.get('origin') !== origin) return rejectUpgrade(403);
```

and `    let host: Host;` add:

```ts
    // Authorization above is the same for both modes. A session with a journal head is read from it, whether or not its Host is online.
    const journalHost = journalSessions && hosts.get(binding.hostId);
    if (journalHost && await journalSessions!.serves(journalHost.id, journalSessionKey(binding.providerId, binding.nativeSessionId))) return acceptJournalServed(journalHost, binding, context);
```

- [ ] **Step 5: Run the new tests and see them pass.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/broker-journal-sessions.test.ts --testTimeout=10000`
Expected: PASS, 14 tests.

- [ ] **Step 6: Run the suites around the changed code.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/broker.test.ts src/broker-journals.test.ts src/broker-heartbeat.test.ts src/session-security.test.ts src/stream-preemption.test.ts src/gateway.test.ts src/journal-host-stream.test.ts src/journal-session-stream.test.ts src/journal-uplink.test.ts src/host-journals.test.ts --testTimeout=10000`
Expected: PASS for all files. The broker, heartbeat, security, preemption and gateway suites are the crude-mode guard: none of their sessions has a journal head, so none of them reaches `acceptJournalServed`.

- [ ] **Step 7: Typecheck.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted run typecheck`
Expected: exit code 0.

- [ ] **Step 8: Commit.**

```bash
git add packages/agent-remote-hosted/src/broker.ts packages/agent-remote-hosted/src/test-utils/journal-session-fixture.ts packages/agent-remote-hosted/src/broker-journal-sessions.test.ts
git commit -m "feat(hosted): serve browser streams of journaled sessions from the journal" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Verify the workspace and update compatibility metadata

**Files:**
- Modify: `packages/agent-remote-lab/compatibility.json` (generated)

- [ ] **Step 1: Build the changed package and typecheck every package that depends on it.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted run build && pnpm --filter @orchardworks/agent-remote-hosted --filter @orchardworks/agent-remote-lab --filter @orchardworks/agent-remote-cloudflare --filter @orchardworks/agent-remote-controller run typecheck`
Expected: exit code 0 for both. (`agent-remote-lab`, `agent-remote-cloudflare` and `agent-remote-controller` import `agent-remote-hosted`, whose declarations now mention the new types.)

- [ ] **Step 2: Run the whole hosted suite.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run --testTimeout=10000` with a Bash tool timeout of 300000 ms.
Expected: PASS. If the outer deadline is hit, run the files in two halves (`src/[a-i]*.test.ts`, then `src/[j-z]*.test.ts`) instead of raising the deadline.

- [ ] **Step 3: Run the real-transport suites that use the hosted broker with a real Controller uplink.** Their sessions have no journal, so they prove crude mode is unchanged end to end.

Run: `pnpm --filter @orchardworks/agent-remote-lab exec vitest run src/server/session-channel-routing.test.ts src/server/gateway-relay.test.ts --testTimeout=10000`
Expected: PASS for both files.

Run: `pnpm --filter @orchardworks/agent-remote-journal exec vitest run --testTimeout=10000 && pnpm --filter @orchardworks/agent-remote-protocol exec vitest run --testTimeout=10000`
Expected: PASS for both (neither package changed).

- [ ] **Step 4: Local instance.** Not required for this change. No production composition passes a journal store to the hosted Relay, and no Controller asks for `journal=1` until P1-C, so the journal-served path cannot be reached from `pnpm local up`; Step 3 already covers the crude path through a real uplink. The `pnpm local` check becomes required in P1-B3 (when a durable store is bound) and P1-C (when a Controller publishes). If the verifier wants to confirm anyway: follow `.agents/skills/prepare-arc-local/SKILL.md`, `pnpm local up`, open a session and send a message, `pnpm local down`.

- [ ] **Step 5: Update and check the compatibility digest.**

Run: `pnpm compatibility:update && pnpm compatibility:check`
Expected: exit code 0 for both. The wire contract did not change, so the digest may be unchanged; commit only if `git status` shows `packages/agent-remote-lab/compatibility.json` modified.

- [ ] **Step 6: Commit.**

```bash
git status --short packages/agent-remote-lab/compatibility.json
git add packages/agent-remote-lab/compatibility.json
git commit -m "chore: compatibility digest after journal-served sessions" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```
Expected: the commit succeeds if the digest changed; if `git status` printed nothing, skip the commit.

---

## Self-review

**Brief coverage.**

- Gating (brief 1): Task 6 step 4(g) runs after `sessionAllowed`, origin and `permitted`, and before `recoverBinding`; the gate is `journals.status(...).head` (Decision 1). Tests: offline read (Task 6), journal without head is crude, no journal is crude.
- Read path from the journal (brief 2): negotiate/`negotiated`/Snapshot ordering and the control placeholder (Task 5, Decisions 3 and 4, verified against `session-wire.ts` lines 205-227 and `remote-session-client.ts` `receive`/`beginSocketRecovery`); subscription acknowledged before live rows (unit test and broker test); pages with `requestFill` and `requestOlder` (Decision 9, unit and broker tests); live rows as `agent_stream` with journal epoch and sequence; `timeline_replacement`; head changes as `agent_update`. One deviation, stated in Decision 2: `timeline_subscribed` cannot carry a cursor.
- Corrections and old clients (brief 3): correction rows are never events (Task 1), and the broker test shows the sequence gap and the corrected entry in the next `after` page. The window-hole issue is recorded in Decision 8 as P1-D work.
- Runtime state (brief 4): `restoring` until the Controller stream is ready (Decision 6; `AgentComposer` `canWait` is true for `restoring` and `ready` is false through `runtimeConnectionMessage`).
- Background Controller stream (brief 5): `journal-host-stream.ts` (Task 3) and the routing in `journal-session-stream.ts` (Task 5); frames dropped and forwarded as listed in Decision 14; operations, control, acknowledgements and refusals are covered in Task 6.
- Isolation (brief 6): three new modules plus `journal-sessions.ts`; `broker.ts` gains the admission extraction (Task 4), the gating and the delegation (Task 6). The subscriber registry is fed by the `published` option that Task 2 adds and Task 6 wires.
- Tests (brief 7): real in-memory transports and a session-channel test with a fake Controller; every case listed in the brief has a test (offline read, live order and dense sequences, correction, replacement, fill, operations and acknowledgements, dropped Controller read frames, crude mode unchanged).
- Verification (brief 8): Task 7, with the `pnpm local` check stated as not required yet.

**Placeholder scan.** Every code step shows the code. Edits to `broker.ts`, `host-journals.ts`, `journal-uplink.ts` and the two existing test files name the exact existing text each one replaces or follows; each of those strings occurs once in its file (checked against the current files).

**Type consistency.**

- `JournalPublished.events` and `JournalLiveEvent` (Task 1) are produced by `host-journals.ts`, passed through `JournalConnectionOptions.published` (Task 2), stored in `JournalSessions.published` and read by `createJournalSessionStream().deliver` (Task 5).
- `HostStreamOpener`, `HostStream`, `HostStreamSink` (Task 3) are the types `JournalSessionStreamOptions.hostStreams` and `JournalSessionAttachment.hostStreams` use (Tasks 5 and 6); `HostStreamEntry` (Task 3) replaces the inline `Host.streams` value type (Task 6), and `onReady` is the one field the broker's `stream_opened` handler reads.
- `JournalReads` (Task 5) is implemented in `journal-sessions.ts` and faked over a real `SessionJournal` in the stream tests.
- `JournalStatus` (Task 1) is what `JournalReads.status` returns.
- `admitClientMessages` (Task 4) is called by the crude `accept` and by `acceptJournalServed` (Task 6) with the same `(client, context, subject, expiry)` arguments.

**Risks the implementer should watch.**

- With the Host offline a current client reads the conversation and reaches `ready` read-only. The Relay answers its automatic acquire with the pending control state; it does not refuse it (see the plan owner's amendment). The client stays read-only until the Host's Controller connects again. The Relay then closes the stream once, and the client acquires control over the new Controller stream. P2 issues control tokens at the Relay and removes that reconnect.
- `timeline_resource_binding_replaced` and the non-timeline `agent_stream` events of the Controller are dropped (Decision 14); resource-binding amendments need a journal amendment path, which the journal package does not have yet. Carry it to the plan that adds amendments (P1-C or later).
- The head's `attention.cursor` is served as published. The Controller must publish a head whose attention cursor refers to the journal's epoch (P1-C), or the client's unread logic compares cursors from two epochs.
- `GET /v1/sessions/:id/snapshot` and `/timeline` still go to the Controller (Decision 13). A client that uses HTTP recovery (`timelineRecovery: 'http'`) is not served from the journal.
- Every `serves` check is a store read on the Host's serialized journal queue, so a slow store delays stream opening for sessions of that Host even when they have no journal (P1-B3 bounds and caches this).
