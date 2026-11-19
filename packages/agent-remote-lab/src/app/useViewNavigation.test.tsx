import { describe, expect, it, vi } from 'vitest';
import { buildOpened, mockScope, renderHook } from '../test/render-hook.js';
import { useViewNavigation } from './useViewNavigation.js';

const source = buildOpened('source');
const history = { providerId: 'codex', nativeSessionId: 'history', title: 'Earlier', hostId: 'local', parentNativeSessionId: undefined };
const reveal = { requestId: 1 };

function scopeOf(facts: Record<string, unknown> = {}) {
  const scope = {
    accessReady: true, directory: {}, letterReveals: { [source.agentId]: reveal }, openChildSession: vi.fn(async () => undefined), openSession: vi.fn(async () => true),
    remoteHosts: [{ id: 'local', online: true }], sessionEntries: [source], sourceCurrent: () => true, transitioning: false, viewSession: (session: object) => ({ ...session, viewed: true }),
    letterNavigation: vi.fn(() => ({ direction: vi.fn(), open: vi.fn() })), ...facts,
  };
  return { scope, mock: mockScope<typeof useViewNavigation>(scope) };
}

async function navigationOf(facts: Record<string, unknown> = {}, actions?: object, sourceState?: object) {
  const built = scopeOf(facts);
  const { result } = await renderHook(() => useViewNavigation(built.mock));
  return { ...built, navigation: result.current.viewNavigation(source, sourceState as never, actions as never) };
}

describe('the navigation of a view that can navigate', () => {
  it('offers letters, children and the reveal of the entry a letter led to', async () => {
    const { navigation, scope } = await navigationOf();
    expect(navigation.communication).toBeDefined();
    expect(navigation.onOpenChildSession).toBeDefined();
    expect(navigation.revealEntry).toBe(reveal);
    expect(scope.letterNavigation).toHaveBeenCalledWith(expect.objectContaining({ viewed: true }), undefined);
  });
  it('opens a child of the view from the view', async () => {
    const state = { agent: { runtimeInfo: { childSessions: [] } } };
    const { navigation, scope } = await navigationOf({}, undefined, state);
    await navigation.onOpenChildSession!({ nativeSessionId: 'child', title: 'Child' } as never);
    expect(scope.openChildSession).toHaveBeenCalledWith({ nativeSessionId: 'child', title: 'Child' }, expect.objectContaining({ viewed: true }), state);
  });
  it('links an earlier session of the family and opens it as history', async () => {
    const { navigation, scope } = await navigationOf({ sessionEntries: [source, { ...history, parentNativeSessionId: undefined }] });
    expect(navigation.resolveSessionLink('source')).toBeDefined();
    await navigation.resolveSessionLink('source')!.open();
    expect(scope.openSession).toHaveBeenCalledWith(expect.objectContaining({ nativeSessionId: 'source' }), undefined, undefined, false, undefined, 'history');
  });
  it('reports a history session that could not be opened', async () => {
    const { navigation } = await navigationOf({ openSession: vi.fn(async () => false) });
    await expect(navigation.resolveSessionLink('source')!.open()).rejects.toThrow('This session could not be opened.');
  });
  it('treats a Host the list does not know as reachable', async () => {
    const { navigation } = await navigationOf({ remoteHosts: [] });
    expect(navigation.communication).toBeDefined();
  });
});

describe('the navigation of a view that cannot navigate', () => {
  it.each([
    ['no directory', { directory: undefined }], ['restoring access', { accessReady: false }], ['a source that is not current', { sourceCurrent: () => false }],
    ['a session switch in progress', { transitioning: true }], ['an offline Host', { remoteHosts: [{ id: 'local', online: false }] }],
  ])('offers no letters, children or history links with %s', async (_name, change) => {
    const { navigation, scope } = await navigationOf(change);
    expect(navigation.communication).toBeUndefined();
    expect(navigation.onOpenChildSession).toBeUndefined();
    expect(navigation.resolveSessionLink('source')).toBeUndefined();
    expect(scope.letterNavigation).not.toHaveBeenCalled();
  });
});

describe('a view that brings its own actions', () => {
  it('uses them, with the source as given and whatever the state of the page', async () => {
    const open = vi.fn(async () => true), openChild = vi.fn(async () => undefined);
    const { navigation, scope } = await navigationOf({ directory: undefined }, { openSession: open, openChildSession: openChild });
    await navigation.resolveSessionLink('source')!.open();
    await navigation.onOpenChildSession!({ nativeSessionId: 'c', title: 'C' } as never);
    expect(open).toHaveBeenCalled();
    expect(openChild).toHaveBeenCalled();
    expect(scope.openSession).not.toHaveBeenCalled();
    expect(navigation.communication).toBeUndefined();
  });
  it('does not project the source through the page view', async () => {
    const { scope } = await navigationOf({}, { openSession: vi.fn() });
    expect(scope.letterNavigation).toHaveBeenCalledWith(expect.not.objectContaining({ viewed: true }), undefined);
  });
});
