// The effects of useQuotesAndReferences: quoting selected messages into another view, creating the destination, where the
// quote lands, and the stable wrappers of the next message. The rules themselves are owned by `quote-flow` and `quote-targets`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_SESSION_EXCERPTS_PER_MESSAGE } from '@orchardworks/agent-remote-protocol';
import { readQuotes } from '../features/session-links/session-quotes.js';
import { reloadedConversationMessage } from '../features/session-links/quote-flow.js';
import { NEW_SESSION_TARGET } from '../features/session-links/SessionQuotes.js';
import { buildOpened, mockScope, renderHook } from '../test/render-hook.js';
import { buildBinding, buildView, buildWindow } from '../test/window-builders.js';
import { useQuotesAndReferences } from './useQuotesAndReferences.js';

const baseUrl = 'https://relay';
const source = buildOpened('source', { title: 'Source' });
const entry = (key: string, text: string) => ({ itemKey: key, seqStart: 1, providerId: 'codex', item: { type: 'user_message', text, messageId: key } }) as never;
const sourceState = {
  agent: { id: source.agentId, providerId: 'codex', cwd: '/work', model: 'gpt' },
  timeline: { epoch: 'epoch', entries: [entry('k1', 'first'), entry('k2', 'second'), entry('k3', 'third')] },
} as never;
const selection = (overrides: Record<string, unknown> = {}) => ({ viewId: 'source-view', epoch: 'epoch', keys: new Set(['k1', 'k3']), ...overrides });
const dest = { windowId: 'W', viewId: 'dest' };
const openWindow = buildWindow([buildView('source-view'), buildView('dest')], 'source-view', { id: 'W' });

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

async function mount(facts: Record<string, unknown> = {}) {
  const scope = {
    baseUrl, quoteSelection: selection(), quote: { selection: selection() }, dispatchQuote: vi.fn(), sharedWindow: openWindow,
    windowWorkspace: { windows: [openWindow], readWindow: () => openWindow, operate: vi.fn(async () => undefined), open: vi.fn(async () => undefined) },
    directory: { create: vi.fn(async (_provider: string, _operation: string, _options: object) => ({ agentId: 'agent-new', nativeSessionId: 'native-new' })) },
    selectedHost: { id: 'local' }, remoteHosts: [{ id: 'local' }], rememberSession: vi.fn(), setDirectoryRevision: vi.fn(), editWindow: vi.fn(), retryHosts: vi.fn(),
    navigateAttributionRef: { current: vi.fn(async () => undefined) }, ...facts,
  };
  const { result } = await renderHook(() => useQuotesAndReferences(mockScope<typeof useQuotesAndReferences>(scope)));
  return { scope, hook: result.current };
}
const quoted = (viewId: string) => readQuotes(baseUrl, viewId);

describe('quoting selected messages into an existing view', () => {
  it('stores an excerpt of only the selected messages in the destination, clears the selection and reveals the destination', async () => {
    const { scope, hook } = await mount();
    await hook.quoteSelected('source-view', source as never, sourceState, dest);
    const [excerpt] = quoted('dest');
    expect(excerpt!.source).toMatchObject({ hostId: 'local', providerId: 'codex', nativeSessionId: 'source', title: 'Source' });
    expect(JSON.stringify(excerpt!.segments)).toMatch(/first/);
    expect(JSON.stringify(excerpt!.segments)).toMatch(/third/);
    expect(JSON.stringify(excerpt!.segments)).not.toMatch(/second/);
    expect(scope.dispatchQuote).toHaveBeenCalledWith({ type: 'quoted', viewId: 'source-view' });
    expect(scope.windowWorkspace.operate).toHaveBeenCalledWith({ type: 'view.select', viewId: 'dest' });
    expect(scope.directory.create).not.toHaveBeenCalled();
  });
  it.each([
    ['another view', { viewId: 'other' }], ['a selection that is creating its destination', { busy: true }], ['no selection', undefined],
  ])('does nothing for %s', async (_name, change) => {
    const { scope, hook } = await mount({ quoteSelection: change && selection(change) });
    await hook.quoteSelected('source-view', source as never, sourceState, dest);
    expect(scope.dispatchQuote).not.toHaveBeenCalled();
    expect(quoted('dest')).toEqual([]);
  });
  it('refuses a selection made before the conversation was reloaded', async () => {
    const { scope, hook } = await mount({ quoteSelection: selection({ epoch: 'older' }) });
    await hook.quoteSelected('source-view', source as never, sourceState, dest);
    expect(scope.dispatchQuote).toHaveBeenCalledWith({ type: 'failed', viewId: 'source-view', error: reloadedConversationMessage });
    expect(quoted('dest')).toEqual([]);
  });
  it('keeps the selection and reports it when the destination cannot take another quote', async () => {
    const { scope, hook } = await mount();
    for (let count = 0; count < MAX_SESSION_EXCERPTS_PER_MESSAGE; count++) await hook.quoteSelected('source-view', source as never, sourceState, dest);
    scope.dispatchQuote.mockClear();
    await hook.quoteSelected('source-view', source as never, sourceState, dest);
    expect(scope.dispatchQuote).toHaveBeenCalledTimes(1);
    expect(scope.dispatchQuote).toHaveBeenCalledWith({ type: 'failed', viewId: 'source-view', error: expect.stringContaining('already carries') });
  });
});

