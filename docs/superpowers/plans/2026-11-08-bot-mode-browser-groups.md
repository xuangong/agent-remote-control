# Bot mode milestone 2a (the group in the browser) Implementation Plan

## Goal

The browser keeps a group, not a Window: the `WindowWorkspaceStore` holds the Window document together with its Bot appearance, applies group edits optimistically like layout edits, and the Lab's catalog lists every group, including one that is only a section. The local-first Lab mode stores the group beside its local Window.

No visible change: `windows` still lists only groups with a Window appearance, and nothing in the page reads the new fields yet. Milestone 2b builds the mode switch, the roster, the bot's page, the fallback group and notifications on what this plan exposes.

Design: [Bot mode](../specs/2026-11-08-bot-view-design.md), milestone 2, first half. Milestone 1 (protocol, Relay, web client) shipped in `1c2f9fef` and the Worker is deployed.

**Tech Stack:** TypeScript, TypeBox (`@sinclair/typebox`), React, Vitest, `@orchardworks/agent-remote-protocol`, `@orchardworks/agent-remote-web`, `@orchardworks/agent-remote-lab`.

**Working directory:** `/Volumes/Projects/agent-remote-control/.worktrees/bot-mode-ui` (branch `feat/bot-mode-ui`, from `main` at `1c2f9fef`). The web and Lab packages import the protocol from its built `dist`, so rebuild the protocol package before running their tests; every task below does.

---

## Architecture

`WindowWorkspaceStore` holds `WindowGroup` internally and keeps its Window-shaped surface:

| Member | Before | After |
|---|---|---|
| `getSnapshot()` | `WorkspaceWindow` | unchanged (`this.snapshot.window`) |
| `getCommittedSnapshot()` | `WorkspaceWindow` | unchanged (`this.committed.window`) |
| `getGroup()` / `getCommittedGroup()` | — | the group |
| `constructor(initial, …)` | `WorkspaceWindow` | `WorkspaceWindow \| WindowGroup`, normalized |
| `accept(value)` | `WorkspaceWindow` | a Window, a group or a `WindowSnapshot` |
| `operate(operation)` | `WindowOperation` | `WindowGroupOperation` (a superset) |
| `cache?(window)` | `WorkspaceWindow` | unchanged; the Lab caches the group itself |
| `localCommit?(source, operation)` | Window in, Window out | group in, group out |

Keeping the Window-shaped reads is not a convenience: the design says every existing Window *is* a group with only the Window appearance, so a Window and a group are two readings of one value. It also leaves the 34 store constructions across 8 Lab files, and every `accept` call and `getSnapshot` reader in the page, unchanged, so the diff stays reviewable.

## File structure

| File | Responsibility |
|---|---|
| `packages/agent-remote-protocol/src/window-groups.ts` | add `toWindowGroup`, `decodeWindowGroup`, `isWindowGroupOperation` |
| `packages/agent-remote-web/src/client/window-client.ts` | decode groups with the shared decoder |
| `packages/agent-remote-lab/src/window-workspace-store.ts` | hold a group; group edits, recovery journal v2 |
| `packages/agent-remote-lab/src/hooks/useWindowWorkspace.ts` | store groups locally; a catalog of groups |
| `docs/current/agent-remote/window-groups.md` | how the browser holds a group |

---

### Task 1: Shared group decoding (protocol and web client)

**Files:**
- Modify: `packages/agent-remote-protocol/src/window-groups.ts`
- Modify: `packages/agent-remote-protocol/src/window-groups.test.ts`
- Modify: `packages/agent-remote-web/src/client/window-client.ts`

- [ ] **Step 1: Write the failing tests**

In `window-groups.test.ts`, add `decodeWindowGroup, isWindowGroupOperation, toWindowGroup` to the import from `./window-groups.js`, and append:

```ts
it('reads the group a Window, a snapshot or a group describes', () => {
  const window = windowOf('w', createWindowView('main', session('a'), 'primary'));
  expect(toWindowGroup(window)).toEqual({ window });
  expect(toWindowGroup({ window, manager: { session: session('a'), generation: 1 } })).toEqual({ window });
  const group = section(window);
  expect(toWindowGroup(group)).toEqual(group);
  expect(toWindowGroup({ window, bots: group.bots, presentation: { window: false } })).toEqual({ ...group, presentation: { window: false } });
});

it('decodes a stored or transported group, including a Window saved before groups', () => {
  const window = windowOf('w', createWindowView('main', session('a'), 'primary'));
  const group = { ...section(window), presentation: { window: false } as const };
  expect(decodeWindowGroup(JSON.parse(JSON.stringify(window)))).toEqual({ window });
  expect(decodeWindowGroup(JSON.parse(JSON.stringify(group)))).toEqual(group);
  expect(decodeWindowGroup({ window, manager: { session: session('a'), generation: 1 } })).toEqual({ window });
  expect(decodeWindowGroup({ window, bots: { rank: '', members: {} } })).toBeUndefined();
  expect(decodeWindowGroup({ window, bots: { rank: 'm', members: { missing: {} } } })).toBeUndefined();
  expect(decodeWindowGroup({ window: { ...window, views: [] } })).toBeUndefined();
  expect(decodeWindowGroup(undefined)).toBeUndefined();
});

it('accepts every group operation and refuses anything else', () => {
  expect(isWindowGroupOperation({ type: 'bots.add', rank: 'm' })).toBe(true);
  expect(isWindowGroupOperation({ type: 'rename', title: 'Release' })).toBe(true);
  expect(isWindowGroupOperation({ type: 'batch', operations: [{ type: 'bots.add', rank: 'm' }, { type: 'rename', title: 'Release' }] })).toBe(true);
  expect(isWindowGroupOperation({ type: 'bots.add' })).toBe(false);
  expect(isWindowGroupOperation({ type: 'delete' })).toBe(false);
  expect(isWindowGroupOperation(undefined)).toBe(false);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @orchardworks/agent-remote-protocol exec vitest run src/window-groups.test.ts`
