import { useCallback, useRef, useState } from 'react';
import { initialPanels, reducePanels, type PanelsEffect, type PanelsEvent, type PanelsState } from './panels.js';

/**
 * The shell of the panels slice: it applies events to the pure reducer in order, so several dispatches in one handler
 * compose, and runs the effects the reducer returns. The reducer owns every rule.
 */
export function usePanels(layout: Parameters<typeof initialPanels>[0], run: (effect: PanelsEffect) => void) {
  const current = useRef<PanelsState>();
  current.current ??= initialPanels(layout);
  const [state, setState] = useState<PanelsState>(current.current);
  const runEffect = useRef(run); runEffect.current = run;
  const dispatch = useCallback((event: PanelsEvent) => {
    const step = reducePanels(current.current!, event);
    current.current = step.state;
    setState(step.state);
    for (const effect of step.effects) runEffect.current(effect);
  }, []);
  return [state, dispatch] as const;
}
