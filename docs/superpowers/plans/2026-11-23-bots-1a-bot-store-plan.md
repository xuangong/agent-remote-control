# Bots 1a: the bot store — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every bot a Relay record with a stable `botId`, its identity (name, label, picture) and its mission, while Window groups keep only placement and a `botId` reference, without changing what pages and older clients read.

**Architecture:** Records live beside the Window rows in `HostedRelayState.bots`, one storage record each. The Window service splits on write and merges on read: a group's `bots.members[viewId]` is stored as placement plus `botId`, and every response merges the bot's identity back, so the wire shape stays `WindowBotDetails` (which gains `botId` and `mission`). One reconcile function runs after every Window change: it creates records for new bot views, writes identity fields, and retires records no live group references. Existing bots migrate when the state loads, with ids derived from account, Window and view, so they are stable before the first commit.

**Tech Stack:** TypeScript, TypeBox (protocol schemas), Vitest, pnpm workspaces. Packages: `agent-remote-protocol`, `agent-relay-core`, `agent-remote-lab`.

Design: [bots design](../specs/2026-11-23-bots-design.md) section 2.1; parent plan: [bots plan](2026-11-23-fold-into-assistants-plan.md) step 1. Plans 1b (standing instructions and missions in sessions) and 1c (chains and usage) follow.

**Out of scope here:** `organizer` other than the person, `lifetime: temporary`, `main` for bots without a view, `status`, `peers` (step 2 fills them); mission delivery to sessions (1b); chains (1c).

**Compatibility:** forward only, as decided for this work: an older Relay cannot read a state with `bot` records or `botId` in bot details. No intermediate release ships this alone.

> **Found while executing (2026-11-23).** Two things the steps below did not foresee, fixed in the code: `reconcileBots` takes a
> `changed` set of the rows the change wrote, because rows it did not write hold placement only and would read as identity cleared;
> and the snapshot decoder compares `bots` as stored (like Window rows), since a snapshot from before bot records gains records when
> it loads. `encodeValidatedHostedSnapshot` is exported so a test can write such a snapshot.

## File structure

| File | Responsibility |
|---|---|
| `packages/agent-remote-protocol/src/bots.ts` (create) | `BotRecord` schema, `BOT_MISSION_LIMIT`, `botIdentity` / `botPlacement` split of `WindowBotDetails` |
| `packages/agent-remote-protocol/src/window-groups.ts` (modify) | `WindowBotDetails` gains `botId` and `mission` |
| `packages/agent-relay-core/src/bot-store.ts` (create) | `SavedBot`, validation, `mergeBots` (read), `reconcileBots` (write), `migrationBotId` |
| `packages/agent-relay-core/src/state.ts` (modify) | `HostedRelayState.bots`, validation, load migration |
| `packages/agent-relay-core/src/record-codec.ts` (modify) | Record kind `bot` |
| `packages/agent-relay-core/src/window-workspaces.ts` (modify) | Merge on read, reconcile after each change |
| `packages/agent-relay-core/src/assistants.ts` (modify) | Directory ids are `botId` |
| `packages/agent-remote-lab/src/conversation/assistant/AssistantDetails.tsx` and `MissionEditor.tsx` (create) | Mission section in a bot's details |

Run tests with Node 22 (`export PATH=/opt/homebrew/opt/node@22/bin:$PATH`) and `LANG=en_US.UTF-8`.

### Task 1: the bot record in the protocol

**Files:**
- Create: `packages/agent-remote-protocol/src/bots.ts`
- Modify: `packages/agent-remote-protocol/src/window-groups.ts` (move `BotPicture` and `readBotPicture` to `bots.ts` and re-export them; add `botId` and `mission` to `WindowBotDetails`)
- Modify: `packages/agent-remote-protocol/src/index.ts` (add `export * from './bots.js';`)
- Test: `packages/agent-remote-protocol/src/bots.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { BOT_MISSION_LIMIT, BotRecord, botIdentity, botPlacement, WindowBotDetails } from './index.js';

const id = 'b_' + 'a'.repeat(32);

describe('bot records', () => {
  it('accepts a standing bot of the person with identity and mission, and refuses unknown fields', () => {
    const record = { botId: id, name: 'Chief', label: 'Lead', picture: { shape: 'circle', color: '#ff8a3d' }, mission: 'Coordinate the release.',
      organizer: { kind: 'person' }, lifetime: 'standing', createdAt: 1, updatedAt: 2 };
    expect(Value.Check(BotRecord, record)).toBe(true);
    expect(Value.Check(BotRecord, { ...record, mode: 'coordinator' })).toBe(false);
    expect(Value.Check(BotRecord, { ...record, botId: 'chief' })).toBe(false);
    expect(Value.Check(BotRecord, { ...record, mission: 'x'.repeat(BOT_MISSION_LIMIT + 1) })).toBe(false);
  });

  it('splits bot details into identity, which the record keeps, and placement, which the group keeps', () => {
    const details = { botId: id, name: 'Chief', label: 'Lead', mission: 'Coordinate.', pinned: true as const, rank: 'm', process: 'full' as const };
    expect(Value.Check(WindowBotDetails, details)).toBe(true);
    expect(botIdentity(details)).toEqual({ name: 'Chief', label: 'Lead', mission: 'Coordinate.' });
    expect(botPlacement(details)).toEqual({ botId: id, pinned: true, rank: 'm', process: 'full' });
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm test:unit agent-remote-protocol src/bots.test.ts`
Expected: FAIL, `./index.js` has no export `BotRecord`.

- [ ] **Step 3: Write `bots.ts`**

