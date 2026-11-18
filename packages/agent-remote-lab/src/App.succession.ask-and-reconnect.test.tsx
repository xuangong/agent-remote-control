import 'fake-indexeddb/auto';
import { type ComponentProps } from 'react';
import { WebSocket } from 'ws';
import { expect, it, vi } from 'vitest';
import { createWindowView, type WorkspaceWindow, type ProjectedTimelineEntry, type SessionSuccessionReplay, type Team } from '@orchardworks/agent-remote-protocol';
import { App } from './App.js';
import { type OpenedSession, type SuccessionDescription } from './directory-client.js';
import { DraftStore } from './draft-store.js';
import { readCompositionDocument, parseComposition, saveCompositionDocument, createCompositionDocument, createCompositionSlot, createAskOwner } from './session-composition.js';
import { flushRecoveryWrites } from './recovery-writes.js';
import * as trackingHooks from './hooks/useSessionTracking.js';
import * as askHooks from './hooks/useAskConversations.js';
import * as successionHooks from './hooks/useSessionSuccession.js';
import { ForkStore, referenceForkContext } from './session-forks.js';
import { sessionKey } from './session-tree.js';
import { saveTrackedSessions } from './tracking-state.js';
import * as remoteReact from '@orchardworks/agent-client-web/react';
import * as managerComponents from './components/ChatSessionManager.js';
import { act, cleanups, committed, editVisiblePrompt, failureFixture, native, setGlobalAskVisible, settleApp, testDeadline, visibleQuery, waitFor } from './App.succession.fixture.js';

it('keeps post-upgrade view preferences and owners when opening the same Window in a new tab', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  const real = successionHooks.useSessionSuccession, realAsk = askHooks.useAskConversations, realManager = managerComponents.ChatSessionManager;
  let succession!: ReturnType<typeof real>, ask!: ReturnType<typeof realAsk>, manager!: ComponentProps<typeof realManager>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  vi.spyOn(askHooks, 'useAskConversations').mockImplementation((...args) => { ask = realAsk(...args); return ask; });
  vi.spyOn(managerComponents, 'ChatSessionManager').mockImplementation(props => { manager = props; return realManager(props); });
  const f = await failureFixture(false, 'B', false, '', { chain: [] });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  await act(async () => manager.onOpen({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'D', title: 'Post-upgrade D' }));
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('D'));
  const windowId = new URL(window.location.href).searchParams.get('window')!;
  const original = structuredClone(succession.desired!.slot), owner = succession.ownerFor(original.id);
  await act(async () => ask.toggle(succession.binding!.session, owner));
  const primary = () => visibleQuery(f.view, '.lab-primary-conversation')!;
  await act(async () => primary().querySelector<HTMLButtonElement>('[aria-label="Session view options"]')!.click());
  await act(async () => primary().querySelector<HTMLInputElement>('input[name^="session-display-"][value="content"]')!.click());
  await f.newTab('D', windowId);
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('D'));
  expect(succession.desired?.slot.id).toBe(original.id);
  expect(succession.desired?.slot.owners).toEqual(original.owners);
  expect(succession.ownerFor(original.id)).toBe(owner);
  expect(ask.isEnabled(succession.binding!.session, owner)).toBe(true);
  await act(async () => primary().querySelector<HTMLButtonElement>('[aria-label="Session view options"]')!.click());
  expect(primary().querySelector<HTMLInputElement>('input[name^="session-display-"][value="content"]')!.checked).toBe(true);
  expect(f.frames.filter(frame => frame.message && ['send_message', 'execute_command', 'image_upload_begin'].includes(frame.message.type))).toEqual([]);
});

it('keeps a synchronized native binding alive while composition replay is pending', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>, options!: Parameters<typeof real>[0];
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { options = args[0]; succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B');
  const releaseAttach = f.holdAttach('B');
  let releaseCurrent = () => {};
  const nativeSetTimeout = globalThis.setTimeout;
  const deadlineSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    if (delay === 15000) return nativeSetTimeout(callback, 200, ...args);
    return nativeSetTimeout(callback, delay, ...args);
  });
  try {
    await settleApp(() => expect(f.requests.some(request => request.url.endsWith('/attach') && request.body?.nativeSessionId === 'B')).toBe(true));
    releaseCurrent = f.holdCurrent();
    const currentRequests = f.requests.filter(request => request.url.includes('/session-successions/current')).length;
    let outcome = 'pending', failure: unknown;
    await act(async () => { void succession.refreshCommitted('primary-op-2').then(() => { outcome = 'confirmed'; }, error => { outcome = 'failed'; failure = error; }); });
    await settleApp(() => expect(f.requests.filter(request => request.url.includes('/session-successions/current')).length).toBeGreaterThan(currentRequests));
    await act(async () => releaseAttach());
    const nativeConnection = () => options.connections.find({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'B' });
    await settleApp(() => {
      expect(nativeConnection()?.replica.getState().agent?.runtimeInfo.sessionId).toBe('B');
      expect(nativeConnection()?.replica.getState().timeline.initialized).toBe(true);
      expect(nativeConnection()?.client.getSessionState().synchronized).toBe(true);
      expect(nativeConnection()?.client.getSessionState().runtime?.state).toBe('connected');
      expect(nativeConnection()?.client.getSessionState().controlChecking).toBe(false);
      expect(nativeConnection()?.client.getSessionState().recovering).toBe(false);
    });
    const synchronizedConnection = nativeConnection()!;
    deadlineSpy.mockRestore();
    expect(outcome).toBe('pending');
    expect(succession.binding).toBeUndefined();
    await act(async () => { await new Promise(resolve => nativeSetTimeout(resolve, 250)); });
    expect(succession.error).toBeUndefined();
    expect(outcome).toBe('pending');
    expect(nativeConnection()).toBe(synchronizedConnection);
    await act(async () => releaseCurrent());
    await settleApp(() => { expect(failure).toBeUndefined(); expect(outcome).toBe('confirmed'); });
    expect(succession.error).toBeUndefined();
    expect(succession.binding?.isCurrent()).toBe(true);
    expect(succession.binding?.client).toBe(synchronizedConnection.client);
    expect(succession.binding?.session.nativeSessionId).toBe('B');
    expect(succession.document.roles[0]?.appliedRevision).toBe(2);
    expect(f.requests.filter(request => request.url.endsWith('/attach') && request.body?.nativeSessionId === 'B')).toHaveLength(1);
  } finally { deadlineSpy.mockRestore(); releaseAttach(); releaseCurrent(); }
}, testDeadline);


