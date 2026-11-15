# P1-B1 Relay journal service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The hosted Relay keeps session journals for Controllers that ask for them. A Controller opens a session's journal over the Host uplink, publishes rows, completions, corrections, replacements, prepends and the head, and gets each publication acknowledged only after the journal store holds it. The Relay can ask the Controller to fill evicted bodies and to read older history. Browsers are not served from journals yet (P1-B2), and no durable store exists yet (P1-B3): this plan runs the service against the `JournalStore` port with `MemoryJournalStore` in tests, and production hosts do not enable journals.

**Architecture:** Three layers, each in its own module. The uplink schema in `agent-remote-protocol` carries nine new messages behind the capability `journal=1` / `registered.journal: 1`. `host-journals.ts` in `agent-remote-hosted` keeps one `SessionJournal` per Host session, loaded lazily from the store, with all work of one Host serialized in a promise chain, and maps the journal's typed errors to refusal reasons. `journal-uplink.ts` is the per-connection adapter between uplink messages and that service: it tracks which sessions the connection opened, sends acknowledgements and refusals, and owns the Relay-to-Host request map (fill and older history) with timeouts and caps. `broker.ts` only grants the capability, dispatches to the adapter and exposes `requestFill` and `requestOlder`.

**Tech Stack:** TypeScript 5.7 (ES2022, Node16 modules, strict), TypeBox (`@sinclair/typebox`), Vitest 4.1.11, pnpm workspace. The journal package runs in Node and in a Worker; the hosted package uses `node:crypto` already.

**Design reference:** `docs/superpowers/specs/2026-11-15-im-session-service-design.md`, sections Architecture (Roles, Data flows), Session journal, Answering the client protocol in smart mode, and Compatibility and rollout. Roadmap: `docs/superpowers/plans/2026-11-15-im-session-service-roadmap.md` (row P1-B). Predecessor: `2026-11-15-p1a-journal-core.md`, which must have landed completely (`page`, `evict`, `fill`, `planReconcile`, `JournalStore`, `MemoryJournalStore`).

**Commands.** Every test command below sets a per-test deadline (`--testTimeout`). Run each with an outer deadline: the Bash tool timeout of at most 300000 ms. Hosted and journal tests import their workspace dependencies from `dist`, so rebuild a package after changing it (each task says when).

**Decisions made in this plan** (not stated in the design):

1. A publication entry is `{ sequence, op, ...fields }`. `op` is the discriminant (`append | complete | seal | alias | correct | replace | prepend | head`). Flat tagged objects keep every entry strictly typed.
2. `Host.journal` holds the per-connection handle (`JournalConnection`), not the flag `1`. Fill and older requests need that connection's pending map and its `opened` sessions, and a Host that is offline has no handle. Like `hostStatus` and `sessionStates` it is set when `registered` is sent and is never persisted. Only the Relay `registered.journal: 1` field is the wire flag.
3. The connection remembers which sessions it opened and the generation it got. A `journal_publish` for a session this connection did not open, or with an older generation, is refused `fenced` without touching the journal. Generations are persisted, so this stops a connection that skipped `journal_open` from writing with a generation that was current before a Relay restart.
4. The service reads the publisher from a new `SessionJournal.publisher` getter, so `publish(hostId, sessionKey, generation, entries)` needs no publisher id: the journal's publisher plus the claimed generation identify the publication.
5. `publish` returns `refusal` next to the rows, watermark and cursor, and `replacedEpoch` when a replacement started a new epoch. P1-B2 needs the epoch to announce `timeline_replacement`. No fan-out hook exists yet: the rows are returned and the adapter drops them.
6. A failed `store.apply` drops the cached journal, so the next call reloads the last stored state, and the error propagates. The broker closes the connection with 1011 (its existing catch). The Controller reconnects, opens again and resumes after the stored watermark.
7. `journal_fill` applies only the item keys that were requested; other rows in the response are ignored. A response with an unknown `requestId` is ignored, as `outbox_response` is today.
8. One fill and one older-history read may be in flight per session on a connection (the design allows one per journal), at most 32 requests per connection, each with a 15 s timeout (`journalRequestTimeoutMs` overrides it in tests).
9. Every journal message is bounded to `UPLINK_MAX_FRAME_BYTES / 4` (8 MiB) in UTF-8, validated with the other cross-field rules.

---

**Amendments after the P1-A final review** (they override the code below where they differ):

- The journal throws `JournalInvalidRowError` and `JournalInvalidPublicationError` instead of a bare `RangeError`; `refusalOf` maps both to `invalid`, as above.
- An unexpected error while applying a publication drops the cached journal before it propagates, as above, so a half-applied publication is never acknowledged.
- `open` must not claim a generation that cannot be sent. Its signature is `open(hostId, sessionKey, publisherId, fits)`. The adapter (Task 4) supplies `fits(index, epoch)`, which encodes the `journal_opened` reply with `encodeRemoteHostUplinkMessage` and checks the result. When the reply would not fit, `open` returns a refusal (`{ refused: 'index_too_large' }`) without claiming, and the adapter answers the Controller with `journal_refused` (reason `invalid`) and leaves the session unopened.
- Every journal message the adapter sends is validated with `encodeRemoteHostUplinkMessage` before `send`. A failure is logged as a diagnostic and treated like a refusal. It never reaches the Controller as an unencodable frame.
- Revisions come from one counter for the whole journal (`JournalMeta.lastRevision`). The head type and the journal's input types are the protocol's wire types, re-exported by the journal.

## File structure

| File | Responsibility |
|---|---|
| `packages/agent-remote-journal/src/types.ts` | Modify: `JournalHead`, `JournalMeta.head`. |
| `packages/agent-remote-journal/src/session-journal.ts` | Modify: `setHead`, `head`, `publisher`. |
| `packages/agent-remote-journal/src/journal-head.test.ts` | New: head and publisher tests. |
| `packages/agent-remote-protocol/src/remote-host-journal.ts` | New: wire schemas, limits and cross-field validation of the journal messages. |
| `packages/agent-remote-protocol/src/remote-host-uplink.ts` | Modify: nine messages, `registered.journal`, the validator hook. |
| `packages/agent-remote-protocol/src/index.ts` | Modify: export the new module. |
| `packages/agent-remote-protocol/src/remote-host-journal.test.ts` | New: encode, decode and rejection tests. |
| `packages/agent-remote-hosted/package.json` | Modify: depend on `@orchardworks/agent-remote-journal`. |
| `packages/agent-remote-hosted/src/host-journals.ts` | New: the Host journal service. |
| `packages/agent-remote-hosted/src/host-journals.test.ts` | New: service tests with `MemoryJournalStore`. |
| `packages/agent-remote-hosted/src/journal-uplink.ts` | New: the per-connection adapter and the request map. |
| `packages/agent-remote-hosted/src/journal-uplink.test.ts` | New: adapter tests with a recording sender and a fake scheduler. |
| `packages/agent-remote-hosted/src/broker.ts` | Modify: option, capability, dispatch, disconnect, `requestFill`, `requestOlder`. |
| `packages/agent-remote-hosted/src/gateway.ts` | Modify: `journals` option threaded to each tenant broker. |
| `packages/agent-remote-hosted/src/index.ts` | Modify: export the service. |
| `packages/agent-remote-hosted/src/broker-journals.test.ts` | New: tests over the in-memory transport harness. |
| `pnpm-lock.yaml`, `packages/agent-remote-lab/compatibility.json` | Generated. |

Protocol fixtures: `packages/agent-remote-protocol/test/fixtures` holds only `legacy-team` (recordings of the old Team uplink shapes). The journal messages are new and opt-in, so no fixture entry is needed; the encode/decode tests in Task 2 are the contract, and a Controller that does not send `journal=1` never receives a journal field (Task 5 tests it).

---

### Task 1: The journal head and the publisher getter

**Files:**
- Modify: `packages/agent-remote-journal/src/types.ts`
- Modify: `packages/agent-remote-journal/src/session-journal.ts`
- Test: `packages/agent-remote-journal/src/journal-head.test.ts`

- [ ] **Step 1: Write the failing tests.** `packages/agent-remote-journal/src/journal-head.test.ts`:

```ts
import type { AgentSnapshotPayload } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { openJournal, PUBLISHER } from './journal.test-fixture.js';
import { SessionJournal } from './session-journal.js';
import { JournalFencedError } from './types.js';

const snapshot = (status: AgentSnapshotPayload['status']): AgentSnapshotPayload => ({
  id: 'session-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status, activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status },
});

describe('journal head', () => {
  it('stores the latest snapshot with its observation time and reports it as a change', () => {
    const { journal, publish } = openJournal();
    expect(journal.head).toBeUndefined();
    journal.takeChanges();
    journal.setHead(publish(), { snapshot: snapshot('running'), observedAt: 5 });
    expect(journal.head).toEqual({ snapshot: snapshot('running'), observedAt: 5 });
    expect(journal.takeChanges()?.meta.head).toEqual({ snapshot: snapshot('running'), observedAt: 5 });
    journal.setHead(publish(), { snapshot: snapshot('idle'), observedAt: 9 });
    expect(journal.head?.observedAt).toBe(9);
  });

  it('ignores a publication it already applied', () => {
    const { journal, publish } = openJournal();
    const publication = publish();
    journal.setHead(publication, { snapshot: snapshot('running'), observedAt: 5 });
    journal.setHead(publication, { snapshot: snapshot('idle'), observedAt: 9 });
    expect(journal.head).toEqual({ snapshot: snapshot('running'), observedAt: 5 });
  });

  it('fences off an older connection of the publisher', () => {
    const { journal, publish } = openJournal();
    const stale = publish();
    journal.claim(PUBLISHER);
    expect(() => journal.setHead(stale, { snapshot: snapshot('idle'), observedAt: 1 })).toThrow(JournalFencedError);
    expect(journal.head).toBeUndefined();
  });

  it('survives a store round trip and does not alias the stored value', () => {
    const { journal, publish } = openJournal();
    journal.setHead(publish(), { snapshot: snapshot('running'), observedAt: 5 });
    const restored = new SessionJournal(journal.state());
    expect(restored.head).toEqual(journal.head);
    const copy = journal.head!;
    copy.observedAt = 99;
    expect(journal.head?.observedAt).toBe(5);
  });

  it('exposes the publisher with its generation and watermark', () => {
    const { journal, publish } = openJournal();
    expect(journal.publisher).toEqual({ publisherId: PUBLISHER, generation: 1, watermark: 0 });
    journal.setHead(publish(), { snapshot: snapshot('idle'), observedAt: 1 });
    expect(journal.publisher).toEqual({ publisherId: PUBLISHER, generation: 1, watermark: 1 });
    expect(SessionJournal.create('host-1:codex:other').publisher).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and see it fail.**

Run: `pnpm --filter @orchardworks/agent-remote-journal exec vitest run src/journal-head.test.ts --testTimeout=10000`
Expected: FAIL with `journal.setHead is not a function` (and `head`/`publisher` reading `undefined`).

- [ ] **Step 3: Implement.** In `packages/agent-remote-journal/src/types.ts`, change the first import to:

```ts
import type { AgentSnapshotPayload, AgentTimelineItem, ResourceBinding, TimelineCollapse, TimelineSeqRange } from '@orchardworks/agent-remote-protocol';
```

Add before `JournalMeta`:

```ts
/** The latest Snapshot a Controller published for the session, and when it observed it. */
export interface JournalHead {
  snapshot: AgentSnapshotPayload;
  observedAt: number;
}
```

and add the field to `JournalMeta`, after `publisher`:

```ts
  /** Absent until the Controller publishes its first Snapshot. */
  head?: JournalHead;
```

In `packages/agent-remote-journal/src/session-journal.ts`, add `type JournalHead, type JournalPublisher,` to the import from `./types.js` (next to `type JournalPublication,`). Add the getters after the `cursor` getter:

```ts
  /** The latest Snapshot the publisher reported, or undefined before the first one. */
  get head(): JournalHead | undefined { return this.meta.head === undefined ? undefined : structuredClone(this.meta.head); }
  /** The publisher that may write now: its generation and last applied publication. Null before the first claim. */
  get publisher(): JournalPublisher | null { return this.meta.publisher === null ? null : { ...this.meta.publisher }; }
```

and the method after `alias`:

```ts
  /** Replaces the head with the Controller's latest Snapshot. */
  setHead(publication: JournalPublication, head: JournalHead): void {
    if (this.duplicate(publication)) return;
    this.advance(publication);
    this.meta.head = structuredClone(head);
  }
