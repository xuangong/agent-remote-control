# Bot Mode Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver milestone 2b: a Bot roster and Content only conversation over the existing groups, with independent Window/Bot navigation, shared view drafts, and mode-scoped attention.

**Architecture:** Keep `useWindowWorkspace` and its `WindowWorkspaceStore` instances as the single group authority. Add independent presentation/navigation state and reuse the existing session leaf through a small, page-scoped stable-host registry, so a view has one composer even when both modes can show it. App supplies existing services and renders the existing Window page once; Bot components own roster and presentation, never a second grouping model or native session client.

**Tech Stack:** React 18, TypeScript, existing protocol/web clients, Vitest with jsdom, Playwright, existing `pnpm local` instance tooling.

**Spec:** `docs/superpowers/specs/2026-11-08-bot-view-design.md`, milestone 2b. The direction is accepted; the document's older `proposed` heading does not reopen design approval. Also read `PRODUCT.md`, `DESIGN.md`, and this checkout's `AGENTS.md`.

## Global Constraints

- "Window mode stays the default."
- "Pictures are a shape and a color; no generated or uploaded images."
- "Notifications follow the mode: each mode reminds only of what it manages (see Bot mode)."
- "A session in no Window belongs to the fallback group, so every session has a group."
- "One mode at a time, each with its own place."
- "A bot's draft is its view's draft, so text typed to a bot is still there when the same session is opened in Window mode, and the other way round."
- "This presentation is fixed for Bot mode and does not change the view's own display setting, which belongs to Window mode."
- "Compact screens. The roster is the home screen; a bot opens full screen with Back."
- Use one `WindowGroup` catalog, `groupBotViews`/`isBotView`, and existing composition slots. Do not copy membership into local storage or derive a second set of groups from the roster.
- Milestones 3–5 remain deferred: creation/addition of bots, editing labels/pictures, pin/hide controls, reorder, transfer/remove, Window close/rebind behavior changes, linking/conversion, CLI additions, Threads, read positions/New result, manager and Team pages. Render existing label/picture/pin/hidden metadata correctly without adding their editors.
- A new section can be empty. Show: `No bots in this section yet. Organize sessions in a Window, then choose Show as section.` Include the mode switch, not a nonfunctional New bot button. A section need not support population until milestone 3.
- Preserve existing Window UI, layout selection, native interpretation boundaries, uncertainty/no-replay behavior, and unrelated work. Do not publish, push, deploy, or touch production/the user's Controller/browser.
- All tests need per-test and outer process deadlines. `pnpm test` and `pnpm test:e2e` already provide outer deadlines. Focused test commands below add an explicit outer deadline.
- After reviewed implementation changes, run `pnpm compatibility:update`, then `pnpm compatibility:check`. Website validation must include this worktree's `pnpm local up` under `.agents/skills/prepare-arc-local/SKILL.md`.

---

## Read This Before Editing

Baseline inspected for this plan: milestone 2a tasks 1–3 at `dd9eaa61`; the parent worker is closing its review. Start from the parent's final 2a commit, preserve its corrections, and adapt line references to current code. This plan changes no code by itself.

Important existing behavior:

- `useWindowWorkspace.ts` owns one store per group, cached/journaled group snapshots, the catalog, and the selected Window. Its `choose` currently writes `?window=`, session storage and last-Window storage. `open()` is consequently **not** a Bot selection API.
- `useWindowSessionBridge.ts` calls `succession.projectWindow/open` and honors `selectedPrimaryViewId`. Bot selection must never use that path or `view.select` merely to display a bot.
- `ensureWindowCompositionSlot`/`succession.ensureWindowView` preserve a view's owners through a verified role succession. `windowSuccessionLayout` produces the authorized `layout.apply`; it must also reach a selected section that is not the active Window.
- `SessionFamily` currently contains `FamilySession` (attachment/owner handling) and `FamilyChat` (the shared conversation leaf). `LabWorkbench` adds product draft/operation/display policy; `SessionWorkbench` renders timeline/composer. Reuse these layers.
- `ConversationConnections` already pools `RemoteSessionClient` by agent. That alone does not share `AgentComposer`'s mount-local pending sends, interactions and settings state. Keep one leaf mount for a shared view.
- `SessionDock.tsx:moveSessionHost` already moves a stable portal host without remounting its content. Use that mechanism, including focus/selection preservation.
- `useSessionTracking` currently unions tracked, open, and Ask sessions. `setDisplayed` only arbitrates notification delivery across tabs; it does **not** filter eligibility. Both observation membership and notifier eligibility must follow the mode.

## File Ownership and Contracts

Paths below are relative to `packages/agent-remote-lab/src/` unless stated otherwise.

| File | Responsibility |
| --- | --- |
| `bot-roster.ts` | Pure projection, deterministic ordering, fallback exclusion, status copy. |
| `workbench-mode.ts` and `hooks/useWorkbenchMode.ts` | Mode preference, Bot place, route parsing/writing, history transitions. No group edits. |
| `hooks/useWindowWorkspace.ts` | Extend existing controller with group-scoped read/edit/watch/create access; retain selected Window semantics. |
| `hooks/useBotWorkspace.ts` | Selected Bot/section, group watch leases, slot enrollment and verified succession layout reconciliation. |
| `hooks/useOtherSessions.ts` | Directory pages across authorized Host/provider sources; no membership storage or automatic attach. |
| `components/SessionConversation.tsx` | Extract existing `FamilySession` and `FamilyChat`, preserving behavior and notices. |
| `components/SessionConversationSurfaces.tsx` | One stable portal host/leaf per composition slot; active destination and cleanup. |
| `components/SessionFamily.tsx` | Keep Window family geometry/navigation; register ordinary leaves with the surface owner. |
| `components/LabWorkbench.tsx`, `components/SessionWorkbench.tsx` | Explicit fixed display policy, independent of stored Window settings. |
| `components/WorkbenchModeSwitch.tsx`, `components/BotRoster.tsx`, `components/BotWorkspace.tsx`, `components/bot-workspace.css` | Accessible switch, roster, header, empty/error/loading states, desktop/compact layout. |
| `components/WindowWorkspaces.tsx`, `components/WindowMenu.tsx` | Show as section; preserve Window-only listing/link behavior. |
| `hooks/useSessionTracking.tsx`, `session-notifications.ts` | Explicit mode observation and notification scopes, async delivery fencing. |
| `App.tsx` | Wire existing services/contexts, switch visible shell, provide scoped presentation callbacks. No duplicated Window JSX. |
| `App.bot-mode.test.tsx`, `App.bot-succession.test.tsx`, focused file tests, `../e2e/bot-mode.spec.ts` | Observable state, ownership, transport, URL, notification and geometry regressions. |

The four tasks below are ordered. Each includes its own red/green cycle and a local commit. Do not start the next task until its predecessor's focused checks pass and its diff is reviewed.

### Task 1: Group Access, Roster Projection and Independent Navigation

**Files:** Create `bot-roster.ts`, `bot-roster.test.ts`, `workbench-mode.ts`, `workbench-mode.test.ts`, `hooks/useWorkbenchMode.ts`, `hooks/useWorkbenchMode.test.tsx`, `hooks/useBotWorkspace.ts`, `hooks/useBotWorkspace.test.tsx`, `hooks/useOtherSessions.ts`, `hooks/useOtherSessions.test.tsx`. Modify `hooks/useWindowWorkspace.ts`; add `hooks/useWindowWorkspace.bot.test.tsx`.