describe('quoting into a new session', () => {
  it('creates the session where the source stands, opens it as a dock and quotes into it', async () => {
    const { scope, hook } = await mount();
    await hook.quoteSelected('source-view', source as never, sourceState, { windowId: 'W', viewId: NEW_SESSION_TARGET });
    const creation = scope.dispatchQuote.mock.calls[0]![0] as { type: string; creationId: string };
    expect(creation).toMatchObject({ type: 'creating', viewId: 'source-view' });
    expect(scope.directory.create).toHaveBeenCalledWith('codex', creation.creationId, { cwd: '/work', model: 'gpt' });
    expect(scope.rememberSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-new', nativeSessionId: 'native-new', title: 'New session' }));
    expect(scope.setDirectoryRevision).toHaveBeenCalled();
    const batch = scope.editWindow.mock.calls[0]![0] as { operations: Array<{ type: string; view: { id: string; placement: string } }> };
    const { view } = batch.operations[0]!;
    expect(view.placement).toBe('dock');
    expect(quoted(view.id)).toHaveLength(1);
    expect(scope.windowWorkspace.operate).toHaveBeenCalledWith({ type: 'view.select', viewId: view.id });
  });
  it('reuses the id of an attempt that failed, so the Host creates the session once', async () => {
    const { scope, hook } = await mount({ quoteSelection: selection({ creationId: 'earlier-attempt' }) });
    await hook.quoteSelected('source-view', source as never, sourceState, { windowId: 'W', viewId: NEW_SESSION_TARGET });
    expect(scope.directory.create.mock.calls[0]![1]).toBe('earlier-attempt');
  });
  it('reports a failed creation, creates nothing in the Window and stores no quote', async () => {
    const { scope, hook } = await mount();
    scope.directory.create.mockRejectedValueOnce(new Error('Host is offline.'));
    await hook.quoteSelected('source-view', source as never, sourceState, { windowId: 'W', viewId: NEW_SESSION_TARGET });
    expect(scope.dispatchQuote).toHaveBeenLastCalledWith({ type: 'failed', viewId: 'source-view', error: 'Host is offline.' });
    expect(scope.editWindow).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });
  it('checks the Hosts again after creating on a remote Host, also when the creation failed', async () => {
    const remote = buildOpened('source', { hostId: 'remote' });
    const { scope, hook } = await mount({ remoteHosts: [{ id: 'remote' }], selectedHost: { id: 'remote' } });
    scope.directory.create.mockRejectedValueOnce(new Error('offline'));
    await hook.quoteSelected('source-view', remote as never, sourceState, { windowId: 'W', viewId: NEW_SESSION_TARGET });
    expect(scope.retryHosts).toHaveBeenCalledTimes(1);
    await hook.quoteSelected('source-view', remote as never, sourceState, { windowId: 'W', viewId: NEW_SESSION_TARGET });
    expect(scope.retryHosts).toHaveBeenCalledTimes(2);
  });
  it('does not create a session on a Host whose session quota is used up', async () => {
    const { scope, hook } = await mount({ remoteHosts: [{ id: 'local', sessionQuota: { limit: 1, used: 1 } }], selectedHost: { id: 'local' } });
    await hook.quoteSelected('source-view', buildOpened('source', { hostId: 'local' }) as never, sourceState, { windowId: 'W', viewId: NEW_SESSION_TARGET });
    expect(scope.directory.create).not.toHaveBeenCalled();
    expect(scope.dispatchQuote).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'failed' }));
  });
});

