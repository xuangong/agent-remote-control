// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, rerender } from '../test/setup.js';
import { AgentComposer } from './AgentComposer.js';
import { createReplicaState, type AgentReplicaState, remoteSessionState } from '@orchardworks/agent-client';
import { buildSessionFacts, CONTROL, SESSION_PRESENTATION_VECTORS, SESSION_CONNECTION_PATTERN } from '@orchardworks/agent-client/testing';


it.each(['connecting', 'catching_up', 'disconnected'] as const)('says no connection word while a local draft has no native binding (%s)', async connection => {
  const state: AgentReplicaState = { ...createReplicaState(), agent: {
    id: 'cached', providerId: 'test', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', status: 'running',
    activeTurn: { turnId: 'old-turn', startedAt: '2026-09-20T00:00:00Z' },
    capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: false },
    pendingInteractions: [], runtimeInfo: { providerId: 'test', status: 'running' },
  } };
  const send = vi.fn(), cancel = vi.fn();
  for (const cached of [state, undefined]) {
    const container = await render(<AgentComposer state={cached} sessionState={remoteSessionState(undefined, connection)} draftOnly draft="Local draft" onSendMessage={send} onCancel={cancel} />);
    expect(container.querySelector<HTMLElement>('[data-testid="agent-activity-label"]')?.hidden).toBe(true);
    expect(container.textContent).not.toMatch(SESSION_CONNECTION_PATTERN);
    expect(container.textContent).not.toContain('Open or attach to an Agent first.');
    expect(container.querySelector<HTMLButtonElement>('[data-testid="cancel-submit"]')?.hidden).toBe(true);
    expect(container.querySelector('[data-testid="turn-elapsed"]')).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')).toMatchObject({ value: 'Local draft', disabled: false });
    const submit = container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!;
    expect(submit.disabled).toBe(true);
    await act(async () => submit.click());
    expect(send).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
  }
});

