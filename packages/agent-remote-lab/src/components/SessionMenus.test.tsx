import { act, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, unmount } from '../test/setup.js';
import { SessionHeadingActions } from './SessionHeadingActions.js';
import { SessionViewOptions, type SessionDisplayPreferences } from './SessionViewOptions.js';

const observers = new Set<() => void>();
let triggerVisible = true;
let triggerBounds: DOMRect;
const openPopovers = new Set<HTMLElement>();

beforeEach(() => {
  triggerVisible = true;
  triggerBounds = new DOMRect(700, 100, 44, 44);
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: () => void) { observers.add(callback); }
    observe() {}
    disconnect() { observers.delete(this.callback); }
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.tagName === 'BUTTON') return triggerVisible ? triggerBounds : new DOMRect();
    return new DOMRect(0, 0, 216, 220);
  });
  const matches = HTMLElement.prototype.matches;
  vi.spyOn(HTMLElement.prototype, 'matches').mockImplementation(function (this: HTMLElement, selector) {
    return selector === ':popover-open' ? openPopovers.has(this) : matches.call(this, selector);
  });
  Object.defineProperties(HTMLElement.prototype, {
    showPopover: { configurable: true, value: function (this: HTMLElement) {
      if (!this.isConnected || this.getAttribute('popover') !== 'manual') throw new Error('Invalid popover.');
      openPopovers.add(this);
    } },
    hidePopover: { configurable: true, value: function (this: HTMLElement) { openPopovers.delete(this); } },
  });
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); openPopovers.clear(); observers.clear();
  delete (HTMLElement.prototype as Partial<HTMLElement>).showPopover;
  delete (HTMLElement.prototype as Partial<HTMLElement>).hidePopover;
});

async function click(element: Element) { await act(async () => (element as HTMLElement).click()); }
async function resize() { await act(async () => { for (const callback of observers) callback(); }); }
function Preferences() {
  const [preferences, onChange] = useState<SessionDisplayPreferences>({ mode: 'preview', lettersVisible: false });
  return <SessionViewOptions preferences={preferences} onChange={onChange} />;
}

it('opens view options in the top layer and preserves selection and Escape focus', async () => {
  const container = await render(<Preferences />);
  const trigger = container.querySelector('button')!;
  await click(trigger);
  const panel = container.querySelector('section')!;
  expect(panel.matches(':popover-open')).toBe(true);
  expect(panel.parentElement).toBe(trigger.parentElement);
  expect(panel.style.getPropertyValue('--session-menu-left')).toBe('528px');
  await click(panel.querySelector('input[value="simple"]')!);
  expect(panel.querySelector<HTMLInputElement>('input[value="simple"]')!.checked).toBe(true);
  await act(async () => panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(container.querySelector('section')).toBeNull();
  expect(panel.matches(':popover-open')).toBe(false);
  expect(document.activeElement).toBe(trigger);
});

it('keeps a leading menu inside the viewport and repositions it above a low anchor', async () => {
  triggerBounds = new DOMRect(990, 730, 44, 30);
  const container = await render(<div className="lab-session-heading-leading"><Preferences /></div>);
  await click(container.querySelector('button')!);
  const panel = container.querySelector('section')!;
  expect(panel.style.getPropertyValue('--session-menu-left')).toBe('800px');
  expect(panel.style.getPropertyValue('--session-menu-top')).toBe('505px');
  triggerBounds = new DOMRect(20, 80, 44, 44);
  await act(async () => window.dispatchEvent(new Event('scroll')));
  expect(panel.style.getPropertyValue('--session-menu-left')).toBe('20px');
  expect(panel.style.getPropertyValue('--session-menu-top')).toBe('129px');
  await unmount(container);
});

it('returns heading actions to inline layout when its menu trigger becomes hidden', async () => {
  const container = await render(<SessionHeadingActions><button>Action</button></SessionHeadingActions>);
  const trigger = container.querySelector('button')!;
  const panel = container.querySelector<HTMLElement>('.lab-session-heading-actions-panel')!;
  await click(trigger);
  expect(panel.matches(':popover-open')).toBe(true);
  triggerVisible = false;
  await resize();
  expect(panel.hasAttribute('popover')).toBe(false);
  expect(panel.style.getPropertyValue('--session-menu-left')).toBe('');
  expect(panel.textContent).toBe('Action');
  triggerVisible = true;
  await resize();
  expect(panel.matches(':popover-open')).toBe(true);
  await unmount(container);
  expect(panel.matches(':popover-open')).toBe(false);
  expect(observers.size).toBe(0);
});

it('dismisses heading actions outside the menu without dismissing a child modal', async () => {
  const container = await render(<><SessionHeadingActions><button>Action</button></SessionHeadingActions><dialog open /></>);
  const trigger = container.querySelector('button')!;
  const panel = container.querySelector<HTMLElement>('.lab-session-heading-actions-panel')!;
  await click(trigger);
  await act(async () => container.querySelector('dialog')!.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  expect(panel.matches(':popover-open')).toBe(true);
  await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  expect(panel.matches(':popover-open')).toBe(false);
  expect(panel.hasAttribute('popover')).toBe(false);
});