Expected: FAIL, 3 tests, "is not a function".

- [ ] **Step 3: Implement**

In `window-groups.ts`, add `decodeWorkspaceWindow` to the import from `./window-workspace.js`:

```ts
import { WINDOW_VIEW_LIMIT, WindowEdit, WorkspaceWindow, decodeWorkspaceWindow, isWorkspaceWindow, type WindowSessionBinding, type WindowView } from './window-workspace.js';
```

After `export const hasWindowAppearance = …`, add:

```ts
/** The group a Window, a group or a Relay snapshot describes: every Window is a group with only the Window appearance. */
export function toWindowGroup(value: WorkspaceWindow | { window: WorkspaceWindow; bots?: WindowBots; presentation?: WindowPresentation }): WindowGroup {
  if (!('window' in value)) return { window: value };
  return { window: value.window, ...(value.bots ? { bots: value.bots } : {}), ...(value.presentation ? { presentation: value.presentation } : {}) };
}
/** A group from storage or a Relay, its Window decoded from any schema this build reads; a bare Window predates groups. */
export function decodeWindowGroup(value: unknown): WindowGroup | undefined {
  const source = (value && typeof value === 'object' && 'window' in value ? value : { window: value }) as { window: unknown; bots?: unknown; presentation?: unknown };
  const window = decodeWorkspaceWindow(source.window);
  if (!window) return undefined;
  const group = { window, ...(source.bots === undefined ? {} : { bots: source.bots }), ...(source.presentation === undefined ? {} : { presentation: source.presentation }) };
  return isWindowGroup(group) ? group : undefined;
}
```

Beside `isWindowGroupMutation`, add:

```ts
export const isWindowGroupOperation = (value: unknown): value is WindowGroupOperation => Value.Check(WindowGroupOperation, value);
```

In `packages/agent-remote-web/src/client/window-client.ts`, add `decodeWindowGroup` to the protocol import and delete the private decoder:

```ts
/** A group as a Relay sends it, with its Window decoded from any schema this client accepts. */
function decodeGroup(value: any): WindowGroup | undefined {
  const window = decodeWorkspaceWindow(value?.window);
  const group = window && { window, ...(value.bots === undefined ? {} : { bots: value.bots }), ...(value.presentation === undefined ? {} : { presentation: value.presentation }) };
  return group && isWindowGroup(group) ? group : undefined;
}
```

Replace the two call sites (`raw.map(decodeGroup)` in `listGroups`, `decodeGroup(value)` in `across`) with `decodeWindowGroup`. Keep `decodeWorkspaceWindow` and `isWindowGroup` in the import: `validate` still uses both.

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @orchardworks/agent-remote-protocol exec vitest run
pnpm --filter @orchardworks/agent-remote-protocol exec tsc --noEmit
pnpm --filter @orchardworks/agent-remote-protocol build
pnpm --filter @orchardworks/agent-remote-web exec vitest run src/client/window-client.test.ts
pnpm --filter @orchardworks/agent-remote-web exec tsc --noEmit
```
Expected: protocol 14 tests in `window-groups.test.ts` and the whole suite pass; web client 30 pass; no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-remote-protocol/src/window-groups.ts packages/agent-remote-protocol/src/window-groups.test.ts packages/agent-remote-web/src/client/window-client.ts
git commit -m "feat(protocol): read a Window, a snapshot or a group as one group"
```

---

### Task 2: The store holds a group

**Files:**
- Modify: `packages/agent-remote-lab/src/window-workspace-store.ts`
- Modify: `packages/agent-remote-lab/src/window-workspace.test.ts`
- Modify: `packages/agent-remote-lab/src/hooks/useWindowWorkspace.ts` (local commit and local storage only)

- [ ] **Step 1: Write the failing tests**

In `window-workspace.test.ts`, extend the protocol import to `import { applyGroupOperation, createWindowView, type WindowGroup, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';` and append:

