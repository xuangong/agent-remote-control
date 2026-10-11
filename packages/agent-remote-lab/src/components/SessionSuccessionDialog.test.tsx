import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { SessionDirectoryClient, type SuccessionActionResult, type SuccessionDescription } from '../directory-client.js';
import { SessionSuccessionDialog } from './SessionSuccessionDialog.js';
const source = { hostId: 'host', agentId: 'agent', providerId: 'opencode', nativeSessionId: 'A', title: 'Original' };
const ref = { controllerId: 'controller', providerId: 'opencode', nativeSessionId: 'A' };
const description: SuccessionDescription = { role: { id: 'role', revision: 4, origin: ref, current: ref, workspace: { controllerId: 'controller', canonicalCwd: '/actual/workspace' } }, targets: [{ providerId: 'opencode', displayName: 'OpenCode' }], eligibility: { status: 'ready' } };
function response(operationId: string, phase: SuccessionActionResult['record']['phase']): SuccessionActionResult {
  return { role: description.role, record: { operationId, roleId: 'role', expectedRevision: 4, from: ref, targetProviderId: 'opencode', phase, startedAt: 'now', updatedAt: 'now' } };
}
function button(name: string) { return [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(item => item.textContent === name)!; }
const flush = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
beforeEach(() => { Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } }); });
async function setup() {
  const directory = new SessionDirectoryClient('http://localhost', undefined, 'host');
  const describe = vi.spyOn(directory, 'describeSuccession').mockResolvedValue(description);
  const prepare = vi.spyOn(directory, 'prepareSuccession');
  const action = vi.spyOn(directory, 'successionAction');
  const committed = vi.fn().mockResolvedValue(undefined), close = vi.fn(), intent = vi.fn();
  await render(<SessionSuccessionDialog source={source} directory={directory} assertAccess={() => {}} assertSource={() => {}} onIntent={intent} onCommitted={committed} onClose={close} />);
  await flush(); return { directory, describe, prepare, action, committed, close, intent };
}
it('uses authoritative revision and same operation for preparation and commitment', async () => {
  const state = await setup();
  state.prepare.mockImplementation(async input => response(input.operationId, 'ready'));
  state.action.mockImplementation(async (_action, id) => response(id, 'committed'));
  expect(document.querySelector('dialog')?.textContent).toContain('/actual/workspace');
  await act(async () => button('Prepare and hand off').click());
  const request = state.prepare.mock.calls[0]![0];
  expect(request).toMatchObject({ providerId: 'opencode', nativeSessionId: 'A', expectedRevision: 4, targetProviderId: 'opencode' });
  expect(state.intent).toHaveBeenCalledWith(request, false);
  expect(state.action).toHaveBeenCalledWith('commit', request.operationId);
  expect(state.committed).toHaveBeenCalledOnce();
}, 5000);
it('keeps an uncertain prepare identity and recovers it through status without creating again', async () => {
  const state = await setup();
  state.prepare.mockRejectedValue(new Error('Response lost'));
  await act(async () => button('Prepare and hand off').click());
  const id = state.prepare.mock.calls[0]![0].operationId;
  expect(button('Prepare and hand off')).toBeUndefined();
  state.action.mockResolvedValue(response(id, 'committed'));
  await act(async () => button('Check status').click());
  expect(state.action).toHaveBeenCalledWith('status', id); expect(state.prepare).toHaveBeenCalledOnce(); expect(state.committed).toHaveBeenCalledOnce();
}, 5000);
it('allows cancellation during held creation and ignores a late ready response', async () => {
  const state = await setup();
  let release!: (value: SuccessionActionResult) => void;
  state.prepare.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  await act(async () => button('Prepare and hand off').click());
  const id = state.prepare.mock.calls[0]![0].operationId;
  state.action.mockResolvedValue(response(id, 'cancelled'));
  await act(async () => button('Cancel Handoff').click());
  await act(async () => release(response(id, 'ready')));
  expect(state.action.mock.calls).toEqual([['cancel', id]]); expect(state.committed).not.toHaveBeenCalled();
  expect(document.querySelector('dialog')?.textContent).toContain('Handoff cancelled');
}, 5000);
it('blocks a Host-described unavailable source before preparing', async () => {
  const directory = new SessionDirectoryClient('http://localhost', undefined, 'host');
  vi.spyOn(directory, 'describeSuccession').mockResolvedValue({ ...description, eligibility: { status: 'blocked', code: 'busy', reason: 'Source has pending work.' } });
  const prepare = vi.spyOn(directory, 'prepareSuccession');
  await render(<SessionSuccessionDialog source={source} directory={directory} assertAccess={() => {}} assertSource={() => {}} onIntent={() => {}} onCommitted={async () => {}} onClose={() => {}} />);
  await flush(); expect(button('Prepare and hand off').disabled).toBe(true); expect(prepare).not.toHaveBeenCalled();
}, 5000);

