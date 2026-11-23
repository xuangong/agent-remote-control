import 'fake-indexeddb/auto';
import { SESSION_CONNECTION_PATTERN } from '@orchardworks/agent-client/testing';
import { createHash, webcrypto } from 'node:crypto';
import { StrictMode, useContext, type ComponentProps } from 'react';
import { expect, it, vi } from 'vitest';
import { type AgentChildSession, type ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { readImageDraft, writeImageDraft } from '@orchardworks/agent-client-web/browser';
import { CommunicationNavigationContext, type CommunicationNavigation } from '@orchardworks/agent-client-web/react';
import { type OpenedSession } from './kernel/directory-client.js';
import { DraftStore } from './kernel/draft-store.js';
import { readCompositionDocument } from './kernel/session-composition.js';
import * as trackingHooks from './features/sessions/useSessionTracking.js';
import * as askHooks from './features/team/useAskConversations.js';
import * as successionHooks from './hooks/useSessionSuccession.js';
import * as successionContextHooks from './conversation/useSuccessionContext.js';
import { ForkStore, referenceForkContext } from './kernel/session-forks.js';
import { sessionKey } from './kernel/session-tree.js';
import { readTrackedSessions, saveTrackedSessions } from './kernel/tracking-state.js';
import * as workbenchComponents from './conversation/LabWorkbench.js';
import * as forkActions from './conversation/fork-actions.js';
import { clearConversationRecovery } from './kernel/conversation-recovery.js';
import * as sessionCommunication from './features/session-links/session-communication.js';
import * as historyHooks from './hooks/useConversationHistory.js';
import { readLastSession } from './kernel/conversation-recovery.js';
import * as starsHooks from './features/sessions/useSessionStars.js';
import * as attentionHooks from './kernel/useSessionAttention.js';
import type { FavoritesSnapshot } from './features/sessions/session-stars-client.js';
import { act, cleanups, committed, failureFixture, handoffCommandFixture, native, saveSessionComposition, setGlobalAskVisible, settleApp, testDeadline, visibleQuery, waitFor } from './App.succession.fixture.js';

it('does not silently replace an unavailable requested Handoff provider', async () => {
  const f = await handoffCommandFixture();
  let failure: unknown;
  await act(async () => { try { await f.primary.onExecuteConsoleCommand!('console:handoff', 'missing-provider'); } catch (error) { failure = error; } });
  if (failure) expect(document.querySelector('dialog')).toBeNull();
  else {
    await settleApp(() => expect(document.querySelector<HTMLSelectElement>('dialog [aria-label="Successor provider"]')?.value).toBe(''));
    expect(document.querySelector<HTMLButtonElement>('dialog button[type="submit"]')?.disabled).toBe(true);
    expect(document.querySelector('dialog')?.textContent).toContain('missing-provider');
  }
  expect(f.requests.some(request => request.url.endsWith('/succession/prepare'))).toBe(false);
  expect(f.frames.some(frame => ['send_message', 'execute_command'].includes(frame.message?.type ?? ''))).toBe(false);
}, testDeadline);

it('opens Handoff while the native session is working and respects the Host blocked eligibility', async () => {
  const f = await handoffCommandFixture({ nativeStatus: 'running' });
  expect(f.primary.state?.agent?.status).toBe('running');
  expect(f.primary.consoleCommands?.some(command => command.id === 'console:handoff')).toBe(true);
  await act(async () => { await f.primary.onExecuteConsoleCommand!('console:handoff', ''); });
  await settleApp(() => expect(document.querySelector('dialog')?.textContent).toContain('The source is still working.'));
  expect(document.querySelector<HTMLButtonElement>('dialog button[type="submit"]')?.disabled).toBe(true);
  expect(f.requests.some(request => request.url.endsWith('/succession/prepare'))).toBe(false);
  expect(f.frames.some(frame => ['send_message', 'execute_command'].includes(frame.message?.type ?? ''))).toBe(false);
}, testDeadline);

it('refreshes successor context after Composer delivery without waiting for a native timeline echo', async () => {
  vi.stubGlobal('crypto', webcrypto);
  // The context is read at most once per interval, 2 s by default.
  const readContext = successionContextHooks.useSuccessionContext;
  vi.spyOn(successionContextHooks, 'useSuccessionContext').mockImplementation(options => readContext({ ...options, readIntervalMs: 100 }));
  const real = workbenchComponents.LabWorkbench;
  let primary!: ComponentProps<typeof real>, reads = 0;
  const pendingCounts: number[] = [];
  vi.spyOn(workbenchComponents, 'LabWorkbench').mockImplementation(props => { if (props.state?.agent) primary = props; return real({ ...props,
    onPendingInputChange: count => { pendingCounts.push(count); props.onPendingInputChange?.(count); },
  }); });
  const replay = committed();
  let contextState: 'pending' | 'materialized' = 'pending';
  const f = await failureFixture(false, 'B', false, '', { userScoped: true, successionStatus: () => {
    reads++;
    return { record: replay.projection.receipt, role: replay.projection.role,
      context: { operationId: replay.projection.receipt.operationId, target: native('B'), state: contextState } };
  } });
  await settleApp(() => { expect(primary.state?.agent?.id).toBe('agent-B'); expect(primary.pendingFirstInputContext?.state).toBe('pending'); });
  // The context is read at most once per interval; past that, delivery's refresh reads it at once.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
  const observed = reads, timeline = structuredClone(primary.state!.timeline);
  contextState = 'materialized';
  expect(f.view.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(false);
  await act(async () => {
    const button = f.view.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!;
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); button.click();
  });
  expect([...f.view.querySelectorAll('.agent-composer [role="alert"]')].map(item => item.textContent)).toEqual([]);
  await settleApp(() => expect(f.frames.filter(frame => frame.message?.type === 'send_message')).toHaveLength(1));
  expect(pendingCounts).toContain(1);
  // A pending context is not polled, so only delivery's refresh can read it again.
  await settleApp(() => { expect(primary.pendingFirstInputContext).toBeUndefined(); expect(reads).toBeGreaterThan(observed); });
  expect(primary.state!.timeline).toEqual(timeline);
  expect(f.requests.filter(request => request.url.endsWith('/succession/status')).every(request => request.body?.includeContext === true)).toBe(true);
}, testDeadline);

it.each(['history', 'child'] as const)('does not expose or execute Handoff from the %s native view', async context => {
  const f = await handoffCommandFixture({ context });
  expect(f.primary.consoleCommands?.some(command => command.id === 'console:handoff')).toBe(false);
  await act(async () => { await expect(f.primary.onExecuteConsoleCommand!('console:handoff', '')).rejects.toThrow(); });
  expect(document.querySelector('dialog')).toBeNull();
  expect(f.requests.some(request => request.url.endsWith('/succession/describe') || request.url.endsWith('/succession/prepare'))).toBe(false);
  expect(f.frames.some(frame => ['send_message', 'execute_command'].includes(frame.message?.type ?? ''))).toBe(false);
}, testDeadline);

it('old desktop A notification still opens concrete A history after B and C confirmation', async () => {
  const notices: Array<{ title: string; options: NotificationOptions; onclick?: () => void; close: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('Notification', class {
    static permission = 'granted';
    close = vi.fn();
    constructor(readonly title: string, readonly options: NotificationOptions) { notices.push(this); }
  });
  const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
  const realAttention = attentionHooks.useSessionAttention, realSuccession = successionHooks.useSessionSuccession;
  const realWorkbench = workbenchComponents.LabWorkbench;
  let attention!: ReturnType<typeof realAttention>, succession!: ReturnType<typeof realSuccession>, primary!: ComponentProps<typeof realWorkbench>;
  const opened: unknown[] = [];
  vi.spyOn(attentionHooks, 'useSessionAttention').mockImplementation((scope, active, open) => {
    attention = realAttention(scope, active, session => { opened.push(structuredClone(session)); open(session); }); return attention;
  });
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = realSuccession(...args); return succession; });
  vi.spyOn(workbenchComponents, 'LabWorkbench').mockImplementation(props => { if (props.state?.agent) primary = props; return realWorkbench(props); });
  let source!: OpenedSession;
  const entry: ProjectedTimelineEntry = { providerId: 'recorded', seqStart: 1, seqEnd: 1, timestamp: 'now', turnId: 'A-turn', resources: [], collapsed: [], sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
    item: { type: 'assistant_message', text: 'Original A completion' } };
  const f = await failureFixture(false, 'B', false, '', { chain: [], userScoped: true, timeline: [entry], seed(_scope, original) { source = original; } });
  await settleApp(() => { expect(primary.state?.agent?.id).toBe('agent-A'); expect(primary.state?.timeline.initialized).toBe(true); expect(attention.enabled).toBe(true); });
  const locator = structuredClone(source), cursor = { epoch: 'epoch-agent-A', seq: 1 };
  await act(async () => {
    await attention.notifier.observe(source, { connection: 'ready', activity: 'running', cursor: { ...cursor, seq: 0 } });
    await attention.notifier.observe(source, { connection: 'ready', activity: 'idle', cursor });
  });
  expect(notices).toHaveLength(1);
  const original = notices[0]!, receipt = createHash('sha256').update(JSON.stringify([f.scope, sessionKey(locator), 'idle', cursor])).digest('hex');
  expect(original.options.tag).toBe(`arc:${receipt}`);
  expect(JSON.parse(localStorage.getItem('agent-remote:notification-receipts')!)).toEqual([receipt]);
  const receipts = localStorage.getItem('agent-remote:notification-receipts');
  for (const replay of [committed(), committed('B', 'C', 3)]) {
    f.chain.push(replay); await act(async () => f.notify(replay));
    await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe(replay.to.nativeSessionId));
  }
  const beforeClick = f.requests.length;
  await act(async () => original.onclick!());
  await settleApp(() => { expect(succession.binding?.session.nativeSessionId).toBe('A'); expect(primary.state?.agent?.id).toBe('agent-A'); expect(primary.state?.timeline.initialized).toBe(true); expect(new URL(window.location.href).searchParams.get('session')).toBe('A'); });
  expect(opened).toEqual([locator]);
  expect(source).toEqual(locator);
  expect(original.options.tag).toBe(`arc:${receipt}`);
  expect(localStorage.getItem('agent-remote:notification-receipts')).toBe(receipts);
  expect(notices[0]).toBe(original);
  expect(original.close).toHaveBeenCalledOnce(); expect(focus).toHaveBeenCalledOnce();
  expect(new URL(window.location.href).searchParams.get('session')).toBe('A');
  expect(new URL(window.location.href).searchParams.get('intent')).toBe('history');
  expect(succession.desired?.slot.intent).toMatchObject({ kind: 'history', target: { native: { providerId: 'recorded', nativeSessionId: 'A' } } });
  expect(succession.desired?.slot.owners.text.key).toMatch(/^view:/);
  expect(f.view.textContent).toContain('Original A completion');
  expect(visibleQuery(f.view, '[data-testid="prompt-input"]')?.textContent).toBe('');
  expect(f.requests.slice(beforeClick).filter(item => item.url.endsWith('/attach'))).toEqual([]);
  expect(f.frames.some(frame => ['send_message', 'execute_command', 'image_upload_begin'].includes(frame.message?.type ?? ''))).toBe(false);
});