```ts
const bound = (): WorkspaceWindow => ({ ...initial(), views: [createWindowView('main', { hostId: 'mac', providerId: 'claude', nativeSessionId: 'one', title: 'One' }, 'primary')] });

it('applies a group edit at once and sends it with the next revision', async () => {
  const store = new WindowWorkspaceStore(bound());
  await store.operate({ type: 'bots.add', rank: 'm' });
  expect(store.getGroup().bots).toEqual({ rank: 'm', members: {} });
  expect(store.getSnapshot().revision).toBe(1);
  await store.operate({ type: 'bot.update', viewId: 'main', details: { label: 'Release' } });
  expect(store.getGroup().bots?.members).toEqual({ main: { label: 'Release' } });
  expect(store.getCommittedGroup()).toEqual(store.getGroup());
});

it('keeps a Window reading of a group it holds', async () => {
  const group: WindowGroup = { window: bound(), bots: { rank: 'm', members: { main: { pinned: true } } } };
  const store = new WindowWorkspaceStore(group);
  expect(store.getSnapshot()).toEqual(group.window);
  await store.operate({ type: 'rename', title: 'Renamed' });
  expect(store.getSnapshot().title).toBe('Renamed');
  expect(store.getGroup().bots).toEqual(group.bots);
});

it('adopts the appearances a snapshot carries and ignores an older one', () => {
  const store = new WindowWorkspaceStore(bound());
  const window = applyGroupOperation({ window: bound() }, { type: 'rename', title: 'Remote' }).window;
  store.accept({ window, bots: { rank: 'n', members: {} }, manager: { session: window.views[0]!.binding!, generation: 1 } });
  expect(store.getGroup()).toEqual({ window, bots: { rank: 'n', members: {} } });
  store.accept(bound());
  expect(store.getSnapshot().title).toBe('Remote');
});

it('recovers a journal written before groups and one written with them', async () => {
  const legacy = new WindowWorkspaceStore(bound(), undefined, undefined, undefined,
    { recovery: { version: 1, committed: bound(), edits: [{ operation: { type: 'rename', title: 'Pending' }, revision: 0 }] } });
  expect(legacy.getSnapshot().title).toBe('Pending');
  expect(legacy.getGroup().bots).toBeUndefined();
  let saved: unknown;
  const store = new WindowWorkspaceStore({ window: bound(), bots: { rank: 'm', members: {} } },
    { async mutate() { throw new Error('Offline'); }, async operation() { throw new Error('Offline'); } } as never,
    undefined, undefined, { persist: value => { saved = value; } });
  void store.operate({ type: 'bot.update', viewId: 'main', details: { pinned: true } });
  await store.retry();
  expect(saved).toMatchObject({ version: 2, committed: { bots: { rank: 'm' } } });
  const restored = new WindowWorkspaceStore(bound(), undefined, undefined, undefined, { recovery: saved });
  expect(restored.getGroup().bots?.members).toEqual({ main: { pinned: true } });
  store.dispose();
});

it('tolerates an echo that already shows a pending appearance', async () => {
  const store = new WindowWorkspaceStore(bound());
  const pending = store.operate({ type: 'bots.add', rank: 'm' });
  store.accept({ window: store.getSnapshot(), bots: { rank: 'm', members: {} } });
  await pending;
  expect(store.getGroup().bots).toEqual({ rank: 'm', members: {} });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @orchardworks/agent-remote-lab exec vitest run src/window-workspace.test.ts`
Expected: FAIL, 5 new tests (`getGroup is not a function`, and a group operation rejected by `applyWindowOperation`).

- [ ] **Step 3: Implement the store**

In `window-workspace-store.ts`, replace the imports and the module-level helpers down to the end of `function recovery(…)` with:

```ts
import { getLayoutDiagnosticsStatus, recordWindowSelection } from './layout-diagnostics.js';
import {
  applyGroupOperation, hasWindowAppearance, isWindowGroup, isWindowGroupMutation, isWindowGroupOperation, toWindowGroup,
  type WindowBots, type WindowGroup, type WindowGroupEdit, type WindowGroupMutation, type WindowGroupOperation, type WindowPresentation, type WorkspaceWindow,
} from '@orchardworks/agent-remote-protocol';
import { WindowRequestError, type WindowCommit, type WindowWorkspaceClient } from '@orchardworks/agent-remote-web';

/** A value the store can read as a group: a Window, a group, or a Relay snapshot with its manager. */
export type WindowGroupSource = WorkspaceWindow | { window: WorkspaceWindow; bots?: WindowBots; presentation?: WindowPresentation };
export interface WindowSaveState { state: 'saved' | 'saving' | 'offline' | 'error'; pending: number; error?: string }
interface SavedEdit { operation: WindowGroupOperation; revision: number; mutation?: WindowGroupMutation; uncertain?: boolean }
export interface WindowWorkspaceRecovery { version: 2; committed: WindowGroup; edits: SavedEdit[] }
interface PendingEdit extends SavedEdit { done: Promise<void>; resolve(): void; reject(error: unknown): void }
interface Options { recovery?: unknown; persist?(value: WindowWorkspaceRecovery): void; autoRetry?: boolean; paused?: boolean }
const copy = <T>(value: T): T => structuredClone(value);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const replacesLayout = (operation: WindowGroupOperation) => operation.type === 'layout.apply' || operation.type === 'batch' && operation.operations.some(edit => edit.type === 'layout.apply');
function equivalent(first: WindowGroup, second: WindowGroup): boolean {
  return JSON.stringify({ ...first, window: { ...first.window, revision: 0 } }) === JSON.stringify({ ...second, window: { ...second.window, revision: 0 } });
}

/** An echo may already show a pending change; applying it a second time would be refused. */
function applied(group: WindowGroup, edit: WindowGroupEdit): boolean {
  switch (edit.type) {
    case 'view.create': return group.window.views.some(view => view.id === edit.view.id);
    case 'view.close': return !group.window.views.some(view => view.id === edit.viewId);
    case 'bots.add': return !!group.bots;
    case 'bots.remove': return !group.bots;
    case 'window.add': return hasWindowAppearance(group);
    case 'window.remove': return !hasWindowAppearance(group);
    default: return false;
  }
}
/** A subscription may echo a pending create/close before its receipt arrives. */
function project(source: WindowGroup, operation: WindowGroupOperation): WindowGroup {
  let result = source;
  for (const edit of operation.type === 'batch' ? operation.operations : [operation]) {
    if (applied(result, edit)) continue;
    result = applyGroupOperation(result, edit);
  }
  return { ...result, window: { ...result.window, revision: source.window.revision + 1 } };
}

function recovery(value: unknown, id: string): WindowWorkspaceRecovery | undefined {
  if (!value || typeof value !== 'object') return;
  const saved = value as { version?: unknown; committed?: unknown; edits?: unknown };
  // Version 1 journals hold the Window alone; every one of them was written before the Bot appearance existed.
  if (saved.version !== 1 && saved.version !== 2) return;
  const committed = decodeWindowGroup(saved.committed);
  if (!committed || committed.window.id !== id || !Array.isArray(saved.edits)) return;
  const edits = saved.edits as SavedEdit[];
  if (!edits.every((edit, index) => edit && isWindowGroupOperation(edit.operation) && Number.isSafeInteger(edit.revision) && edit.revision >= 0
    && (edit.uncertain === undefined || typeof edit.uncertain === 'boolean') && (!edit.uncertain || !!edit.mutation)
    && (!edit.mutation || index === 0 && isWindowGroupMutation(edit.mutation) && edit.mutation.baseRevision <= committed.window.revision
      && JSON.stringify(edit.operation) === JSON.stringify(edit.mutation.operation)))) return;
  return copy({ version: 2, committed, edits });
}
```

