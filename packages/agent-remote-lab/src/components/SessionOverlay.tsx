import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/** Keep workspace services in the React tree while a floating container lives in the shell. */
export function SessionOverlay({ target, children }: { target: RefObject<HTMLElement>; children: ReactNode }) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useEffect(() => { setContainer(target.current); }, [target]);
  return container ? createPortal(children, container) : null;
}