```

- [ ] **Step 4: Run the package tests and build it.**

Run: `pnpm --filter @orchardworks/agent-remote-journal exec vitest run --testTimeout=10000 && pnpm --filter @orchardworks/agent-remote-journal run build`
Expected: PASS (every test of the package, including the 5 new ones); build exit code 0.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-journal/src
git commit -m "feat(journal): keep the latest Snapshot as the journal head and expose the publisher"
```

### Task 2: Uplink schemas for journals

**Files:**
- Create: `packages/agent-remote-protocol/src/remote-host-journal.ts`
- Modify: `packages/agent-remote-protocol/src/remote-host-uplink.ts`
- Modify: `packages/agent-remote-protocol/src/index.ts`
- Test: `packages/agent-remote-protocol/src/remote-host-journal.test.ts`

- [ ] **Step 1: Write the failing tests.** `packages/agent-remote-protocol/src/remote-host-journal.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { JOURNAL_FILL_MAX_ITEMS, JOURNAL_MESSAGE_MAX_BYTES, JOURNAL_PUBLISH_MAX_ENTRIES } from './remote-host-journal.js';
import { decodeRemoteHostUplinkMessage, encodeRemoteHostUplinkMessage } from './remote-host-uplink.js';

const SESSION = 'codex:thread-1';
const DIGEST = 'a'.repeat(64);
const row = { itemKey: 'item-1', providerId: 'codex', sourceKey: 'delta-1', occurredAt: 1_725_000_000_000, turnId: 'turn-1',
  item: { type: 'assistant_message', text: 'Hello', messageId: 'item-1' } };
const snapshot = {
  id: 'session-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle', activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status: 'idle' },
};
const message = (fields: Record<string, unknown>) => ({ uplinkVersion: 2, ...fields });
const publish = (entries: unknown[]) => message({ type: 'journal_publish', sessionKey: SESSION, generation: 1, entries });
const seal = (sequence: number) => ({ sequence, op: 'seal', itemKey: 'item-1' });
const indexEntry = { itemKey: 'item-1', seqStart: -2, seqEnd: -1, state: 'complete', digest: DIGEST, liveOnly: false, revision: 3, resident: true };

const valid: Array<Record<string, unknown>> = [
  message({ type: 'journal_open', requestId: 'open-1', sessionKey: SESSION, publisherId: 'controller-1' }),
  publish([
    { sequence: 1, op: 'append', row },
    { sequence: 2, op: 'complete', itemKey: 'item-1', digest: DIGEST },
    { sequence: 3, op: 'seal', itemKey: 'item-1' },
    { sequence: 4, op: 'alias', itemKey: 'item-1', clientMessageId: 'operation-1' },
    { sequence: 5, op: 'correct', row, digest: DIGEST, expectedRevision: 3 },
    { sequence: 6, op: 'replace', items: [{ row, digest: DIGEST }] },
    { sequence: 7, op: 'prepend', items: [{ row, digest: DIGEST }] },
    { sequence: 8, op: 'head', head: { snapshot, observedAt: 1_725_000_000_000 } },
  ]),
  message({ type: 'journal_fill', requestId: 'fill-1', sessionKey: SESSION, items: [{ row, digest: DIGEST }] }),
  message({ type: 'journal_older_done', requestId: 'older-1', sessionKey: SESSION, olderAvailable: true }),
  message({ type: 'journal_opened', requestId: 'open-1', sessionKey: SESSION, generation: 1, watermark: 0, epoch: 'epoch-1', index: [indexEntry] }),
  message({ type: 'journal_ack', sessionKey: SESSION, generation: 1, watermark: 8, cursor: { epoch: 'epoch-1', seq: 4 } }),
  message({ type: 'journal_refused', sessionKey: SESSION, generation: 1, sequence: 3, reason: 'stale_revision', itemKey: 'item-1' }),
  message({ type: 'journal_fill_request', requestId: 'fill-1', sessionKey: SESSION, itemKeys: ['item-1', 'item-2'] }),
  message({ type: 'journal_older_request', requestId: 'older-1', sessionKey: SESSION, limit: 50 }),
];

describe('journal uplink envelopes', () => {
  it.each(valid.map(value => [value.type as string, value] as const))('round trips %s', (_type, value) => {
    const decoded = decodeRemoteHostUplinkMessage(JSON.stringify(value));
    expect(decoded).toEqual({ status: 'ok', value });
    if (decoded.status === 'ok') expect(encodeRemoteHostUplinkMessage(decoded.value)).toEqual({ status: 'ok', json: JSON.stringify(value) });
  });

  it('lets the Relay acknowledge journals when it registers a Host', () => {
    const registered = { uplinkVersion: 2, type: 'registered', journal: 1, hostId: 'host', heartbeat: { intervalMs: 20_000, timeoutMs: 10_000 } };
    expect(decodeRemoteHostUplinkMessage(JSON.stringify(registered)).status).toBe('ok');
    expect(decodeRemoteHostUplinkMessage(JSON.stringify({ ...registered, journal: 2 })).status).toBe('rejected');
  });

  it.each<[string, Record<string, unknown>]>([
    ['a publication without entries', publish([])],
    ['an entry with an unknown operation', publish([{ sequence: 1, op: 'erase', itemKey: 'item-1' }])],
    ['an entry that repeats or reverses a sequence', publish([seal(2), seal(2)])],
    ['an entry with sequence zero', publish([seal(0)])],
    ['a completion without a digest', publish([{ sequence: 1, op: 'complete', itemKey: 'item-1' }])],
    ['a row with an extra field', publish([{ sequence: 1, op: 'append', row: { ...row, title: 'Secret' } }])],
    ['a row with an unknown item type', publish([{ sequence: 1, op: 'append', row: { ...row, item: { type: 'banner', text: 'x' } } }])],
    ['a correction with revision zero', publish([{ sequence: 1, op: 'correct', row, digest: DIGEST, expectedRevision: 0 }])],
    ['a publication with too many entries', publish(Array.from({ length: JOURNAL_PUBLISH_MAX_ENTRIES + 1 }, (_, at) => seal(at + 1)))],
    ['a publication above the byte bound', publish([{ sequence: 1, op: 'append', row: { ...row, item: { type: 'assistant_message', text: 'x'.repeat(JOURNAL_MESSAGE_MAX_BYTES) } } }])],
    ['a fill that repeats an item', message({ type: 'journal_fill', requestId: 'f', sessionKey: SESSION, items: [{ row, digest: DIGEST }, { row, digest: DIGEST }] })],
    ['a fill with too many items', message({ type: 'journal_fill', requestId: 'f', sessionKey: SESSION,
      items: Array.from({ length: JOURNAL_FILL_MAX_ITEMS + 1 }, (_, at) => ({ row: { ...row, itemKey: `item-${at}` }, digest: DIGEST })) })],
    ['a fill request with no items', message({ type: 'journal_fill_request', requestId: 'f', sessionKey: SESSION, itemKeys: [] })],
    ['a fill request that repeats an item', message({ type: 'journal_fill_request', requestId: 'f', sessionKey: SESSION, itemKeys: ['a', 'a'] })],
    ['an older request with limit zero', message({ type: 'journal_older_request', requestId: 'o', sessionKey: SESSION, limit: 0 })],
    ['an older request above the limit', message({ type: 'journal_older_request', requestId: 'o', sessionKey: SESSION, limit: 201 })],
    ['an index entry whose range is reversed', message({ type: 'journal_opened', requestId: 'o', sessionKey: SESSION, generation: 1, watermark: 0, epoch: 'e', index: [{ ...indexEntry, seqStart: 3, seqEnd: 2 }] })],
    ['an acknowledgement without an epoch', message({ type: 'journal_ack', sessionKey: SESSION, generation: 1, watermark: 1, cursor: { seq: 1 } })],
    ['a refusal with an unknown reason', message({ type: 'journal_refused', sessionKey: SESSION, generation: 1, sequence: 1, reason: 'nope' })],
    ['an open without a publisher', message({ type: 'journal_open', requestId: 'o', sessionKey: SESSION })],
  ])('rejects %s', (_name, value) => {
    expect(decodeRemoteHostUplinkMessage(JSON.stringify(value)).status).toBe('rejected');
    expect(encodeRemoteHostUplinkMessage(value as never).status).toBe('rejected');
  });
});
```

- [ ] **Step 2: Run it and see it fail.**

Run: `pnpm --filter @orchardworks/agent-remote-protocol exec vitest run src/remote-host-journal.test.ts --testTimeout=10000`
Expected: FAIL, because `./remote-host-journal.js` does not exist.

- [ ] **Step 3: Implement the schemas.** `packages/agent-remote-protocol/src/remote-host-journal.ts`:

```ts
import { Type, type Static } from '@sinclair/typebox';

import { SafeNonNegativeInteger, SafeTimelinePosition, TimelineCursor } from './cursor.js';
import { ResourceBinding } from './resources.js';
import { AgentSnapshotPayload } from './snapshot.js';
import { AgentTimelineItem } from './timeline.js';
import { UPLINK_MAX_FRAME_BYTES } from './uplink.js';

/**
 * Session journals over the Host uplink. A Controller that asked for them (`journal=1`, acknowledged by
 * `registered.journal: 1`) opens a session's journal, which fences every older connection of that session, publishes
 * entries under the generation it was given, and answers the Relay's requests to read bodies and older history again.
 * The Relay acknowledges a publication only once its store holds it. The messages are listed without their envelope
 * (`uplinkVersion`, `type`), which remote-host-uplink.ts adds.
 */

/** The most entries one publication carries. */
export const JOURNAL_PUBLISH_MAX_ENTRIES = 256;
/** The most UTF-8 bytes of any journal message. */
export const JOURNAL_MESSAGE_MAX_BYTES = UPLINK_MAX_FRAME_BYTES / 4;
/** The most items one replacement or prepend carries. */
export const JOURNAL_ITEMS_PER_ENTRY_MAX = 5000;
/** The most items an index in `journal_opened` lists. */
export const JOURNAL_INDEX_MAX_ITEMS = 30_000;
/** The most bodies one fill carries or asks for. */
export const JOURNAL_FILL_MAX_ITEMS = 64;
/** The most items one older-history read asks for. */
export const JOURNAL_OLDER_MAX_LIMIT = 200;

const object = { additionalProperties: false } as const;
const identity = Type.String({ minLength: 1, maxLength: 512 });
const requestId = identity;
/** `${providerId}:${nativeSessionId}`. */
const sessionKey = Type.String({ minLength: 1, maxLength: 4609 });
const itemKey = Type.String({ minLength: 1, maxLength: 4096 });
const digest = Type.String({ minLength: 1, maxLength: 128 });
const generation = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
/** A time `Date` can represent. */
const milliseconds = Type.Integer({ minimum: 0, maximum: 8_640_000_000_000_000 });

/** One row a Controller publishes: a timeline row plus the native identity of the item it belongs to. */
export const JournalRowInput = Type.Object({
  itemKey, providerId: identity, sourceKey: itemKey,
  nativeRevision: Type.Optional(SafeNonNegativeInteger), occurredAt: milliseconds, turnId: Type.Optional(identity),
  item: AgentTimelineItem, resources: Type.Optional(Type.Array(ResourceBinding, { maxItems: 256 })),
  /** A row that a reread of native history cannot reproduce. */
  liveOnly: Type.Optional(Type.Boolean()),
}, object);
export type JournalRowInput = Static<typeof JournalRowInput>;

/** A complete item from native history: one row carrying its whole content, and its digest. */
export const CompleteItemInput = Type.Object({ row: JournalRowInput, digest }, object);
export type CompleteItemInput = Static<typeof CompleteItemInput>;

export const JournalIndexEntry = Type.Object({
  itemKey, seqStart: SafeTimelinePosition, seqEnd: SafeTimelinePosition,
  state: Type.Union([Type.Literal('open'), Type.Literal('complete')]),
  digest: Type.Optional(digest), liveOnly: Type.Boolean(), clientMessageId: Type.Optional(identity),
  revision, resident: Type.Boolean(),
}, object);
export type JournalIndexEntry = Static<typeof JournalIndexEntry>;

export const JournalHead = Type.Object({ snapshot: AgentSnapshotPayload, observedAt: milliseconds }, object);
export type JournalHead = Static<typeof JournalHead>;

const sequence = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const items = Type.Array(CompleteItemInput, { maxItems: JOURNAL_ITEMS_PER_ENTRY_MAX });
export const JournalPublishEntry = Type.Union([
  Type.Object({ sequence, op: Type.Literal('append'), row: JournalRowInput }, object),
  Type.Object({ sequence, op: Type.Literal('complete'), itemKey, digest }, object),
  Type.Object({ sequence, op: Type.Literal('seal'), itemKey }, object),
  Type.Object({ sequence, op: Type.Literal('alias'), itemKey, clientMessageId: identity }, object),
  Type.Object({ sequence, op: Type.Literal('correct'), row: JournalRowInput, digest, expectedRevision: revision }, object),
  Type.Object({ sequence, op: Type.Literal('replace'), items }, object),
  Type.Object({ sequence, op: Type.Literal('prepend'), items }, object),
  Type.Object({ sequence, op: Type.Literal('head'), head: JournalHead }, object),
]);
export type JournalPublishEntry = Static<typeof JournalPublishEntry>;

export const JOURNAL_REFUSAL_REASONS = ['fenced', 'stale_revision', 'unknown_item', 'body_missing', 'type_changed', 'duplicate_item', 'invalid'] as const;
export const JournalRefusalReason = Type.Union(JOURNAL_REFUSAL_REASONS.map(reason => Type.Literal(reason)));
export type JournalRefusalReason = (typeof JOURNAL_REFUSAL_REASONS)[number];

/** Host to Relay. */
export const JournalOpen = Type.Object({ requestId, sessionKey, publisherId: identity }, object);
export const JournalPublish = Type.Object({ sessionKey, generation, entries: Type.Array(JournalPublishEntry, { minItems: 1, maxItems: JOURNAL_PUBLISH_MAX_ENTRIES }) }, object);
export const JournalFill = Type.Object({ requestId, sessionKey, items: Type.Array(CompleteItemInput, { maxItems: JOURNAL_FILL_MAX_ITEMS }) }, object);
export const JournalOlderDone = Type.Object({ requestId, sessionKey, olderAvailable: Type.Boolean() }, object);

/** Relay to Host. */
export const JournalOpened = Type.Object({ requestId, sessionKey, generation, watermark: SafeNonNegativeInteger, epoch: identity,
  index: Type.Array(JournalIndexEntry, { maxItems: JOURNAL_INDEX_MAX_ITEMS }) }, object);
export const JournalAck = Type.Object({ sessionKey, generation, watermark: SafeNonNegativeInteger, cursor: TimelineCursor }, object);
export const JournalRefused = Type.Object({ sessionKey, generation, sequence: SafeNonNegativeInteger, reason: JournalRefusalReason, itemKey: Type.Optional(itemKey) }, object);
export const JournalFillRequest = Type.Object({ requestId, sessionKey, itemKeys: Type.Array(itemKey, { minItems: 1, maxItems: JOURNAL_FILL_MAX_ITEMS }) }, object);
export const JournalOlderRequest = Type.Object({ requestId, sessionKey, limit: Type.Integer({ minimum: 1, maximum: JOURNAL_OLDER_MAX_LIMIT }) }, object);

const encoder = new (globalThis as unknown as { TextEncoder: new () => { encode(value: string): Uint8Array } }).TextEncoder();
const distinct = (keys: readonly string[]) => new Set(keys).size === keys.length;

/** The rules the schemas cannot state: size, strictly increasing entries, distinct items and well-ordered ranges. */
export function validJournalMessage(message: { type: string }): boolean {
  if (encoder.encode(JSON.stringify(message)).length > JOURNAL_MESSAGE_MAX_BYTES) return false;
  switch (message.type) {
    case 'journal_publish': {
      const { entries } = message as unknown as Static<typeof JournalPublish>;
      return entries.every((entry, at) => at === 0 || entry.sequence > entries[at - 1]!.sequence);
    }
    case 'journal_fill': return distinct((message as unknown as Static<typeof JournalFill>).items.map(({ row }) => row.itemKey));
    case 'journal_fill_request': return distinct((message as unknown as Static<typeof JournalFillRequest>).itemKeys);
    case 'journal_opened': return (message as unknown as Static<typeof JournalOpened>).index.every(entry => entry.seqStart <= entry.seqEnd);
    default: return true;
  }
}
```

