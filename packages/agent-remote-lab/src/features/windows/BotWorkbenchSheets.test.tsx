import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BotWorkbenchSheets } from './BotWorkbenchSheets.js';

let root: Root | undefined; let host: HTMLElement | undefined;
// jsdom has no modal dialogs: opening one only marks it open.
Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); } });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); });
const bots = [{ botId: 'b1', name: 'Dango' }, { botId: 'b2', name: 'Pebbles' }];
async function show(sheet: 'new' | 'bind' | 'unbind', handlers: Partial<Parameters<typeof BotWorkbenchSheets>[0]> = {}) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const props = { sheet, bots, busy: false, onClose: vi.fn(), onFree: vi.fn(), onOpenBot: vi.fn(), onBind: vi.fn(), onUnbind: vi.fn(), ...handlers };
  await act(async () => root!.render(<BotWorkbenchSheets {...props} />));
  return props;
}
const button = (name: string) => [...document.querySelectorAll('button')].find(item => item.textContent === name)!;

it('offers a free workbench and each bot\'s workbench when a Window is made', async () => {
  const props = await show('new');
  await act(async () => button('Free workbench').click());
  expect(props.onFree).toHaveBeenCalledTimes(1);
  await act(async () => button('Pebbles').click());
  expect(props.onOpenBot).toHaveBeenCalledWith('b2');
});
it('binds to the bot that is chosen', async () => {
  const props = await show('bind');
  await act(async () => button('Dango').click());
  expect(props.onBind).toHaveBeenCalledWith('b1');
});
it('says what unbinding keeps before it unbinds', async () => {
  const props = await show('unbind');
  expect(document.body.textContent).toContain('The tiles you see stay');
  await act(async () => button('Unbind').click());
  expect(props.onUnbind).toHaveBeenCalledTimes(1);
});
it('says there are no bots rather than showing an empty list', async () => {
  await show('new', { bots: [] });
  expect(document.body.textContent).toContain('No bots yet.');
});
