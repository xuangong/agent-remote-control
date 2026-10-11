import { act, useState } from 'react';
import { expect, it, vi } from 'vitest';
import { createReplicaState, type AgentReplicaState } from '@orchardworks/agent-remote-web';
import { AgentComposer } from '@orchardworks/agent-remote-web/react';
import { render } from '../test/setup.js';
import { SessionDirectoryClient } from '../directory-client.js';
import { useSuccessionContext } from './useSuccessionContext.js';

it('keeps offline successor images out of the waiting queue so its first text can send on reconnect', async () => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  const target = { controllerId: 'controller', providerId: 'test', nativeSessionId: 'B' }, source = { ...target, nativeSessionId: 'A' };
  const directory = new SessionDirectoryClient('https://relay.example/', (async () => Response.json({
    record: { operationId: 'handoff', roleId: 'role', expectedRevision: 1, from: source, to: target, phase: 'committed', committedRevision: 2, startedAt: 'now', updatedAt: 'now' },
    role: { id: 'role', revision: 2, origin: source, current: target, workspace: { controllerId: 'controller', canonicalCwd: '/work' } },
    context: { operationId: 'handoff', target, state: 'pending' },
  })) as typeof fetch, 'host');
  const state: AgentReplicaState = { ...createReplicaState(), timeline: { ...createReplicaState().timeline, initialized: true }, agent: {
    id: 'B', providerId: 'test', createdAt: 'now', updatedAt: 'now', status: 'idle', activeTurn: null, pendingInteractions: [],
    capabilities: { sendMessage: true, history: true, cancel: false, queueMessage: false, steer: false, readResource: false,
      interactions: { question: false, toolApproval: false, planApproval: false },
      imageInput: { mediaTypes: ['image/png'], maxImages: 8, maxImageBytes: 10485760, maxMessageBytes: 20971520 } },
    runtimeInfo: { providerId: 'test', sessionId: 'B', status: 'idle' },
  } };
  let connect!: (online: boolean) => void;
  const send = vi.fn(async () => {}), content = vi.fn(async () => {}), upload = vi.fn();
  function View() {
    const [online, setOnline] = useState(true); connect = setOnline;
    const context = useSuccessionContext({ directory, operationId: 'handoff', target, enabled: online });
    return <AgentComposer state={state} disabled={!online} recovering={!online} onSendMessage={send} onSendMessageContent={content} onUploadImage={upload}
      pendingFirstInputContext={context && context.state !== 'materialized' ? { state: context.state, onRetry: context.onRetry } : undefined} />;
  }
  const container = await render(<View />);
  await act(async () => connect(false));
  await act(async () => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files: [new File(['x'], 'x.png', { type: 'image/png' })], getData: () => '' } });
    container.querySelector('[role="textbox"]')!.dispatchEvent(event);
  });
  expect(container.querySelector('[data-image-id]')).toBeNull();
  expect(container.textContent).toContain('History from the previous session will be included with your first message.');
  await act(async () => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files: [], getData: (type: string) => type === 'text/plain' ? 'Continue with this first text' : '' } });
    container.querySelector('[role="textbox"]')!.dispatchEvent(event);
  });
  await act(async () => container.querySelector('[role="textbox"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  expect(container.querySelectorAll('[data-testid="pending-send"]')).toHaveLength(1);
  expect(send).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
  await act(async () => connect(true));
  expect(send).toHaveBeenCalledExactlyOnceWith('Continue with this first text');
  expect(content).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
  expect(container.querySelector('[data-testid="pending-send"]')).toBeNull();
}, 10000);
