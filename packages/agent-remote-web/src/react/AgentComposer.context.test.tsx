import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { createReplicaState } from '../replica/reducer.js';
import type { AgentReplicaState } from '../replica/types.js';
import { render, rerender } from '../test/setup.js';
import { AgentComposer, type AgentComposerProps } from './AgentComposer.js';

const hint = 'History from the previous session will be included with your first message.';
const state: AgentReplicaState = { ...createReplicaState(), timeline: { ...createReplicaState().timeline, initialized: true }, agent: {
  id: 'successor', providerId: 'test', createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z', status: 'idle', activeTurn: null,
  capabilities: { history: true, sendMessage: true, queueMessage: true, steer: false, cancel: false, readResource: true,
    imageInput: { mediaTypes: ['image/png'], maxImages: 8, maxImageBytes: 10485760, maxMessageBytes: 20971520 } },
  pendingInteractions: [], runtimeInfo: { providerId: 'test', status: 'idle' },
} };
const running: AgentReplicaState = { ...state, agent: { ...state.agent!, status: 'running', activeTurn: { turnId: 'native-turn', startedAt: '2026-10-11T00:00:01Z' } } };
beforeEach(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

async function setup(props: Partial<AgentComposerProps> = {}) {
  const upload = vi.fn(async () => ({ attachmentId: 'ready-image', sha256: 'a'.repeat(64), mediaType: 'image/png' as const, byteLength: 1 }));
  const text = vi.fn(async () => {}), content = vi.fn(async () => {});
  let current: AgentComposerProps = { state, onUploadImage: upload, onSendMessage: text, onSendMessageContent: content, ...props };
  const container = await render(<AgentComposer {...current} />);
  const update = async (patch: Partial<AgentComposerProps>) => { current = { ...current, ...patch }; await rerender(container, <AgentComposer {...current} />); };
  const paste = async (text = '', images = false) => act(async () => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files: images ? [new File(['x'], 'x.png', { type: 'image/png' })] : [], getData: (type: string) => type === 'text/plain' ? text : '' } });
    container.querySelector('[role="textbox"]')!.dispatchEvent(event);
  });
  const enter = () => act(async () => container.querySelector('[role="textbox"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  return { container, update, paste, enter, upload, text, content };
}

it('keeps the first-input hint after text acceptance and native activity until authoritative context confirmation', async () => {
  const f = await setup({ pendingFirstInputContext: { state: 'pending' } });
  expect(f.container.textContent).toContain(hint);
  await f.paste('Continue the work'); await f.enter();
  expect(f.text).toHaveBeenCalledExactlyOnceWith('Continue the work');
  expect(f.container.querySelector('[role="textbox"]')!.textContent).toBe('');
  expect(f.container.textContent).toContain(hint);
  await f.update({ state: running });
  expect(f.container.textContent).toContain(hint);
  expect(f.container.querySelector<HTMLButtonElement>('[data-testid="queue-submit"]')!.disabled).toBe(true);
  await f.update({ state, pendingFirstInputContext: undefined });
  expect(f.container.textContent).not.toContain(hint);
}, 10000);

it('blocks new image selection and paste while allowing text-only editing and immediate delivery', async () => {
  const f = await setup({ pendingFirstInputContext: { state: 'pending' } });
  expect(f.container.querySelector<HTMLButtonElement>('[aria-label="Add images"]')!.disabled).toBe(true);
  await f.paste('Keep this draft');
  await f.paste('', true);
  expect(f.container.querySelector('[role="textbox"]')!.textContent).toBe('Keep this draft');
  expect(f.container.querySelector('[data-image-id]')).toBeNull();
  expect(f.container.textContent).toContain('The first message must contain only text.');
  expect(f.upload).not.toHaveBeenCalled();
  await f.enter();
  expect(f.text).toHaveBeenCalledExactlyOnceWith('Keep this draft');
  expect(f.content).not.toHaveBeenCalled();
  expect(f.container.querySelector('[role="textbox"]')!.textContent).toBe('');
}, 10000);

it('clears accepted text in a retained rich editor when the provider has no image input', async () => {
  const f = await setup({ state: { ...state, agent: { ...state.agent!, capabilities: { ...state.agent!.capabilities, imageInput: undefined } } },
    imageDraftBinding: { scope: '', key: 'retained-text-editor' },
    imageRecipient: { identity: 'test/successor', lifetime: {}, isCurrent: () => true } });
  await f.paste('Send without images'); await f.enter();
  expect(f.text).toHaveBeenCalledExactlyOnceWith('Send without images');
  expect(f.container.querySelector('[role="textbox"]')!.textContent).toBe('');
  expect(f.upload).not.toHaveBeenCalled();
}, 10000);

it.each(['text', 'image', 'recipient'] as const)('preserves a newer %s edit when a text send completes late', async change => {
  let finish!: () => void;
  const accepted = new Promise<void>(resolve => { finish = resolve; });
  const recipient = { identity: 'test/successor', lifetime: {}, isCurrent: () => true };
  const f = await setup({ imageDraftBinding: { scope: '', key: `retained-late-${change}` }, imageRecipient: recipient,
    onSendMessage: async () => accepted });
  await f.paste('Sending text'); await f.enter();
  if (change === 'text') await f.update({ draft: 'New draft' });
  if (change === 'image') {
    await f.update({ sessionKey: 'next-recipient', imageRecipient: { identity: 'test/next', lifetime: {}, isCurrent: () => true } });
    await f.paste('', true);
  }
  if (change === 'recipient') await f.update({ imageRecipient: { ...recipient, lifetime: {} } });
  const draft = f.container.querySelector('[role="textbox"]')!.textContent;
  const image = f.container.querySelector('[data-image-id]')?.getAttribute('data-image-id');
  if (change === 'image') expect(image).toBeDefined();
  await act(async () => finish());
  expect(f.container.querySelector('[role="textbox"]')!.textContent).toBe(draft);
  if (change === 'image') expect(f.container.querySelector('[data-image-id]')?.getAttribute('data-image-id')).toBe(image);
}, 10000);

it('clears an unchanged text edit after upload availability changes during delivery', async () => {
  let finish!: () => void;
  const accepted = new Promise<void>(resolve => { finish = resolve; });
  const f = await setup({ pendingFirstInputContext: { state: 'pending' }, onSendMessage: async () => accepted });
  await f.paste('First message'); await f.enter();
  await f.update({ pendingFirstInputContext: undefined });
  await act(async () => finish());
  expect(f.container.querySelector('[role="textbox"]')!.textContent).toBe('');
}, 10000);

it('preserves existing images while pending and resumes upload only after authoritative context confirmation', async () => {
  const f = await setup({ disabled: true });
  await f.paste('Retained text'); await f.paste('', true);
  const imageId = f.container.querySelector('[data-image-id]')!.getAttribute('data-image-id');
  await f.update({ disabled: false, pendingFirstInputContext: { state: 'pending' } });
  expect(f.upload).not.toHaveBeenCalled();
  expect(f.container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(true);
  await f.enter();
  expect(f.text).not.toHaveBeenCalled(); expect(f.content).not.toHaveBeenCalled();
  expect(f.container.querySelector('[data-image-id]')!.getAttribute('data-image-id')).toBe(imageId);
  expect(f.container.querySelector('[role="textbox"]')!.textContent).toContain('Retained text');
  expect(f.container.textContent).toContain('The first message must contain only text.');
  await f.update({ pendingFirstInputContext: undefined });
  expect(f.container.textContent).not.toContain('The first message must contain only text.');
  expect(f.upload).toHaveBeenCalledTimes(1);
  await f.enter();
  expect(f.content).toHaveBeenCalledExactlyOnceWith([{ type: 'text', text: 'Retained text' }, { type: 'image', attachmentId: 'ready-image', label: 'image #1' }], { imageDigests: { 'ready-image': 'a'.repeat(64) } });
  expect(f.container.querySelector('[data-image-id]')).toBeNull();
}, 10000);

it('keeps handoff drafts editable without sending or enrolling a reconnect queue while mutations are blocked', async () => {
  const f = await setup({ mutationBlocked: true, state: running, disabled: true, recovering: true });
  await f.paste('Keep editing through handoff');
  await f.enter();
  expect(f.container.querySelector('[role="textbox"]')!.textContent).toBe('Keep editing through handoff');
  expect(f.container.querySelector('[data-testid="pending-send"]')).toBeNull();
  expect(f.text).not.toHaveBeenCalled();
  await f.paste('', true);
  expect(f.upload).not.toHaveBeenCalled();
  await f.update({ disabled: false, recovering: false });
  await f.enter();
  expect(f.content).not.toHaveBeenCalled(); expect(f.upload).not.toHaveBeenCalled();
  await f.update({ mutationBlocked: false });
  expect(f.upload).toHaveBeenCalledTimes(1);
  await f.enter();
  expect(f.content).toHaveBeenCalledTimes(1);
}, 10000);

it('keeps confirmed settings visible and native mutations disabled without reporting disconnection during handoff', async () => {
  const select = vi.fn(async () => {}), execute = vi.fn(async () => ({})), cancel = vi.fn(async () => {});
  const current: AgentReplicaState = { ...running, agent: { ...running.agent!, capabilities: { ...running.agent!.capabilities, commands: true, cancel: true, sessionSettings: true },
    runtimeInfo: { ...running.agent!.runtimeInfo, settings: [{ id: 'model', category: 'model', label: 'Model', value: 'current', options: [{ value: 'current', label: 'Current model' }, { value: 'next', label: 'Other model' }], mutable: true, scope: 'session' }] } } };
  const f = await setup({ state: current, mutationBlocked: true, onSetSessionSetting: select, onExecuteCommand: execute, onCancel: cancel });
  await act(async () => f.container.querySelector<HTMLButtonElement>('[data-testid="session-model-button"]')!.click());
  expect(f.container.querySelector('select')!.value).toBe('current');
  expect(f.container.querySelector('select')!.disabled).toBe(true);
  expect(f.container.textContent).not.toContain('Disconnected.');
  expect(f.container.querySelector<HTMLButtonElement>('[data-testid="cancel-submit"]')!.disabled).toBe(true);
  expect(f.container.querySelector<HTMLButtonElement>('[aria-label="Open chat commands"]')!.disabled).toBe(true);
  expect(select).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
}, 10000);

it('reports retained waiting messages and unconfirmed delivery until the user resolves the queue', async () => {
  const changes: number[] = [];
  const f = await setup({ disabled: true, recovering: true, onPendingInputChange: count => changes.push(count),
    onSendMessage: async () => { throw new Error('Delivery is not confirmed.'); } });
  expect(changes.at(-1)).toBe(0);
  await f.paste('First pending message'); await f.enter();
  await f.paste('Second pending message'); await f.enter();
  expect(changes.at(-1)).toBe(2);
  await f.update({ disabled: false, recovering: false });
  expect(f.container.querySelector('[data-testid="pending-send"]')!.getAttribute('data-state')).toBe('error');
  expect(changes.at(-1)).toBe(2);
  await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Dismiss message after checking delivery"]')!.click());
  expect(changes.at(-1)).toBe(1);
  await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Dismiss message after checking delivery"]')!.click());
  expect(changes.at(-1)).toBe(0);
}, 10000);

it('reports an in-flight message but does not count a local console command as pending input', async () => {
  const changes: number[] = [];
  let finishMessage!: () => void, finishCommand!: () => void, commandEntered = false;
  const message = new Promise<void>(resolve => { finishMessage = resolve; });
  const command = new Promise<void>(resolve => { finishCommand = resolve; });
  const f = await setup({ onPendingInputChange: count => changes.push(count), onSendMessage: async () => message,
    consoleCommands: [{ id: 'local', name: 'local', kind: 'command', description: 'Local view command' }],
    onExecuteConsoleCommand: async () => { commandEntered = true; await command; return {}; } });
  await f.paste('Send this message'); await f.enter();
  expect(changes.at(-1)).toBe(1);
  await act(async () => finishMessage());
  expect(changes.at(-1)).toBe(0);
  await f.paste('/local'); await f.enter();
  expect(commandEntered).toBe(true);
  expect(changes.at(-1)).toBe(0);
  await act(async () => finishCommand());
  expect(changes.at(-1)).toBe(0);
}, 10000);

it('reports pending inputs for the selected session while retaining the previous session queue', async () => {
  const original: number[] = [], other: number[] = [];
  const f = await setup({ sessionKey: 'original', disabled: true, recovering: true, onPendingInputChange: count => original.push(count) });
  await f.paste('Keep this with the original session'); await f.enter();
  expect(original.at(-1)).toBe(1);
  await f.update({ sessionKey: 'other', onPendingInputChange: count => other.push(count) });
  expect(other.at(-1)).toBe(0);
  expect(f.container.querySelector('[data-testid="pending-send"]')).toBeNull();
  await f.update({ sessionKey: 'original', onPendingInputChange: count => original.push(count) });
  expect(original.at(-1)).toBe(1);
  expect(f.container.querySelector('[data-testid="pending-send"]')?.textContent).toContain('Keep this with the original session');
  expect(f.text).not.toHaveBeenCalled();
}, 10000);

it.each(['dispatching', 'accepted', 'unknown', 'unavailable'] as const)('lets the user recheck %s context after automatic polling stops', async state => {
  const retry = vi.fn();
  const f = await setup({ pendingFirstInputContext: { state, onRetry: retry } });
  const button = [...f.container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Check again');
  expect(button).toBeDefined();
  await act(async () => button!.click());
  expect(retry).toHaveBeenCalledOnce();
  expect(f.container.querySelector<HTMLButtonElement>('[aria-label="Add images"]')!.disabled).toBe(true);
}, 10000);
