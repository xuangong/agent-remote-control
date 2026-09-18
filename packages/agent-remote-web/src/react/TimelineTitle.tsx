import { createContext, type ReactNode, useContext, useEffect, useRef } from 'react';

export interface TimelineTime {
  readonly timestamp: string;
  readonly date: string;
  readonly time: string;
  readonly visible: boolean;
  toggle(): void;
}

export const TimelineTimeContext = createContext<TimelineTime | undefined>(undefined);
export const isDesktopTimeline = () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1181px)').matches;

/** Titles inside disclosure buttons share the button's keyboard and mobile behavior. */
export function TimelineTitle({ children, className, disclose }: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly disclose?: () => void;
}) {
  const time = useContext(TimelineTimeContext);
  const pendingClick = useRef<ReturnType<typeof setTimeout>>();
  const cancelClick = () => {
    clearTimeout(pendingClick.current);
    pendingClick.current = undefined;
  };
  useEffect(() => cancelClick, []);
  const titleClass = `agent-timeline-title${className ? ` ${className}` : ''}`;
  if (!time) return <span className={titleClass}>{children}</span>;

  const hint = `Double-click to ${time.visible ? 'hide' : 'show'} all local timestamps (Alt+T)`;
  const label = <span className="agent-time-title-label" title={hint}
    onMouseDown={event => { if (isDesktopTimeline() && event.detail > 1) event.preventDefault(); }}
    onClick={event => {
      if (!disclose || !isDesktopTimeline() || event.detail === 0) return;
      event.stopPropagation();
      cancelClick();
      // Defer only pointer clicks on the label so a double click cannot open details.
      if (event.detail === 1) pendingClick.current = setTimeout(() => { pendingClick.current = undefined; disclose(); }, 500);
    }}
    onDoubleClick={event => {
      if (!isDesktopTimeline()) return;
      event.preventDefault();
      event.stopPropagation();
      cancelClick();
      time.toggle();
    }}>{children}</span>;

  return <span className={titleClass}>
    {disclose ? label : <>
      <button type="button" className="agent-time-title-control" title={hint} aria-pressed={time.visible} aria-keyshortcuts="Alt+T"
        onClick={event => { if (event.detail === 0) time.toggle(); }}>{label}</button>
      <span className="agent-time-title-mobile">{children}</span>
    </>}
    <time className="agent-title-time" dateTime={time.timestamp} hidden={!time.visible}
      aria-label={`${time.date} ${time.time} (local time)`}>{time.date} {time.time}</time>
  </span>;
}