**Interfaces:** Export these types from `workbench-mode.ts` and `bot-roster.ts`:

```ts
export type WorkbenchMode = 'window' | 'bot';
export type BotPlace =
  | { kind: 'section'; groupId: string }
  | { kind: 'bot'; groupId: string; viewId: string }
  | { kind: 'session'; session: SessionEntry };
export interface BotRow {
  groupId: string; viewId: string; binding: WindowSessionBinding;
  details: WindowBotDetails; status?: 'Needs you' | 'Working' | 'Failed';
}
export interface BotSection {
  groupId: string; title: string; rows: BotRow[];
  status?: 'Needs you' | 'Working' | 'Failed';
}
export interface BotRosterModel { sections: BotSection[]; other: SessionEntry[] }
export function projectBotRoster(
  groups: readonly WindowGroup[], directory: readonly SessionEntry[],
  status: (binding: WindowSessionBinding) => SessionActivityStatus,
): BotRosterModel;
export function botActivityLabel(status: SessionActivityStatus | undefined): BotRow['status'];
```

Extend the existing workspace return value; these methods share `stores`, journals and `groups` with Window actions:

```ts
export interface GroupHandle {
  getGroup(): WindowGroup;
  getSyncState(): WindowSaveState;
  subscribe(listener: () => void): () => void;
  operate(operation: WindowGroupOperation): Promise<void>;
  retry(): Promise<void>;
  release(): void;
}
// Added to ReturnType<typeof useWindowWorkspace>:
acquireGroup(id: string): Promise<GroupHandle>;
readGroup(id: string): WindowGroup | undefined;
operateGroup(id: string, operation: WindowGroupOperation): Promise<void>;
createSection(title: string): Promise<string>;
refreshGroups(): Promise<void>;
// Optional sixth hook argument; old callers keep today's Window behavior:
interface WorkspaceNavigation {
  mode: WorkbenchMode;
  onSectionRoute(groupId: string): void;
}
```

`useWorkbenchMode(scope)` returns `{ mode, place, rosterVisible, setMode(mode), select(place), back(), acceptSectionRoute(groupId) }`; setter parameters use the types above and return `void`. `useBotWorkspace(workspace, succession, place, enabled)` returns `{ group, view, slot, loading, error, saveState, retry, refresh }`; its `succession` parameter is a `Pick<ReturnType<typeof useSessionSuccession>, 'document' | 'ensureWindowView' | 'save' | 'refresh' | 'discovering'>`. It never calls `open`, `leave` or `projectWindow`. `useOtherSessions(sources, enabled)` returns `{ sessions, sources, refresh, loadMore }`, where a source is `{ id: string; hostId: string; providerId: string; directory: SessionDirectoryClient; online: boolean }`; returned source state adds `{ loading: boolean; hasMore: boolean; error?: string; expired: boolean }`. `refresh(id?: string)` and `loadMore(id: string)` return `Promise<void>`.

- [ ] **Step 1: Write projection and route red tests.** Use real `WindowGroup` fixtures, not a new Bot data fixture format. A compact complete projection example:

```ts
const binding = (id: string): WindowSessionBinding =>
  ({ hostId: 'host', providerId: 'recorded', nativeSessionId: id, title: id });
const windowOf = (id: string, views: WindowView[]): WorkspaceWindow =>
  ({ schemaVersion: 3, id, revision: 0, title: id, views,
     selectedPrimaryViewId: views.find(v => v.placement === 'primary')?.id ?? null,
     selectedViewId: views[0]?.id ?? null });
it('derives Other sessions against all groups, including non-bot views', () => {
  const section: WindowGroup = { window: windowOf('section', [
    createWindowView('one', binding('one'), 'primary'),
    createWindowView('hidden', binding('hidden'), 'dock'),
  ]), bots: { rank: 'm', members: { hidden: { hidden: true } } } };
  const ordinary: WindowGroup = { window: windowOf('ordinary', [
    createWindowView('history', { ...binding('past'), sessionIntent: 'history' }, 'primary'),
  ]) };
  const result = projectBotRoster([section, ordinary],
    ['one', 'hidden', 'past', 'loose'].map(binding), () => 'starting');
  expect(result.sections[0]?.rows.map(row => row.viewId)).toEqual(['one']);
  expect(result.sections[0]?.status).toBe('Needs you');
  expect(result.other.map(session => session.nativeSessionId)).toEqual(['loose']);
});
```

Add cases for primary/dock/float, all `isBotView` exclusions, pinned before rank, absent member rank preserving document order, section rank then ID ties, hidden exclusion from status, `waiting > failed > running`, and idle/offline/unknown with no Bot status badge. Rank comparison uses lexical `<`/`>`, not locale-dependent ordering. Fallback excludes every binding in **all** groups, deduplicates by host/provider/native tuple, and sorts `updatedAt`, then `createdAt`, descending, then identity; missing timestamps sort last.

- [ ] **Step 2: Run red tests with both deadlines.**

```bash
python3 -c 'import subprocess; subprocess.run(["pnpm","--filter","@orchardworks/agent-remote-lab","exec","vitest","run","src/bot-roster.test.ts","src/workbench-mode.test.ts","--testTimeout=10000","--hookTimeout=15000","--maxWorkers=1"],check=True,timeout=180)'
```

Expected: missing projection/route exports or the added assertions fail. A dependency/startup failure is not a useful red test.

- [ ] **Step 3: Implement projection and navigation.** Persist only mode in `localStorage['agent-remote:workbench-mode']`; invalid/missing values mean `window`. Persist Bot place through `conversationSessionStorage` under `agent-remote:recovery:${scope}:bot-place`; keep existing Window place keys untouched. Serialize only the locator/title fields of fallback selection, never agent credentials or transient attachment IDs. Storage failures preserve page-local operation.

```ts
export function botActivityLabel(value: SessionActivityStatus | undefined): BotRow['status'] {
  if (value === 'waiting' || value === 'starting') return 'Needs you';
  if (value === 'running') return 'Working';
  if (value === 'failed') return 'Failed';
}
// Selection identifies the view, never its current native session.
const selected = place?.kind === 'bot'
  ? group?.window.views.find(view => view.id === place.viewId && isBotView(view))
  : undefined;
```

Use `groupBotViews`, existing `windowActivity`, and `sessionKey`. Do not infer native activity from directory `state`. Bot route is `?mode=bot&section=<group>&bot=<view>`; section-only route omits `bot`. Fallback route uses `mode=bot&host=...&provider=...&session=...` and no `window`, `section` or `bot`. Explicit Window/session links without `mode=bot` take precedence over a stored Bot preference. No explicit route uses stored mode/place. Mode switching restores the destination mode's own route, not the source's target. Keep non-navigation query parameters. Use `replaceState` for mode-local canonicalization; listen to `popstate`; no effect-generated history loop.

Capture the last Window route's navigation fields before leaving it in `conversationSessionStorage['agent-remote:recovery:${scope}:window-route']`; no group snapshot is stored there. On first loading an explicit Bot route, switching to Window without a captured route removes Bot/native-target parameters and lets the existing last-Window chooser restore its own Window. A common route-writing helper owns the navigation keys `mode`, `window`, `section`, `bot`, `host`, `provider`, `session`, `parent`, `intent`, `agent` and `keepOriginal`; preserve unrelated parameters. Do not copy Bot's native locator into this saved Window route.

