import { act, useState, type ComponentProps } from 'react';
import { AgentReplica } from '@orchardworks/agent-remote-web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';
import { DraftStore } from '../draft-store.js';
import { ForkStore, referenceForkContext } from '../session-forks.js';
import { sessionKey } from '../session-tree.js';
import type { AskEntry } from '../hooks/useAskConversations.js';
import { SessionAsk } from './SessionAsk.js';

type AskProps = ComponentProps<typeof SessionAsk>;
const source = { hostId: 'local', providerId: 'codex', nativeSessionId: 'main', agentId: 'main-agent', title: 'Main' };
const sibling = { ...source, nativeSessionId: 'side', agentId: 'side-agent', title: 'Side' };
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

function fixture(entries: AskEntry[]) {
  const values = new Map(entries.map(entry => [sessionKey(entry.source), entry]));
  const restore = vi.fn<AskProps['ask']['restore']>(() => undefined);
  const ask = {
    entryFor: (session: typeof source) => values.get(sessionKey(session))!, isEnabled: () => true, isOpen: () => true,
    restore, drafts: new DraftStore('session-ask-focus'), store: new ForkStore('session-ask-focus', sessionStorage),
    close: vi.fn(), toggle: vi.fn(), sendInput: vi.fn(),
  } as unknown as AskProps['ask'];
  const props: Omit<AskProps, 'source'> = {
    ask, visible: true, available: true, canRestore: false, storageScope: 'session-ask-focus',
    synchronize: async () => {}, onOpen: vi.fn(), replicaFor: () => { throw new Error('A draft Ask has no native replica.'); },
    transport: {} as AskProps['transport'], observations: {}, navigation: () => ({} as ReturnType<AskProps['navigation']>),
  };
  return { ask, restore, props };
}

it('restores multiple expanded Ask windows without moving focus or cancelling their source composition', async () => {
  const existing = await render(<input aria-label="Existing focus" />);
  const input = existing.querySelector('input')!;
  input.focus();
  const entries = [source, sibling].map(value => ({ source: value, restoring: true, restoreOnly: true }));
  const { props, restore } = fixture(entries);
  const parentFocus = vi.fn();
  let finish!: () => void;
  function Harness() {
    const [restored, setRestored] = useState(false);
    finish = () => { for (const entry of entries) { entry.restoring = false; entry.restoreOnly = false; } setRestored(true); };
    return <>{[source, sibling].map(value => <div key={sessionKey(value)} onFocusCapture={parentFocus}>
      <SessionAsk {...props} source={value} canRestore={restored} />
    </div>)}</>;
  }
  const container = await render(<Harness />);
  expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(2);
  expect(restore).not.toHaveBeenCalled();
  expect(parentFocus).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(input);
  await act(async () => { finish(); });
  expect(restore).toHaveBeenCalledTimes(2);
  expect(parentFocus).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(input);
});

it('focuses an explicitly opened Ask and only minimizes the Ask containing the Escape event', async () => {
  const { ask, props } = fixture([{ source }, { source: sibling, restoring: true, restoreOnly: true }]);
  let open = false;
  ask.isOpen = session => sessionKey(session) === sessionKey(sibling) || open;
  function Harness() {
    const [, changed] = useState(0);
    return <><div data-source="main"><SessionAsk {...props} state={replicaState} source={source} onOpen={() => { open = true; changed(value => value + 1); }} /></div>
      <div data-source="side"><SessionAsk {...props} source={sibling} /></div></>;
  }
  const container = await render(<Harness />);
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-source="main"] .lab-ask-trigger')!.click(); });
  const opened = container.querySelector('[data-source="main"] [role="dialog"]')!;
  expect(document.activeElement).toBe(opened);
  await act(async () => { opened.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
  expect(ask.close).toHaveBeenCalledExactlyOnceWith(source);
});

it('retires the previous restoration when the owning workspace or transport changes', async () => {
  const { props, restore } = fixture([{ source, restoring: true, restoreOnly: true }]);
  const stop = vi.fn();
  restore.mockImplementation(() => stop);
  let switchScope!: () => void, switchTransport!: () => void;
  function Harness() {
    const [scope, setScope] = useState('first');
    const [transport, setTransport] = useState(props.transport);
    switchScope = () => setScope('second');
    switchTransport = () => setTransport({} as AskProps['transport']);
    return <SessionAsk {...props} source={source} canRestore storageScope={scope} transport={transport} />;
  }
  await render(<Harness />);
  expect(restore).toHaveBeenCalledTimes(1);
  await act(async () => { switchScope(); });
  expect(stop).toHaveBeenCalledTimes(1);
  expect(restore).toHaveBeenCalledTimes(2);
  await act(async () => { switchTransport(); });
  expect(stop).toHaveBeenCalledTimes(2);
  expect(restore).toHaveBeenCalledTimes(3);
});

it.each(['restoring', 'failed'])('does not subscribe to a saved Ask while its attachment is %s and preserves the draft', async phase => {
  const entry: AskEntry = { source, attached: false, restoring: phase === 'restoring',
    error: phase === 'failed' ? 'The native runtime could not find this session.' : undefined };
  const { ask, props } = fixture([entry]);
  const record = ask.store.prepare(referenceForkContext(source), { sourceNativeSessionId: source.nativeSessionId });
  ask.store.bind(record.id, { ...sibling, title: 'Ask' });
  entry.record = ask.store.get(record.id);
  ask.drafts.set(sessionKey(source), 'Keep this unsent question');
  const replicaFor = vi.fn(props.replicaFor);
  const connect = vi.fn();
  const container = await render(<SessionAsk {...props} source={source} replicaFor={replicaFor} transport={{ ...props.transport, connect }} />);
  expect(replicaFor).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Ask draft"]')?.value).toBe('Keep this unsent question');
  expect(container.textContent).not.toContain('Timeline synchronization');
  expect(container.querySelector('[aria-label="Clean Ask"]')).not.toBeNull();
  if (phase === 'failed') {
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('The native runtime could not find this session.');
    await act(async () => { container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click(); });
    expect(props.onOpen).toHaveBeenCalledExactlyOnceWith();
  }
});

it('mounts the ordinary Ask session only after attachment succeeds', async () => {
  const entry: AskEntry = { source, attached: false, restoring: true };
  const { ask, props } = fixture([entry]);
  const record = ask.store.prepare(referenceForkContext(source), { sourceNativeSessionId: source.nativeSessionId });
  ask.store.bind(record.id, { ...sibling, title: 'Ask' });
  entry.record = ask.store.get(record.id);
  ask.drafts.set(sessionKey(source), 'Continue this question');
  const replica = new AgentReplica();
  const replicaFor = vi.fn(() => replica);
  const connect = vi.fn(() => ({ close: vi.fn(), send: vi.fn() }));
  const transport = { ...props.transport, connect, onDiagnostic: () => () => {}, onProtocolMessage: () => () => {} };
  let attach!: () => void;
  function Harness() {
    const [, changed] = useState(0);
    attach = () => { entry.attached = true; entry.restoring = false; changed(value => value + 1); };
    return <SessionAsk {...props} source={source} replicaFor={replicaFor} transport={transport} />;
  }
  const container = await render(<Harness />);
  expect(connect).not.toHaveBeenCalled();
  await act(async () => { attach(); });
  expect(replicaFor).toHaveBeenCalledWith(sibling.agentId);
  expect(connect).toHaveBeenCalledOnce();
  expect(container.querySelector('[aria-label="Ask draft"]')).toBeNull();
  expect(container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')?.value).toBe('Continue this question');
});