```ts
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const strict = { additionalProperties: false } as const;
const time = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

/** A bot's picture: a shape, a colour and which of six directions it looks (0 to 5; omitted means the default look). */
export const BotPicture = Type.Object({
  shape: Type.Union([Type.Literal('circle'), Type.Literal('squircle'), Type.Literal('triangle'), Type.Literal('sideways')]),
  color: Type.String({ pattern: '^#[0-9a-f]{6}$' }),
  gaze: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
}, strict);
export type BotPicture = Static<typeof BotPicture>;
/** A stored picture in the current form: older rows hold `rounded` or `hexagon`, which read as `squircle` with the same colour; an invalid picture reads as none. */
export function readBotPicture(stored: unknown): BotPicture | undefined {
  if (!stored || typeof stored !== 'object') return undefined;
  const picture = stored as { shape?: unknown };
  const current = picture.shape === 'rounded' || picture.shape === 'hexagon' ? { ...picture, shape: 'squircle' } : picture;
  return Value.Check(BotPicture, current) ? current : undefined;
}

/** A bot's id: stable across handoffs and moves between groups. */
export const BotId = Type.String({ pattern: '^b_[0-9a-f]{32}$' });
export const BOT_MISSION_LIMIT = 4000;
/** What a bot is for and how it sees its place; its standing instructions after the base instructions. */
export const BotMission = Type.String({ minLength: 1, maxLength: BOT_MISSION_LIMIT });
export const BotName = Type.String({ minLength: 1, maxLength: 60 });
export const BotLabel = Type.String({ minLength: 1, maxLength: 120 });

/**
 * One bot of an account, kept by the Relay (bots design 2.1). Its placement in Bot mode and Windows stays in the groups, which refer
 * to it by `botId`. `retiredAt`: it left every group, or its work ended; a retired bot is unreachable.
 */
export const BotRecord = Type.Object({
  botId: BotId,
  name: Type.Optional(BotName),
  label: Type.Optional(BotLabel),
  picture: Type.Optional(BotPicture),
  mission: Type.Optional(BotMission),
  organizer: Type.Union([Type.Object({ kind: Type.Literal('person') }, strict), Type.Object({ kind: Type.Literal('bot'), botId: BotId }, strict)]),
  lifetime: Type.Union([Type.Literal('standing'), Type.Literal('temporary')]),
  createdAt: time,
  updatedAt: time,
  retiredAt: Type.Optional(time),
}, strict);
export type BotRecord = Static<typeof BotRecord>;
export const isBotRecord = (value: unknown): value is BotRecord => Value.Check(BotRecord, value);

/** The bot details fields that belong to the bot rather than to its place in a group. */
export const BOT_IDENTITY_FIELDS = ['name', 'label', 'picture', 'mission'] as const;
type IdentityField = typeof BOT_IDENTITY_FIELDS[number];
export type BotIdentity = Partial<Pick<BotRecord, IdentityField>>;

/** The identity part of bot details, as the bot's record keeps it. */
export function botIdentity<T extends BotIdentity>(details: T): BotIdentity {
  return Object.fromEntries(BOT_IDENTITY_FIELDS.filter(key => details[key] !== undefined).map(key => [key, details[key]])) as BotIdentity;
}
/** The placement part of bot details, as the group keeps it: everything but identity. */
export function botPlacement<T extends BotIdentity>(details: T): Omit<T, IdentityField> {
  const placement = { ...details } as T;
  for (const key of BOT_IDENTITY_FIELDS) delete placement[key];
  return placement;
}
```

- [ ] **Step 4: Change `window-groups.ts`**

Replace the `BotPicture` and `readBotPicture` declarations (lines 12–25) with:

```ts
import { BotId, BotLabel, BotMission, BotName, BotPicture } from './bots.js';
export { BotPicture, readBotPicture } from './bots.js';
```

In `WindowBotDetails`, use `name: Type.Optional(BotName)` and `label: Type.Optional(BotLabel)` in place of the inline strings, and add after `rank`:

```ts
  /** The bot's record at the Relay. Responses carry it; a change that leaves it out keeps the bot of the same view. */
  botId: Type.Optional(BotId),
  /** What the bot is for, in its record; its standing instructions after the base instructions. */
  mission: Type.Optional(BotMission),
```

Add `export * from './bots.js';` to `index.ts` next to `window-groups.js`.

If TypeScript reports `BotPicture` exported twice through `index.ts`, drop the re-export line from `window-groups.ts` and import
`BotPicture` / `readBotPicture` from `./bots.js` in the protocol files that used them from `./window-groups.js`.

- [ ] **Step 5: Run the protocol suite**