it.each(['history', 'control', 'runtime'] as const)('keeps a matching session alive while %s is still recovering', async phase => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>, options!: Parameters<typeof real>[0];
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { options = args[0]; succession = real(...args); return succession; });
  const nativeSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) =>
    nativeSetTimeout(callback, delay === 15000 ? 200 : delay, ...args));
  const f = await failureFixture(false, 'B', false, '', {
    holdTimelineInitially: phase === 'history', holdAccessInitially: phase === 'control',
    nativeConnection: phase === 'runtime' ? 'restoring' : 'connected',
  });
  const connection = () => options.connections.find({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'B' });
  await settleApp(() => expect(connection()?.replica.getState().agent?.runtimeInfo.sessionId).toBe('B'));
  const initial = connection()!;
  await act(async () => { await new Promise(resolve => nativeSetTimeout(resolve, 300)); });
  expect(succession.error).toBeUndefined();
  // A restoring runtime does not hide which session this is: the view binds to show it, but grants nothing.
  if (phase === 'runtime') expect(succession.binding?.client).toBe(initial.client);
  else { expect(succession.binding).toBeUndefined(); expect(succession.sessionState.synchronized).toBe(false); }
  expect(succession.sessionState.operations.send_message.allowed).toBe(false);
  expect(succession.imageRecipient).toBeUndefined();
  expect(succession.sessionState.connection).toBe(initial.client.getSessionState().connection);
  if (phase === 'control') expect(succession.sessionState.controlChecking).toBe(true);
  if (phase === 'runtime') expect(succession.sessionState.runtime?.state).toBe('restoring');
  if (phase === 'history') expect(succession.sessionState.connection).toBe('catching_up');
  await editVisiblePrompt(f.view, 'Keep this draft while recovering');
  expect(f.frames.filter(frame => frame.message && ['send_message', 'interaction_response', 'image_upload_begin'].includes(frame.message.type))).toEqual([]);
  await act(async () => { f.releaseTimeline(); f.releaseAccess(); f.updatesByAgent.get('agent-B')?.('B'); });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  expect(succession.error).toBeUndefined();
  expect(succession.binding?.client).toBe(initial.client);
  expect(visibleQuery(f.view, '[data-testid="prompt-input"]')?.textContent).toBe('Keep this draft while recovering');
  expect(f.requests.filter(request => request.url.endsWith('/attach'))).toHaveLength(1);
});

it('reconnects automatically when the initial snapshot does not arrive before the public deadline', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const nativeSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) =>
    nativeSetTimeout(callback, delay === 15000 ? 150 : delay === 20000 ? 500 : delay, ...args));
  const f = await failureFixture(false, 'B', false, '', { holdSnapshotInitially: true });
  await settleApp(() => expect(f.frames.some(frame => frame.type === 'subscribe' && frame.agentId === 'agent-B')).toBe(true));
  await settleApp(() => expect(succession.sessionState.connection).toBe('disconnected'));
  expect(succession.error).toBeUndefined();
  expect(succession.binding).toBeUndefined();
  expect(succession.sessionState.operations.send_message.allowed).toBe(false);
  await act(async () => f.releaseSnapshot());
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  expect(succession.error).toBeUndefined();
  expect(f.frames.filter(frame => frame.type === 'subscribe' && frame.agentId === 'agent-B').length).toBeGreaterThanOrEqual(2);
  expect(f.requests.filter(request => request.url.endsWith('/attach'))).toHaveLength(1);
});

it('clears an identity error as soon as a matching snapshot arrives while history is still pending', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'wrong-native', false, '', { holdTimelineInitially: true });
  await settleApp(() => expect(succession.error).toBe('The native session identity could not be confirmed.'));
  expect(succession.binding).toBeUndefined();
  expect(succession.sessionState.operations.send_message.allowed).toBe(false);
  await act(async () => f.updatesByAgent.get('agent-B')?.('B'));
  await settleApp(() => expect(succession.error).toBeUndefined());
  expect(succession.binding).toBeUndefined();
  expect(succession.sessionState.operations.send_message.allowed).toBe(false);
  await act(async () => f.releaseTimeline());
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  expect(f.requests.filter(request => request.url.endsWith('/attach'))).toHaveLength(1);
});

it('retires a slow attachment when navigating away and ignores its late identity updates', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B', false, '', { holdTimelineInitially: true });
  await settleApp(() => expect(f.updatesByAgent.has('agent-B')).toBe(true));
  expect(succession.binding).toBeUndefined();
  await act(async () => succession.open({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'D', title: 'Other session' }));
  await settleApp(() => expect(f.updatesByAgent.has('agent-D')).toBe(true));
  await act(async () => { f.updatesByAgent.get('agent-B')?.('wrong-native'); f.releaseTimeline(); });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('D'));
  expect(succession.error).toBeUndefined();
  expect(succession.selected?.nativeSessionId).toBe('D');
  expect(f.frames.filter(frame => frame.message && ['send_message', 'interaction_response', 'image_upload_begin'].includes(frame.message.type))).toEqual([]);
});

