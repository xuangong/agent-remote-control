# P1-A Journal core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure TypeScript package, `@orchardworks/agent-remote-journal`, that keeps one session's journal. It covers stable epochs and dense sequences, the item index (skeleton), fencing and de-duplication of publications, corrections, replacement, prepends, eviction and fill, pages, reconcile planning, item digests and a store port.

**Architecture:** One `SessionJournal` class owns one session's state. A journal stores one record per item. Live rows are folded into their item with the same merge the Controller's projector uses, now exported from `agent-remote-relay` under the subpath `./timeline-projection`. Pages, reconcile planning, retention selection and digests are pure functions in their own modules. A `JournalStore` port persists the incremental changes the journal hands out. The package uses no Node-only API, so it runs in Node and in a Cloudflare Worker.

**Tech Stack:** TypeScript 5.7 (ES2022, Node16 modules, strict), Vitest 4.1.11, pnpm workspace. WebCrypto (`crypto.subtle`, `crypto.randomUUID`) is available in Node 22 and in Workers.

**Design reference:** `docs/superpowers/specs/2026-11-15-im-session-service-design.md`, sections Session journal and Continuing a journal across reopens.

**Commands.** Every test command below sets a per-test deadline (`--testTimeout`). Run it with an outer deadline: the Bash tool timeout of at most 300000 ms.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/agent-remote-relay/src/timeline-projector.ts` | Modify: export `entryFromRow`, `mergeRowIntoEntry`, `includeSequence`, and re-export `CanonicalTimelineRow`. |
| `packages/agent-remote-relay/package.json` | Modify: add the subpath export `./timeline-projection`. |
| `packages/agent-remote-journal/package.json`, `tsconfig.json` | New package. |
| `packages/agent-remote-journal/src/types.ts` | Journal data types and errors. |
| `packages/agent-remote-journal/src/item-digest.ts` | Content digest of a timeline item. |
| `packages/agent-remote-journal/src/journal-items.ts` | Conversions between journal items, rows and projected entries. |
| `packages/agent-remote-journal/src/session-journal.ts` | The `SessionJournal` class. |
| `packages/agent-remote-journal/src/journal-pages.ts` | Pages (`tail`, `before`, `after`) from journal items. |
| `packages/agent-remote-journal/src/retention.ts` | Which item bodies may be evicted. |
| `packages/agent-remote-journal/src/reconcile.ts` | The reconcile plan from the index and a reread. |
| `packages/agent-remote-journal/src/journal-store.ts` | The `JournalStore` port and the in-memory store. |
| `packages/agent-remote-journal/src/index.ts` | Public exports. |

---

### Task 1: Export the projector's row merge

**Files:**
- Modify: `packages/agent-remote-relay/src/timeline-projector.ts`
- Modify: `packages/agent-remote-relay/package.json`
- Test: `packages/agent-remote-relay/src/timeline-projector.test.ts`

- [ ] **Step 1: Write the failing test.** Append to `packages/agent-remote-relay/src/timeline-projector.test.ts`:

```ts
describe('mergeRowIntoEntry', () => {
  const row = (seq: number, text: string): CanonicalTimelineRow => ({
    epoch: 'epoch-1', seq, providerId: 'codex', sourceKey: `delta:${seq}`, occurredAt: 1_725_000_000_000 + seq,
    timestamp: new Date(1_725_000_000_000 + seq).toISOString(), turnId: 'turn-1',
    item: { type: 'assistant_message', text, messageId: 'message-1' }, resources: [],
  });

  it('folds a row into its entry exactly as pages project rows', () => {
    const rows = [row(1, 'Hel'), row(2, 'lo'), row(3, '!')];
    const entry = entryFromRow(rows[0]!);
    mergeRowIntoEntry(entry, rows[1]!);
    mergeRowIntoEntry(entry, rows[2]!);
    expect(entry).toEqual(projectTimelineRows(rows)[0]);
  });
});
```

Change the file's import lines to:

```ts
import { entryFromRow, mergeRowIntoEntry, projectTimelinePage, projectTimelineRows, type CanonicalTimelineRow } from './timeline-projector.js';
import { TimelineStore } from './timeline-store.js';
```

- [ ] **Step 2: Run it and see it fail.**

Run: `pnpm --filter @orchardworks/agent-remote-relay exec vitest run src/timeline-projector.test.ts --testTimeout=10000`
Expected: FAIL, because `entryFromRow` and `mergeRowIntoEntry` are not exported.

- [ ] **Step 3: Implement.** In `packages/agent-remote-relay/src/timeline-projector.ts`:

1. Replace the import of `timeline-store.js` with:

```ts
import { TimelineStore, type CanonicalTimelineRow } from './timeline-store.js';

export type { CanonicalTimelineRow } from './timeline-store.js';
```

2. Replace the whole `projectTimelineRows` function with:

```ts
export function projectTimelineRows(rows: readonly CanonicalTimelineRow[]): ProjectedTimelineEntry[] {
  const entries: ProjectedTimelineEntry[] = [];
  for (const row of rows) {
    const match = findProjection(entries, row);
    if (match === undefined) entries.push(entryFromRow(row));
    else mergeRowIntoEntry(entries[match] as ProjectedTimelineEntry, row);
  }
  return entries;
}

/** Folds one row into the entry it continues, exactly as pages project rows. */
export function mergeRowIntoEntry(entry: ProjectedTimelineEntry, row: CanonicalTimelineRow): void {
  const previousBackground = entry.item.background;
  entry.seqEnd = row.seq;
  entry.sourceSeqRanges = includeSequence(entry.sourceSeqRanges, row.seq);
  includeResources(entry.resources, row.resources);
  if (row.item.background) entry.item.background = structuredClone(mergeBackgroundActivity(entry.item.background, row.item.background));
  if (row.item.type === 'assistant_message' && entry.item.type === 'assistant_message') {
    entry.item.text += row.item.text;
    includeCollapse(entry.collapsed, 'assistant_merge');
  } else if (row.item.type === 'reasoning' && entry.item.type === 'reasoning') {
    entry.item.text += row.item.text;
    includeCollapse(entry.collapsed, 'reasoning_merge');
  } else if (row.item.type === 'tool_call') {
    entry.item = structuredClone(row.item);
    if (row.item.background) entry.item.background = mergeBackgroundActivity(previousBackground, row.item.background);
    includeCollapse(entry.collapsed, 'tool_lifecycle');
  } else if (row.item.type === 'compaction' && entry.item.type === 'compaction') {
    entry.item = { ...entry.item, ...row.item };
  } else if (row.item.type === 'todo') {
    entry.item = structuredClone(row.item);
    if (row.item.background) entry.item.background = mergeBackgroundActivity(previousBackground, row.item.background);
  }
}
```

3. Add `export` to the existing `function entryFromRow(` and `function includeSequence(` declarations. Change nothing else.

4. In `packages/agent-remote-relay/package.json`, replace the `exports` object with:

```json
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./timeline-projection": {
      "types": "./dist/timeline-projector.d.ts",
      "import": "./dist/timeline-projector.js"
    }
  },
```

- [ ] **Step 4: Run the projector and store tests.**

Run: `pnpm --filter @orchardworks/agent-remote-relay exec vitest run src/timeline-projector.test.ts src/timeline-store.test.ts --testTimeout=10000`
Expected: PASS, 15 tests.

- [ ] **Step 5: Build the relay so the subpath exists in `dist`.**

Run: `pnpm --filter @orchardworks/agent-remote-relay run build`
Expected: exit code 0; `packages/agent-remote-relay/dist/timeline-projector.js` exists.

- [ ] **Step 6: Commit.**

```bash
git add packages/agent-remote-relay/src/timeline-projector.ts packages/agent-remote-relay/src/timeline-projector.test.ts packages/agent-remote-relay/package.json
git commit -m "refactor(relay): export the projector's row merge for reuse"
```

### Task 2: Package, types, item conversions and digests

**Files:**
- Create: `packages/agent-remote-journal/package.json`
- Create: `packages/agent-remote-journal/tsconfig.json`
- Create: `packages/agent-remote-journal/src/types.ts`
- Create: `packages/agent-remote-journal/src/journal-items.ts`
- Create: `packages/agent-remote-journal/src/item-digest.ts`
- Create: `packages/agent-remote-journal/src/index.ts`
- Test: `packages/agent-remote-journal/src/item-digest.test.ts`
- Test: `packages/agent-remote-journal/src/journal-items.test.ts`

- [ ] **Step 1: Create the package files.**

`packages/agent-remote-journal/package.json`:

```json
{
  "name": "@orchardworks/agent-remote-journal",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Relay-side session journals: stable epochs and sequences, an item index, reconcile planning and retention.",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --testTimeout=10000"
  },
  "dependencies": {
    "@orchardworks/agent-provider-sdk": "workspace:*",
    "@orchardworks/agent-remote-protocol": "workspace:*",
    "@orchardworks/agent-remote-relay": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "4.1.11"
  }
}
```

`packages/agent-remote-journal/tsconfig.json`: an exact copy of `packages/agent-remote-relay/tsconfig.json`.

`packages/agent-remote-journal/src/types.ts`:

```ts
import type { AgentTimelineItem, ResourceBinding, TimelineCollapse, TimelineSeqRange } from '@orchardworks/agent-remote-protocol';

