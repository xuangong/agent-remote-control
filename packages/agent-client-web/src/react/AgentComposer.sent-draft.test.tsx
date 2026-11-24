// @vitest-environment jsdom
import { act, useState } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { AgentComposer } from './AgentComposer.js';
import { buildSessionFacts, CONTROL } from '@orchardworks/agent-client/testing';

const bots = [{ botId: 'b_1', name: 'Reviewer' }];
const commands = [{ id: 'side', name: 'side', kind: 'command' as const, description: 'Side' }];

/** A composer whose draft is kept by its page, as the workbench keeps it; `focusOther` shows another session, as opening a side does. */
async function setup(options: { command?: () => Promise<object>; ask?: () => Promise<void> }) {
  const facts = buildSessionFacts('ready', { snapshot: { status: 'idle' }, control: CONTROL.granted });
  const saved: Record<string, string> = { one: '', two: '' };
  let focusOther!: () => void, savedDraft!: () => Record<string, string>;
  function Page() {
    const [agent, setAgent] = useState('one');
    const [, bump] = useState(0);
    focusOther = () => act(() => setAgent('two'));
    savedDraft = () => saved;
    return <AgentComposer sessionKey={agent} state={facts.replica} sessionState={facts.session} onSendMessage={async () => {}}
      draft={saved[agent]} onDraftChange={text => { saved[agent] = text; bump(value => value + 1); }}
      mentions={{ bots, ask: options.ask ?? (async () => {}) }} consoleCommands={commands} onExecuteConsoleCommand={options.command ?? (async () => ({}))} />;
  }
  const container = await render(<Page />);
  const input = () => container.querySelector<HTMLTextAreaElement>('textarea')!;
  const type = (text: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), text);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
  const enter = () => act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
  return { type, enter, input, focusOther: () => focusOther(), saved: () => savedDraft() };
}

it('clears the saved draft of the session when /side was sent and the page already shows the side it opened', async () => {
  let finish!: () => void;
  const view = await setup({ command: () => new Promise(resolve => { finish = () => resolve({}); }) });
  await view.type('/side Is printf better than echo?');
  await view.enter();
  view.focusOther();
  await act(async () => finish());
  expect(view.saved()).toEqual({ one: '', two: '' });
});

it('clears the saved draft of the session when @bot was sent and the page already shows another session', async () => {
  let finish!: () => void;
  const view = await setup({ ask: () => new Promise<void>(resolve => { finish = resolve; }) });
  await view.type('@Reviewer is it ready?');
  await view.enter();
  view.focusOther();
  await act(async () => finish());
  expect(view.saved()).toEqual({ one: '', two: '' });
});

it('clears the draft when /side was sent', async () => {
  const command = vi.fn(async () => ({}));
  const view = await setup({ command });
  await view.type('/side Is printf better than echo?');
  await view.enter();
  expect(command).toHaveBeenCalledWith('side', expect.stringContaining('printf'));
  expect(view.saved()).toEqual({ one: '', two: '' });
  expect(view.input().value).toBe('');
});