it('resumes a saved uncertain operation without describing or preparing another source', async () => {
  const directory = new SessionDirectoryClient('http://localhost', undefined, 'host');
  const describe = vi.spyOn(directory, 'describeSuccession'), prepare = vi.spyOn(directory, 'prepareSuccession');
  const action = vi.spyOn(directory, 'successionAction').mockResolvedValue(response('saved-op', 'committed'));
  const committed = vi.fn().mockResolvedValue(undefined);
  await render(<SessionSuccessionDialog source={source} directory={directory} resume={{ operationId: 'saved-op', providerId: 'opencode', nativeSessionId: 'A', expectedRevision: 4, targetProviderId: 'opencode' }}
    assertAccess={() => {}} assertSource={() => { throw new Error('Original source is now historical'); }} onIntent={() => {}} onCommitted={committed} onClose={() => {}} />);
  await act(async () => button('Check status').click());
  expect(action).toHaveBeenCalledWith('status', 'saved-op'); expect(describe).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled(); expect(committed).toHaveBeenCalledOnce();
}, 5000);

it('does not dispatch preparation when retaining the operation fails', async () => {
  const directory = new SessionDirectoryClient('http://localhost', undefined, 'host');
  vi.spyOn(directory, 'describeSuccession').mockResolvedValue(description);
  const prepare = vi.spyOn(directory, 'prepareSuccession');
  await render(<SessionSuccessionDialog source={source} directory={directory} assertAccess={() => {}} assertSource={() => {}} onIntent={() => { throw new Error('Storage unavailable'); }} onCommitted={async () => {}} onClose={() => {}} />);
  await flush(); await act(async () => button('Prepare and hand off').click());
  expect(prepare).not.toHaveBeenCalled(); expect(button('Prepare and hand off')).toBeDefined(); expect(document.querySelector('[role="alert"]')?.textContent).toContain('Storage unavailable');
}, 5000);

it('never commits late preparation after a failed cancellation and retains the cancellation intent', async () => {
  const state = await setup();
  let release!: (value: SuccessionActionResult) => void;
  state.prepare.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  await act(async () => button('Prepare and hand off').click());
  const request = state.prepare.mock.calls[0]![0];
  state.action.mockRejectedValue(new Error('Cancel response lost'));
  await act(async () => button('Cancel Handoff').click());
  expect(state.intent).toHaveBeenLastCalledWith(request, true);
  await act(async () => release(response(request.operationId, 'ready')));
  expect(state.action.mock.calls).toEqual([['cancel', request.operationId]]);
  expect(button('Commit Handoff')).toBeUndefined();
  expect(document.querySelector('dialog')?.textContent).toContain('Cancellation requested');
}, 5000);

it('preserves saved cancellation intent after reload while consuming an already committed receipt', async () => {
  const directory = new SessionDirectoryClient('http://localhost', undefined, 'host');
  const action = vi.spyOn(directory, 'successionAction').mockResolvedValue(response('cancel-op', 'ready'));
  const committed = vi.fn().mockResolvedValue(undefined);
  await render(<SessionSuccessionDialog source={source} directory={directory} resume={{ operationId: 'cancel-op', providerId: 'opencode', nativeSessionId: 'A', expectedRevision: 4, targetProviderId: 'opencode' }} resumeCancellation
    assertAccess={() => {}} assertSource={() => {}} onIntent={() => {}} onCommitted={committed} onClose={() => {}} />);
  await act(async () => button('Check status').click());
  expect(button('Commit Handoff')).toBeUndefined(); expect(action.mock.calls).toEqual([['status', 'cancel-op']]);
  action.mockResolvedValue(response('cancel-op', 'committed'));
  await act(async () => button('Check status').click());
  expect(committed).toHaveBeenCalledOnce();
}, 5000);

it('lets the user hide a pre-enrollment rejection without clearing or replacing its uncertain operation', async () => {
  const state = await setup();
  state.prepare.mockRejectedValue(new Error('Stale revision rejected before enrollment'));
  await act(async () => button('Prepare and hand off').click());
  const request = state.prepare.mock.calls[0]![0];
  state.action.mockRejectedValue(new Error('succession_not_found'));
  for (const name of ['Check status', 'Reconcile', 'Cancel Handoff']) await act(async () => button(name).click());
  await act(async () => button('Hide Handoff').click());
  expect(state.close).toHaveBeenCalledWith(true);
  expect(state.prepare).toHaveBeenCalledOnce();
  expect(state.intent).toHaveBeenLastCalledWith(request, true);
}, 5000);
