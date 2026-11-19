// @vitest-environment jsdom
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { ApprovalCard } from './ApprovalCard.js';
import { Bubble } from './Bubble.js';
import { Card } from './Card.js';
import { Pill } from './Pill.js';
import { SessionChangeLine } from './SessionChangeLine.js';
import { StatusLine } from './StatusLine.js';
import { Toggle } from './Toggle.js';
import { WorkSummaryLine } from './WorkSummaryLine.js';

const key = (target: Element, type: 'keydown' | 'keyup', name: string) => {
  const event = new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true });
  act(() => { target.dispatchEvent(event); });
  return event;
};

it('sets who a bubble is from and places the assistant\'s avatar at the foot of the body', async () => {
  const container = await render(<>
    <Bubble from="mine" avatar={<i data-testid="ignored" />}>Hi</Bubble>
    <Bubble from="theirs" avatar={<i data-testid="avatar" />}>Hello</Bubble>
  </>);
  const [mine, theirs] = [...container.querySelectorAll<HTMLElement>('.orchard-bubble-row')];
  expect(mine!.dataset.from).toBe('mine');
  expect(mine!.querySelector('[data-testid]')).toBeNull();
  expect(theirs!.dataset.from).toBe('theirs');
  const children = [...theirs!.children];
  expect(children.map(child => child.className)).toEqual(['orchard-bubble-avatar', 'orchard-bubble']);
  expect(children[0]!.querySelector('[data-testid="avatar"]')).not.toBeNull();
});

it('says a message is still being sent, and marks it busy', async () => {
  const container = await render(<Bubble from="mine" delivery="sending" sendingLabel="发送中">顺便改个标题</Bubble>);
  expect(container.querySelector('.orchard-bubble')!.getAttribute('aria-busy')).toBe('true');
  expect(container.querySelector('.orchard-bubble-status')!.textContent).toBe('发送中');
  const sent = await render(<Bubble from="mine" delivery="sent" sendingLabel="发送中">Done</Bubble>);
  expect(sent.querySelector('.orchard-bubble')!.hasAttribute('aria-busy')).toBe(false);
  expect(sent.querySelector('.orchard-bubble-status')).toBeNull();
});

it('tints a card on request', async () => {
  const container = await render(<><Card>Plain</Card><Card tone="tint">Tint</Card></>);
  expect([...container.querySelectorAll<HTMLElement>('.orchard-card')].map(card => card.dataset.tone)).toEqual(['plain', 'tint']);
});

it('makes a pill a button that does not submit, in its variant', async () => {
  const container = await render(<Pill variant="primary">好的</Pill>);
  const pill = container.querySelector('button')!;
  expect(pill.type).toBe('button');
  expect(pill.dataset.variant).toBe('primary');
});

it('switches a toggle by click and by Space, once each, and not while disabled', async () => {
  const onChange = vi.fn();
  const container = await render(<Toggle checked={false} label="Notifications" onChange={onChange} />);
  const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(toggle.textContent).toBe('Notifications');
  act(() => toggle.click());
  expect(key(toggle, 'keydown', ' ').defaultPrevented).toBe(true);
  expect(key(toggle, 'keyup', ' ').defaultPrevented).toBe(true);
  expect(onChange.mock.calls).toEqual([[true], [true]]);

  const blocked = vi.fn();
  const disabled = await render(<Toggle checked label="Sound" onChange={blocked} disabled />);
  const off = disabled.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(off.getAttribute('aria-checked')).toBe('true');
  act(() => off.click());
  key(off, 'keydown', ' ');
  expect(blocked).not.toHaveBeenCalled();
});

it('opens a work-summary line in place: the button says it is expanded and controls the steps', async () => {
  const onToggle = vi.fn();
  const closed = await render(<WorkSummaryLine summary="翻了 3 个文件" open={false} onToggle={onToggle}><p>Read notes.md</p></WorkSummaryLine>);
  const button = closed.querySelector('button')!;
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(closed.textContent).not.toContain('Read notes.md');
  act(() => button.click());
  expect(onToggle).toHaveBeenCalledTimes(1);

  const open = await render(<WorkSummaryLine summary="翻了 3 个文件" open onToggle={onToggle}><p>Read notes.md</p></WorkSummaryLine>);
  const expanded = open.querySelector('button')!;
  expect(expanded.getAttribute('aria-expanded')).toBe('true');
  const region = document.getElementById(expanded.getAttribute('aria-controls')!)!;
  expect(region.getAttribute('role')).toBe('region');
  expect(region.textContent).toBe('Read notes.md');
});

it('lists an approval\'s choices in order, and choosing one calls only its own handler', async () => {
  const handlers = [vi.fn(), vi.fn(), vi.fn()];
  const container = await render(<ApprovalCard prompt="我想加一小段例子，可以吗？"
    choices={[{ label: '好的', primary: true, onChoose: handlers[0]! }, { label: '先别', onChoose: handlers[1]! }, { label: '看看要改什么', onChoose: handlers[2]! }]} />);
  const buttons = [...container.querySelectorAll('button')];
  expect(buttons.map(button => [button.textContent, button.dataset.variant])).toEqual([['好的', 'primary'], ['先别', 'plain'], ['看看要改什么', 'plain']]);
  act(() => buttons[1]!.click());
  expect(handlers.map(handler => handler.mock.calls.length)).toEqual([0, 1, 0]);
});

it('announces a status sentence politely and keeps the typing dots out of the reading', async () => {
  const live = await render(<StatusLine sentence="Chief 在想例子怎么写" detail="认真工作中" live />);
  const sentence = live.querySelector('[role="status"]')!;
  expect(sentence.getAttribute('aria-live')).toBe('polite');
  expect(sentence.textContent).toBe('Chief 在想例子怎么写');
  expect(live.querySelector('.orchard-typing')!.getAttribute('aria-hidden')).toBe('true');
  const still = await render(<StatusLine sentence="看完啦" />);
  expect(still.querySelector('.orchard-typing')).toBeNull();
});

it('names a session-change line by its text', async () => {
  const container = await render(<SessionChangeLine>换到新的会话继续</SessionChangeLine>);
  const line = container.querySelector('[role="separator"]')!;
  expect(line.getAttribute('aria-label')).toBe('换到新的会话继续');
});