it.each([false, true])('does not present Ready for an unbound draft while access checking is %s', async controlChecking => {
  const session = { ...remoteSessionState(undefined, 'ready'), controlChecking };
  const container = await render(<AgentComposer draftOnly sessionState={session} draft="Local draft" />);
  expect(container.querySelector<HTMLElement>('[data-testid="agent-activity-label"]')?.hidden).toBe(true);
  expect(container.textContent).not.toMatch(SESSION_CONNECTION_PATTERN);
  expect(container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(true);
});

describe('the composer follows composerAvailability, row by row', () => {
  it.each(SESSION_PRESENTATION_VECTORS.map(row => [row.name, row] as const))('%s', async (_name, row) => {
    const container = await render(<AgentComposer sessionKey="agent-1" state={row.facts.replica} sessionState={row.facts.session} host={row.facts.host} onSendMessage={vi.fn()} />);
    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!;
    expect(input.disabled || input.readOnly).toBe(row.composer.input === 'disabled');
    expect(container.textContent).not.toMatch(SESSION_CONNECTION_PATTERN);
  });
});

it('takes a message typed before the first Snapshot, says Sending at once, keeps focus, and sends it once when the session is ready', async () => {
  const send = vi.fn(async () => {});
  const opening = buildSessionFacts('connecting', undefined);
  const restored = buildSessionFacts('catching_up', { snapshot: { status: 'idle' }, restored: true, control: CONTROL.checking });
  const ready = buildSessionFacts('ready', { snapshot: { status: 'idle' }, control: CONTROL.granted });
  const view = (facts: typeof ready) => <AgentComposer sessionKey="agent-1" state={facts.replica} sessionState={facts.session} onSendMessage={send} />;
  const container = await render(view(opening));
  const input = container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!;
  expect(input.disabled).toBe(false);
  input.focus();
  const type = (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await type('Typed while opening');
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
  const pending = container.querySelectorAll('[data-testid="pending-send"]');
  expect(pending).toHaveLength(1);
  expect(pending[0]!.textContent).toContain('Sending');
  expect(input.value).toBe('');
  expect(document.activeElement).toBe(input);
  await type(' next');
  expect(input.value).toBe(' next');
  expect(send).not.toHaveBeenCalled();
  // The Snapshot arrives from the device before the session is ready: the model controls show, the send still waits.
  await rerender(container, view(restored));
  expect(container.querySelector('[data-testid="session-model-button"]')).not.toBeNull();
  expect(send).not.toHaveBeenCalled();
  await rerender(container, view(ready));
  await act(async () => {});
  expect(send).toHaveBeenCalledExactlyOnceWith('Typed while opening');
  expect(input.value).toBe(' next');
  expect(container.textContent).not.toMatch(SESSION_CONNECTION_PATTERN);
});

it('allows cached-session drafts while synchronizing but waits for readiness to send or execute commands', async () => {
  const state: AgentReplicaState = { ...createReplicaState(), timeline: { ...createReplicaState().timeline, initialized: true }, agent: {
    id: 'cached', providerId: 'test', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', status: 'idle', activeTurn: null,
    capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false },
    pendingInteractions: [], runtimeInfo: { providerId: 'test', status: 'idle' },
  } };
  let resolve!: () => void;
  const send = vi.fn(() => new Promise<void>(done => { resolve = done; }));
  const command = vi.fn(async () => ({}));
  const draft = vi.fn();
  const view = (disabled: boolean, current = state) => <AgentComposer sessionState={remoteSessionState(current, (disabled) ? 'connecting' : 'ready')} state={current} onDraftChange={draft}
    onSendMessage={send} consoleCommands={[{ id: 'side', name: 'side', kind: 'command', description: 'Open a side conversation' }]} onExecuteConsoleCommand={command} />;
  const container = await render(view(true));
  const input = container.querySelector('textarea')!;
  const type = (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const enter = () => act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  expect(input.disabled).toBe(false);
  expect(input.placeholder).toBe('Message…');
  expect(container.querySelector('[data-testid="agent-activity"]')?.getAttribute('data-active')).toBe('false');
  expect(container.querySelector('[data-testid="agent-activity-label"]')?.textContent).toBe('Ready');
  await type('Draft during synchronization');
  expect(draft).toHaveBeenLastCalledWith('Draft during synchronization');
  expect(container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(false);
  await enter();
  expect(send).not.toHaveBeenCalled();
  await type('/side');
  await enter();
  expect(command).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Open chat commands"]')!.disabled).toBe(true);
  await type('Draft during synchronization');
  await rerender(container, view(false));
  expect(input.placeholder).toBe('Message…');
  expect(input.value).toBe('Draft during synchronization');
  expect(send).toHaveBeenCalledExactlyOnceWith('Draft during synchronization');
  expect(input.disabled).toBe(false);
  await act(async () => resolve());
  expect(input.disabled).toBe(false);
  expect(input.value).toBe('Draft during synchronization');
  await rerender(container, view(true, { ...state, agent: { ...state.agent!, capabilities: { ...state.agent!.capabilities, sendMessage: false } } }));
  expect(input.disabled).toBe(true);
  await rerender(container, view(true, createReplicaState()));
  expect(input.disabled).toBe(true);
});

it('presents a failed command through its renderer and keeps the message for other failures', async () => {
  const state: AgentReplicaState = { ...createReplicaState(), timeline: { ...createReplicaState().timeline, initialized: true }, agent: {
    id: 'commands', providerId: 'test', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', status: 'idle', activeTurn: null,
    capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false },
    pendingInteractions: [], runtimeInfo: { providerId: 'test', status: 'idle' },
  } };
  const signIn = Object.assign(new Error('Sign in again before changing session permissions.'), { code: 'reauthentication_required' });
  const command = vi.fn().mockRejectedValueOnce(signIn).mockRejectedValueOnce(new Error('The fork could not connect.'));
  const renderCommandError = vi.fn((error: unknown) => (error as { code?: string }).code === 'reauthentication_required' ? <a href="/sign-in">Sign in again</a> : undefined);
  const container = await render(<AgentComposer sessionState={remoteSessionState(state, 'ready')} state={state} draft="/fork keep going" onSendMessage={vi.fn()} renderCommandError={renderCommandError}
    consoleCommands={[{ id: 'fork', name: 'fork', kind: 'command', description: 'Fork' }]} onExecuteConsoleCommand={command} />);
  const submit = () => act(async () => container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.click());
  await submit();
  expect(command).toHaveBeenLastCalledWith('fork', ' keep going');
  expect(renderCommandError).toHaveBeenLastCalledWith(signIn);
  expect(container.querySelector('.agent-composer-note a')?.textContent).toBe('Sign in again');
  expect(container.textContent).not.toContain('Sign in again before changing session permissions.');
  expect(container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!.value).toBe('/fork keep going');
  await submit();
  expect(container.querySelector('.agent-composer-note a')).toBeNull();
  expect(container.querySelector('.agent-composer-note[role="alert"]')?.textContent).toBe('The fork could not connect.');
});

it('keeps image atoms through reconnect and sends ordered image-only content with digest identity', async () => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  const state: AgentReplicaState = { ...createReplicaState(), timeline: { ...createReplicaState().timeline, initialized: true }, agent: {
    id: 'images', providerId: 'test', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', status: 'idle', activeTurn: null,
    capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: true, imageInput: { mediaTypes: ['image/png'], maxImages: 8, maxImageBytes: 10485760, maxMessageBytes: 20971520 } },
    pendingInteractions: [], runtimeInfo: { providerId: 'test', status: 'idle' },
  } };
  const attachment = { attachmentId: 'image-a', sha256: 'a'.repeat(64), mediaType: 'image/png' as const, byteLength: 1, imageDimensions: { width: 1, height: 1 } };
  const upload = vi.fn(async () => attachment);
  const send = vi.fn(async () => {});
  const command = vi.fn(async () => ({}));
  const view = (disabled: boolean) => <AgentComposer sessionState={remoteSessionState(state, (disabled) ? 'connecting' : 'ready')} state={state} onSendMessageContent={send} onUploadImage={disabled ? undefined : upload} consoleCommands={[{ id: 'side', name: 'side', kind: 'command', description: 'Side' }]} onExecuteConsoleCommand={command} />;
  const container = await render(view(true));
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { files: [new File(['x'], 'x.png', { type: 'image/png' })], getData: () => '' } });
  await act(async () => container.querySelector('[role="textbox"]')!.dispatchEvent(paste));
  expect(container.querySelector('[data-image-id]')?.textContent).toBe('[image #1]');
  expect(upload).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(false);
  await rerender(container, view(false));
  expect(upload).toHaveBeenCalledTimes(1);
  expect(container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(false);
  await act(async () => container.querySelector('[role="textbox"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  expect(send).toHaveBeenCalledWith([{ type: 'image', attachmentId: 'image-a', label: 'image #1' }], { imageDigests: { 'image-a': 'a'.repeat(64) } });
  expect(container.querySelector('[data-image-id]')).toBeNull();
  const commandPaste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(commandPaste, 'clipboardData', { value: { files: [], getData: (type: string) => type === 'text/plain' ? '/side' : '' } });
  await act(async () => container.querySelector('[role="textbox"]')!.dispatchEvent(commandPaste));
  await act(async () => container.querySelector('[role="textbox"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  expect(command).toHaveBeenCalledWith('side', '');
  expect(container.querySelector('[role="textbox"]')?.textContent).toBe('');
});

it('offers explicit upload retry after the Host rejects an expired attachment', async () => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value() { this.open = true; } },
    close: { configurable: true, value() { this.open = false; } },
  });
  Object.defineProperties(URL, {
    createObjectURL: { configurable: true, value: () => 'blob:test-image' },
    revokeObjectURL: { configurable: true, value: () => {} },
  });
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  const state: AgentReplicaState = { ...createReplicaState(), timeline: { ...createReplicaState().timeline, initialized: true }, agent: {
    id: 'expired-image', providerId: 'test', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', status: 'idle', activeTurn: null,
    capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: true, imageInput: { mediaTypes: ['image/png'], maxImages: 8, maxImageBytes: 10485760, maxMessageBytes: 20971520 } },
    pendingInteractions: [], runtimeInfo: { providerId: 'test', status: 'idle' },
  } };
  const attachment = { attachmentId: 'expired', sha256: 'a'.repeat(64), mediaType: 'image/png' as const, byteLength: 1, imageDimensions: { width: 1, height: 1 } };
  const upload = vi.fn(async (_blob: Blob, _uploadId: string) => attachment);
  const send = vi.fn().mockRejectedValueOnce(Object.assign(new Error('Attachment expired.'), { code: 'invalid_image_input' })).mockResolvedValue(undefined);
  const container = await render(<AgentComposer sessionState={remoteSessionState(state, 'ready')} state={state} onSendMessageContent={send} onUploadImage={upload} />);
  const editor = container.querySelector('[role="textbox"]')!;
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { files: [new File(['x'], 'x.png', { type: 'image/png' })], getData: () => '' } });
  await act(async () => editor.dispatchEvent(paste));
  await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  expect(container.querySelector('[data-image-id]')?.getAttribute('data-state')).toBe('failed');
  expect(container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
  await act(async () => {
    (editor as HTMLElement).focus();
    document.getSelection()!.collapse(editor, 1);
    document.dispatchEvent(new Event('selectionchange'));
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', keyCode: 37, bubbles: true, cancelable: true })));
  await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  const retry = Array.from(document.querySelectorAll('dialog button')).find(button => button.textContent === 'Retry')! as HTMLButtonElement;
  expect(retry).toBeDefined();
  upload.mockResolvedValue({ ...attachment, attachmentId: 'replacement' });
  await act(async () => retry.click());
  expect(upload.mock.calls[1]?.[1]).not.toBe(upload.mock.calls[0]?.[1]);
  expect(send).toHaveBeenCalledTimes(1);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close image preview"]')!.click());
  await act(async () => {
    const submit = container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!;
    submit.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    submit.click();
  });
  expect(send.mock.calls[1]?.[0]).toEqual([{ type: 'image', attachmentId: 'replacement', label: 'image #1' }]);
});

it('takes a send over a state restored from the device, says Sending, and sends it only once the state is confirmed', async () => {
  const base = createReplicaState();
  const agent = { id: 'a', providerId: 'test', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', status: 'idle' as const, activeTurn: null,
    capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false }, pendingInteractions: [], runtimeInfo: { providerId: 'test', status: 'idle' as const } };
  const restored: AgentReplicaState = { ...base, agent, timeline: { ...base.timeline, initialized: true, restoredFromDevice: true } };
  const confirmed: AgentReplicaState = { ...restored, timeline: { ...restored.timeline, restoredFromDevice: undefined } };
  const send = vi.fn(async () => {});
  const container = await render(<AgentComposer state={restored} sessionState={remoteSessionState(restored, 'catching_up')} draft="Typed early" onSendMessage={send} />);
  expect(container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')).toMatchObject({ value: 'Typed early', disabled: false });
  const submit = () => container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!;
  expect(submit().disabled).toBe(false);
  await act(async () => submit().click());
  expect(container.querySelector('[data-testid="pending-send"]')?.textContent).toContain('Sending');
  expect(send).not.toHaveBeenCalled();
  await rerender(container, <AgentComposer state={confirmed} sessionState={remoteSessionState(confirmed, 'ready')} draft="" onSendMessage={send} />);
  await act(async () => {});
  expect(send).toHaveBeenCalledExactlyOnceWith('Typed early');
});

it('sends a message at once through the queue, keeps the editor enabled and focused, and keeps what is typed while it is on its way', async () => {
  let acknowledge!: () => void;
  const send = vi.fn(() => new Promise<void>(resolve => { acknowledge = resolve; }));
  const ready = buildSessionFacts('ready', { snapshot: { status: 'idle' }, control: CONTROL.granted });
  const container = await render(<AgentComposer sessionKey="agent-1" state={ready.replica} sessionState={ready.session} onSendMessage={send} />);
  const input = container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!;
  input.focus();
  const type = (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await type('Sent now');
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
  expect(send).toHaveBeenCalledExactlyOnceWith('Sent now');
  // On its way, the message is the conversation's outgoing row; the composer shows no second Sending.
  expect(container.querySelector('[data-testid="pending-send"]')).toBeNull();
  expect(input.disabled).toBe(false);
  expect(document.activeElement).toBe(input);
  await type('Typed meanwhile');
  await act(async () => acknowledge());
  expect(input.value).toBe('Typed meanwhile');
  expect(document.activeElement).toBe(input);
});

function readyAgent(imageInput: boolean): AgentReplicaState {
  return { ...createReplicaState(), timeline: { ...createReplicaState().timeline, initialized: true }, agent: {
    id: 'return-key', providerId: 'test', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', status: 'idle', activeTurn: null,
    capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false, ...(imageInput ? { imageInput: { mediaTypes: ['image/png'], maxImages: 8, maxImageBytes: 10485760, maxMessageBytes: 20971520 } } : {}) },
    pendingInteractions: [], runtimeInfo: { providerId: 'test', status: 'idle' },
  } };
}

describe('settings placement', () => {
  const view = (settings?: 'inline' | 'none') => {
    const state = readyAgent(false);
    return <AgentComposer sessionState={remoteSessionState(state, 'ready')} state={state} settings={settings} onSendMessage={vi.fn()} sessionControls={<span data-testid="extra-control" />} />;
  };

  it('keeps the model and permission controls inline by default', async () => {
    const container = await render(view());
    expect(container.querySelector('[data-testid="session-model-button"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="extra-control"]')).not.toBeNull();
  });

  it('leaves the settings out but keeps the actions and send', async () => {
    const container = await render(view('none'));
    expect(container.querySelector('[data-testid="session-model-button"]')).toBeNull();
    expect(container.querySelector('[data-testid="extra-control"]')).toBeNull();
    expect(container.querySelector('[aria-label="Open chat commands"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="prompt-submit"]')).not.toBeNull();
  });
});

describe.each([['textarea', false], ['editor', true]] as const)('Return key in the %s', (_name, rich) => {
  const stubPointer = (coarse: boolean) => vi.stubGlobal('matchMedia', (query: string) => ({ matches: coarse && query === '(pointer: coarse)' }));
  afterEach(() => vi.unstubAllGlobals());
  const mount = async () => {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
    const state = readyAgent(rich);
    const send = vi.fn().mockResolvedValue(undefined), sendContent = vi.fn().mockResolvedValue(undefined);
    const container = await render(<AgentComposer sessionState={remoteSessionState(state, 'ready')} state={state} draft="Hello" onSendMessage={send} onSendMessageContent={sendContent} onUploadImage={rich ? vi.fn() : undefined} />);
    const input = container.querySelector<HTMLElement>('[data-testid="prompt-input"]')!;
    const sent = () => send.mock.calls.length + sendContent.mock.calls.length;
    const press = async (init: KeyboardEventInit) => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
      await act(async () => { input.dispatchEvent(event); });
      return event;
    };
    return { container, input, sent, press };
  };

  it('sends on Return and hints send under a fine pointer', async () => {
    stubPointer(false);
    const { input, sent, press } = await mount();
    expect(input.getAttribute('enterkeyhint')).toBe('send');
    await press({});
    expect(sent()).toBe(1);
  });

  it('makes a new line on Return under a coarse pointer', async () => {
    stubPointer(true);
    const { input, sent, press } = await mount();
    expect(input.getAttribute('enterkeyhint')).toBe('enter');
    const plain = await press({});
    expect(sent()).toBe(0);
    if (rich) { expect(plain.defaultPrevented).toBe(true); expect(input.textContent).toContain('\n'); }
    else expect(plain.defaultPrevented).toBe(false);
  });

  it.each([['Ctrl', { ctrlKey: true }], ['Command', { metaKey: true }]])('sends on %s-Return under a coarse pointer', async (_key, init) => {
    stubPointer(true);
    const { sent, press } = await mount();
    await press(init);
    expect(sent()).toBe(1);
  });

  it('sends with the button under a coarse pointer', async () => {
    stubPointer(true);
    const { container, sent } = await mount();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.click());
    expect(sent()).toBe(1);
  });
});