it.each([false, true])('first complete A-B-C discovery retains the origin owners with independent B=%s', async independentB => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>, source!: OpenedSession, independent!: OpenedSession;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B', false, '', { chain: [committed(), committed('B', 'C', 3)], async seed(scope, original) {
    source = original; independent = { ...original, nativeSessionId: 'B', agentId: 'agent-B', title: 'Independent B' };
    localStorage.setItem(`agent-remote-opened:${scope}`, JSON.stringify(independentB ? [source, independent] : [source]));
    const drafts = new DraftStore(scope); drafts.set(independent.agentId, 'Independent B draft'); drafts.flush();
    await writeImageDraft({ version: 1, scope, key: JSON.stringify([scope, sessionKey(source)]),
      parts: [{ type: 'text', text: 'A local draft' }, { type: 'image', imageId: 'origin-image', label: 'Origin image' }],
      images: { 'origin-image': { imageId: 'origin-image', blob: new Blob(['Origin image bytes'], { type: 'image/png' }), uploadId: 'origin-upload', status: 'pending', progress: 0 } }, nextLabel: 2 });
  } });
  await settleApp(() => { expect(succession.desired?.slot.owners.text.key).toBe('agent-A'); });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('C'));
  expect(succession.result?.status).toBe('applied');
  expect(visibleQuery(f.view, '[data-testid="prompt-input"]')?.textContent).toContain('A local draft');
  expect(succession.desired?.slot.owners).toEqual({ text: { scope: f.scope, key: 'agent-A' },
    image: { scope: f.scope, key: JSON.stringify([f.scope, sessionKey(source)]) }, display: { scope: f.scope, key: sessionKey(source) } });
  const image = (await readImageDraft(succession.desired!.slot.owners.image.key))?.images['origin-image'];
  expect(image?.blob && await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(image.blob!); })).toBe('Origin image bytes');
  if (independentB) {
    const slot = succession.document.slots.find(slot => slot.owners.text.key === independent.agentId)!;
    expect(slot.intent).toMatchObject({ kind: 'fixed', target: { native: { nativeSessionId: 'B' } } });
    expect(slot.id).not.toBe(succession.desired!.slot.id);
    expect(new DraftStore(f.scope).get(independent.agentId)).toBe('Independent B draft');
    expect(succession.document.retained).toContainEqual({ slot: slot.id, against: succession.desired!.slot.id });
  }
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['C']);
  expect(f.frames.filter(frame => frame.message && ['send_message', 'execute_command', 'image_upload_begin'].includes(frame.message.type))).toEqual([]);
});

