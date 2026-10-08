import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

/** Keeps floating actions within their Session View without covering the reading area. */
export function SessionTimelineTools({ collapsible, searchOpen, searchPanel, timelineRef, onDismissSearch, children }: {
  collapsible: boolean; searchOpen: boolean; searchPanel?: ReactNode; timelineRef: RefObject<HTMLElement>; onDismissSearch(): void; children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const contentId = useId();
  const container = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const latestDismissSearch = useRef(onDismissSearch);
  latestDismissSearch.current = onDismissSearch;
  const hidden = collapsible && collapsed && !searchOpen;
  useLayoutEffect(() => { if (searchOpen) setCollapsed(false); }, [searchOpen]);
  useEffect(() => {
    const element = container.current;
    if (!collapsible || hidden || !element) return;
    const ownerDocument = element.ownerDocument;
    const dismissOutside = (event: Event) => {
      const path = event.composedPath();
      if (path.includes(element)) return;
      // Portaled modal actions return focus to their toolbar trigger.
      if (path.some(target => target instanceof Element && target.matches('dialog[open]'))) return;
      setCollapsed(true);
      latestDismissSearch.current();
    };
    const dismissOnWheel = (event: WheelEvent) => {
      if (event.deltaY !== 0 && !event.ctrlKey) dismissOutside(event);
    };
    const dismissOnScrollKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.target !== timelineRef.current) return;
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) dismissOutside(event);
    };
    ownerDocument.addEventListener('pointerdown', dismissOutside, true);
    ownerDocument.addEventListener('wheel', dismissOnWheel, { capture: true, passive: true });
    ownerDocument.addEventListener('keydown', dismissOnScrollKey);
    return () => {
      ownerDocument.removeEventListener('pointerdown', dismissOutside, true);
      ownerDocument.removeEventListener('wheel', dismissOnWheel, true);
      ownerDocument.removeEventListener('keydown', dismissOnScrollKey);
    };
  }, [collapsible, hidden, timelineRef]);
  const label = hidden ? 'Expand session actions' : 'Collapse session actions';
  return <div ref={container} className="lab-timeline-controls">
    <div className="lab-timeline-tools" role="toolbar" aria-label="Session actions"
    data-collapsible={collapsible || undefined} data-collapsed={hidden || undefined}>
    <div ref={content} id={contentId} className="lab-timeline-tools-content"
      aria-hidden={hidden || undefined} {...(hidden ? { inert: '' } : {})}>{children}</div>
    {collapsible ? <button type="button" className="lab-timeline-tools-toggle"
      aria-label={label} title={label} aria-expanded={!hidden} aria-controls={contentId} disabled={searchOpen}
      onClick={event => {
        if (!hidden && content.current?.contains(document.activeElement)) event.currentTarget.focus({ preventScroll: true });
        setCollapsed(!hidden);
      }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path className="lab-timeline-tools-expand-icon" d="m14 6-6 6 6 6" />
        <path className="lab-timeline-tools-collapse-icon" d="m10 6 6 6-6 6" />
      </svg>
    </button> : null}
    </div>
    {searchPanel}
  </div>;
}