`back()` sets `rosterVisible=true` on compact screens while retaining the last bot identity. `select` sets it false for a bot/session and true for an empty section. Persist this flag beside `place`, so returning from Window restores the Bot home/conversation the user actually left. Explicit Bot deep links open their conversation; a first visit with no saved place opens the roster. A selected missing/hidden/ineligible bot shows an unavailable notice and roster; do not silently select a different bot. Re-enabling Window mode restores its stored Window and selection without writing `view.select`.

- [ ] **Step 4: Add group-controller red tests, then implement the methods.** Reuse the `mount`/local cache pattern in `hooks/useWindowWorkspace.test.tsx`. Assert acquiring/editing/watching B while Window A is selected leaves `window.id`, selected view IDs, `?window=` and both last-Window keys unchanged. Two leases for B and Window+B for the same group share one `changes` loop. Local writes use the existing lock and `applyGroupOperation`; background store subscriptions update the same catalog. Release is idempotent and aborts only the final watch lease; pending mutation recovery remains alive under the existing controller. Disable/dispose on scope/access change; reject late inspect/list responses using scope and generation fences.

Explicit `?window=<section-only-id>` must inspect it, call `onSectionRoute(id)`, and never choose it as a Window, import a new Window, consume stale `host/provider/session`, or attach stale last-session state. Cached data cannot override a confirmed absence of Window appearance. Window-mode `open(id)` rejects section-only groups even if called directly; preferred IDs and local-first restoration filter `hasWindowAppearance`. When Bot mode starts with only sections, load the catalog without creating a Window. Later switching to Window initializes it using existing policy. Keep the Window store mounted when switching away, but suppress its URL writes and user-navigation side effects.

`createSection` makes one group with a single empty primary view, title supplied by a trimmed required input (max 256), `bots: { rank, members: {} }`, and `presentation: { window: false }`. Empty view is not a bot. Use a valid rank `'m'`; append by `lastRank + 'm'` while length <=64, otherwise reuse the final rank and stable ID tie-break. Reordering/rebalancing is deferred.

Keep its exact request separately at `${key}:pending-section-create`, including `{ group, operationId, issuedAt }`. Persist before POST. Submit via `client.createGroup(group, identity)`; recovery uses read-only `recoverCreate(group.window, identity)` and adopts the inspected **full** group. Only explicit Retry may resubmit the exact original group/identity after an unknown result. A new title or click never replaces an unsettled request. Known rejection clears it; uncertainty retains it. Local creation persists the same group envelope. Neither path calls `choose` or imports the current Window composition.

- [ ] **Step 5: Enroll Bot slots and reconcile succession without changing Window selection.** On selecting a group, acquire its shared handle; after confirmed data, call `succession.ensureWindowView(groupId, viewId, binding)` for its ordinary views, and `save()` only if `document.editRevision` changed. Call existing `refresh()` once for a newly enrolled locator set, with generation guards. After discovery completes, compute `windowSuccessionLayout(document, currentGroup.window)` and submit through `operateGroup`; coalesce by group/revision/operation. Do not synthesize `view.bind`, role evidence or replacement sessions. Re-read the group before dispatch; let the existing layout conflict path fence stale replacements. Subscribe section groups needed by the roster while Bot mode is active; share leases with the selected group and active Window. Catalog refresh on entry/focus and explicit Refresh discovers added/removed sections; only confirmed deletion retires a group, never catalog omission alone.

Test a confirmed role handoff A→B with unchanged `{groupId, viewId}` and unchanged text/image owners, current binding B, untouched unrelated Window selection, and one `layout.apply`. Test pending/failed discovery, stale source binding, deleted selected group, scope changes, late `acquireGroup` completion, and StrictMode setup/cleanup. Release a handle returned after cancellation immediately.

- [ ] **Step 6: Implement fallback directory reads with generation tests.** Build source descriptors from the authorized Host/provider catalog and the existing local Lab providers; do not scan arbitrary machines. Fetch first pages only while Bot mode is active. Retain per-source cached pages while temporarily offline, show an offline/error hint, and do not claim a complete catalog. Merge loaded pages globally, offer source-specific Load more, and preserve explicit Refresh after `cursor_expired`. Never silently restart pagination or automatically attach listed sessions. Abort old requests and reject late results on source/mode/access changes. A test resolves source A after replacing it with B and verifies A does not reappear; another confirms a grouped session vanishes from fallback immediately when group data changes without another directory request.

- [ ] **Step 7: Run focused green tests and commit.**

```bash
python3 -c 'import subprocess; subprocess.run(["pnpm","--filter","@orchardworks/agent-remote-lab","exec","vitest","run","src/bot-roster.test.ts","src/workbench-mode.test.ts","src/hooks/useWorkbenchMode.test.tsx","src/hooks/useBotWorkspace.test.tsx","src/hooks/useOtherSessions.test.tsx","src/hooks/useWindowWorkspace","--testTimeout=10000","--hookTimeout=15000","--maxWorkers=1"],check=True,timeout=240)'
git add packages/agent-remote-lab/src/bot-roster* packages/agent-remote-lab/src/workbench-mode* packages/agent-remote-lab/src/hooks/useWorkbenchMode* packages/agent-remote-lab/src/hooks/useBotWorkspace* packages/agent-remote-lab/src/hooks/useOtherSessions* packages/agent-remote-lab/src/hooks/useWindowWorkspace*
git commit -m "feat: add independent bot navigation over shared groups"
```

Expected: all selected tests pass, including the existing 2a recovery/local-first tests. Inspect staged files before committing to avoid including concurrent changes.

### Task 2: One Conversation Mount Across Both Modes

**Files:** Create `components/SessionConversation.tsx`, `components/SessionConversationSurfaces.tsx`, `components/SessionConversationSurfaces.test.tsx`, `components/LabWorkbench.fixed-display.test.tsx`. Modify `components/SessionFamily.tsx`, `components/SessionDock.tsx`, `components/LabWorkbench.tsx`, `components/SessionWorkbench.tsx`. Extend `components/SessionFamily.test.tsx` and `components/SessionFamily.succession.test.tsx`.

**Interfaces:** Move the existing `Props`/`SessionProps` leaf requirements into exported `SessionConversationProps`. Preserve `FamilySessionPresentationContext` as a compatibility re-export from `SessionFamily.tsx`; its owning definition moves to `SessionConversation.tsx`. Rename the extracted `FamilySession` export to `SessionConversation`; leave the `FamilyChat` implementation internal. This is a move, not a second renderer.

```ts
// Add these fields to the extracted existing leaf props.
interface ConversationPresentation {
  visible: boolean;
  fixedDisplayMode?: TimelineDisplayMode;
  dockHeadingStart?: ReactNode;
  onPendingInputChange?(count: number): void;
}
export interface SessionSurfaceDescriptor {
  slotId: string;
  props: SessionConversationProps & ConversationPresentation;
  layout?: WindowLayoutAuthority;
  bridge?: WindowSessionBridge;
  presentedViewId?: string;
  titleInteraction: React.ContextType<typeof SessionTitleInteractionContext>;
}
export interface SessionConversationSurfacesProps {
  scope: string; transport: RemoteAgentTransport; mode: WorkbenchMode;
  children: ReactNode;
}
export function SessionConversationSurfaces(props: SessionConversationSurfacesProps): JSX.Element;
export function SessionConversationMount(props: {
  mode: WorkbenchMode; descriptor: SessionSurfaceDescriptor; active: boolean;
}): JSX.Element;
```