Add `decodeWindowGroup` to the protocol import above (it is used by `recovery`).

In the class, change the state and the constructor:

```ts
export class WindowWorkspaceStore {
  private committed: WindowGroup;
  private snapshot: WindowGroup;
```
```ts
  constructor(initial: WindowGroupSource, private readonly client?: WindowWorkspaceClient, private readonly cache?: (window: WorkspaceWindow) => void,
    private readonly localCommit?: (source: WindowGroup, operation: WindowGroupOperation) => Promise<WindowGroup>, private readonly options: Options = {}) {
    const group = toWindowGroup(initial);
    const restored = recovery(options.recovery, group.window.id);
    this.committed = restored?.committed ?? group;
```

Replace the readers:

```ts
  getSnapshot = () => this.snapshot.window;
  getCommittedSnapshot = () => this.committed.window;
  /** The group this store holds: the Window above with the appearances it is managed in. */
  getGroup = () => this.snapshot;
  getCommittedGroup = () => this.committed;
```

In `publish`, keep caching the Window: `this.cache?.(this.snapshot.window);`.

Rewrite `recordSelection` to read through `window`, and widen its operation:

```ts
  private recordSelection(previous: WindowGroup, source: Parameters<typeof recordWindowSelection>[0]['source'], operation?: WindowGroupOperation) {
    if (!getLayoutDiagnosticsStatus().recording) return;
    const sameView = previous.window.selectedViewId === this.snapshot.window.selectedViewId;
    const before = previous.window.views.find(view => view.id === previous.window.selectedViewId)?.binding;
    const after = this.snapshot.window.views.find(view => view.id === this.snapshot.window.selectedViewId)?.binding;
    const bindingChanged = sameView && (!!before !== !!after || (['hostId', 'providerId', 'nativeSessionId', 'sessionIntent'] as const)
      .some(field => before?.[field] !== after?.[field]));
    if (sameView && !bindingChanged) return;
    recordWindowSelection({ source, previous: previous.window.views.findIndex(view => view.id === previous.window.selectedViewId),
      selected: this.snapshot.window.views.findIndex(view => view.id === this.snapshot.window.selectedViewId), revision: this.snapshot.window.revision,
      pending: this.edits.length, ...(bindingChanged ? { bindingChanged: true as const } : {}), ...(operation ? { operation: operation.type } : {}) }, this);
  }
```

`accept` and `operate`:

```ts
  accept(value: WindowGroupSource) {
    const group = toWindowGroup(value);
    if (this.stopped || !isWindowGroup(group) || group.window.id !== this.committed.window.id || group.window.revision < this.committed.window.revision) return;
    const previous = this.snapshot;
    this.committed = group; this.rebuild(); this.recordSelection(previous, 'remote'); this.publish();
  }
  operate(operation: WindowGroupOperation): Promise<void> {
    try {
      if (this.stopped) throw new Error('This Window is no longer active in this account.');
      const next = applyGroupOperation(this.snapshot, operation);
      if (equivalent(this.snapshot, next)) return this.edits.at(-1)?.done ?? Promise.resolve();
      const first = this.edits.length === 0;
      const edit = this.pending({ operation: copy(operation), revision: replacesLayout(operation) ? this.committed.window.revision : this.snapshot.window.revision });
      const previous = this.snapshot;
      this.edits.push(edit); this.snapshot = next; this.recordSelection(previous, 'local', operation); this.publish(first ? 'saving' : undefined);
      if (this.sync.state !== 'offline' && this.sync.state !== 'error') void this.retry();
      return edit.done;
    } catch (error) { return Promise.reject(error); }
  }
```

In `discardPendingChanges`, read the Window through the group:

```ts
      const snapshot = await this.client!.inspect(this.committed.window.id);
      this.ensureActive();
      if (snapshot.window.revision >= this.committed.window.revision) this.committed = toWindowGroup(snapshot);
```

In `recover` and `synchronize`, replace every `this.committed.id` with `this.committed.window.id` and `this.committed.revision` with `this.committed.window.revision`, and accept the whole snapshot:

```ts
        if (next) this.accept(next);
```

In `flush`, the three Window reads and the two commits:

```ts
          if (replacesLayout(edit.operation) && edit.revision !== this.committed.window.revision) {
```
```ts
          if (operation.type === 'view.close' && !this.committed.window.views.some(view => view.id === operation.viewId)) { this.settle(edit); continue; }
          // Revalidate target preconditions after unrelated remote changes.
          try { applyGroupOperation(this.committed, edit.operation); }
          catch (error) { this.settle(edit, error); continue; }
          edit.mutation = { operationId: crypto.randomUUID(), issuedAt: Date.now(), baseRevision: this.committed.window.revision, operation: edit.operation };
```
```ts
        if (!this.client) {
          const next = this.localCommit ? await this.localCommit(this.committed, edit.operation) : applyGroupOperation(this.committed, edit.operation);
          if (this.stopped) return;
          this.committed = next; this.settle(edit); continue;
        }
        const commit = await this.send(edit);
        if (this.stopped) return;
        if (commit.window.revision >= this.committed.window.revision) this.committed = toWindowGroup(commit);
```

- [ ] **Step 4: Adapt the Lab's local commit**

