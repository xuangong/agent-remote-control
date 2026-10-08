import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Keeps floating actions within their Session View without covering the reading area. */
export function SessionTimelineTools({ collapsible, searchOpen, children }: {
  collapsible: boolean; searchOpen: boolean; children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const contentId = useId();
  const content = useRef<HTMLDivElement>(null);
  const hidden = collapsible && collapsed && !searchOpen;
  useLayoutEffect(() => { if (searchOpen) setCollapsed(false); }, [searchOpen]);
  const label = hidden ? 'Expand session actions' : 'Collapse session actions';
  return <div className="lab-timeline-tools" role="toolbar" aria-label="Session actions"
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
  </div>;
}