/** One row a Controller publishes: today's timeline row plus the native identity of the item it belongs to. */
export interface JournalRowInput {
  itemKey: string;
  providerId: string;
  sourceKey: string;
  nativeRevision?: number;
  occurredAt: number;
  turnId?: string;
  item: AgentTimelineItem;
  resources?: ResourceBinding[];
  /** A row that a reread of native history cannot reproduce, such as an interaction record. */
  liveOnly?: boolean;
}

/** A row stamped with the journal's epoch and sequence; what subscribers receive live. */
export interface JournalRow {
  epoch: string;
  seq: number;
  itemKey: string;
  providerId: string;
  sourceKey: string;
  nativeRevision?: number;
  occurredAt: number;
  timestamp: string;
  turnId?: string;
  item: AgentTimelineItem;
  resources: ResourceBinding[];
}

/** The content of an item, which the journal may evict and fill again from the Host. */
export interface JournalBody {
  item: AgentTimelineItem;
  timestamp: string;
  collapsed: TimelineCollapse[];
  resources: ResourceBinding[];
}

/** One item of the session. Everything but the body is the journal's skeleton and is never evicted. */
export interface JournalItem {
  itemKey: string;
  providerId: string;
  turnId?: string;
  seqStart: number;
  seqEnd: number;
  sourceSeqRanges: TimelineSeqRange[];
  state: 'open' | 'complete';
  digest?: string;
  liveOnly: boolean;
  clientMessageId?: string;
  revision: number;
  body: JournalBody | null;
}

/** The publisher allowed to write: one Controller process (`publisherId`) on one uplink connection (`generation`). */
export interface JournalPublisher {
  publisherId: string;
  generation: number;
  /** The last publication applied; publications at or below it are duplicates. */
  watermark: number;
}

/** Identifies one publication: the publisher's connection and its monotonic publication number. */
export interface JournalPublication {
  publisherId: string;
  generation: number;
  sequence: number;
}

export interface JournalMeta {
  sessionKey: string;
  epoch: string;
  /** The sequence the next forward row receives. */
  nextSeq: number;
  /** The lowest sequence in use; older rows are prepended below it. */
  minSeq: number;
  publisher: JournalPublisher | null;
  retiredEpochs: { epoch: string; retiredAt: number }[];
}

export interface JournalState {
  meta: JournalMeta;
  items: JournalItem[];
}

/** What changed since changes were last taken, for a store that writes incrementally. */
export interface JournalChanges {
  meta: JournalMeta;
  upsert: JournalItem[];
  /** True after a replacement: the store drops every item it holds for the session before the upserts. */
  replaced: boolean;
}

export interface JournalIndexEntry {
  itemKey: string;
  seqStart: number;
  seqEnd: number;
  state: 'open' | 'complete';
  digest?: string;
  liveOnly: boolean;
  clientMessageId?: string;
  revision: number;
  /** Whether the journal holds the body; false after eviction. */
  resident: boolean;
}

/** A complete item from native history: one row carrying its whole content, and its digest. */
export interface CompleteItemInput {
  row: JournalRowInput;
  digest: string;
}

export class JournalFencedError extends Error {
  constructor(readonly sessionKey: string) {
    super(`A newer publisher owns the journal of ${sessionKey}.`);
    this.name = 'JournalFencedError';
  }
}

export class JournalStaleRevisionError extends Error {
  constructor(readonly itemKey: string, readonly revision: number) {
    super(`Journal item ${itemKey} moved to revision ${revision}.`);
    this.name = 'JournalStaleRevisionError';
  }
}

export class JournalBodyMissingError extends Error {
  constructor(readonly itemKey: string) {
    super(`Journal item ${itemKey} has no resident body.`);
    this.name = 'JournalBodyMissingError';
  }
}

export class JournalUnknownItemError extends Error {
  constructor(readonly itemKey: string) {
    super(`Journal item ${itemKey} is unknown.`);
    this.name = 'JournalUnknownItemError';
  }
}
```

`packages/agent-remote-journal/src/journal-items.ts`:

```ts
import type { ProjectedTimelineEntry, ResourceBinding } from '@orchardworks/agent-remote-protocol';
import { entryFromRow, type CanonicalTimelineRow } from '@orchardworks/agent-remote-relay/timeline-projection';

import { JournalBodyMissingError, type JournalBody, type JournalItem, type JournalRow, type JournalRowInput } from './types.js';

export function stampRow(epoch: string, seq: number, input: JournalRowInput): JournalRow {
  return {
    epoch, seq, itemKey: input.itemKey, providerId: input.providerId, sourceKey: input.sourceKey,
    ...(input.nativeRevision === undefined ? {} : { nativeRevision: input.nativeRevision }),
    occurredAt: input.occurredAt, timestamp: new Date(input.occurredAt).toISOString(),
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    item: structuredClone(input.item), resources: structuredClone(input.resources ?? []),
  };
}

export function canonicalRow(row: JournalRow): CanonicalTimelineRow {
  return {
    epoch: row.epoch, seq: row.seq, providerId: row.providerId, sourceKey: row.sourceKey,
    ...(row.nativeRevision === undefined ? {} : { nativeRevision: row.nativeRevision }),
    occurredAt: row.occurredAt, timestamp: row.timestamp,
    ...(row.turnId === undefined ? {} : { turnId: row.turnId }),
    item: row.item as CanonicalTimelineRow['item'], resources: row.resources,
  };
}

/** The projected entry of a resident item, as pages show it and live rows merge into it. */
export function itemEntry(item: JournalItem): ProjectedTimelineEntry {
  if (item.body === null) throw new JournalBodyMissingError(item.itemKey);
  return {
    providerId: item.providerId, item: structuredClone(item.body.item),
    ...(item.turnId === undefined ? {} : { turnId: item.turnId }),
    timestamp: item.body.timestamp, seqStart: item.seqStart, seqEnd: item.seqEnd,
    sourceSeqRanges: structuredClone(item.sourceSeqRanges), collapsed: [...item.body.collapsed],
    resources: structuredClone(item.body.resources),
  };
}

export function entryBody(entry: ProjectedTimelineEntry): JournalBody {
  return { item: entry.item, timestamp: entry.timestamp, collapsed: entry.collapsed, resources: entry.resources };
}

/** The body of a complete item read again from native history, for a fill. */
export function bodyFromRow(input: JournalRowInput): JournalBody {
  return entryBody(entryFromRow(canonicalRow(stampRow('fill', 0, input))));
}

export function mergeResources(current: readonly ResourceBinding[], additions: readonly ResourceBinding[]): ResourceBinding[] {
  const merged = structuredClone([...current]);
  for (const addition of additions) {
    if (!merged.some(({ locator, resourceId }) => locator === addition.locator && resourceId === addition.resourceId)) {
      merged.push(structuredClone(addition));
    }
  }
  return merged;
}
```

`packages/agent-remote-journal/src/item-digest.ts`:

```ts
import type { AgentTimelineItem } from '@orchardworks/agent-remote-protocol';

/**
 * Digest of an item's content: equal for an item built from live deltas and the same item read again from native
 * history. Background outcomes merge in later and are left out.
 */
