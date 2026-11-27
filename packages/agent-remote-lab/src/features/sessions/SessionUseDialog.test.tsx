import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { render } from '../../test/setup.js';
import { SessionUseDialog } from './SessionUseDialog.js';

beforeEach(() => { Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn() }); });

const base = { title: 'Fix the build', providerId: 'claude', name: 'Fix the build', phase: 'confirm' as const, onName: vi.fn(), onConfirm: vi.fn(), onTakeOver: vi.fn(), onCancel: vi.fn() };
const button = (label: string) => [...document.querySelectorAll('dialog button')].find(item => item.textContent === label) as HTMLButtonElement;

it('asks to make the session a bot with its name editable, and confirms once', async () => {
  const onConfirm = vi.fn(), onName = vi.fn();
  await render(<SessionUseDialog {...base} onConfirm={onConfirm} onName={onName} />);
  expect(document.querySelector('h2')!.textContent).toBe('Make Fix the build a bot?');
  const input = document.querySelector<HTMLInputElement>('dialog input')!;
  expect(input.value).toBe('Fix the build');
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Builder'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(onName).toHaveBeenCalledWith('Builder');
  await act(async () => button('Make bot').click());
  expect(onConfirm).toHaveBeenCalledTimes(1);
});

it('says a terminal still has the session and offers the take-over instead of the bot', async () => {
  const onTakeOver = vi.fn(), onConfirm = vi.fn();
  await render(<SessionUseDialog {...base} phase="held" onTakeOver={onTakeOver} onConfirm={onConfirm} />);
  expect(document.querySelector('h2')!.textContent).toBe('A terminal still has this session');
  expect(document.querySelector('[role="status"]')!.textContent).toContain('claude command line in a terminal still has this session open');
  expect(document.querySelector('dialog input')).toBeNull();
  await act(async () => button('Take over here').click());
  expect(onTakeOver).toHaveBeenCalledTimes(1);
  expect(onConfirm).not.toHaveBeenCalled();
});

it('cannot be confirmed twice while the bot is being made', async () => {
  const onConfirm = vi.fn();
  await render(<SessionUseDialog {...base} phase="working" onConfirm={onConfirm} />);
  expect(button('Make bot').disabled).toBe(true);
  expect(button('Cancel').disabled).toBe(true);
  expect(document.querySelector('dialog input')!.hasAttribute('disabled')).toBe(true);
  expect(document.body.textContent).toContain('Making the bot…');
});

it('shows why the bot could not be made and lets the person try again', async () => {
  const onConfirm = vi.fn();
  await render(<SessionUseDialog {...base} phase="failed" failure="The Host is offline." onConfirm={onConfirm} />);
  expect(document.querySelector('[role="alert"]')!.textContent).toBe('The Host is offline.');
  await act(async () => button('Make bot').click());
  expect(onConfirm).toHaveBeenCalledTimes(1);
});
