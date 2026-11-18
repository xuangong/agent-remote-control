import { useCallback, useLayoutEffect, useRef } from 'react';

/** Keep event handlers stable without retaining a previous render's permissions or client. */
export function useTimelineAction<Args extends unknown[], Result>(scope: string, action: ((...args: Args) => Result) | undefined) {
  const latest = useRef({ scope, action });
  useLayoutEffect(() => {
    latest.current = { scope, action };
    return () => { latest.current = { scope, action: undefined }; };
  }, [scope, action]);
  const invoke = useCallback((...args: Args): Result => {
    const current = latest.current;
    if (current.scope !== scope || !current.action) throw new Error('This session action is no longer available.');
    return current.action(...args);
  }, [scope]);
  return action ? invoke : undefined;
}