Run: `pnpm test:unit agent-remote-protocol`
Expected: all pass, the new file included.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-remote-protocol/src/bots.ts packages/agent-remote-protocol/src/bots.test.ts packages/agent-remote-protocol/src/window-groups.ts packages/agent-remote-protocol/src/index.ts
git commit -m "feat(bots): the bot record and the split of bot details"
```

### Task 2: the bot store's rules, as pure functions

**Files:**
- Create: `packages/agent-relay-core/src/bot-store.ts`
- Test: `packages/agent-relay-core/src/bot-store.test.ts`

The two functions every later task uses: `mergeBots` turns a stored group into what pages read, and `reconcileBots` brings the
records in line with the stored groups after a change. Both work on plain arrays; Task 4 calls them inside the state's mutation.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import type { WindowGroup } from '@orchardworks/agent-remote-protocol';
import { mergeBots, migrationBotId, reconcileBots, validBots, type SavedBot } from './bot-store.js';
import type { SavedWorkspaceWindow } from './window-workspaces.js';

const view = (id: string, nativeSessionId: string) => ({ id, placement: 'primary', binding: { hostId: 'mac', providerId: 'claude', nativeSessionId, title: nativeSessionId } });
const row = (id: string, members: Record<string, Record<string, unknown>>): SavedWorkspaceWindow => ({ subject: 'me', id, generation: 0, receipts: [],
  window: { id, title: id, revision: 1, views: Object.keys(members).map((viewId, index) => view(viewId, `${id}-${index}`)), selectedViewId: null, selectedPrimaryViewId: null } as never,
  bots: { rank: 'm', members: members as never } });
let next = 0;
const newId = () => 'b_' + (++next).toString(16).padStart(32, '0');

describe('the bot store', () => {
  it('creates a record for a new bot view, keeps identity there and placement with the group', () => {
    const rows = [row('g1', { v1: { name: 'Chief', label: 'Lead', mission: 'Coordinate.', pinned: true } })], bots: SavedBot[] = [];
    reconcileBots('me', rows, bots, new Map(), 10, newId);
    const botId = rows[0]!.bots!.members.v1!.botId!;
    expect(rows[0]!.bots!.members.v1).toEqual({ botId, pinned: true });
    expect(bots).toEqual([{ subject: 'me', botId, name: 'Chief', label: 'Lead', mission: 'Coordinate.', organizer: { kind: 'person' }, lifetime: 'standing', createdAt: 10, updatedAt: 10 }]);
    expect(mergeBots('me', { window: rows[0]!.window!, bots: rows[0]!.bots } as WindowGroup, bots).bots!.members.v1).toEqual({ botId, pinned: true, name: 'Chief', label: 'Lead', mission: 'Coordinate.' });
  });

  it('keeps a bot through a change that leaves its id out, by its view, and through a move to another group, by its id', () => {
    const rows = [row('g1', { v1: { name: 'Chief' } }), row('g2', { v9: { name: 'Other' } })], bots: SavedBot[] = [];
    reconcileBots('me', rows, bots, new Map(), 10, newId);
    const chief = rows[0]!.bots!.members.v1!.botId!;
    const before = new Map([[JSON.stringify(['g1', 'v1']), chief]]);
    rows[0]!.bots!.members.v1 = { name: 'Chief 2' };
    reconcileBots('me', rows, bots, before, 11, newId);
    expect(rows[0]!.bots!.members.v1!.botId).toBe(chief);
    // The bot moves to g2 with its id, as a transfer carries its details.
    rows[1]!.window!.views.push(view('v1', 'moved') as never); rows[1]!.bots!.members.v1 = { botId: chief, name: 'Chief 2' };
    rows[0]!.window!.views.splice(0, 1); delete rows[0]!.bots!.members.v1;
    reconcileBots('me', rows, bots, new Map(), 12, newId);
    expect(bots.find(bot => bot.botId === chief)).toMatchObject({ name: 'Chief 2', updatedAt: 11 });
    expect(bots.find(bot => bot.botId === chief)!.retiredAt).toBeUndefined();
  });

  it('retires a standing bot no live group shows, and brings it back when one shows it again', () => {
    const rows = [row('g1', { v1: { name: 'Chief' } })], bots: SavedBot[] = [];
    reconcileBots('me', rows, bots, new Map(), 10, newId);
    const chief = rows[0]!.bots!.members.v1!.botId!;
    const removed = rows[0]!.bots!.members.v1!;
    delete rows[0]!.bots!.members.v1;
    reconcileBots('me', rows, bots, new Map(), 20, newId);
    expect(bots[0]).toMatchObject({ botId: chief, retiredAt: 20 });
    rows[0]!.bots!.members.v1 = removed;
    reconcileBots('me', rows, bots, new Map(), 30, newId);
    expect(bots[0]!.retiredAt).toBeUndefined();
  });

  it('never touches another account, and refuses an id another account holds', () => {
    const bots: SavedBot[] = [{ subject: 'other', botId: newId(), organizer: { kind: 'person' }, lifetime: 'standing', createdAt: 1, updatedAt: 1 }];
    const rows = [row('g1', { v1: { botId: bots[0]!.botId, name: 'Mine' } })];
    reconcileBots('me', rows, bots, new Map(), 10, newId);
    expect(rows[0]!.bots!.members.v1!.botId).not.toBe(bots[0]!.botId);
    expect(bots.filter(bot => bot.subject === 'other')).toEqual([{ subject: 'other', botId: bots[0]!.botId, organizer: { kind: 'person' }, lifetime: 'standing', createdAt: 1, updatedAt: 1 }]);
  });

  it('derives the same id for an existing bot on every load, and validates stored records', () => {
    expect(migrationBotId('me', 'g1', 'v1')).toBe(migrationBotId('me', 'g1', 'v1'));
    expect(migrationBotId('me', 'g1', 'v1')).toMatch(/^b_[0-9a-f]{32}$/);
    const record = { subject: 'me', botId: newId(), organizer: { kind: 'person' }, lifetime: 'standing', createdAt: 1, updatedAt: 1 };
    expect(validBots([record])).toBe(true);
    expect(validBots([record, record])).toBe(false);
    expect(validBots([{ ...record, subject: '' }])).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm test:unit agent-relay-core src/bot-store.test.ts`
Expected: FAIL, cannot find module `./bot-store.js`.

- [ ] **Step 3: Write `bot-store.ts`**