The provider's registry is scoped to the exact `{scope, transport}` instance, created with `useMemo`; each entry is keyed by `slotId`, never native session ID, group rank, array index, display mode or agent ID. A Window mount and Bot mount for the same slot claim the same leaf. Distinct Window views referencing the same native session intentionally retain their distinct existing draft owners/composers.

- [ ] **Step 1: Write a failing stable-host test.** Use `render`/`unmount` from `src/test/setup.ts` and `act`; mock only the extracted leaf for this lifecycle unit test. The mock renders one input and counts mount cleanup. Use a Harness with buttons that set mode, register one Window destination and one Bot destination with the same slot, and expose buttons named `Window mode`/`Bot mode`.

```tsx
const lifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));
vi.mock('./SessionConversation.js', async () => {
  const { useEffect } = await import('react');
  return { SessionConversation() {
    useEffect(() => { lifecycle.mounts++; return () => { lifecycle.unmounts++; }; }, []);
    return <input aria-label="Owned draft" defaultValue="draft" />;
  } };
});
function SurfaceHarness() {
  const [mode, setMode] = useState<WorkbenchMode>('window');
  const transport = useMemo(() => ({} as RemoteAgentTransport), []); // Mocked leaf never connects.
  const descriptor = useMemo<SessionSurfaceDescriptor>(() => {
    const target = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'one', title: 'One' };
    return { slotId: 'slot-one', titleInteraction: undefined, props: {
      storageScope: 'scope', baseUrl: '/scope', target, hostLabel: 'Host', compact: false,
      active: true, offline: false, transport, draftStore: new DraftStore('scope'),
      viewId: 'slot-one', familyRoot: true, entries: [target], visible: true,
      onNavigate: async () => {},
    } };
  }, [transport]);
  return <SessionConversationSurfaces scope="scope" transport={transport} mode={mode}>
    {(['window', 'bot'] as const).map(value => <div key={value}>
      <button data-mode={value} onClick={() => setMode(value)}>{value}</button>
      <div data-destination={value}><SessionConversationMount mode={value}
        descriptor={descriptor} active={mode === value} /></div>
    </div>)}
  </SessionConversationSurfaces>;
}
it('moves one leaf between mode destinations without losing its input node', async () => {
  lifecycle.mounts = 0; lifecycle.unmounts = 0;
  const container = await render(<SurfaceHarness />);
  const input = container.querySelector<HTMLInputElement>('[aria-label="Owned draft"]')!;
  input.value = 'keep this exact editor'; input.focus();
  await act(async () => container.querySelector<HTMLButtonElement>('[data-mode="bot"]')!.click());
  expect(container.querySelector('[data-destination="bot"] input')).toBe(input);
  expect(input.value).toBe('keep this exact editor');
  expect(lifecycle.mounts).toBe(1); expect(lifecycle.unmounts).toBe(0);
});
```

Import the declared types/components and React hooks in this test file. Add separate StrictMode assertions against the post-initial-effect baseline (StrictMode intentionally replays mount effects). The production components receive no test-only render injection.

- [ ] **Step 2: Run red tests.**

```bash
python3 -c 'import subprocess; subprocess.run(["pnpm","--filter","@orchardworks/agent-remote-lab","exec","vitest","run","src/components/SessionConversationSurfaces.test.tsx","src/components/LabWorkbench.fixed-display.test.tsx","--testTimeout=10000","--hookTimeout=15000","--maxWorkers=1"],check=True,timeout=180)'
```

Expected: missing surface/fixed-display support fails the assertions.

- [ ] **Step 3: Extract the leaf and implement stable destinations.** Keep Window family geometry, attached-child navigation, selection and resizing in `SessionFamily`. For ordinary mapped root views, render `SessionConversationMount` instead of directly rendering the extracted leaf. Keep attached/history/managed/feature leaf behavior unchanged; without the provider, the mount falls back to direct rendering for isolated component tests and legacy standalone consumers.

Each registry entry owns one `document.createElement('div')` with `className='lab-session-conversation-host'`; its portal target never changes. It owns registrations by unique mount token and stores the latest descriptor. A mode change selects the active registration and calls existing `moveSessionHost(host, destination)` in a layout effect. Do not call `createPortal(children, destination)` with a changing destination. A connected, hidden, inert parking element belongs to the provider.

```tsx
// The provider renders this portal once for each retained slot.
createPortal(
  <WindowLayoutContext.Provider value={chosen.layout}>
    <WindowSessionBridgeContext.Provider value={chosen.bridge}>
      <WindowPresentationContext.Provider value={chosen.presentedViewId}>
        <SessionTitleInteractionContext.Provider value={chosen.titleInteraction}>
          <SessionConversation {...chosen.props} visible={shown}
            onPendingInputChange={reportPendingAndForward} />
        </SessionTitleInteractionContext.Provider>
      </WindowPresentationContext.Provider>
    </WindowSessionBridgeContext.Provider>
  </WindowLayoutContext.Provider>, entry.host, entry.slotId,
);
```

`onPendingInputChange` is an explicit new leaf prop. Compose it with `sessionPresentation(context).onPendingInputChange` inside `FamilyChat`, including the existing succession first-input callback; neither may overwrite the other. `reportPendingAndForward` updates the entry count and then invokes the descriptor callback once. Keep attachment failure + Retry + product `composerNotice` composition unchanged.

The common provider must remain under existing `ConversationConnectionScope`, `RecoveryScope`, `SessionViewOperationsContext`, access, descriptions, preview and toast providers. Window-specific contexts are captured by `SessionConversationMount` and supplied explicitly above; DOM movement does not change React context. Export `useSessionDockHeadingStart(): ReactNode` from `SessionDock.tsx` to capture its existing private heading node at the Window mount; pass that node as a prop, so the common leaf does not accidentally inherit the wrong dock provider. Preserve existing title-drag behavior through the captured title-interaction value.

Keep the provider wrapper topology stable in both modes. The registry knows the selected registration's `mode`; wrap the leaf in Track/Ask/TPM/Team scope providers in both modes, supplying captured normal values in Window and `undefined` in Bot. Do not conditionally insert/remove these providers around the leaf, which would itself remount it.

For Bot registrations, set layout/bridge/presented-view/title-interaction to `undefined`, set `familyRoot=false`, and supply only the Bot header/presentation callback. Keep the same slot, `draftBinding`, `imageDraftBinding`, succession resolver and shared transport pool. Preserve a matching Window registration's `attachmentManaged`/`attachedSession` policy while moving its leaf, so a mode toggle does not trigger a second attach; for a different group, use the existing independent leaf attach path and connection reuse. Identity changes can retire a native attachment; presentation changes cannot.

Propagate `visible={shown}` through `LabWorkbench` to `SessionWorkbench`/composer. A hidden or parked leaf cannot auto-dispatch a waiting send; the existing `usePendingSend` visibility contract already enforces this. Do not add a separate send queue or regenerate operation IDs.

- [ ] **Step 4: Implement explicit release and fencing.** Registration cleanup removes only its own token. Use microtask-delayed collection and recheck that the same registry/entry is still unclaimed, so StrictMode re-registration and Window→Bot relocation do not destroy it. Keep an unclaimed leaf only while it has pending input; park it with `visible=false` and blocked mutation until a valid mount returns. Release it once the pending count is zero. For a confirmed deleted/rebound view, fence the old locator immediately through the live operation resolver; never attach a new session from a retired descriptor. Draft storage is not deleted. Scope/access teardown aborts watch/attach work and releases portal hosts, leases and registry subscriptions; no delayed callback may mutate the next scope. The registry stores transient mounts only, not group membership or authoritative bindings.

