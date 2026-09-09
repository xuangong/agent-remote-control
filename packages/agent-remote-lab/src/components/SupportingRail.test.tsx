import { act, useRef, useState } from 'react';
import { describe, expect, it } from 'vitest';

import { render } from '../test/setup.js';
import { SupportingRail } from './SupportingRail.js';

function Harness({ compact = true }: { compact?: boolean }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(!compact);
  return <>
    <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>Open Context</button>
    <SupportingRail
      id="test-context"
      label="Context"
      className="test-context"
      compact={compact}
      open={open}
      triggerRef={triggerRef}
      onClose={() => setOpen(false)}
    >
      <button type="button">First action</button>
      <button type="button">Last action</button>
      <button type="button" tabIndex={-1}>Programmatic action</button>
      <fieldset disabled>
        <button type="button">Disabled action</button>
      </fieldset>
    </SupportingRail>
  </>;
}

describe('SupportingRail', () => {
  it('moves focus to its internal close control when a compact rail opens', async () => {
    const container = await render(<Harness />);
    await act(async () => (container.querySelector('button') as HTMLButtonElement).click());
    expect(document.activeElement?.textContent).toBe('Close Context');
  });

  it('wraps Tab and Shift+Tab inside an open compact rail', async () => {
    const container = await render(<Harness />);
    await act(async () => (container.querySelector('button') as HTMLButtonElement).click());
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    const close = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Close Context')!;
    const last = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Last action')!;
    last.focus();
    await act(async () => last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(close);
    close.focus();
    await act(async () => close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(last);
  });

  it('excludes negative-tabindex and inherited-disabled controls from keyboard wrapping', async () => {
    const container = await render(<Harness />);
    await act(async () => (container.querySelector('button') as HTMLButtonElement).click());
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    const close = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Close Context')!;
    const last = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Last action')!;
    last.focus();
    await act(async () => last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(close);
  });

  it('closes with Escape and restores focus to its trigger', async () => {
    const container = await render(<Harness />);
    const trigger = container.querySelector('button') as HTMLButtonElement;
    await act(async () => trigger.click());
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('renders as a non-modal persistent aside on desktop', async () => {
    const container = await render(<Harness compact={false} />);
    const rail = container.querySelector('aside') as HTMLElement;
    expect(rail.getAttribute('role')).toBeNull();
    expect(rail.getAttribute('aria-modal')).toBeNull();
    expect(rail.textContent).toContain('First action');
  });
});