In `packages/agent-remote-protocol/src/remote-host-uplink.ts`:

1. After the line `import { HostSessionStates } from './session-states.js';` add:

```ts
import { JournalAck, JournalFill, JournalFillRequest, JournalOlderDone, JournalOlderRequest, JournalOpen, JournalOpened, JournalPublish, JournalRefused, validJournalMessage } from './remote-host-journal.js';
```

2. In the `registered` object, add `journal: Type.Optional(Type.Literal(1)), ` right after `outbox: Type.Optional(Type.Literal(1)), `.

3. After the `session_states` line (`Type.Object({ uplinkVersion: version, type: Type.Literal('session_states'), ...HostSessionStates.properties }, object),`) add:

```ts
  // Journals: only after the Relay acknowledged journal: 1 in registered. The Controller opens a session's journal, publishes to it
  // and answers fills and older-history reads; the Relay acknowledges durable publications, refuses what it cannot apply and asks for reads.
  Type.Object({ uplinkVersion: version, type: Type.Literal('journal_open'), ...JournalOpen.properties }, object),
  Type.Object({ uplinkVersion: version, type: Type.Literal('journal_publish'), ...JournalPublish.properties }, object),
  Type.Object({ uplinkVersion: version, type: Type.Literal('journal_fill'), ...JournalFill.properties }, object),
  Type.Object({ uplinkVersion: version, type: Type.Literal('journal_older_done'), ...JournalOlderDone.properties }, object),
  Type.Object({ uplinkVersion: version, type: Type.Literal('journal_opened'), ...JournalOpened.properties }, object),
  Type.Object({ uplinkVersion: version, type: Type.Literal('journal_ack'), ...JournalAck.properties }, object),
  Type.Object({ uplinkVersion: version, type: Type.Literal('journal_refused'), ...JournalRefused.properties }, object),
  Type.Object({ uplinkVersion: version, type: Type.Literal('journal_fill_request'), ...JournalFillRequest.properties }, object),
  Type.Object({ uplinkVersion: version, type: Type.Literal('journal_older_request'), ...JournalOlderRequest.properties }, object),
```

4. In `RemoteHostUplinkBrokerMessage`, replace `'team_response' | 'outbox_response'` with `'team_response' | 'outbox_response' | 'journal_opened' | 'journal_ack' | 'journal_refused' | 'journal_fill_request' | 'journal_older_request'`.

5. In `validRemoteHostUplinkMessage`, directly after `if (!Value.Check(RemoteHostUplinkMessage, value)) return false;` add:

```ts
  if (value.type.startsWith('journal_') && !validJournalMessage(value)) return false;
```

In `packages/agent-remote-protocol/src/index.ts`, add after `export * from './remote-host-uplink.js';`:

```ts
export * from './remote-host-journal.js';
```

- [ ] **Step 4: Run the new tests and the protocol suite.**

Run: `pnpm --filter @orchardworks/agent-remote-protocol exec vitest run --testTimeout=10000`
Expected: PASS for every test file, including 9 round trips, the `registered.journal` test and 20 rejections. A failure of an unrelated uplink test means the union edit broke an existing shape.

- [ ] **Step 5: Typecheck and build the protocol, so dependants resolve the new types.**

Run: `pnpm --filter @orchardworks/agent-remote-protocol run typecheck && pnpm --filter @orchardworks/agent-remote-protocol run build`
Expected: exit code 0.

- [ ] **Step 6: Commit.**

```bash
git add packages/agent-remote-protocol/src
git commit -m "feat(protocol): carry session journals over the Host uplink behind journal=1"
```

### Task 3: The Host journal service

**Files:**
- Modify: `packages/agent-remote-hosted/package.json`
- Create: `packages/agent-remote-hosted/src/host-journals.ts`
- Modify: `packages/agent-remote-hosted/src/index.ts`
- Test: `packages/agent-remote-hosted/src/host-journals.test.ts`

- [ ] **Step 1: Declare the dependency and link it.** In `packages/agent-remote-hosted/package.json`, add to `dependencies`, before the protocol entry:

```json
    "@orchardworks/agent-remote-journal": "workspace:*",
```

Run: `pnpm install --offline`
Expected: exit code 0; `git diff --stat pnpm-lock.yaml` shows the `packages/agent-remote-hosted` importer gaining a `link:../agent-remote-journal` entry, and `ls packages/agent-remote-hosted/node_modules/@orchardworks/` lists `agent-remote-journal`. (If the offline store lacks a package, run `pnpm install` once online.)

- [ ] **Step 2: Write the failing tests.** `packages/agent-remote-hosted/src/host-journals.test.ts`:

