import { createContext, useContext, useState } from 'react';

export type TimelineDisplayMode = 'preview' | 'simple';
export const TimelineDisplay = createContext<TimelineDisplayMode>('preview');

/** Explicit choices survive item updates and changes to the default display mode. */
export function useItemDisclosure() {
  const mode = useContext(TimelineDisplay);
  const [choice, setChoice] = useState<boolean>();
  return {
    expanded: choice === true,
    preview: choice === undefined && mode === 'preview',
    toggle: () => setChoice(current => current !== true),
  };
}
