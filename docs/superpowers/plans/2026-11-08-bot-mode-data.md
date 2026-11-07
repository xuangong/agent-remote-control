# Bot mode milestone 1 (data) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store a Bot appearance and a Window appearance for every Window group on the Relay, with the edits, cross-group operations and rules of [the design](../specs/2026-11-08-bot-view-design.md), without changing what any current page or command line sees.

**Architecture:** A pure protocol module (`window-groups.ts`) defines the group (the existing Window document plus optional `bots` and `presentation`), its edits and the cross-group operations, and enforces rule 1 (a bot keeps its conversation). The Relay's Window service stores `bots` and `presentation` beside each Window document, answers with them next to the Window, keeps groups without a Window appearance out of the `windows` list older clients read, enforces rule 5 (a session is at most one bot) across a user's groups, and adds `merge`, `split` and `transfer` routes. The web client reads and sends all of it. The browser store and every visible change are milestone 2.

**Tech Stack:** TypeScript, TypeBox schemas (`@sinclair/typebox`), Vitest, the hosted Relay service (`@orchardworks/agent-remote-hosted`, Immer-backed `RelayState`), `@orchardworks/agent-remote-web`.

**Working directory:** `/Volumes/Projects/agent-remote-control/.worktrees/bot-view` (branch `docs/bot-view-design`). Hosted and web tests import the protocol package from its built `dist`, so rebuild the protocol package before running them (the commands below do).

---

## File structure

| File | Responsibility |
|---|---|
| Create `packages/agent-remote-protocol/src/window-groups.ts` | Group schemas, edits, requests; `isBotView`, `isWindowGroup`, `applyGroupOperation` (rule 1), `duplicateBot` (rule 5), `mergeGroups`, `splitGroup`, `transferBot` |
| Create `packages/agent-remote-protocol/src/window-groups.test.ts` | Unit tests of the module |
| Modify `packages/agent-remote-protocol/src/index.ts` | Export the module |
| Modify `packages/agent-remote-hosted/src/window-workspaces.ts` | Store and validate `bots`/`presentation`, group responses, group edits, rule 5, `merge`/`split`/`transfer` |
| Modify `packages/agent-remote-hosted/src/window-routes.ts` | `POST /v1/windows/:id/{merge,split,transfer}` |
| Modify `packages/agent-remote-hosted/src/window-workspaces.test.ts` | Relay tests |
| Modify `packages/agent-remote-web/src/client/window-client.ts` | `listGroups`, `createGroup`, group mutations, `merge`/`split`/`transfer`, snapshot validation |
| Modify `packages/agent-remote-web/src/client/window-client.test.ts` | Client tests |
| Create `docs/current/agent-remote/window-groups.md`; modify `docs/current/agent-remote/README.md` | Current-state documentation |
| Modify `docs/superpowers/specs/2026-11-08-bot-view-design.md` | Move the browser store to milestone 2; record `bot.update { viewId, details }` |

---

### Task 1: Align the design with this plan

**Files:**
- Modify: `docs/superpowers/specs/2026-11-08-bot-view-design.md`

- [ ] **Step 1: Edit the milestones and the edit list**

Replace the milestone 1 and 2 lines:

```markdown
1. **Data.** Protocol types and `applyGroupOperation`; Relay storage, responses, edits, `merge`, `split`, `transfer`, rules 1 and 5; web client. No visible change. Deploy the Worker.
2. **Bot mode.** The browser store keeping the Bot appearance beside its Window (also in the local-first Lab mode); the mode switch (Window mode by default); roster of sections and bots with status; the fallback group; a bot's page in Content only; Show as section on a Window; New section; each mode returning to what it had open (rule 6); notifications following the mode; compact layout.
```