```ts
/**
 * The Relay's bot records (bots design 2.1). A group keeps a bot's placement and its `botId`; the record keeps who the bot is. Pages
 * read groups merged with their records (`mergeBots`), and every change to groups is followed by `reconcileBots`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { botIdentity, botPlacement, groupBotViews, isBotRecord, BOT_IDENTITY_FIELDS, type BotRecord, type WindowBotDetails, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import type { SavedWorkspaceWindow } from './window-workspaces.js';

export type SavedBot = BotRecord & { subject: string };
/** Bot records kept across every account. */
export const MAX_BOTS = 20000;
const key = (windowId: string, viewId: string) => JSON.stringify([windowId, viewId]);

export const newBotId = () => 'b_' + randomUUID().replaceAll('-', '');
/** The id an existing bot gets when its account's bots first move into records: the same on every load, so a restart before the first commit changes nothing. */
export const migrationBotId = (subject: string, windowId: string, viewId: string) =>
  'b_' + createHash('sha256').update(JSON.stringify(['bot', subject, windowId, viewId])).digest('hex').slice(0, 32);

export function validBots(value: unknown): value is SavedBot[] {
  if (!Array.isArray(value) || value.length > MAX_BOTS) return false;
  const ids = new Set<string>();
  return value.every(item => {
    if (!item || typeof item !== 'object' || typeof item.subject !== 'string' || !item.subject) return false;
    const { subject: _, ...record } = item;
    if (!isBotRecord(record) || ids.has(record.botId)) return false;
    ids.add(record.botId); return true;
  });
}

/** The group as pages read it: each bot's details with its record's identity. A detail without a record is read as stored. */
export function mergeBots(subject: string, group: WindowGroup, bots: readonly SavedBot[]): WindowGroup {
  if (!group.bots) return group;
  const byId = new Map(bots.filter(bot => bot.subject === subject).map(bot => [bot.botId, bot]));
  return { ...group, bots: { ...group.bots, members: Object.fromEntries(Object.entries(group.bots.members).map(([viewId, details]) => {
    const record = details.botId ? byId.get(details.botId) : undefined;
    return [viewId, record ? { ...botPlacement(details), ...botIdentity(record) } : details];
  })) } };
}

/** The `botId` of every bot view of an account's live rows, by Window and view, read before a change. */
export function botIdsByView(subject: string, rows: readonly SavedWorkspaceWindow[]): Map<string, string> {
  const ids = new Map<string, string>();
  for (const row of rows) if (row.subject === subject && !row.deleted) for (const [viewId, details] of Object.entries(row.bots?.members ?? {})) if (details.botId) ids.set(key(row.id, viewId), details.botId);
  return ids;
}

/**
 * After a change to an account's groups: every bot view of a live row gets a record (by its `botId`, else the id its view had before
 * the change, else a new one), the record takes the identity its details carry, and the row keeps only placement and the id. A
 * standing bot no live row shows is retired; one shown again is brought back.
 */
export function reconcileBots(subject: string, rows: SavedWorkspaceWindow[], bots: SavedBot[], before: ReadonlyMap<string, string>, now: number, newId: () => string = newBotId): void {
  const mine = new Map(bots.filter(bot => bot.subject === subject).map(bot => [bot.botId, bot]));
  const taken = new Set(bots.filter(bot => bot.subject !== subject).map(bot => bot.botId));
  const shown = new Set<string>();
  for (const row of rows) {
    if (row.subject !== subject || row.deleted || !row.window || !row.bots) continue;
    const views = new Set(groupBotViews({ window: row.window, bots: row.bots }).map(view => view.id));
    for (const [viewId, details] of Object.entries(row.bots.members)) {
      if (!views.has(viewId)) continue;
      const known = (id: string | undefined) => id && !taken.has(id) && !shown.has(id) ? id : undefined;
      const botId = known(details.botId) ?? known(before.get(key(row.id, viewId))) ?? newId();
      let record = mine.get(botId);
      if (!record) { record = { subject, botId, organizer: { kind: 'person' }, lifetime: 'standing', createdAt: now, updatedAt: now }; bots.push(record); mine.set(botId, record); }
      const identity = botIdentity(details as WindowBotDetails);
      if (BOT_IDENTITY_FIELDS.some(field => JSON.stringify(record![field]) !== JSON.stringify(identity[field]))) {
        for (const field of BOT_IDENTITY_FIELDS) { if (identity[field] === undefined) delete record[field]; else (record as Record<string, unknown>)[field] = identity[field]; }
        record.updatedAt = now;
      }
      if (record.retiredAt !== undefined) delete record.retiredAt;
      row.bots.members[viewId] = { ...botPlacement(details), botId };
      shown.add(botId);
    }
  }
  for (const record of mine.values()) if (record.lifetime === 'standing' && !shown.has(record.botId) && record.retiredAt === undefined) record.retiredAt = now;
}
```

A record with no identity change keeps its `updatedAt`, as the test of the move expects (`updatedAt: 11`).

- [ ] **Step 4: Run it**

Run: `pnpm test:unit agent-relay-core src/bot-store.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-relay-core/src/bot-store.ts packages/agent-relay-core/src/bot-store.test.ts
git commit -m "feat(bots): records beside groups, merged on read and reconciled after a change"
```

### Task 3: records in the Relay state, the storage codec and the load migration

**Files:**
- Modify: `packages/agent-relay-core/src/bot-store.ts` (add `needsBotMigration`, `migrateBots`)
- Modify: `packages/agent-relay-core/src/window-workspaces.ts` (`readStoredBots` moves to `bot-store.ts`)
- Modify: `packages/agent-relay-core/src/state.ts` (field, validation, migration on load)
- Modify: `packages/agent-relay-core/src/record-codec.ts` (record kind `bot`)
- Test: `packages/agent-relay-core/src/bot-store.test.ts`, `packages/agent-relay-core/src/bot-store-state.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Append to `bot-store.test.ts`:

```ts
import { migrateBots, needsBotMigration } from './bot-store.js';

