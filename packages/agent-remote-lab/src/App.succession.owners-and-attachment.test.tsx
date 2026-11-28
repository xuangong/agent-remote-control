import 'fake-indexeddb/auto';
import { useContext, type ComponentProps } from 'react';
import { expect, it, vi } from 'vitest';
import { inspectImageDraft, readImageDraft, writeImageDraft } from '@orchardworks/agent-client-web/browser';
import { type OpenedSession } from './kernel/directory-client.js';
import { DraftStore } from './kernel/draft-store.js';
import { readCompositionDocument, initializeCompositionDocument, saveCompositionDocument, createCompositionSlot } from './kernel/session-composition.js';
import { TrackedSessionViews } from './kernel/tracked-session-views.js';
import { flushRecoveryWrites } from './kernel/recovery-writes.js';
import * as askHooks from './features/team/useAskConversations.js';
import * as successionHooks from './hooks/useSessionSuccession.js';
import { ForkStore, referenceForkContext } from './kernel/session-forks.js';
import { sessionKey } from './kernel/session-tree.js';
import { readTrackedSessions, saveTrackedSessions } from './kernel/tracking-state.js';
import * as workbenchComponents from './conversation/LabWorkbench.js';
import * as historyHooks from './hooks/useConversationHistory.js';
import { RecoveryScope, type ReadingPositions } from './kernel/conversation-recovery.js';
import * as attentionHooks from './kernel/useSessionAttention.js';
import * as managerComponents from './features/sessions/ChatSessionManager.js';
import * as windowWorkspaceHooks from './features/windows/useWindowWorkspace.js';
import { act, cleanups, committed, failureFixture, native, saveSessionComposition, settleApp, settleAppEagerly, visibleQuery, waitFor } from './App.succession.fixture.js';
import { chooseFreeWorkbench, stubDialogs } from './test/new-workbench.js';
stubDialogs();

it('rejects a retired source after awaiting Ask relations before creating any native target', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const realWorkbench = workbenchComponents.LabWorkbench, realSuccession = successionHooks.useSessionSuccession;
  let primary!: ComponentProps<typeof realWorkbench>, succession!: ReturnType<typeof realSuccession>;
  vi.spyOn(workbenchComponents, 'LabWorkbench').mockImplementation(props => { if (props.state?.agent) primary = props; return realWorkbench(props); });
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = realSuccession(...args); return succession; });
  const f = await failureFixture(false, 'B', false, '', { providerId: 'codex', userScoped: true, holdRelationsInitially: true });
  await settleApp(() => { expect(primary.state?.agent?.id).toBe('agent-B'); });
  const oldPrimary = primary;
  const release = f.holdRelations(); cleanups.push(release);
  let pending!: Promise<unknown>;
  await act(async () => { pending = oldPrimary.onExecuteConsoleCommand!('console:ask', 'Preserve the submitting source').catch(error => error); });
  await waitFor(() => expect(f.requests.some(item => item.url.endsWith('/session-relations'))).toBe(true));
  const next = committed('B', 'C', 3, 'primary', 'codex'); f.chain.push(next);
  await act(async () => f.notify(next));
  await settleApp(() => { expect(succession.binding?.session.nativeSessionId).toBe('C'); });
  await act(async () => { release(); await pending; });
  expect(f.requests.filter(item => item.url.endsWith('/create'))).toEqual([]);
  expect(f.frames.filter(frame => frame.message?.type === 'resource_request').map(frame => frame.message?.payload?.agentId)).toEqual([]);
  expect(f.frames.some(frame => ['send_message', 'execute_command', 'session_setting_request'].includes(frame.message?.type ?? ''))).toBe(false);
  expect(new URL(window.location.href).searchParams.get('session')).toBe('C');
});