export async function itemDigest(item: AgentTimelineItem): Promise<string> {
  const { background: _background, ...content } = item;
  const bytes = new TextEncoder().encode(canonicalJson(content));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, field]) => field !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`).join(',')}}`;
}
```

`packages/agent-remote-journal/src/index.ts`:

```ts
export * from './types.js';
export { itemDigest } from './item-digest.js';
export { bodyFromRow } from './journal-items.js';
```

- [ ] **Step 2: Write the tests.**

`packages/agent-remote-journal/src/item-digest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { itemDigest } from './item-digest.js';

describe('itemDigest', () => {
  it('is the same for the same content in any key order', async () => {
    const first = await itemDigest({ type: 'assistant_message', text: 'Hello', messageId: 'message-1' });
    const second = await itemDigest({ messageId: 'message-1', text: 'Hello', type: 'assistant_message' });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with the content', async () => {
    expect(await itemDigest({ type: 'reasoning', text: 'a' })).not.toBe(await itemDigest({ type: 'reasoning', text: 'b' }));
  });
});
```

`packages/agent-remote-journal/src/journal-items.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { bodyFromRow, itemEntry, mergeResources, stampRow } from './journal-items.js';
import { JournalBodyMissingError, type JournalItem } from './types.js';

describe('journal items', () => {
  it('stamps a row with its epoch, sequence and timestamp without sharing the input', () => {
    const input = { itemKey: 'm1', providerId: 'codex', sourceKey: 's1', occurredAt: 0, item: { type: 'reasoning' as const, text: 'a' } };
    const row = stampRow('epoch-1', 7, input);
    expect(row).toMatchObject({ epoch: 'epoch-1', seq: 7, itemKey: 'm1', timestamp: '1970-01-01T00:00:00.000Z', resources: [] });
    input.item.text = 'changed';
    expect(row.item).toEqual({ type: 'reasoning', text: 'a' });
  });

  it('refuses to project an evicted item', () => {
    const evicted: JournalItem = { itemKey: 'm1', providerId: 'codex', seqStart: 1, seqEnd: 1, sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }], state: 'complete', liveOnly: false, revision: 1, body: null };
    expect(() => itemEntry(evicted)).toThrow(JournalBodyMissingError);
  });

  it('builds the body of a complete item read again from history', () => {
    expect(bodyFromRow({ itemKey: 'm1', providerId: 'codex', sourceKey: 'h1', occurredAt: 0, item: { type: 'assistant_message', text: 'Hi', messageId: 'm1' } }))
      .toEqual({ item: { type: 'assistant_message', text: 'Hi', messageId: 'm1' }, timestamp: '1970-01-01T00:00:00.000Z', collapsed: [], resources: [] });
  });

  it('merges resources without duplicates', () => {
    const binding = { locator: 'file:a', resourceId: 'r1', state: 'available' } as never;
    expect(mergeResources([binding], [binding])).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Install and build the dependencies.**

Run: `pnpm install --prefer-offline`
Expected: exit code 0, with `pnpm-lock.yaml` gaining an importer for `packages/agent-remote-journal`.

Run: `pnpm --filter "@orchardworks/agent-remote-journal^..." run build`
Expected: exit code 0.

- [ ] **Step 4: Run the tests and the typecheck.**

Run: `pnpm --filter @orchardworks/agent-remote-journal exec vitest run --testTimeout=10000`
Expected: PASS, 6 tests.

Run: `pnpm --filter @orchardworks/agent-remote-journal run typecheck`
Expected: exit code 0. If TypeScript reports the `ResourceBinding` literal in the last test as incompatible, the `as never` cast already covers it. If it reports `canonicalRow`'s item as incompatible, keep the existing cast.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-journal pnpm-lock.yaml
git commit -m "feat(journal): add the journal package with its types, item conversions and digests"
```

### Task 3: The session journal: claim, append, complete, seal, alias, changes

**Files:**
- Create: `packages/agent-remote-journal/src/session-journal.ts`
- Modify: `packages/agent-remote-journal/src/index.ts`
- Test: `packages/agent-remote-journal/src/session-journal.test.ts`

- [ ] **Step 1: Write the test fixture and the failing tests.** The fixture is not a test file and is excluded from the build by the `*.test-fixture.ts` pattern in `tsconfig.json`.

`packages/agent-remote-journal/src/journal.test-fixture.ts`:

```ts
import { SessionJournal } from './session-journal.js';
import type { JournalPublication, JournalRowInput } from './types.js';

export const PUBLISHER = 'controller-1';

/** A journal claimed by one publisher, with a function that numbers its publications. */
export function openJournal() {
  const journal = SessionJournal.create('host-1:codex:session-1', 'epoch-1');
  const { generation } = journal.claim(PUBLISHER);
  let sequence = 0;
  const publish = (): JournalPublication => ({ publisherId: PUBLISHER, generation, sequence: ++sequence });
  return { journal, publish };
}

export const text = (itemKey: string, sourceKey: string, chunk: string, turnId = 'turn-1'): JournalRowInput => ({
  itemKey, providerId: 'codex', sourceKey, occurredAt: 1_725_000_000_000, turnId,
  item: { type: 'assistant_message', text: chunk, messageId: itemKey },
});
```

`packages/agent-remote-journal/src/session-journal.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { openJournal, PUBLISHER, text } from './journal.test-fixture.js';
import { JournalFencedError } from './types.js';

describe('SessionJournal', () => {
  it('stamps dense sequences and folds deltas into one item', () => {
    const { journal, publish } = openJournal();
    const first = journal.append(publish(), text('m1', 'd1', 'Hel'));
    const second = journal.append(publish(), text('m1', 'd2', 'lo'));
    expect([first?.seq, second?.seq]).toEqual([1, 2]);
    expect(journal.cursor).toEqual({ epoch: 'epoch-1', seq: 2 });
    expect(journal.index()).toEqual([expect.objectContaining({ itemKey: 'm1', seqStart: 1, seqEnd: 2, state: 'open', resident: true, revision: 2 })]);
    expect(journal.state().items[0]?.body?.item).toMatchObject({ type: 'assistant_message', text: 'Hello' });
  });

  it('ignores a publication it already applied', () => {
    const { journal, publish } = openJournal();
    const publication = publish();
    expect(journal.append(publication, text('m1', 'd1', 'Hel'))?.seq).toBe(1);
    expect(journal.append(publication, text('m1', 'd1', 'Hel'))).toBeUndefined();
    expect(journal.cursor.seq).toBe(1);
  });

  it('fences off an older connection of the publisher', () => {
    const { journal, publish } = openJournal();
    const stale = publish();
    journal.claim(PUBLISHER);
    expect(() => journal.append(stale, text('m1', 'd1', 'Hel'))).toThrow(JournalFencedError);
  });

  it('resumes a reconnecting publisher after its watermark and starts a new one from zero', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'Hel'));
    expect(journal.claim(PUBLISHER)).toEqual({ generation: 2, watermark: 1 });
    expect(journal.claim('controller-2')).toEqual({ generation: 3, watermark: 0 });
  });

  it('completes, seals and aliases items', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'Hello'));
    journal.complete(publish(), 'm1', 'digest-1');
    journal.append(publish(), { itemKey: 'u1', providerId: 'codex', sourceKey: 'u1', occurredAt: 0, item: { type: 'user_message', text: 'Hi' } });
    journal.alias(publish(), 'u1', 'operation-1');
    journal.append(publish(), text('m2', 'd2', 'Interrupt'));
    journal.seal(publish(), 'm2');
    const index = journal.index();
    expect(index[0]).toMatchObject({ itemKey: 'm1', state: 'complete', digest: 'digest-1' });
    expect(index[1]).toMatchObject({ itemKey: 'u1', clientMessageId: 'operation-1' });
    expect(journal.state().items[1]?.body?.item).toMatchObject({ clientMessageId: 'operation-1' });
    expect(index[2]).toMatchObject({ itemKey: 'm2', state: 'complete' });
    expect(index[2]?.digest).toBeUndefined();
  });

  it('hands out only what changed', () => {
    const { journal, publish } = openJournal();
    journal.takeChanges();
    journal.append(publish(), text('m1', 'd1', 'Hel'));
    const changes = journal.takeChanges();
    expect(changes?.upsert.map(({ itemKey }) => itemKey)).toEqual(['m1']);
    expect(changes?.meta.nextSeq).toBe(2);
    expect(changes?.replaced).toBe(false);
    expect(journal.takeChanges()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them and see them fail.**

Run: `pnpm --filter @orchardworks/agent-remote-journal exec vitest run src/session-journal.test.ts --testTimeout=10000`
Expected: FAIL, because `./session-journal.js` does not exist.

- [ ] **Step 3: Implement.** `packages/agent-remote-journal/src/session-journal.ts`:

```ts
import type { TimelineCursor } from '@orchardworks/agent-remote-protocol';
import { entryFromRow, mergeRowIntoEntry } from '@orchardworks/agent-remote-relay/timeline-projection';

import { canonicalRow, entryBody, itemEntry, stampRow } from './journal-items.js';
import {
  JournalBodyMissingError, JournalFencedError, JournalUnknownItemError,
  type JournalChanges, type JournalIndexEntry, type JournalItem, type JournalMeta, type JournalPublication,
  type JournalRow, type JournalRowInput, type JournalState,
} from './types.js';

/**
 * The journal of one session: epochs and dense sequences assigned here, one record per item, and the one publisher
 * allowed to write. It changes only through its methods and hands out what changed to its store.
 */
export class SessionJournal {
  protected meta: JournalMeta;
  protected readonly items: JournalItem[];
  protected readonly byKey = new Map<string, JournalItem>();
  protected readonly dirty = new Set<string>();
  protected metaDirty = false;
  protected replaced = false;

  static create(sessionKey: string, epoch: string = crypto.randomUUID()): SessionJournal {
    const journal = new SessionJournal({ meta: { sessionKey, epoch, nextSeq: 1, minSeq: 1, publisher: null, retiredEpochs: [] }, items: [] });
    journal.metaDirty = true;
    return journal;
  }

  constructor(state: JournalState) {
    this.meta = structuredClone(state.meta);
    this.items = structuredClone(state.items).sort((left, right) => left.seqStart - right.seqStart);
    for (const item of this.items) this.byKey.set(item.itemKey, item);
  }

  get sessionKey(): string { return this.meta.sessionKey; }
  get epoch(): string { return this.meta.epoch; }
  /** The last forward sequence assigned: the cursor of a subscriber that has everything. */
  get cursor(): TimelineCursor { return { epoch: this.meta.epoch, seq: this.meta.nextSeq - 1 }; }

  /**
   * Registers a publisher's new uplink connection and fences off every older one. A reconnecting publisher resumes
   * after its watermark; a different publisher, such as a restarted Controller, starts from zero.
   */
  claim(publisherId: string): { generation: number; watermark: number } {
    const previous = this.meta.publisher;
    const generation = (previous?.generation ?? 0) + 1;
    const watermark = previous?.publisherId === publisherId ? previous.watermark : 0;
    this.meta.publisher = { publisherId, generation, watermark };
    this.metaDirty = true;
    return { generation, watermark };
  }

  /** Appends one live row, opening its item or folding into it. Returns undefined for a duplicate publication. */
  append(publication: JournalPublication, input: JournalRowInput): JournalRow | undefined {
    if (this.duplicate(publication)) return undefined;
    const existing = this.byKey.get(input.itemKey);
    if (existing && existing.body === null) throw new JournalBodyMissingError(input.itemKey);
    this.advance(publication);
    const row = stampRow(this.meta.epoch, this.meta.nextSeq++, input);
    if (existing) {
      const entry = itemEntry(existing);
      mergeRowIntoEntry(entry, canonicalRow(row));
      existing.seqEnd = entry.seqEnd;
      existing.sourceSeqRanges = entry.sourceSeqRanges;
      existing.body = entryBody(entry);
      if (input.liveOnly) existing.liveOnly = true;
      existing.revision += 1;
      this.dirty.add(existing.itemKey);
    } else {
      this.insertLast(this.openItem(row, input.liveOnly === true));
    }
    return row;
  }

  /** Marks an item complete with the digest of its whole content. */
  complete(publication: JournalPublication, itemKey: string, digest: string): void {
    if (this.duplicate(publication)) return;
    const item = this.require(itemKey);
    this.advance(publication);
    item.state = 'complete';
    item.digest = digest;
    item.revision += 1;
    this.dirty.add(itemKey);
  }

  /** Closes an item that native history no longer contains, keeping what was received. */
  seal(publication: JournalPublication, itemKey: string): void {
    if (this.duplicate(publication)) return;
    const item = this.require(itemKey);
    this.advance(publication);
    item.state = 'complete';
    delete item.digest;
    item.revision += 1;
    this.dirty.add(itemKey);
  }

  /** Records which operation produced a user message, so clients match its echo exactly. */
  alias(publication: JournalPublication, itemKey: string, clientMessageId: string): void {
    if (this.duplicate(publication)) return;
    const item = this.require(itemKey);
    this.advance(publication);
    item.clientMessageId = clientMessageId;
    if (item.body?.item.type === 'user_message') item.body.item.clientMessageId = clientMessageId;
    item.revision += 1;
    this.dirty.add(itemKey);
  }

  index(): JournalIndexEntry[] {
    return this.items.map(item => ({
      itemKey: item.itemKey, seqStart: item.seqStart, seqEnd: item.seqEnd, state: item.state,
      ...(item.digest === undefined ? {} : { digest: item.digest }), liveOnly: item.liveOnly,
      ...(item.clientMessageId === undefined ? {} : { clientMessageId: item.clientMessageId }),
      revision: item.revision, resident: item.body !== null,
    }));
  }

  state(): JournalState {
    return { meta: structuredClone(this.meta), items: structuredClone(this.items) };
  }

  /** What changed since the last call, or undefined when nothing did. */
  takeChanges(): JournalChanges | undefined {
    if (!this.metaDirty && this.dirty.size === 0 && !this.replaced) return undefined;
    const upsert = [...this.dirty]
      .map(key => this.byKey.get(key))
      .filter((item): item is JournalItem => item !== undefined)
      .map(item => structuredClone(item));
    const changes: JournalChanges = { meta: structuredClone(this.meta), upsert, replaced: this.replaced };
    this.dirty.clear();
    this.metaDirty = false;
    this.replaced = false;
    return changes;
  }

  protected duplicate(publication: JournalPublication): boolean {
    const publisher = this.meta.publisher;
    if (!publisher || publisher.publisherId !== publication.publisherId || publisher.generation !== publication.generation) {
      throw new JournalFencedError(this.meta.sessionKey);
    }
    return publication.sequence <= publisher.watermark;
  }

  protected advance(publication: JournalPublication): void {
    (this.meta.publisher as NonNullable<JournalMeta['publisher']>).watermark = publication.sequence;
    this.metaDirty = true;
  }

  protected require(itemKey: string): JournalItem {
    const item = this.byKey.get(itemKey);
    if (!item) throw new JournalUnknownItemError(itemKey);
    return item;
  }

  protected openItem(row: JournalRow, liveOnly: boolean): JournalItem {
    const entry = entryFromRow(canonicalRow(row));
    return {
      itemKey: row.itemKey, providerId: row.providerId, ...(row.turnId === undefined ? {} : { turnId: row.turnId }),
      seqStart: row.seq, seqEnd: row.seq, sourceSeqRanges: entry.sourceSeqRanges,
      state: 'open', liveOnly, revision: 1, body: entryBody(entry),
    };
  }

  protected insertLast(item: JournalItem): void {
    this.items.push(item);
    this.byKey.set(item.itemKey, item);
    this.dirty.add(item.itemKey);
  }
}
```

Append to `packages/agent-remote-journal/src/index.ts`:

```ts
export { SessionJournal } from './session-journal.js';
```

- [ ] **Step 4: Run the tests.**

Run: `pnpm --filter @orchardworks/agent-remote-journal exec vitest run --testTimeout=10000`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-journal/src
git commit -m "feat(journal): stamp, fold, complete and fence publications in a session journal"
```

### Task 4: Corrections, replacement and older history

**Files:**
- Modify: `packages/agent-remote-journal/src/session-journal.ts`
- Test: `packages/agent-remote-journal/src/session-journal.test.ts`

- [ ] **Step 1: Write the failing tests.** Append inside the `describe('SessionJournal', …)` block, and add `JournalStaleRevisionError` to the import from `./types.js`:

```ts
  it('corrects an item that has not moved since the index was read', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'Hel'));
    journal.complete(publish(), 'm1', 'digest-old');
    const revision = journal.index()[0]!.revision;
    const row = journal.correct(publish(), text('m1', 'h1', 'Hello!'), 'digest-new', revision);
    expect(row?.seq).toBe(2);
    expect(journal.index()[0]).toMatchObject({ itemKey: 'm1', seqStart: 1, seqEnd: 2, state: 'complete', digest: 'digest-new' });
    expect(journal.state().items[0]?.sourceSeqRanges).toEqual([{ startSeq: 1, endSeq: 2 }]);
    expect(journal.state().items[0]?.body?.item).toMatchObject({ text: 'Hello!' });
  });

  it('refuses a correction computed against an older revision', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'Hel'));
    const revision = journal.index()[0]!.revision;
    journal.append(publish(), text('m1', 'd2', 'lo'));
    expect(() => journal.correct(publish(), text('m1', 'h1', 'Hello'), 'digest', revision)).toThrow(JournalStaleRevisionError);
  });

  it('replaces the epoch with one sequence per item and remembers the retired epoch', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'Old'));
    journal.takeChanges();
    const epoch = journal.replace(publish(), [{ row: text('m2', 'h2', 'Fresh'), digest: 'digest-2' }], 1_725_000_000_000);
    expect(epoch).not.toBe('epoch-1');
    expect(journal.cursor).toEqual({ epoch, seq: 1 });
    expect(journal.index()).toEqual([expect.objectContaining({ itemKey: 'm2', seqStart: 1, seqEnd: 1, state: 'complete', digest: 'digest-2' })]);
    expect(journal.state().meta.retiredEpochs).toEqual([{ epoch: 'epoch-1', retiredAt: 1_725_000_000_000 }]);
    const changes = journal.takeChanges();
    expect(changes?.replaced).toBe(true);
    expect(changes?.upsert.map(({ itemKey }) => itemKey)).toEqual(['m2']);
  });

  it('prepends older items below the lowest sequence in one batch and skips known ones', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m3', 'd3', 'Now'));
    const rows = journal.prepend(publish(), [
      { row: text('m1', 'h1', 'Oldest'), digest: 'digest-1' },
      { row: text('m2', 'h2', 'Older'), digest: 'digest-2' },
      { row: text('m3', 'h3', 'Now'), digest: 'digest-3' },
    ]);
    expect(rows.map(({ itemKey, seq }) => [itemKey, seq])).toEqual([['m1', -1], ['m2', 0]]);
    expect(journal.index().map(({ itemKey, seqStart }) => [itemKey, seqStart])).toEqual([['m1', -1], ['m2', 0], ['m3', 1]]);
    expect(journal.index()[0]).toMatchObject({ state: 'complete', digest: 'digest-1' });
  });