In `useWindowWorkspace.ts`, add `applyGroupOperation, decodeWindowGroup, type WindowGroup, type WindowGroupOperation` to the protocol import, and replace `persistLocal` and the `localCommit` closure:

```ts
  const persistLocal = (group: WindowGroup) => conversationLocalStorage.setItem(`${key}:${group.window.id}`, JSON.stringify(group));
```
```ts
    const next = new WindowWorkspaceStore(window, client, client ? () => cache(next.getCommittedSnapshot()) : undefined, client ? undefined : async (source, operation) => {
      const commit = async () => {
        const value = decodeWindowGroup(JSON.parse(conversationLocalStorage.getItem(`${key}:${source.window.id}`) ?? 'null'));
        if (!value) throw new Error('The local Window is unavailable.');
        const replacesLayout = operation.type === 'layout.apply' || operation.type === 'batch' && operation.operations.some(edit => edit.type === 'layout.apply');
        if (replacesLayout && value.window.revision !== source.window.revision) throw new Error('The Window changed before applying this layout. Refresh and retry.');
        const result = applyGroupOperation(value, operation); persistLocal(result); return result;
      };
      return globalThis.navigator.locks ? globalThis.navigator.locks.request(`${key}:${source.window.id}`, commit) : commit();
    }, {
```

The three remaining readers of that storage keep reading a Window out of it, so a group written here is read back by a build that has not moved to the catalog yet. In `cache`, `readCached` and the local catalog scan, replace `decodeWorkspaceWindow(JSON.parse(…))` with `decodeWindowGroup(JSON.parse(…))?.window`:

```ts
      const previous = decodeWindowGroup(JSON.parse(conversationLocalStorage.getItem(`${key}:${window.id}`) ?? 'null'))?.window;
      if (!previous || previous.revision <= window.revision) conversationLocalStorage.setItem(`${key}:${window.id}`, JSON.stringify(window));
```
```ts
    try { const value = decodeWindowGroup(JSON.parse(conversationLocalStorage.getItem(`${key}:${id}`) ?? 'null'))?.window; return value?.id === id ? value : undefined; }
```
```ts
        try { const value = decodeWindowGroup(JSON.parse(conversationLocalStorage.getItem(entry) ?? 'null'))?.window; if (value) local.push(value); } catch { /* A corrupt cache is not a usable Window. */ }
```
```ts
      try { const value = decodeWindowGroup(JSON.parse(event.newValue))?.window; if (value) store.accept(value); } catch { /* Invalid data never replaces a committed snapshot. */ }
```
and in `open`, the local branch:
```ts
        else { const cached = decodeWindowGroup(JSON.parse(conversationLocalStorage.getItem(`${key}:${id}`) ?? 'null'))?.window; if (!cached || cached.id !== id) throw new Error('This local Window is unavailable.'); next = cached; }
```

`cache` still writes the Window alone, so a group's appearances live only where `persistLocal` wrote them; task 3 makes both write the group. Keep `decodeWorkspaceWindow` in the import: `pendingCreation` still uses it.

Hook `operate` validates with the group:

```ts
  const operate = (operation: WindowGroupOperation): Promise<void> => {
    const active = currentStore.current;
    if (!active || currentlyUnavailable.current || !inScope()) throw new Error('Open an available Window before editing its layout.');
    applyGroupOperation(active.getGroup(), operation);
```

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @orchardworks/agent-remote-lab exec vitest run src/window-workspace.test.ts src/window-workspace.local-first.test.ts src/window-workspace.recovery.test.ts src/layout-diagnostics.test.ts src/window-titles.test.ts src/window-binding-queue.test.ts
pnpm --filter @orchardworks/agent-remote-lab exec vitest run src/hooks/useWindowWorkspace.test.tsx src/hooks/useWindowWorkspace.local-first.test.tsx src/hooks/useWindowWorkspace.deleted-journal.test.tsx src/hooks/useSessionSuccession.window.test.tsx
pnpm --filter @orchardworks/agent-remote-lab exec tsc --noEmit
```
Expected: all pass, including the 5 new tests. Every existing store construction and `accept` call keeps working through the normalization.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-remote-lab/src/window-workspace-store.ts packages/agent-remote-lab/src/window-workspace.test.ts packages/agent-remote-lab/src/hooks/useWindowWorkspace.ts
git commit -m "feat(lab): keep a Window's Bot appearance in its store"
```

---

### Task 3: A catalog of groups

**Files:**
- Modify: `packages/agent-remote-lab/src/hooks/useWindowWorkspace.ts`
- Modify: `packages/agent-remote-lab/src/hooks/useWindowWorkspace.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `useWindowWorkspace.test.tsx`, make the fixtures serve groups. Add below `windowFixture`:

```ts
const groupsOf = (...windows: WorkspaceWindow[]) => windows.map(window => ({ window }));
```

In `hostedWindows`, replace the `list` spy with a `listGroups` spy and keep returning it under the same name:

```ts
  const list = vi.spyOn(WindowWorkspaceClient.prototype, 'listGroups').mockImplementation(async () => [...documents.values()].map(window => ({ window })));