it('follows an Ask native prefix with an execution recipient while preserving the association anchor', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const realAsk = askHooks.useAskConversations, realSuccession = successionHooks.useSessionSuccession;
  let ask!: ReturnType<typeof realAsk>, succession!: ReturnType<typeof realSuccession>;
  vi.spyOn(askHooks, 'useAskConversations').mockImplementation((...args) => { ask = realAsk(...args); return ask; });
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = realSuccession(...args); return succession; });
  const prefix = committed('X', 'Y', 2, 'ask');
  const preparation = { kind: 'native_prefix' as const, turnId: 'turn', messageId: 'message' };
  prefix.projection.receipt.preparation = preparation; prefix.projection.receipt.prepared!.preparation = preparation;
  let anchor!: OpenedSession, original!: OpenedSession;
  const f = await failureFixture(false, 'B', false, '', { chain: [committed(), prefix], seed(scope, source) {
    original = source; anchor = { ...source, nativeSessionId: 'X', agentId: 'agent-X', title: 'Ask X' };
    const store = new ForkStore(`ask:${scope}`, sessionStorage);
    const record = store.prepare(referenceForkContext(source), { sourceNativeSessionId: source.nativeSessionId });
    store.bind(record.id, anchor); store.markConfigured(record.id); store.finishCreation(record.id);
  } });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  const owner = succession.ownerFor(succession.desired!.slot.id);
  await setGlobalAskVisible(f.view, true);
  await act(async () => { await ask.open(undefined, succession.binding!.session, '', false, { associationOwner: owner }); });
  await settleApp(() => expect(succession.recipientFor(anchor, owner)?.isCurrent()).toBe(true));
  expect(succession.recipientFor(anchor, owner)?.identity).toContain('agent-Y');
  expect(ask.entryFor(original, owner).record?.target).toEqual(anchor);
  expect(ask.entryFor(original, owner).record?.source).toEqual(original);
  expect(f.requests.filter(request => request.url.endsWith('/attach')).some(request => request.body?.nativeSessionId === 'X')).toBe(false);
  expect(succession.binding?.session.nativeSessionId).toBe('B');
  expect(f.frames.some(frame => frame.message?.type === 'send_message')).toBe(false);
}, testDeadline);

it('fences a warm Team main view immediately when its public execution locator disappears', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const interval = globalThis.setInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) => interval(callback, delay === 4000 ? 50 : delay, ...args)) as typeof setInterval);
  let team: Team = { id: 'team', operationId: 'create', revision: 1, title: 'Team', status: 'active', source: { hostId: 'host', providerId: 'recorded', nativeSessionId: 'main', title: 'Main' },
    members: [{ id: 'leader', hostId: 'host', providerId: 'recorded', nativeSessionId: 'A', role: 'leader', name: 'Leader', responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 }], messages: [], createdAt: 1, updatedAt: 1 };
  const f = await failureFixture(false, 'A', false, '', { chain: [], teams: () => [team] });
  await settleApp(() => expect(succession.binding?.isCurrent()).toBe(true));
  await act(async () => {
    succession.desired!.slot.metadata = { ...succession.desired!.slot.metadata!, teamId: 'team', teamMemberId: 'leader' };
    succession.save();
  });
  const recipient = succession.imageRecipient!;
  expect(recipient.isCurrent()).toBe(true);
  team = { ...team, revision: 2, members: [{ ...team.members[0]!, nativeSessionId: undefined }] };
  await settleApp(() => expect(recipient.isCurrent()).toBe(false));
  expect(succession.isCurrent()).toBe(false);
  expect(f.view.textContent).toContain('no current execution locator');
  expect(f.view.querySelector('.lab-primary-conversation [data-prompt-edit-action]')).toBeNull();
  expect(f.frames.some(frame => frame.message?.type === 'send_message')).toBe(false);
  team = { ...team, revision: 3, members: [{ ...team.members[0]!, nativeSessionId: 'A' }] };
  await settleApp(() => expect(succession.imageRecipient?.isCurrent()).toBe(true));
  expect(recipient.isCurrent()).toBe(false);
  expect(succession.imageRecipient).not.toBe(recipient);
}, testDeadline);

it.each(['A', 'B'].flatMap(initial => ['native preparation', 'selected resources'].map(stage => ({ initial, stage }))))
('fences shared prompt editing from $initial after awaiting $stage over HTTP and WebSocket', async ({ initial, stage }) => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  let entered = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); cleanups.push(release);
  const prompt: ProjectedTimelineEntry = { providerId: 'recorded', seqStart: 1, seqEnd: 1, timestamp: '2026-10-15T00:00:00Z', turnId: 'selected-turn', collapsed: [], sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
    resources: stage === 'selected resources' ? [{ locator: '/selected.png', resourceId: 'selected-image', status: 'available' }] : [],
    item: { type: 'user_message', messageId: 'selected-message', text: 'Original selected prompt', ...(stage === 'selected resources' ? { content: [{ type: 'text', text: 'Original selected prompt' }, { type: 'image', locator: '/selected.png', label: 'image #1' }] } : {}) } };
  const description: SuccessionDescription = { role: { id: 'primary', revision: initial === 'A' ? 1 : 2, origin: native('A'), current: native(initial), workspace: { controllerId: 'installation', canonicalCwd: '/fixture' } },
    targets: [{ providerId: 'recorded', displayName: 'Recorded' }], eligibility: { status: 'ready' } };
  if (stage === 'selected resources') {
    const prepare = remoteReact.preparePromptDraft;
    vi.spyOn(remoteReact, 'preparePromptDraft').mockImplementation(async (...args) => { const value = await prepare(...args); entered = true; await gate; return value; });
  }
  const f = await failureFixture(false, 'B', false, '', { chain: initial === 'A' ? [] : [committed()], timeline: [prompt], persistPrompt: true,
    successionDescription: description, async successionPrepare(body) {
      entered = true; await gate;
      return { role: description.role, record: { operationId: String(body.operationId), roleId: 'primary', expectedRevision: description.role.revision,
        from: native(initial), to: native('S'), targetProviderId: 'recorded', preparation: body.preparation as any, phase: 'ready', startedAt: 'now', updatedAt: 'now' } };
    } });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe(initial));
  await settleApp(() => expect(f.view.querySelector('.lab-primary-conversation [data-prompt-edit-action]')).not.toBeNull());
  await act(async () => f.view.querySelector<HTMLButtonElement>('.lab-primary-conversation [data-prompt-edit-action]')!.click());
  await settleApp(() => expect(entered, f.view.textContent ?? '').toBe(true));
  const next = committed(initial, initial === 'A' ? 'B' : 'C', initial === 'A' ? 2 : 3); f.chain.push(next);
  await act(async () => f.notify(next));
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe(next.to!.nativeSessionId));
  await act(async () => release());
  if (stage === 'native preparation') {
    await settleApp(() => expect(f.view.textContent).toContain('Details'));
    await act(async () => [...f.view.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Details')!.click());
  }
  await settleApp(() => expect(f.view.textContent).toMatch(/no longer ready|connection changed/));
  const prepared = f.requests.filter(request => request.url.endsWith('/succession/prepare'));
  expect(prepared).toHaveLength(stage === 'native preparation' ? 1 : 0);
  if (prepared[0]) {
    expect(prepared[0].body).toMatchObject({ nativeSessionId: initial, preparation: { kind: 'native_prefix', turnId: 'selected-turn', messageId: 'selected-message' } });
    const retained = Object.keys(sessionStorage).filter(key => key.includes(':prefix-edit:')).map(key => JSON.parse(sessionStorage.getItem(key)!));
    expect(retained).toEqual([expect.objectContaining({ operation: expect.objectContaining({ operationId: prepared[0].body!.operationId, nativeSessionId: initial }) })]);
  }
  expect(f.requests.filter(request => request.url.endsWith('/succession/commit') || request.url.endsWith('/create'))).toEqual([]);
  expect(f.frames.filter(frame => frame.message?.type === 'resource_request').map(frame => frame.message?.payload?.agentId)).toEqual(stage === 'selected resources' ? [`agent-${initial}`] : []);
  expect(f.frames.some(frame => ['send_message', 'execute_command', 'session_setting_request'].includes(frame.message?.type ?? ''))).toBe(false);
  expect(new URL(window.location.href).searchParams.get('session')).toBe(next.to!.nativeSessionId);
});

