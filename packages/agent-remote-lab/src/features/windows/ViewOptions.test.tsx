import { act, createRef, useState } from 'react';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { render } from '../../test/setup.js';
import { ViewOptions } from './ViewOptions.js';

type Spy = Mock<(...args: unknown[]) => void>;
function Harness({ compact = false, calls }: { compact?: boolean; calls: Record<string, Spy> }) {
  const [shown, setShown] = useState({ header: true, sidebar: false, inspector: false });
  const trigger = createRef<HTMLButtonElement>();
  return <ViewOptions triggerRef={trigger as React.RefObject<HTMLButtonElement>} compact={compact} inert={false} headerVisible={shown.header} sidebarVisible={shown.sidebar} inspectorVisible={shown.inspector}
    onSetAllVisible={visible => { calls.all!(visible); setShown({ header: visible, sidebar: visible, inspector: visible }); }}
    onToggleHeader={() => { calls.header!(); setShown(value => ({ ...value, header: !value.header })); }}
    onToggleSidebar={() => { calls.sidebar!(); setShown(value => ({ ...value, sidebar: !value.sidebar })); }}
    onToggleInspector={() => { calls.inspector!(); setShown(value => ({ ...value, inspector: !value.inspector })); }} />;
}
const control = (container: HTMLElement, name: string) => container.querySelector<HTMLElement>(`[data-view-control="${name}"]`)!;
const calls = () => ({ all: vi.fn<(...args: unknown[]) => void>(), header: vi.fn<(...args: unknown[]) => void>(), sidebar: vi.fn<(...args: unknown[]) => void>(), inspector: vi.fn<(...args: unknown[]) => void>() });

describe('ViewOptions', () => {
  it('opens one panel of three checkboxes that show which panels are visible, and each checkbox toggles only its panel', async () => {
    const spies = calls();
    const container = await render(<Harness calls={spies} />);
    expect(container.querySelectorAll('button[aria-label="View options"]')).toHaveLength(1);
    expect(control(container, 'trigger').getAttribute('aria-expanded')).toBe('false');
    await act(async () => control(container, 'trigger').click());
    expect(control(container, 'trigger').getAttribute('aria-expanded')).toBe('true');
    const checked = () => ['header', 'sidebar', 'inspector'].map(name => (control(container, name) as HTMLInputElement).checked);
    expect(checked()).toEqual([true, false, false]);
    await act(async () => control(container, 'sidebar').click());
    expect(spies.sidebar).toHaveBeenCalledOnce(); expect(spies.header).not.toHaveBeenCalled(); expect(spies.inspector).not.toHaveBeenCalled();
    expect(checked()).toEqual([true, true, false]);
    await act(async () => control(container, 'inspector').click());
    expect(checked()).toEqual([true, true, true]);
    expect(container.querySelector('[aria-label="View options"][id]')?.textContent).toMatch(/Header[\s\S]*Sidebar[\s\S]*Replica Inspector/);
  });

  it('shows and hides every panel at once on a wide layout, and offers only Hide all on a compact one', async () => {
    const spies = calls();
    const wide = await render(<Harness calls={spies} />);
    await act(async () => control(wide, 'trigger').click());
    await act(async () => control(wide, 'show-all').click());
    expect(spies.all).toHaveBeenLastCalledWith(true);
    expect(['header', 'sidebar', 'inspector'].every(name => (control(wide, name) as HTMLInputElement).checked)).toBe(true);
    await act(async () => control(wide, 'hide-all').click());
    expect(spies.all).toHaveBeenLastCalledWith(false);
    expect(['header', 'sidebar', 'inspector'].some(name => (control(wide, name) as HTMLInputElement).checked)).toBe(false);
    const compact = await render(<Harness calls={calls()} compact />);
    await act(async () => control(compact, 'trigger').click());
    expect(control(compact, 'show-all')).toBeNull();
    expect(control(compact, 'hide-all')).not.toBeNull();
  });

  it('closes on Escape and gives the focus back to the View button', async () => {
    const container = await render(<Harness calls={calls()} />);
    await act(async () => control(container, 'trigger').click());
    const header = control(container, 'header');
    header.focus();
    await act(async () => { header.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(container.querySelector('#lab-view-options-panel')).toBeNull();
    expect(document.activeElement).toBe(control(container, 'trigger'));
  });

  it('closes the panel when a compact layout opens its Sidebar or Inspector over the page, but keeps it for the Header', async () => {
    const container = await render(<Harness calls={calls()} compact />);
    await act(async () => control(container, 'trigger').click());
    await act(async () => control(container, 'header').click());
    expect(container.querySelector('#lab-view-options-panel')).not.toBeNull();
    await act(async () => control(container, 'sidebar').click());
    expect(container.querySelector('#lab-view-options-panel')).toBeNull();
  });
});