```

- [ ] **Step 2: Run them and see them fail.**

Run: `pnpm --filter @orchardworks/agent-remote-journal exec vitest run src/session-journal.test.ts --testTimeout=10000`
Expected: FAIL, because `correct`, `replace` and `prepend` do not exist.

- [ ] **Step 3: Implement.** In `packages/agent-remote-journal/src/session-journal.ts`:

1. Change the relay import to `import { entryFromRow, includeSequence, mergeRowIntoEntry } from '@orchardworks/agent-remote-relay/timeline-projection';`.
2. Add `mergeResources` to the import from `./journal-items.js`.
3. Add `JournalStaleRevisionError` and `type CompleteItemInput` to the import from `./types.js`.
4. Below the imports, add:

```ts
/** How long a retired epoch is remembered, for diagnostics only. */
export const RETIRED_EPOCH_MS = 7 * 24 * 60 * 60 * 1000;
```

5. Add these methods to the class, after `alias`:

```ts
  /** Replaces an item's content after a reread found it different, unless the item moved since the index was read. */
  correct(publication: JournalPublication, input: JournalRowInput, digest: string, expectedRevision: number): JournalRow | undefined {
    if (this.duplicate(publication)) return undefined;
    const item = this.require(input.itemKey);
    if (item.revision !== expectedRevision) throw new JournalStaleRevisionError(item.itemKey, item.revision);
    this.advance(publication);
    const row = stampRow(this.meta.epoch, this.meta.nextSeq++, input);
    item.body = {
      item: structuredClone(row.item), timestamp: row.timestamp,
      collapsed: item.body?.collapsed ?? [], resources: mergeResources(item.body?.resources ?? [], row.resources),
    };
    item.seqEnd = row.seq;
    item.sourceSeqRanges = includeSequence(item.sourceSeqRanges, row.seq);
    item.state = 'complete';
    item.digest = digest;
    item.revision += 1;
    this.dirty.add(item.itemKey);
    return row;
  }

  /** Starts a new epoch from a reread of native history: one sequence per item, oldest first. */
  replace(publication: JournalPublication, items: readonly CompleteItemInput[], now: number): string {
    if (this.duplicate(publication)) return this.meta.epoch;
    this.advance(publication);
    this.meta.retiredEpochs = [
      ...this.meta.retiredEpochs.filter(({ retiredAt }) => now - retiredAt < RETIRED_EPOCH_MS),
      { epoch: this.meta.epoch, retiredAt: now },
    ];
    this.meta.epoch = crypto.randomUUID();
    this.meta.nextSeq = 1;
    this.meta.minSeq = 1;
    this.items.length = 0;
    this.byKey.clear();
    this.dirty.clear();
    this.replaced = true;
    for (const complete of items) this.insertLast(this.completeItem(complete, this.meta.nextSeq++));
    return this.meta.epoch;
  }

  /** Adds older items below the lowest sequence as one batch, oldest first. Items already known are skipped. */
  prepend(publication: JournalPublication, older: readonly CompleteItemInput[]): JournalRow[] {
    if (this.duplicate(publication)) return [];
    this.advance(publication);
    const fresh = older.filter(({ row }) => !this.byKey.has(row.itemKey));
    const lowest = Math.min(this.meta.minSeq, this.items[0]?.seqStart ?? this.meta.nextSeq);
    const first = lowest - fresh.length;
    if (!Number.isSafeInteger(first)) throw new Error('Journal history position exhausted.');
    const created = fresh.map((complete, offset) => this.completeItem(complete, first + offset));
    this.items.unshift(...created);
    for (const item of created) {
      this.byKey.set(item.itemKey, item);
      this.dirty.add(item.itemKey);
    }
    this.meta.minSeq = first;
    return fresh.map((complete, offset) => stampRow(this.meta.epoch, first + offset, complete.row));
  }

  protected completeItem(complete: CompleteItemInput, seq: number): JournalItem {
    return { ...this.openItem(stampRow(this.meta.epoch, seq, complete.row), false), state: 'complete', digest: complete.digest };
  }