Test: two registrations => one mount; unregister one => survivor remains; remove last idle registration => host removed; unclaimed in-flight send settles before collection; waiting/unknown send stays hidden and cannot replay; StrictMode does not dispose a live entry; scope/transport replacement removes old hosts; stale cleanup cannot remove a newer registration. Test real `ConversationConnections` with the existing transport fixture for one session stream and one send dispatch across mode switches.

- [ ] **Step 5: Lock Bot display without saving preferences.** Add `fixedDisplayMode?: TimelineDisplayMode` to `LabWorkbench` and `SessionWorkbench`. Keep the existing display hook and binding for Window ownership; overlay the effective mode after reading, and pass the lock down. Guard both View controls and reveal-driven mode changes.

```ts
// LabWorkbench: displayPreferences remain the stored Window preference.
const effectiveDisplay = fixedDisplayMode
  ? { ...displayPreferences, mode: fixedDisplayMode } : displayPreferences;
// SessionWorkbench: ignore an attempted mode change while locked.
function changeDisplayPreferences(next: SessionDisplayPreferences): void {
  if (fixedDisplayMode) return;
  if (onDisplayPreferencesChange) onDisplayPreferencesChange(next);
  else setLocalDisplay({ scope: displayScope, value: next });
}
const viewOptions = fixedDisplayMode ? null :
  <SessionViewOptions preferences={preferences} onChange={changeDisplayPreferences} />;
```

The effective fixed mode is `content`; retain normal questions, approvals, errors, message failures, uncertain receipts, settings, interrupt and input controls. Do not pass Bot mode as `defaultDisplayMode`: stored Window preferences would override that default. A hidden tool/reasoning search result cannot automatically switch Bot display to Simple; keep it collapsed with the existing no-visible-match behavior. Trace/child/Threads navigation is not introduced in this milestone.

Test with a real `LabWorkbench` whose Window display is `preview`: Bot renders content items and keeps interactions/errors, hides tool/reasoning items, has no display-mode control, and dispatches no `view.display`; returning to Window restores `preview`. Assert text/image owner keys and the prompt DOM node remain unchanged. Preserve source/currentness gates for offline, pending locator and native ownership takeover.

- [ ] **Step 6: Run green checks and commit.**

```bash
python3 -c 'import subprocess; subprocess.run(["pnpm","--filter","@orchardworks/agent-remote-lab","exec","vitest","run","src/components/SessionConversationSurfaces.test.tsx","src/components/LabWorkbench.fixed-display.test.tsx","src/components/SessionFamily","src/components/SessionWorkbench","src/components/SessionWindow","--testTimeout=10000","--hookTimeout=15000","--maxWorkers=1"],check=True,timeout=240)'
git add packages/agent-remote-lab/src/components/SessionConversation* packages/agent-remote-lab/src/components/SessionFamily* packages/agent-remote-lab/src/components/SessionDock.tsx packages/agent-remote-lab/src/components/LabWorkbench.tsx packages/agent-remote-lab/src/components/LabWorkbench.fixed-display.test.tsx packages/agent-remote-lab/src/components/SessionWorkbench.tsx
git commit -m "feat: preserve one conversation surface across workbench modes"
```

Expected: focused suites pass with existing SessionFamily Retry, handoff and layout behavior intact.

### Task 3: Bot Page, Mode Switch and Section Entry Points

**Files:** Create `components/WorkbenchModeSwitch.tsx`, `components/BotRoster.tsx`, `components/BotWorkspace.tsx`, `components/bot-workspace.css`, `components/BotWorkspace.test.tsx`, `components/BotRoster.test.tsx`, `App.bot-mode.test.tsx`, `App.bot-succession.test.tsx`. Modify `App.tsx`, `components/ViewOptions.tsx`, `components/WindowWorkspaces.tsx`, `components/WindowMenu.tsx`, `app.css`; extend `components/WindowWorkspaces.test.tsx`.

**Interfaces:** `WorkbenchModeSwitch` takes `{ mode: WorkbenchMode; onChange(mode: WorkbenchMode): void }`. `BotRoster` takes `{ model: BotRosterModel; place?: BotPlace; onSelect(place: BotPlace): void; onNewSection(): void; directoryControls: ReactNode }`. `BotWorkspace` takes the following page composition inputs, not an App controller clone:

```ts
interface BotWorkspaceProps {
  visible: boolean; compact: boolean; scope: string;
  workspace: ReturnType<typeof useWindowWorkspace>;
  navigation: ReturnType<typeof useWorkbenchMode>;
  selected: ReturnType<typeof useBotWorkspace>;
  roster: BotRosterModel;
  directory: ReturnType<typeof useOtherSessions>;
  describeConversation(place: BotPlace): SessionSurfaceDescriptor | undefined;
}
```

`describeConversation` is a narrow App adapter. For a bot it reads the selected confirmed group/view/slot; for a fallback entry it uses `succession.ensureView(session)` with the existing ordinary composition owner. It returns descriptor props using `draftOwnerBinding(slot.owners.text)`, `slot.owners.image`, the existing `replicaFor`, transport, Host offline/access state, and `succession.successionContextFor(slot.id)`. It cannot open a Window, set Window selection, bind a view or create a session. Bot drafts belong to the exact group view; do not merge drafts of separate views merely because their native session addresses happen to match.

- [ ] **Step 1: Add failing page tests for the accepted interactions.** Use the existing `App.window-retention.test.tsx` transport fixture and real local group cache. Extract reusable fixture construction into `test/bot-mode-fixtures.ts` if needed; it must expose `seedGroup(scope, group)`, `mountBotApp(scope)`, and captured `send_message`/attachment records, using the existing fixture transport negotiation and access checks. `seedGroup` writes the existing `${scope}:shared-window:${groupId}` cache envelope; `mountBotApp` uses `App` with a real local `SessionDirectoryClient` whose list/attach methods return fixture sessions, never `initialState` (that bypasses Window groups).

Test this exact sequence: Show as section on Window B, explicitly return to Window A selected at view A2, switch to Bot, open B1, type a draft, switch to Window (still A/A2), open B in Window using its existing navigation, observe B1's same draft, switch to Bot (still B1). Assert only explicit Window actions change `selectedViewId`, selected Window or its saved keys. Add Bot A→B→A selection, compact Back, mode reload, corrupt preference, unavailable Window recovery still exposing mode switch, and initial section-only URLs with stale session query parameters.

```ts
// mountBotApp returns { container, workspace: () => realHookResult, sendMessages }.
const app = await mountBotApp('bot-place-test');
const button = (label: string) => [...app.container.querySelectorAll<HTMLButtonElement>('button')]
  .find(item => (item.getAttribute('aria-label') ?? item.textContent?.trim()) === label
    && !item.closest('[hidden]'))!;
const before = structuredClone(app.workspace().window);
await act(async () => button('Bot mode').click());
await act(async () => button('B1').click());
expect(app.workspace().window).toEqual(before);
expect(app.workspace().readGroup('B')?.window.selectedViewId).toBe('B2');
expect(app.sendMessages).toHaveLength(0);
```

- [ ] **Step 2: Run red page tests.**

```bash
python3 -c 'import subprocess; subprocess.run(["pnpm","--filter","@orchardworks/agent-remote-lab","exec","vitest","run","src/components/BotRoster.test.tsx","src/components/BotWorkspace.test.tsx","src/App.bot-mode.test.tsx","src/App.bot-succession.test.tsx","--testTimeout=10000","--hookTimeout=15000","--maxWorkers=1"],check=True,timeout=240)'
```

