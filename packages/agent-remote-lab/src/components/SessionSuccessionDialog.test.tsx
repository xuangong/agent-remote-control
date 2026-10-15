import { act, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, unmount } from '../test/setup.js';
import { SessionDirectoryClient, type SuccessionActionResult, type SuccessionDescription } from '../directory-client.js';
import { SessionSuccessionDialog } from './SessionSuccessionDialog.js';
const source = { hostId: 'host', agentId: 'agent', providerId: 'opencode', nativeSessionId: 'A', title: 'Original' };
const ref = { controllerId: 'controller', providerId: 'opencode', nativeSessionId: 'A' };
const description: SuccessionDescription = { role: { id: 'role', revision: 4, origin: ref, current: ref, workspace: { controllerId: 'controller', canonicalCwd: '/actual/workspace' } }, targets: [{ providerId: 'opencode', displayName: 'OpenCode' }], eligibility: { status: 'ready' } };
function response(operationId: string, phase: SuccessionActionResult['record']['phase']): SuccessionActionResult {
  return { role: description.role, record: { operationId, roleId: 'role', expectedRevision: 4, from: ref, targetProviderId: 'opencode', phase, startedAt: 'now', updatedAt: 'now' } };
}
function button(name: string) { return [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === name)!; }
async function details() { if (button('Details')) await act(async () => button('Details').click()); }
const flush = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
afterEach(() => vi.useRealTimers());
beforeEach(() => { Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } }); });
async function setup(options: { description?: SuccessionDescription; initialProvider?: string; blockedReason?: string } = {}) {
  const directory = new SessionDirectoryClient('http://localhost', undefined, 'host');
  const describe = vi.spyOn(directory, 'describeSuccession').mockResolvedValue(options.description ?? description);
  const prepare = vi.spyOn(directory, 'prepareSuccession');
  const action = vi.spyOn(directory, 'successionAction');
  const settled = vi.fn().mockResolvedValue(undefined), close = vi.fn(), intent = vi.fn(), gated = vi.fn();
  const container = await render(<SessionSuccessionDialog source={source} directory={directory} initialProvider={options.initialProvider} blockedReason={options.blockedReason} assertAccess={() => {}} assertSource={() => {}} onIntent={intent} onSettled={settled} onClose={close} onGatedChange={gated} />);
  await flush(); return { directory, describe, prepare, action, settled, close, intent, gated, container };
}
it('uses authoritative revision and same operation for preparation and commitment', async () => {
  const state = await setup();
  state.prepare.mockImplementation(async input => response(input.operationId, 'ready'));
  state.action.mockImplementation(async (_action, id) => response(id, 'committed'));
  expect(document.body.textContent).toContain('/actual/workspace');
  await act(async () => button('Hand off').click());
  const request = state.prepare.mock.calls[0]![0];
  expect(request).toMatchObject({ providerId: 'opencode', nativeSessionId: 'A', expectedRevision: 4, targetProviderId: 'opencode' });
  expect(state.intent).toHaveBeenCalledWith(request, false);
  expect(state.action).toHaveBeenCalledWith('commit', request.operationId);
  expect(state.settled).toHaveBeenCalledOnce();
  expect(state.settled).toHaveBeenCalledWith(response(request.operationId, 'committed'));
  expect(state.close).toHaveBeenLastCalledWith(false);
  expect(state.gated).toHaveBeenLastCalledWith(false);
}, 5000);

it('shows pending input as a preparation block before retaining an operation', async () => {
  const reason = 'Send or remove pending messages before handing off this conversation.';
  const state = await setup({ blockedReason: reason });
  expect(button('Hand off').disabled).toBe(true);
  expect(document.querySelector('dialog')?.textContent).toContain(reason);
  await act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(state.prepare).not.toHaveBeenCalled();
  expect(state.intent).not.toHaveBeenCalled();
}, 5000);