it.each(['legacy exact', 'legacy missing', 'explicit successor'] as const)('restores a cold managed Team window only from public roster evidence: %s', async mode => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const team: Team = { id: 'team', operationId: 'create', revision: 1, title: 'Team', status: 'active', source: { hostId: 'host', providerId: 'recorded', nativeSessionId: 'A', title: 'Main' },
    members: [{ id: 'leader', hostId: 'host', providerId: 'recorded', nativeSessionId: mode === 'legacy missing' ? undefined : mode === 'explicit successor' ? 'Y' : 'X', role: 'leader', name: 'Leader', responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 }], messages: [], createdAt: 1, updatedAt: 1 };
  const prefix = committed('X', 'Y', 2, 'team-role');
  const preparation = { kind: 'native_prefix' as const, turnId: 'turn', messageId: 'message' };
  prefix.projection.receipt.preparation = preparation; prefix.projection.receipt.prepared!.preparation = preparation;
  const f = await failureFixture(false, 'A', false, '', { chain: mode === 'explicit successor' ? [prefix] : [], teams: () => [team], seed(scope, source) {
    const main = createCompositionSlot('main-slot', source, scope);
    const target = { ...source, nativeSessionId: 'X', agentId: 'agent-X', title: 'Saved Leader', ...(mode === 'explicit successor' ? { teamId: 'team', teamMemberId: 'leader' } : {}) };
    const member = createCompositionSlot('member-slot', target, scope);
    const document = createCompositionDocument(scope, [main, member]);
    document.asks = document.slots.map(slot => createAskOwner(slot, scope));
    document.windows = [{ id: 'member-window', slotId: member.id, managed: true, groupId: 'team' }];
    saveCompositionDocument(document, () => true); flushRecoveryWrites();
    const drafts = new DraftStore(scope); drafts.set(`session:${sessionKey(target)}`, 'Retained member draft'); drafts.flush();
  } });
  await settleApp(() => expect(f.view.querySelector('[data-view-id="member-window"]'), f.view.textContent ?? '').not.toBeNull());
  const panel = () => f.view.querySelector('[data-view-id="member-window"]')!;
  if (mode === 'legacy missing') {
    await settleApp(() => expect(panel().textContent).toContain('saved Team member identity is unavailable'));
    expect(f.requests.filter(request => request.url.endsWith('/attach')).some(request => request.body?.nativeSessionId === 'X')).toBe(false);
  } else {
    const expected = mode === 'explicit successor' ? 'Y' : 'X';
    await settleApp(() => expect(f.requests.filter(request => request.url.endsWith('/attach')).some(request => request.body?.nativeSessionId === expected)).toBe(true));
    await settleApp(() => expect(panel().querySelector('[data-testid="prompt-input"]')?.textContent).toBe('Retained member draft'));
    if (mode === 'explicit successor') expect(f.requests.filter(request => request.url.endsWith('/attach')).some(request => request.body?.nativeSessionId === 'X')).toBe(false);
  }
  expect(new URL(window.location.href).searchParams.get('session')).toBe('A');
  expect(f.frames.some(frame => frame.message?.type === 'send_message')).toBe(false);
}, testDeadline);

