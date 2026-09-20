import { type CSSProperties, type ReactNode, useMemo } from 'react';
import { useTimelineTimeSwipe } from './useTimelineTimeSwipe.js';
import { isDesktopTimeline, TimelineTimeContext } from './TimelineTitle.js';
import { toggleTimelineTime, useTimelineTimeVisibility } from './timeline-time-visibility.js';

interface TimelineEntryProps {
  readonly entryKey: string;
  readonly timestamp: string;
  readonly sent: boolean;
  readonly inspected: boolean;
  readonly inspect?: () => void;
  readonly sequence: number;
  readonly children: ReactNode;
}

export function TimelineEntry({ entryKey, timestamp, sent, inspected, inspect, sequence, children }: TimelineEntryProps) {
  const timeVisible = useTimelineTimeVisibility();
  const localTime = useMemo(() => {
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return undefined;
    return {
      date: new Intl.DateTimeFormat(undefined, { dateStyle: 'short' }).format(date),
      time: new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date),
    };
  }, [timestamp]);
  const timeContext = useMemo(() => localTime ? { ...localTime, timestamp, visible: timeVisible, toggle: toggleTimelineTime } : undefined, [localTime, timestamp, timeVisible]);
  const { ref, reveal } = useTimelineTimeSwipe(!!localTime, sent ? -1 : 1);
  return <div ref={ref} className="agent-timeline-entry" data-entry-key={entryKey}
    data-inspected={inspected || undefined} tabIndex={inspect ? -1 : undefined}
    data-time-side={sent ? 'right' : 'left'} data-time-revealed={reveal.offset !== 0 || undefined}
    data-time-dragging={reveal.dragging || undefined}
    onKeyDown={event => {
      if (localTime && isDesktopTimeline() && event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 't') {
        event.preventDefault();
        event.stopPropagation();
        toggleTimelineTime();
      }
    }}
    style={{ '--agent-time-offset': `${reveal.offset}px`, '--agent-time-top': `${reveal.top}px` } as CSSProperties}>
    {inspect ? <button className="agent-inspect-entry" type="button" aria-label={`Inspect event #${sequence} in Trace`} title="Inspect in Trace" onClick={inspect}>
      <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 4h5m-5 6h5m-5 6h5M5 4v12m6-6h6m-3-3 3 3-3 3" /></svg>
    </button> : null}
    {localTime ? <time className="agent-entry-time" dateTime={timestamp} aria-label={`${localTime.date} ${localTime.time} (local time)`}>
      <span>{localTime.date}</span><span>{localTime.time}</span>
    </time> : null}
    <TimelineTimeContext.Provider value={timeContext}>
      <div className="agent-entry-content">{children}</div>
    </TimelineTimeContext.Provider>
  </div>;
}
