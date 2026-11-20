import { createContext, useContext, useState } from 'react';
import type { ProcessMode } from '@orchardworks/agent-client';
export const TimelineSearchReveal = createContext(false);

/** The process mode a host gives every timeline below it, an earlier session's included; a timeline's own prop wins. */
export const ProcessModeContext = createContext<ProcessMode>('concise');

/** How each step of an open work line shows: its one-line header (`summary`) or today's preview block (`preview`). */
export const TimelineStepLevel = createContext<'summary' | 'preview'>('preview');

/** Whether letters between agents show; a host that offers the choice provides it. */
export const TimelineLettersVisible = createContext(true);

/** Explicit choices survive item updates and changes of the step level. */
export function useItemDisclosure() {
  const level = useContext(TimelineStepLevel);
  const revealed = useContext(TimelineSearchReveal);
  const [disclosure, setDisclosure] = useState<{ revealed: boolean; choice?: boolean }>({ revealed });
  // A newly selected search result opens once; readers can still collapse it.
  if (disclosure.revealed !== revealed) setDisclosure({ revealed, choice: revealed ? true : disclosure.choice });
  const choice = disclosure.revealed === revealed ? disclosure.choice : revealed ? true : disclosure.choice;
  return {
    expanded: choice ?? revealed,
    preview: !revealed && choice === undefined && level === 'preview',
    toggle: () => setDisclosure({ revealed, choice: !(choice ?? revealed) }),
  };
}