it.each(['retention failure', 'draft edit'])('retains independent B stores and selected Track through an Ask %s before publishing the role', async boundary => {
  const realAsk = askHooks.useAskConversations, realSuccession = successionHooks.useSessionSuccession;
  let ask!: ReturnType<typeof realAsk>, succession!: ReturnType<typeof realSuccession>, consumer!: Parameters<typeof realSuccession>[0];
  let source!: OpenedSession, independent!: OpenedSession, blocked = true, entered = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); cleanups.push(release);
  vi.spyOn(askHooks, 'useAskConversations').mockImplementation((...args) => {
    ask = realAsk(...args); const value = ask;
    return { ...value, async retainAssociationOwners(...params) {
      const result = await value.retainAssociationOwners(...params);
      if (blocked && result.status === 'applied') {
        entered = true;
        if (boundary === 'retention failure') return { status: 'failed', retention: 'page', code: 'fixture_ask_retention' };
        await gate;
      }
      return result;
    } };
  });
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => {
    consumer = args[0];
    succession = realSuccession(...args); return succession;
  });
  const f = await failureFixture(false, 'B', false, '', { async seed(scope, original) {
    source = original; independent = { ...original, nativeSessionId: 'B', agentId: 'agent-B', title: 'Independent B' };
    localStorage.setItem(`agent-remote-opened:${scope}`, JSON.stringify([source, independent]));
    saveTrackedSessions(scope, [source, independent].map((entry, index) => ({ ...entry, hostId: 'host', starredAt: index + 1 })));
    const text = new DraftStore(scope); text.set(independent.agentId, 'Independent B draft'); text.flush();
    await writeImageDraft({ version: 1, scope, key: JSON.stringify([scope, sessionKey(independent)]),
      parts: [{ type: 'image', imageId: 'independent-B-image', label: 'Independent B image' }],
      images: { 'independent-B-image': { imageId: 'independent-B-image', blob: new Blob(['Independent B image bytes'], { type: 'image/png' }), uploadId: 'independent-B-upload', status: 'pending', progress: 0 } }, nextLabel: 2 });
    const askText = new DraftStore(`${scope}:ask`); askText.set(sessionKey(source), 'Primary Ask draft'); askText.set(sessionKey(independent), 'Independent Ask draft'); askText.flush();
    const store = new ForkStore(`ask:${scope}`, sessionStorage);
    for (const [origin, nativeSessionId] of [[source, 'T'], [independent, 'U']] as const) {
      const record = store.prepare(referenceForkContext(origin), { sourceNativeSessionId: origin.nativeSessionId });
      store.bind(record.id, { ...origin, nativeSessionId, agentId: `agent-${nativeSessionId}` }); store.markConfigured(record.id); store.finishCreation(record.id);
    }
    const imported = initializeCompositionDocument(scope);
    if (imported.status !== 'ready') throw new Error('Fixture import failed');
    const views = new TrackedSessionViews(imported.document, () => {});
    for (const entry of [source, independent]) {
      const slot = imported.document.slots.find(slot => slot.owners.text.key === entry.agentId)!;
      views.select(sessionKey(entry)); views.remember({ primarySlot: slot.id, selections: {}, focus: slot.id, anchor: slot.id });
    }
    saveCompositionDocument(imported.document, () => true); flushRecoveryWrites();
  } });
  await waitFor(() => expect(entered).toBe(true));
  const independentSlotOf = () => succession.document.slots.find(slot => slot.owners.text.key === independent.agentId)!;
  const assertIndependentImage = async () => {
    const independentImage = independentSlotOf().owners.image;
    expect(independentImage).toEqual({ scope: f.scope, key: JSON.stringify([f.scope, sessionKey(independent)]) });
    expect(succession.desired!.slot.owners.image).not.toEqual(independentImage);
    const image = (await readImageDraft(independentImage.key))?.images['independent-B-image'];
    expect(image?.blob && await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(image.blob!); })).toBe('Independent B image bytes');
    expect((await inspectImageDraft(independentImage)).snapshot()).toMatchObject({ status: 'ready', retention: 'page' });
    expect((await readImageDraft(succession.desired!.slot.owners.image.key))?.images['independent-B-image']).toBeUndefined();
  };
  const ownersOf = () => ({ primary: succession.ownerFor(succession.document.slots.find(slot => slot.owners.text.key === source.agentId)!.id), independent: succession.ownerFor(independentSlotOf().id) });
  let trackedLayouts: unknown;
  if (boundary === 'draft edit') {
    // The edit overtakes the application (`local_edit`): the page discovers again and applies the document with the edit, with no Retry.
    await act(async () => { consumer.textStore(f.scope).set(source.agentId, 'Edited while Ask retained'); release(); });
    trackedLayouts = structuredClone(succession.document.tracks.map(({ entryId, view }) => ({ entryId, view })));
  } else {
    await settleApp(() => { expect(succession.error).toContain('needs synchronization'); });
    expect(consumer.tracking().sessions.map(entry => entry.nativeSessionId)).toEqual(['A', 'B']);
    expect(readTrackedSessions(f.scope).map(entry => entry.nativeSessionId)).toEqual(['A', 'B']);
    expect(succession.document.selectedTrack).toBe(sessionKey(independent));
    expect(new TrackedSessionViews(succession.document, () => {}).get(sessionKey(independent))?.primary.nativeSessionId).toBe('B');
    await assertIndependentImage();
    expect(succession.document.retained.some(value => value.slot === independentSlotOf().id)).toBe(true);
    const { primary: primaryOwner, independent: independentOwner } = ownersOf();
    expect(primaryOwner).not.toBe(independentOwner);
    expect(ask.entryFor(source, primaryOwner).record?.target?.nativeSessionId).toBe('T');
    expect(ask.entryFor(independent, independentOwner).record?.target?.nativeSessionId).toBe('U');
    expect(ask.draftBinding(independentOwner).store.get(ask.draftBinding(independentOwner).key)).toBe('Independent Ask draft');
    expect(consumer.textStore(f.scope).get(independent.agentId)).toBe('Independent B draft');
    expect(f.requests.filter(item => item.url.endsWith('/attach'))).toEqual([]);
    expect(f.frames.filter(frame => frame.type === 'subscribe')).toEqual([]);
    trackedLayouts = structuredClone(succession.document.tracks.map(({ entryId, view }) => ({ entryId, view })));
    blocked = false; release();
    await act(async () => succession.retry());
  }
  await settleApp(() => { expect(succession.binding?.session.nativeSessionId).toBe('B'); });
  expect(succession.error).toBeUndefined();
  const { primary: primaryOwner, independent: independentOwner } = ownersOf();
  expect(primaryOwner).not.toBe(independentOwner);
  expect(succession.document.retained.some(value => value.slot === independentSlotOf().id)).toBe(true);
  expect(ask.draftBinding(independentOwner).store.get(ask.draftBinding(independentOwner).key)).toBe('Independent Ask draft');
  expect(consumer.tracking().sessions.map(entry => entry.nativeSessionId)).toEqual(['B']);
  await assertIndependentImage();
  expect(succession.document.selectedTrack).toBe(sessionKey(independent));
  expect(succession.document.tracks.map(({ entryId, view }) => ({ entryId, view }))).toEqual(trackedLayouts);
  expect(consumer.textStore(f.scope).get(independent.agentId)).toBe('Independent B draft');
  const text = boundary === 'draft edit' ? 'Edited while Ask retained' : 'A local draft';
  expect(visibleQuery(f.view, '[data-testid="prompt-input"]')?.textContent).toBe(text);
  expect(ask.entryFor(independent, independentOwner).record?.source.nativeSessionId).toBe('B');
  expect(ask.entryFor(independent, independentOwner).record?.target?.nativeSessionId).toBe('U');
  expect(succession.document.tracks.map(track => track.view?.primarySlot)).toEqual(expect.arrayContaining([succession.desired!.slot.id, independentSlotOf().id]));
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B']);
});

