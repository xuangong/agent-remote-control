import { useEffect, useId, useRef, useState } from 'react';
import { PROCESS_MODES, type ProcessMode } from '@orchardworks/agent-client';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { SegmentedControl } from '@orchardworks/agent-client-web/primitives';
import { useSessionMenuLayer } from '../kernel/useSessionMenuLayer.js';
import type { ProcessModeChoice } from './useProcessMode.js';

/**
 * The conversation's view options: how much of each turn's work shows for this assistant. The default for every assistant
 * on this device, and whether letters between agents show, are in Settings > Assistants.
 */
export function SessionViewOptions({ process }: { process: ProcessModeChoice }) {
  const t = useTranslate();
  const [open, setOpen] = useState(false);
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  useSessionMenuLayer(panel, trigger, open);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  if (!process.chooseForAssistant) return null;
  const options = PROCESS_MODES.map(mode => ({ value: mode, label: t(`process.${mode}` as const) }));
  return <div className="lab-session-view-options" ref={container}
    onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={event => {
      if (event.key === 'Escape' && open) {
        event.preventDefault(); event.stopPropagation(); setOpen(false);
        trigger.current?.focus({ preventScroll: true });
      }
    }}>
    <button type="button" ref={trigger} className="lab-session-view-options-trigger"
      aria-label={t('navigation.viewOptions.session')} aria-expanded={open} aria-controls={id}
      title={`${t('process.heading')}: ${t(`process.${process.mode}` as const)}`}
      onClick={() => setOpen(value => !value)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
        <path d="M4 6h16M4 12h10M4 18h16" /><path d="m18 10 3 2-3 2" />
      </svg>
      <span>{t('navigation.viewOptions.view')}</span>
    </button>
    {open ? <section ref={panel} id={id} className="lab-session-view-options-panel" aria-label={t('navigation.viewOptions.session')} tabIndex={-1}>
      <p className="lab-session-view-options-heading">{t('process.heading')}</p>
      {process.chooseForAssistant ? <div className="lab-process-choice">
        <span id={`${id}-assistant`}>{t('process.assistant')}</span>
        <SegmentedControl<ProcessMode> label={t('process.assistant')} options={options} value={process.mode} onChange={process.chooseForAssistant} />
      </div> : null}
    </section> : null}
  </div>;
}
