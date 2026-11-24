// @vitest-environment jsdom
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { AgentComposer } from './AgentComposer.js';
import { buildSessionFacts, CONTROL } from '@orchardworks/agent-client/testing';

const bots = [{ botId: 'b_1', name: 'Reviewer' }, { botId: 'b_2', name: 'Release Manager' }];

async function setup(ask = vi.fn(async () => {}), send = vi.fn(async () => {})) {
  const facts = buildSessionFacts('ready', { snapshot: { status: 'idle' }, control: CONTROL.granted });
  const container = await render(<AgentComposer sessionKey="agent-1" state={facts.replica} sessionState={facts.session} onSendMessage={send} mentions={{ bots, ask }} />);
  const input = () => container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!;
  const type = (text: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), text);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
  const key = (name: string) => act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })); });
  const options = () => [...container.querySelectorAll<HTMLElement>('[data-mention-picker] [role="option"]')];
  return { container, input, type, key, options, ask, send, submit: () => container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')! };
}

it('offers the account\'s bots after @ and narrows them as the name is typed', async () => {
  const view = await setup();
  await view.type('@');
  expect(view.options().map(option => option.textContent)).toEqual(['@Reviewer', '@Release Manager']);
  await view.type('@rel');
  expect(view.options().map(option => option.textContent)).toEqual(['@Release Manager']);
  await view.type('hello @');
  expect(view.options()).toEqual([]);
});

it('chooses a bot with the arrow keys and Enter or Tab, and closes on Escape without sending', async () => {
  const view = await setup();
  await view.type('@');
  await view.key('ArrowDown');
  expect(view.options().map(option => option.getAttribute('aria-selected'))).toEqual(['false', 'true']);
  await view.key('Enter');
  expect(view.input().value).toBe('@Release Manager ');
  expect(view.options()).toEqual([]);
  expect(view.send).not.toHaveBeenCalled();
  await view.type('@');
  await view.key('Tab');
  expect(view.input().value).toBe('@Reviewer ');
  await view.type('@');
  await view.key('Escape');
  expect(view.options()).toEqual([]);
  expect(view.input().value).toBe('@');
});

it('chooses a bot with the pointer', async () => {
  const view = await setup();
  await view.type('@re');
  await act(async () => view.options()[0]!.click());
  expect(view.input().value).toBe('@Reviewer ');
});

it('asks the mentioned bot, never writes to the session, and clears the draft', async () => {
  const view = await setup();
  await view.type('@reviewer is the release ready?');
  expect(view.submit().disabled).toBe(false);
  await act(async () => view.submit().click());
  expect(view.ask).toHaveBeenCalledWith(bots[0], 'is the release ready?');
  expect(view.send).not.toHaveBeenCalled();
  expect(view.input().value).toBe('');
  expect(view.container.textContent).toContain('Reviewer was asked');
});

it('sends Enter as the ask too, and keeps the draft and says why when the ask fails', async () => {
  const view = await setup(vi.fn(async () => { throw new Error('The bot is offline.'); }));
  await view.type('@Release Manager when does it ship?');
  await view.key('Enter');
  expect(view.ask).toHaveBeenCalledWith(bots[1], 'when does it ship?');
  expect(view.send).not.toHaveBeenCalled();
  expect(view.input().value).toBe('@Release Manager when does it ship?');
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('The bot is offline.');
});

it('sends an ordinary message when no known bot follows @', async () => {
  const view = await setup();
  await view.type('@nobody hello');
  await view.key('Enter');
  expect(view.send).toHaveBeenCalledWith('@nobody hello');
  expect(view.ask).not.toHaveBeenCalled();
});