it('edits a real App managed Team window into its retained origin owner and admits input only to the successor', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  let team: Team = { id: 'team', operationId: 'create', revision: 1, title: 'Team', status: 'active', source: { hostId: 'host', providerId: 'recorded', nativeSessionId: 'A', title: 'Main' },
    members: [{ id: 'leader', hostId: 'host', providerId: 'recorded', nativeSessionId: 'X', role: 'leader', name: 'Leader', responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 }], messages: [], createdAt: 1, updatedAt: 1 };
  const chain: SessionSuccessionReplay[] = [], prefix = committed('X', 'Y', 2, 'team-role');
  const preparation = { kind: 'native_prefix' as const, turnId: 'selected-turn', messageId: 'selected-message' };
  prefix.projection.receipt.preparation = preparation; prefix.projection.receipt.prepared!.preparation = preparation;
  const description: SuccessionDescription = { role: { ...prefix.projection.role, revision: 1, current: native('X') }, targets: [{ providerId: 'recorded', displayName: 'Recorded' }], eligibility: { status: 'ready' } };
  const prompt: ProjectedTimelineEntry = { providerId: 'recorded', seqStart: 1, seqEnd: 1, timestamp: '2026-10-15T00:00:00Z', turnId: preparation.turnId, collapsed: [], resources: [], sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }], item: { type: 'user_message', messageId: preparation.messageId, text: 'Selected member prompt' } };
  const textKey = `session:${JSON.stringify(['host', 'recorded', 'X'])}`;
  const f = await failureFixture(false, 'A', false, '', { chain, teams: () => [team], timeline: [prompt], persistPrompt: true, successionDescription: description,
    async successionPrepare(body) {
      prefix.projection.receipt.operationId = String(body.operationId); prefix.projection.receipt.prepared!.operationId = String(body.operationId);
      return { role: description.role, record: { ...prefix.projection.receipt, phase: 'ready', committedRevision: undefined } };
    }, successionCommit() {
      chain.push(prefix); team = { ...team, revision: 2, members: [{ ...team.members[0]!, nativeSessionId: 'Y' }] };
      return { role: prefix.projection.role, record: prefix.projection.receipt, locator: prefix.to };
    }, seed(scope, source) {
      const main = createCompositionSlot('main-slot', source, scope);
      const target = { ...source, nativeSessionId: 'X', agentId: 'agent-X', title: 'Leader', teamId: 'team', teamMemberId: 'leader' };
      const member = createCompositionSlot('member-slot', target, scope), document = createCompositionDocument(scope, [main, member]);
      document.asks = document.slots.map(slot => createAskOwner(slot, scope));
      document.windows = [{ id: 'member-window', slotId: member.id, managed: true, groupId: 'team', teamMemberId: 'leader' }];
      saveCompositionDocument(document, () => true); flushRecoveryWrites();
      const drafts = new DraftStore(scope); drafts.set(textKey, 'Existing member draft'); drafts.flush();
    } });
  const panel = () => f.view.querySelector('[data-view-id="member-window"]')!;
  await settleApp(() => expect(panel()?.querySelector('[data-testid="prompt-input"]')?.textContent).toBe('Existing member draft'));
  await settleApp(() => expect(panel().querySelector('[data-prompt-edit-action]')).not.toBeNull());
  await act(async () => panel().querySelector<HTMLButtonElement>('[data-prompt-edit-action]')!.click());
  await settleApp(() => expect(f.requests.filter(request => request.url.endsWith('/succession/commit'))).toHaveLength(1));
  await act(async () => f.notify(prefix));
  await waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); }); expect(panel().querySelector('.lab-handoff-notice')?.textContent ?? '').toBe(''); }, { timeout: 6000 });
  expect(panel().querySelector('[data-testid="prompt-input"]')?.textContent).toBe('Selected member prompt');
  expect(new DraftStore(f.scope).get(textKey)).toBe('Selected member prompt');
  expect(new DraftStore(f.scope).get(`session:${JSON.stringify(['host', 'recorded', 'Y'])}`)).toBe('');
  expect(f.frames.filter(frame => frame.message?.type === 'send_message')).toEqual([]);
  expect(f.requests.filter(request => request.url.endsWith('/succession/prepare'))).toHaveLength(1);
  expect(new URL(window.location.href).searchParams.get('session')).toBe('A');
  const button = panel().querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!;
  await act(async () => { button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); button.click(); });
  await settleApp(() => expect(f.frames.filter(frame => frame.message?.type === 'send_message').map(frame => frame.message?.payload?.agentId)).toEqual(['agent-Y']));
  await settleApp(() => expect(panel().querySelector('[data-testid="prompt-input"]')?.textContent).toBe(''));
  expect(new DraftStore(f.scope).get(textKey)).toBe('');
  expect(new URL(window.location.href).searchParams.get('session')).toBe('A');
}, testDeadline);

it('persists adopted Window mappings across reload without changing native owners or Ask references', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B');
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  const slotId = succession.desired!.slot.id;
  const owners = structuredClone(succession.desired!.slot.owners);
  const askOwnerId = succession.ownerFor(slotId);
  const windowId = new URL(window.location.href).searchParams.get('window')!;
  await settleApp(() => {
    const read = readCompositionDocument(f.scope);
    expect(read.status).toBe('ready');
    if (read.status === 'ready') expect(read.document.windowBindings).toEqual(expect.arrayContaining([expect.objectContaining({ windowId, viewId: 'main', slotId })]));
  });
  await f.reload();
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  expect(succession.desired!.slot.id).toBe(slotId);
  expect(succession.desired!.slot.owners).toEqual(owners);
  expect(succession.ownerFor(slotId)).toBe(askOwnerId);
  expect(visibleQuery(f.view, '[data-testid="prompt-input"]')?.textContent).toBe('A local draft');
}, testDeadline);