```ts
import { MemoryJournalStore, SessionJournal, type JournalStore } from '@orchardworks/agent-remote-journal';
import type { JournalPublishEntry } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { createHostJournals } from './host-journals.js';

const HOST = 'host-1';
const SESSION = 'codex:thread-1';
const KEY = `${HOST}:${SESSION}`;
const PAGE = { requestId: 'page-1', agentId: 'agent-1', direction: 'tail' as const, limit: 10 };
const row = (itemKey: string, text: string) => ({
  itemKey, providerId: 'codex', sourceKey: `${itemKey}:${text}`, occurredAt: 1_725_000_000_000, turnId: 'turn-1',
  item: { type: 'assistant_message' as const, text, messageId: itemKey },
});
const append = (sequence: number, itemKey: string, text: string): JournalPublishEntry => ({ sequence, op: 'append', row: row(itemKey, text) });
const complete = (sequence: number, itemKey: string, digest = `digest-${itemKey}`): JournalPublishEntry => ({ sequence, op: 'complete', itemKey, digest });
const snapshot = {
  id: 'session-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle' as const, activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status: 'idle' as const },
};

function fixture(store: JournalStore = new MemoryJournalStore()) {
  return { journals: createHostJournals({ store, now: () => 1_000 }), store };
}

describe('createHostJournals', () => {
  it('opens a journal and fences the previous generation on every open', async () => {
    const { journals, store } = fixture();
    const first = await journals.open(HOST, SESSION, 'controller-1');
    expect(first).toMatchObject({ generation: 1, watermark: 0, index: [] });
    expect(typeof first.epoch).toBe('string');
    expect((await store.load(KEY))?.meta.publisher).toEqual({ publisherId: 'controller-1', generation: 1, watermark: 0 });
    expect(await journals.open(HOST, SESSION, 'controller-1')).toMatchObject({ generation: 2, epoch: first.epoch });
  });

  it('applies a publication in order, stores it before returning and reports the stamped rows', async () => {
    const { journals, store } = fixture();
    const opened = await journals.open(HOST, SESSION, 'controller-1');
    const result = await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hel'), append(2, 'm1', 'lo'), complete(3, 'm1'), append(4, 'm2', 'Next')]);
    expect(result.refusal).toBeUndefined();
    expect(result.rows.map(({ itemKey, seq }) => [itemKey, seq])).toEqual([['m1', 1], ['m1', 2], ['m2', 3]]);
    expect(result).toMatchObject({ watermark: 4, cursor: { epoch: opened.epoch, seq: 3 } });
    const saved = await store.load(KEY);
    expect(saved?.meta.publisher?.watermark).toBe(4);
    expect(saved?.items.map(({ itemKey, state }) => [itemKey, state])).toEqual([['m1', 'complete'], ['m2', 'open']]);
    expect((await journals.open(HOST, SESSION, 'controller-1')).index.map(({ itemKey }) => itemKey)).toEqual(['m1', 'm2']);
  });

  it('acknowledges a publication it already applied without changing the journal', async () => {
    const { journals } = fixture();
    await journals.open(HOST, SESSION, 'controller-1');
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello')]);
    const again = await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello')]);
    expect(again).toMatchObject({ rows: [], watermark: 1, cursor: { seq: 1 } });
    expect(again.refusal).toBeUndefined();
  });

  it('stops at the first refused entry and keeps and acknowledges the ones before it', async () => {
    const { journals, store } = fixture();
    await journals.open(HOST, SESSION, 'controller-1');
    const result = await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'One'), complete(2, 'ghost'), append(3, 'm3', 'Three')]);
    expect(result.rows.map(({ itemKey }) => itemKey)).toEqual(['m1']);
    expect(result).toMatchObject({ watermark: 1, refusal: { sequence: 2, reason: 'unknown_item', itemKey: 'ghost' } });
    expect((await store.load(KEY))?.items.map(({ itemKey }) => itemKey)).toEqual(['m1']);
  });

  it('names the reason of every refusal the journal can raise', async () => {
    const { journals } = fixture();
    await journals.open(HOST, SESSION, 'controller-1');
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello'), complete(2, 'm1')]);
    const refusal = async (entry: JournalPublishEntry) => (await journals.publish(HOST, SESSION, 1, [entry])).refusal;
    expect(await refusal({ sequence: 3, op: 'correct', row: row('m1', 'Hello!'), digest: 'd', expectedRevision: 99 })).toEqual({ sequence: 3, reason: 'stale_revision', itemKey: 'm1' });
    expect(await refusal(complete(3, 'ghost'))).toEqual({ sequence: 3, reason: 'unknown_item', itemKey: 'ghost' });
    expect(await refusal({ sequence: 3, op: 'append', row: { ...row('m1', 'x'), item: { type: 'reasoning', text: 'x' } } })).toEqual({ sequence: 3, reason: 'type_changed', itemKey: 'm1' });
    expect(await refusal({ sequence: 3, op: 'replace', items: [{ row: row('a', 'x'), digest: 'd1' }, { row: row('a', 'y'), digest: 'd2' }] })).toEqual({ sequence: 3, reason: 'duplicate_item', itemKey: 'a' });
    expect(await refusal({ sequence: 3, op: 'append', row: { ...row('m2', 'x'), occurredAt: Number.NaN } })).toEqual({ sequence: 3, reason: 'invalid' });
  });

  it('refuses an append to an item whose body was evicted', async () => {
    const store = new MemoryJournalStore();
    const seeded = SessionJournal.create(KEY);
    const { generation } = seeded.claim('controller-1');
    const publication = (sequence: number) => ({ publisherId: 'controller-1', generation, sequence });
    seeded.append(publication(1), row('m1', 'Hello'));
    seeded.complete(publication(2), 'm1', 'digest-m1');
    seeded.evict(0);
    await store.apply(seeded.takeChanges()!);
    const { journals } = fixture(store);
    const opened = await journals.open(HOST, SESSION, 'controller-1');
    expect(opened).toMatchObject({ generation: 2, watermark: 2, index: [expect.objectContaining({ itemKey: 'm1', resident: false })] });
    const result = await journals.publish(HOST, SESSION, 2, [append(3, 'm1', 'more')]);
    expect(result.refusal).toEqual({ sequence: 3, reason: 'body_missing', itemKey: 'm1' });
  });

  it('refuses a fenced generation and a session that was never opened, without changing anything', async () => {
    const { journals, store } = fixture();
    await journals.open(HOST, SESSION, 'controller-1');
    await journals.open(HOST, SESSION, 'controller-1');
    const stale = await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hi')]);
    expect(stale).toMatchObject({ rows: [], refusal: { sequence: 1, reason: 'fenced' } });
    expect((await store.load(KEY))?.items).toEqual([]);
    const unopened = await journals.publish(HOST, 'codex:unknown', 1, [append(5, 'm1', 'Hi')]);
    expect(unopened).toEqual({ rows: [], watermark: 0, refusal: { sequence: 5, reason: 'fenced' } });
    expect(await store.load(`${HOST}:codex:unknown`)).toBeUndefined();
  });

  it('stores the head and reports the new epoch of a replacement', async () => {
    const { journals, store } = fixture();
    const opened = await journals.open(HOST, SESSION, 'controller-1');
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Old')]);
    const result = await journals.publish(HOST, SESSION, 1, [
      { sequence: 2, op: 'head', head: { snapshot, observedAt: 7 } },
      { sequence: 3, op: 'replace', items: [{ row: row('x1', 'Fresh'), digest: 'digest-x1' }] },
    ]);
    expect(result.replacedEpoch).toBeDefined();
    expect(result.replacedEpoch).not.toBe(opened.epoch);
    expect(result.cursor).toEqual({ epoch: result.replacedEpoch, seq: 1 });
    const saved = await store.load(KEY);
    expect(saved?.meta.head).toEqual({ snapshot, observedAt: 7 });
    expect(saved?.items.map(({ itemKey }) => itemKey)).toEqual(['x1']);
  });

  it('does not return before the store holds the changes', async () => {
    const memory = new MemoryJournalStore();
    let hold = false, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const store: JournalStore = { load: key => memory.load(key), delete: key => memory.delete(key),
      apply: async changes => { if (hold) await gate; await memory.apply(changes); } };
    const { journals } = fixture(store);
    await journals.open(HOST, SESSION, 'controller-1');
    hold = true;
    let settled = false;
    const published = journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello')]).then(result => { settled = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect((await memory.load(KEY))?.items).toEqual([]);
    release();
    expect((await published).watermark).toBe(1);
    expect((await memory.load(KEY))?.items).toHaveLength(1);
  });

  it('reloads the stored state after a failed write and propagates the failure', async () => {
    const memory = new MemoryJournalStore();
    let failing = false;
    const store: JournalStore = { load: key => memory.load(key), delete: key => memory.delete(key),
      apply: async changes => { if (failing) throw new Error('disk full'); await memory.apply(changes); } };
    const { journals } = fixture(store);
    await journals.open(HOST, SESSION, 'controller-1');
    failing = true;
    await expect(journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello')])).rejects.toThrow('disk full');
    failing = false;
    expect(await journals.open(HOST, SESSION, 'controller-1')).toMatchObject({ generation: 2, watermark: 0, index: [] });
  });

  it('serializes the work of one Host in call order', async () => {
    const { journals } = fixture();
    await journals.open(HOST, SESSION, 'controller-1');
    const results = await Promise.all([
      journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'a')]),
      journals.publish(HOST, SESSION, 1, [append(2, 'm2', 'b')]),
      journals.publish(HOST, SESSION, 1, [append(3, 'm3', 'c')]),
    ]);
    expect(results.map(result => result.watermark)).toEqual([1, 2, 3]);
    expect(results.map(result => result.rows[0]?.seq)).toEqual([1, 2, 3]);
  });

  it('keeps the journals of different Hosts apart and survives forgetting a Host', async () => {
    const { journals } = fixture();
    await journals.open(HOST, SESSION, 'controller-1');
    await journals.open('host-2', SESSION, 'controller-2');
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello')]);
    expect((await journals.open('host-2', SESSION, 'controller-2')).index).toEqual([]);
    await journals.forget(HOST);
    expect(await journals.open(HOST, SESSION, 'controller-1')).toMatchObject({ generation: 2, watermark: 1, index: [expect.objectContaining({ itemKey: 'm1' })] });
  });

  it('puts bodies back only when their digest matches the recorded one', async () => {
    const { journals } = fixture();
    await journals.open(HOST, SESSION, 'controller-1');
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello'), complete(2, 'm1', 'digest-m1')]);
    expect(await journals.fill(HOST, SESSION, [{ row: row('m1', 'Hello'), digest: 'digest-m1' }])).toEqual({ filled: ['m1'], mismatched: [], unknown: [] });
    expect(await journals.fill(HOST, SESSION, [{ row: row('m1', 'Hello'), digest: 'other' }])).toEqual({ filled: [], mismatched: ['m1'], unknown: [] });
    expect(await journals.fill(HOST, SESSION, [{ row: row('ghost', 'x'), digest: 'd' }])).toEqual({ filled: [], mismatched: [], unknown: ['ghost'] });
    expect(await journals.fill(HOST, 'codex:none', [{ row: row('m1', 'x'), digest: 'd' }])).toEqual({ filled: [], mismatched: [], unknown: ['m1'] });
  });

  it('serves pages and reports a missing journal', async () => {
    const { journals } = fixture();
    await journals.open(HOST, SESSION, 'controller-1');
    await journals.publish(HOST, SESSION, 1, [append(1, 'm1', 'Hello')]);
    const tail = await journals.page(HOST, SESSION, PAGE, false);
    expect(tail?.kind).toBe('page');
    if (tail?.kind === 'page') expect(tail.page.payload.entries).toHaveLength(1);
    expect(await journals.page(HOST, 'codex:none', PAGE, false)).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run them and see them fail.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/host-journals.test.ts --testTimeout=10000`
Expected: FAIL, because `./host-journals.js` does not exist.

- [ ] **Step 4: Implement.** `packages/agent-remote-hosted/src/host-journals.ts`:

```ts
import {
  bodyFromRow, JournalBodyMissingError, JournalDuplicateItemError, JournalFencedError, JournalItemTypeChangedError, JournalStaleRevisionError,
  JournalUnknownItemError, SessionJournal,
  type JournalIndexEntry, type JournalPageRequest, type JournalPageResult, type JournalPublication, type JournalRow, type JournalStore,
} from '@orchardworks/agent-remote-journal';
import type { CompleteItemInput, JournalPublishEntry, JournalRefusalReason, TimelineCursor } from '@orchardworks/agent-remote-protocol';

export interface HostJournalsOptions {
  store: JournalStore;
  now(): number;
}

export interface JournalOpened {
  generation: number;
  watermark: number;
  epoch: string;
  index: JournalIndexEntry[];
}

export interface JournalRefusal {
  sequence: number;
  reason: JournalRefusalReason;
  itemKey?: string;
}

export interface JournalPublished {
  /** The rows the journal stamped, in order, for the subscribers that read this session. */
  rows: JournalRow[];
  /** The last publication applied; everything up to it is stored. */
  watermark: number;
  /** The journal's cursor after the publication; absent when the session has no journal. */
  cursor?: TimelineCursor;
  /** Set when a replacement started a new epoch. */
  replacedEpoch?: string;
  /** The first entry the journal refused; entries before it are applied and stored. */
  refusal?: JournalRefusal;
}

export interface JournalFilled {
  filled: string[];
  mismatched: string[];
  unknown: string[];
}

/**
 * The session journals of the Hosts of one Relay account. Journals are keyed by Host and session, loaded from the
 * store when first used, and changed only through this service. All work of one Host runs one call at a time.
 */
export interface HostJournals {
  /** Claims the session's journal for a publisher, creating it when needed, and fences every older generation. */
  open(hostId: string, sessionKey: string, publisherId: string): Promise<JournalOpened>;
  /** Applies entries in order and stores the changes before returning. */
  publish(hostId: string, sessionKey: string, generation: number, entries: readonly JournalPublishEntry[]): Promise<JournalPublished>;
  /** Puts bodies the Host read again back into the journal. */
  fill(hostId: string, sessionKey: string, items: readonly CompleteItemInput[]): Promise<JournalFilled>;
  /** A page of the session's journal, or undefined when it has none. */
  page(hostId: string, sessionKey: string, request: JournalPageRequest, olderBeyondJournal: boolean): Promise<JournalPageResult | undefined>;
  /** Drops what is cached for a Host; the store keeps the journals. */
  forget(hostId: string): Promise<void>;
}

export function createHostJournals(options: HostJournalsOptions): HostJournals {
  const { store, now } = options;
  const cache = new Map<string, Map<string, SessionJournal>>();
  const chains = new Map<string, Promise<void>>();
  const storeKey = (hostId: string, sessionKey: string) => `${hostId}:${sessionKey}`;

  function serialized<T>(hostId: string, work: () => Promise<T>): Promise<T> {
    const result = (chains.get(hostId) ?? Promise.resolve()).then(work);
    const tail = result.then(() => undefined, () => undefined);
    chains.set(hostId, tail);
    void tail.then(() => { if (chains.get(hostId) === tail) chains.delete(hostId); });
    return result;
  }

  async function load(hostId: string, sessionKey: string, create: boolean): Promise<SessionJournal | undefined> {
    const cached = cache.get(hostId)?.get(sessionKey);
    if (cached) return cached;
    const saved = await store.load(storeKey(hostId, sessionKey));
    const journal = saved ? new SessionJournal(saved) : create ? SessionJournal.create(storeKey(hostId, sessionKey)) : undefined;
    if (journal) {
      const sessions = cache.get(hostId) ?? new Map<string, SessionJournal>();
      sessions.set(sessionKey, journal);
      cache.set(hostId, sessions);
    }
    return journal;
  }

  /** Writes what changed. After a failed write the cached journal is ahead of the store, so it is dropped. */
  async function persist(hostId: string, sessionKey: string, journal: SessionJournal): Promise<void> {
    const changes = journal.takeChanges();
    if (!changes) return;
    try { await store.apply(changes); }
    catch (error) { cache.get(hostId)?.delete(sessionKey); throw error; }
  }

  function apply(journal: SessionJournal, publication: JournalPublication, entry: JournalPublishEntry, published: JournalPublished): void {
    switch (entry.op) {
      case 'append': { const row = journal.append(publication, entry.row); if (row) published.rows.push(row); break; }
      case 'complete': journal.complete(publication, entry.itemKey, entry.digest); break;
      case 'seal': journal.seal(publication, entry.itemKey); break;
      case 'alias': journal.alias(publication, entry.itemKey, entry.clientMessageId); break;
      case 'correct': { const row = journal.correct(publication, entry.row, entry.digest, entry.expectedRevision); if (row) published.rows.push(row); break; }
      case 'replace': {
        const before = journal.epoch;
        const epoch = journal.replace(publication, entry.items, now());
        if (epoch !== before) published.replacedEpoch = epoch;
        break;
      }
      case 'prepend': published.rows.push(...journal.prepend(publication, entry.items)); break;
      case 'head': journal.setHead(publication, entry.head); break;
    }
  }

  /** The refusal for an error the journal raises on purpose; undefined for an unexpected one. */
  function refusalOf(error: unknown, sequence: number): JournalRefusal | undefined {
    if (error instanceof JournalFencedError) return { sequence, reason: 'fenced' };
    if (error instanceof JournalStaleRevisionError) return { sequence, reason: 'stale_revision', itemKey: error.itemKey };
    if (error instanceof JournalUnknownItemError) return { sequence, reason: 'unknown_item', itemKey: error.itemKey };
    if (error instanceof JournalBodyMissingError) return { sequence, reason: 'body_missing', itemKey: error.itemKey };
    if (error instanceof JournalItemTypeChangedError) return { sequence, reason: 'type_changed', itemKey: error.itemKey };
    if (error instanceof JournalDuplicateItemError) return { sequence, reason: 'duplicate_item', itemKey: error.itemKey };
    if (error instanceof JournalInvalidRowError) return { sequence, reason: 'invalid', itemKey: error.itemKey };
    if (error instanceof JournalInvalidPublicationError) return { sequence, reason: 'invalid' };
    return undefined;
  }

  return {
    open: (hostId, sessionKey, publisherId) => serialized<JournalOpened>(hostId, async () => {
      const journal = (await load(hostId, sessionKey, true))!;
      const { generation, watermark } = journal.claim(publisherId);
      await persist(hostId, sessionKey, journal);
      return { generation, watermark, epoch: journal.epoch, index: journal.index() };
    }),

    publish: (hostId, sessionKey, generation, entries) => serialized<JournalPublished>(hostId, async () => {
      const journal = await load(hostId, sessionKey, false);
      const publisherId = journal?.publisher?.publisherId;
      if (!journal || publisherId === undefined) return { rows: [], watermark: 0, refusal: { sequence: entries[0]?.sequence ?? 0, reason: 'fenced' } };
      const published: JournalPublished = { rows: [], watermark: 0 };
      for (const entry of entries) {
        try { apply(journal, { publisherId, generation, sequence: entry.sequence }, entry, published); }
        catch (error) {
          const refusal = refusalOf(error, entry.sequence);
          if (!refusal) { cache.get(hostId)?.delete(sessionKey); throw error; }
          published.refusal = refusal;
          break;
        }
      }
      await persist(hostId, sessionKey, journal);
      return { ...published, watermark: journal.publisher?.watermark ?? 0, cursor: journal.cursor };
    }),

    fill: (hostId, sessionKey, items) => serialized<JournalFilled>(hostId, async () => {
      const filled: string[] = [], mismatched: string[] = [], unknown: string[] = [];
      const journal = await load(hostId, sessionKey, false);
      for (const { row, digest } of items) {
        const outcome = journal ? journal.fill(row.itemKey, bodyFromRow(row), digest) : 'unknown';
        (outcome === 'filled' ? filled : outcome === 'mismatch' ? mismatched : unknown).push(row.itemKey);
      }
      if (journal) await persist(hostId, sessionKey, journal);
      return { filled, mismatched, unknown };
    }),

    page: (hostId, sessionKey, request, olderBeyondJournal) => serialized<JournalPageResult | undefined>(hostId, async () =>
      (await load(hostId, sessionKey, false))?.page(request, { olderBeyondJournal })),

    forget: hostId => serialized<void>(hostId, async () => { cache.delete(hostId); }),
  };
}
```

