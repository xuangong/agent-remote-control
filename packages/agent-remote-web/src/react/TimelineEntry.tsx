import { type CSSProperties, type ReactNode, useMemo, useState } from 'react';
import { useTimelineTimeSwipe } from './useTimelineTimeSwipe.js';
import { isDesktopTimeline, TimelineTimeContext } from './TimelineTitle.js';
import { toggleTimelineTime, useTimelineTimeVisibility } from './timeline-time-visibility.js';

interface TimelineEntryProps {
  readonly onEdit?: () => Promise<void>;
  readonly entryKey: string;
  readonly timestamp: string;
  readonly sent: boolean;
  readonly inspected: boolean;
  readonly inspect?: () => void;
  readonly sequence: number;
  readonly children: ReactNode;
  readonly selection?: 'available' | 'selected' | 'unselected';
  readonly selectionLabel?: string;
  readonly onSelect?: (extend: boolean) => void;
}
const interactive = 'a, button, input, select, textarea, summary, label, [role="button"], [contenteditable="true"]';

export function TimelineEntry({ onEdit, entryKey, timestamp, sent, inspected, inspect, sequence, children, selection, selectionLabel = 'Select', onSelect }: TimelineEntryProps) {
  const selecting = !!onSelect && (selection === 'selected' || selection === 'unselected');
  const startSelection = onSelect && selection === 'available' ? <button type="button" className="agent-select-entry" aria-label={`${selectionLabel} this message`} title={`${selectionLabel}: select messages`}
    onClick={() => onSelect(false)}><svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M4 6h5v5H6.5L4 14V6Zm7 0h5v5h-2.5L11 14V6Z" /></svg></button> : null;
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState<string>();
  const editButton = onEdit ? <button type="button" data-prompt-edit-action className="agent-edit-prompt" aria-label="Edit from this message" title="Edit from this message in a new branch" disabled={editing} onClick={() => {
    setEditing(true); setEditError(undefined); void onEdit().catch(error => setEditError(error instanceof Error ? error.message : 'Prompt editing failed.')).finally(() => setEditing(false));
  }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 4-5 5 5 5M4 9h10a6 6 0 0 1 0 12" /></svg></button> : null;
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
  const { ref, reveal } = useTimelineTimeSwipe(!!localTime, sent ? -1 : 1, !!onEdit);
  return <div ref={ref} className="agent-timeline-entry" data-entry-key={entryKey}
    data-inspected={inspected || undefined} tabIndex={inspect || inspected ? -1 : undefined}
    data-prompt-editable={!!onEdit || undefined}
    data-selecting={selecting || undefined} data-selected={selection === 'selected' || undefined}
    // Shift-click would extend the page's text selection instead of selecting a range of messages.
    onMouseDown={selecting ? event => { if (event.shiftKey && !(event.target instanceof Element && event.target.closest(interactive))) event.preventDefault(); } : undefined}
    onClick={selecting ? event => {
      // While selecting, a click anywhere on the message toggles it, except on its own controls or after selecting its text.
      if (event.target instanceof Element && event.target.closest(interactive) || !event.shiftKey && window.getSelection()?.toString()) return;
      onSelect!(event.shiftKey);
    } : undefined}
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
    {selecting ? <button type="button" role="checkbox" className="agent-entry-checkbox" aria-checked={selection === 'selected'}
      aria-label={`Select message #${sequence}`} onClick={event => { event.stopPropagation(); onSelect!(event.shiftKey); }} /> : null}
    {inspect || editButton || startSelection ? <span className="agent-entry-actions">
    {startSelection}
    {editButton ? <span className="agent-entry-edit-desktop">{editButton}</span> : null}
    {inspect ? <button className="agent-inspect-entry" type="button" aria-label={`Inspect event #${sequence} in Trace`} title="Inspect in Trace" onClick={inspect}>
      <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 4h5m-5 6h5m-5 6h5M5 4v12m6-6h6m-3-3 3 3-3 3" /></svg>
    </button> : null}
    </span> : null}
    {localTime ? <div className="agent-entry-time"><time dateTime={timestamp} aria-label={`${localTime.date} ${localTime.time} (local time)`}>
      <span>{localTime.date}</span><span>{localTime.time}</span>
    </time>{editButton}</div> : null}
    {editError ? <p className="agent-edit-prompt-error" role="alert">{editError}</p> : null}
    <TimelineTimeContext.Provider value={timeContext}>
      <div className="agent-entry-content">{children}</div>
    </TimelineTimeContext.Provider>
  </div>;
}