it('restores an open Ask with its original source after rebinding main and opening a fresh page', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  const real = successionHooks.useSessionSuccession, realAsk = askHooks.useAskConversations, realManager = managerComponents.ChatSessionManager;
  let succession!: ReturnType<typeof real>, ask!: ReturnType<typeof realAsk>, manager!: ComponentProps<typeof realManager>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  vi.spyOn(askHooks, 'useAskConversations').mockImplementation((...args) => { ask = realAsk(...args); return ask; });
  vi.spyOn(managerComponents, 'ChatSessionManager').mockImplementation(props => { manager = props; return realManager(props); });
  const f = await failureFixture(false, 'B', false, '', { chain: [], seed(scope, source) {
    const store = new ForkStore(`ask:${scope}`, sessionStorage);
    const record = store.prepare(referenceForkContext(source), { sourceNativeSessionId: source.nativeSessionId });
    store.bind(record.id, { ...source, nativeSessionId: 'T', agentId: 'agent-T', title: 'Ask for A' });
    store.markConfigured(record.id); store.finishCreation(record.id);
  } });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  const sourceA = succession.binding!.session, ownerA = succession.ownerFor(sourceA.viewId);
  await setGlobalAskVisible(f.view, true);
  await act(async () => f.view.querySelector<HTMLButtonElement>('[aria-label="Ask about this session"]')!.click());
  await settleApp(() => expect(ask.isOpen(sourceA, ownerA)).toBe(true));
  await settleApp(() => expect(f.view.querySelector('[role="dialog"][aria-label="Ask"] [data-testid="prompt-input"]')).not.toBeNull());
  const windowId = new URL(window.location.href).searchParams.get('window')!;
  await act(async () => manager.onOpen({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'B', title: 'Main B' }));
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  const sourceB = succession.binding!.session, ownerB = succession.ownerFor(sourceB.viewId);
  expect(ask.sharedView(ownerB)).toBeUndefined();
  expect(ask.entryFor(sourceB, ownerB).record?.target?.nativeSessionId).not.toBe('T');
  expect(ask.entryFor(sourceA, ownerA).record?.source.nativeSessionId).toBe('A');
  expect(ask.entryFor(sourceA, ownerA).record?.target?.nativeSessionId).toBe('T');
  await f.newTab('B', windowId);
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  await settleApp(() => expect(f.view.querySelectorAll('[role="dialog"][aria-label="Ask"]')).toHaveLength(1));
  const restoredOwners = succession.document.asks.filter(owner => ask.sharedView(owner.id));
  expect(restoredOwners).toHaveLength(1);
  const restoredSlot = succession.document.slots.find(slot => slot.id === restoredOwners[0]!.sourceSlot)!;
  expect(restoredSlot.intent.target.native.nativeSessionId).toBe('A');
  const currentOwner = succession.ownerFor(succession.binding!.session.viewId);
  expect(ask.sharedView(currentOwner)).toBeUndefined();
  expect(ask.entryFor(succession.binding!.session, currentOwner).record?.target?.nativeSessionId).not.toBe('T');
  expect(() => parseComposition(succession.document, f.scope)).not.toThrow();
  await act(async () => f.view.querySelector<HTMLElement>('.lab-primary-conversation')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
  expect(f.view.querySelectorAll('[aria-label="Ask about this session"]')).toHaveLength(1);
  await settleApp(() => expect(f.view.querySelector<HTMLButtonElement>('[aria-label="Ask about this session"]')!.disabled).toBe(false));
  await act(async () => f.view.querySelector<HTMLButtonElement>('[aria-label="Ask about this session"]')!.click());
  await settleApp(() => expect(ask.entryFor(succession.binding!.session, currentOwner).record?.target?.nativeSessionId).toBe('S'));
  expect(f.requests.filter(request => request.url.endsWith('/create')).map(request => request.body?.sourceNativeSessionId)).toEqual(['B']);
  expect(f.view.querySelectorAll('[role="dialog"][aria-label="Ask"]')).toHaveLength(2);
  expect(ask.entryFor(sourceA, restoredOwners[0]!.id).record?.target?.nativeSessionId).toBe('T');
});

it('keeps one global Ask launcher and retains the original Ask draft when another primary root is selected', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  const f = await failureFixture(false, 'A', false, '&window=global-ask-roots', { chain: [], seed(scope, source) {
    const binding = (id: string) => ({ hostId: 'host', providerId: 'recorded', nativeSessionId: id, title: `Root ${id}` });
    const document: WorkspaceWindow = { schemaVersion: 3, id: 'global-ask-roots', title: 'Ask roots', revision: 0,
      selectedPrimaryViewId: 'primary-A', selectedViewId: 'primary-A',
      views: [createWindowView('primary-A', binding('A'), 'primary'), createWindowView('primary-X', binding('X'), 'primary')] };
    localStorage.setItem(`agent-remote:recovery:${scope}:shared-window:${document.id}`, JSON.stringify(document));
    const store = new ForkStore(`ask:${scope}`, sessionStorage);
    const record = store.prepare(referenceForkContext(source), { sourceNativeSessionId: 'A' });
    store.bind(record.id, { ...source, nativeSessionId: 'T', agentId: 'agent-T', title: 'Ask for A' });
    store.markConfigured(record.id); store.finishCreation(record.id);
  } });
  const group = (id: string) => f.view.querySelector<HTMLElement>(`[data-primary-group-id="${id}"]`)!;
  const trigger = () => f.view.querySelector<HTMLButtonElement>('[aria-label="Ask about this session"]')!;
  await settleApp(() => expect(f.view.querySelectorAll('.lab-primary-group [data-testid="prompt-input"]'), f.view.textContent ?? '').toHaveLength(2));
  expect(trigger()).toBeNull();
  await setGlobalAskVisible(f.view, true);
  expect(f.view.querySelectorAll('[aria-label="Ask about this session"]')).toHaveLength(1);
  expect(trigger().closest('[data-view-id], [data-primary-group-id]')).toBeNull();
  expect(f.requests.filter(request => request.url.endsWith('/create'))).toHaveLength(0);
  await settleApp(() => expect(trigger().disabled).toBe(false));
  await act(async () => trigger().click());
  await settleApp(() => expect(f.view.querySelector('[role="dialog"][aria-label="Ask"] [data-testid="prompt-input"]')).not.toBeNull());
  const original = f.view.querySelector<HTMLElement>('[role="dialog"][aria-label="Ask"]')!;
  await editVisiblePrompt(original, 'Keep the question about A');
  await act(async () => group('primary-X').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
  await settleApp(() => expect(group('primary-X').getAttribute('data-selected')).toBe('true'));
  expect(f.view.contains(original)).toBe(true);
  expect(original.closest('[hidden]')).toBeNull();
  await settleApp(() => expect(original.querySelector('[data-testid="prompt-input"]')?.textContent).toBe('Keep the question about A'));
  expect(f.view.querySelectorAll('[aria-label="Ask about this session"]')).toHaveLength(1);
  await settleApp(() => expect(trigger().disabled).toBe(false));
  await act(async () => trigger().click());
  await settleApp(() => expect(f.requests.filter(request => request.url.endsWith('/create')).map(request => request.body?.sourceNativeSessionId)).toEqual(['X']));
  await settleApp(() => expect(f.view.querySelectorAll('[role="dialog"][aria-label="Ask"] [data-testid="prompt-input"]')).toHaveLength(2));
  expect(f.view.contains(original)).toBe(true);
  expect(original.querySelector('[data-testid="prompt-input"]')?.textContent).toBe('Keep the question about A');
  expect(f.view.querySelectorAll('[aria-label="Ask about this session"]')).toHaveLength(1);
  await setGlobalAskVisible(f.view, false);
  expect(f.view.querySelector('[aria-label="Ask about this session"]')).toBeNull();
  expect(f.view.querySelector('[role="dialog"][aria-label="Ask"]')).toBeNull();
  await setGlobalAskVisible(f.view, true);
  await settleApp(() => expect([...f.view.querySelectorAll('[role="dialog"][aria-label="Ask"] [data-testid="prompt-input"]')]
    .map(input => input.textContent)).toContain('Keep the question about A'));
  expect(f.requests.filter(request => request.url.endsWith('/create')).map(request => request.body?.sourceNativeSessionId)).toEqual(['X']);
}, testDeadline);