describe('where the quote lands', () => {
  const other = buildWindow([buildView('far', 'primary', { binding: buildBinding('far', { title: 'Far session' }) })], 'far', { id: 'other', title: 'Other window' });
  it('leaves a notice for a destination in another Window, without moving the person, and opens it on request', async () => {
    const { scope, hook } = await mount({ windowWorkspace: { windows: [openWindow, other], readWindow: () => openWindow, operate: vi.fn(async () => undefined), open: vi.fn(async () => undefined) } });
    await hook.quoteSelected('source-view', source as never, sourceState, { windowId: 'other', viewId: 'far' });
    expect(quoted('far')).toHaveLength(1);
    expect(scope.windowWorkspace.operate).not.toHaveBeenCalled();
    const { notice } = scope.dispatchQuote.mock.calls.at(-1)![0] as { notice: { message: string; open(): Promise<void> } };
    expect(notice.message).toBe('Quoted into “Far session” in Window “Other window”.');
    await notice.open();
    expect(scope.windowWorkspace.open).toHaveBeenCalledWith('other');
    expect(scope.windowWorkspace.operate).toHaveBeenCalledWith({ type: 'view.select', viewId: 'far' });
  });
  it('reads the open Window from the workspace, which is newer than the shared snapshot', async () => {
    const newer = buildWindow([buildView('source-view'), buildView('dest'), buildView('added')], 'source-view', { id: 'W' });
    const { hook } = await mount({ sharedWindow: openWindow, windowWorkspace: { windows: [], readWindow: () => newer, operate: vi.fn(), open: vi.fn() } });
    expect(hook.quoteTargets('source-view', source as never)[0]!.views.map(view => view.viewId)).toEqual(['dest', 'added']);
  });
  it('lists as targets the views of every Window that can take the quote', async () => {
    const { hook } = await mount({ windowWorkspace: { windows: [openWindow, other], readWindow: () => openWindow, operate: vi.fn(), open: vi.fn() } });
    expect(hook.quoteTargets('source-view', source as never).map(window => [window.id, window.current, window.views.map(view => view.viewId)])).toEqual([['W', true, ['dest']], ['other', false, ['far']]]);
  });
});

describe('selection, source and the next message', () => {
  it('selects messages for the view and epoch of its timeline', async () => {
    const { scope, hook } = await mount();
    const entries = hook.quoteEntrySelection('source-view', 'epoch');
    expect(entries.label).toBe('Quote');
    expect([...entries.selected!]).toEqual(['k1', 'k3']);
    entries.select(['k2'], true);
    expect(scope.dispatchQuote).toHaveBeenCalledWith({ type: 'select', viewId: 'source-view', epoch: 'epoch', keys: ['k2'], value: true });
  });
  it('opens the session an excerpt was quoted from through attribution navigation', async () => {
    const { scope, hook } = await mount();
    await hook.openExcerptSource({ hostId: 'local', providerId: 'codex', nativeSessionId: 'source', title: 'Source' });
    expect(scope.navigateAttributionRef.current).toHaveBeenCalledWith(expect.objectContaining({ kind: 'quote', value: 'Source',
      target: { kind: 'session', hostId: 'local', providerId: 'codex', nativeSessionId: 'source' } }));
  });
  it('keeps one wrapper per base actions and view, so memoized timelines do not render again', async () => {
    const { hook } = await mount();
    const base = { send: vi.fn() } as never;
    expect(hook.quotedActions(base, 'a')).toBe(hook.quotedActions(base, 'a'));
    expect(hook.quotedActions(base, 'a')).not.toBe(hook.quotedActions(base, 'b'));
    expect(hook.referencedActions(base, source as never, undefined)).toBe(hook.referencedActions(base, source as never, undefined));
  });
});