it.each(['confirmed', 'failed'] as const)('reopening current B preserves its %s outcome until explicit Retry', async outcome => {
  const real = successionHooks.useSessionSuccession, realHistory = historyHooks.useConversationHistory;
  let succession!: ReturnType<typeof real>, open!: Parameters<typeof realHistory>[2];
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  vi.spyOn(historyHooks, 'useConversationHistory').mockImplementation((...args) => { open = args[2]; return realHistory(...args); });
  const f = await failureFixture(false, outcome === 'confirmed' ? 'B' : undefined);
  await settleApp(() => {
    if (outcome === 'confirmed') expect(succession.binding?.session.nativeSessionId).toBe('B');
    else expect(succession.error).toBe('Fixture successor unavailable.');
  });
  const editor = visibleQuery(f.view, '[data-testid="prompt-input"]'), owners = structuredClone(succession.desired!.slot.owners), binding = succession.binding;
  await act(async () => { expect(await open({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'B', title: 'Current B' })).toBe(true); });
  if (outcome === 'confirmed') { expect(succession.binding).toBe(binding); expect(succession.isCurrent()).toBe(true); }
  else {
    expect(succession.error).toBe('Fixture successor unavailable.');
    expect([...f.view.querySelectorAll('button')].some(button => button.textContent === 'Retry session')).toBe(true);
  }
  for (const keepOriginal of [true, false]) {
    await act(async () => { expect(await open({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'B', title: 'Current B' }, undefined, keepOriginal)).toBe(true); });
    expect(succession.desired?.keepOriginal).toBe(keepOriginal);
    if (outcome === 'confirmed') expect(succession.binding).toBe(binding);
    else expect(succession.error).toBe('Fixture successor unavailable.');
  }
  expect(succession.desired!.slot.owners).toEqual(owners);
  expect(visibleQuery(f.view, '[data-testid="prompt-input"]')).toBe(editor);
  expect(editor?.textContent).toBe('A local draft');
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B']);
  if (outcome === 'failed') {
    f.setNativeIdentity('B');
    await act(async () => [...f.view.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry session')!.click());
    await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
    expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B', 'B']);
  }
  expect(f.frames.filter(frame => frame.message && ['send_message', 'execute_command', 'image_upload_begin'].includes(frame.message.type))).toEqual([]);
});

it('access suspension keeps hot B ownership and resumes only after authoritative recovery', async () => {
  const real = successionHooks.useSessionSuccession, realWorkbench = workbenchComponents.LabWorkbench;
  let succession!: ReturnType<typeof real>, primary!: ComponentProps<typeof realWorkbench>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  vi.spyOn(workbenchComponents, 'LabWorkbench').mockImplementation(props => { if (props.state?.agent) primary = props; return realWorkbench(props); });
  const f = await failureFixture(false, 'B', false, '', { chain: [] });
  await settleApp(() => expect(primary.state?.agent?.id).toBe('agent-A'));
  const next = committed(); f.chain.push(next); await act(async () => f.notify(next));
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  const editor = visibleQuery(f.view, '[data-testid="prompt-input"]'), owners = structuredClone(succession.desired!.slot.owners);
  const oldRecipient = succession.imageRecipient!, oldPrimary = primary;
  const beforeRequests = f.requests.length, beforeFrames = f.frames.length;
  await act(async () => f.setAccessReady(false));
  expect(new URL(window.location.href).searchParams.get('session')).toBe('B');
  expect(succession.active).toBe(true);
  expect(succession.selected?.nativeSessionId).toBe('B');
  expect(readLastSession(f.scope)?.nativeSessionId).toBe('B');
  expect(primary.state?.agent?.id).not.toBe('agent-A');
  expect(primary.draftOnly).toBe(true); expect(succession.isCurrent()).toBe(false); expect(oldRecipient.isCurrent()).toBe(false);
  expect(succession.desired!.slot.owners).toEqual(owners);
  expect(visibleQuery(f.view, '[data-testid="prompt-input"]')).toBe(editor);
  await act(async () => { primary.draftBinding!.store.set(primary.draftBinding!.key, 'Edited while access paused'); });
  expect(editor?.textContent).toBe('Edited while access paused');
  await expect(oldPrimary.actions.sendMessage!('Must remain local')).rejects.toThrow();
  expect(f.requests.slice(beforeRequests).filter(item => item.url.endsWith('/attach'))).toEqual([]);
  expect(f.frames.slice(beforeFrames).filter(frame => frame.message && ['send_message', 'execute_command', 'image_upload_begin'].includes(frame.message.type))).toEqual([]);
  const release = f.pauseReplay();
  await act(async () => f.setAccessReady(true));
  await settleApp(() => expect(f.requests.slice(beforeRequests).some(item => item.url.includes('/session-successions'))).toBe(true));
  expect(succession.isCurrent()).toBe(false); expect(oldRecipient.isCurrent()).toBe(false);
  expect(succession.selected?.nativeSessionId).toBe('B');
  expect(editor?.textContent).toBe('Edited while access paused');
  release();
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  expect(succession.imageRecipient?.isCurrent()).toBe(true); expect(oldRecipient.isCurrent()).toBe(false);
  expect(succession.desired!.slot.owners).toEqual(owners);
  expect(visibleQuery(f.view, '[data-testid="prompt-input"]')).toBe(editor);
  expect(f.requests.slice(beforeRequests).filter(item => item.url.endsWith('/attach')).every(item => item.body?.nativeSessionId === 'B')).toBe(true);
  expect(new URL(window.location.href).searchParams.get('session')).toBe('B');
  expect(readLastSession(f.scope)?.nativeSessionId).toBe('B');
});

it('newer Favorites progress with the same tree revision recovers missed succession once', async () => {
  const real = successionHooks.useSessionSuccession, realStars = starsHooks.useSessionStars;
  let succession!: ReturnType<typeof real>, favorites!: ReturnType<typeof realStars>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  vi.spyOn(starsHooks, 'useSessionStars').mockImplementation((...args) => { favorites = realStars(...args); return favorites; });
  const snapshot = (revision: number, status: 'applied' | 'pending' = 'applied'): FavoritesSnapshot => ({ revision: 7, folders: [],
    stars: ['B', 'C'].map((nativeSessionId, index) => ({ hostId: 'host', providerId: 'recorded', nativeSessionId, title: nativeSessionId,
      starredAt: 1, favoriteId: `favorite-${nativeSessionId}`, folderId: null, order: index, available: true, online: true })),
    successionProgress: { version: 1, roles: [{ hostId: 'host', controllerId: 'installation', roleId: 'primary', roleRevision: revision, operationId: `primary-op-${revision}`, status }] } });
  const f = await failureFixture(false, 'B', false, '', { userScoped: true, favorites: snapshot(2) });
  await settleApp(() => { expect(succession.binding?.session.nativeSessionId).toBe('B'); expect(favorites.ready).toBe(true); });
  const queries = () => f.requests.filter(item => item.url.includes('/session-successions?')).length;
  const before = queries(), editor = visibleQuery(f.view, '[data-testid="prompt-input"]');
  f.chain.push(committed('B', 'C', 3)); f.setFavorites(snapshot(3));
  const release = f.pauseReplay();
  try {
    await act(async () => { await favorites.refresh(); });
    expect(favorites.revision).toBe(7); expect(favorites.successionProgress?.roles[0]?.roleRevision).toBe(3);
    await settleApp(() => expect(queries()).toBeGreaterThan(before));
    expect(succession.selected?.nativeSessionId).toBe('B');
    expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B']);
  } finally { release(); }
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('C'));
  expect(visibleQuery(f.view, '[data-testid="prompt-input"]')).toBe(editor);
  expect(editor?.textContent).toBe('A local draft');
  const after = queries();
  for (const value of [snapshot(3), snapshot(2), snapshot(2, 'pending'), { revision: 7, folders: [], stars: snapshot(3).stars }]) {
    f.setFavorites(value); await act(async () => { await favorites.refresh(); });
    expect(queries()).toBe(after); expect(succession.selected?.nativeSessionId).toBe('C');
  }
  f.setFavorites(snapshot(4, 'pending')); await act(async () => { await favorites.refresh(); });
  await settleApp(() => { expect(queries()).toBeGreaterThan(after); expect(succession.discovering).toBe(false); });
  expect(succession.selected?.nativeSessionId).toBe('C');
  expect(succession.document.roles[0]?.appliedRevision).toBe(3);
  const pendingQueries = queries();
  f.setFavorites(snapshot(4, 'pending')); await act(async () => { await favorites.refresh(); });
  expect(queries()).toBe(pendingQueries);
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B', 'C']);
  expect(f.frames.filter(frame => frame.message && ['send_message', 'execute_command', 'image_upload_begin'].includes(frame.message.type))).toEqual([]);
});

it('discovers desired B over HTTP before any A attach, retains its owner on failure and retries only explicitly', async () => {
  const f = await failureFixture();
  await settleApp(() => { expect(f.view.textContent).toContain('Fixture successor unavailable.'); });
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B']);
  expect(visibleQuery(f.view, '[data-testid="prompt-input"]')?.textContent).toBe('A local draft');
  const saved = readCompositionDocument(f.scope);
  expect(saved.status).toBe('ready');
  if (saved.status === 'ready') expect(saved.document.slots[0]?.intent).toMatchObject({ kind: 'role', revision: 2, target: { native: native('B') } });
  await act(async () => {
    const retry = [...f.view.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry session');
    expect(retry).toBeDefined(); retry!.click();
    await waitFor(() => expect(f.requests.filter(item => item.url.endsWith('/attach'))).toHaveLength(2));
  });
  expect(f.requests.filter(item => item.body && !item.url.startsWith('/v1/windows') && !item.url.endsWith('/attach') && !item.url.endsWith('/succession/status')).map(item => item.url)).toEqual([]);
});

it('uses C when current advances during initial A enrollment after the discovery page reported B', async () => {
  const f = await failureFixture(true);
  await settleApp(() => { expect(f.view.textContent).toContain('Fixture successor unavailable.'); });
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['C']);
  expect(new URL(f.requests.find(item => item.url.includes('/session-successions?'))!.url, f.scope).searchParams.get('limit')).toBe('64');
  const saved = readCompositionDocument(f.scope);
  if (saved.status !== 'ready') throw new Error('Composition was not saved.');
  expect(saved.document.slots[0]!.intent).toMatchObject({ kind: 'role', revision: 3, target: { native: native('C') } });
  await act(async () => [...f.view.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry session')!.click());
  await waitFor(() => expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['C', 'C']));
});


it.each([null, 'wrong-native'])('keeps the opaque draft editable and refuses native input for snapshot identity %s', async identity => {
  const f = await failureFixture(false, identity);
  await settleApp(() => { expect(f.view.textContent).toContain('The native session identity could not be confirmed.'); });
  expect(visibleQuery(f.view, '[data-testid="prompt-input"]')?.textContent).toBe('A local draft');
  expect(f.frames.some(frame => frame.message?.type === 'send_message')).toBe(false);
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B']);
});

it('confirms only B through the real session channel in StrictMode and keeps its view during native recovery', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B', true);
  await settleApp(() => { expect(succession.binding?.session.nativeSessionId).toBe('B');
    expect(visibleQuery(f.view, '.lab-primary-conversation [data-testid="prompt-input"]')).not.toBeNull(); });
  const editor = visibleQuery(f.view, '.lab-primary-conversation [data-testid="prompt-input"]');
  expect(editor?.textContent).toBe('A local draft');
  await act(async () => { for (const update of f.updates) update('B', 'restoring'); });
  // A restoring runtime says nothing per session (target T5); the view and its editor stay.
  await settleApp(() => { expect(visibleQuery(f.view, '.lab-primary-conversation [data-testid="prompt-input"]')).toBe(editor); });
  expect(f.view.textContent).not.toMatch(SESSION_CONNECTION_PATTERN);
  expect(visibleQuery(f.view, '.lab-primary-conversation [data-testid="prompt-input"]')).toBe(editor);
  await act(async () => { for (const update of f.updates) update('B'); });
  expect(f.frames.filter(frame => frame.type === 'subscribe').every(frame => frame.agentId === 'agent-B')).toBe(true);
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B']);
});


it.each([['&keepOriginal=1', 'B', 'A local draft'], ['&intent=history', 'A', '']])('keeps prompt-edit behavior independent of succession history owners: %s', async (flags, expected, draft) => {
  const f = await failureFixture(false, undefined, false, flags);
  await settleApp(() => { expect(f.view.textContent).toContain('Fixture successor unavailable.'); });
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual([expected]);
  expect(visibleQuery(f.view, '[data-testid="prompt-input"]')?.textContent).toBe(draft);
  const read = readCompositionDocument(f.scope);
  if (read.status !== 'ready') throw new Error('Missing composition.');
  const slot = read.document.slots.find(slot => slot.intent.kind === (flags.includes('history') ? 'history' : 'role'))!;
  expect(slot).toBeDefined();
  expect(slot.owners.text.key === 'agent-A').toBe(!flags.includes('history'));
});

it('treats succession notifications as hints until authorized HTTP recovery completes', async () => {
  const f = await failureFixture(false, 'B');
  await settleApp(() => { expect(f.view.querySelector('.lab-has-agent')).not.toBeNull(); });
  const release = f.pauseReplay();
  try {
    const before = f.requests.length;
    await act(async () => f.notify(committed('B', 'C', 3)));
    await waitFor(() => expect(f.requests.length).toBeGreaterThan(before));
    expect(f.view.querySelector('.lab-has-agent')).not.toBeNull();
    expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B']);
  } finally { release(); }
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  const saved = readCompositionDocument(f.scope);
  if (saved.status !== 'ready') throw new Error('Missing composition.');
  expect(saved.document.slots.find(slot => slot.intent.kind === 'role')?.intent).toMatchObject({ revision: 2, target: { native: native('B') } });
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B']);
});

it('commits the first role Track view before a later role participant fails', async () => {
  const realTracking = trackingHooks.useSessionTracking, rendered: string[][] = [];
  vi.spyOn(trackingHooks, 'useSessionTracking').mockImplementation((...args) => {
    const tracking = realTracking(...args); rendered.push(tracking.sessions.map(item => item.nativeSessionId)); return tracking;
  });
  const realFlush = DraftStore.prototype.flushCurrent;
  let beforeFailure: string[] | undefined;
  vi.spyOn(DraftStore.prototype, 'flushCurrent').mockImplementation(function (this: DraftStore, key, revision, current) {
    if (key === 'agent-X') {
      beforeFailure = rendered.at(-1);
      return Promise.resolve({ status: 'failed', ticket: 0, error: new Error('Second owner unavailable'), sessionWritten: false, localWritten: false });
    }
    return realFlush.call(this, key, revision, current);
  });
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const f = await failureFixture(false, undefined, false, '', { chain: [committed(), committed('X', 'Y', 2, 'secondary')], seed(scope, source) {
    const secondary = { ...source, nativeSessionId: 'X', agentId: 'agent-X', title: 'Independent second role' };
    localStorage.setItem(`agent-remote-opened:${scope}`, JSON.stringify([source, secondary]));
    saveTrackedSessions(scope, [source, secondary].map(item => ({ ...item, hostId: 'host', starredAt: 1 })));
  } });
  await waitFor(() => expect(beforeFailure).toBeDefined());
  expect(beforeFailure).toEqual(['B', 'X']);
  expect(readTrackedSessions(f.scope).map(item => item.nativeSessionId)).toEqual(['B', 'X']);
  await waitFor(() => expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B']));
  const read = readCompositionDocument(f.scope);
  if (read.status !== 'ready') throw new Error('Missing composition.');
  expect(read.document.roles.find(role => role.roleId === 'primary')?.appliedRevision).toBe(2);
  expect(read.document.roles.find(role => role.roleId === 'secondary')?.appliedRevision).toBeLessThan(2);
  expect(errors.mock.calls.flat().join(' ')).not.toContain('flushSync was called from inside a lifecycle method');
});

it.each(['edit', 'retire'] as const)('rejects an accepted but queued Track publication after %s without native observation', async boundary => {
  const realTracking = trackingHooks.useSessionTracking;
  let scope = '', interrupted = false, rendered: string[] = [];
  vi.spyOn(trackingHooks, 'useSessionTracking').mockImplementation((...args) => {
    const tracking = realTracking(...args); rendered = tracking.sessions.map(item => item.nativeSessionId);
    return { ...tracking, refresh(revision, current) {
      const result = tracking.refresh(revision, current);
      if (!interrupted && result.status === 'ready') {
        interrupted = true;
        if (boundary === 'edit') tracking.toggle({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'User-edit', title: 'User edit', starredAt: 2 });
        else clearConversationRecovery(scope);
      }
      return result;
    } };
  });
  const f = await failureFixture(false, undefined, false, '', { seed(value, source) { scope = value; saveTrackedSessions(scope, [{ ...source, hostId: 'host', starredAt: 1 }]); } });
  await waitFor(() => expect(interrupted).toBe(true));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
  expect(f.requests.filter(item => item.url.endsWith('/attach'))).toEqual([]);
  expect(f.frames.filter(frame => frame.type === 'subscribe')).toEqual([]);
  if (boundary === 'edit') {
    expect(rendered).toEqual(['B', 'User-edit']);
    expect(readTrackedSessions(scope).map(item => item.nativeSessionId)).toEqual(rendered);
    expect(f.view.textContent).toContain('track_publish_uncommitted');
  }
});

it('retains closed and nested Ask owners, and supplies T with its own replaceable native image recipient', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const realAsk = askHooks.useAskConversations, realSuccession = successionHooks.useSessionSuccession;
  let ask!: ReturnType<typeof realAsk>, succession!: ReturnType<typeof realSuccession>;
  let consumer!: Parameters<typeof realSuccession>[0];
  vi.spyOn(askHooks, 'useAskConversations').mockImplementation((...args) => { ask = realAsk(...args); return ask; });
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { consumer = args[0]; succession = realSuccession(...args); return succession; });
  let original!: OpenedSession, target!: OpenedSession, nested!: OpenedSession;
  const f = await failureFixture(false, 'B', false, '', { seed(scope, source) {
    original = source; target = { ...source, nativeSessionId: 'T', agentId: 'agent-T', title: 'Independent Ask target' };
    nested = { ...target, nativeSessionId: 'U', agentId: 'agent-U', title: 'Nested Ask target' };
    const store = new ForkStore(`ask:${scope}`, sessionStorage);
    for (const [from, to] of [[source, target], [target, nested]]) {
      const record = store.prepare(referenceForkContext(from!), { sourceNativeSessionId: from!.nativeSessionId }); store.bind(record.id, to!); store.markConfigured(record.id); store.finishCreation(record.id);
    }
  } });
  await waitFor(() => expect(succession.binding).toBeDefined());
  const primaryOwner = succession.ownerFor(succession.desired!.slot.id);
  expect(primaryOwner).toBeDefined();
  expect(succession.ownerFor(succession.document.slots.find(slot => slot.owners.text.key === target.agentId)!.id)).toBeDefined();
  expect(ask.isOpen(original, primaryOwner)).toBe(false);
  expect(ask.entryFor(original, primaryOwner).record?.source).toEqual(original);
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B']);
  await setGlobalAskVisible(f.view, true);
  await act(async () => { await ask.open(undefined, succession.binding!.session, '', false, { associationOwner: primaryOwner }); });
  await waitFor(() => expect(succession.recipientFor(target, primaryOwner)?.isCurrent()).toBe(true));
  const first = succession.recipientFor(target, primaryOwner)!, primary = succession.imageRecipient!;
  expect(first.lifetime).not.toBe(primary.lifetime);
  expect(first.identity).toContain('agent-T'); expect(primary.identity).toContain('agent-B');
  await act(async () => f.updatesByAgent.get('agent-T')!('T', 'restoring'));
  await waitFor(() => expect(first.isCurrent()).toBe(false)); expect(primary.isCurrent()).toBe(true);
  await act(async () => f.updatesByAgent.get('agent-T')!('T'));
  await waitFor(() => expect(succession.recipientFor(target, primaryOwner)?.isCurrent()).toBe(true));
  const recovered = succession.recipientFor(target, primaryOwner)!;
  expect(recovered.lifetime).not.toBe(first.lifetime); expect(first.isCurrent()).toBe(false);
  const connection = consumer.connections.find(target)!;
  const retained = consumer.connections.acquire(target.agentId, connection.replica, target); cleanups.push(retained.release);
  await act(async () => {
    ask.close(original, primaryOwner);
    const record = ask.store.prepare(referenceForkContext(original), { sourceNativeSessionId: original.nativeSessionId });
    ask.store.bind(record.id, target); ask.store.markConfigured(record.id); ask.store.finishCreation(record.id);
    succession.document.asks.find(owner => owner.id === primaryOwner)!.records!.push({ id: record.id, target: sessionKey(target) });
    succession.document.editRevision++; succession.save();
    await ask.open(undefined, succession.binding!.session, '', false, { associationOwner: primaryOwner });
  });
  await waitFor(() => expect(succession.recipientFor(target, primaryOwner)?.isCurrent()).toBe(true));
  expect(recovered.isCurrent()).toBe(false);
  expect(succession.recipientFor(target, primaryOwner)?.lifetime).not.toBe(recovered.lifetime);
  expect(f.frames.some(frame => ['send_message', 'execute_command'].includes(frame.message?.type ?? ''))).toBe(false);
});


