import { useEffect, useId, useRef, useState } from 'react';
import type { TimelineDisplayMode } from '@orchardworks/agent-remote-web/react';

export interface SessionDisplayPreferences {
  mode: TimelineDisplayMode;
  lettersVisible: boolean;
}

const modes = [
  { value: 'preview', label: 'Preview' },
  { value: 'simple', label: 'Simple conversation' },
  { value: 'content', label: 'Content only' },
] as const;

export function SessionViewOptions({ preferences, onChange }: {
  preferences: SessionDisplayPreferences;
  onChange(preferences: SessionDisplayPreferences): void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  return <div className="lab-session-view-options" ref={container}
    onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={event => {
      if (event.key === 'Escape' && open) {
        event.preventDefault(); event.stopPropagation(); setOpen(false);
        trigger.current?.focus({ preventScroll: true });
      }
    }}>
    <button type="button" ref={trigger} className="lab-session-view-options-trigger"
      aria-label="Session view options" aria-expanded={open} aria-controls={id}
      title={`View: ${modes.find(mode => mode.value === preferences.mode)?.label}`}
      onClick={() => setOpen(value => !value)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
        <path d="M4 6h16M4 12h10M4 18h16" /><path d="m18 10 3 2-3 2" />
      </svg>
      <span>View</span>
    </button>
    {open ? <section id={id} className="lab-session-view-options-panel" aria-label="Session view options" tabIndex={-1}>
      <fieldset><legend>Display</legend>
        {modes.map(mode => <label key={mode.value}>
          <span>{mode.label}</span>
          <input type="radio" name={`session-display-${id}`} value={mode.value} checked={preferences.mode === mode.value}
            onChange={() => onChange({ ...preferences, mode: mode.value })} />
        </label>)}
      </fieldset>
      <label className="lab-session-letters-option"><span>Show letters</span>
        <input type="checkbox" aria-label="Show letters" checked={preferences.lettersVisible}
          onChange={event => onChange({ ...preferences, lettersVisible: event.target.checked })} />
      </label>
    </section> : null}
  </div>;
}