describe('moving existing bots into records', () => {
  it('gives every existing bot view a record with an id derived from its place, once', () => {
    const rows = [row('g1', { v1: { name: 'Chief', picture: { shape: 'rounded', color: '#ff8a3d' }, pinned: true } })];
    expect(needsBotMigration(rows)).toBe(true);
    const bots: SavedBot[] = [];
    migrateBots(rows, bots, 5);
    expect(rows[0]!.bots!.members.v1).toEqual({ botId: migrationBotId('me', 'g1', 'v1'), pinned: true });
    // An older picture shape reads in the current form before it moves.
    expect(bots).toEqual([expect.objectContaining({ botId: migrationBotId('me', 'g1', 'v1'), name: 'Chief', picture: { shape: 'squircle', color: '#ff8a3d' } })]);
    expect(needsBotMigration(rows)).toBe(false);
  });
});
```

Create `bot-store-state.test.ts`:

```ts
import { expect, it } from 'vitest';
import { decodeHostedSnapshot, encodeHostedSnapshot } from './record-codec.js';
import { emptyRelayState, validateRelayState } from './state.js';
import { migrationBotId } from './bot-store.js';

const auth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 'bot-store-test-secret-0123456789' };
const window = { id: 'g1', title: 'g1', revision: 1, selectedViewId: null, selectedPrimaryViewId: null,
  views: [{ id: 'v1', placement: 'primary', binding: { hostId: 'mac', providerId: 'claude', nativeSessionId: 's1', title: 's1' } }] };