it('does not treat authorization-hidden succession as an unsupported transport', async () => {
  const f = await failureFixture(false, 'A', false, '', { replayFailure: 'session_not_found' });
  await waitFor(() => expect(f.view.textContent).toContain('Fixture succession route unavailable.'));
  expect(f.requests.filter(item => item.url.endsWith('/attach'))).toEqual([]);
});

it('restores a selected Side path and focus while the primary changes from A to B', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  let side!: OpenedSession;
  const f = await failureFixture(false, 'B', false, '', { selected: 'S', seed(scope, source) {
    side = { ...source, nativeSessionId: 'S', agentId: 'agent-S', title: 'Retained Side' };
    localStorage.setItem(`agent-remote-opened:${scope}`, JSON.stringify([source, side]));
    saveSessionComposition(scope, { path: [source, side], focus: sessionKey(side), anchor: sessionKey(side), addressKey: sessionKey(side) });
  } });
  await waitFor(() => expect(succession.binding).toBeDefined());
  await waitFor(() => expect(f.view.querySelector('.lab-side-conversation')).not.toBeNull());
  const sideId = succession.document.slots.find(slot => slot.intent.target.native.nativeSessionId === 'S')!.id;
  await settleApp(() => expect(succession.layoutView()).toMatchObject({ primary: { nativeSessionId: 'B' }, sides: [side], focus: sideId, anchor: sideId }));
  const saved = readCompositionDocument(f.scope);
  if (saved.status !== 'ready') throw new Error('Missing composition.');
  const sideSlot = saved.document.slots.find(slot => slot.owners.text.key === side.agentId)!;
  expect(saved.document.focus).toBe(sideSlot.id); expect(saved.document.anchor).toBe(sideSlot.id); expect(saved.document.address).toBe(sideSlot.id);
  expect(f.frames.filter(frame => frame.type === 'subscribe').map(frame => frame.agentId)).not.toContain('agent-A');
});