In `packages/agent-remote-hosted/src/index.ts`, add after the `broker.js` export line:

```ts
export { createHostJournals, type HostJournals, type HostJournalsOptions, type JournalFilled, type JournalOpened, type JournalPublished, type JournalRefusal } from './host-journals.js';
```

- [ ] **Step 5: Run the tests and typecheck.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/host-journals.test.ts --testTimeout=10000 && pnpm --filter @orchardworks/agent-remote-hosted run typecheck`
Expected: PASS, 14 tests; typecheck exit code 0. A type error on `entry.row` passed to `journal.append` means the wire `JournalRowInput` and the journal's `JournalRowInput` diverged; fix the schema, not the call.

- [ ] **Step 6: Commit.**

```bash
git add packages/agent-remote-hosted/package.json packages/agent-remote-hosted/src/host-journals.ts packages/agent-remote-hosted/src/host-journals.test.ts packages/agent-remote-hosted/src/index.ts pnpm-lock.yaml
git commit -m "feat(hosted): keep Host session journals behind the journal store port"
```

### Task 4: The per-connection journal adapter

**Files:**
- Create: `packages/agent-remote-hosted/src/journal-uplink.ts`
- Test: `packages/agent-remote-hosted/src/journal-uplink.test.ts`

- [ ] **Step 1: Write the failing tests.** `packages/agent-remote-hosted/src/journal-uplink.test.ts`:

```ts
import { MemoryJournalStore } from '@orchardworks/agent-remote-journal';
import { decodeRemoteHostUplinkMessage, JOURNAL_INDEX_MAX_ITEMS } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { createHostJournals, type HostJournals } from './host-journals.js';
import { createJournalConnection, isJournalHostMessage, JOURNAL_REQUEST_LIMIT, JOURNAL_REQUEST_TIMEOUT_MS, type JournalHostMessage } from './journal-uplink.js';

const SESSION = 'codex:thread-1';
const DIGEST = 'a'.repeat(64);
const row = (itemKey: string, text: string) => ({
  itemKey, providerId: 'codex', sourceKey: `${itemKey}:${text}`, occurredAt: 1_725_000_000_000, turnId: 'turn-1',
  item: { type: 'assistant_message', text, messageId: itemKey },
});

/** A message as the Relay decodes it from the Host. */
function wire(fields: Record<string, unknown>): JournalHostMessage {
  const decoded = decodeRemoteHostUplinkMessage(JSON.stringify({ uplinkVersion: 2, ...fields }));
  if (decoded.status !== 'ok' || !isJournalHostMessage(decoded.value)) throw new Error('Not a journal message from the Host.');
  return decoded.value;
}

type Sent = { type: string; [field: string]: unknown };

function fixture(options: { journals?: HostJournals } = {}) {
  const store = new MemoryJournalStore();
  const journals = options.journals ?? createHostJournals({ store, now: () => 1_000 });
  const sent: Sent[] = [];
  const timers = new Map<number, { callback(): void; delayMs: number }>();
  let nextTimer = 0, live = true, sendFailure: Error | undefined;
  const connection = createJournalConnection({
    hostId: 'host-1', journals, current: () => live,
    send: message => { if (sendFailure) throw sendFailure; sent.push(message as unknown as Sent); },
    scheduler: { setTimeout: (callback, delayMs) => { timers.set(++nextTimer, { callback, delayMs }); return nextTimer; }, clearTimeout: timer => { timers.delete(timer as number); } },
  });
  return {
    connection, store, sent, timers,
    endConnection() { live = false; },
    failSends(error: Error) { sendFailure = error; },
    expireOldestTimer() { const [id, timer] = [...timers][0]!; timers.delete(id); timer.callback(); },
    async open() {
      await connection.receive(wire({ type: 'journal_open', requestId: 'open-1', sessionKey: SESSION, publisherId: 'controller-1' }));
      return sent.at(-1)!;
    },
    publish: (entries: unknown[], generation = 1) => connection.receive(wire({ type: 'journal_publish', sessionKey: SESSION, generation, entries })),
  };
}
const requestIdOf = (sent: Sent[], type: string) => String(sent.find(message => message.type === type)!.requestId);

describe('a journal connection', () => {
  it('answers an open with the generation, watermark, epoch and index', async () => {
    const f = fixture();
    expect(await f.open()).toMatchObject({ type: 'journal_opened', uplinkVersion: 2, requestId: 'open-1', sessionKey: SESSION, generation: 1, watermark: 0, index: [] });
  });

  it('acknowledges a publication only after the store holds it', async () => {
    const f = fixture();
    const opened = await f.open();
    await f.publish([{ sequence: 1, op: 'append', row: row('m1', 'Hello') }, { sequence: 2, op: 'complete', itemKey: 'm1', digest: DIGEST }]);
    expect(f.sent.at(-1)).toMatchObject({ type: 'journal_ack', sessionKey: SESSION, generation: 1, watermark: 2, cursor: { epoch: opened.epoch, seq: 1 } });
    expect((await f.store.load(`host-1:${SESSION}`))?.items).toEqual([expect.objectContaining({ itemKey: 'm1', digest: DIGEST })]);
  });

  it('acknowledges the applied entries and refuses the first one the journal rejects', async () => {
    const f = fixture();
    await f.open();
    await f.publish([{ sequence: 1, op: 'append', row: row('m1', 'Hello') }, { sequence: 2, op: 'complete', itemKey: 'ghost', digest: DIGEST }]);
    expect(f.sent.slice(-2)).toMatchObject([
      { type: 'journal_ack', watermark: 1 },
      { type: 'journal_refused', sessionKey: SESSION, generation: 1, sequence: 2, reason: 'unknown_item', itemKey: 'ghost' },
    ]);
  });

  it('refuses a publication for a session this connection did not open', async () => {
    const f = fixture();
    await f.publish([{ sequence: 4, op: 'seal', itemKey: 'm1' }]);
    expect(f.sent).toEqual([expect.objectContaining({ type: 'journal_refused', generation: 1, sequence: 4, reason: 'fenced' })]);
    expect(await f.store.load(`host-1:${SESSION}`)).toBeUndefined();
  });

  it('fences the first generation when the session is opened again', async () => {
    const f = fixture();
    await f.open();
    expect(await f.open()).toMatchObject({ type: 'journal_opened', generation: 2 });
    f.sent.length = 0;
    await f.publish([{ sequence: 1, op: 'append', row: row('m1', 'Hello') }], 1);
    expect(f.sent).toEqual([expect.objectContaining({ type: 'journal_refused', generation: 1, reason: 'fenced' })]);
    await f.publish([{ sequence: 1, op: 'append', row: row('m1', 'Hello') }], 2);
    expect(f.sent.at(-1)).toMatchObject({ type: 'journal_ack', generation: 2, watermark: 1 });
  });

  it('fails an open whose index no single message can carry', async () => {
    const huge: HostJournals = { ...createHostJournals({ store: new MemoryJournalStore(), now: () => 1 }),
      open: async () => ({ generation: 1, watermark: 0, epoch: 'e', index: Array.from({ length: JOURNAL_INDEX_MAX_ITEMS + 1 }, (_, at) => ({
        itemKey: `i${at}`, seqStart: at, seqEnd: at, state: 'complete' as const, liveOnly: false, revision: 1, resident: true })) }) };
    const f = fixture({ journals: huge });
    await expect(f.open()).rejects.toThrow(/more items/);
    expect(f.sent).toEqual([]);
  });

  it('sends nothing once the uplink connection is no longer current', async () => {
    const f = fixture();
    await f.open();
    f.sent.length = 0;
    f.endConnection();
    await f.publish([{ sequence: 1, op: 'append', row: row('m1', 'Hello') }]);
    expect(f.sent).toEqual([]);
  });

  describe('requests to the Host', () => {
    it('asks for bodies and resolves with what the journal accepted of the requested items', async () => {
      const f = fixture();
      await f.open();
      await f.publish([{ sequence: 1, op: 'append', row: row('m1', 'Hello') }, { sequence: 2, op: 'complete', itemKey: 'm1', digest: DIGEST }]);
      const pending = f.connection.requestFill(SESSION, ['m1']);
      expect(f.sent.at(-1)).toMatchObject({ type: 'journal_fill_request', uplinkVersion: 2, sessionKey: SESSION, itemKeys: ['m1'] });
      expect([...f.timers.values()].map(timer => timer.delayMs)).toEqual([JOURNAL_REQUEST_TIMEOUT_MS]);
      await f.connection.receive(wire({ type: 'journal_fill', requestId: requestIdOf(f.sent, 'journal_fill_request'), sessionKey: SESSION,
        items: [{ row: row('m1', 'Hello'), digest: DIGEST }, { row: row('m9', 'not asked for'), digest: DIGEST }] }));
      await expect(pending).resolves.toEqual({ filled: ['m1'], mismatched: [], unknown: [] });
      expect(f.timers.size).toBe(0);
    });

    it('asks for older history and resolves when the Host says it is done', async () => {
      const f = fixture();
      const pending = f.connection.requestOlder(SESSION, 25);
      expect(f.sent.at(-1)).toMatchObject({ type: 'journal_older_request', sessionKey: SESSION, limit: 25 });
      await f.connection.receive(wire({ type: 'journal_older_done', requestId: requestIdOf(f.sent, 'journal_older_request'), sessionKey: SESSION, olderAvailable: false }));
      await expect(pending).resolves.toEqual({ olderAvailable: false });
    });

    it('ignores an answer it did not ask for, or one for another session or kind', async () => {
      const f = fixture();
      const pending = f.connection.requestOlder(SESSION, 25);
      const requestId = requestIdOf(f.sent, 'journal_older_request');
      await f.connection.receive(wire({ type: 'journal_older_done', requestId: 'unknown', sessionKey: SESSION, olderAvailable: true }));
      await f.connection.receive(wire({ type: 'journal_older_done', requestId, sessionKey: 'codex:other', olderAvailable: true }));
      await f.connection.receive(wire({ type: 'journal_fill', requestId, sessionKey: SESSION, items: [] }));
      expect(f.timers.size).toBe(1);
      f.connection.close();
      await expect(pending).rejects.toMatchObject({ code: 'closed' });
    });

    it('allows one fill and one older read per session, and a bounded number in all', async () => {
      const f = fixture();
      const first = f.connection.requestFill(SESSION, ['m1']);
      await expect(f.connection.requestFill(SESSION, ['m2'])).rejects.toMatchObject({ code: 'in_flight' });
      const older = f.connection.requestOlder(SESSION, 10);
      const rest = Array.from({ length: JOURNAL_REQUEST_LIMIT - 2 }, (_, at) => f.connection.requestOlder(`codex:s${at}`, 10));
      await expect(f.connection.requestOlder('codex:one-more', 10)).rejects.toMatchObject({ code: 'busy' });
      f.connection.close();
      for (const pending of [first, older, ...rest]) await expect(pending).rejects.toMatchObject({ code: 'closed' });
    });

    it('rejects an unanswered request after the deadline and then accepts a new one', async () => {
      const f = fixture();
      const pending = f.connection.requestOlder(SESSION, 10);
      f.expireOldestTimer();
      await expect(pending).rejects.toMatchObject({ code: 'timeout' });
      const again = f.connection.requestOlder(SESSION, 10);
      f.connection.close();
      await expect(again).rejects.toMatchObject({ code: 'closed' });
    });

    it('rejects invalid requests, requests on a connection that is not current and failed writes', async () => {
      const f = fixture();
      await expect(f.connection.requestFill(SESSION, [])).rejects.toMatchObject({ code: 'invalid' });
      await expect(f.connection.requestFill(SESSION, ['a', 'a'])).rejects.toMatchObject({ code: 'invalid' });
      await expect(f.connection.requestOlder(SESSION, 0)).rejects.toMatchObject({ code: 'invalid' });
      f.failSends(new Error('socket closed'));
      await expect(f.connection.requestOlder(SESSION, 10)).rejects.toThrow('socket closed');
      expect(f.timers.size).toBe(0);
      f.endConnection();
      await expect(f.connection.requestOlder(SESSION, 10)).rejects.toMatchObject({ code: 'unavailable' });
    });
  });
});
```

- [ ] **Step 2: Run them and see them fail.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/journal-uplink.test.ts --testTimeout=10000`
Expected: FAIL, because `./journal-uplink.js` does not exist.