- [ ] **Step 3: Implement roster and page.** Use native buttons in a `nav aria-label="Bots"`, section headings, `aria-current` for the selected bot, and a text status alongside the shape/color avatar. Default avatar uses a circle and the existing action token; validated configured hex colors are member data, not newly invented theme tokens. Show label if present. Do not display offline/unknown as Failed or invent New result. Hidden members remain absent; no Hidden bots management section until milestone 3.

```tsx
<nav aria-label="Workbench mode">
  <button type="button" aria-pressed={mode === 'window'}
    onClick={() => onChange('window')}>Window mode</button>
  <button type="button" aria-pressed={mode === 'bot'}
    onClick={() => onChange('bot')}>Bot mode</button>
</nav>
```

Place the Window switch in the existing View options panel (available with hidden header) and the visible app bar; place the Bot switch in the roster heading and compact conversation toolbar. Avoid an additional independent navigation rail. `Other sessions` is always last after sections; clicking an entry opens a plain Content only session with no bot label/pin controls and no group mutation. Include Host/provider context so equal native IDs on different Hosts are distinguishable. Errors/partial pages, Refresh and Load more use the hook states; no fallback entry participates in notification targets.

The Bot pane's shared Session header displays picture, title, optional label, and current status via the leaf presentation callback. Keep normal composer model/effort/permission menus. Defer Threads and management controls entirely. New section is a small inline form with required title, Save/Cancel and inline error. It calls `createSection`, selects `{kind:'section',groupId}` only on confirmed success, and shows saving/uncertain state with explicit Retry. Cancelling its UI does not delete a pending creation request.

- [ ] **Step 4: Add Show as section to existing Window options.** Only show the action if the active group's `bots` is absent. Use the same `operateGroup(window.id, { type:'bots.add', rank })` path and journal as other edits. It adds an appearance without switching mode, selecting another Window, expanding views or rewriting display settings. Report success as `Shown as a section in Bot mode.` A structured `bot_session_taken` rejection keeps the original Window and names the conflict when the existing error payload provides its group; don't invent a successful conversion or suppress the rejection. The richer open-conflict management flow is deferred to milestone 3.

```ts
await workspace.operateGroup(id, { type: 'bots.add', rank: nextSectionRank });
// No workspace.open(), view.select, view.display or navigation.select here.
```

Never append a selected section-only `workspace.window` back into the Window list: `WindowWorkspaces` currently merges its current Window into the catalog, so filter using the corresponding group's `hasWindowAppearance` as well. Copy Window link strips `mode`, `section` and `bot`; it must not copy a mixed Bot URL.

- [ ] **Step 5: Wire App without cloning it.** Keep all existing App hooks and Window JSX in one place. Under the existing shared service providers, add `SessionConversationSurfaces`; retain the Window shell mounted but `hidden` and `inert` when Bot mode is active, and render `BotWorkspace` as its sibling. Keep the surface owner outside the hidden Window DOM. The unavailable-Window early return must become Window-local content so it cannot hide Bot navigation or tear down the common surface owner. No second `useSessionSuccession`, `ConversationConnections`, `DraftStore`, Ask store or provider runtime is permitted.

Use the existing compact media decision (`isCompactLayout`) consistently. Gate Window-only foreground effects, active props, `visibleWindows`, title/URL publication, global focus handlers, view menus, floating Track/Ask/TPM/Team panels, preview/inspector and toast activity by `mode === 'window'`. Keep their saved values intact. Scope CSS so Bot hiding cannot be overridden by `.lab-shell` display rules. Stop event bubbling from a Bot-owned portal before it can invoke stale Window pane selection; a portal's React ancestor is the shared provider, not its new DOM parent, and every handler still needs the proper mode gate.

Extend the existing `sessionViewPresentation(context, options)` with `options.bot?: { groupId: string; viewId: string }`. Resolve that view through `workspace.readGroup(groupId)` and the exact slot, instead of `sharedWindow`; preserve one shared Handoff availability/command/dialog implementation. For Bot presentation use `context.actions`, never the currently selected Window's `actions`, and share App's question draft map and pending-input counts. Omit Window close/selection/history menus, quote controls, side/Ask creation and trace routing. Override global Track/Ask/TPM/Team console-command contexts to `undefined` around Bot leaf presentation so hidden Window UI actions are not injected.

Keep `/handoff` available to an ordinary writable Bot under the existing Host capability/access, connection, idle and pending-input restrictions. The command captures the Bot's exact `{groupId, viewId, slotId, hostId, providerId, nativeSessionId}` and uses the existing `SessionSuccessionDialog`, `handoffProvider`, `assertSuccessionAccess`, `assertSourceCurrent` and `refreshSettled`; no new handoff endpoint or workflow. Revalidate the captured group/view binding and current slot before opening the chooser, dispatching, and applying completion. The dialog's pending-input check must always look up `pendingGroupInputs[source.viewId]` for a mapped Bot, including a section-only page with no selected Window. Keep its progress/unknown recovery visible on that Bot surface while the unrelated Window stays unchanged. Native session settings and ordinary native commands remain available through the existing composer.

Add integration cases where Window A is selected but Bot B invokes `/handoff`: the request source is B, A receives no command, changing the selected bot cannot retarget the running chooser, pending B input blocks handoff, and a removed/rebound B fails source validation. After verified B→C completion, only B's view binding changes; its slot/draft owner and Bot selection survive. Reuse the same shared presentation callback for these tests rather than mocking the Handoff guard.

Do not call `succession.open` for Bot/fallback navigation. A different-group bot uses the extracted leaf's existing attach resolver; the Window's primary locator stays its own. On confirmed handoff discovered from the Host, `useBotWorkspace` updates the same group view via `windowSuccessionLayout`; `SessionViewOperationsContext.resolveTarget` fences input until the verified locator is current.

- [ ] **Step 6: Implement responsive styles and focus.** Desktop uses a compact 260px roster and `minmax(0,1fr)` conversation within available page height. Use existing `--obs-*` tokens and 14px system font. Roster and conversation scroll independently; body has no horizontal overflow. Compact mode shows roster alone or selected conversation alone; Back restores focus to its roster row and preserves selection/draft/leaf mount. On a keyboard-triggered open, focus the conversation heading; do not automatically focus the composer/open the mobile keyboard. Escape closes only the current menu/form before any page Back behavior; respect `defaultPrevented` and IME. Use existing visible focus styling and reduced-motion behavior.

```css
.lab-bot-workspace { display: grid; grid-template-columns: 260px minmax(0, 1fr); min-height: 0; }
.lab-bot-roster, .lab-bot-conversation { min-width: 0; min-height: 0; }
.lab-bot-roster { overflow: auto; background: var(--obs-surface); }
.lab-bot-workspace[data-compact] { grid-template-columns: minmax(0, 1fr); }
.lab-bot-workspace [hidden], .lab-window-mode[hidden] { display: none !important; }
.lab-session-conversation-host { min-width: 0; min-height: 0; height: 100%; }
```

- [ ] **Step 7: Run green page/regression tests and commit.** Include a real controlled handoff projection test: fixed `{groupId,viewId,slotId}`, preserved text/image draft owners and pending input, only native binding changes, stale locator sends refused, other Window stays selected. Confirm view display remains byte-for-byte unchanged after Bot visits.

