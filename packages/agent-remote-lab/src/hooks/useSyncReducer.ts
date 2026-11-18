import { useCallback, useRef, useState } from 'react';

/**
 * The shell of a pure state reducer: events apply in order, so several dispatches in one handler compose, and the latest
 * state is readable at once through `read` (a handler sees the result of its own earlier dispatch).
 */
export function useSyncReducer<State, Event>(reduce: (state: State, event: Event) => State, initial: State) {
  const current = useRef(initial);
  const [state, setState] = useState(initial);
  const dispatch = useCallback((event: Event) => {
    current.current = reduce(current.current, event);
    setState(current.current);
  }, [reduce]);
  const read = useCallback(() => current.current, []);
  return [state, dispatch, read] as const;
}