```

- [ ] **Step 4: Run the tests.**

Run: `pnpm --filter @orchardworks/agent-remote-journal exec vitest run --testTimeout=10000`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-journal/src
git commit -m "feat(journal): correct items, replace epochs and prepend older history"
```

### Task 5: Pages

**Files:**
- Create: `packages/agent-remote-journal/src/journal-pages.ts`
- Modify: `packages/agent-remote-journal/src/session-journal.ts`
- Modify: `packages/agent-remote-journal/src/index.ts`
- Test: `packages/agent-remote-journal/src/journal-pages.test.ts`

- [ ] **Step 1: Write the failing tests.** `packages/agent-remote-journal/src/journal-pages.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { openJournal, text } from './journal.test-fixture.js';

function fiveItems() {
  const { journal, publish } = openJournal();
  for (const key of ['m1', 'm2', 'm3', 'm4', 'm5']) journal.append(publish(), text(key, `d-${key}`, key));
  return journal;
}
const request = { requestId: 'request-1', agentId: 'agent-1', limit: 2 };
const keys = (result: ReturnType<ReturnType<typeof fiveItems>['page']>) =>
  result.kind === 'page' ? result.page.payload.entries.map(({ item }) => (item.type === 'assistant_message' ? item.messageId : item.type)) : result.itemKeys;

describe('journal pages', () => {
  it('serves the tail with its cursors, window and neighbours', () => {
    const result = fiveItems().page({ ...request, direction: 'tail' }, { olderBeyondJournal: false });
    expect(keys(result)).toEqual(['m4', 'm5']);
    if (result.kind !== 'page') throw new Error('expected a page');
    expect(result.page.payload).toMatchObject({
      epoch: 'epoch-1', reset: false, gap: false, hasOlder: true, hasNewer: false,
      startCursor: { epoch: 'epoch-1', seq: 4 }, endCursor: { epoch: 'epoch-1', seq: 5 },
      window: { minSeq: 1, maxSeq: 5, nextSeq: 6 },
    });
  });

  it('serves pages before and after a cursor', () => {
    const journal = fiveItems();
    expect(keys(journal.page({ ...request, direction: 'before', cursor: { epoch: 'epoch-1', seq: 4 } }, { olderBeyondJournal: false }))).toEqual(['m2', 'm3']);
    expect(keys(journal.page({ ...request, limit: 10, direction: 'after', cursor: { epoch: 'epoch-1', seq: 3 } }, { olderBeyondJournal: false }))).toEqual(['m4', 'm5']);
  });

  it('resets a cursor of a retired epoch and reports a cursor ahead of history as a gap', () => {
    const journal = fiveItems();
    const stale = journal.page({ ...request, direction: 'after', cursor: { epoch: 'retired', seq: 2 } }, { olderBeyondJournal: false });
    expect(stale.kind === 'page' && stale.page.payload).toMatchObject({ reset: true, staleCursor: true, entries: [] });
    const ahead = journal.page({ ...request, direction: 'after', cursor: { epoch: 'epoch-1', seq: 9 } }, { olderBeyondJournal: false });
    expect(ahead.kind === 'page' && ahead.page.payload).toMatchObject({ gap: true, entries: [] });
  });

  it('reports older history the Host still has beyond the journal', () => {
    const result = fiveItems().page({ ...request, limit: 10, direction: 'tail' }, { olderBeyondJournal: true });
    expect(result.kind === 'page' && result.page.payload.hasOlder).toBe(true);
    const complete = fiveItems().page({ ...request, limit: 10, direction: 'tail' }, { olderBeyondJournal: false });
    expect(complete.kind === 'page' && complete.page.payload.hasOlder).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and see them fail.**

Run: `pnpm --filter @orchardworks/agent-remote-journal exec vitest run src/journal-pages.test.ts --testTimeout=10000`
Expected: FAIL, because `page` does not exist.

- [ ] **Step 3: Implement.** `packages/agent-remote-journal/src/journal-pages.ts`:

```ts
import { PROTOCOL_VERSION, type HistoryPage, type TimelineDirection, type TimelineHistoryCursor } from '@orchardworks/agent-remote-protocol';