it('keeps A outbox, question drafts and reading cursor concrete through B confirmation and explicit A history', async () => {
  const realWorkbench = workbenchComponents.LabWorkbench, realHistory = historyHooks.useConversationHistory, realSuccession = successionHooks.useSessionSuccession;
  let primary!: ComponentProps<typeof realWorkbench>, positions!: ReadingPositions, open!: Parameters<typeof realHistory>[2], succession!: ReturnType<typeof realSuccession>;
  vi.spyOn(workbenchComponents, 'LabWorkbench').mockImplementation(props => { primary = props; positions = useContext(RecoveryScope)!; return realWorkbench(props); });
  vi.spyOn(historyHooks, 'useConversationHistory').mockImplementation((...args) => { open = args[2]; return realHistory(...args); });
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = realSuccession(...args); return succession; });
  let source!: OpenedSession, outboxKey = '';
  const f = await failureFixture(false, 'B', false, '', { chain: [], preserveNativeState: true, seed(scope, original) {
    source = original; outboxKey = `agent-remote:recovery:${scope}:outbox:${sessionKey(source)}`;
    localStorage.setItem(outboxKey, JSON.stringify([{ id: 'saved-A', agentId: 'agent-A', text: 'Unsent A', epoch: 'epoch-agent-A', afterSeq: 0, status: 'failed', operationId: 'original-A-operation', error: 'Original failure' }]));
  } });
  await settleApp(() => { expect(primary.state?.agent?.id).toBe('agent-A'); expect(primary.state?.timeline.initialized).toBe(true); });
  const question = { answers: { one: { selectedValues: ['web'] } } };
  const readingKey = JSON.stringify(['agent-A', 'epoch-agent-A']);
  await act(async () => { primary.onQuestionDraftChange!('question-A', question); positions.set(readingKey, { following: false, anchor: { key: 'A-message-anchor', offset: 23 } }); });
  const originalPosition = positions.get(readingKey), originalOutbox = localStorage.getItem(outboxKey), oldPrimary = primary;
  expect(primary.state?.outgoingMessages).toContainEqual(expect.objectContaining({ id: 'saved-A', agentId: 'agent-A', status: 'failed' }));
  expect(primary.questionDrafts).toEqual({ 'question-A': question });
  const next = committed(); f.chain.push(next); await act(async () => f.notify(next));
  await settleApp(() => { expect(succession.binding?.session.nativeSessionId).toBe('B'); expect(primary.state?.agent?.id).toBe('agent-B'); });
  expect(primary.state?.outgoingMessages ?? []).toEqual([]); expect(primary.questionDrafts).toEqual({});
  expect(positions.get(readingKey)).toEqual(originalPosition);
  expect(positions.get(JSON.stringify(['agent-B', 'epoch-agent-B']))).not.toEqual(originalPosition);
  expect(localStorage.getItem(outboxKey)).toBe(originalOutbox);
  expect(localStorage.getItem(`agent-remote:recovery:${f.scope}:outbox:${sessionKey({ ...source, nativeSessionId: 'B' })}`)).toBeNull();
  await expect(oldPrimary.actions.retryMessage!('saved-A')).rejects.toThrow();
  await expect(oldPrimary.actions.respondToInteraction!('question-A', { kind: 'question', answers: [{ questionId: 'one', selectedValues: ['web'] }] })).rejects.toThrow();
  expect(f.frames.some(frame => ['send_message', 'interaction_response'].includes(frame.message?.type ?? ''))).toBe(false);
  await act(async () => { expect(await open(source, 'history')).toBe(true); });
  await settleApp(() => { expect(primary.state?.agent?.id).toBe('agent-A'); expect(primary.state?.timeline.initialized).toBe(true); });
  expect(new URL(window.location.href).searchParams.get('intent')).toBe('history');
  expect(primary.questionDrafts).toEqual({ 'question-A': question });
  expect(primary.state?.outgoingMessages).toContainEqual(expect.objectContaining({ id: 'saved-A', agentId: 'agent-A', status: 'failed' }));
  const before = f.frames.length;
  await act(async () => {
    await primary.actions.retryMessage!('saved-A');
    await primary.actions.respondToInteraction!('question-A', { kind: 'question', answers: [{ questionId: 'one', selectedValues: ['web'] }] });
    await primary.actions.loadOlder!();
  });
  const operations = f.frames.slice(before).filter(frame => ['send_message', 'interaction_response', 'timeline_request'].includes(frame.message?.type ?? ''));
  // Older history reads over the session wire, like every other timeline read.
  expect(operations.map(frame => [frame.message?.type, frame.message?.payload?.agentId])).toEqual([
    ['send_message', 'agent-A'], ['interaction_response', 'agent-A'], ['timeline_request', 'agent-A'],
  ]);
  const older = operations.find(frame => frame.message?.type === 'timeline_request')!.message!.payload!;
  expect(older.direction).toBe('before');
  expect(older.cursor).toEqual({ epoch: 'epoch-agent-A', seq: 1 });
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['A', 'B']);
});

