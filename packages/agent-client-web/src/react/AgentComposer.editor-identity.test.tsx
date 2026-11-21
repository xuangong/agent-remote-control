// @vitest-environment jsdom
import { act, useState } from 'react';
import { beforeEach, expect, it } from 'vitest';
import { AgentComposer } from './AgentComposer.js';
import { render } from '../test/setup.js';
import { createReplicaState, remoteSessionState, type AgentReplicaState } from '@orchardworks/agent-client';

beforeEach(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

function stateFor(sessionId: string): AgentReplicaState {
  const state = createReplicaState();
  state.timeline.initialized = true;
  state.agent = { id: sessionId, providerId: 'test', createdAt: 'now', updatedAt: 'now', status: 'idle', activeTurn: null,
    capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false }, pendingInteractions: [],
    runtimeInfo: { providerId: 'test', sessionId, status: 'idle' } };
  return state;
}

it('keeps the editor, its focus and its selection when the session behind one draft owner changes from A to B', async () => {
  const binding = { scope: 'scope', key: 'view:primary' };
  let moveTo!: (sessionId: string) => void;
  function Harness() {
    const [sessionId, setSessionId] = useState('A'), [text, setText] = useState('Keep this focused selection');
    moveTo = setSessionId;
    const state = stateFor(sessionId);
    return <AgentComposer sessionState={remoteSessionState(state, 'ready')} state={state} draft={text} imageDraftBinding={binding} onDraftChange={setText} onSendMessage={async () => {}} />;
  }
  const view = await render(<Harness />);
  const editor = () => view.querySelector<HTMLElement>('[data-testid="prompt-input"]')!;
  const original = editor();
  await act(async () => original.focus());
  const text = original.firstChild!, range = document.createRange();
  range.setStart(text, 2); range.setEnd(text, 9);
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  expect(String(selection)).toBe('ep this');
  await act(async () => moveTo('B'));
  expect(editor()).toBe(original);
  expect(document.activeElement).toBe(original);
  expect(String(window.getSelection())).toBe('ep this');
  expect(editor().textContent).toBe('Keep this focused selection');
});

it('mounts a new editor when the draft owner changes', async () => {
  let move!: (key: string) => void;
  function Harness() {
    const [key, setKey] = useState('view:one'), [text, setText] = useState('one');
    move = setKey;
    const state = stateFor('A');
    return <AgentComposer sessionState={remoteSessionState(state, 'ready')} state={state} draft={text} imageDraftBinding={{ scope: 'scope', key }} onDraftChange={setText} onSendMessage={async () => {}} />;
  }
  const view = await render(<Harness />);
  const original = view.querySelector('[data-testid="prompt-input"]');
  await act(async () => move('view:two'));
  expect(view.querySelector('[data-testid="prompt-input"]')).not.toBe(original);
});