it('moves existing bots into records when the state loads, and keeps them through the stored records', () => {
  const legacy = { ...emptyRelayState(auth), workspaceWindows: [{ subject: 'me', id: 'g1', generation: 0, receipts: [], window, bots: { rank: 'm', members: { v1: { name: 'Chief' } } } }] };
  const loaded = validateRelayState(structuredClone(legacy), auth);
  const botId = migrationBotId('me', 'g1', 'v1');
  expect(loaded.workspaceWindows![0]!.bots!.members.v1).toEqual({ botId });
  expect(loaded.bots).toEqual([expect.objectContaining({ subject: 'me', botId, name: 'Chief' })]);
  // A second load before any commit gives the same id.
  expect(validateRelayState(structuredClone(legacy), auth).bots![0]!.botId).toBe(botId);
  const records = [...encodeHostedSnapshot(loaded, auth).records.values()];
  const decoded = decodeHostedSnapshot(records.map(record => record.manifest), records.flatMap(record => record.chunks), auth);
  expect(decoded.bots).toEqual(loaded.bots);
  expect(() => validateRelayState({ ...loaded, bots: [...loaded.bots!, loaded.bots![0]] }, auth)).toThrow();
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm test:unit agent-relay-core src/bot-store.test.ts src/bot-store-state.test.ts`
Expected: FAIL, `migrateBots` is not exported, and `loaded.bots` is undefined.

- [ ] **Step 3: Add the migration to `bot-store.ts`**

Move `readStoredBots` (with its comment) from `window-workspaces.ts` into `bot-store.ts`, exported, and import it in
`window-workspaces.ts` from `./bot-store.js`, so the two modules do not import each other in a cycle. `bot-store.ts` then imports
`readBotPicture` from the protocol as well. Then add:

```ts
const bound = (row: SavedWorkspaceWindow) => row.window && row.bots ? groupBotViews({ window: row.window, bots: row.bots }).map(view => view.id) : [];
/** Whether some live row holds a bot view without a record. */
export function needsBotMigration(rows: readonly SavedWorkspaceWindow[]): boolean {
  return rows.some(row => !row.deleted && bound(row).some(viewId => !row.bots!.members[viewId]?.botId));
}
/** Gives every bot view of every account a record, with `migrationBotId` for those without one. Pictures are read in the current form first. */
export function migrateBots(rows: SavedWorkspaceWindow[], bots: SavedBot[], now: number): void {
  for (const row of rows) if (!row.deleted && row.bots) row.bots = readStoredBots(row.bots) as typeof row.bots;
  for (const subject of new Set(rows.map(row => row.subject))) {
    const before = new Map<string, string>();
    for (const row of rows) if (row.subject === subject && !row.deleted) for (const viewId of bound(row)) before.set(key(row.id, viewId), migrationBotId(subject, row.id, viewId));
    reconcileBots(subject, rows, bots, before, now);
  }
}
```


- [ ] **Step 4: Add the field, validation and migration to `state.ts`**

1. Import: `import { migrateBots, needsBotMigration, validBots, type SavedBot } from './bot-store.js';`
2. In `HostedRelayState`, after `workspaceWindows?`:
   ```ts
     /** Each account's bots (bots design 2.1), one record each; groups refer to them by `botId`. */
     bots?: SavedBot[];
   ```
3. In `checkRelayState`, next to the `workspaceWindows` check:
   ```ts
     if (value.bots !== undefined && !validBots(value.bots)) return invalid();
   ```
4. In `migrateRelayState`, after the Window rows are decoded:
   ```ts
     if (migrated.workspaceWindows && needsBotMigration(migrated.workspaceWindows)) migrateBots(migrated.workspaceWindows, migrated.bots ??= [], Date.now());
   ```
5. In the function that decides whether to migrate (the line `if (Object.hasOwn(value, 'sessionSuccessions') || value.workspaceWindows?.some(row => !normalized(row))) return migrateRelayState(value);`), add `|| (value.workspaceWindows !== undefined && needsBotMigration(value.workspaceWindows))` to the condition.

- [ ] **Step 5: Add the record kind to `record-codec.ts`**

Mirror `sessionDraft` / `sessionDrafts` at each of its places:

1. `HOSTED_RECORD_KINDS`: append `'bot'`.
2. `HostedRelayHeader`: add `'bots'` to the `Omit<…>` list and `bots?: Identity<'bot'>[];` to the added fields.
3. In the encoder's references (next to `sessionDrafts: references(…)`):
   ```ts
       bots: references(state.bots, 'bot', '', value => JSON.stringify([value.subject, value.botId])),
   ```
4. In the decoder (next to `collection(relay, 'sessionDrafts', 'sessionDraft', '');`):
   ```ts
     collection(relay, 'bots', 'bot', '');
   ```
5. Wherever the decoder rebuilds the state from the header and the collections (the object that spreads `workspaceWindows` at the end of `decodeHostedSnapshot`), carry `bots` the same way `sessionDrafts` is carried.

- [ ] **Step 6: Run the tests**

Run: `pnpm test:unit agent-relay-core src/bot-store.test.ts src/bot-store-state.test.ts`
Expected: all pass. Then `pnpm test:unit agent-relay-core`: all pass; Window tests that compare stored `bots.members` may now see `botId` and fail, which Task 4 fixes.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-relay-core/src/bot-store.ts packages/agent-relay-core/src/bot-store.test.ts packages/agent-relay-core/src/bot-store-state.test.ts packages/agent-relay-core/src/state.ts packages/agent-relay-core/src/record-codec.ts packages/agent-relay-core/src/window-workspaces.ts
git commit -m "feat(bots): bot records in the Relay state, stored and migrated on load"
```

### Task 4: the Window service reads merged groups and reconciles after every change

**Files:**
- Modify: `packages/agent-relay-core/src/window-workspaces.ts`
- Test: `packages/agent-relay-core/src/window-bots.test.ts` (create); update `window-workspaces.test.ts` and `gateway-push.test.ts` where they compare stored bot details

Every operation must see each bot's identity in its details: an operation that does not touch a bot (a rename of the group, a new
rank) carries its details through, and `reconcileBots` would otherwise read a missing name as a cleared one. So the service applies
operations to merged groups, stores the result, and reconciles, which moves identity back into records.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from 'vitest';
import { createWindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { createRelayState, emptyRelayState } from './state.js';
import { createWindowWorkspaces } from './window-workspaces.js';

const auth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 'window-bots-test-secret-0123456789' };
const view = (id: string, nativeSessionId: string) => createWindowView(id, { hostId: 'host', providerId: 'claude', nativeSessionId, title: nativeSessionId }, 'primary');
const window = (id: string, views: ReturnType<typeof view>[]): WorkspaceWindow => ({ schemaVersion: 3, id, title: id, revision: 0, selectedPrimaryViewId: views[0]?.id ?? null, selectedViewId: views[0]?.id ?? null, views });

async function fixture() {
  let clock = 1_000;
  const state = createRelayState(auth, { initial: emptyRelayState(auth), async commit() {} }, () => {}, () => {});
  const service = createWindowWorkspaces(state, () => true, () => clock);
  const me = { subject: 'me' };
  const create = (id: string, members: Record<string, Record<string, unknown>>) => service.create(me, { operationId: `create-${id}`, issuedAt: clock,
    window: window(id, Object.keys(members).map(viewId => view(viewId, `${id}-${viewId}`))), bots: { rank: id === 'a' ? 'm' : 'n', members } });
  let n = 0;
  const change = (id: string, operation: unknown) => service.mutate(me, id, { operationId: `op-${++n}`, issuedAt: clock, baseRevision: service.inspect(me, id).window.revision, operation });
  const member = (id: string, viewId: string) => service.list(me).groups.find(group => group.window.id === id)!.bots!.members[viewId]!;
  return { state, service, me, create, change, member, tick: () => { clock += 1_000; } };
}

it('keeps who a bot is in its record and serves its details merged, through edits that do not touch it', async () => {
  const f = await fixture();
  await f.create('a', { v1: { name: 'Chief', mission: 'Coordinate the release.', pinned: true } });
  const botId = f.member('a', 'v1').botId!;
  expect(f.member('a', 'v1')).toEqual({ botId, name: 'Chief', mission: 'Coordinate the release.', pinned: true });
  // The group stores placement and the id; the record holds the rest.
  expect(f.state.read().workspaceWindows![0]!.bots!.members.v1).toEqual({ botId, pinned: true });
  expect(f.state.read().bots).toEqual([expect.objectContaining({ subject: 'me', botId, name: 'Chief', mission: 'Coordinate the release.' })]);
  await f.change('a', { type: 'section.rank', rank: 'p' });
  expect(f.member('a', 'v1')).toMatchObject({ botId, name: 'Chief', mission: 'Coordinate the release.' });
  // A page that writes details without the id keeps the same bot.
  await f.change('a', { type: 'bot.update', viewId: 'v1', details: { name: 'Chief', label: 'Lead' } });
  expect(f.member('a', 'v1')).toEqual({ botId, name: 'Chief', label: 'Lead' });
});

it('keeps a bot\'s id when it moves to another group, and retires it when it leaves every group', async () => {
  const f = await fixture();
  await f.create('a', { v1: { name: 'Chief' } });
  await f.create('b', { v2: { name: 'Other' } });
  const botId = f.member('a', 'v1').botId!;
  const transfer = await f.service.transfer(f.me, 'a', { operationId: 'move', issuedAt: 1_000, baseRevision: f.service.inspect(f.me, 'a').window.revision,
    target: 'b', targetRevision: f.service.inspect(f.me, 'b').window.revision, viewId: 'v1' });
  expect(transfer.result.status).toBe('committed');
  expect(f.member('b', 'v1')).toMatchObject({ botId, name: 'Chief' });
  expect(f.state.read().bots!.find(bot => bot.botId === botId)!.retiredAt).toBeUndefined();
  f.tick();
  await f.change('b', { type: 'bots.remove' });
  expect(f.state.read().bots!.find(bot => bot.botId === botId)!.retiredAt).toBe(2_000);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm test:unit agent-relay-core src/window-bots.test.ts`
Expected: FAIL: `botId` is undefined and `state.read().bots` is undefined.

- [ ] **Step 3: Change `window-workspaces.ts`**

1. Import: `import { botIdsByView, mergeBots, readStoredBots, reconcileBots } from './bot-store.js';` (`readStoredBots` moved there in Task 3).
2. Inside `createWindowWorkspaces`, add helpers:
   ```ts
     /** A row as pages read it, merged with the bot records of the same snapshot. */
     const shown = (snapshot: HostedRelayState, row: SavedWorkspaceWindow) => mergeBots(row.subject, windowGroup(row), snapshot.bots ?? []);
     const describedIn = (snapshot: HostedRelayState, row: SavedWorkspaceWindow) => row.window ? shown(snapshot, row) : {};
     /** After a change to an account's rows: bring its records in line (bots design 2.1). */
     const reconcile = (draft: HostedRelayState, subject: string, before: ReadonlyMap<string, string>) =>
       reconcileBots(subject, draft.workspaceWindows ??= [], draft.bots ??= [], before, now());
   ```
3. Give `settle` and `settleAcross` the snapshot: add a first parameter `snapshot: HostedRelayState`, and replace `described(row)` with `describedIn(snapshot, row)`, and `groupsOf(rows())` with `Object.fromEntries(rows().map(row => [row.id, row.window ? shown(snapshot, row) : null]))`. Delete the module-level `described` and the `groupsOf` helper. Pass `draft` at every call site.
4. In `create`, `mutate`, `merge`, `split` and `transfer`, read `const before = botIdsByView(principal.subject, draft.workspaceWindows ?? []);` at the top of the `state.mutate` callback, apply every group operation to `shown(draft, row)` instead of `windowGroup(row)` (`applyGroupOperation`, `mergeGroups`, `splitGroup`, `transferBot`), and call `reconcile(draft, principal.subject, before)` as the last statement of each `apply` closure, after the `store(...)` calls. `uniqueBots` keeps reading stored rows with `windowGroup`: it compares sessions, not identity.
5. `list` and `inspect` return `shown(state.read(), row)` in place of `windowGroup(row)`.
6. `windowGroup` stays exported for validation, which checks rows as stored.

- [ ] **Step 4: Run the Relay suite and update stored-details expectations**

Run: `pnpm test:unit agent-relay-core`
Expected: the new tests pass. Tests in `window-workspaces.test.ts` and `gateway-push.test.ts` that compare `bots.members` exactly now also see `botId`; change those expectations to include `botId: expect.stringMatching(/^b_[0-9a-f]{32}$/)` (use `toMatchObject` where the test is about another field). Do not change what they test.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-relay-core/src/window-workspaces.ts packages/agent-relay-core/src/window-bots.test.ts packages/agent-relay-core/src/window-workspaces.test.ts packages/agent-relay-core/src/gateway-push.test.ts
git commit -m "feat(bots): Window groups keep placement, bot records keep identity"
```

### Task 5: assistant ids are bot ids

**Files:**
- Modify: `packages/agent-relay-core/src/assistants.ts:44-51`
- Test: `packages/agent-relay-core/src/assistants.test.ts`

Links and `list_assistants` name an assistant by its directory key, today `<windowId>/<viewId>`, which a move between groups changes
(O70). With records, the key is the `botId`.

- [ ] **Step 1: Write the failing test**

Append to the `describe` block of `assistants.test.ts` (its `group(...)` helper builds groups from `[viewId, hostId, session]`):

```ts
  it('names an assistant by its bot id, which a move between groups keeps', async () => {
    const botId = 'b_' + 'c'.repeat(32);
    const moved = [group('g2', [['v7', 'mac', 'chief'], ['v2', 'pc', 'tracker']], { rank: 'm', members: {
      v7: { botId, name: 'Chief', mode: 'coordinator' }, v2: { name: 'Tracker', mode: 'coordinator' } } })];
    const f = fixture({ groups: moved });
    expect(await f.broker.hostCall('pc', { action: 'list_assistants', owner: f.tracker })).toEqual({ assistants: [{ id: botId, name: 'Chief' }] });
  });
```

`fixture` does not take groups yet: add `groups?: WindowGroup[]` to its options and use `options.groups ?? [the current default]`.

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm test:unit agent-relay-core src/assistants.test.ts`
Expected: FAIL, the id is `g2/v7`.

- [ ] **Step 3: Use the bot id**

In `accountDirectory`, keep the naming key and take the id from the record:

```ts
    const viewKey = viewAssistantKey(group.window.id, view.id), details = group.bots?.members[view.id];
    const key = details?.botId ?? viewKey;
    return { key, name: names.get(viewKey) ?? view.binding.title, …the rest unchanged };
```

- [ ] **Step 4: Run the Relay suite**

Run: `pnpm test:unit agent-relay-core`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-relay-core/src/assistants.ts packages/agent-relay-core/src/assistants.test.ts
git commit -m "feat(bots): assistants are named by their bot id"
```

### Task 6: the mission in a bot's details

**Files:**
- Create: `packages/agent-remote-lab/src/conversation/assistant/MissionEditor.tsx`
- Modify: `packages/agent-remote-lab/src/conversation/assistant/AssistantDetails.tsx` (a `mission` section)
- Modify: `packages/agent-remote-lab/src/conversation/ConversationDetails.tsx`, `ConversationSurface.tsx` (pass it from `processAssistant`)
- Modify: `packages/agent-client/src/presentation/messages/areas/conversation.en.ts`, `conversation.zh.ts`
- Test: `packages/agent-remote-lab/src/conversation/assistant/AssistantDetails.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to `AssistantDetails.test.tsx` (it already has `open`, `botGroup`, `until`, `visibleButton`):

```ts
it("writes an assistant's mission in its details, keeping its other details, and clears it", async () => {
  const group = botGroup('A'); group.bots!.members.A1 = { name: 'A1', label: 'Reviewer' };
  const app = await open('bot-details-mission', [group], '/?mode=bot&section=A&bot=A1');
  try {
    const details = () => app.container.querySelector<HTMLElement>('.lab-assistant-details')!;
    const field = () => details().querySelector<HTMLTextAreaElement>('textarea[aria-label="Mission"]')!;
    await until(() => expect(field()).not.toBeNull());
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field(), 'Review every change before release.');
      field().dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => visibleButton(details(), 'Save mission').click());
    await until(() => expect(app.workspace().readGroup('A')?.bots?.members.A1).toEqual({ name: 'A1', label: 'Reviewer', mission: 'Review every change before release.' }));
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field(), '  ');
      field().dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => visibleButton(details(), 'Save mission').click());
    await until(() => expect(app.workspace().readGroup('A')?.bots?.members.A1).toEqual({ name: 'A1', label: 'Reviewer' }));
  } finally { await app.close(); }
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm test:unit agent-remote-lab src/conversation/assistant/AssistantDetails.test.tsx`
Expected: FAIL, no `textarea[aria-label="Mission"]`.

- [ ] **Step 3: Add the strings**

`conversation.en.ts`, after `'details.tasks'`:

```ts
  'details.mission': 'Mission',
  'details.missionHint': 'What this assistant is for and how it works. It reads this before every conversation, and other assistants see it.',
  'details.missionSave': 'Save mission',
```

`conversation.zh.ts`, after `'details.tasks'`:

```ts
  'details.mission': '使命',
  'details.missionHint': '这个助手是做什么的、怎么工作。它在每次对话前读这段话，其他助手也能看到。',
  'details.missionSave': '保存使命',
```

- [ ] **Step 4: Write `MissionEditor.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { BOT_MISSION_LIMIT } from '@orchardworks/agent-remote-protocol';
import { useTranslate } from '@orchardworks/agent-client-web/react';

/** A bot's mission as the person writes it; saving an empty text clears it. */
export interface MissionChoice { readonly text: string; save(text: string): void }

export function MissionEditor({ mission }: { mission: MissionChoice }) {
  const t = useTranslate();
  const [draft, setDraft] = useState(mission.text);
  useEffect(() => { setDraft(mission.text); }, [mission.text]);
  return <div className="lab-assistant-process">
    <textarea aria-label={t('details.mission')} value={draft} maxLength={BOT_MISSION_LIMIT} rows={4} onChange={event => setDraft(event.target.value)} />
    <p className="lab-assistant-hint">{t('details.missionHint')}</p>
    <button type="button" className="lab-assistant-action" disabled={draft.trim() === mission.text} onClick={() => mission.save(draft.trim())}>{t('details.missionSave')}</button>
  </div>;
}
```

- [ ] **Step 5: Show it in the details**

1. `AssistantDetails.tsx`: import `MissionEditor` and `type MissionChoice`; add `readonly mission?: MissionChoice;` to `AssistantRef` with the comment `/** The mission, for an assistant whose bot details the reader may change. */`; render before the `where` section:
   ```tsx
    {assistant.mission ? section('mission', t('details.mission'), <MissionEditor mission={assistant.mission} />) : null}
   ```
2. `ConversationSurface.tsx`, next to `const mode = assistantModeChoice(processAssistant);`:
   ```ts
  const mission = processAssistant ? { text: processAssistant.details?.mission ?? '', save: (text: string) => {
    const { mission: _previous, ...rest } = processAssistant.details ?? {};
    processAssistant.update(text ? { ...rest, mission: text } : rest);
  } } : undefined;
   ```
   and pass `{...(mission ? { mission } : {})}` to `ConversationDetails`.
3. `ConversationDetails.tsx`: accept `mission?: MissionChoice` and add `...(mission ? { mission } : {})` to `assistantRef`.

- [ ] **Step 6: Run the lab suite**

Run: `pnpm test:unit agent-remote-lab`
Expected: all pass; the section-order test is unaffected because its `reference()` has no mission.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-remote-lab/src/conversation packages/agent-client/src/presentation/messages/areas/conversation.en.ts packages/agent-client/src/presentation/messages/areas/conversation.zh.ts
git commit -m "feat(bots): write a bot's mission in its details"
```

### Task 7: verify

- [ ] **Step 1:** `pnpm arch:check` (the new `bot-store.ts` is in `packages/agent-relay-core/src/**`), then `pnpm verify:changed`. Expected: both pass.
- [ ] **Step 2:** `pnpm local up` from this worktree, then in a headless page (the `prepare-arc-local` skill): open a bot's details, write a mission and save it, rename the bot, move it to another group, reload; the mission and name are unchanged and `pnpm --silent local api v1/windows` shows the same `botId` in both places.
- [ ] **Step 3:** Restart the instance (`pnpm local up` again) and read `v1/windows`: the ids are the same.
- [ ] **Step 4:** Commit nothing new unless a fix was needed; note the result in the parent plan's step 1.
