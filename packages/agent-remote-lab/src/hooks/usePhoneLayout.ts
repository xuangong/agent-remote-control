import { useSyncExternalStore } from 'react';
import { orchardBreakpoints } from '@orchardworks/agent-client-web/theme';

/** The phone layout: one screen at a time, with the assistant list as home (I3 plan, decision 14). */
export const PHONE_LAYOUT_QUERY = `(max-width: ${orchardBreakpoints.phone}px)`;

const media = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(PHONE_LAYOUT_QUERY) : undefined;
const subscribe = (listener: () => void) => {
  const list = media();
  list?.addEventListener?.('change', listener);
  return () => list?.removeEventListener?.('change', listener);
};
const snapshot = () => media()?.matches === true;

/** Whether the page is at phone width; follows the width as it changes. */
export function usePhoneLayout(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