```bash
python3 -c 'import subprocess; subprocess.run(["pnpm","--filter","@orchardworks/agent-remote-lab","exec","vitest","run","src/components/BotRoster.test.tsx","src/components/BotWorkspace.test.tsx","src/components/WindowWorkspaces.test.tsx","src/App.bot-mode.test.tsx","src/App.bot-succession.test.tsx","src/App.window-retention.test.tsx","src/App.window-actions.test.tsx","src/App.succession.test.tsx","--testTimeout=10000","--hookTimeout=15000","--maxWorkers=1"],check=True,timeout=240)'
git add packages/agent-remote-lab/src/components/WorkbenchModeSwitch.tsx packages/agent-remote-lab/src/components/Bot* packages/agent-remote-lab/src/components/bot-workspace.css packages/agent-remote-lab/src/components/ViewOptions.tsx packages/agent-remote-lab/src/components/WindowWorkspaces* packages/agent-remote-lab/src/components/WindowMenu.tsx packages/agent-remote-lab/src/App.tsx packages/agent-remote-lab/src/App.bot-* packages/agent-remote-lab/src/app.css packages/agent-remote-lab/src/test/bot-mode-fixtures.ts
git commit -m "feat: add bot roster and content-only workspace"
```

Expected: page and Window regression suites pass. If fixture extraction was unnecessary, omit its nonexistent path from staging.

### Task 4: Mode-Scoped Attention and Complete Acceptance

**Files:** Modify `hooks/useSessionTracking.tsx`, `session-notifications.ts`, `App.tsx`, `../playwright.config.ts`; extend `hooks/useSessionTracking.test.tsx` and `session-notifications.test.ts`. Create `../e2e/bot-mode.spec.ts` and `docs/superpowers/acceptance/2026-11-08-bot-mode-page.md` at repository root. Update the reviewed compatibility manifest only through its script.

**Interfaces:** Extend the existing tracking hook with one final optional parameter; old callers retain their behavior. The `visibleSessions` parameter may be widened from `OpenedSession[]` to `SessionEntry[]` because its code reads only native identities.

```ts
export interface SessionTrackingScope {
  includeTracked?: boolean; // Default true; affects observation, not saved Track membership.
  additionalSessions?: readonly SessionEntry[];
}
// Added final argument to useSessionTracking(..., onObservation?, scope?: SessionTrackingScope).
// SessionAttentionNotifications gains:
setEligible(sessions: readonly SessionEntry[]): void;
```

`setEligible` stores native identity keys, removes baselines for no-longer-eligible sessions, and closes their stale notifications. Before its first call, preserve existing behavior for legacy direct consumers. Once set, both `observe` and the final asynchronous `deliver` must check membership, enabled state and disposal. `setDisplayed` remains cross-tab routing, not authorization.

- [ ] **Step 1: Add failing attention tests.** Reuse the notification permission/cursor fixtures already present in `session-notifications.test.ts`. Verify eligible Bot running→idle and idle→waiting produce reminders; hidden bot, fallback, unrelated tracked session and Ask do not. Window mode retains tracked/open/Ask behavior. Switching modes does not synthesize a completion from an old observation baseline; leaving and reentering scope starts from a fresh observation. Notification click in Bot mode resolves the current roster's group/view identity and selects it; a deleted/hidden bot notification does nothing. Window click behavior is unchanged.

```ts
it('fences delivery after eligibility changes during async fingerprinting', async () => {
  const session: SessionEntry = { hostId: 'host', providerId: 'recorded',
    nativeSessionId: 'one', title: 'One' };
  const notifier = new SessionAttentionNotifications('scope', () => true, vi.fn());
  notifier.setEligible([session]);
  await notifier.observe(session, { connection: 'ready', activity: 'running',
    cursor: { epoch: 'one', seq: 1 } });
  const pending = notifier.observe(session, { connection: 'ready', activity: 'idle',
    cursor: { epoch: 'one', seq: 2 } });
  notifier.setEligible([]);
  await pending;
  expect(Notification).not.toHaveBeenCalled();
  notifier.dispose();
});
```

The file's existing `Notification` mock must expose permission `granted`; gate `crypto.subtle.digest` with a deferred promise so membership changes definitely precede delivery. Also test a Track observer disappearing on Bot entry without changing `tracking.sessions` or stored Track data.

- [ ] **Step 2: Run red attention tests.**

```bash
python3 -c 'import subprocess; subprocess.run(["pnpm","--filter","@orchardworks/agent-remote-lab","exec","vitest","run","src/session-notifications.test.ts","src/hooks/useSessionTracking.test.tsx","src/App.tracking.test.tsx","--testTimeout=10000","--hookTimeout=15000","--maxWorkers=1"],check=True,timeout=180)'
```

- [ ] **Step 3: Wire observation and delivery scopes.** In Bot mode pass empty Window-open/Ask arrays, `includeTracked:false`, and all visible Bot bindings as `additionalSessions`. Do not invent `agentId:''`; the existing activity observer attaches only when necessary and reuses a shown conversation. `visibleSessions` contains only the currently visible attached Bot, never the whole roster, so reading one bot does not acknowledge the others. Fallback may have a conversation stream while selected, but no attention observer or notifier membership.

```ts
const botTargets = roster.sections.flatMap(section => section.rows.map(row => row.binding));
const trackingScope: SessionTrackingScope = mode === 'bot'
  ? { includeTracked: false, additionalSessions: botTargets } : {};
const eligible = mode === 'bot' ? botTargets
  : [...tracking.sessions, ...openWindows, ...askActivitySessions.map(item => item.session)];
```

Apply `setEligible(eligible)` and `setDisplayed(mode === 'bot' ? botTargets : windowDisplayed)` in a layout effect keyed by sorted native keys, enabled state and notifier identity. Gate the `onObservation` adapter against the latest eligible identity set as well, so an observer callback delivered during teardown cannot repopulate an unrelated baseline. Changes to group hidden flags, deletion, succession and mode remove prior keys immediately. Use one notifier and the existing opaque deduplication ledger; no second notification implementation. Enable `useSessionStates` while Bot mode is visible, independently of Window overview visibility, and derive roster status with `sessionActivity(binding, tracking.liveObservations, sessionStates)`.

- [ ] **Step 4: Add browser checks using actual interactions.** `e2e/bot-mode.spec.ts` uses the recorded transport fixtures for deterministic UI checks; add its filename to the existing WebKit desktop/mobile allowlists. It must create/reuse sessions through fixture UI/transport, use Show as section, and assert saved group state rather than searching source text. Record creates, attaches and send operations to catch duplication.

```ts
test('switches modes with the same draft and fixed Bot display', async ({ page }) => {
  await page.goto('/');
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const windowPrompt = page.getByTestId('prompt-input').filter({ visible: true });
  await windowPrompt.fill('Keep this draft across modes');
  await page.getByRole('button', { name: 'Windows', exact: true }).click();
  await page.getByText('Window options', { exact: true }).click();
  await page.getByRole('button', { name: 'Show as section', exact: true }).click();
  await page.getByRole('button', { name: 'Bot mode', exact: true }).filter({ visible: true }).click();
  await page.getByRole('navigation', { name: 'Bots', exact: true }).getByRole('button').first().click();
  await expect(page.getByTestId('prompt-input').filter({ visible: true })).toHaveValue('Keep this draft across modes');
  await expect(page.getByRole('button', { name: 'Session view options', exact: true })).toBeHidden();
});
```

