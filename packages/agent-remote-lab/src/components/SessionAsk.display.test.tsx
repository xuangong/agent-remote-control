import { createRef, type ComponentProps } from 'react';
import { applyWindowOperation, createWindowView } from '@orchardworks/agent-remote-protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { DraftStore } from '../draft-store.js';
import { ForkStore, referenceForkContext } from '../session-forks.js';
import { sessionKey } from '../session-tree.js';
import { WindowLayoutContext, type WindowLayoutAuthority } from '../window-workspace-context.js';
import { windowSessionBinding } from '../window-workspace.js';
import { askParticipantKey, type AskEntry } from '../hooks/useAskConversations.js';

const family = vi.hoisted(() => ({ displayBindings: [] as unknown[] }));
vi.mock('./SessionFamily.js', () => ({ SessionFamily: (props: { displayBinding?: unknown }) => { family.displayBindings.push(props.displayBinding); return null; } }));
const { SessionAsk } = await import('./SessionAsk.js');

type AskProps = ComponentProps<typeof SessionAsk>;
const source = { hostId: 'local', providerId: 'codex', nativeSessionId: 'main', agentId: 'main-agent', title: 'Main' };
beforeEach(() => { family.displayBindings.length = 0; vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

function setup(display: { scope: string; key: string } | undefined, sharedViewId?: string) {
  const store = new ForkStore('ask-display', sessionStorage);
  const record = store.prepare(referenceForkContext(source), { sourceNativeSessionId: source.nativeSessionId });
  store.bind(record.id, { ...source, nativeSessionId: 'ask-target', agentId: 'ask-agent', title: 'Ask' });
  const bound = store.get(record.id)!;
  const entry: AskEntry = { source, attached: true, record: bound, attachedParticipant: askParticipantKey(bound) };
  const drafts = new DraftStore('ask-display');
  const view = sharedViewId ? { ...createWindowView(sharedViewId, { ...windowSessionBinding(source), nativeSessionId: 'ask-target' }, 'float'), feature: { kind: 'ask', id: 'feature-ask' } } : undefined;
  const ask = {
    sharedView: () => view, entryFor: () => entry, isEnabled: () => true, isOpen: () => true, restore: () => undefined, drafts, store,
    associationOwner: (id: string) => ({ id, sourceSlot: id, geometryScope: id, display, text: { scope: 'ask-display', key: id }, input: { scope: 'ask-display', key: id }, open: true }),
    draftBinding: (id: string) => ({ store: drafts, key: id }), close: vi.fn(), minimize: vi.fn(), toggle: vi.fn(), sendInput: vi.fn(), discardInput: vi.fn(),
  } as unknown as AskProps['ask'];
  const props: AskProps = { source, associationOwner: sessionKey(source), ask, visible: true, canRestore: false, storageScope: 'ask-display', synchronize: async () => {}, onOpen: vi.fn(),
    replicaFor: () => ({}) as never, transport: {} as never, navigation: (() => ({})) as never, triggerRef: createRef<HTMLButtonElement>(), onToggleEnabled: vi.fn() };
  const layout: WindowLayoutAuthority | undefined = view ? { window: { schemaVersion: 3, id: 'window', title: 'Window', revision: 0, selectedPrimaryViewId: view.id, selectedViewId: view.id, views: [view] }, operate: vi.fn() } : undefined;
  return { props, layout };
}

it('keeps an Ask\'s display choices under the owner that holds them, apart from every other view', async () => {
  const { props } = setup({ scope: 'relay', key: 'ask-owner-display' });
  await render(<SessionAsk {...props} />);
  expect(family.displayBindings.at(-1)).toEqual({ scope: 'relay', key: 'ask-owner-display' });
});

it('keys an Ask shown as a Window view by that view, under the owner\'s scope', async () => {
  const { props, layout } = setup({ scope: 'relay', key: 'ask-owner-display' }, 'ask-view');
  await render(<WindowLayoutContext.Provider value={{ ...layout!, readWindow: () => layout!.window, operate: (operation: Parameters<typeof applyWindowOperation>[1]) => { void operation; } }}><SessionAsk {...props} /></WindowLayoutContext.Provider>);
  expect(family.displayBindings.at(-1)).toEqual({ scope: 'relay', key: 'ask-view' });
});