import { itemEntry } from './journal-items.js';
import type { JournalItem } from './types.js';

export interface JournalPageRequest {
  requestId: string;
  agentId: string;
  direction: TimelineDirection;
  cursor?: TimelineHistoryCursor;
  limit: number;
}

export interface JournalPageView {
  epoch: string;
  items: readonly JournalItem[];
  nextSeq: number;
}

/** A page, or the items whose bodies must be filled from the Host before the page can be served. */
export type JournalPageResult = { kind: 'page'; page: HistoryPage } | { kind: 'missing'; itemKeys: string[] };

type PageFlags = Pick<HistoryPage['payload'], 'reset' | 'staleCursor' | 'gap' | 'error'>;
const SERVED: PageFlags = { reset: false, staleCursor: false, gap: false, error: null };

export function pageJournal(view: JournalPageView, request: JournalPageRequest, options: { olderBeyondJournal: boolean }): JournalPageResult {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1) throw new Error('Timeline page limit must be a positive integer.');
  if (request.direction !== 'tail' && request.cursor === undefined) throw new Error(`${request.direction} Timeline requests require a cursor.`);
  const cursor = request.cursor;
  if (cursor && cursor.epoch !== view.epoch) {
    return page(view, request, [], { reset: true, staleCursor: true, gap: false, error: 'Timeline cursor epoch was replaced.' }, options);
  }
  if (request.direction === 'after' && cursor && cursor.seq > view.nextSeq - 1) {
    return page(view, request, [], { reset: false, staleCursor: false, gap: true, error: 'Timeline cursor is ahead of recoverable history.' }, options);
  }
  const selected = request.direction === 'tail' ? view.items.slice(-request.limit)
    : request.direction === 'before' ? view.items.filter(({ seqStart }) => seqStart < (cursor as TimelineHistoryCursor).seq).slice(-request.limit)
      : view.items.filter(({ seqEnd }) => seqEnd > (cursor as TimelineHistoryCursor).seq).slice(0, request.limit);
  const missing = selected.filter(({ body }) => body === null).map(({ itemKey }) => itemKey);
  if (missing.length > 0) return { kind: 'missing', itemKeys: missing };
  return page(view, request, selected, SERVED, options);
}

function page(view: JournalPageView, request: JournalPageRequest, selected: readonly JournalItem[], flags: PageFlags, options: { olderBeyondJournal: boolean }): JournalPageResult {
  const first = selected[0];
  const last = selected.at(-1);
  const servedOlder = options.olderBeyondJournal && flags.error === null;
  return {
    kind: 'page',
    page: {
      protocolVersion: PROTOCOL_VERSION,
      type: 'timeline_page',
      payload: {
        requestId: request.requestId,
        agentId: request.agentId,
        direction: request.direction,
        epoch: view.epoch,
        ...flags,
        window: { minSeq: view.items[0]?.seqStart ?? 0, maxSeq: view.nextSeq - 1, nextSeq: view.nextSeq },
        startCursor: first ? { epoch: view.epoch, seq: first.seqStart } : null,
        endCursor: last ? { epoch: view.epoch, seq: last.seqEnd } : null,
        hasOlder: first
          ? view.items.some(({ seqStart }) => seqStart < first.seqStart) || (servedOlder && first === view.items[0])
          : servedOlder,
        hasNewer: last ? view.items.some(({ seqEnd }) => seqEnd > last.seqEnd) : false,
        entries: selected.map(itemEntry),
      },
    },
  };
}
```

In `packages/agent-remote-journal/src/session-journal.ts`, add the import `import { pageJournal, type JournalPageRequest, type JournalPageResult } from './journal-pages.js';` and this method after `index()`:

```ts
  /** A page of the journal; `olderBeyondJournal` says whether the Host still holds history older than the journal. */
  page(request: JournalPageRequest, options: { olderBeyondJournal: boolean }): JournalPageResult {
    return pageJournal({ epoch: this.meta.epoch, items: this.items, nextSeq: this.meta.nextSeq }, request, options);
  }
```

Append to `packages/agent-remote-journal/src/index.ts`:

```ts
export { pageJournal, type JournalPageRequest, type JournalPageResult, type JournalPageView } from './journal-pages.js';
```

- [ ] **Step 4: Run the tests.**

Run: `pnpm --filter @orchardworks/agent-remote-journal exec vitest run --testTimeout=10000`
Expected: PASS, 20 tests.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-journal/src
git commit -m "feat(journal): serve tail, before and after pages from journal items"
```

### Task 6: Retention: eviction and fill

**Files:**
- Create: `packages/agent-remote-journal/src/retention.ts`
- Modify: `packages/agent-remote-journal/src/session-journal.ts`
- Modify: `packages/agent-remote-journal/src/index.ts`
- Test: `packages/agent-remote-journal/src/retention.test.ts`

- [ ] **Step 1: Write the failing tests.** `packages/agent-remote-journal/src/retention.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { bodyFromRow } from './journal-items.js';
import { evictableItems } from './retention.js';
import { openJournal, text } from './journal.test-fixture.js';

function threeTurns() {
  const { journal, publish } = openJournal();
  journal.append(publish(), text('m1', 'd1', 'first', 'turn-1'));
  journal.complete(publish(), 'm1', 'digest-1');
  journal.append(publish(), { ...text('i1', 'i1', 'ask', 'turn-1'), liveOnly: true });
  journal.complete(publish(), 'i1', 'digest-i1');
  journal.append(publish(), text('m2', 'd2', 'second', 'turn-2'));
  journal.complete(publish(), 'm2', 'digest-2');
  journal.append(publish(), text('m3', 'd3', 'third', 'turn-3'));
  return { journal, publish };
}

describe('retention', () => {
  it('evicts complete bodies outside the latest turns, never live-only or open items', () => {
    const { journal } = threeTurns();
    expect(evictableItems(journal.state().items, 2)).toEqual(['m1']);
    expect(evictableItems(journal.state().items, 0)).toEqual(['m1', 'm2']);
  });

  it('asks for a fill when a page reaches an evicted body and accepts only the recorded digest', () => {
    const { journal } = threeTurns();
    expect(journal.evict(2)).toEqual(['m1']);
    expect(journal.index()[0]).toMatchObject({ itemKey: 'm1', resident: false });
    const request = { requestId: 'r', agentId: 'a', direction: 'tail' as const, limit: 10 };
    expect(journal.page(request, { olderBeyondJournal: false })).toEqual({ kind: 'missing', itemKeys: ['m1'] });
    const body = bodyFromRow(text('m1', 'h1', 'first', 'turn-1'));
    expect(journal.fill('m1', body, 'digest-other')).toBe('mismatch');
    expect(journal.fill('m1', body, 'digest-1')).toBe('filled');
    expect(journal.page(request, { olderBeyondJournal: false }).kind).toBe('page');
    expect(journal.fill('unknown', body, 'digest-1')).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run them and see them fail.**

Run: `pnpm --filter @orchardworks/agent-remote-journal exec vitest run src/retention.test.ts --testTimeout=10000`
Expected: FAIL, because `./retention.js` does not exist.

- [ ] **Step 3: Implement.** `packages/agent-remote-journal/src/retention.ts`:

```ts
import type { JournalItem } from './types.js';