- [ ] **Step 3: Implement.** `packages/agent-remote-hosted/src/journal-uplink.ts`:

```ts
import { randomUUID } from 'node:crypto';

import {
  JOURNAL_FILL_MAX_ITEMS, JOURNAL_INDEX_MAX_ITEMS, JOURNAL_OLDER_MAX_LIMIT, REMOTE_HOST_UPLINK_VERSION,
  type RemoteHostUplinkMessage,
} from '@orchardworks/agent-remote-protocol';

import type { HostJournals, JournalFilled } from './host-journals.js';

/** The most requests one connection has open to its Host at a time. */
export const JOURNAL_REQUEST_LIMIT = 32;
/** How long the Host has to answer a request. */
export const JOURNAL_REQUEST_TIMEOUT_MS = 15_000;

/** The journal messages a Host sends to its Relay. */
export type JournalHostMessage = Extract<RemoteHostUplinkMessage, { type: 'journal_open' | 'journal_publish' | 'journal_fill' | 'journal_older_done' }>;

export function isJournalHostMessage(message: RemoteHostUplinkMessage): message is JournalHostMessage {
  return message.type === 'journal_open' || message.type === 'journal_publish' || message.type === 'journal_fill' || message.type === 'journal_older_done';
}

export class JournalRequestError extends Error {
  constructor(readonly code: 'invalid' | 'unavailable' | 'busy' | 'in_flight' | 'timeout' | 'closed', message: string) {
    super(message);
    this.name = 'JournalRequestError';
  }
}

export interface JournalConnectionOptions {
  hostId: string;
  journals: HostJournals;
  send(message: RemoteHostUplinkMessage): void;
  /** Whether this is still the Host's current uplink connection. */
  current(): boolean;
  scheduler: { setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(timer: unknown): void };
  requestTimeoutMs?: number;
}

export interface JournalConnection {
  /** Handles one journal message from the Host. Calls made in order enqueue their journal work in that order. */
  receive(message: JournalHostMessage): Promise<void>;
  /** Asks the Host's Controller to read item bodies again from native history; resolves once the journal took them. */
  requestFill(sessionKey: string, itemKeys: readonly string[]): Promise<JournalFilled>;
  /** Asks the Host's Controller to read older history and publish it as prepended items. */
  requestOlder(sessionKey: string, limit: number): Promise<{ olderAvailable: boolean }>;
  /** Ends the connection: pending requests fail and its sessions need opening again. */
  close(): void;
}

type Pending = { kind: 'fill' | 'older'; sessionKey: string; itemKeys: ReadonlySet<string>; resolve(value: never): void; reject(error: Error): void; timer: unknown };

/**
 * One uplink connection's side of the journals: it runs the Host's publications through the journal service, tells the
 * Host what was stored or refused, and keeps the requests the Relay made to the Host until they are answered.
 */
export function createJournalConnection(options: JournalConnectionOptions): JournalConnection {
  const { hostId, journals, scheduler } = options;
  const timeoutMs = options.requestTimeoutMs ?? JOURNAL_REQUEST_TIMEOUT_MS;
  /** The generation each session was opened with on this connection. */
  const opened = new Map<string, number>();
  const pending = new Map<string, Pending>();
  const send = (message: RemoteHostUplinkMessage) => { if (options.current()) options.send(message); };

  function request<T>(kind: Pending['kind'], sessionKey: string, itemKeys: readonly string[], message: (requestId: string) => RemoteHostUplinkMessage): Promise<T> {
    if (!options.current()) return Promise.reject(new JournalRequestError('unavailable', 'The Host connection is not current.'));
    if (pending.size >= JOURNAL_REQUEST_LIMIT) return Promise.reject(new JournalRequestError('busy', 'Too many pending journal requests.'));
    if ([...pending.values()].some(item => item.kind === kind && item.sessionKey === sessionKey)) {
      return Promise.reject(new JournalRequestError('in_flight', `A journal ${kind} request for ${sessionKey} is already pending.`));
    }
    const requestId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = scheduler.setTimeout(() => {
        pending.delete(requestId);
        reject(new JournalRequestError('timeout', 'The Host did not answer the journal request before the Relay deadline.'));
      }, timeoutMs);
      pending.set(requestId, { kind, sessionKey, itemKeys: new Set(itemKeys), resolve: resolve as (value: never) => void, reject, timer });
      try { options.send(message(requestId)); }
      catch (error) {
        scheduler.clearTimeout(timer);
        pending.delete(requestId);
        reject(error instanceof Error ? error : new Error('The journal request could not be written.'));
      }
    });
  }

  /** The pending request this answer belongs to, taken out of the map; undefined when the Relay asked for no such thing. */
  function answered(requestId: string, kind: Pending['kind'], sessionKey: string): Pending | undefined {
    const found = pending.get(requestId);
    if (!found || found.kind !== kind || found.sessionKey !== sessionKey) return undefined;
    pending.delete(requestId);
    scheduler.clearTimeout(found.timer);
    return found;
  }

  return {
    async receive(message) {
      switch (message.type) {
        case 'journal_open': {
          const result = await journals.open(hostId, message.sessionKey, message.publisherId);
          if (result.index.length > JOURNAL_INDEX_MAX_ITEMS) throw new Error(`The journal of ${message.sessionKey} holds more items than one journal_opened carries.`);
          if (!options.current()) return;
          opened.set(message.sessionKey, result.generation);
          send({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_opened', requestId: message.requestId, sessionKey: message.sessionKey, ...result });
          return;
        }
        case 'journal_publish': {
          const { sessionKey, generation } = message;
          if (opened.get(sessionKey) !== generation) {
            send({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_refused', sessionKey, generation, sequence: message.entries[0]!.sequence, reason: 'fenced' });
            return;
          }
          const result = await journals.publish(hostId, sessionKey, generation, message.entries);
          if (!options.current()) return;
          if (result.cursor && result.refusal?.reason !== 'fenced') {
            send({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_ack', sessionKey, generation, watermark: result.watermark, cursor: result.cursor });
          }
          if (result.refusal) {
            const { sequence, reason, itemKey } = result.refusal;
            send({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_refused', sessionKey, generation, sequence, reason, ...(itemKey === undefined ? {} : { itemKey }) });
          }
          return;
        }
        case 'journal_fill': {
          const found = answered(message.requestId, 'fill', message.sessionKey);
          if (!found) return;
          try { found.resolve(await journals.fill(hostId, message.sessionKey, message.items.filter(({ row }) => found.itemKeys.has(row.itemKey))) as never); }
          catch (error) { found.reject(error instanceof Error ? error : new Error('The journal could not take the bodies.')); }
          return;
        }
        case 'journal_older_done': {
          answered(message.requestId, 'older', message.sessionKey)?.resolve({ olderAvailable: message.olderAvailable } as never);
          return;
        }
      }
    },

    requestFill(sessionKey, itemKeys) {
      if (itemKeys.length < 1 || itemKeys.length > JOURNAL_FILL_MAX_ITEMS || new Set(itemKeys).size !== itemKeys.length) {
        return Promise.reject(new JournalRequestError('invalid', `A fill asks for 1 to ${JOURNAL_FILL_MAX_ITEMS} distinct items.`));
      }
      return request<JournalFilled>('fill', sessionKey, itemKeys, requestId => ({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_fill_request', requestId, sessionKey, itemKeys: [...itemKeys] }));
    },

    requestOlder(sessionKey, limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > JOURNAL_OLDER_MAX_LIMIT) {
        return Promise.reject(new JournalRequestError('invalid', `An older-history read asks for 1 to ${JOURNAL_OLDER_MAX_LIMIT} items.`));
      }
      return request<{ olderAvailable: boolean }>('older', sessionKey, [], requestId => ({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_older_request', requestId, sessionKey, limit }));
    },

    close() {
      opened.clear();
      for (const item of pending.values()) {
        scheduler.clearTimeout(item.timer);
        item.reject(new JournalRequestError('closed', 'The Host connection closed before it answered.'));
      }
      pending.clear();
    },
  };
}
```

Note: `request` writes with `options.send` (not the guarded `send`), because it already checked `current()`; a write failure must reach the caller.

- [ ] **Step 4: Run the tests and typecheck.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/journal-uplink.test.ts --testTimeout=10000 && pnpm --filter @orchardworks/agent-remote-hosted run typecheck`
Expected: PASS, 13 tests; typecheck exit code 0.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-hosted/src/journal-uplink.ts packages/agent-remote-hosted/src/journal-uplink.test.ts
git commit -m "feat(hosted): run a Host's journal messages and Relay requests per uplink connection"
```

### Task 5: Grant the capability and dispatch journal messages in the broker

**Files:**
- Modify: `packages/agent-remote-hosted/src/broker.ts`
- Modify: `packages/agent-remote-hosted/src/gateway.ts`
- Test: `packages/agent-remote-hosted/src/broker-journals.test.ts`

- [ ] **Step 1: Write the failing tests.** `packages/agent-remote-hosted/src/broker-journals.test.ts` (the harness is the one of `session-states.test.ts`, extended with an inbox of what the Relay sent to the Controller; Task 6 appends to this file):