it('retains an authorized desired B after its replay endpoint becomes unavailable', async () => {
  const f = await failureFixture(false, undefined, false, '', { stateRetryMs: 20 });
  await settleApp(() => { expect(f.view.textContent).toContain('Fixture successor unavailable.'); });
  f.failReplay('route_not_found');
  f.dropSockets();
  await act(async () => window.dispatchEvent(new Event('online')));
  await settleApp(() => { expect(f.view.textContent).toContain('Fixture succession route unavailable.'); });
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B']);
  expect(new URL(window.location.href).searchParams.get('session')).toBe('B');
  expect(visibleQuery(f.view, '[data-testid="prompt-input"]')?.textContent).toBe('A local draft');
});


it.each(['A', 'B'])('retains a completed old-source creation before rejecting new configuration, input and navigation after %s changes', async initial => {
  const realWorkbench = workbenchComponents.LabWorkbench, realSuccession = successionHooks.useSessionSuccession;
  let primary!: ComponentProps<typeof realWorkbench>, succession!: ReturnType<typeof realSuccession>;
  vi.spyOn(workbenchComponents, 'LabWorkbench').mockImplementation(props => { if (props.state?.agent) primary = props; return realWorkbench(props); });
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = realSuccession(...args); return succession; });
  const configure = vi.spyOn(forkActions, 'configureFork').mockRejectedValue(new Error('Unexpected target configuration'));
  const f = await failureFixture(false, 'B', false, '', initial === 'A' ? { chain: [] } : undefined);
  await settleApp(() => { expect(primary.state?.agent?.id).toBe(`agent-${initial}`); });
  const oldPrimary = primary, oldRecipient = succession.imageRecipient;
  const release = f.holdCreate();
  let pending!: Promise<unknown>;
  await act(async () => { pending = oldPrimary.onExecuteConsoleCommand!('console:fork', 'Retained first input').catch(error => error); });
  await waitFor(() => expect(f.requests.some(item => item.url.endsWith('/create'))).toBe(true));
  const current = initial === 'A' ? 'B' : 'C';
  const next = committed(initial, current, initial === 'A' ? 2 : 3); f.chain.push(next);
  await act(async () => f.notify(next));
  await settleApp(() => { expect(succession.binding?.session.nativeSessionId).toBe(current); });
  let result: unknown;
  await act(async () => { release(); result = await pending; });
  expect(result).toBeInstanceOf(Error); expect((result as Error).message).toContain('source session changed');
  const record = new ForkStore(f.scope).allLocal().find(record => record.source.nativeSessionId === initial)!;
  expect(record.target).toMatchObject({ nativeSessionId: 'S', agentId: 'agent-S' });
  expect(record.configured).not.toBe(true); expect(record.delivery).toBe('pending');
  expect(configure).not.toHaveBeenCalled(); if (oldRecipient) expect(oldRecipient.isCurrent()).toBe(false);
  await expect(oldPrimary.onExecuteConsoleCommand!('console:ask', 'late')).rejects.toThrow(/source session changed|view no longer matches/);
  await expect(oldPrimary.actions.sendMessage!('late native input')).rejects.toThrow();
  expect(f.frames.some(frame => ['send_message', 'execute_command'].includes(frame.message?.type ?? ''))).toBe(false);
  expect(new URL(window.location.href).searchParams.get('session')).toBe(current);
});