/**
 * Items whose bodies may be evicted: complete, resident and not live-only, outside the latest turns. Consecutive items
 * of one turn form one unit; an item without a turn is a unit of its own.
 */
export function evictableItems(items: readonly JournalItem[], keepLatestTurns: number): string[] {
  const units: JournalItem[][] = [];
  for (const item of items) {
    const unit = units.at(-1);
    if (unit && item.turnId !== undefined && unit[0]?.turnId === item.turnId) unit.push(item);
    else units.push([item]);
  }
  return units.slice(0, Math.max(0, units.length - keepLatestTurns)).flat()
    .filter(item => item.state === 'complete' && item.body !== null && !item.liveOnly)
    .map(({ itemKey }) => itemKey);
}
```

In `packages/agent-remote-journal/src/session-journal.ts`, import `evictableItems` from `./retention.js` and `type JournalBody` from `./types.js`, then add after `page`:

```ts
  /** Evicts the bodies of complete, non-live-only items outside the latest turns. Returns the evicted item keys. */
  evict(keepLatestTurns: number): string[] {
    const keys = evictableItems(this.items, keepLatestTurns);
    for (const key of keys) {
      (this.byKey.get(key) as JournalItem).body = null;
      this.dirty.add(key);
    }
    return keys;
  }

  /** Puts back a body read again from the Host. Its digest must equal the one recorded when the item completed. */
  fill(itemKey: string, body: JournalBody, digest: string): 'filled' | 'mismatch' | 'unknown' {
    const item = this.byKey.get(itemKey);
    if (!item) return 'unknown';
    if (item.digest !== undefined && item.digest !== digest) return 'mismatch';
    if (item.body === null) {
      item.body = structuredClone(body);
      this.dirty.add(itemKey);
    }
    return 'filled';
  }
```

Append to `packages/agent-remote-journal/src/index.ts`:

```ts
export { evictableItems } from './retention.js';
```

- [ ] **Step 4: Run the tests.**

Run: `pnpm --filter @orchardworks/agent-remote-journal exec vitest run --testTimeout=10000`
Expected: PASS, 22 tests.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-journal/src
git commit -m "feat(journal): evict bodies outside the latest turns and fill them by digest"
```

### Task 7: Reconcile planning

**Files:**
- Create: `packages/agent-remote-journal/src/reconcile.ts`
- Modify: `packages/agent-remote-journal/src/index.ts`
- Test: `packages/agent-remote-journal/src/reconcile.test.ts`

- [ ] **Step 1: Write the failing tests.** `packages/agent-remote-journal/src/reconcile.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { planReconcile } from './reconcile.js';
import type { JournalIndexEntry } from './types.js';

const entry = (itemKey: string, digest: string | undefined, extra: Partial<JournalIndexEntry> = {}): JournalIndexEntry => ({
  itemKey, seqStart: 0, seqEnd: 0, state: 'complete', ...(digest === undefined ? {} : { digest }), liveOnly: false, revision: 1, resident: true, ...extra,
});
const journal = [entry('a', 'da'), entry('b', 'db'), entry('c', 'dc')];

describe('planReconcile', () => {
  it('continues with nothing to do when the reread matches', () => {
    expect(planReconcile(journal, [{ itemKey: 'a', digest: 'da' }, { itemKey: 'b', digest: 'db' }, { itemKey: 'c', digest: 'dc' }]))
      .toEqual({ kind: 'continue', append: [], correct: [], abandon: [] });
  });

  it('appends new items after the known ones and corrects changed or open items', () => {
    const index = [entry('a', 'da'), entry('b', undefined, { state: 'open' }), entry('c', 'dc')];
    expect(planReconcile(index, [{ itemKey: 'a', digest: 'da' }, { itemKey: 'b', digest: 'db' }, { itemKey: 'c', digest: 'changed' }, { itemKey: 'd', digest: 'dd' }]))
      .toEqual({ kind: 'continue', append: ['d'], correct: ['b', 'c'], abandon: [] });
  });

  it('compares only inside the reread window, leaving older journal items alone', () => {
    expect(planReconcile(journal, [{ itemKey: 'b', digest: 'db' }, { itemKey: 'c', digest: 'dc' }, { itemKey: 'd', digest: 'dd' }]))
      .toEqual({ kind: 'continue', append: ['d'], correct: [], abandon: [] });
  });

  it('ignores live-only journal items', () => {
    const index = [entry('a', 'da'), entry('ask', 'dask', { liveOnly: true }), entry('b', 'db')];
    expect(planReconcile(index, [{ itemKey: 'a', digest: 'da' }, { itemKey: 'b', digest: 'db' }]).kind).toBe('continue');
  });

  it('abandons open items the native history never kept', () => {
    const index = [entry('a', 'da'), entry('b', undefined, { state: 'open' }), entry('c', 'dc'), entry('d', undefined, { state: 'open' })];
    expect(planReconcile(index, [{ itemKey: 'a', digest: 'da' }, { itemKey: 'c', digest: 'dc' }]))
      .toEqual({ kind: 'continue', append: [], correct: [], abandon: ['b', 'd'] });
  });

  it('replaces when a complete item inside the window is missing, reordered or preceded by a new one', () => {
    expect(planReconcile(journal, [{ itemKey: 'a', digest: 'da' }, { itemKey: 'c', digest: 'dc' }])).toEqual({ kind: 'replace', reason: 'missing' });
    expect(planReconcile(journal, [{ itemKey: 'a', digest: 'da' }, { itemKey: 'b', digest: 'db' }])).toEqual({ kind: 'replace', reason: 'missing' });
    expect(planReconcile(journal, [{ itemKey: 'b', digest: 'db' }, { itemKey: 'a', digest: 'da' }])).toEqual({ kind: 'replace', reason: 'reordered' });
    expect(planReconcile(journal, [{ itemKey: 'a', digest: 'da' }, { itemKey: 'x', digest: 'dx' }, { itemKey: 'b', digest: 'db' }])).toEqual({ kind: 'replace', reason: 'inserted' });
    expect(planReconcile(journal, [{ itemKey: 'x', digest: 'dx' }, { itemKey: 'c', digest: 'dc' }])).toEqual({ kind: 'replace', reason: 'inserted' });
  });

  it('asks for older history when the reread starts after everything the journal knows', () => {
    expect(planReconcile(journal, [{ itemKey: 'x', digest: 'dx' }, { itemKey: 'y', digest: 'dy' }])).toEqual({ kind: 'gap' });
  });

  it('appends everything to an empty journal and replaces a journal whose native history is now empty', () => {
    expect(planReconcile([], [{ itemKey: 'a', digest: 'da' }])).toEqual({ kind: 'continue', append: ['a'], correct: [], abandon: [] });
    expect(planReconcile(journal, [])).toEqual({ kind: 'replace', reason: 'missing' });
    expect(planReconcile([entry('a', undefined, { state: 'open' })], [])).toEqual({ kind: 'continue', append: [], correct: [], abandon: ['a'] });
  });
});
```

- [ ] **Step 2: Run them and see them fail.**

Run: `pnpm --filter @orchardworks/agent-remote-journal exec vitest run src/reconcile.test.ts --testTimeout=10000`
Expected: FAIL, because `./reconcile.js` does not exist.