Use the actual accessible Window-menu trigger exposed by `WindowMenu` and the fixture's known bot title when implementing the test; inspect its DOM instead of forcing clicks. If installed Playwright lacks locator `filter({visible:true})`, scope to the visible mode region (`[data-workbench-mode="window"]`/`[data-workbench-mode="bot"]`) rather than weakening assertions.

Cover 1440×900, 1181×800, 1180×800, 390×844, and 320×568. At the 1180 breakpoint verify roster/home vs full conversation and Back focus. Assert no horizontal overflow, one visible composer, no offscreen focus traps, readable long title/label, independent scrolling, and visible normal approval/error controls. Exercise mode switch with an in-flight send and a queued offline send: one original operation, no replay while hidden, draft intact. Exercise changing Bot within a different group while a Window remains selected. Test `?window=<section-only>` directly, reload both modes, and remove a selected Bot from a second fixture client.

- [ ] **Step 5: Run focused green tests, types and browser suites.** First ensure chosen test ports are free; never stop an existing listener. Set `AGENT_REMOTE_TEST_RELAY_PORT` and `AGENT_REMOTE_TEST_WEB_PORT` to the chosen free ports when the default fixture ports are occupied. The runner's configuration uses `reuseExistingServer:false`.

```bash
python3 -c 'import subprocess; subprocess.run(["pnpm","--filter","@orchardworks/agent-remote-lab","exec","vitest","run","src/session-notifications.test.ts","src/hooks/useSessionTracking.test.tsx","src/App.tracking.test.tsx","src/App.bot-mode.test.tsx","src/App.bot-succession.test.tsx","--testTimeout=10000","--hookTimeout=15000","--maxWorkers=1"],check=True,timeout=240)'
pnpm --filter @orchardworks/agent-remote-lab typecheck
pnpm test:e2e bot-mode.spec.ts session-view-ownership.spec.ts session-composition-persistence.spec.ts
```

Expected: selected Vitest/browser suites and Lab typecheck pass. These browser fixtures prove Web behavior, not actual Provider handoff or a physical mobile device.

- [ ] **Step 6: Review implementation, refresh compatibility and run repository checks.** Review the four task diffs against the acceptance matrix below. Fix correctness findings before generating compatibility metadata. Then run:

```bash
pnpm compatibility:update
pnpm compatibility:check
pnpm typecheck
pnpm test
```

Expected: compatibility check, types and root unit suite pass. Root tests enforce per-test and outer deadlines. If a failure is environmental, record the command/error and tested boundary; do not describe the work as fully green.

- [ ] **Step 7: Validate this checkout's complete local instance.** Read `.agents/skills/prepare-arc-local/SKILL.md` and its lifecycle, browser, CLI, test-loop and verification references at execution time. Before a restart, inspect this worktree's instance and sessions; do not interrupt unrelated work. Run from `.worktrees/bot-mode-ui`:

```bash
pnpm --silent local status --json
pnpm local up
agent-remote-controller-dev --build-info
```

Use only task-created sessions in this instance's `workspace/` and one new headless browser context from the skill's script. Confirm current build identity. Create two native sessions and two Windows through supported local UI/CLI/API, mark a populated Window Show as section, create an empty section, exercise both modes and fallback, and record a reply/approval or ordinary model turn using only the task's sessions. With Window A remembered, initiate one supported real Handoff from Bot B's existing `/handoff` chooser, switch modes during/after the operation, and verify stable group/view IDs and text/image owners, changed confirmed native locator, preserved draft, no duplicate prompt and no command sent to A. No linking/splitting acceptance is required for 2b.

Use a bounded local script (per action <=30s; whole script <=240s) and provider-turn deadlines from the skill. Capture desktop/compact screenshots under `.tmp/local/bot-mode/`, open each captured image, and record what it actually demonstrates. A normal failed/timed-out turn is a result: record it and continue independent remaining checks. Missing Provider/sign-in/model access, a required Codex daemon not running, sandbox refusal, or an unrelated running session that would be interrupted is a skill stop condition: stop that instance work, ask exactly as the skill requires, name/link its relevant instruction, and mark dependent model-turn/handoff layers not exercised. Do not substitute fixture evidence or attempt credential/daemon changes. Independent offline work may continue. Leave an instance already running intact; leave a task-started instance running only if the user will inspect it, and record its origin. Never use production or the user's browser/Controller.

- [ ] **Step 8: Write acceptance evidence and commit.** Record actual origin/build commit, commands, outcomes, screenshots, cleanup/session IDs and limitations in `docs/superpowers/acceptance/2026-11-08-bot-mode-page.md`. Include separate Build, Site, Controller, Page, Feature and Model turn rows with `verified`, `failed`, or `not exercised`. Do not copy planned expectations as evidence. Commit reviewed implementation/tests and the generated compatibility manifest paths shown by `git diff --name-only`; do not stage unrelated changes or `.tmp` evidence files.

```bash
git diff --check
git status --short
git add packages/agent-remote-lab/src/hooks/useSessionTracking.tsx packages/agent-remote-lab/src/hooks/useSessionTracking.test.tsx packages/agent-remote-lab/src/session-notifications.ts packages/agent-remote-lab/src/session-notifications.test.ts packages/agent-remote-lab/src/App.tsx packages/agent-remote-lab/playwright.config.ts packages/agent-remote-lab/e2e/bot-mode.spec.ts packages/agent-remote-lab/compatibility.json docs/superpowers/acceptance/2026-11-08-bot-mode-page.md
git commit -m "feat: scope bot attention and verify mode switching"
```

Stage any generated compatibility files before this commit after reviewing their exact diff. This is a local commit only; no push or release is authorized.

## Acceptance Matrix and Plan Self-Review

| Accepted 2b requirement | Owning task | Required observable evidence |
| --- | --- | --- |
| Default Window, remembered browser mode | 1, 3 | Missing/corrupt preference and reload tests. |
| Independent places and routes | 1, 3 | Bot B selection leaves Window A/A2 and saved Window keys unchanged. |
| Shared text/image drafts and pending send state | 2, 3 | Same slot/owners/editor, one send operation across modes. |
| One grouping, sections/statuses/order | 1, 3 | Protocol-derived roster and immediate catalog updates. |
| Other sessions | 1, 3 | Exclusion by every group binding; pagination/error states; no bot metadata/notifications. |
| Content only, Window preference unchanged | 2, 3 | Tool/reasoning filtering, preserved interactions/errors/settings, no `view.display`. |
| Show as section | 3 | One journaled appearance edit, no layout/selection rewrite, refusal preserved. |
| New section | 1, 3 | Section-only group, exact unknown-create recovery, useful empty state. |
| Mode-specific observations/notifications | 4 | Hidden/fallback/Track/Ask excluded in Bot mode, async delivery fence. |
| Desktop/compact layout and keyboard access | 3, 4 | Geometry at breakpoint, Back focus, hidden/inert inactive mode. |
| Section-only URL handling | 1, 3 | Redirect to Bot section without opening Window or stale session. |
| Bot continuity through Handoff | 1–4 | Existing verified succession projection; same view/draft, changed native binding. |
| Preserve Window behavior | 2–4 | Existing retention, family, composition and ownership suites. |

The plan intentionally does not implement milestone 3–5 controls or imply their acceptance. Implementation tasks must not add another group cache, duplicate App page logic, create a second succession coordinator, infer provider state, remount a composer on mode change, or replay an uncertain operation. Parent review precedes execution; no new user design approval is required for these reversible implementation decisions.