```

Replace every other `vi.spyOn(WindowWorkspaceClient.prototype, 'list')` with `…, 'listGroups')`, wrapping its windows: `mockResolvedValue([first, second])` becomes `mockResolvedValue(groupsOf(first, second))`, and `mockResolvedValue([])` stays as it is. There are ten such lines (136, 160, 223, 238, 251, 283, 302, 571, 617, 641); check with `grep -n "prototype, 'list'" src/hooks/useWindowWorkspace.test.tsx` that none is left.

Append:

```ts
it('lists every group but offers only the Windows, and opens a group with its section', async () => {
  const plain = windowFixture('plain'), both = windowFixture('both'), only = windowFixture('section-only');
  vi.spyOn(WindowWorkspaceClient.prototype, 'listGroups').mockResolvedValue([
    { window: plain },
    { window: both, bots: { rank: 'm', members: {} } },
    { window: only, bots: { rank: 'n', members: {} }, presentation: { window: false } },
  ]);
  vi.spyOn(WindowWorkspaceClient.prototype, 'inspect').mockImplementation(async id => id === both.id
    ? { window: both, bots: { rank: 'm', members: {} } } : { window: id === plain.id ? plain : only });
  vi.spyOn(WindowWorkspaceClient.prototype, 'changes').mockImplementation((_id, _revision, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  history.replaceState(null, '', `/?window=${both.id}`);
  const read = await mount('catalog-groups', true);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(read().groups.map(group => group.window.id).sort()).toEqual(['both', 'plain', 'section-only']);
  expect(read().windows.map(window => window.id).sort()).toEqual(['both', 'plain']);
  expect(read().group?.bots).toEqual({ rank: 'm', members: {} });
});

it('saves a section added to the open Window and keeps it in the catalog', async () => {
  const window = windowFixture('becomes-section');
  const hosted = hostedWindows(window);
  const mutate = vi.spyOn(WindowWorkspaceClient.prototype, 'mutate').mockImplementation(async (id, mutation) => {
    const group = applyGroupOperation({ window: hosted.documents.get(id)! }, mutation.operation);
    hosted.documents.set(id, group.window);
    return { ...group, result: { operationId: mutation.operationId, status: 'committed' as const, revision: group.window.revision, committedAt: 1, expiresAt: 100 } };
  });
  history.replaceState(null, '', `/?window=${window.id}`);
  const read = await mount('add-section', true);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  await act(async () => { await read().operate({ type: 'bots.add', rank: 'm' }); });
  expect(mutate.mock.calls[0]?.[1].operation).toEqual({ type: 'bots.add', rank: 'm' });
  expect(read().group?.bots).toEqual({ rank: 'm', members: {} });
  expect(read().groups.find(group => group.window.id === window.id)?.bots).toEqual({ rank: 'm', members: {} });
});
```

Add `applyGroupOperation` to the protocol import of that file.

Still in `useWindowWorkspace.test.tsx`, whose `mount` runs the workbench without a client, append:

```ts
it('keeps a local section across a reload and still opens a Window stored before groups', async () => {
  const read = await mount('local-section');
  const id = read().window!.id;
  await act(async () => { await read().operate({ type: 'bots.add', rank: 'm' }); });
  expect(read().group?.bots).toEqual({ rank: 'm', members: {} });
  const stored = JSON.parse(conversationLocalStorage.getItem(`agent-remote:recovery:local-section:shared-window:${id}`)!);
  expect(stored).toMatchObject({ window: { id }, bots: { rank: 'm' } });
  await act(async () => root!.unmount()); root = undefined;
  const again = await mount('local-section');
  expect(again().groups.find(group => group.window.id === id)?.bots).toEqual({ rank: 'm', members: {} });

  const legacy = { schemaVersion: 3, id: 'legacy', revision: 0, title: 'Legacy', selectedPrimaryViewId: 'main', selectedViewId: 'main',
    views: [createWindowView('main', undefined, 'primary')] };
  conversationLocalStorage.setItem('agent-remote:recovery:local-legacy:shared-window:legacy', JSON.stringify(legacy));
  const stale = await mount('local-legacy');
  await act(async () => stale().open('legacy'));
  expect(stale().window?.id).toBe('legacy');
  expect(stale().group?.bots).toBeUndefined();
});
```

`conversationLocalStorage`, `createWindowView` and `root` are already in that file; add only `applyGroupOperation` to its protocol import. `useWindowWorkspace.local-first.test.tsx` needs no edit: it mounts with a client, and its `saveCache` writes a bare Window under the same key, so it already covers reading a layout stored before groups.

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @orchardworks/agent-remote-lab exec vitest run src/hooks/useWindowWorkspace.test.tsx src/hooks/useWindowWorkspace.local-first.test.tsx`
Expected: FAIL — `read().groups` and `read().group` are undefined, and the hosted tests call a `listGroups` the hook never uses.

- [ ] **Step 3: Implement**

In `useWindowWorkspace.ts`:

Add `hasWindowAppearance, toWindowGroup, type WindowGroup` to the protocol import (`applyGroupOperation`, `decodeWindowGroup`, `WindowGroupOperation` came in task 2).

Hold the catalog as groups and derive the Windows:

```ts
  const [groups, setGroups] = useState<WindowGroup[]>([]);
  const windows = useMemo(() => groups.filter(hasWindowAppearance).map(group => group.window), [groups]);
```
(replacing `const [windows, setWindows] = useState<WorkspaceWindow[]>([]);`)

`cache`, `readCached`, `choose` and `makeStore` take the group:

```ts
  const cache = (group: WindowGroup) => {
    if (selection.deleted.has(group.window.id)) return;
    try {
      const previous = decodeWindowGroup(JSON.parse(conversationLocalStorage.getItem(`${key}:${group.window.id}`) ?? 'null'))?.window;
      if (!previous || previous.revision <= group.window.revision) persistLocal(group);
    } catch { /* The service remains authoritative when cache storage is unavailable. */ }
  };
```
```ts
  const choose = (group: WindowGroup, created = false, confirmed = true) => {
    const window = group.window;
    if (!inScope() || selection.deleted.has(window.id) || deletions.get(window.id)?.dispatched) return;
    if (created && !client) persistLocal(group);
    const next = makeStore(group);
    if (confirmed) { next.accept(group); confirmedStores.add(next); }
    if (client) cache(next.getCommittedGroup());
    …unchanged from `if (confirmed) commitImportedWindowComposition(…)` to the end…
  };
  const readCached = (id: string): WindowGroup | undefined => {
    const existing = stores.get(id); if (existing) return existing.getCommittedGroup();
    try {
      const journal = JSON.parse(conversationSessionStorage.getItem(`${key}:pending:${id}`) ?? 'null');
      const committed = decodeWindowGroup(journal?.committed);
      if (committed?.window.id === id) return committed;
    } catch { /* Fall back to the last confirmed layout. */ }
    try { const value = decodeWindowGroup(JSON.parse(conversationLocalStorage.getItem(`${key}:${id}`) ?? 'null')); return value?.window.id === id ? value : undefined; }
    catch { return undefined; }
  };
  const makeStore = (group: WindowGroup) => {
    const existing = stores.get(group.window.id); if (existing) return existing;
    let recovery: unknown;
    try { recovery = JSON.parse(conversationSessionStorage.getItem(`${key}:pending:${group.window.id}`) ?? 'null'); } catch { /* Invalid journals do not replace a confirmed layout. */ }
    const next = new WindowWorkspaceStore(group, client, client ? () => cache(next.getCommittedGroup()) : undefined, client ? undefined : async (source, operation) => {
      …the closure from task 2, unchanged…
    }, {
      recovery, autoRetry: true, paused: !access.current,
      persist: value => {
        if (selection.deleted.has(group.window.id)) return;
        if (value.edits.length) conversationSessionStorage.setItem(`${key}:pending:${group.window.id}`, JSON.stringify(value));
        else conversationSessionStorage.removeItem(`${key}:pending:${group.window.id}`);
      },
    });
    stores.set(group.window.id, next);
    next.setEnabled(access.current);
    return next;
  };
```

Note that `cache` now calls `persistLocal`, so a hosted cache keeps the appearances too.

The catalog writers:

```ts
  const updateCatalog = (group: WindowGroup) => { if (inScope() && !selection.deleted.has(group.window.id)) setGroups(current => current.some(item => item.window.id === group.window.id)
    ? current.map(item => item.window.id === group.window.id ? group : item) : [...current, group]); };
```
and in `forgetDeletedWindow`: `setGroups(current => current.filter(item => item.window.id !== id));`.

The restore effect. The recovery scan and the local branch keep groups:

```ts
        if (cached && !selection.deleted.has(id)) makeStore(cached);
```
```ts
    const restore = async (group: WindowGroup) => {
      if (!live()) return;
      const operation = target && sessionLinkOperation(group.window, target);
      choose(group);
      if (operation) { const pending = makeStore(group).operate(operation); void pending.catch(error => { if (live()) setError(String(error.message ?? error)); }); }
    };
    if (!client) {
      const local: WindowGroup[] = [];
      for (const entry of conversationLocalStorage.keys().filter(entry => entry.startsWith(`${key}:`))) {
        try { const value = decodeWindowGroup(JSON.parse(conversationLocalStorage.getItem(entry) ?? 'null')); if (value) local.push(value); } catch { /* A corrupt cache is not a usable Window. */ }
      }
      setGroups(local);
      if (requested && !cached) { setError('This Window is unavailable in the local workbench.'); setUnavailable(true); }
      else {
        const existing = cached ?? local[0];
        try {
          if (existing && !target) choose(existing);
          else if (existing) void Promise.resolve().then(() => restore(existing)).catch(error => { if (live()) setError(String(error.message ?? error)); });
          else { const imported = initialWindow(); choose({ window: imported }, true); }
        } catch (error) { setError(String(error instanceof Error ? error.message : error)); }
      }
    }
```
and `if (client && cached && !target) choose(cached, false, false);` keeps working because `cached` is now a group.

The hosted restore reads every group and offers only the Windows:

```ts
    const restoreHosted = async () => {
      if (!live()) return;
      const all = (await client.listGroups()).filter(group => !selection.deleted.has(group.window.id)); if (!current || generation !== selection.generation) return;
      setGroups(all.map(group => stores.get(group.window.id)?.getGroup() ?? group));
      // Only a group shown as a Window can be opened here; a section alone belongs to Bot mode.
      const list = all.filter(hasWindowAppearance);
      // A background journal may outlive a Window deleted on another page.
      // Catalog omission alone is insufficient proof, and its inspection must not delay opening the selected Window.
      const listed = new Set(all.map(group => group.window.id));
      for (const [id, pending] of stores) {
        if (listed.has(id) || id === currentStore.current?.getSnapshot().id || !pending.getSyncState().pending) continue;
        void client.inspect(id).catch(error => {
          if (live() && stores.get(id) === pending && error instanceof WindowRequestError && error.status === 404) forgetDeletedWindow(id);
        });
      }
      if (requested) { const next = await client.inspect(requested); if (live()) choose(toWindowGroup(next)); return; }
      if (!pendingCreation()) {
        const ids = [...new Set([...preferredIds(), ...list.map(group => group.window.id)])].filter(id => list.some(group => group.window.id === id));
        for (const id of ids) {
          let next: WindowSnapshot;
          try { next = await client.inspect(id); }
          catch (error) {
            if (!live()) return;
            if (!(error instanceof WindowRequestError) || error.status !== 404) throw error;
            forgetDeletedWindow(id);
            continue;
          }
          await restore(toWindowGroup(next)); return;
        }
      }
      if (!live()) return;
      const { candidate, snapshot: next } = await createHosted(initialWindow, false);
      if (live()) { commitImportedWindowComposition(composition, candidate, next.window); await restore(toWindowGroup(next)); }
    };
```

A requested group without a Window appearance still opens here, as it does today for any id in the URL; Bot mode decides what to do with it in milestone 2b.

Publish the group and keep the catalog in step:

```ts
  const window = useSyncExternalStore(store?.subscribe ?? (() => () => {}), store?.getSnapshot ?? (() => undefined));
  const group = useSyncExternalStore(store?.subscribe ?? (() => () => {}), store?.getGroup ?? (() => undefined));
  const saveState = useSyncExternalStore(store?.subscribe ?? (() => () => {}), store?.getSyncState ?? (() => undefined));
  useEffect(() => {
    if (!group) return;
    updateCatalog(group);
  }, [group]);
```

In the storage event, accept the whole group:

```ts
      try { const value = decodeWindowGroup(JSON.parse(event.newValue)); if (value) store.accept(value); } catch { /* Invalid data never replaces a committed snapshot. */ }
```

The returned value gains `group` and `groups`, keeps `windows`, and the three entry points take groups:

```ts
  return { window, group, windows, groups, error, client, deleted, deletedWindowIds, hasActiveWindow, saveState, …unchanged… ,
```
```ts
      if (cached) { choose(cached, false, !client); setError(undefined); }
      let next: WindowGroup;
      try {
        if (client) next = toWindowGroup(await client.inspect(id));
        else { const cached = decodeWindowGroup(JSON.parse(conversationLocalStorage.getItem(`${key}:${id}`) ?? 'null')); if (!cached || cached.window.id !== id) throw new Error('This local Window is unavailable.'); next = cached; }
      } catch (error) {
        if (generation !== selection.generation) return;
        if (error instanceof WindowRequestError && error.status === 404) forgetDeletedWindow(id);
        throw error;
      }
      if (generation !== selection.generation) return;
      setError(undefined); choose(next);
```
```ts
    async create() {
      const generation = ++selection.generation;
      let created: WindowGroup;
      const candidate = () => unavailable ? emptyWindow() : importCompositionWindow(composition);
      if (client) { const { candidate: original, snapshot } = await createHosted(candidate, true); if (generation !== selection.generation) return; created = toWindowGroup(snapshot); commitImportedWindowComposition(composition, original, created.window); }
      else created = { window: candidate() };
      choose(created, true); setError(undefined); setGroups(current => [...current.filter(group => group.window.id !== created.window.id), created]);
    },
```
and in `rename`, `updateCatalog(store.getSnapshot())` becomes `updateCatalog(store.getGroup())` in both places.

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @orchardworks/agent-remote-lab exec vitest run src/hooks src/window-workspace.test.ts src/window-workspace.local-first.test.ts src/window-workspace.recovery.test.ts src/window-binding-queue.test.ts
pnpm --filter @orchardworks/agent-remote-lab exec tsc --noEmit
```
Expected: all pass, including the three new tests.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-remote-lab/src/hooks/useWindowWorkspace.ts packages/agent-remote-lab/src/hooks/useWindowWorkspace.test.tsx
git commit -m "feat(lab): keep a catalog of groups beside the Windows it offers"
```

---

### Task 4: Document and verify the milestone

**Files:**
- Modify: `docs/current/agent-remote/window-groups.md`
- Modify: `docs/superpowers/specs/2026-11-08-bot-view-design.md`

- [ ] **Step 1: Document what the browser holds**

Append to `docs/current/agent-remote/window-groups.md`:

```markdown
## In the browser

`WindowWorkspaceStore` (`packages/agent-remote-lab/src/window-workspace-store.ts`) holds a group. It reads a Window, a group or a Relay snapshot as one group, because every Window is a group with only the Window appearance, and keeps its Window-shaped readers: `getSnapshot()` and `getCommittedSnapshot()` answer the Window, `getGroup()` and `getCommittedGroup()` the group. Group edits are applied at once and saved in the background like layout edits, through the same receipts and revisions. Its recovery journal is version 2 and holds the group; a version 1 journal, written before groups, is read as a Window.

`useWindowWorkspace` keeps a catalog of groups (`listGroups`) and offers `windows`, the groups with a Window appearance, to the Window workbench: a group that is only a section is in `groups` but not in `windows`, and is never restored as the open Window. The local-first Lab mode stores each group whole under `agent-remote:recovery:<scope>:shared-window:<id>`; a Window stored there before groups still loads, as the group with only the Window appearance.
```

- [ ] **Step 2: Record the split in the design**

In `2026-11-08-bot-view-design.md`, replace milestone 2 with:

```markdown
2. **Bot mode.** In two parts. **2a, the group in the browser:** the store keeping the Bot appearance beside its Window with its own recovery journal, a catalog of groups, the local-first Lab mode storing the group; no visible change. **2b, the page:** the mode switch (Window mode by default); roster of sections and bots with status; the fallback group; a bot's page in Content only; Show as section on a Window; New section; each mode returning to what it had open (rule 6); notifications following the mode; compact layout.
```

- [ ] **Step 3: Verify the milestone**

```bash
pnpm lint:docs
pnpm -r run build
pnpm typecheck
node scripts/run-tests.mjs affected $(git merge-base HEAD origin/main)
pnpm compatibility:update && pnpm compatibility:check
```
Expected: docs lint passes; build and typecheck clean; every affected package's tests pass; the compatibility digest updates.

- [ ] **Step 4: Commit and report**

```bash
git add docs packages/agent-remote-lab/compatibility.json
git commit -m "docs: describe the group the browser holds"
```

Report the results. Nothing here is outward-facing: no Relay change, no deployment, no Controller release. Ask the owner before merging or pushing.

---

## Deferred to milestone 2b

- A `?window=` link to a group that is only a section opens it in the Window workbench; mode routing decides this.
- `windows` is derived on every catalog change; if the roster needs a different order, sort it where it is shown.
- Nothing reads `bots` yet: the roster, statuses, the fallback group, the bot's page and notifications are all 2b.