```ts
import { MemoryJournalStore } from '@orchardworks/agent-remote-journal';
import { afterEach, expect, it } from 'vitest';
import { createHostBroker, type RelaySocket } from './index.js';

const close: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of close.splice(0).reverse()) await dispose(); });

function transportPair() {
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
  const server = new Socket(), native = new Socket(); server.peer = native; native.peer = server;
  close.push(() => server.close());
  return { server, native };
}

type Wire = Record<string, any>;
const SESSION = 'codex:thread-1';
const DIGEST = 'a'.repeat(64);
const row = (itemKey: string, text: string) => ({
  itemKey, providerId: 'codex', sourceKey: `${itemKey}:${text}`, occurredAt: 1_725_000_000_000, turnId: 'turn-1',
  item: { type: 'assistant_message', text, messageId: itemKey },
});

/** A Controller connected over the in-memory transport. `query` is what it asks for when it connects. */
async function connectedHost(options: { query?: string; journals?: MemoryJournalStore | false; requestTimeoutMs?: number } = {}) {
  const store = new MemoryJournalStore();
  const broker = createHostBroker({ origin: 'https://relay.example', rpcTimeoutMs: 1000, journalRequestTimeoutMs: options.requestTimeoutMs ?? 50,
    ...(options.journals === false ? {} : { journals: options.journals ?? store }) });
  close.push(() => broker.close());
  const pairing = await (await broker.handleRequest(new Request('https://relay.example/v1/remote/pairings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), {}))!.json();
  const prepared = await broker.prepareUpgrade(new Request(`https://relay.example/ws/remote-host${options.query ?? '?journal=1'}`, { headers: { authorization: `Bearer ${pairing.key}` } }));
  if (!prepared || prepared instanceof Response) throw new Error('Host upgrade rejected');
  const pair = transportPair();
  const inbox: Wire[] = [];
  pair.native.onMessage(data => { inbox.push(JSON.parse(data)); });
  prepared.accept(pair.server);
  pair.native.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'native', name: 'Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
  /** The next message of this type the Relay sent, removed from the inbox. */
  async function take(type: string): Promise<Wire> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const at = inbox.findIndex(message => message.type === type);
      if (at >= 0) return inbox.splice(at, 1)[0]!;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`The Relay sent no ${type}.`);
  }
  const send = (fields: Wire) => pair.native.send(JSON.stringify({ uplinkVersion: 2, ...fields }));
  const host = await take('registered');
  const open = async (publisherId = 'controller-1') => { send({ type: 'journal_open', requestId: `open-${Math.random()}`, sessionKey: SESSION, publisherId }); return take('journal_opened'); };
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  return { broker, pair, store, host, inbox, take, send, open, settle, storeKey: `${host.hostId}:${SESSION}` };
}

it('grants journals to a Controller that asked for them when the Relay has a journal store', async () => {
  expect((await connectedHost()).host.journal).toBe(1);
});

it('does not grant journals to a Controller that did not ask, or when the Relay has no store', async () => {
  expect((await connectedHost({ query: '' })).host.journal).toBeUndefined();
  expect((await connectedHost({ journals: false })).host.journal).toBeUndefined();
});

it('closes a Host that sends journal messages the Relay did not acknowledge', async () => {
  for (const options of [{ query: '' }, { journals: false as const }]) {
    const { pair, send, settle } = await connectedHost(options);
    send({ type: 'journal_open', requestId: 'open-1', sessionKey: SESSION, publisherId: 'controller-1' });
    await settle();
    expect(pair.server.closeCode).toBe(1008);
  }
});

it('closes a Host that sends a message only the Relay may send', async () => {
  const { pair, send, settle } = await connectedHost();
  send({ type: 'journal_ack', sessionKey: SESSION, generation: 1, watermark: 1, cursor: { epoch: 'e', seq: 1 } });
  await settle();
  expect(pair.server.closeCode).toBe(1008);
});

it('opens the journal of a session and stores the claim', async () => {
  const { host, open, store, storeKey } = await connectedHost();
  const opened = await open();
  expect(opened).toMatchObject({ uplinkVersion: 2, sessionKey: SESSION, generation: 1, watermark: 0, index: [] });
  expect(typeof opened.epoch).toBe('string');
  expect((await store.load(storeKey))?.meta.publisher).toEqual({ publisherId: 'controller-1', generation: 1, watermark: 0 });
  expect(storeKey.startsWith(`${host.hostId}:`)).toBe(true);
});

it('acknowledges a publication only after the store holds it, and returns the index when the journal is opened again', async () => {
  const { open, send, take, store, storeKey } = await connectedHost();
  const opened = await open();
  send({ type: 'journal_publish', sessionKey: SESSION, generation: opened.generation, entries: [
    { sequence: 1, op: 'append', row: row('m1', 'Hello') }, { sequence: 2, op: 'complete', itemKey: 'm1', digest: DIGEST }] });
  const ack = await take('journal_ack');
  expect(ack).toMatchObject({ sessionKey: SESSION, generation: 1, watermark: 2, cursor: { epoch: opened.epoch, seq: 1 } });
  expect((await store.load(storeKey))?.items).toEqual([expect.objectContaining({ itemKey: 'm1', state: 'complete', digest: DIGEST })]);
  const reopened = await open();
  expect(reopened).toMatchObject({ generation: 2, watermark: 2, epoch: opened.epoch,
    index: [expect.objectContaining({ itemKey: 'm1', seqStart: 1, seqEnd: 1, state: 'complete', digest: DIGEST, resident: true })] });
});

it('fences the first generation when the session is opened again', async () => {
  const { open, send, take } = await connectedHost();
  await open();
  await open();
  send({ type: 'journal_publish', sessionKey: SESSION, generation: 1, entries: [{ sequence: 1, op: 'append', row: row('m1', 'Hello') }] });
  expect(await take('journal_refused')).toMatchObject({ sessionKey: SESSION, generation: 1, sequence: 1, reason: 'fenced' });
  send({ type: 'journal_publish', sessionKey: SESSION, generation: 2, entries: [{ sequence: 1, op: 'append', row: row('m1', 'Hello') }] });
  expect(await take('journal_ack')).toMatchObject({ generation: 2, watermark: 1 });
});

it('acknowledges the entries before a refused one and names the refusal', async () => {
  const { open, send, take, store, storeKey } = await connectedHost();
  await open();
  send({ type: 'journal_publish', sessionKey: SESSION, generation: 1, entries: [
    { sequence: 1, op: 'append', row: row('m1', 'Hello') }, { sequence: 2, op: 'complete', itemKey: 'ghost', digest: DIGEST },
    { sequence: 3, op: 'append', row: row('m3', 'Never applied') }] });
  expect(await take('journal_ack')).toMatchObject({ watermark: 1 });
  expect(await take('journal_refused')).toMatchObject({ generation: 1, sequence: 2, reason: 'unknown_item', itemKey: 'ghost' });
  expect((await store.load(storeKey))?.items.map(({ itemKey }) => itemKey)).toEqual(['m1']);
});

it('stores the head a Controller publishes', async () => {
  const { open, send, take, store, storeKey } = await connectedHost();
  await open();
  const snapshot = {
    id: 'session-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle', activeTurn: null,
    capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
    pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status: 'idle' },
  };
  send({ type: 'journal_publish', sessionKey: SESSION, generation: 1, entries: [{ sequence: 1, op: 'head', head: { snapshot, observedAt: 12 } }] });
  await take('journal_ack');
  expect((await store.load(storeKey))?.meta.head).toEqual({ snapshot, observedAt: 12 });
});

it('keeps the journals of two Hosts apart even for the same session', async () => {
  const shared = new MemoryJournalStore();
  const first = await connectedHost({ journals: shared });
  const second = await connectedHost({ journals: shared });
  expect(first.host.hostId).not.toBe(second.host.hostId);
  const opened = await first.open();
  first.send({ type: 'journal_publish', sessionKey: SESSION, generation: opened.generation, entries: [{ sequence: 1, op: 'append', row: row('m1', 'Hello') }] });
  await first.take('journal_ack');
  expect((await second.open()).index).toEqual([]);
});
```

- [ ] **Step 2: Run them and see them fail.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/broker-journals.test.ts --testTimeout=10000`
Expected: FAIL. The grant test reads `undefined`, and every test that waits for `journal_opened` or `journal_ack` throws `The Relay sent no journal_opened.` The two tests that expect a close with 1008 already pass: they guard the existing rejection of unknown messages.

- [ ] **Step 3: Implement in `packages/agent-remote-hosted/src/broker.ts`.** Each edit replaces a string that occurs exactly once.

1. After the import of `./succession-capacity.js` (`import { isSuccessionCapacityError, remainingAssociationRevisions, SUCCESSION_FEATURE_BYTES } from './succession-capacity.js';`) add:

```ts
import type { JournalStore } from '@orchardworks/agent-remote-journal';
import { createHostJournals } from './host-journals.js';
import { createJournalConnection, isJournalHostMessage, type JournalConnection } from './journal-uplink.js';
```

2. In the `Host` type, replace `  outbox?: 1;` with:

```ts
  outbox?: 1;
  /** The Controller publishes session journals on this connection; set when the Relay acknowledges it, never persisted. */
  journal?: JournalConnection;
```

3. In `HostBrokerOptions`, after the `outbox?: { hostCall(hostId: string, call: unknown): Promise<unknown> };` line add:

```ts
  /** Where Host session journals are kept. Without it no Controller is granted journals. */
  journals?: JournalStore;
  /** How long a Controller has to answer a journal request. Defaults to 15 seconds. */
  journalRequestTimeoutMs?: number;
```

4. After `  const clearTimeout = scheduler.clearTimeout.bind(scheduler);` add:

```ts
  const journals = options.journals && createHostJournals({ store: options.journals, now });
```

5. In the `register` signature replace `statusRequested = false, outboxRequested = false) {` with `statusRequested = false, outboxRequested = false, journalRequested = false) {`.

6. In `registered()`, replace `host.tunnelToken ??= randomBytes(32).toString('base64url');` with:

```ts
host.tunnelToken ??= randomBytes(32).toString('base64url');
      host.journal?.close();
      host.journal = journalRequested && journals
        ? createJournalConnection({ hostId: host.id, journals, current, scheduler, requestTimeoutMs: options.journalRequestTimeoutMs, send: message => send(host!, message) })
        : undefined;
```

and, in the `registered` message built on the next line, replace `...(host.outbox === 1 ? { outbox: 1 as const } : {}), ` with `...(host.outbox === 1 ? { outbox: 1 as const } : {}), ...(host.journal ? { journal: 1 as const } : {}), `.

7. In the receive chain, replace `} else closeConnection(1008, 'Unexpected uplink message');` with:

```ts
} else if (isJournalHostMessage(message)) {
        if (!host.journal) return closeConnection(1008, 'Journals were not acknowledged');
        await host.journal.receive(message);
      } else closeConnection(1008, 'Unexpected uplink message');
```

8. In `disconnected`, replace `host.socket = undefined; host.ready = false; host.sessionStates = undefined;` with:

```ts
host.socket = undefined; host.ready = false; host.sessionStates = undefined;
    host.journal?.close(); host.journal = undefined;
```

9. In `upgrade`, replace `url.searchParams.get('outbox') === '1');` with `url.searchParams.get('outbox') === '1', url.searchParams.get('journal') === '1');`.

In `packages/agent-remote-hosted/src/gateway.ts`:

1. After `import { createHostBroker, USER_STREAM_LIMIT, type RemoteHostBrokerState, type HostBrokerOptions } from './broker.js';` add:

```ts
import type { JournalStore } from '@orchardworks/agent-remote-journal';
```

2. In `HostedRelayOptions`, after `diagnosticStorage?: RelayDiagnosticStore;` add:

```ts
  /** Where Host session journals are kept; absent, no Controller is granted journals. Journals of every account share it, keyed by Host. */
  journals?: JournalStore;
```

3. In the `createHostBroker({...})` call, replace `        outbox: { hostCall: (hostId, call) => sessionOutbox.hostCall(hostId, call) },` with:

```ts
        outbox: { hostCall: (hostId, call) => sessionOutbox.hostCall(hostId, call) },
        journals: options.journals,
```

- [ ] **Step 4: Run the new tests, the neighbouring broker tests and the typecheck.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/broker-journals.test.ts src/session-states.test.ts src/session-outbox.test.ts src/broker-heartbeat.test.ts --testTimeout=10000 && pnpm --filter @orchardworks/agent-remote-hosted run typecheck`
Expected: PASS, 10 new tests plus the existing ones; typecheck exit code 0.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-hosted/src/broker.ts packages/agent-remote-hosted/src/gateway.ts packages/agent-remote-hosted/src/broker-journals.test.ts
git commit -m "feat(hosted): grant journals to Controllers that ask and dispatch their journal messages"
```

### Task 6: Fill and older-history requests from the broker

