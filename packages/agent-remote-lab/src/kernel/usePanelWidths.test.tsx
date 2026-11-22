import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { renderHook } from '../test/render-hook.js';
import { PANEL_WIDTHS_STORAGE_KEY } from './panel-layout.js';
import { useDetailsBeside, usePanelWidths } from './usePanelWidths.js';

afterEach(() => { localStorage.clear(); });

it('shows a drag\'s widths at once and keeps them on this device only when it ends', async () => {
  const { result } = await renderHook(() => usePanelWidths());
  expect(result.current.widths).toEqual({ rail: 60, sidebar: 260, details: 300 });
  act(() => result.current.show({ rail: 60, sidebar: 300, details: 300 }));
  act(() => result.current.show({ rail: 60, sidebar: 320, details: 300 }));
  expect(result.current.widths.sidebar).toBe(320);
  expect(localStorage.getItem(PANEL_WIDTHS_STORAGE_KEY)).toBeNull();
  act(() => result.current.keep());
  expect(JSON.parse(localStorage.getItem(PANEL_WIDTHS_STORAGE_KEY)!)).toEqual({ rail: 60, sidebar: 320, details: 300 });
  expect(result.current.widths.sidebar).toBe(320);
});

it('follows the widths another tab keeps', async () => {
  const { result } = await renderHook(() => usePanelWidths());
  act(() => {
    localStorage.setItem(PANEL_WIDTHS_STORAGE_KEY, JSON.stringify({ rail: 120, sidebar: 380, details: 400 }));
    dispatchEvent(new StorageEvent('storage', { key: PANEL_WIDTHS_STORAGE_KEY }));
  });
  expect(result.current.widths).toEqual({ rail: 120, sidebar: 380, details: 400 });
});

it('says whether the details fit beside the conversation as the window and the widths change', async () => {
  const viewport = window.innerWidth;
  try {
    window.innerWidth = 1440;
    const { result } = await renderHook(() => useDetailsBeside(false));
    expect(result.current).toBe(true);
    act(() => { window.innerWidth = 1180; dispatchEvent(new Event('resize')); });
    expect(result.current).toBe(false);
    act(() => { window.innerWidth = 1440; dispatchEvent(new Event('resize')); });
    expect(result.current).toBe(true);
    act(() => {
      localStorage.setItem(PANEL_WIDTHS_STORAGE_KEY, JSON.stringify({ rail: 200, sidebar: 420, details: 480 }));
      dispatchEvent(new StorageEvent('storage', { key: PANEL_WIDTHS_STORAGE_KEY }));
    });
    expect(result.current).toBe(false);
    const { result: phone } = await renderHook(() => useDetailsBeside(true));
    expect(phone.current).toBe(false);
  } finally { window.innerWidth = viewport; }
});
