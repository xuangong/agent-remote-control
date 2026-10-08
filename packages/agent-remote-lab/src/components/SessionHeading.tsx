import { useLayoutEffect, useRef, type ReactNode } from 'react';

/** Keeps the title centered while reserving room for unequal control groups. */
export function SessionHeading({ leading, trailing, children, hidden }: {
  leading?: ReactNode; trailing?: ReactNode; children: ReactNode; hidden?: boolean;
}) {
  const heading = useRef<HTMLElement>(null);
  const start = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = heading.current!;
    const update = () => {
      const padding = getComputedStyle(element);
      const left = (start.current?.getBoundingClientRect().width ?? 0) + parseFloat(padding.paddingLeft || '0');
      const right = (end.current?.getBoundingClientRect().width ?? 0) + parseFloat(padding.paddingRight || '0');
      element.style.setProperty('--lab-heading-inset', `${Math.ceil(Math.max(left, right)) + 8}px`);
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    observer.observe(start.current!);
    observer.observe(end.current!);
    return () => observer.disconnect();
  }, []);
  return <header className="lab-workbench-heading lab-session-heading" ref={heading} hidden={hidden}>
    <div className="lab-session-heading-leading" ref={start}>{leading}</div>
    <div className="lab-session-heading-title">{children}</div>
    <div className="lab-session-heading-trailing" ref={end}>{trailing}</div>
  </header>;
}