**Files:**
- Modify: `packages/agent-remote-hosted/src/broker.ts`
- Test: `packages/agent-remote-hosted/src/broker-journals.test.ts`

- [ ] **Step 1: Write the failing tests.** Append to `packages/agent-remote-hosted/src/broker-journals.test.ts`:

```ts
it('asks the Controller for bodies and resolves once the journal took them', async () => {
  const { broker, host, open, send, take } = await connectedHost();
  await open();
  send({ type: 'journal_publish', sessionKey: SESSION, generation: 1, entries: [
    { sequence: 1, op: 'append', row: row('m1', 'Hello') }, { sequence: 2, op: 'complete', itemKey: 'm1', digest: DIGEST }] });
  await take('journal_ack');
  const filled = broker.requestFill(host.hostId, SESSION, ['m1']);
  const request = await take('journal_fill_request');
  expect(request).toMatchObject({ uplinkVersion: 2, sessionKey: SESSION, itemKeys: ['m1'] });
  send({ type: 'journal_fill', requestId: request.requestId, sessionKey: SESSION, items: [{ row: row('m1', 'Hello'), digest: DIGEST }] });
  await expect(filled).resolves.toEqual({ filled: ['m1'], mismatched: [], unknown: [] });
  const wrong = broker.requestFill(host.hostId, SESSION, ['m1']);
  const second = await take('journal_fill_request');
  send({ type: 'journal_fill', requestId: second.requestId, sessionKey: SESSION, items: [{ row: row('m1', 'Rewritten'), digest: 'b'.repeat(64) }] });
  await expect(wrong).resolves.toEqual({ filled: [], mismatched: ['m1'], unknown: [] });
});

it('asks the Controller for older history, which it publishes as prepended items before it says it is done', async () => {
  const { broker, host, open, send, take, store, storeKey } = await connectedHost();
  await open();
  send({ type: 'journal_publish', sessionKey: SESSION, generation: 1, entries: [{ sequence: 1, op: 'append', row: row('m2', 'Now') }] });
  await take('journal_ack');
  const older = broker.requestOlder(host.hostId, SESSION, 20);
  const request = await take('journal_older_request');
  expect(request).toMatchObject({ sessionKey: SESSION, limit: 20 });
  send({ type: 'journal_publish', sessionKey: SESSION, generation: 1, entries: [{ sequence: 2, op: 'prepend', items: [{ row: row('m1', 'Before'), digest: DIGEST }] }] });
  expect(await take('journal_ack')).toMatchObject({ watermark: 2 });
  send({ type: 'journal_older_done', requestId: request.requestId, sessionKey: SESSION, olderAvailable: false });
  await expect(older).resolves.toEqual({ olderAvailable: false });
  expect((await store.load(storeKey))?.items.map(({ itemKey, seqStart }) => [itemKey, seqStart])).toEqual([['m1', 0], ['m2', 1]]);
});

it('rejects an unanswered request after the deadline and allows the next one', async () => {
  const { broker, host, take } = await connectedHost({ requestTimeoutMs: 50 });
  const silent = broker.requestOlder(host.hostId, SESSION, 5);
  await take('journal_older_request');
  await expect(silent).rejects.toMatchObject({ code: 'timeout' });
  const next = broker.requestOlder(host.hostId, SESSION, 5);
  await take('journal_older_request');
  await expect(next).rejects.toMatchObject({ code: 'timeout' });
});

it('allows one request of a kind per session at a time', async () => {
  const { broker, host, take } = await connectedHost({ requestTimeoutMs: 100 });
  const first = broker.requestOlder(host.hostId, SESSION, 5);
  await take('journal_older_request');
  await expect(broker.requestOlder(host.hostId, SESSION, 5)).rejects.toMatchObject({ code: 'in_flight' });
  await expect(first).rejects.toMatchObject({ code: 'timeout' });
});

it('fails pending requests when the Controller disconnects', async () => {
  const { broker, host, pair, take, settle } = await connectedHost({ requestTimeoutMs: 1000 });
  const pending = broker.requestFill(host.hostId, SESSION, ['m1']);
  await take('journal_fill_request');
  pair.native.close(1000);
  await expect(pending).rejects.toMatchObject({ code: 'closed' });
  await settle();
  await expect(broker.requestFill(host.hostId, SESSION, ['m1'])).rejects.toMatchObject({ status: 503, code: 'host_offline' });
});

it('refuses requests for a Host that cannot publish journals or does not exist', async () => {
  const plain = await connectedHost({ query: '' });
  await expect(plain.broker.requestFill(plain.host.hostId, SESSION, ['m1'])).rejects.toMatchObject({ status: 501, code: 'journal_unavailable' });
  await expect(plain.broker.requestOlder(plain.host.hostId, SESSION, 5)).rejects.toMatchObject({ status: 501, code: 'journal_unavailable' });
  await expect(plain.broker.requestOlder('no-such-host', SESSION, 5)).rejects.toMatchObject({ status: 404, code: 'host_not_found' });
});
```

- [ ] **Step 2: Run them and see them fail.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/broker-journals.test.ts --testTimeout=10000`
Expected: the 6 new tests FAIL with `broker.requestFill is not a function` (or `requestOlder`); the 10 from Task 5 still pass.

- [ ] **Step 3: Implement.** In `packages/agent-remote-hosted/src/broker.ts`:

1. Before `  function send(host: Host, message: RemoteHostUplinkMessage) {` add:

```ts
  const requireJournal = (hostId: string) => {
    const connection = requireHost(hostId).journal;
    if (!connection) throw new BrokerError(501, 'journal_unavailable', 'The Controller on this Host does not publish journals.');
    return connection;
  };
```

2. In the object the broker returns, before `    tunnelHost: (token: string) =>` add:

```ts
    /**
     * Asks a connected Host's Controller to read item bodies again from native history. Resolves with what the journal
     * accepted; rejects with a JournalRequestError (timeout, in_flight, busy, closed) or a BrokerError for an offline Host.
     * The caller authorizes the read this serves.
     */
    async requestFill(hostId: string, sessionKey: string, itemKeys: string[]) { return requireJournal(hostId).requestFill(sessionKey, itemKeys); },
    /** Asks a connected Host's Controller to read older history and publish it as prepended items. */
    async requestOlder(hostId: string, sessionKey: string, limit: number) { return requireJournal(hostId).requestOlder(sessionKey, limit); },
```

3. Export the error from the package so callers can test for it. In `packages/agent-remote-hosted/src/index.ts` add:

```ts
export { JournalRequestError } from './journal-uplink.js';
```

- [ ] **Step 4: Run the tests and typecheck.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/broker-journals.test.ts --testTimeout=10000 && pnpm --filter @orchardworks/agent-remote-hosted run typecheck`
Expected: PASS, 16 tests; typecheck exit code 0.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-hosted/src/broker.ts packages/agent-remote-hosted/src/index.ts packages/agent-remote-hosted/src/broker-journals.test.ts
git commit -m "feat(hosted): let the Relay ask a Controller to fill bodies and read older history"
```

### Task 7: Verify the workspace and update compatibility metadata

**Files:**
- Modify: `packages/agent-remote-lab/compatibility.json` (generated)

- [ ] **Step 1: Build in dependency order and typecheck every package that depends on the changed ones.**

Run: `pnpm --filter @orchardworks/agent-remote-protocol --filter @orchardworks/agent-remote-relay --filter @orchardworks/agent-remote-journal --filter @orchardworks/agent-remote-hosted run build && pnpm --filter @orchardworks/agent-remote-protocol --filter @orchardworks/agent-remote-journal --filter @orchardworks/agent-remote-hosted --filter @orchardworks/agent-remote-relay --filter @orchardworks/agent-remote-lab --filter @orchardworks/agent-remote-cloudflare --filter @orchardworks/agent-remote-controller run typecheck`
Expected: exit code 0 for both. (`agent-remote-lab`, `agent-remote-cloudflare` and `agent-remote-controller` (the package in `packages/agent-host`) import `agent-remote-hosted`, whose declarations now mention the journal package.)

- [ ] **Step 2: Run the affected test suites.**

Run: `pnpm --filter @orchardworks/agent-remote-protocol exec vitest run --testTimeout=10000 && pnpm --filter @orchardworks/agent-remote-journal exec vitest run --testTimeout=10000 && pnpm --filter @orchardworks/agent-remote-relay exec vitest run --testTimeout=10000`
Expected: PASS for all three. The relay suite is unchanged: its uplink client decodes the extended schema and never asks for `journal=1`.

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run --testTimeout=10000` with a Bash tool timeout of 300000 ms.
Expected: PASS. If the outer deadline is hit, run the files in two halves (`src/[a-i]*.test.ts`, then `src/[j-z]*.test.ts`) instead of raising the deadline.

- [ ] **Step 3: Check that crude Hosts are untouched.** The conformance of the hosted Relay with an existing Controller is covered by the broker, gateway and session-state suites above. Confirm that no journal field reaches a Controller that did not ask:

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/broker-journals.test.ts -t "does not grant" --testTimeout=10000`
Expected: PASS, 1 test.

- [ ] **Step 4: Local instance.** Hosted production compositions do not pass a journal store, so this change must not alter a real Controller's connection. Follow `.agents/skills/prepare-arc-local/SKILL.md`: `pnpm local up`, confirm the development Controller registers and a session opens and answers, then `pnpm local down`. If the session cannot listen on local ports, report the check as not exercised instead of working around it.

- [ ] **Step 5: Update and check the compatibility digest.**

Run: `pnpm compatibility:update && pnpm compatibility:check`
Expected: exit code 0 for both.

- [ ] **Step 6: Commit.**

```bash
git add packages/agent-remote-lab/compatibility.json
git commit -m "chore: compatibility digest after the Relay journal service"
```

---

## Self-review

**Spec coverage.**

- Journal head: Task 1 (`setHead`, `head`, fenced and de-duplicated, reported by `takeChanges`, store round trip) plus the `publisher` getter the service needs.
- Uplink protocol: Task 2 covers the capability (`registered.journal`), all nine messages with strict schemas, the `JournalRowInput`, `CompleteItemInput` and `JournalIndexEntry` wire schemas, all seven refusal reasons, batch bounds (entries, items, bytes), cross-field validation (strictly increasing sequences, distinct items, ordered ranges), the extended `RemoteHostUplinkBrokerMessage`, and rejection tests. Fixtures: stated in the file structure section that none is needed.
- Hosted service: Task 3 (`open`, `publish`, `fill`, `page`, `forget`; lazy load; per-Host serialization; store-before-return; typed errors mapped; stop at the first refusal).
- Broker integration: Task 5 (capability grant gated on `journal=1` and the store, dispatch in the receive chain through `journal-uplink.ts`, 1008 for ungated Hosts, `createHostedRelay({ journals })`) and Task 6 (`requestFill`, `requestOlder`, 15 s timeout, cap 32, in-flight rule, disconnect rejection). The adapter itself, with a fake scheduler, is Task 4.
- Tests over the transport harness: Tasks 5 and 6 cover grant and non-grant, open returning the index, acknowledgement after the store applied, fencing, refusal reasons (unit-level in Tasks 3 and 4, through the broker for `unknown_item`), fill and older round trips, timeouts, and ungated 1008.
- Verification: Task 7 (build, typecheck including lab, cloudflare and the Controller package, affected tests, local instance, compatibility update and check, commit).
- Not in scope and not touched: serving browsers from journals (P1-B2), a durable store (P1-B3), the Controller side (P1-C).

**Placeholder scan.** No step says to add something without showing it. Edits to `broker.ts`, `gateway.ts` and `remote-host-uplink.ts` name the exact existing string each one replaces or follows, and each of those strings occurs once in the file.

**Type consistency.**

- Names used across tasks: `SessionJournal.setHead/head/publisher` (Task 1) are used by `host-journals.ts` (Task 3); `JournalPublishEntry`, `JournalRefusalReason`, `CompleteItemInput`, the `JOURNAL_*` limits and `REMOTE_HOST_UPLINK_VERSION` (Task 2) are used by Tasks 3 and 4; `HostJournals` and `JournalFilled` (Task 3) by `journal-uplink.ts` (Task 4); `createJournalConnection`, `isJournalHostMessage`, `JournalConnection` and `JournalRequestError` (Task 4) by `broker.ts` (Tasks 5 and 6).
- The wire `JournalRowInput`, `CompleteItemInput` and `JournalHead` are structurally equal to the journal package's types of the same names; the service passes wire values to the journal without conversion, so a divergence fails the Task 3 typecheck. `host-journals.ts` imports the wire `CompleteItemInput` from the protocol and never the journal package's.
- Spec deviation recorded under Decisions, item 2: `Host.journal` is the connection handle, not the literal `1`.