it.each(['global-hidden', 'source-collapsed', 'source-rebound'] as const)('tracks Ask read state from its global presentation when %s', async scenario => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const realTracking = trackingHooks.useSessionTracking;
  let tracking!: ReturnType<typeof realTracking>;
  vi.spyOn(trackingHooks, 'useSessionTracking').mockImplementation((...args) => { tracking = realTracking(...args); return tracking; });
  const realManager = managerComponents.ChatSessionManager;
  let manager!: ComponentProps<typeof realManager>;
  vi.spyOn(managerComponents, 'ChatSessionManager').mockImplementation(props => { if (props.current?.nativeSessionId === 'A') manager = props; return realManager(props); });
  const f = await failureFixture(false, 'A', false, '&window=global-ask-read-state', { chain: [], liveActivity: true, seed(scope, source) {
    const binding = (id: string) => ({ hostId: 'host', providerId: 'recorded', nativeSessionId: id, title: `Root ${id}` });
    const document: WorkspaceWindow = { schemaVersion: 3, id: 'global-ask-read-state', title: 'Ask read state', revision: 0,
      selectedPrimaryViewId: 'primary-A', selectedViewId: 'primary-A',
      views: [createWindowView('primary-A', binding('A'), 'primary'), createWindowView('primary-X', binding('X'), 'primary')] };
    localStorage.setItem(`agent-remote:recovery:${scope}:shared-window:${document.id}`, JSON.stringify(document));
    const target = { ...source, nativeSessionId: 'T', agentId: 'agent-T', title: 'Ask for A', hostId: 'host', starredAt: 1 };
    saveTrackedSessions(scope, [target]);
    const store = new ForkStore(`ask:${scope}`, sessionStorage);
    const record = store.prepare(referenceForkContext(source), { sourceNativeSessionId: 'A' });
    store.bind(record.id, target); store.markConfigured(record.id); store.finishCreation(record.id);
  } });
  const key = sessionKey({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'T' });
  await setGlobalAskVisible(f.view, true);
  const trigger = () => f.view.querySelector<HTMLButtonElement>('[aria-label="Ask about this session"]')!;
  await settleApp(() => expect(trigger().disabled).toBe(false));
  await act(async () => trigger().click());
  await settleApp(() => expect(f.view.querySelector('[role="dialog"][aria-label="Ask"] [data-testid="prompt-input"]')).not.toBeNull());
  await settleApp(() => expect(tracking.observations[key]?.connection).toBe('ready'));
  if (scenario === 'global-hidden') {
    await setGlobalAskVisible(f.view, false);
    expect(f.view.querySelector('[role="dialog"][aria-label="Ask"]')).toBeNull();
  } else if (scenario === 'source-rebound') {
    await act(async () => manager.onOpen({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'B', title: 'Main B' }));
    await settleApp(() => expect(f.view.querySelector('[data-primary-group-id="primary-A"]')?.textContent).toContain('Main B'));
    expect(f.view.querySelector('[role="dialog"][aria-label="Ask"]')?.closest('[hidden]')).toBeNull();
  } else {
    const sourceGroup = f.view.querySelector<HTMLElement>('[data-primary-group-id="primary-A"]')!;
    await act(async () => sourceGroup.querySelector<HTMLButtonElement>('.lab-primary-group-minimize')!.click());
    const other = f.view.querySelector<HTMLElement>('[data-primary-group-id="primary-X"]')!;
    await act(async () => other.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    await settleApp(() => expect(other.getAttribute('data-selected')).toBe('true'));
    expect(f.view.querySelector('[role="dialog"][aria-label="Ask"]')?.closest('[hidden]')).toBeNull();
  }
  await act(async () => f.emitActivity('agent-T', 'running'));
  await settleApp(() => expect(tracking.observations[key]?.activity).toBe('running'));
  await act(async () => f.emitActivity('agent-T', 'waiting'));
  await settleApp(() => expect(tracking.observations[key]?.activity).toBe('waiting'));
  expect(tracking.observations[key]?.attention).toBe(scenario === 'global-hidden' ? 'pending' : undefined);
}, testDeadline);