- [ ] **Step 3: Implement.** `packages/agent-remote-journal/src/reconcile.ts`:

```ts
import type { JournalIndexEntry } from './types.js';

/** One item of a reread of native history, oldest first. */
export interface ReconcileCandidate {
  itemKey: string;
  digest: string;
}

export type ReconcilePlan =
  | { kind: 'continue'; append: string[]; correct: string[]; abandon: string[] }
  | { kind: 'replace'; reason: 'missing' | 'reordered' | 'inserted' }
  | { kind: 'gap' };

/**
 * Compares a reread of native history with the journal inside the reread's window. The reread's oldest item is the
 * anchor; journal items older than it are outside the window and stay. Live-only items have no native copy and take
 * no part. Open items the reread lacks were never kept natively and are abandoned rather than treated as a rewrite.
 */
export function planReconcile(index: readonly JournalIndexEntry[], reread: readonly ReconcileCandidate[]): ReconcilePlan {
  const known = index.filter(({ liveOnly }) => !liveOnly);
  const position = new Map(known.map(({ itemKey }, at) => [itemKey, at] as const));
  const append: string[] = [];
  const correct: string[] = [];
  const abandon: string[] = [];
  const first = reread[0];
  let next = 0;
  if (first !== undefined && known.length > 0) {
    const anchor = position.get(first.itemKey);
    if (anchor === undefined) {
      return reread.some(({ itemKey }) => position.has(itemKey)) ? { kind: 'replace', reason: 'inserted' } : { kind: 'gap' };
    }
    next = anchor;
  }
  for (const candidate of reread) {
    const at = position.get(candidate.itemKey);
    if (at === undefined) {
      append.push(candidate.itemKey);
      continue;
    }
    if (append.length > 0) return { kind: 'replace', reason: 'inserted' };
    if (at < next) return { kind: 'replace', reason: 'reordered' };
    for (let skipped = next; skipped < at; skipped += 1) {
      const passed = known[skipped] as JournalIndexEntry;
      if (passed.state !== 'open') return { kind: 'replace', reason: 'missing' };
      abandon.push(passed.itemKey);
    }
    const matched = known[at] as JournalIndexEntry;
    if (matched.state === 'open' || matched.digest !== candidate.digest) correct.push(candidate.itemKey);
    next = at + 1;
  }
  for (let rest = next; rest < known.length; rest += 1) {
    const remaining = known[rest] as JournalIndexEntry;
    if (remaining.state !== 'open') return { kind: 'replace', reason: 'missing' };
    abandon.push(remaining.itemKey);
  }
  return { kind: 'continue', append, correct, abandon };
}
```

Append to `packages/agent-remote-journal/src/index.ts`:

```ts
export { planReconcile, type ReconcileCandidate, type ReconcilePlan } from './reconcile.js';
```

- [ ] **Step 4: Run the tests.**

Run: `pnpm --filter @orchardworks/agent-remote-journal exec vitest run --testTimeout=10000`
Expected: PASS, 30 tests.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-journal/src
git commit -m "feat(journal): plan reconciles inside the reread window"
```

### Task 8: The store port

**Files:**
- Create: `packages/agent-remote-journal/src/journal-store.ts`
- Modify: `packages/agent-remote-journal/src/index.ts`
- Test: `packages/agent-remote-journal/src/journal-store.test.ts`

- [ ] **Step 1: Write the failing tests.** `packages/agent-remote-journal/src/journal-store.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { MemoryJournalStore } from './journal-store.js';
import { SessionJournal } from './session-journal.js';
import { openJournal, text } from './journal.test-fixture.js';

describe('MemoryJournalStore', () => {
  it('restores a journal from the changes it applied', async () => {
    const store = new MemoryJournalStore();
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'Hel'));
    await store.apply(journal.takeChanges()!);
    journal.append(publish(), text('m1', 'd2', 'lo'));
    journal.append(publish(), text('m2', 'd3', 'Next'));
    await store.apply(journal.takeChanges()!);
    const restored = new SessionJournal((await store.load(journal.sessionKey))!);
    expect(restored.index()).toEqual(journal.index());
    expect(restored.cursor).toEqual(journal.cursor);
    const request = { requestId: 'r', agentId: 'a', direction: 'tail' as const, limit: 10 };
    expect(restored.page(request, { olderBeyondJournal: false })).toEqual(journal.page(request, { olderBeyondJournal: false }));
  });

  it('drops the old items after a replacement and deletes a journal', async () => {
    const store = new MemoryJournalStore();
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'Old'));
    await store.apply(journal.takeChanges()!);
    journal.replace(publish(), [{ row: text('m2', 'h2', 'Fresh'), digest: 'digest-2' }], 0);
    await store.apply(journal.takeChanges()!);
    expect((await store.load(journal.sessionKey))?.items.map(({ itemKey }) => itemKey)).toEqual(['m2']);
    await store.delete(journal.sessionKey);
    expect(await store.load(journal.sessionKey)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them and see them fail.**

Run: `pnpm --filter @orchardworks/agent-remote-journal exec vitest run src/journal-store.test.ts --testTimeout=10000`
Expected: FAIL, because `./journal-store.js` does not exist.

- [ ] **Step 3: Implement.** `packages/agent-remote-journal/src/journal-store.ts`:

```ts
import type { JournalChanges, JournalItem, JournalMeta, JournalState } from './types.js';

/** Persists journals incrementally: the store applies the changes a journal hands out. */
export interface JournalStore {
  load(sessionKey: string): Promise<JournalState | undefined>;
  apply(changes: JournalChanges): Promise<void>;
  delete(sessionKey: string): Promise<void>;
}

export class MemoryJournalStore implements JournalStore {
  private readonly sessions = new Map<string, { meta: JournalMeta; items: Map<string, JournalItem> }>();

  async load(sessionKey: string): Promise<JournalState | undefined> {
    const session = this.sessions.get(sessionKey);
    if (!session) return undefined;
    const items = [...session.items.values()].map(item => structuredClone(item)).sort((left, right) => left.seqStart - right.seqStart);
    return { meta: structuredClone(session.meta), items };
  }

  async apply(changes: JournalChanges): Promise<void> {
    const existing = this.sessions.get(changes.meta.sessionKey);
    const items = existing && !changes.replaced ? existing.items : new Map<string, JournalItem>();
    for (const item of changes.upsert) items.set(item.itemKey, structuredClone(item));
    this.sessions.set(changes.meta.sessionKey, { meta: structuredClone(changes.meta), items });
  }

  async delete(sessionKey: string): Promise<void> {
    this.sessions.delete(sessionKey);
  }
}
```

Append to `packages/agent-remote-journal/src/index.ts`:

```ts
export { MemoryJournalStore, type JournalStore } from './journal-store.js';
```

- [ ] **Step 4: Run the tests.**

Run: `pnpm --filter @orchardworks/agent-remote-journal exec vitest run --testTimeout=10000`
Expected: PASS, 32 tests.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-journal/src
git commit -m "feat(journal): persist journals incrementally through a store port"
```

### Task 9: Verify the workspace and update compatibility metadata

**Files:**
- Modify: `packages/agent-remote-lab/compatibility.json` (generated)

- [ ] **Step 1: Build and typecheck the new package and the relay.**

Run: `pnpm --filter @orchardworks/agent-remote-journal run build && pnpm --filter @orchardworks/agent-remote-journal run typecheck && pnpm --filter @orchardworks/agent-remote-relay run typecheck`
Expected: exit code 0.

- [ ] **Step 2: Run the relay's full suite and the journal suite.**

Run: `pnpm --filter @orchardworks/agent-remote-relay exec vitest run --testTimeout=10000 && pnpm --filter @orchardworks/agent-remote-journal exec vitest run --testTimeout=10000`
Expected: PASS for both.

- [ ] **Step 3: Check that the test helpers are not shipped.** `src/**/*.test.ts` is excluded by `tsconfig.json`, so `dist` holds no test file.

Run: `ls packages/agent-remote-journal/dist | grep -c test || true`
Expected: `0`.

- [ ] **Step 4: Update and check the compatibility digest.**

Run: `pnpm compatibility:update && pnpm compatibility:check`
Expected: exit code 0 for both.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-lab/compatibility.json
git commit -m "chore: compatibility digest after the journal core"
```
