/**
 * The reader's panel widths on this device and the window's width, as hooks. A drag changes the widths in memory on every move and
 * keeps them once it ends, so other tabs follow the result (through the `storage` event), not every step. Only the frame's chrome reads
 * every change; the workbench reads whether the details fit (`useDetailsBeside`), which changes rarely.
 */
import { useSyncExternalStore } from 'react';
import { layoutPanels, PANEL_WIDTHS_STORAGE_KEY, readPanelWidths, type PanelWidths } from './panel-layout.js';

const listeners = new Set<() => void>();
let stored: { readonly raw: string | null; readonly widths: PanelWidths } | undefined;
let live: PanelWidths | undefined;

function readStored(): PanelWidths {
  let raw: string | null = null;
  try { raw = localStorage.getItem(PANEL_WIDTHS_STORAGE_KEY); } catch { /* A private window keeps the widths on this page. */ }
  if (!stored || stored.raw !== raw) stored = { raw, widths: readPanelWidths(raw) };
  return stored.widths;
}
const snapshot = () => live ?? readStored();
const notify = () => { for (const listener of listeners) listener(); };
function subscribe(listener: () => void) {
  listeners.add(listener);
  const fromOtherTab = (event: StorageEvent) => { if (event.key === PANEL_WIDTHS_STORAGE_KEY && !live) listener(); };
  addEventListener('storage', fromOtherTab);
  return () => { listeners.delete(listener); removeEventListener('storage', fromOtherTab); };
}

const subscribeResize = (listener: () => void) => { addEventListener('resize', listener); return () => removeEventListener('resize', listener); };
const subscribeLayout = (listener: () => void) => { const stop = [subscribe(listener), subscribeResize(listener)]; return () => { for (const each of stop) each(); }; };

/**
 * Whether Bot mode's details fit beside its conversation at the kept widths: a drag opens or collapses them once it ends, never on its way.
 * A component that reads only this renders again only when it changes.
 */
export function useDetailsBeside(phone: boolean): boolean {
  const beside = () => !phone && layoutPanels(readStored(), { mode: 'bot', viewport: window.innerWidth }).detailsBeside;
  return useSyncExternalStore(subscribeLayout, beside, beside);
}

export interface PanelWidthsStore {
  readonly widths: PanelWidths;
  /** Shows new widths; they are kept on this device at the next `keep`. */
  show(widths: PanelWidths): void;
  /** Keeps the widths shown. */
  keep(): void;
}

export function usePanelWidths(): PanelWidthsStore {
  const widths = useSyncExternalStore(subscribe, snapshot, snapshot);
  return {
    widths,
    show: next => { live = next; notify(); },
    keep: () => {
      const kept = live;
      live = undefined;
      if (kept) try { localStorage.setItem(PANEL_WIDTHS_STORAGE_KEY, JSON.stringify(kept)); } catch { stored = { raw: null, widths: kept }; }
      notify();
    },
  };
}

const viewportWidth = () => window.innerWidth;

/** The window's width, following resizes. */
export function useViewportWidth(): number {
  return useSyncExternalStore(subscribeResize, viewportWidth, viewportWidth);
}