it.each(['A', 'B'].flatMap(initial => ['child', 'child-mobile', 'communication', 'ask'].map(operation => ({ initial, operation }))))
('fences held $operation work from source $initial after its successor is confirmed', async ({ initial, operation }) => {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes(operation === 'child-mobile' ? 'max-width: 1180px' : 'min-width: 1181px'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const realWorkbench = workbenchComponents.LabWorkbench, realSuccession = successionHooks.useSessionSuccession;
  let primary!: ComponentProps<typeof realWorkbench>, succession!: ReturnType<typeof realSuccession>, communication: CommunicationNavigation | undefined;
  vi.spyOn(workbenchComponents, 'LabWorkbench').mockImplementation(props => { const navigation = useContext(CommunicationNavigationContext); if (props.state?.agent && props.state.agent.id !== 'agent-S') { primary = props; communication = navigation; } return realWorkbench(props); });
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = realSuccession(...args); return succession; });
  const configure = vi.spyOn(forkActions, 'configureFork').mockRejectedValue(new Error('Unexpected stale operation configuration'));
  const providerId = 'recorded';
  const child: AgentChildSession = { nativeSessionId: 'S', title: '/root/side', createdAt: 'now', status: 'idle', observation: 'live' };
  const letter: ProjectedTimelineEntry = { providerId, seqStart: 1, seqEnd: 1, timestamp: '2026-10-10T00:00:00Z', resources: [], collapsed: [], sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
    item: { type: 'agent_communication', messageId: 'letter', sender: '/root', recipient: '/root/side', text: 'Read the source message.' } };
  const f = await failureFixture(false, 'B', false, '', { providerId,
    chain: initial === 'A' ? [] : [committed('A', 'B', 2, 'primary', providerId)], children: operation === 'child-mobile' ? [] : [child], timeline: operation === 'communication' ? [letter] : [] });
  await settleApp(() => { expect(primary.state?.agent?.id).toBe(`agent-${initial}`); });
  const oldPrimary = primary, oldCommunication = communication;
  const create = operation === 'ask';
  let loaded = false, releaseLoad!: () => void;
  const loadGate = new Promise<void>(resolve => { releaseLoad = resolve; });
  if (operation === 'communication') {
    const load = sessionCommunication.loadSessionCommunication;
    vi.spyOn(sessionCommunication, 'loadSessionCommunication').mockImplementation(async (...args) => { const result = await load(...args); loaded = true; await loadGate; return result; });
  }
  const release = create ? f.holdCreate() : operation === 'communication' ? releaseLoad : f.holdAttach('S');
  cleanups.push(release);
  let pending!: Promise<unknown>;
  await act(async () => {
    const request = operation.startsWith('child') ? oldPrimary.onOpenChildSession!(child)
      : operation === 'communication' ? oldCommunication!.open(letter)
      : oldPrimary.onExecuteConsoleCommand!('console:ask', 'Question for the original source');
    pending = Promise.resolve(request).catch(error => error);
  });
  await waitFor(() => expect(f.requests.some(item => create ? item.url.endsWith('/create') : item.url.endsWith('/child/attach'))).toBe(true));
  if (operation === 'communication') await waitFor(() => expect(loaded).toBe(true));
  const destination = f.requests.find(item => create ? item.url.endsWith('/create') : item.url.endsWith('/child/attach'))!;
  expect(destination.body).toMatchObject(create ? { providerId, sourceNativeSessionId: initial } : { providerId, parentNativeSessionId: initial, nativeSessionId: 'S' });
  const current = initial === 'A' ? 'B' : 'C';
  const next = committed(initial, current, initial === 'A' ? 2 : 3, 'primary', providerId); f.chain.push(next);
  await act(async () => f.notify(next));
  await settleApp(() => { expect(succession.binding?.session.nativeSessionId).toBe(current); });
  const layoutBeforeRelease = JSON.stringify(succession.layoutView());
  let result: unknown;
  await act(async () => { release(); result = await pending; });
  if (operation === 'communication') { expect(result).toBeInstanceOf(Error); expect((result as Error).message).toContain('source session changed'); }
  if (operation === 'ask') {
    const record = new ForkStore(`ask:${f.scope}`, sessionStorage).allLocal().find(record => record.source.nativeSessionId === initial)!;
    expect(record.target).toMatchObject({ agentId: 'agent-S', providerId, nativeSessionId: 'S' });
    expect(record.configured).not.toBe(true); expect(record.delivery).toBe('pending');
    const inputs = JSON.parse(sessionStorage.getItem(`agent-remote-ask:${f.scope}:inputs:${JSON.stringify(['host', providerId, 'A'])}`) ?? '[]');
    expect(inputs).toEqual([expect.objectContaining({ text: 'Question for the original source', owner: expect.objectContaining({ recordId: record.id }) })]);
  }
  expect(configure).not.toHaveBeenCalled();
  expect(f.frames.some(frame => frame.type === 'subscribe' && frame.agentId === 'agent-S')).toBe(operation === 'communication');
  expect(f.frames.some(frame => ['send_message', 'execute_command', 'session_setting_request', 'interaction_response'].includes(frame.message?.type ?? ''))).toBe(false);
  expect(new URL(window.location.href).searchParams.get('session')).toBe(current);
  expect(primary.state?.agent?.id).toBe(`agent-${current}`);
  expect(JSON.stringify(succession.layoutView())).toBe(layoutBeforeRelease);
  expect(f.view.querySelector('.lab-side-conversation [data-inspected="true"]')).toBeNull();
});