it('checks the current preparation block when a previously available chooser is submitted', async () => {
  const directory = new SessionDirectoryClient('http://localhost', undefined, 'host');
  vi.spyOn(directory, 'describeSuccession').mockResolvedValue(description);
  const prepare = vi.spyOn(directory, 'prepareSuccession'), intent = vi.fn(), access = vi.fn(), current = vi.fn();
  let block!: (reason: string) => void;
  function Panel() {
    const [reason, setReason] = useState<string>();
    block = setReason;
    return <SessionSuccessionDialog source={source} directory={directory} blockedReason={reason}
      assertAccess={access} assertSource={current} onIntent={intent} onSettled={async () => {}} onClose={() => {}} />;
  }
  await render(<Panel />); await flush();
  expect(button('Hand off').disabled).toBe(false);
  await act(async () => block('Resolve the newly pending message.'));
  access.mockClear(); current.mockClear();
  await act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(prepare).not.toHaveBeenCalled(); expect(intent).not.toHaveBeenCalled();
  expect(access).not.toHaveBeenCalled(); expect(current).not.toHaveBeenCalled();
}, 5000);

it('continues status, reconciliation, and cancellation of a retained operation with pending input', async () => {
  const directory = new SessionDirectoryClient('http://localhost', undefined, 'host');
  const action = vi.spyOn(directory, 'successionAction').mockImplementation(async (kind, id) => response(id, kind === 'cancel' ? 'cancelled' : 'unknown'));
  await render(<SessionSuccessionDialog source={source} directory={directory} blockedReason="Resolve pending input."
    resume={{ operationId: 'retained-op', providerId: 'opencode', nativeSessionId: 'A', expectedRevision: 4 }}
    assertAccess={() => {}} assertSource={() => {}} onIntent={() => {}} onSettled={async () => {}} onClose={() => {}} />);
  await flush(); await details();
  await act(async () => button('Reconcile').click());
  await act(async () => button('Cancel Handoff').click());
  expect(action.mock.calls).toEqual([['status', 'retained-op'], ['reconcile', 'retained-op'], ['cancel', 'retained-op', {
    original: { operationId: 'retained-op', providerId: 'opencode', nativeSessionId: 'A', expectedRevision: 4 },
  }]]);
}, 5000);

it('defaults to the source provider even when the Host lists another target first', async () => {
  const state = await setup({ description: { ...description, targets: [{ providerId: 'codex', displayName: 'Codex' }, ...description.targets] } });
  expect(document.querySelector('select')?.value).toBe('opencode');
  state.prepare.mockImplementation(async input => response(input.operationId, 'ready'));
  state.action.mockImplementation(async (_action, id) => response(id, 'committed'));
  await act(async () => button('Hand off').click());
  expect(state.prepare.mock.calls[0]![0].targetProviderId).toBe('opencode');
}, 5000);

it('matches an explicit claude alias to the available provider', async () => {
  await setup({ initialProvider: 'claude', description: { ...description, targets: [...description.targets, { providerId: 'claude-code', displayName: 'Claude Code' }] } });
  expect(document.querySelector('select')?.value).toBe('claude-code');
}, 5000);