it('opens the global Ask overlay from the foreground session on a narrow screen', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes('max-width: 1180px'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })));
  const binding = (id: string) => ({ hostId: 'host', providerId: 'recorded', nativeSessionId: id, title: `Root ${id}` });
  const document: WorkspaceWindow = { schemaVersion: 3, id: 'global-ask-mobile', title: 'Mobile Ask', revision: 0,
    selectedPrimaryViewId: 'primary-X', selectedViewId: 'primary-X',
    views: [createWindowView('primary-A', binding('A'), 'primary'), createWindowView('primary-X', binding('X'), 'primary')] };
  const f = await failureFixture(false, 'A', false, `&window=${document.id}`, { chain: [], selected: 'X', seed(scope) {
    localStorage.setItem(`agent-remote:recovery:${scope}:shared-window:${document.id}`, JSON.stringify(document));
  } });
  await settleApp(() => expect(visibleQuery(f.view, '[data-primary-group-id="primary-X"] [data-testid="prompt-input"]')).not.toBeNull());
  expect(f.view.querySelector('[data-primary-group-id="primary-A"]')?.closest('[hidden]')).not.toBeNull();
  await setGlobalAskVisible(f.view, true);
  const trigger = f.view.querySelector<HTMLButtonElement>('[aria-label="Ask about this session"]')!;
  expect(trigger.closest('[hidden], [data-view-id], [data-primary-group-id]')).toBeNull();
  expect(trigger.disabled).toBe(false);
  await act(async () => trigger.click());
  await settleApp(() => expect(f.requests.filter(request => request.url.endsWith('/create')).map(request => request.body?.sourceNativeSessionId)).toEqual(['X']));
  await settleApp(() => expect(visibleQuery(f.view, '[role="dialog"][aria-label="Ask"] [data-testid="prompt-input"]')).not.toBeNull());
  expect(f.view.querySelector('[role="dialog"][aria-label="Ask"]')?.closest('[data-primary-group-id]')).toBeNull();
  expect(f.view.querySelectorAll('[aria-label="Ask about this session"]')).toHaveLength(1);
}, testDeadline);

it('keeps both primary conversations mounted with separate drafts and creates an empty dock without a primary selector', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  const f = await failureFixture(false, 'A', false, '&window=multi-primary-test', { chain: [], async seed(scope, source) {
    const secondary = { ...source, nativeSessionId: 'X', agentId: 'agent-X', title: 'Secondary X' };
    localStorage.setItem(`agent-remote-opened:${scope}`, JSON.stringify([source, secondary]));
    const view = (id: string, session: OpenedSession) => ({ id, placement: 'primary', width: 520, collapsed: false,
      display: { mode: 'content', lettersVisible: true }, bindingPolicy: 'replaceable',
      binding: { hostId: session.hostId, providerId: session.providerId, nativeSessionId: session.nativeSessionId, title: session.title } });
    localStorage.setItem(`agent-remote:recovery:${scope}:shared-window:multi-primary-test`, JSON.stringify({
      schemaVersion: 3, id: 'multi-primary-test', title: 'Parallel work', revision: 0,
      selectedPrimaryViewId: 'primary-A', selectedViewId: 'primary-A', views: [view('primary-A', source), view('primary-X', secondary)],
    }));
  } });
  const group = (id: string) => f.view.querySelector<HTMLElement>(`[data-primary-group-id="${id}"]`);
  await settleApp(() => expect(group('primary-X')).not.toBeNull());
  expect(f.view.querySelector('[aria-label="Primary session groups"]')).toBeNull();
  expect(f.view.querySelector('[aria-label="New primary group"]')).toBeNull();
  const a = f.view.querySelector('[data-primary-group-id="primary-A"]');
  await settleApp(() => expect(f.view.querySelectorAll('.lab-primary-group [data-testid="prompt-input"]')).toHaveLength(2));
  const conversations = [...f.view.querySelectorAll<HTMLElement>('.lab-primary-group')];
  expect(conversations.some(pane => pane.querySelector('[data-testid="prompt-input"]')?.textContent === 'A local draft')).toBe(true);
  await settleApp(() => {
    const editor = visibleQuery(conversations[1]!, '[data-testid="prompt-input"]');
    expect(editor).not.toBeNull();
    expect(editor?.getAttribute('aria-disabled')).not.toBe('true');
  });
  await editVisiblePrompt(conversations[1]!, 'X independent draft');
  expect(conversations[0]!.querySelector('[data-testid="prompt-input"]')?.textContent).toBe('A local draft');
  expect(conversations[1]!.querySelector('[data-testid="prompt-input"]')?.textContent).toBe('X independent draft');
  expect(group('primary-X')!.closest('[hidden]')).toBeNull();
  await act(async () => { group('primary-X')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
  await settleApp(() => expect(group('primary-X')!.getAttribute('data-selected')).toBe('true'));
  if (a) expect(f.view.contains(a)).toBe(true);
  expect(conversations.every(pane => f.view.contains(pane))).toBe(true);
  const add = f.view.querySelector<HTMLButtonElement>('.lab-session-dock-add');
  expect(add).not.toBeNull(); expect(add!.closest('[hidden]')).toBeNull();
  await act(async () => add!.click());
  await settleApp(() => {
    const saved = JSON.parse(localStorage.getItem(`agent-remote:recovery:${f.scope}:shared-window:multi-primary-test`)!).window;
    expect(saved.views).toHaveLength(3);
    expect(saved.views.filter((view: { placement: string }) => view.placement === 'primary')).toHaveLength(2);
    expect(saved.views.find((view: { id: string }) => view.id === saved.selectedViewId)).toMatchObject({ placement: 'dock' });
    expect(saved.views.find((view: { id: string }) => view.id === saved.selectedViewId)?.binding).toBeUndefined();
    expect(saved.selectedPrimaryViewId).toBe('primary-X');
  });
  expect(conversations.every(pane => f.view.contains(pane))).toBe(true);
  expect(conversations[0]!.querySelector('[data-testid="prompt-input"]')?.textContent).toBe('A local draft');
  expect(conversations[1]!.querySelector('[data-testid="prompt-input"]')?.textContent).toBe('X independent draft');
  for (const pane of conversations) {
    await settleApp(() => expect(pane.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')?.disabled).toBe(false));
    await act(async () => { const submit = pane.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!; submit.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); submit.click(); });
  }
  await settleApp(() => expect(f.frames.filter(frame => frame.message?.type === 'send_message')).toHaveLength(2));
  expect(f.frames.filter(frame => frame.message?.type === 'send_message').map(frame => frame.message!.payload).map(payload => [payload?.agentId, payload?.text]))
    .toEqual([['agent-A', 'A local draft'], ['agent-X', 'X independent draft']]);

});