it.each([['damaged', '{broken'], ['unsupported', JSON.stringify({ version: 99 })], ['capacity', ' '.repeat(1048577)]])('preserves %s composition bytes without attaching the saved predecessor', async (_kind, original) => {
  const f = await failureFixture(false, 'B', false, '', { seed(scope) { sessionStorage.setItem(`agent-remote:recovery:${scope}:composition-v1`, original!); } });
  await settleApp(() => { expect(f.view.textContent).toContain('Saved session composition is unreadable or unsupported.'); });
  expect(sessionStorage.getItem(`agent-remote:recovery:${f.scope}:composition-v1`)).toBe(original);
  expect(f.requests.filter(item => item.url.endsWith('/attach'))).toEqual([]);
  expect(f.frames.filter(frame => frame.type === 'subscribe')).toEqual([]);
  expect(JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${f.scope}:drafts`)!)['agent-A']).toBe('A local draft');
});

it('retains desired B and the editable owner when the composition checkpoint cannot be saved', async () => {
  const set = Storage.prototype.setItem;
  const f = await failureFixture(false, 'B', false, '', { seed(scope) {
    expect(initializeCompositionDocument(scope).status).toBe('ready');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key.endsWith(':composition-v2')) throw new Error('Fixture storage capacity reached');
      set.call(this, key, value);
    });
  } });
  await settleApp(() => { expect(f.view.textContent).toContain('Session composition needs synchronization'); });
  expect(f.requests.filter(item => item.url.endsWith('/attach'))).toEqual([]);
  expect(visibleQuery(f.view, '[data-testid="prompt-input"]')?.textContent).toBe('A local draft');
  expect(new URL(window.location.href).searchParams.get('session')).toBe('B');
});

it('permanently retires primary image lifetimes across page resume and same-native recovery', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B');
  await settleApp(() => { expect(succession.imageRecipient?.isCurrent()).toBe(true); });
  const beforePage = succession.imageRecipient!;
  await act(async () => window.dispatchEvent(new Event('pagehide')));
  expect(beforePage.isCurrent()).toBe(false);
  await act(async () => window.dispatchEvent(new Event('pageshow')));
  await settleApp(() => { expect(succession.imageRecipient?.isCurrent()).toBe(true); });
  const beforeNative = succession.imageRecipient!;
  expect(beforeNative.lifetime).not.toBe(beforePage.lifetime);
  await act(async () => f.updatesByAgent.get('agent-B')!('B', 'restoring'));
  await settleApp(() => { expect(beforeNative.isCurrent()).toBe(false); });
  await act(async () => f.updatesByAgent.get('agent-B')!('B'));
  await settleApp(() => { expect(succession.imageRecipient?.isCurrent()).toBe(true); });
  expect(beforePage.isCurrent()).toBe(false); expect(beforeNative.isCurrent()).toBe(false);
  expect(succession.imageRecipient!.lifetime).not.toBe(beforeNative.lifetime);
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B']);
  expect(f.view.querySelector('.lab-has-agent')).not.toBeNull();
});

it('reconciles metadata on page resume without retrying an HTTP attachment failure', async () => {
  const f = await failureFixture(false, undefined, false, '', { stateRetryMs: 20 });
  await settleApp(() => { expect(f.view.textContent).toContain('Retry session'); });
  const reads = f.requests.filter(item => item.url.includes('/session-successions')).length;
  f.dropSockets();
  await act(async () => { window.dispatchEvent(new Event('pagehide')); window.dispatchEvent(new Event('pageshow')); });
  await settleApp(() => { expect(f.requests.filter(item => item.url.includes('/session-successions')).length).toBeGreaterThan(reads); });
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B']);
  expect(f.view.textContent).toContain('Retry session');
});

it('reports a failed attachment once in the workbench with its Retry action', async () => {
  const f = await failureFixture();
  const workbench = f.view.querySelector<HTMLElement>('#lab-workbench')!;
  const description = 'The Host is offline or its connection was interrupted.';
  await settleApp(() => { expect(workbench.textContent).toContain(description); });
  expect(workbench.textContent!.split(description).length - 1).toBe(1);
  const notices = workbench.querySelectorAll<HTMLElement>('.lab-session-notice');
  expect(notices).toHaveLength(1);
  expect([...notices[0]!.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Retry session']);
  // The Host's own wording stays available as a diagnostic, not as a second headline.
  expect(workbench.textContent!.split('Fixture successor unavailable.').length - 1).toBe(1);
  expect(notices[0]!.querySelector('details')?.textContent).toContain('Fixture successor unavailable.');
});

it('opens retained B and the role through local view entries without sharing their owners or replacing the native connection', async () => {
  const real = successionHooks.useSessionSuccession, realAsk = askHooks.useAskConversations;
  let succession!: ReturnType<typeof real>, ask!: ReturnType<typeof realAsk>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  vi.spyOn(askHooks, 'useAskConversations').mockImplementation((...args) => { ask = realAsk(...args); return ask; });
  const f = await failureFixture(false, 'B', false, '', { async seed(scope, source) {
    const independent = { ...source, nativeSessionId: 'B', agentId: 'agent-B', title: 'Independent B' };
    localStorage.setItem(`agent-remote-opened:${scope}`, JSON.stringify([source, independent]));
    const text = new DraftStore(scope); text.set(independent.agentId, 'Independent B draft'); text.flush();
    const store = new ForkStore(`ask:${scope}`, sessionStorage), askText = new DraftStore(`${scope}:ask`);
    for (const [origin, target] of [[source, 'T'], [independent, 'U']] as const) {
      const record = store.prepare(referenceForkContext(origin), { sourceNativeSessionId: origin.nativeSessionId });
      store.bind(record.id, { ...origin, nativeSessionId: target, agentId: `agent-${target}` }); store.markConfigured(record.id); store.finishCreation(record.id);
      askText.set(sessionKey(origin), `Ask draft for ${target}`);
    }
    askText.flush();
  } });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  const originalSlot = succession.desired!.slot.id, originalClient = succession.binding!.client;
  const independent = succession.document.slots.find(slot => slot.owners.text.key === 'agent-B')!;
  const primary = () => visibleQuery(f.view, '.lab-primary-conversation')!;
  const clickView = async (title: string) => {
    await settleApp(() => expect(primary()?.querySelector('.lab-chat-sessions-heading')).not.toBeNull());
    await act(async () => primary().querySelector<HTMLButtonElement>('.lab-chat-sessions-heading')!.click());
    const row = [...primary().querySelectorAll<HTMLButtonElement>('.lab-chat-session-row')].find(button => button.textContent?.includes(title));
    expect(row).toBeDefined(); expect(row!.disabled).toBe(false);
    await act(async () => row!.click());
  };
  const assertAsk = (target: string) => {
    const bound = succession.binding!.session, owner = succession.ownerFor(bound.viewId);
    expect(succession.document.asks.find(value => value.id === owner)?.sourceSlot).toBe(succession.desired!.slot.id);
    expect(ask.entryFor(bound, owner).record?.target?.nativeSessionId).toBe(target);
    const draft = ask.draftBinding(owner); expect(draft.store.get(draft.key)).toBe(`Ask draft for ${target}`);
  };
  assertAsk('T');
  await clickView('Independent B');
  await settleApp(() => { expect(succession.desired!.slot.id).toBe(independent.id); expect(succession.isCurrent()).toBe(true); });
  expect(primary().querySelector('[data-testid="prompt-input"]')?.textContent).toBe('Independent B draft'); assertAsk('U');
  expect(succession.document.address).toBe(independent.id); expect(succession.binding!.client).toBe(originalClient);
  await clickView('Retained primary');
  await settleApp(() => { expect(succession.desired!.slot.id).toBe(originalSlot); expect(succession.isCurrent()).toBe(true); });
  expect(primary().querySelector('[data-testid="prompt-input"]')?.textContent).toBe('A local draft'); assertAsk('T');
  expect(succession.binding!.client).toBe(originalClient);
  await clickView('Independent B');
  await settleApp(() => { expect(succession.desired!.slot.id).toBe(independent.id); expect(succession.isCurrent(), succession.error).toBe(true); });
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B']);
  await act(async () => { f.chain.push(committed('B', 'C', 3)); f.notify(f.chain[1]!); });
  await settleApp(() => expect(succession.document.roles[0]?.appliedRevision).toBe(3));
  expect(succession.desired!.slot.id).toBe(independent.id); expect(succession.binding!.session.nativeSessionId).toBe('B'); assertAsk('U');
  await clickView('Retained primary');
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('C'));
  expect(succession.desired!.slot.id).toBe(originalSlot); assertAsk('T');
  expect(primary().querySelector('[data-testid="prompt-input"]')?.textContent).toBe('A local draft');
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B', 'C']);
  expect(f.frames.filter(frame => frame.message && ['send_message', 'execute_command', 'image_upload_begin'].includes(frame.message.type))).toEqual([]);
});

it.each(['missing', 'mismatched'])('rejects an explicit %s view without a native fallback or retry attachment', async kind => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B');
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  const id = kind === 'missing' ? 'missing-slot' : succession.desired!.slot.id;
  await act(async () => { expect(await succession.open({ hostId: 'host', providerId: 'recorded', nativeSessionId: kind === 'missing' ? 'B' : 'D', title: 'Rejected view' }, undefined, undefined, id)).toBe(true); });
  expect(succession.error).toContain('no longer matches'); expect(succession.binding).toBeUndefined();
  await act(async () => succession.retry());
  await settleApp(() => expect(succession.discovering).toBe(false));
  expect(succession.binding).toBeUndefined();
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B']);
});

it('reselecting an explicitly failed view retains its error until Retry', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture();
  await settleApp(() => expect(succession.error).toBe('Fixture successor unavailable.'));
  const id = succession.desired!.slot.id, target = succession.selected!;
  await act(async () => { expect(await succession.open(target, undefined, undefined, id)).toBe(true); });
  expect(succession.error).toBe('Fixture successor unavailable.');
  expect(f.requests.filter(item => item.url.endsWith('/attach'))).toHaveLength(1);
  f.setNativeIdentity('B');
  await act(async () => succession.retry());
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  expect(f.requests.filter(item => item.url.endsWith('/attach'))).toHaveLength(2);
});

it.each([false, true])('restores the legacy Side primary without overriding explicit history intent %s', async history => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  await failureFixture(false, 'B', false, history ? '&intent=history' : '', { selected: 'B', seed(scope, source) {
    const side = { ...source, nativeSessionId: 'B', agentId: 'agent-B', title: 'Side B' };
    localStorage.setItem(`agent-remote-opened:${scope}`, JSON.stringify([source, side]));
    saveSessionComposition(scope, { path: [source, side], focus: sessionKey(side), anchor: sessionKey(source), addressKey: sessionKey(side) });
  } });
  await settleApp(() => { expect(succession.binding?.session.nativeSessionId).toBe('B'); expect(succession.isCurrent()).toBe(true); });
  expect(succession.desired?.slot.intent.kind).toBe(history ? 'history' : 'role');
  if (!history) expect(succession.desired?.slot.owners.text.key).toBe('agent-A');
});

it.each(['B', 'D'])('restores the selected Window owner while a new %s Window keeps independent owners', async selected => {
  const real = successionHooks.useSessionSuccession, realManager = managerComponents.ChatSessionManager;
  let succession!: ReturnType<typeof real>, manager!: ComponentProps<typeof realManager>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  vi.spyOn(managerComponents, 'ChatSessionManager').mockImplementation(props => { manager = props; return realManager(props); });
  const f = await failureFixture(false, 'B', false, '', { seed(scope, source) {
    const independent = { ...source, nativeSessionId: 'B', agentId: 'agent-B', title: 'Independent B' };
    localStorage.setItem(`agent-remote-opened:${scope}`, JSON.stringify([source, independent]));
    saveSessionComposition(scope, { path: [source, independent], focus: sessionKey(independent), anchor: sessionKey(source), addressKey: sessionKey(independent) });
    const draft = new DraftStore(scope); draft.set(independent.agentId, 'Independent B draft'); draft.flush();
  } });
  await settleAppEagerly(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  const slot = succession.document.slots.find(value => value.owners.text.key === 'agent-B')!;
  const primarySlot = succession.desired!.slot.id, owners = structuredClone(slot.owners), askOwner = succession.ownerFor(slot.id);
  await act(async () => manager.onOpenView!({ slotId: slot.id, session: { hostId: 'host', providerId: 'recorded', nativeSessionId: 'B', title: 'Independent B' } }));
  await settleAppEagerly(() => expect(succession.document.focus).toBe(slot.id));
  const originalUrl = window.location.href, windowId = new URL(originalUrl).searchParams.get('window');
  const sideDraft = () => f.view.querySelector('.lab-side-conversation [data-testid="prompt-input"]')?.textContent;
  expect(sideDraft()).toBe('Independent B draft');
  expect(readCompositionDocument(f.scope)).toMatchObject({ status: 'ready', document: { address: slot.id } });
  await f.reload();
  await settleAppEagerly(() => { expect(succession.document.focus).toBe(slot.id); expect(sideDraft()).toBe('Independent B draft'); });
  expect(succession.document.slots.find(value => value.id === slot.id)?.owners).toEqual(owners);
  expect(succession.ownerFor(slot.id)).toBe(askOwner);
  await act(async () => f.view.querySelector<HTMLButtonElement>(':is(.lab-launcher, .lab-window-floating, .lab-toolbar-launchers, #lab-context) button[aria-label="Groups"]')!.click());
  const createWindow = [...f.view.querySelectorAll<HTMLButtonElement>('.lab-window-panel button')].find(button => button.textContent === 'New group')!;
  expect(createWindow).toBeDefined();
  await act(async () => createWindow.click());
  await chooseFreeWorkbench();
  await settleAppEagerly(() => expect(new URL(window.location.href).searchParams.get('window')).not.toBe(windowId));
  await act(async () => manager.onOpen({ hostId: 'host', providerId: 'recorded', nativeSessionId: selected, title: `Independent ${selected}` }));
  await settleAppEagerly(() => expect(succession.binding?.session.nativeSessionId).toBe(selected));
  expect(new URL(window.location.href).searchParams.get('window')).not.toBe(windowId);
  expect(succession.desired?.slot.id).not.toBe(slot.id); expect(succession.desired?.slot.id).not.toBe(primarySlot);
  expect(succession.desired?.slot.owners.text).not.toEqual(owners.text);
  window.history.replaceState(null, '', originalUrl);
  await f.reload();
  await settleAppEagerly(() => { expect(succession.document.focus).toBe(slot.id); expect(sideDraft()).toBe('Independent B draft'); });
  expect(succession.ownerFor(slot.id)).toBe(askOwner);
  await act(async () => manager.onOpen({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'B', title: 'Ordinary B' }));
  await settleAppEagerly(() => expect(succession.document.focus).toBe(primarySlot));
  expect(f.view.querySelector('.lab-primary-conversation [data-testid="prompt-input"]')?.textContent).toBe('A local draft');
});


it('reattaches a restored Side to its new runtime binding while preserving the view and draft owners', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B', false, '', { seed(scope, source) {
    const side = { ...source, nativeSessionId: 'S', agentId: 'agent-S', title: 'Independent Side' };
    localStorage.setItem(`agent-remote-opened:${scope}`, JSON.stringify([source, side]));
    saveSessionComposition(scope, { path: [source, side], focus: sessionKey(side), anchor: sessionKey(source), addressKey: sessionKey(source) });
    const drafts = new DraftStore(scope); drafts.set(side.agentId, 'Side draft before runtime restart'); drafts.flush();
  } });
  await settleApp(() => expect(succession.layoutView()?.sides[0]?.agentId).toBe('agent-S'));
  const slot = succession.document.slots.find(value => value.intent.target.native.nativeSessionId === 'S')!;
  const owners = structuredClone(slot.owners), askOwner = succession.ownerFor(slot.id);
  f.rebind('S', 'restarted-side-binding');
  await f.reload();
  await settleApp(() => expect(succession.layoutView()?.sides[0]?.agentId).toBe('restarted-side-binding'));
  const restored = succession.document.slots.find(value => value.id === slot.id)!;
  expect(restored.owners).toEqual(owners); expect(succession.ownerFor(slot.id)).toBe(askOwner);
  expect(restored.metadata?.agentId).toBe('restarted-side-binding');
  expect(f.view.querySelector('.lab-side-conversation [data-testid="prompt-input"]')?.textContent).toBe('Side draft before runtime restart');
  await settleApp(() => expect(f.frames.filter(frame => frame.type === 'subscribe').map(frame => frame.agentId)).toContain('restarted-side-binding'));
  expect(f.frames.filter(frame => frame.message && ['send_message', 'execute_command', 'image_upload_begin'].includes(frame.message.type))).toEqual([]);
});

it('reopening an attached Side preserves its existing draft owner despite an unowned legacy slot', async () => {
  const real = successionHooks.useSessionSuccession, realWindow = windowWorkspaceHooks.useWindowWorkspace;
  let succession!: ReturnType<typeof real>, workspace!: ReturnType<typeof realWindow>, side!: OpenedSession;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  vi.spyOn(windowWorkspaceHooks, 'useWindowWorkspace').mockImplementation((...args) => { workspace = realWindow(...args); return workspace; });
  const f = await failureFixture(false, 'B', false, '', { chain: [], seed(scope, source) {
    side = { ...source, nativeSessionId: 'S', agentId: 'agent-S', title: 'Side S' };
    localStorage.setItem(`agent-remote-opened:${scope}`, JSON.stringify([source, side]));
    const store = new ForkStore(scope), record = store.prepare(referenceForkContext(source), { sourceNativeSessionId: source.nativeSessionId });
    store.bind(record.id, side); store.markConfigured(record.id); store.finishCreation(record.id);
    const drafts = new DraftStore(scope); drafts.set(side.agentId, 'Existing Side draft'); drafts.flush();
  } });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  const openSide = () => f.view.querySelector<HTMLButtonElement>('.lab-primary-conversation .lab-fork-entry > button')!.click();
  await act(async () => openSide());
  await settleApp(() => expect(workspace.window?.views.find(view => view.attachedTo)?.binding?.nativeSessionId).toBe('S'));
  const child = workspace.window!.views.find(view => view.attachedTo)!;
  const mapping = () => succession.document.windowBindings!.find(entry => entry.windowId === workspace.window!.id && entry.viewId === child.id)!;
  const originalSlotId = mapping().slotId;
  const originalSlot = succession.document.slots.find(slot => slot.id === originalSlotId)!;
  await settleApp(() => expect(f.view.querySelector('.lab-side-conversation [data-testid="prompt-input"]')?.textContent).toBe('Existing Side draft'));
  const owners = structuredClone(originalSlot.owners);
  await act(async () => {
    const legacy = createCompositionSlot('legacy-side', side, f.scope);
    legacy.owners.text.key = 'legacy-side-draft';
    succession.document.slots.unshift(legacy); succession.document.editRevision++; succession.save();
  });
  await act(async () => openSide());
  await settleApp(() => {
    expect(mapping().slotId).toBe(originalSlotId);
    expect(succession.document.slots.find(slot => slot.id === mapping().slotId)!.owners).toEqual(owners);
    expect(f.view.querySelector('.lab-side-conversation [data-testid="prompt-input"]')?.textContent).toBe('Existing Side draft');
  });
  expect(workspace.window!.views.filter(view => view.attachedTo)).toHaveLength(1);
});

it.each(['ordinary', 'Track'] as const)('leaves a focused unlinked Side through %s navigation and keeps its independent view', async navigation => {
  const real = successionHooks.useSessionSuccession, realManager = managerComponents.ChatSessionManager, realAttention = attentionHooks.useSessionAttention;
  let succession!: ReturnType<typeof real>, manager!: ComponentProps<typeof realManager>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  vi.spyOn(managerComponents, 'ChatSessionManager').mockImplementation(props => { manager = props; return realManager(props); });
  vi.spyOn(attentionHooks, 'useSessionAttention').mockImplementation((...args) => ({ ...realAttention(...args), trackVisible: true }));
  const realWindow = windowWorkspaceHooks.useWindowWorkspace;
  let workspace!: ReturnType<typeof realWindow>;
  vi.spyOn(windowWorkspaceHooks, 'useWindowWorkspace').mockImplementation((...args) => { workspace = realWindow(...args); return workspace; });
  let target!: OpenedSession, side!: OpenedSession, store!: ForkStore, recordId!: string;
  const f = await failureFixture(false, 'B', false, '', { chain: [], userScoped: navigation === 'Track', seed(scope, source) {
    target = { ...source, nativeSessionId: 'D', agentId: 'agent-D', title: 'New primary D' };
    side = { ...source, nativeSessionId: 'S', agentId: 'agent-S', title: 'Side S' };
    localStorage.setItem(`agent-remote-opened:${scope}`, JSON.stringify([source, target, side]));
    saveTrackedSessions(scope, [target, side].map((session, index) => ({ ...session, hostId: 'host', starredAt: index + 1 })));
    const drafts = new DraftStore(scope); drafts.set(side.agentId, 'Independent S draft'); drafts.flush();
    store = new ForkStore(scope);
    const record = store.prepare(referenceForkContext(source), { sourceNativeSessionId: source.nativeSessionId });
    recordId = record.id;
    store.bind(record.id, side); store.markConfigured(record.id); store.finishCreation(record.id);
  } });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  await act(async () => f.view.querySelector<HTMLButtonElement>('.lab-primary-conversation .lab-fork-entry > button')!.click());
  await settleApp(() => expect(new URL(window.location.href).searchParams.get('session')).toBe('S'));
  const slot = succession.document.slots.find(value => value.owners.text.key === side.agentId)!;
  const owners = structuredClone(slot.owners), askOwner = succession.ownerFor(slot.id);
  const sharedWindow = new URL(window.location.href).searchParams.has('window');
  const independent = () => f.view.querySelector('[aria-label="Session: Side S"]');
  await act(async () => {
    store.setLinked(recordId, false);
    window.dispatchEvent(new StorageEvent('storage', { key: `agent-remote-forks:${f.scope}:navigation:${recordId}` }));
  });
  await settleApp(() => {
    expect(f.view.querySelector('.lab-side-conversation:not([hidden]) .lab-side-close')).toBeNull();
    if (sharedWindow) expect(independent()?.querySelector('[data-testid="prompt-input"]')?.textContent).toBe('Independent S draft');
    else {
      expect(f.view.querySelector<HTMLElement>('.lab-primary-conversation')!.hidden).toBe(true);
      expect(f.view.querySelector('.lab-side-conversation:not([hidden]) [data-testid="prompt-input"]')?.textContent).toBe('Independent S draft');
    }
  });
  async function open(session: OpenedSession) {
    if (navigation === 'ordinary') await act(async () => manager.onOpen(session));
    else {
      await act(async () => f.view.querySelector<HTMLButtonElement>('[aria-label="Tracked sessions"]')!.click());
      const row = () => [...f.view.querySelectorAll<HTMLButtonElement>(':is(.lab-tracking-floating, .lab-launcher-track) .lab-session-row')].find(row => row.textContent?.includes(session.title));
      await settleApp(() => expect(row()).toBeDefined());
      await act(async () => row()!.click());
    }
    await settleApp(() => {
      expect(succession.binding?.session.nativeSessionId).toBe(session.nativeSessionId);
      expect(f.view.querySelector<HTMLElement>('.lab-primary-conversation')!.hidden).toBe(false);
      expect(new URL(window.location.href).searchParams.get('session')).toBe(session.nativeSessionId);
      expect(succession.document.primary).toBe(succession.binding!.session.viewId);
    });
  }
  if (sharedWindow && navigation === 'Track') {
    await act(async () => { await workspace.operate({ type: 'view.select', viewId: workspace.window!.selectedPrimaryViewId! }); });
  }
  await open(target);
  expect(f.view.querySelectorAll('.lab-side-conversation:not([hidden])')).toHaveLength(0);
  if (sharedWindow && navigation === 'Track') {
    const dock = workspace.window!.views.find(view => view.placement === 'dock' && view.binding?.nativeSessionId === 'S')!;
    await act(async () => { await workspace.operate({ type: 'view.collapse', viewId: dock.id, collapsed: true }); await workspace.operate({ type: 'view.select', viewId: workspace.window!.selectedPrimaryViewId! }); });
  }
  if (sharedWindow && navigation === 'Track') {
    // S is already a bot of this group, its own folded dock: Track selects and unfolds it instead of opening it again (rule 6).
    await act(async () => f.view.querySelector<HTMLButtonElement>('[aria-label="Tracked sessions"]')!.click());
    const row = () => [...f.view.querySelectorAll<HTMLButtonElement>(':is(.lab-tracking-floating, .lab-launcher-track) .lab-session-row')].find(item => item.textContent?.includes(side.title));
    await settleApp(() => expect(row()).toBeDefined());
    await act(async () => row()!.click());
    await settleApp(() => {
      const dock = workspace.window!.views.find(view => view.placement === 'dock' && view.binding?.nativeSessionId === 'S')!;
      expect(dock.collapsed).toBe(false);
      expect(workspace.window!.selectedViewId).toBe(dock.id);
    });
  } else await open(side);
  if (sharedWindow) {
    if (navigation !== 'Track') {
      expect(succession.binding?.session.viewId).not.toBe(slot.id);
      expect(succession.desired?.slot.owners).not.toEqual(owners);
    }
    expect(independent()?.querySelector('[data-testid="prompt-input"]')?.textContent).toBe('Independent S draft');
    expect(succession.document.slots.find(value => value.id === slot.id)?.owners).toEqual(owners);
  } else {
    expect(succession.binding?.session.viewId).toBe(slot.id);
    expect(succession.desired?.slot.owners).toEqual(owners);
    expect(f.view.querySelector('.lab-primary-conversation [data-testid="prompt-input"]')?.textContent).toBe('Independent S draft');
  }
  expect(succession.ownerFor(slot.id)).toBe(askOwner);
  expect(store.get(recordId)?.linked).toBe(false);
  expect(f.frames.filter(frame => frame.message && ['send_message', 'execute_command', 'image_upload_begin'].includes(frame.message.type))).toEqual([]);
});

it('retries a transient composition import failure through the synchronization button and restores shared owners', async () => {
  const real = successionHooks.useSessionSuccession, realAsk = askHooks.useAskConversations;
  let succession!: ReturnType<typeof real>, askDocument!: Parameters<typeof realAsk>[0], rejectImport = true;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  vi.spyOn(askHooks, 'useAskConversations').mockImplementation((...args) => { askDocument = args[0]; return realAsk(...args); });
  const originalSet = Storage.prototype.setItem;
  let importWrites = 0;
  const f = await failureFixture(false, 'B', false, '', { chain: [], seed(scope, source) {
    saveTrackedSessions(scope, [{ ...source, hostId: 'host', starredAt: 1 }]);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function(this: Storage, key: string, value: string) {
      if (key === `agent-remote:recovery:${scope}:composition-v2`) {
        importWrites++;
        if (rejectImport) throw new Error('Temporary import storage failure');
      }
      originalSet.call(this, key, value);
    });
  } });
  await settleApp(() => expect(f.view.textContent).toContain('Saved session composition is unreadable or unsupported.'));
  const failedWrites = importWrites, fallback = succession.document;
  expect(f.requests.filter(request => request.url.endsWith('/attach'))).toHaveLength(0);
  rejectImport = false;
  await act(async () => [...f.view.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry synchronization')!.click());
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  expect(importWrites).toBeGreaterThan(failedWrites);
  expect(succession.document).not.toBe(fallback);
  expect(askDocument).toBe(succession.document);
  expect(succession.error).toBeUndefined();
  expect(succession.desired?.slot.owners.text.key).toBe('agent-A');
  expect(succession.ownerFor(succession.binding!.session.viewId)).toBeDefined();
  expect(new TrackedSessionViews(succession.document, () => {}).entry(sessionKey(succession.binding!.session))?.slotId).toBe(succession.binding!.session.viewId);
  expect(readCompositionDocument(f.scope).status).toBe('ready');
  expect(new DraftStore(f.scope).get('agent-A')).toBe('A local draft');
  expect(visibleQuery(f.view, '[data-testid="prompt-input"]')?.textContent).toBe('A local draft');
  expect(f.frames.filter(frame => frame.message && ['send_message', 'execute_command', 'image_upload_begin'].includes(frame.message.type))).toEqual([]);
  await f.reload();
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  expect(succession.desired?.slot.owners.text.key).toBe('agent-A');
});
