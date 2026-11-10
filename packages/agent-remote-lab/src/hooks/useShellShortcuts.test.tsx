import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render, unmount } from '../test/setup.js';
import { useShellShortcuts } from './useShellShortcuts.js';

const platform = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform');
afterEach(() => { if (platform) Object.defineProperty(Navigator.prototype, 'platform', platform); });
const onPlatform = (value: string) => {
  // applePlatform() prefers userAgentData.platform; jsdom has none, so stubbing navigator.platform decides it.
  expect('userAgentData' in navigator).toBe(false);
  Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => value });
};
const press = async (init: KeyboardEventInit) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  await act(async () => { window.dispatchEvent(event); });
  return event;
};

function Harness(props: Parameters<typeof useShellShortcuts>[0]) { useShellShortcuts(props); return null; }

it('toggles the sidebar with Command-Backslash and switches modes with Option-Command-1 and 2 on Apple platforms', async () => {
  onPlatform('MacIntel');
  const toggleSidebar = vi.fn(), setMode = vi.fn();
  await render(<Harness toggleSidebar={toggleSidebar} setMode={setMode} />);
  await press({ key: '\\', code: 'Backslash', metaKey: true });
  await press({ key: '¡', code: 'Digit1', metaKey: true, altKey: true });
  await press({ key: '™', code: 'Digit2', metaKey: true, altKey: true });
  expect(toggleSidebar).toHaveBeenCalledOnce();
  expect(setMode.mock.calls).toEqual([['window'], ['bot']]);
  await press({ key: '\\', code: 'Backslash', ctrlKey: true });
  await press({ key: '1', code: 'Digit1', metaKey: true });
  expect(toggleSidebar).toHaveBeenCalledOnce();
  expect(setMode).toHaveBeenCalledTimes(2);
});

it('uses Control elsewhere, ignores AltGraph and events already handled, and works without a sidebar', async () => {
  onPlatform('Win32');
  const setMode = vi.fn();
  await render(<Harness setMode={setMode} />);
  expect((await press({ key: '\\', code: 'Backslash', ctrlKey: true })).defaultPrevented).toBe(false);
  await press({ key: '1', code: 'Digit1', ctrlKey: true, altKey: true });
  expect(setMode).toHaveBeenCalledWith('window');
  await act(async () => {
    const event = new KeyboardEvent('keydown', { key: '2', code: 'Digit2', ctrlKey: true, altKey: true, cancelable: true });
    Object.defineProperty(event, 'getModifierState', { value: (key: string) => key === 'AltGraph' });
    window.dispatchEvent(event);
  });
  await act(async () => {
    const event = new KeyboardEvent('keydown', { key: '2', code: 'Digit2', ctrlKey: true, altKey: true, cancelable: true });
    event.preventDefault(); window.dispatchEvent(event);
  });
  expect(setMode).toHaveBeenCalledOnce();
});

it('leaves Control-Alt-2 alone when the layout types a character with it', async () => {
  onPlatform('Win32');
  const setMode = vi.fn();
  await render(<Harness setMode={setMode} />);
  const event = await press({ key: '²', code: 'Digit2', ctrlKey: true, altKey: true });
  expect(event.defaultPrevented).toBe(false);
  expect(setMode).not.toHaveBeenCalled();
});

it('ignores repeated keydowns from a held key', async () => {
  onPlatform('MacIntel');
  const toggleSidebar = vi.fn(), setMode = vi.fn();
  await render(<Harness toggleSidebar={toggleSidebar} setMode={setMode} />);
  await press({ key: '\\', code: 'Backslash', metaKey: true });
  await press({ key: '\\', code: 'Backslash', metaKey: true, repeat: true });
  await press({ key: '\\', code: 'Backslash', metaKey: true, repeat: true });
  expect(toggleSidebar).toHaveBeenCalledOnce();
});

it('does nothing while a dialog is open', async () => {
  onPlatform('MacIntel');
  const toggleSidebar = vi.fn(), setMode = vi.fn();
  await render(<Harness toggleSidebar={toggleSidebar} setMode={setMode} />);
  const dialog = document.createElement('dialog');
  dialog.setAttribute('open', '');
  document.body.append(dialog);
  try {
    const event = await press({ key: '\\', code: 'Backslash', metaKey: true });
    await press({ key: '™', code: 'Digit2', metaKey: true, altKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(toggleSidebar).not.toHaveBeenCalled();
    expect(setMode).not.toHaveBeenCalled();
  } finally { dialog.remove(); }
  await press({ key: '\\', code: 'Backslash', metaKey: true });
  expect(toggleSidebar).toHaveBeenCalledOnce();
});

it('stops listening once unmounted', async () => {
  onPlatform('MacIntel');
  const toggleSidebar = vi.fn(), setMode = vi.fn();
  const container = await render(<Harness toggleSidebar={toggleSidebar} setMode={setMode} />);
  await unmount(container);
  await press({ key: '\\', code: 'Backslash', metaKey: true });
  await press({ key: '¡', code: 'Digit1', metaKey: true, altKey: true });
  expect(toggleSidebar).not.toHaveBeenCalled();
  expect(setMode).not.toHaveBeenCalled();
});