In the **Edits** paragraph, replace `` `bot.update { viewId, label?, picture?, pinned?, hidden?, rank? }` `` with `` `bot.update { viewId, details }` (replaces that bot's label, picture, pin, hidden flag and rank together) ``, and replace the sentence beginning "The browser's `WindowWorkspaceStore` keeps the bot appearance" with: "In milestone 2 the browser's `WindowWorkspaceStore` keeps the Bot appearance next to the Window and applies these edits optimistically like layout edits; the local-first Lab mode stores it beside its local Window."

- [ ] **Step 2: Lint and commit**

Run: `pnpm --silent lint:docs`
Expected: exit 0

```bash
git add docs/superpowers/specs/2026-11-08-bot-view-design.md
git commit -m "docs(spec): move the browser store to Bot mode milestone 2"
```

---

### Task 2: Group schemas and validation (protocol)

**Files:**
- Create: `packages/agent-remote-protocol/src/window-groups.ts`
- Create: `packages/agent-remote-protocol/src/window-groups.test.ts`
- Modify: `packages/agent-remote-protocol/src/index.ts:59`

- [ ] **Step 1: Write the failing tests**

Create `packages/agent-remote-protocol/src/window-groups.test.ts`:

```ts
import { expect, it } from 'vitest';
import type { WorkspaceWindow } from './window-workspace.js';
import { createWindowView } from './window-workspace-operations.js';
import { WindowGroupError, isBotView, isWindowGroup, isWindowGroupCreateRequest, isWindowGroupMutation, type WindowGroup } from './window-groups.js';

const session = (nativeSessionId: string, title = nativeSessionId) => ({ hostId: 'mac', providerId: 'claude', nativeSessionId, title });
function windowOf(id: string, ...views: WorkspaceWindow['views']): WorkspaceWindow {
  const primary = views.find(view => view.placement === 'primary')?.id ?? null;
  return { schemaVersion: 3, id, title: id, revision: 0, selectedPrimaryViewId: primary, selectedViewId: views[0]?.id ?? null, views };
}
const section = (window: WorkspaceWindow, rank = 'm'): WindowGroup => ({ window, bots: { rank, members: {} } });
/** The code of a group rule's refusal, or the message of any other error. */
function refusal(run: () => unknown): string {
  try { run(); } catch (error) { return error instanceof WindowGroupError ? error.code : `other:${(error as Error).message}`; }
  return 'none';
}

it('counts only ordinary views with a current session as bots', () => {
  expect(isBotView(createWindowView('main', session('a'), 'primary'))).toBe(true);
  expect(isBotView(createWindowView('dock', session('b')))).toBe(true);
  expect(isBotView(createWindowView('empty'))).toBe(false);
  expect(isBotView(createWindowView('past', { ...session('c'), sessionIntent: 'history' }))).toBe(false);
  expect(isBotView({ ...createWindowView('side', session('d'), 'attached'), attachedTo: 'main' })).toBe(false);
  expect(isBotView({ ...createWindowView('ask', session('e'), 'float'), bindingPolicy: 'managed' })).toBe(false);
  expect(isBotView({ ...createWindowView('team', session('f')), feature: { kind: 'team', id: 'release' } })).toBe(false);
});

it('requires a Window or a section, and bot details only for bots', () => {
  const window = windowOf('w', createWindowView('main', session('a'), 'primary'), createWindowView('empty'));
  expect(isWindowGroup({ window })).toBe(true);
  expect(isWindowGroup({ window, presentation: { window: false } })).toBe(false);
  expect(isWindowGroup({ ...section(window), presentation: { window: false } })).toBe(true);
  expect(isWindowGroup({ window, bots: { rank: 'm', members: { main: { label: 'Release notes' } } } })).toBe(true);
  expect(isWindowGroup({ window, bots: { rank: 'm', members: { empty: { label: 'Nobody' } } } })).toBe(false);
  expect(isWindowGroup({ window, bots: { rank: 'M', members: {} } })).toBe(false);
  expect(isWindowGroup({ window, bots: { rank: 'm', members: { main: { picture: { shape: 'star', color: '#ff0000' } } } } })).toBe(false);
  expect(isWindowGroup({ window, bots: { rank: 'm', members: { main: { picture: { shape: 'circle', color: 'red' } } } } })).toBe(false);
});

it('accepts plain Window requests as group requests and checks group creation', () => {
  const window = windowOf('w', createWindowView('main', session('a'), 'primary'));
  expect(isWindowGroupMutation({ operationId: 'op', issuedAt: 1, baseRevision: 0, operation: { type: 'rename', title: 'Renamed' } })).toBe(true);
  expect(isWindowGroupMutation({ operationId: 'op', issuedAt: 1, baseRevision: 0, operation: { type: 'bots.add', rank: 'm' } })).toBe(true);
  expect(isWindowGroupMutation({ operationId: 'op', issuedAt: 1, baseRevision: 0, operation: { type: 'bots.add', rank: 'm', extra: 1 } })).toBe(false);
  expect(isWindowGroupCreateRequest({ operationId: 'op', issuedAt: 1, window })).toBe(true);
  expect(isWindowGroupCreateRequest({ operationId: 'op', issuedAt: 1, window, presentation: { window: false } })).toBe(false);
  expect(isWindowGroupCreateRequest({ operationId: 'op', issuedAt: 1, window, bots: { rank: 'm', members: {} }, presentation: { window: false } })).toBe(true);
  expect(refusal(() => { throw new WindowGroupError('bot_view', 'x'); })).toBe('bot_view');
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @orchardworks/agent-remote-protocol exec vitest run src/window-groups.test.ts`
Expected: FAIL, "Failed to resolve import "./window-groups.js""

- [ ] **Step 3: Write the schemas, guards and error**

Create `packages/agent-remote-protocol/src/window-groups.ts`:

```ts
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { WINDOW_VIEW_LIMIT, WindowEdit, WorkspaceWindow, isWorkspaceWindow, type WindowSessionBinding, type WindowView } from './window-workspace.js';
import { WindowLayoutError } from './window-workspace-operations.js';

const strict = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_.:-]+$' });
const counter = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
/** A fractional index: ranks compare as strings, so a new one always fits between two others. */
const rank = Type.String({ minLength: 1, maxLength: 64, pattern: '^[0-9a-z]+$' });

/** What Bot mode shows for one bot beyond its session's title. */
export const WindowBotDetails = Type.Object({
  label: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  picture: Type.Optional(Type.Object({
    shape: Type.Union([Type.Literal('circle'), Type.Literal('rounded'), Type.Literal('hexagon')]),
    color: Type.String({ pattern: '^#[0-9a-f]{6}$' }),
  }, strict)),
  pinned: Type.Optional(Type.Literal(true)),
  hidden: Type.Optional(Type.Literal(true)),
  rank: Type.Optional(rank),
}, strict);
export type WindowBotDetails = Static<typeof WindowBotDetails>;
/** A group's section in Bot mode. Bots without details use their defaults. */
export const WindowBots = Type.Object({
  rank,
  members: Type.Record(Type.String({ pattern: '^[A-Za-z0-9_.:-]{1,128}$' }), WindowBotDetails, { maxProperties: WINDOW_VIEW_LIMIT, additionalProperties: false }),
}, strict);
export type WindowBots = Static<typeof WindowBots>;
/** Present only for a group that is not shown as a Window. */
export const WindowPresentation = Type.Object({ window: Type.Literal(false) }, strict);
export type WindowPresentation = Static<typeof WindowPresentation>;
/** One grouping of sessions: a Window document and the appearances it is managed in. */
export const WindowGroup = Type.Object({ window: WorkspaceWindow, bots: Type.Optional(WindowBots), presentation: Type.Optional(WindowPresentation) }, strict);
export type WindowGroup = Static<typeof WindowGroup>;

const GroupEdit = Type.Union([
  Type.Object({ type: Type.Literal('bots.add'), rank }, strict),
  Type.Object({ type: Type.Literal('bots.remove') }, strict),
  Type.Object({ type: Type.Literal('window.add') }, strict),
  Type.Object({ type: Type.Literal('window.remove') }, strict),
  /** Replaces the bot's details. */
  Type.Object({ type: Type.Literal('bot.update'), viewId: id, details: WindowBotDetails }, strict),
  Type.Object({ type: Type.Literal('section.rank'), rank }, strict),
]);
export const WindowGroupEdit = Type.Union([...WindowEdit.anyOf, ...GroupEdit.anyOf]);
export type WindowGroupEdit = Static<typeof WindowGroupEdit>;
export const WindowGroupOperation = Type.Union([WindowGroupEdit,
  Type.Object({ type: Type.Literal('batch'), operations: Type.Array(WindowGroupEdit, { minItems: 1, maxItems: 128 }) }, strict)]);
export type WindowGroupOperation = Static<typeof WindowGroupOperation>;
export const WindowGroupMutation = Type.Object({ operationId: id, issuedAt: counter, baseRevision: counter, operation: WindowGroupOperation }, strict);
export type WindowGroupMutation = Static<typeof WindowGroupMutation>;
export const WindowGroupCreateRequest = Type.Object({ operationId: id, issuedAt: counter, window: WorkspaceWindow,
  bots: Type.Optional(WindowBots), presentation: Type.Optional(WindowPresentation) }, strict);
export type WindowGroupCreateRequest = Static<typeof WindowGroupCreateRequest>;
/** Sent to the target group: the source group's views join it and the source is deleted. */
export const WindowMergeRequest = Type.Object({ operationId: id, issuedAt: counter, baseRevision: counter, source: id, sourceRevision: counter }, strict);
export type WindowMergeRequest = Static<typeof WindowMergeRequest>;
/** Sent to a group that is both a Window and a section: the section moves to a new group. */
export const WindowSplitRequest = Type.Object({ operationId: id, issuedAt: counter, baseRevision: counter, newId: id }, strict);
export type WindowSplitRequest = Static<typeof WindowSplitRequest>;
/** Sent to the source group: one bot, its attached views and its details move to the target section. */
export const WindowTransferRequest = Type.Object({ operationId: id, issuedAt: counter, baseRevision: counter, viewId: id, target: id, targetRevision: counter }, strict);
export type WindowTransferRequest = Static<typeof WindowTransferRequest>;

/** A refusal by a group rule; its code reaches clients unlike other layout errors. */
export class WindowGroupError extends WindowLayoutError {
  constructor(code: string, message: string) { super(code, message); this.name = 'WindowGroupError'; }
}

/** A bot is an ordinary view showing a current session: not attached, not history, not an Ask, Team or TPM view. */
export function isBotView(view: WindowView): boolean {
  return view.placement !== 'attached' && view.binding !== undefined && view.binding.sessionIntent === undefined
    && view.feature === undefined && view.bindingPolicy !== 'managed';
}
export const windowSessionIdentity = (binding: Pick<WindowSessionBinding, 'hostId' | 'providerId' | 'nativeSessionId'>) =>
  JSON.stringify([binding.hostId, binding.providerId, binding.nativeSessionId]);
/** The views Bot mode shows as bots: none for a group that is not a section. */
export function groupBotViews(group: WindowGroup): WindowView[] {
  return group.bots ? group.window.views.filter(isBotView) : [];
}
export const hasWindowAppearance = (group: WindowGroup): boolean => group.presentation?.window !== false;

export function isWindowGroup(value: unknown): value is WindowGroup {
  if (!Value.Check(WindowGroup, value) || !isWorkspaceWindow(value.window)) return false;
  if (!hasWindowAppearance(value) && !value.bots) return false;
  const bots = new Set(groupBotViews(value).map(view => view.id));
  return Object.keys(value.bots?.members ?? {}).every(viewId => bots.has(viewId));
}
export const isWindowGroupMutation = (value: unknown): value is WindowGroupMutation => Value.Check(WindowGroupMutation, value);
export const isWindowGroupCreateRequest = (value: unknown): value is WindowGroupCreateRequest => Value.Check(WindowGroupCreateRequest, value)
  && isWindowGroup({ window: value.window, ...(value.bots ? { bots: value.bots } : {}), ...(value.presentation ? { presentation: value.presentation } : {}) });
export const isWindowMergeRequest = (value: unknown): value is WindowMergeRequest => Value.Check(WindowMergeRequest, value);
export const isWindowSplitRequest = (value: unknown): value is WindowSplitRequest => Value.Check(WindowSplitRequest, value);
export const isWindowTransferRequest = (value: unknown): value is WindowTransferRequest => Value.Check(WindowTransferRequest, value);
```

Add the export to `packages/agent-remote-protocol/src/index.ts`, after `export * from './window-workspace-operations.js';`:

```ts
export * from './window-groups.js';
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter @orchardworks/agent-remote-protocol exec vitest run src/window-groups.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Type-check and commit**

Run: `pnpm --filter @orchardworks/agent-remote-protocol exec tsc --noEmit`
Expected: no output

```bash
git add packages/agent-remote-protocol/src/window-groups.ts packages/agent-remote-protocol/src/window-groups.test.ts packages/agent-remote-protocol/src/index.ts
git commit -m "feat(protocol): describe Window groups with a Bot and a Window appearance"
```

---

### Task 3: Group edits and rule 1 (protocol)

**Files:**
- Modify: `packages/agent-remote-protocol/src/window-groups.ts`
- Modify: `packages/agent-remote-protocol/src/window-groups.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `window-groups.test.ts` (and add `applyGroupOperation` to the import from `./window-groups.js`):

```ts
it('adds and removes appearances, always keeping one', () => {
  const group: WindowGroup = { window: windowOf('w', createWindowView('main', session('a'), 'primary')) };
  const both = applyGroupOperation(group, { type: 'bots.add', rank: 'm' });
  expect(both.bots).toEqual({ rank: 'm', members: {} });
  expect(both.window.revision).toBe(1);
  const sectionOnly = applyGroupOperation(both, { type: 'window.remove' });
  expect(sectionOnly.presentation).toEqual({ window: false });
  expect(refusal(() => applyGroupOperation(sectionOnly, { type: 'bots.remove' }))).toBe('last_appearance');
  expect(refusal(() => applyGroupOperation(group, { type: 'window.remove' }))).toBe('last_appearance');
  expect(refusal(() => applyGroupOperation(both, { type: 'bots.add', rank: 'n' }))).toBe('section_exists');
  expect(applyGroupOperation(sectionOnly, { type: 'window.add' }).presentation).toBeUndefined();
  expect(applyGroupOperation(both, { type: 'section.rank', rank: 'n' }).bots?.rank).toBe('n');
});

it('keeps details only for views that are still bots', () => {
  const window = windowOf('w', createWindowView('main', session('a'), 'primary'), createWindowView('dock', session('b')));
  let group = applyGroupOperation(section(window), { type: 'batch', operations: [
    { type: 'bot.update', viewId: 'main', details: { label: 'Writes the release notes', picture: { shape: 'hexagon', color: '#2f6fed' }, pinned: true } },
    { type: 'bot.update', viewId: 'dock', details: { label: 'Reviews' } },
  ] });
  expect(group.window.revision).toBe(1);
  expect(group.bots?.members.main).toEqual({ label: 'Writes the release notes', picture: { shape: 'hexagon', color: '#2f6fed' }, pinned: true });
  group = applyGroupOperation(group, { type: 'view.close', viewId: 'dock' });
  expect(Object.keys(group.bots?.members ?? {})).toEqual(['main']);
  expect(refusal(() => applyGroupOperation(group, { type: 'bot.update', viewId: 'dock', details: {} }))).toBe('bot_not_found');
});

it('lets a bot change its title but not its conversation', () => {
  const group = section(windowOf('w', createWindowView('main', session('a'), 'primary')));
  expect(applyGroupOperation(group, { type: 'view.bind', viewId: 'main', binding: session('a', 'Renamed') }).window.views[0]?.binding?.title).toBe('Renamed');
  expect(refusal(() => applyGroupOperation(group, { type: 'view.bind', viewId: 'main', binding: session('b') }))).toBe('bot_view');
  expect(refusal(() => applyGroupOperation(group, { type: 'view.bind', viewId: 'main', binding: { ...session('a'), sessionIntent: 'history' } }))).toBe('bot_view');
  // Without a section the same view is an ordinary Window view and may show another session.
  expect(applyGroupOperation({ window: group.window }, { type: 'view.bind', viewId: 'main', binding: session('b') }).window.views[0]?.binding?.nativeSessionId).toBe('b');
  // Succession rebinds through the layout, which stays allowed.
  const { schemaVersion: _version, id: _id, revision: _revision, ...layout } = group.window;
  const succeeded = applyGroupOperation(group, { type: 'layout.apply', layout: { ...layout, views: [{ ...layout.views[0]!, binding: session('c') }] } });
  expect(succeeded.window.views[0]?.binding?.nativeSessionId).toBe('c');
});

it('refuses an invalid group or operation and leaves a refused batch without effect', () => {
  const group = section(windowOf('w', createWindowView('main', session('a'), 'primary')));
  expect(refusal(() => applyGroupOperation({ window: group.window, presentation: { window: false } }, { type: 'window.add' }))).toBe('invalid_window_operation');
  const before = JSON.stringify(group);
  expect(refusal(() => applyGroupOperation(group, { type: 'batch', operations: [{ type: 'rename', title: 'Changed' }, { type: 'bots.add', rank: 'n' }] }))).toBe('section_exists');
  expect(JSON.stringify(group)).toBe(before);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @orchardworks/agent-remote-protocol exec vitest run src/window-groups.test.ts`
Expected: FAIL, "applyGroupOperation is not a function" (or a missing export error)

- [ ] **Step 3: Implement `applyGroupOperation`**

In `window-groups.ts`, change the operations import to:

```ts
import { WindowLayoutError, applyWindowOperation } from './window-workspace-operations.js';
```

and append:

```ts
function fail(code: string, message: string): never { throw new WindowGroupError(code, message); }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Drops the details of views that are no longer bots, such as a closed view or one now showing history. */
function pruned(group: WindowGroup): WindowGroup {
  if (!group.bots) return group;
  const bots = new Set(groupBotViews(group).map(view => view.id));
  return { ...group, bots: { ...group.bots, members: Object.fromEntries(Object.entries(group.bots.members).filter(([viewId]) => bots.has(viewId))) } };
}

function edit(group: WindowGroup, item: WindowGroupEdit): WindowGroup {
  switch (item.type) {
    case 'bots.add':
      if (group.bots) fail('section_exists', 'This group is already a section.');
      return { ...group, bots: { rank: item.rank, members: {} } };
    case 'bots.remove': {
      if (!group.bots) fail('section_missing', 'This group is not a section.');
      if (!hasWindowAppearance(group)) fail('last_appearance', 'A group stays a Window or a section; add the other first.');
      const { bots: _bots, ...rest } = group;
      return rest;
    }
    case 'window.add': {
      if (hasWindowAppearance(group)) fail('window_exists', 'This group is already a Window.');
      const { presentation: _presentation, ...rest } = group;
      return rest;
    }
    case 'window.remove':
      if (!hasWindowAppearance(group)) fail('window_missing', 'This group is not a Window.');
      if (!group.bots) fail('last_appearance', 'A group stays a Window or a section; add the other first.');
      return { ...group, presentation: { window: false } };
    case 'bot.update': {
      const view = group.window.views.find(candidate => candidate.id === item.viewId);
      if (!group.bots || !view || !isBotView(view)) fail('bot_not_found', 'This bot no longer exists.');
      return { ...group, bots: { ...group.bots, members: { ...group.bots.members, [item.viewId]: clone(item.details) } } };
    }
    case 'section.rank':
      if (!group.bots) fail('section_missing', 'This group is not a section.');
      return { ...group, bots: { ...group.bots, rank: item.rank } };
    default: {
      if (item.type === 'view.bind' && group.bots) {
        const view = group.window.views.find(candidate => candidate.id === item.viewId);
        // Rule 1: a bot keeps its conversation; the title and role details of that session may change.
        if (view && isBotView(view) && (!isBotView({ ...view, binding: item.binding })
          || windowSessionIdentity(view.binding!) !== windowSessionIdentity(item.binding))) {
          fail('bot_view', 'A bot keeps its conversation. Open the other session beside it.');
        }
      }
      return { ...group, window: applyWindowOperation(group.window, item) };
    }
  }
}

/** Applies one explicit command atomically and advances the Window revision once, as applyWindowOperation does. */
export function applyGroupOperation(source: WindowGroup, operation: WindowGroupOperation): WindowGroup {
  if (!isWindowGroup(source) || !Value.Check(WindowGroupOperation, operation)) fail('invalid_window_operation', 'The group or operation is invalid.');
  let result = clone(source);
  for (const item of operation.type === 'batch' ? operation.operations : [operation]) result = edit(result, item);
  result = pruned({ ...result, window: { ...result.window, revision: source.window.revision + 1 } });
  if (!isWindowGroup(result)) fail('invalid_window_group', 'The resulting group is invalid.');
  return result;
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter @orchardworks/agent-remote-protocol exec vitest run src/window-groups.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Type-check and commit**

Run: `pnpm --filter @orchardworks/agent-remote-protocol exec tsc --noEmit`
Expected: no output

```bash
git add packages/agent-remote-protocol/src/window-groups.ts packages/agent-remote-protocol/src/window-groups.test.ts
git commit -m "feat(protocol): edit Window groups and keep a bot on its conversation"
```

---

### Task 4: Rule 5 and the cross-group operations (protocol)

**Files:**
- Modify: `packages/agent-remote-protocol/src/window-groups.ts`
- Modify: `packages/agent-remote-protocol/src/window-groups.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `window-groups.test.ts` (and add `duplicateBot, mergeGroups, splitGroup, transferBot` to the import from `./window-groups.js`):

```ts
it('finds a session that is a bot in two places', () => {
  const first = section(windowOf('one', createWindowView('main', session('a'), 'primary')));
  const second = section(windowOf('two', createWindowView('main', session('a'), 'primary')));
  expect(duplicateBot([first, second])?.group.window.id).toBe('one');
  expect(duplicateBot([first, { window: second.window }])).toBeUndefined();
  const twice = section(windowOf('three', createWindowView('main', session('b'), 'primary'), createWindowView('dock', session('b'))));
  expect(duplicateBot([twice])?.session.nativeSessionId).toBe('b');
});

it('merges a Window into a section, keeping both appearances and the section identity', () => {
  const target: WindowGroup = { window: windowOf('section', createWindowView('writer', session('a'), 'primary')),
    bots: { rank: 'm', members: { writer: { label: 'Writer' } } }, presentation: { window: false } };
  const source: WindowGroup = { window: windowOf('window', createWindowView('main', session('b'), 'primary'),
    { ...createWindowView('side', session('c'), 'attached'), attachedTo: 'main' }) };
  const merged = mergeGroups(target, source);
  expect(merged.window.id).toBe('section');
  expect(merged.window.views.map(view => view.id)).toEqual(['writer', 'main', 'side']);
  expect(merged.window.revision).toBe(1);
  expect(merged.presentation).toBeUndefined();
  expect(merged.bots?.members).toEqual({ writer: { label: 'Writer' } });
  expect(refusal(() => mergeGroups(target, { window: windowOf('clash', createWindowView('writer', session('d'), 'primary')) })))
    .toBe('other:This view identity already exists.');
});

it('separates a linked group into a Window and a section', () => {
  const linked = applyGroupOperation(section(windowOf('w', createWindowView('main', session('a'), 'primary'))),
    { type: 'bot.update', viewId: 'main', details: { label: 'Writer' } });
  const { kept, created } = splitGroup(linked, 'w-section');
  expect(kept).toEqual({ window: { ...linked.window, revision: 2 } });
  expect(created).toEqual({ window: { ...linked.window, id: 'w-section', revision: 0 }, bots: linked.bots, presentation: { window: false } });
  expect(refusal(() => splitGroup(kept, 'again'))).toBe('not_linked');
  expect(refusal(() => splitGroup(linked, 'w'))).toBe('window_exists');
});

it('moves a bot with its attached views to another section', () => {
  const source = applyGroupOperation(section(windowOf('one', createWindowView('main', session('a'), 'primary'), createWindowView('dock', session('b')),
    { ...createWindowView('side', session('c'), 'attached'), attachedTo: 'dock' })), { type: 'bot.update', viewId: 'dock', details: { label: 'Reviewer' } });
  const target = section(windowOf('two', createWindowView('lead', session('d'), 'primary')));
  const moved = transferBot(source, target, 'dock');
  expect(moved.source.window.views.map(view => view.id)).toEqual(['main']);
  expect(moved.source.bots?.members).toEqual({});
  expect(moved.target.window.views.map(view => view.id)).toEqual(['lead', 'dock', 'side']);
  expect(moved.target.bots?.members).toEqual({ dock: { label: 'Reviewer' } });
  expect(refusal(() => transferBot(source, { window: target.window }, 'dock'))).toBe('section_missing');
  expect(refusal(() => transferBot(source, target, 'side'))).toBe('bot_not_found');
  expect(refusal(() => transferBot(source, source, 'dock'))).toBe('same_group');
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @orchardworks/agent-remote-protocol exec vitest run src/window-groups.test.ts`
Expected: FAIL, missing exports `duplicateBot`, `mergeGroups`, `splitGroup`, `transferBot`

- [ ] **Step 3: Implement them**

Append to `window-groups.ts`:

```ts
/** Rule 5: a session is at most one bot across a user's groups. Names the first group that already has a session claimed again. */
export function duplicateBot(groups: readonly WindowGroup[]): { session: WindowSessionBinding; group: WindowGroup } | undefined {
  const owners = new Map<string, WindowGroup>();
  for (const group of groups) for (const view of groupBotViews(group)) {
    const key = windowSessionIdentity(view.binding!);
    const owner = owners.get(key);
    if (owner) return { session: view.binding!, group: owner };
    owners.set(key, group);
  }
  return undefined;
}

/** A view and the views attached to it or closing with it. */
function family(window: WorkspaceWindow, root: string): Set<string> {
  const ids = new Set([root]);
  for (let changed = true; changed;) {
    changed = false;
    for (const view of window.views) if (!ids.has(view.id) && (view.attachedTo && ids.has(view.attachedTo) || view.closeWith && ids.has(view.closeWith))) {
      ids.add(view.id); changed = true;
    }
  }
  return ids;
}
/** Adds views in order, as one Window edit; their attached views follow their sources. */
function appendViews(window: WorkspaceWindow, views: WindowView[]): WorkspaceWindow {
  if (!views.length) return { ...window, revision: window.revision + 1 };
  return applyWindowOperation(window, { type: 'batch', operations: views.map(view => ({ type: 'view.create' as const, view })) });
}
function checked(group: WindowGroup): WindowGroup {
  const result = pruned(group);
  if (!isWindowGroup(result)) fail('invalid_window_group', 'The resulting group is invalid.');
  return result;
}

/** The target keeps its identity, title and selection, gains the source's views and bot details, and has every appearance either had. */
export function mergeGroups(targetGroup: WindowGroup, sourceGroup: WindowGroup): WindowGroup {
  const target = clone(targetGroup), source = clone(sourceGroup);
  const window = appendViews(target.window, source.window.views);
  const rankOf = target.bots?.rank ?? source.bots?.rank;
  const bots = rankOf === undefined ? undefined : { rank: rankOf, members: { ...source.bots?.members, ...target.bots?.members } };
  const shown = hasWindowAppearance(target) || hasWindowAppearance(source);
  return checked({ window, ...(bots ? { bots } : {}), ...(shown ? {} : { presentation: { window: false as const } }) });
}

/** The group keeps the Window; a new group with the same views becomes the section. */
export function splitGroup(group: WindowGroup, newId: string): { kept: WindowGroup; created: WindowGroup } {
  if (!group.bots || !hasWindowAppearance(group)) fail('not_linked', 'Only a group that is both a Window and a section can be separated.');
  if (newId === group.window.id) fail('window_exists', 'Window identity is already used.');
  const kept = checked({ window: { ...clone(group.window), revision: group.window.revision + 1 } });
  const created = checked({ window: { ...clone(group.window), id: newId, revision: 0 }, bots: clone(group.bots), presentation: { window: false } });
  return { kept, created };
}

/** Moves a bot, its attached views and its details to another section. */
export function transferBot(sourceGroup: WindowGroup, targetGroup: WindowGroup, viewId: string): { source: WindowGroup; target: WindowGroup } {
  const source = clone(sourceGroup), target = clone(targetGroup);
  const view = source.window.views.find(candidate => candidate.id === viewId);
  if (!source.bots || !view || !isBotView(view)) fail('bot_not_found', 'This bot no longer exists.');
  if (!target.bots) fail('section_missing', 'A bot moves only to a section.');
  if (source.window.id === target.window.id) fail('same_group', 'The bot is already in this section.');
  const ids = family(source.window, viewId);
  // A view that closed with something left behind no longer depends on it.
  const moved = source.window.views.filter(candidate => ids.has(candidate.id)).map(candidate => {
    if (!candidate.closeWith || ids.has(candidate.closeWith)) return candidate;
    const { closeWith: _closeWith, ...rest } = candidate;
    return rest;
  });
  const details = source.bots.members[viewId];
  return {
    source: checked({ ...source, window: applyWindowOperation(source.window, { type: 'view.close', viewId }) }),
    target: checked({ ...target, window: appendViews(target.window, moved),
      bots: { ...target.bots, members: { ...target.bots.members, ...(details ? { [viewId]: details } : {}) } } }),
  };
}
```

- [ ] **Step 4: Run the protocol tests**

Run: `pnpm --filter @orchardworks/agent-remote-protocol exec vitest run`
Expected: PASS, every protocol test, including 11 in `window-groups.test.ts`

- [ ] **Step 5: Type-check and commit**

Run: `pnpm --filter @orchardworks/agent-remote-protocol exec tsc --noEmit`
Expected: no output

```bash
git add packages/agent-remote-protocol/src/window-groups.ts packages/agent-remote-protocol/src/window-groups.test.ts
git commit -m "feat(protocol): merge, separate and move bots between Window groups"
```

---

### Task 5: Store and serve groups on the Relay

**Files:**
- Modify: `packages/agent-remote-hosted/src/window-workspaces.ts`
- Modify: `packages/agent-remote-hosted/src/window-workspaces.test.ts`

- [ ] **Step 1: Write the failing tests**

In `window-workspaces.test.ts`, change the protocol import to:

```ts
import { createWindowView, decodeWorkspaceWindow, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
```

and append:

```ts
const sectionWindow = (id: string, nativeSessionId: string, title = 'Release'): WorkspaceWindow => ({ schemaVersion: 3, id, title, revision: 0,
  selectedPrimaryViewId: 'writer', selectedViewId: 'writer', views: [createWindowView('writer', { ...binding, nativeSessionId }, 'primary')] });

it('lists every group, keeping sections without a Window out of the list older pages read', async () => {
  const f = await fixture(); await f.create();
  const created = await f.call('', 'POST', { operationId: 'create-section', issuedAt: Date.now(), window: sectionWindow('section', 'writer'),
    bots: { rank: 'm', members: { writer: { label: 'Writer' } } }, presentation: { window: false } });
  expect(created.body).toMatchObject({ result: { status: 'committed' }, bots: { rank: 'm' }, presentation: { window: false } });
  const listed = await f.call();
  expect(listed.body.windows.map((window: WorkspaceWindow) => window.id)).toEqual(['window']);
  expect(listed.body.groups.map((group: { window: WorkspaceWindow }) => group.window.id)).toEqual(['window', 'section']);
  // An older page decodes every Window it is given.
  expect(listed.body.windows.every((window: unknown) => decodeWorkspaceWindow(window))).toBe(true);
  expect((await f.call('/section')).body).toMatchObject({ bots: { members: { writer: { label: 'Writer' } } }, presentation: { window: false } });
  const restarted = await fixture(f.saved());
  expect((await restarted.call('/section')).body.presentation).toEqual({ window: false });
});

it('refuses stored groups whose appearances or bot details are invalid', async () => {
  const f = await fixture(); await f.create();
  const saved = structuredClone(f.saved());
  const row = saved.workspaceWindows![0]!;
  expect(validateRelayState({ ...saved, workspaceWindows: [{ ...row, bots: { rank: 'm', members: {} } }] }, auth).workspaceWindows![0]!.bots).toEqual({ rank: 'm', members: {} });
  expect(() => validateRelayState({ ...saved, workspaceWindows: [{ ...row, presentation: { window: false } }] }, auth)).toThrow();
  expect(() => validateRelayState({ ...saved, workspaceWindows: [{ ...row, bots: { rank: 'm', members: { missing: {} } } }] }, auth)).toThrow();
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @orchardworks/agent-remote-protocol build && pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/window-workspaces.test.ts`
Expected: FAIL in the two new tests (the create request with `bots` is refused as a legacy request, and `presentation` alone is accepted)

- [ ] **Step 3: Store, validate and serve groups**

In `packages/agent-remote-hosted/src/window-workspaces.ts`:

Replace the protocol import with:

```ts
import {
  decodeWorkspaceWindow, hasWindowAppearance, isWindowDeleteRequest, isWindowGroup, isWindowGroupCreateRequest, isWindowMutation,
  isWindowOperationResult, isWindowSessionBinding, applyWindowOperation, WINDOW_OPERATION_RETENTION_MS,
  type WindowBots, type WindowDeleteRequest, type WindowGroup, type WindowGroupCreateRequest, type WindowMutation,
  type WindowOperationResult, type WindowPresentation, type WindowSessionBinding, type WorkspaceWindow,
} from '@orchardworks/agent-remote-protocol';
```

Add two fields to `SavedWorkspaceWindow`, after `manager`:

```ts
  /** The group's section in Bot mode, kept beside the Window document so older clients still decode every Window. */
  bots?: WindowBots;
  /** Present when the group is not shown as a Window. */
  presentation?: WindowPresentation;
```

After `canonical`, add:

```ts
/** The group a stored row holds; only for rows that are not deleted. */
export function windowGroup(row: SavedWorkspaceWindow): WindowGroup {
  return { window: row.window!, ...(row.bots ? { bots: row.bots } : {}), ...(row.presentation ? { presentation: row.presentation } : {}) };
}
function store(row: SavedWorkspaceWindow, group: WindowGroup) {
  row.window = group.window;
  if (group.bots) row.bots = group.bots; else delete row.bots;
  if (group.presentation) row.presentation = group.presentation; else delete row.presentation;
}
/** What a response says about one stored group: nothing once it is deleted. */
const snapshot = (row: SavedWorkspaceWindow) => row.window ? windowGroup(row) : {};
```

In `validWindowState`, after the `row.manager` check, add:

```ts
    const appearances = row.bots !== undefined || row.presentation !== undefined;
    if (row.deleted ? appearances : appearances && !isWindowGroup({ window: decodeWorkspaceWindow(row.window),
      ...(row.bots === undefined ? {} : { bots: row.bots }), ...(row.presentation === undefined ? {} : { presentation: row.presentation }) })) return false;
```

In `settle`, change the parameter type of `input` to `WindowGroupCreateRequest | WindowMutation | WindowDeleteRequest`, and both `return { result: ..., ...(row.window ? { window: row.window } : {}) };` lines to:

```ts
      return { result: previous.result, ...snapshot(row) };
```

and

```ts
    return { result, ...snapshot(row) };
```

Replace `list`, `inspect` and `create` with:

```ts
    list(principal: WindowPrincipal) {
      if (principal.authorize?.() === false) fail(401, 'unauthorized', 'Authorization is unavailable.');
      const groups = (state.read().workspaceWindows ?? []).filter(row => row.subject === principal.subject && !row.deleted).map(row => structuredClone(windowGroup(row)));
      // Older pages read only `windows`; a group that is only a section stays out of it.
      return { windows: groups.filter(hasWindowAppearance).map(group => group.window), groups };
    },
    inspect(principal: WindowPrincipal, id: string) { const row = rowFor(state.read(), principal, id); return { ...structuredClone(windowGroup(row)), ...(row.manager ? { manager: { session: structuredClone(row.manager.session), generation: row.manager.generation } } : {}) }; },
    async create(principal: WindowPrincipal, input: unknown) {
      assertInputSize(input);
      // A plain Window creation is a group creation without a section.
      if (!isWindowGroupCreateRequest(input)) return replayLegacy(principal, (input as { window?: { id?: string } })?.window?.id, input);
      const group: WindowGroup = { window: input.window, ...(input.bots ? { bots: input.bots } : {}), ...(input.presentation ? { presentation: input.presentation } : {}) };
      const outcome = await state.mutate(draft => {
        if (principal.authorize?.() === false) fail(401, 'unauthorized', 'Authorization is unavailable.');
        const rows = draft.workspaceWindows ??= []; let row = rows.find(row => row.subject === principal.subject && row.id === input.window.id);
        if (!row) { time(input.issuedAt); bindings(principal.subject, input.window); if (input.window.revision !== 0) fail(400, 'invalid_revision', 'New Windows start at revision zero.'); if (rows.length >= 10000) fail(429, 'window_capacity', 'Window capacity reached.'); row = { subject: principal.subject, id: input.window.id, generation: 0, receipts: [] }; rows.push(row); }
        return settle(row, input, () => { if (row!.window || row!.deleted) fail(409, 'window_exists', 'Window identity is already used.'); store(row!, structuredClone(group)); });
      }); notify(principal.subject, input.window.id); return outcome;
    },
```

In `mutate`, replace `{ delete row.window; row.deleted = true; }` with:

```ts
{ delete row.window; delete row.bots; delete row.presentation; row.deleted = true; }
```

and `else { const next = applyWindowOperation(row.window!, input.operation); bindings(principal.subject, next); row.window = next; }` with:

```ts
          else { const next = applyWindowOperation(row.window!, input.operation); bindings(principal.subject, next); store(row, { ...windowGroup(row), window: next }); }
```

(Task 6 replaces this branch with group edits; this step only keeps the stored appearances through layout edits.)

- [ ] **Step 4: Run the Relay tests**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/window-workspaces.test.ts`
Expected: PASS, including the two new tests

- [ ] **Step 5: Type-check and commit**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec tsc --noEmit`
Expected: no output

```bash
git add packages/agent-remote-hosted/src/window-workspaces.ts packages/agent-remote-hosted/src/window-workspaces.test.ts
git commit -m "feat(relay): store Window groups and keep sections out of older pages' Window lists"
```

---

### Task 6: Group edits, rule 1 and rule 5 on the Relay

**Files:**
- Modify: `packages/agent-remote-hosted/src/window-workspaces.ts`
- Modify: `packages/agent-remote-hosted/src/window-workspaces.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `window-workspaces.test.ts`:

```ts
it('refuses to make a session a bot in a second section, naming the section that has it', async () => {
  const f = await fixture(); await f.create();
  expect((await f.call('/window/operations', 'POST', f.mutation('as-section', 0, { type: 'bots.add', rank: 'm' }))).body.result.status).toBe('committed');
  // A plain Window may still show the same session.
  const second = { ...sectionWindow('second', 'native', 'Second'), views: [createWindowView('writer', binding, 'primary')] };
  expect((await f.call('', 'POST', { operationId: 'second', issuedAt: Date.now(), window: second })).body.result.status).toBe('committed');
  const refused = await f.call('/second/operations', 'POST', f.mutation('second-as-section', 0, { type: 'bots.add', rank: 'n' }));
  expect(refused.body.result).toMatchObject({ status: 'rejected', code: 'bot_session_taken', message: 'This session is already a bot in "Window".' });
  expect(refused.body.bots).toBeUndefined();
  const created = await f.call('', 'POST', { operationId: 'third', issuedAt: Date.now(), window: { ...second, id: 'third' }, bots: { rank: 'o', members: {} } });
  expect(created.status).toBe(409);
  expect((await f.call()).body.groups.map((group: { window: WorkspaceWindow }) => group.window.id)).toEqual(['window', 'second']);
});

it('keeps a bot on its conversation whichever client changes it', async () => {
  const f = await fixture(); await f.create();
  await f.call('/window/operations', 'POST', f.mutation('as-section', 0, { type: 'bots.add', rank: 'm' }));
  const rebind = await f.call('/window/operations', 'POST', f.mutation('rebind', 1, { type: 'view.bind', viewId: 'primary', binding: { ...binding, nativeSessionId: 'other' } }));
  expect(rebind.body.result).toMatchObject({ status: 'rejected', code: 'bot_view' });
  const retitle = await f.call('/window/operations', 'POST', f.mutation('retitle', 1, { type: 'view.bind', viewId: 'primary', binding: { ...binding, title: 'Renamed' } }));
  expect(retitle.body.result.status).toBe('committed');
  const details = await f.call('/window/operations', 'POST', f.mutation('label', 2, { type: 'bot.update', viewId: 'primary', details: { label: 'Writer', pinned: true } }));
  expect(details.body).toMatchObject({ result: { status: 'committed', revision: 3 }, bots: { members: { primary: { label: 'Writer', pinned: true } } } });
  // Layout errors keep their generic code.
  const missing = await f.call('/window/operations', 'POST', f.mutation('missing', 3, { type: 'view.close', viewId: 'nowhere' }));
  expect(missing.body.result).toMatchObject({ status: 'rejected', code: 'invalid_operation' });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/window-workspaces.test.ts`
Expected: FAIL in the two new tests (`bots.add` is refused as a legacy request)

- [ ] **Step 3: Apply group edits and both rules**

In `window-workspaces.ts`, replace the protocol import with:

```ts
import {
  applyGroupOperation, decodeWorkspaceWindow, duplicateBot, hasWindowAppearance, isWindowDeleteRequest, isWindowGroup, isWindowGroupCreateRequest,
  isWindowGroupMutation, isWindowOperationResult, isWindowSessionBinding, WindowGroupError, WINDOW_OPERATION_RETENTION_MS,
  type WindowBots, type WindowDeleteRequest, type WindowGroup, type WindowGroupCreateRequest, type WindowGroupMutation,
  type WindowOperationResult, type WindowPresentation, type WindowSessionBinding, type WorkspaceWindow,
} from '@orchardworks/agent-remote-protocol';
```

Inside `createWindowWorkspaces`, after `bindings`, add:

```ts
  /** Rule 5: a session is at most one bot across the subject's groups. `changed` replaces groups by ID; null removes one. */
  function uniqueBots(rows: readonly SavedWorkspaceWindow[], subject: string, changed: ReadonlyMap<string, WindowGroup | null>) {
    const groups = rows.filter(row => row.subject === subject && !row.deleted && !changed.has(row.id)).map(windowGroup);
    for (const group of changed.values()) if (group) groups.push(group);
    const duplicate = duplicateBot(groups);
    if (duplicate) fail(409, 'bot_session_taken', `This session is already a bot in "${duplicate.group.window.title}".`);
  }
  /** A refusal's code: service and group rules name theirs; other layout errors stay generic, as before. */
  function failure(error: unknown): { code: string; message: string } {
    if (!(error instanceof Error)) throw error;
    return { code: error instanceof WindowServiceError || error instanceof WindowGroupError ? error.code : 'invalid_operation', message: error.message };
  }
```

In `settle`, change the `input` parameter type to `WindowGroupCreateRequest | WindowGroupMutation | WindowDeleteRequest`, and replace

```ts
    try { apply(); } catch (error) {
      if (!(error instanceof WindowServiceError) && !(error instanceof Error)) throw error;
      code = error instanceof WindowServiceError ? error.code : 'invalid_operation'; message = error.message;
    }
```

with

```ts
    try { apply(); } catch (error) { ({ code, message } = failure(error)); }
```

In `create`, inside `if (!row) { ... }`, call `uniqueBots(rows, principal.subject, new Map([[input.window.id, group]]));` immediately before `row = { subject: ...`. (The check runs before the row exists: a refused creation must not leave an empty row, which the stored state would reject.)

Replace `mutate` with:

```ts
    async mutate(principal: WindowPrincipal, id: string, input: unknown) {
      assertInputSize(input);
      // A plain Window mutation is a group mutation without section edits.
      if (!isWindowGroupMutation(input) && !isWindowDeleteRequest(input)) return replayLegacy(principal, id, input);
      const outcome = await state.mutate(draft => {
        const row = rowFor(draft, principal, id, true);
        return settle(row, input, () => {
          if (row.deleted) fail(404, 'window_not_found', 'Window was deleted.');
          if (row.window!.revision !== input.baseRevision) fail(409, 'revision_conflict', 'Read the current Window revision.');
          if (input.operation.type === 'delete') { delete row.window; delete row.bots; delete row.presentation; row.deleted = true; return; }
          const next = applyGroupOperation(windowGroup(row), input.operation);
          bindings(principal.subject, next.window);
          uniqueBots(draft.workspaceWindows!, principal.subject, new Map([[id, next]]));
          store(row, next);
        });
      }); notify(principal.subject, id); return outcome;
    },
```

- [ ] **Step 4: Run the Relay tests**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/window-workspaces.test.ts src/gateway-window-wait.test.ts`
Expected: PASS

- [ ] **Step 5: Type-check and commit**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec tsc --noEmit`
Expected: no output

```bash
git add packages/agent-remote-hosted/src/window-workspaces.ts packages/agent-remote-hosted/src/window-workspaces.test.ts
git commit -m "feat(relay): apply section edits and keep each session at most one bot"
```

---

### Task 7: Merge, split and transfer on the Relay

**Files:**
- Modify: `packages/agent-remote-hosted/src/window-workspaces.ts`
- Modify: `packages/agent-remote-hosted/src/window-routes.ts`
- Modify: `packages/agent-remote-hosted/src/window-workspaces.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `window-workspaces.test.ts`:

```ts
it('merges, separates and moves bots between groups in one step each, with a receipt on every group', async () => {
  const f = await fixture(); await f.create();
  await f.call('', 'POST', { operationId: 'create-section', issuedAt: Date.now(), window: sectionWindow('section', 'writer'), bots: { rank: 'm', members: {} }, presentation: { window: false } });
  const merge = { operationId: 'merge', issuedAt: Date.now(), baseRevision: 0, source: 'window', sourceRevision: 0 };
  const merged = await f.call('/section/merge', 'POST', merge);
  expect(merged.body.result.status).toBe('committed');
  expect(merged.body.groups.window).toBeNull();
  expect(merged.body.groups.section).toMatchObject({ window: { revision: 1, views: [{ id: 'writer' }, { id: 'primary' }] }, bots: { rank: 'm' } });
  expect(merged.body.groups.section.presentation).toBeUndefined();
  // The same request is answered from its receipt, found on either group.
  expect((await f.call('/section/merge', 'POST', merge)).body.result).toEqual(merged.body.result);
  expect((await f.call('/window/operations/merge')).body.result).toEqual(merged.body.result);

  const split = await f.call('/section/split', 'POST', { operationId: 'split', issuedAt: Date.now(), baseRevision: 1, newId: 'section-bots' });
  expect(split.body.groups.section.bots).toBeUndefined();
  expect(split.body.groups['section-bots']).toMatchObject({ presentation: { window: false }, window: { revision: 0 } });

  await f.call('', 'POST', { operationId: 'create-third', issuedAt: Date.now(), bots: { rank: 'n', members: {} }, presentation: { window: false },
    window: { schemaVersion: 3, id: 'third', title: 'Third', revision: 0, selectedPrimaryViewId: null, selectedViewId: null, views: [] } });
  const transfer = await f.call('/section-bots/transfer', 'POST', { operationId: 'transfer', issuedAt: Date.now(), baseRevision: 0, viewId: 'primary', target: 'third', targetRevision: 0 });
  expect(transfer.body.groups['section-bots'].window.views.map((view: { id: string }) => view.id)).toEqual(['writer']);
  expect(transfer.body.groups.third.window.views.map((view: { id: string }) => view.id)).toEqual(['primary']);

  const stale = await f.call('/section/split', 'POST', { operationId: 'stale', issuedAt: Date.now(), baseRevision: 0, newId: 'again' });
  expect(stale.body.result).toMatchObject({ status: 'rejected', code: 'revision_conflict' });
  expect(stale.body.groups.again).toBeUndefined();

  const restarted = await fixture(f.saved());
  expect((await restarted.call()).body.groups.map((group: { window: WorkspaceWindow }) => group.window.id)).toEqual(['section', 'section-bots', 'third']);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/window-workspaces.test.ts -t "merges, separates"`
Expected: FAIL, `merged.body.result` is undefined (the route answers 405)

- [ ] **Step 3: Implement the operations and routes**

In `window-workspaces.ts`, add `isWindowMergeRequest, isWindowSplitRequest, isWindowTransferRequest, mergeGroups, splitGroup, transferBot` to the protocol import.

Inside `createWindowWorkspaces`, after `settle`, add:

```ts
  const groupsOf = (rows: SavedWorkspaceWindow[]) => Object.fromEntries(rows.map(row => [row.id, row.window ? windowGroup(row) : null]));
  /** Settles one operation that changes several groups and leaves the same receipt on each; `rows` is read again after the change. */
  function settleAcross(rows: () => SavedWorkspaceWindow[], input: { operationId: string; issuedAt: number }, apply: () => void) {
    const fingerprint = hash(canonical(input));
    const previous = rows().flatMap(row => row.receipts).find(item => item.result.operationId === input.operationId);
    if (previous && previous.result.expiresAt > now()) {
      if (previous.fingerprint !== fingerprint) fail(409, 'operation_conflict', 'Operation ID was used with different input.');
      return { result: previous.result, groups: groupsOf(rows()) };
    }
    time(input.issuedAt);
    if (previous) fail(410, 'operation_expired', 'Operation result expired.');
    for (const row of rows()) {
      row.receipts = row.receipts.filter(item => item.result.expiresAt > now());
      if (row.receipts.length >= 4096) fail(429, 'receipt_capacity', 'Window operation retention capacity reached.');
    }
    let code: string | undefined; let message: string | undefined;
    // `apply` checks everything before it changes any row, so a refusal leaves every group as it was.
    try { apply(); } catch (error) { ({ code, message } = failure(error)); }
    const result: WindowOperationResult = { operationId: input.operationId, status: code ? 'rejected' : 'committed', revision: rows()[0]?.window?.revision ?? 0,
      committedAt: now(), expiresAt: now() + WINDOW_OPERATION_RETENTION_MS, ...(code ? { code, message } : {}) };
    for (const row of rows()) row.receipts.push({ fingerprint, result });
    return { result, groups: groupsOf(rows()) };
  }
```

In the returned object, after `operation`, add:

```ts
    async merge(principal: WindowPrincipal, id: string, input: unknown) {
      assertInputSize(input);
      if (!isWindowMergeRequest(input)) throw new WindowServiceError(400, 'invalid_operation', 'A valid merge request is required.');
      const outcome = await state.mutate(draft => {
        const target = rowFor(draft, principal, id, true), source = rowFor(draft, principal, input.source, true);
        return settleAcross(() => [target, source], input, () => {
          if (target.deleted || source.deleted) fail(404, 'window_not_found', 'Window was deleted.');
          if (target.id === source.id) fail(400, 'invalid_operation', 'A group cannot merge into itself.');
          if (target.window!.revision !== input.baseRevision || source.window!.revision !== input.sourceRevision) fail(409, 'revision_conflict', 'Read the current Window revisions.');
          const merged = mergeGroups(windowGroup(target), windowGroup(source));
          bindings(principal.subject, merged.window);
          uniqueBots(draft.workspaceWindows!, principal.subject, new Map([[target.id, merged], [source.id, null]]));
          store(target, merged); delete source.window; delete source.bots; delete source.presentation; source.deleted = true;
        });
      }); notify(principal.subject, id); notify(principal.subject, input.source); return outcome;
    },
    async split(principal: WindowPrincipal, id: string, input: unknown) {
      assertInputSize(input);
      if (!isWindowSplitRequest(input)) throw new WindowServiceError(400, 'invalid_operation', 'A valid split request is required.');
      const outcome = await state.mutate(draft => {
        const rows = draft.workspaceWindows ??= [];
        const original = rowFor(draft, principal, id, true);
        let created = rows.find(row => row.subject === principal.subject && row.id === input.newId);
        return settleAcross(() => created ? [original, created] : [original], input, () => {
          if (original.deleted) fail(404, 'window_not_found', 'Window was deleted.');
          if (original.window!.revision !== input.baseRevision) fail(409, 'revision_conflict', 'Read the current Window revision.');
          if (created) fail(409, 'window_exists', 'Window identity is already used.');
          if (rows.length >= 10000) fail(429, 'window_capacity', 'Window capacity reached.');
          const parts = splitGroup(windowGroup(original), input.newId);
          store(original, parts.kept);
          created = { subject: principal.subject, id: input.newId, generation: 0, receipts: [] };
          store(created, parts.created); rows.push(created);
        });
      }); notify(principal.subject, id); notify(principal.subject, input.newId); return outcome;
    },
    async transfer(principal: WindowPrincipal, id: string, input: unknown) {
      assertInputSize(input);
      if (!isWindowTransferRequest(input)) throw new WindowServiceError(400, 'invalid_operation', 'A valid transfer request is required.');
      const outcome = await state.mutate(draft => {
        const source = rowFor(draft, principal, id, true), target = rowFor(draft, principal, input.target, true);
        return settleAcross(() => [source, target], input, () => {
          if (source.deleted || target.deleted) fail(404, 'window_not_found', 'Window was deleted.');
          if (source.window!.revision !== input.baseRevision || target.window!.revision !== input.targetRevision) fail(409, 'revision_conflict', 'Read the current Window revisions.');
          const moved = transferBot(windowGroup(source), windowGroup(target), input.viewId);
          bindings(principal.subject, moved.target.window);
          uniqueBots(draft.workspaceWindows!, principal.subject, new Map([[source.id, moved.source], [target.id, moved.target]]));
          store(source, moved.source); store(target, moved.target);
        });
      }); notify(principal.subject, id); notify(principal.subject, input.target); return outcome;
    },
```

In `packages/agent-remote-hosted/src/window-routes.ts`, before `return json(405, { code: 'method_not_allowed' });`, add:

```ts
    const across = parts[3];
    if (id && parts.length === 4 && method === 'POST' && (across === 'merge' || across === 'split' || across === 'transfer')) {
      const input = await body(); return json(200, await service[across](principal, id, input));
    }
```

- [ ] **Step 4: Run the Relay tests**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/window-workspaces.test.ts src/gateway-window-wait.test.ts`
Expected: PASS

- [ ] **Step 5: Type-check and commit**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec tsc --noEmit`
Expected: no output

```bash
git add packages/agent-remote-hosted/src/window-workspaces.ts packages/agent-remote-hosted/src/window-routes.ts packages/agent-remote-hosted/src/window-workspaces.test.ts
git commit -m "feat(relay): merge, separate and move bots across Window groups atomically"
```

---

### Task 8: The web client

**Files:**
- Modify: `packages/agent-remote-web/src/client/window-client.ts`
- Modify: `packages/agent-remote-web/src/client/window-client.test.ts`

- [ ] **Step 1: Write the failing tests**

In `window-client.test.ts`, let the test server pass the request URL to `reply`: change the helper's signature to

```ts
async function withWindowServer(reply: (input: { operationId: string }, url: string) => { body: unknown; status?: number }, run: (client: WindowWorkspaceClient) => Promise<void>) {
```

and its call to `const next = reply(body ? JSON.parse(body) : {}, request.url ?? '');`. Then append:

```ts
it('lists groups with their appearances, and Windows as groups from an older Relay', async () => {
  const bots = { rank: 'm', members: {} };
  await withWindowServer(() => ({ body: { windows: [], groups: [{ window, bots, presentation: { window: false } }] } }), async client => {
    expect(await client.listGroups()).toEqual([{ window, bots, presentation: { window: false } }]);
  });
  await withWindowServer(() => ({ body: { windows: [window] } }), async client => {
    expect(await client.listGroups()).toEqual([{ window }]);
  });
  await withWindowServer(() => ({ body: { groups: [{ window, presentation: { window: false } }] } }), async client => {
    await expect(client.listGroups()).rejects.toThrow('Invalid Window list.');
  });
});

it('returns and checks the section of a snapshot', async () => {
  const bots = { rank: 'm', members: {} };
  await withWindowServer(() => ({ body: { window, bots } }), async client => {
    expect(await client.inspect(window.id)).toEqual({ window, bots });
  });
  await withWindowServer(() => ({ body: { window, bots: { rank: 'm', members: { main: { label: 'Not a bot' } } } } }), async client => {
    await expect(client.inspect(window.id)).rejects.toThrow('Invalid Window snapshot.');
  });
});

it('creates a group with its appearances', async () => {
  const bots = { rank: 'm', members: {} };
  let sent: unknown;
  await withWindowServer(input => { sent = input; return { body: { result: receipt(input.operationId, 0), window, bots, presentation: { window: false } } }; }, async client => {
    expect(await client.createGroup({ window, bots, presentation: { window: false } }, { operationId: 'create-section', issuedAt: 100 }))
      .toMatchObject({ window, bots, presentation: { window: false } });
  });
  expect(sent).toEqual({ operationId: 'create-section', issuedAt: 100, window, bots, presentation: { window: false } });
});

it('sends merges, splits and transfers to their group and returns the groups they changed', async () => {
  const urls: string[] = [];
  const section = { window: { ...window, revision: 1 }, bots: { rank: 'm', members: {} } };
  await withWindowServer((input, url) => { urls.push(url); return { body: { result: receipt(input.operationId), groups: { 'window-one': section, other: null } } }; }, async client => {
    expect(await client.merge('window-one', { operationId: 'merge', issuedAt: 100, baseRevision: 0, source: 'other', sourceRevision: 0 }))
      .toEqual({ result: receipt('merge'), groups: { 'window-one': section, other: null } });
    await client.split('window-one', { operationId: 'split', issuedAt: 100, baseRevision: 1, newId: 'other' });
    await client.transfer('window-one', { operationId: 'transfer', issuedAt: 100, baseRevision: 1, viewId: 'main', target: 'other', targetRevision: 0 });
  });
  expect(urls).toEqual(['/u/account/v1/windows/window-one/merge', '/u/account/v1/windows/window-one/split', '/u/account/v1/windows/window-one/transfer']);
  await withWindowServer(input => ({ body: { result: { ...receipt(input.operationId), status: 'rejected', code: 'bot_session_taken', message: 'This session is already a bot in "Release".' }, groups: {} } }), async client => {
    await expect(client.merge('window-one', { operationId: 'merge', issuedAt: 100, baseRevision: 0, source: 'other', sourceRevision: 0 }))
      .rejects.toMatchObject({ code: 'bot_session_taken', message: 'This session is already a bot in "Release".' });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @orchardworks/agent-remote-protocol build && pnpm --filter @orchardworks/agent-remote-web exec vitest run src/client/window-client.test.ts`
Expected: FAIL, `client.listGroups is not a function`

- [ ] **Step 3: Implement the client**

In `packages/agent-remote-web/src/client/window-client.ts`, replace the protocol import with:

```ts
import {
  decodeWorkspaceWindow, isWindowGroup, isWindowOperationResult, isWindowSessionBinding,
  type WindowBots, type WindowCreateRequest, type WindowDeleteRequest, type WindowGroup, type WindowGroupCreateRequest, type WindowGroupMutation,
  type WindowMergeRequest, type WindowMutation, type WindowOperationResult, type WindowPresentation, type WindowSessionBinding,
  type WindowSplitRequest, type WindowTransferRequest, type WorkspaceWindow,
} from '@orchardworks/agent-remote-protocol';
```

Replace the `WindowSnapshot` and `WindowCommit` interfaces with:

```ts
export interface WindowSnapshot { window: WorkspaceWindow; manager?: { session: WindowSessionBinding; generation: number }; bots?: WindowBots; presentation?: WindowPresentation }
export interface WindowCommit { window: WorkspaceWindow; result: WindowOperationResult; bots?: WindowBots; presentation?: WindowPresentation }
/** The groups a cross-group operation changed; null for a group it deleted. */
export interface WindowGroupsCommit { result: WindowOperationResult; groups: Record<string, WindowGroup | null> }
```

After `list()`, add:

```ts
  /** Every group with its appearances; a Relay without groups answers with Windows only. */
  async listGroups(): Promise<WindowGroup[]> {
    const { value } = await this.request('');
    const raw = value.groups ?? (Array.isArray(value.windows) ? value.windows.map((window: unknown) => ({ window })) : undefined);
    if (!Array.isArray(raw)) throw new Error('Invalid Window list.');
    return raw.map((item: any) => {
      const window = decodeWorkspaceWindow(item?.window);
      const group = window && { window, ...(item.bots === undefined ? {} : { bots: item.bots }), ...(item.presentation === undefined ? {} : { presentation: item.presentation }) };
      if (!group || !isWindowGroup(group)) throw new Error('Invalid Window list.');
      return group;
    });
  }
```

Replace `validate` with:

```ts
  private validate(value: any, id: string): void {
    const window = decodeWorkspaceWindow(value.window);
    const appearances = value.bots !== undefined || value.presentation !== undefined;
    if (!window || window.id !== id || value.manager !== undefined && (!isWindowSessionBinding(value.manager?.session) || !Number.isSafeInteger(value.manager?.generation) || value.manager.generation < 0)
      || appearances && !isWindowGroup({ window, ...(value.bots === undefined ? {} : { bots: value.bots }), ...(value.presentation === undefined ? {} : { presentation: value.presentation }) })) throw new Error('Invalid Window snapshot.');
    value.window = window;
  }
```

After `create`, add:

```ts
  /** Creates a group with its appearances. Unlike create, an unknown outcome is left to the caller, who can read it with recoverCreate. */
  async createGroup(group: WindowGroup, operation: WindowOperationIdentity = identity()): Promise<WindowSnapshot> {
    const input: WindowGroupCreateRequest = { operationId: operation.operationId, issuedAt: operation.issuedAt, window: structuredClone(group.window),
      ...(group.bots ? { bots: structuredClone(group.bots) } : {}), ...(group.presentation ? { presentation: structuredClone(group.presentation) } : {}) };
    const response = await this.request('', 'POST', input);
    const result = this.receipt(response, input.operationId);
    this.committed(result, response.status);
    return this.commit(response, group.window.id, result);
  }
```

Change the `mutate` signature to `async mutate(id: string, mutation: WindowMutation | WindowGroupMutation): Promise<WindowCommit> {`.

After `assign`, add:

```ts
  merge(targetId: string, request: WindowMergeRequest): Promise<WindowGroupsCommit> { return this.across(targetId, 'merge', request); }
  split(id: string, request: WindowSplitRequest): Promise<WindowGroupsCommit> { return this.across(id, 'split', request); }
  transfer(sourceId: string, request: WindowTransferRequest): Promise<WindowGroupsCommit> { return this.across(sourceId, 'transfer', request); }
  private async across(id: string, action: 'merge' | 'split' | 'transfer', request: WindowMergeRequest | WindowSplitRequest | WindowTransferRequest): Promise<WindowGroupsCommit> {
    const response = await this.request(`/${encodeURIComponent(id)}/${action}`, 'POST', request);
    const result = this.receipt(response, request.operationId);
    this.committed(result, response.status);
    const groups = response.value.groups;
    if (!groups || typeof groups !== 'object' || Object.entries(groups).some(([key, group]) => group !== null && (!isWindowGroup(group) || group.window.id !== key))) {
      throw new WindowRequestError('Invalid Window receipt.', response.status, 'invalid_window_receipt');
    }
    return { result, groups };
  }
```

`WindowCreateRequest` stays imported for `WindowMutationUnknownError` and `create`.

- [ ] **Step 4: Run the web client tests**

Run: `pnpm --filter @orchardworks/agent-remote-web exec vitest run src/client/window-client.test.ts`
Expected: PASS

- [ ] **Step 5: Type-check and commit**

Run: `pnpm --filter @orchardworks/agent-remote-web exec tsc --noEmit`
Expected: no output

```bash
git add packages/agent-remote-web/src/client/window-client.ts packages/agent-remote-web/src/client/window-client.test.ts
git commit -m "feat(web): read and change Window groups, their sections and bots"
```

---

### Task 9: Document the current state

**Files:**
- Create: `docs/current/agent-remote/window-groups.md`
- Modify: `docs/current/agent-remote/README.md` (Subdocuments table)

- [ ] **Step 1: Write the document**

Create `docs/current/agent-remote/window-groups.md`:

```markdown
# Window groups

A Window group is a Window document with two appearances: a **Window** (its layout, shown in Window mode) and a **section** (its bots, for Bot mode, which the website adds in a later milestone). Every group has at least one. Every Window created before sections existed is a group with only the Window appearance. Design: [Bot mode](../../superpowers/specs/2026-11-08-bot-view-design.md).

## Data

The Relay stores a group's section (`bots`: a rank and, per bot, a label, a picture of a shape and a color, pinned, hidden and a rank) and its `presentation` (`{ window: false }` when it is not shown as a Window) beside the Window document, not inside it, so older pages and `agent-remote-controller window` still decode every Window (`packages/agent-remote-hosted/src/window-workspaces.ts`). Schemas and pure operations are in `packages/agent-remote-protocol/src/window-groups.ts`.

A **bot** is a view of a section that is not attached, not a history view, not an Ask, Team or TPM view, and shows a session. Details of views that stop being bots are dropped.

## Requests

| Request | Answer |
|---|---|
| `GET /v1/windows` | `windows`: the groups with a Window appearance, as before; `groups`: every group with `bots` and `presentation` |
| `GET /v1/windows/:id`, `.../changes` | the Window with `bots`, `presentation` and `manager` |
| `POST /v1/windows` | creates a group; `bots` and `presentation` are optional |
| `POST /v1/windows/:id/operations` | Window edits and `bots.add {rank}`, `bots.remove`, `window.add`, `window.remove`, `bot.update {viewId, details}`, `section.rank {rank}`, alone or in a batch |
| `POST /v1/windows/:id/merge` | `{source, sourceRevision, baseRevision}`: the source's views join this group, which gets every appearance either had; the source is deleted |
| `POST /v1/windows/:id/split` | `{newId, baseRevision}`: a group that is both keeps the Window; a new group with the same views gets the section |
| `POST /v1/windows/:id/transfer` | `{viewId, target, targetRevision, baseRevision}`: a bot, its attached views and its details move to another section |

Cross-group requests change every group at once, answer with `groups` (null for a deleted one) and leave the same receipt on each group.

## Rules

- A group keeps at least one appearance (`last_appearance`).
- A bot keeps its conversation: an edit that binds a bot's view to another session, or to its history, is refused (`bot_view`); title updates are allowed, and succession rebinds through `layout.apply`.
- A session is at most one bot across a user's groups (`bot_session_taken`, naming the section that has it). Views of groups without a section may show any session.
- Other refusals: `section_exists`, `section_missing`, `window_exists`, `window_missing`, `bot_not_found`, `not_linked`, `same_group`.
```

In `docs/current/agent-remote/README.md`, add this row to the Subdocuments table, after the `protocol.md` row:

```markdown
| [window-groups.md](window-groups.md) | Window groups: their Window and section appearances, bots, and the Relay requests and rules. |
```

- [ ] **Step 2: Lint and commit**

Run: `pnpm --silent lint:docs`
Expected: exit 0

```bash
git add docs/current/agent-remote/window-groups.md docs/current/agent-remote/README.md
git commit -m "docs: describe Window groups, sections and bots on the Relay"
```

---

### Task 10: Verify the milestone

- [ ] **Step 1: Build, type-check and run the affected suites**

Run:

```bash
pnpm -r run build
pnpm typecheck
node scripts/run-tests.mjs affected origin/main
```

Expected: builds succeed, no type errors, every affected suite passes (protocol, hosted, web and the packages that depend on them, including the Lab and Cloudflare Worker suites).

- [ ] **Step 2: Update the compatibility manifest**

Run: `pnpm compatibility:update && pnpm compatibility:check`
Expected: "Compatibility verified: sha256:…"

```bash
git add packages/agent-remote-lab/compatibility.json
git commit -m "chore: update compatibility for Window groups"
```

(Skip the commit if `git status` shows no change.)

- [ ] **Step 3: Check it end to end on a local instance**

Use the `prepare-arc-local` skill's rules (this checkout's instance only; never the production site). Run:

```bash
pnpm local up
agent-remote-controller-dev session list
```

If the list is empty, create one session: `agent-remote-controller-dev session create --provider claude --message "Reply with the single word READY."`, then list again. Put that session's `hostId`, `providerId` and `nativeSessionId` in `H`, `P` and `S`, then:

```bash
W='{"schemaVersion":3,"id":"bots-check","title":"Bots check","revision":0,"selectedPrimaryViewId":"bot","selectedViewId":"bot","views":[{"id":"bot","placement":"primary","width":440,"collapsed":false,"display":{"mode":"preview","lettersVisible":true},"binding":{"hostId":"'$H'","providerId":"'$P'","nativeSessionId":"'$S'","title":"Check"}}]}'
pnpm --silent local api v1/windows --method POST --data '{"operationId":"bots-check","issuedAt":'$(node -e 'console.log(Date.now())')',"window":'$W',"bots":{"rank":"m","members":{}},"presentation":{"window":false}}'
pnpm --silent local api v1/windows
pnpm --silent local api v1/windows --method POST --data '{"operationId":"bots-twice","issuedAt":'$(node -e 'console.log(Date.now())')',"window":'"${W//bots-check/bots-twice}"',"bots":{"rank":"n","members":{}}}'
agent-remote-controller-dev window list
```

Expected: the first request commits with `presentation`; the list shows `bots-check` under `groups` but not under `windows`; the second is refused with HTTP 409 and `bot_session_taken` naming "Bots check"; `agent-remote-controller-dev window list` lists the other Windows without error and without `bots-check`. Then delete the check group:

```bash
pnpm --silent local api v1/windows/bots-check --method DELETE --data '{"operationId":"bots-check-delete","issuedAt":'$(node -e 'console.log(Date.now())')',"baseRevision":0,"operation":{"type":"delete"}}'
```

and run `pnpm local down` if the instance was not running before.

- [ ] **Step 4: Hand off for deployment**

Report the results. Deploying the Worker (the Relay) is outward-facing: ask the owner before `wrangler deploy`. Rolling the Worker back stays possible: older Workers load rows with `bots` and `presentation` (their state check ignores unknown row fields) and keep them, but list groups that are only sections as Windows.