it('requires an explicit target choice when the requested provider is unavailable', async () => {
  const state = await setup({ initialProvider: 'codex' });
  const select = document.querySelector('select')!;
  expect(select.value).toBe('');
  expect(button('Hand off').disabled).toBe(true);
  expect(document.querySelector('[role="status"]')?.textContent).toContain('codex');
  await act(async () => button('Hand off').click());
  expect(state.prepare).not.toHaveBeenCalled();
  await act(async () => { select.value = 'opencode'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(button('Hand off').disabled).toBe(false);
  state.prepare.mockImplementation(async input => response(input.operationId, 'ready'));
  state.action.mockImplementation(async (_action, id) => response(id, 'committed'));
  await act(async () => button('Hand off').click());
  expect(state.prepare.mock.calls[0]![0].targetProviderId).toBe('opencode');
}, 5000);

it('moves held preparation into a quiet inline notice with expandable cancellation', async () => {
  const state = await setup();
  expect(document.querySelector('dialog[open]')).not.toBeNull();
  expect(document.querySelector('dialog')?.textContent).not.toContain('Same Host:');
  let release!: (value: SuccessionActionResult) => void;
  state.prepare.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  await act(async () => button('Hand off').click());
  expect(document.querySelector('dialog')).toBeNull();
  expect(state.container.querySelector('[role="status"]')?.textContent).toContain('Handing off');
  expect(state.container.textContent).not.toContain('/actual/workspace');
  expect(state.container.textContent).not.toContain('Original');
  expect(button('Cancel Handoff')).toBeUndefined();
  expect(state.gated).toHaveBeenLastCalledWith(true);
  await details();
  expect(state.container.textContent).toContain('/actual/workspace');
  expect(state.container.textContent).toContain('Original');
  expect(button('Cancel Handoff').disabled).toBe(false);
  state.action.mockImplementation(async (_action, id) => response(id, 'cancelled'));
  await act(async () => button('Cancel Handoff').click());
  await act(async () => release(response(state.prepare.mock.calls[0]![0].operationId, 'ready')));
  expect(state.action.mock.calls).toEqual([['cancel', state.prepare.mock.calls[0]![0].operationId, { original: state.prepare.mock.calls[0]![0] }]]);
}, 5000);
it('keeps an uncertain prepare identity and recovers it through status without creating again', async () => {
  const state = await setup();
  state.prepare.mockRejectedValue(new Error('Response lost'));
  await act(async () => button('Hand off').click());
  const id = state.prepare.mock.calls[0]![0].operationId;
  expect(button('Hand off')).toBeUndefined();
  state.action.mockResolvedValue(response(id, 'committed'));
  await details(); await act(async () => button('Check status').click());
  expect(state.action).toHaveBeenCalledWith('status', id); expect(state.prepare).toHaveBeenCalledOnce(); expect(state.settled).toHaveBeenCalledOnce();
}, 5000);
it('allows cancellation during held creation and ignores a late ready response', async () => {
  const state = await setup();
  let release!: (value: SuccessionActionResult) => void;
  state.prepare.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  await act(async () => button('Hand off').click());
  const id = state.prepare.mock.calls[0]![0].operationId;
  state.action.mockResolvedValue(response(id, 'cancelled'));
  await details(); await act(async () => button('Cancel Handoff').click());
  await act(async () => release(response(id, 'ready')));
  expect(state.action.mock.calls).toEqual([['cancel', id, { original: state.prepare.mock.calls[0]![0] }]]); expect(state.settled).toHaveBeenCalledOnce();
  expect(state.settled).toHaveBeenCalledWith(response(id, 'cancelled'));
  expect(document.body.textContent).toContain('Handoff cancelled');
}, 5000);
it('blocks a Host-described unavailable source before preparing', async () => {
  const directory = new SessionDirectoryClient('http://localhost', undefined, 'host');
  vi.spyOn(directory, 'describeSuccession').mockResolvedValue({ ...description, eligibility: { status: 'blocked', code: 'busy', reason: 'Source has pending work.' } });
  const prepare = vi.spyOn(directory, 'prepareSuccession');
  await render(<SessionSuccessionDialog source={source} directory={directory} assertAccess={() => {}} assertSource={() => {}} onIntent={() => {}} onSettled={async () => {}} onClose={() => {}} />);
  await flush(); expect(button('Hand off').disabled).toBe(true); expect(prepare).not.toHaveBeenCalled();
}, 5000);

it('resumes a saved uncertain operation without describing or preparing another source', async () => {
  const directory = new SessionDirectoryClient('http://localhost', undefined, 'host');
  const describe = vi.spyOn(directory, 'describeSuccession'), prepare = vi.spyOn(directory, 'prepareSuccession');
  const action = vi.spyOn(directory, 'successionAction').mockResolvedValue(response('saved-op', 'committed'));
  const settled = vi.fn().mockResolvedValue(undefined);
  await render(<SessionSuccessionDialog source={source} directory={directory} resume={{ operationId: 'saved-op', providerId: 'opencode', nativeSessionId: 'A', expectedRevision: 4, targetProviderId: 'opencode' }}
    assertAccess={() => {}} assertSource={() => { throw new Error('Original source is now historical'); }} onIntent={() => {}} onSettled={settled} onClose={() => {}} />);
  await flush();
  expect(action).toHaveBeenCalledWith('status', 'saved-op'); expect(describe).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled(); expect(settled).toHaveBeenCalledOnce();
}, 5000);

it('does not dispatch preparation when retaining the operation fails', async () => {
  const directory = new SessionDirectoryClient('http://localhost', undefined, 'host');
  vi.spyOn(directory, 'describeSuccession').mockResolvedValue(description);
  const prepare = vi.spyOn(directory, 'prepareSuccession');
  await render(<SessionSuccessionDialog source={source} directory={directory} assertAccess={() => {}} assertSource={() => {}} onIntent={() => { throw new Error('Storage unavailable'); }} onSettled={async () => {}} onClose={() => {}} />);
  await flush(); await act(async () => button('Hand off').click());
  expect(prepare).not.toHaveBeenCalled(); expect(button('Hand off')).toBeDefined(); expect(document.querySelector('[role="alert"]')?.textContent).toContain('Storage unavailable');
}, 5000);

it('never commits late preparation after a failed cancellation and retains the cancellation intent', async () => {
  const state = await setup();
  let release!: (value: SuccessionActionResult) => void;
  state.prepare.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  await act(async () => button('Hand off').click());
  const request = state.prepare.mock.calls[0]![0];
  state.action.mockRejectedValue(new Error('Cancel response lost'));
  await details(); await act(async () => button('Cancel Handoff').click());
  expect(state.intent).toHaveBeenLastCalledWith(request, true);
  await act(async () => release(response(request.operationId, 'ready')));
  expect(state.action.mock.calls).toEqual([['cancel', request.operationId, { original: request }]]);
  expect(button('Commit Handoff')).toBeUndefined();
  expect(document.body.textContent).toContain('Cancellation requested');
}, 5000);

it('preserves saved cancellation intent after reload while consuming an already committed receipt', async () => {
  const directory = new SessionDirectoryClient('http://localhost', undefined, 'host');
  const action = vi.spyOn(directory, 'successionAction').mockResolvedValue(response('cancel-op', 'ready'));
  const settled = vi.fn().mockResolvedValue(undefined);
  await render(<SessionSuccessionDialog source={source} directory={directory} resume={{ operationId: 'cancel-op', providerId: 'opencode', nativeSessionId: 'A', expectedRevision: 4, targetProviderId: 'opencode' }} resumeCancellation
    assertAccess={() => {}} assertSource={() => {}} onIntent={() => {}} onSettled={settled} onClose={() => {}} />);
  await flush(); await details();
  expect(button('Commit Handoff')).toBeUndefined(); expect(action.mock.calls).toEqual([['status', 'cancel-op']]);
  action.mockResolvedValue(response('cancel-op', 'committed'));
  await details(); await act(async () => button('Check status').click());
  expect(settled).toHaveBeenCalledOnce();
}, 5000);

it('lets the user hide a pre-enrollment rejection without clearing or replacing its uncertain operation', async () => {
  const state = await setup();
  state.prepare.mockRejectedValue(new Error('Stale revision rejected before enrollment'));
  await act(async () => button('Hand off').click());
  const request = state.prepare.mock.calls[0]![0];
  state.action.mockRejectedValue(new Error('succession_not_found'));
  await details();
  for (const name of ['Check status', 'Reconcile', 'Cancel Handoff']) await act(async () => button(name).click());
  await act(async () => button('Hide Handoff').click());
  expect(state.close).toHaveBeenCalledWith(true);
  expect(state.prepare).toHaveBeenCalledOnce();
  expect(state.intent).toHaveBeenLastCalledWith(request, true);
}, 5000);

it('bounds automatic status recovery of a saved unknown result without replaying mutations', async () => {
  vi.useFakeTimers();
  const directory = new SessionDirectoryClient('http://localhost', undefined, 'host');
  const prepare = vi.spyOn(directory, 'prepareSuccession');
  const action = vi.spyOn(directory, 'successionAction').mockRejectedValue(new Error('HTTP 404'));
  const gated = vi.fn(), close = vi.fn();
  await render(<SessionSuccessionDialog source={source} directory={directory} resume={{ operationId: 'unknown-op', providerId: 'opencode', nativeSessionId: 'A', expectedRevision: 4 }}
    assertAccess={() => {}} assertSource={() => {}} onIntent={() => {}} onSettled={async () => {}} onClose={close} onGatedChange={gated} />);
  expect(action).toHaveBeenCalledWith('status', 'unknown-op');
  expect(gated).toHaveBeenLastCalledWith(true);
  for (let round = 0; round < 8; round++) await act(async () => vi.advanceTimersByTimeAsync(15_000));
  const attempts = action.mock.calls.length;
  expect(attempts).toBeGreaterThan(1);
  expect(attempts).toBeLessThanOrEqual(6);
  await act(async () => vi.advanceTimersByTimeAsync(120_000));
  expect(action).toHaveBeenCalledTimes(attempts);
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(action).toHaveBeenCalledTimes(attempts);
  expect(action.mock.calls.every(([kind, id]) => kind === 'status' && id === 'unknown-op')).toBe(true);
  expect(prepare).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Automatic checks stopped');
  await details();
  expect(button('Check status').disabled).toBe(false);
  expect(button('Reconcile').disabled).toBe(false);
  expect(button('Cancel Handoff').disabled).toBe(false);
  expect(button('Done')).toBeUndefined();
  expect(gated).toHaveBeenLastCalledWith(true);
}, 5000);

it.each(['cancelled', 'rejected'] as const)('keeps sending gated until a %s result refreshes the current conversation', async phase => {
  const state = await setup();
  state.prepare.mockRejectedValue(new Error('Preparation response lost'));
  await act(async () => button('Hand off').click());
  const operationId = state.prepare.mock.calls[0]![0].operationId;
  const terminal = response(operationId, phase);
  state.action.mockResolvedValue(terminal);
  let release!: () => void;
  state.settled.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  await details();
  await act(async () => button(phase === 'cancelled' ? 'Cancel Handoff' : 'Check status').click());
  expect(state.gated).toHaveBeenLastCalledWith(true);
  expect(button('Done')).toBeUndefined();
  expect(state.close).not.toHaveBeenCalled();
  expect(state.settled).toHaveBeenCalledWith(terminal);
  await act(async () => release());
  expect(state.gated).toHaveBeenLastCalledWith(false);
  expect(button('Done')).toBeDefined();
  expect(state.close).not.toHaveBeenCalled();
  await act(async () => button('Done').click());
  expect(state.close).toHaveBeenLastCalledWith(false);
}, 5000);

it.each(['cancelled', 'rejected'] as const)('retains a %s result after refresh failure and retries only the refresh', async phase => {
  const state = await setup();
  state.prepare.mockRejectedValue(new Error('Preparation response lost'));
  await act(async () => button('Hand off').click());
  const operationId = state.prepare.mock.calls[0]![0].operationId;
  state.action.mockResolvedValue(response(operationId, phase));
  state.settled.mockRejectedValueOnce(new Error('Current conversation refresh failed'));
  await details();
  await act(async () => button(phase === 'cancelled' ? 'Cancel Handoff' : 'Check status').click());
  expect(state.gated).toHaveBeenLastCalledWith(true);
  expect(button('Done')).toBeUndefined();
  await act(async () => button('Hide Handoff').click());
  expect(state.close).toHaveBeenLastCalledWith(true);
  await act(async () => button('Retry refresh').click());
  expect(state.settled).toHaveBeenCalledTimes(2);
  expect(state.action).toHaveBeenCalledTimes(1);
  expect(state.prepare).toHaveBeenCalledOnce();
  expect(state.gated).toHaveBeenLastCalledWith(false);
  await details();
  expect(button('Done')).toBeDefined();
}, 5000);

it('preserves a confirmed commit when projection fails and retries only the projection', async () => {
  const state = await setup();
  state.prepare.mockImplementation(async input => response(input.operationId, 'ready'));
  state.action.mockImplementation(async (_action, id) => response(id, 'committed'));
  state.settled.mockRejectedValueOnce(new Error('Refresh failed'));
  await act(async () => button('Hand off').click());
  expect(state.close).not.toHaveBeenCalled();
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Handoff complete');
  expect(state.gated).toHaveBeenLastCalledWith(true);
  await act(async () => button('Retry refresh').click());
  expect(state.settled).toHaveBeenCalledTimes(2);
  expect(state.action).toHaveBeenCalledTimes(1);
  expect(state.prepare).toHaveBeenCalledOnce();
  expect(state.close).toHaveBeenLastCalledWith(false);
  expect(state.gated).toHaveBeenLastCalledWith(false);
}, 5000);

it('ignores completion callbacks after the panel unmounts while preparation is pending', async () => {
  const state = await setup();
  let release!: (value: SuccessionActionResult) => void;
  state.prepare.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  await act(async () => button('Hand off').click());
  const id = state.prepare.mock.calls[0]![0].operationId;
  await unmount(state.container);
  await act(async () => release(response(id, 'ready')));
  expect(state.action).not.toHaveBeenCalled();
  expect(state.settled).not.toHaveBeenCalled();
  expect(state.close).not.toHaveBeenCalled();
}, 5000);

it('pauses status polling when hidden or access is unavailable and resumes on focus', async () => {
  vi.useFakeTimers();
  let access = false;
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  const directory = new SessionDirectoryClient('http://localhost', undefined, 'host');
  const action = vi.spyOn(directory, 'successionAction').mockResolvedValue(response('paused-op', 'unknown'));
  await render(<SessionSuccessionDialog source={source} directory={directory} resume={{ operationId: 'paused-op', providerId: 'opencode', nativeSessionId: 'A', expectedRevision: 4 }}
    assertAccess={() => { if (!access) throw new Error('Reconnect required'); }} assertSource={() => {}} onIntent={() => {}} onSettled={async () => {}} onClose={() => {}} />);
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(action).not.toHaveBeenCalled();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(action).not.toHaveBeenCalled();
  access = true;
  await act(async () => window.dispatchEvent(new Event('focus')));
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(action).toHaveBeenCalledWith('status', 'paused-op');
}, 5000);

it('keeps the operation inline while details are hidden and reopens through onOpen', async () => {
  const directory = new SessionDirectoryClient('http://localhost', undefined, 'host');
  vi.spyOn(directory, 'successionAction').mockResolvedValue(response('visible-op', 'unknown'));
  const opened = vi.fn();
  function Panel() {
    const [visible, setVisible] = useState(false);
    return <SessionSuccessionDialog source={source} directory={directory} visible={visible} resume={{ operationId: 'visible-op', providerId: 'opencode', nativeSessionId: 'A', expectedRevision: 4 }}
      assertAccess={() => {}} assertSource={() => {}} onIntent={() => {}} onSettled={async () => {}} onClose={() => setVisible(false)} onOpen={() => { opened(); setVisible(true); }} />;
  }
  const container = await render(<Panel />);
  expect(container.querySelector('[role="status"]')).not.toBeNull();
  expect(button('Check status')).toBeUndefined();
  await details();
  expect(opened).toHaveBeenCalledOnce();
  expect(button('Check status')).toBeDefined();
  await act(async () => button('Hide Handoff').click());
  expect(button('Check status')).toBeUndefined();
  expect(container.querySelector('[role="status"]')).not.toBeNull();
}, 5000);

it('keeps an uncertain result visible during status recovery and never auto-commits a recovered ready result', async () => {
  const state = await setup();
  state.prepare.mockRejectedValue(new Error('Response lost'));
  await act(async () => button('Hand off').click());
  let release!: (value: SuccessionActionResult) => void;
  state.action.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  await details();
  await act(async () => button('Check status').click());
  expect(state.container.querySelector('[role="status"]')?.textContent).toContain('not yet confirmed');
  const id = state.prepare.mock.calls[0]![0].operationId;
  await act(async () => release(response(id, 'ready')));
  expect(state.action.mock.calls).toEqual([['status', id]]);
  expect(button('Commit Handoff')).toBeDefined();
  expect(state.prepare).toHaveBeenCalledOnce();
}, 5000);

it('does not present the earlier ready receipt as confirmed after a lost commit response', async () => {
  const state = await setup();
  state.prepare.mockImplementation(async input => response(input.operationId, 'ready'));
  state.action.mockRejectedValue(new Error('Commit response lost'));
  await act(async () => button('Hand off').click());
  expect(state.container.querySelector('[role="status"]')?.textContent).toContain('not yet confirmed');
  expect(state.close).not.toHaveBeenCalled();
  expect(state.gated).toHaveBeenLastCalledWith(true);
}, 5000);

it('does not observe a saved result while preparation is still in flight', async () => {
  const state = await setup();
  vi.useFakeTimers();
  let release!: (value: SuccessionActionResult) => void;
  state.prepare.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  await act(async () => button('Hand off').click());
  await act(async () => vi.advanceTimersByTimeAsync(120_000));
  expect(state.action).not.toHaveBeenCalled();
  state.action.mockImplementation(async (_action, id) => response(id, 'committed'));
  await act(async () => release(response(state.prepare.mock.calls[0]![0].operationId, 'ready')));
  expect(state.action.mock.calls).toEqual([['commit', state.prepare.mock.calls[0]![0].operationId]]);
}, 5000);

it('does not auto-commit preparation if the source changed before the response arrived', async () => {
  const directory = new SessionDirectoryClient('http://localhost', undefined, 'host');
  vi.spyOn(directory, 'describeSuccession').mockResolvedValue(description);
  let release!: (value: SuccessionActionResult) => void;
  const prepare = vi.spyOn(directory, 'prepareSuccession').mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const action = vi.spyOn(directory, 'successionAction');
  let sourceChanged = false;
  await render(<SessionSuccessionDialog source={source} directory={directory} assertAccess={() => {}} assertSource={() => { if (sourceChanged) throw new Error('Source changed'); }}
    onIntent={() => {}} onSettled={async () => {}} onClose={() => {}} />);
  await flush();
  await act(async () => button('Hand off').click());
  sourceChanged = true;
  await act(async () => release(response(prepare.mock.calls[0]![0].operationId, 'ready')));
  expect(action).not.toHaveBeenCalled();
  await details();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Source changed');
}, 5000);

it('automatically prepares only the exact selected prefix after durable prompt preparation', async () => {
  const directory = new SessionDirectoryClient('http://localhost', undefined, 'host');
  const prefix = { kind: 'native_prefix' as const, turnId: 'turn-2', messageId: 'message-2' };
  const describe = vi.spyOn(directory, 'describeSuccession').mockResolvedValue(description);
  const order: string[] = [];
  const prepare = vi.spyOn(directory, 'prepareSuccession').mockImplementation(async input => { order.push('prepare'); return response(input.operationId, 'ready'); });
  const action = vi.spyOn(directory, 'successionAction').mockImplementation(async (_kind, id) => { order.push('commit'); return response(id, 'committed'); });
  await render(<SessionSuccessionDialog source={source} directory={directory} preparation={prefix} autoPrepare
    onPreparing={async () => { order.push('draft'); }} assertAccess={() => {}} assertSource={() => {}}
    onIntent={() => { order.push('intent'); }} onSettled={async () => { order.push('follow'); }} onClose={() => {}} />);
  await flush();
  expect(describe).toHaveBeenCalledWith('opencode', 'A', prefix);
  expect(prepare.mock.calls[0]?.[0]).toMatchObject({ preparation: prefix, providerId: 'opencode', nativeSessionId: 'A', expectedRevision: 4 });
  expect(order).toEqual(['draft', 'intent', 'prepare', 'commit', 'follow']);
  expect(action).toHaveBeenCalledOnce();
}, 5000);

it('performs no native preparation when retaining selected prompt bytes fails', async () => {
  const directory = new SessionDirectoryClient('http://localhost', undefined, 'host');
  vi.spyOn(directory, 'describeSuccession').mockResolvedValue(description);
  const prepare = vi.spyOn(directory, 'prepareSuccession');
  await render(<SessionSuccessionDialog source={source} directory={directory} autoPrepare
    preparation={{ kind: 'native_prefix', turnId: 'turn', messageId: 'message' }}
    onPreparing={async () => { throw new Error('Prompt bytes could not be retained.'); }}
    assertAccess={() => {}} assertSource={() => {}} onIntent={() => {}} onSettled={async () => {}} onClose={() => {}} />);
  await flush();
  expect(document.body.textContent).toContain('Prompt bytes could not be retained.');
  expect(prepare).not.toHaveBeenCalled();
}, 5000);
