import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslate } from '@orchardworks/agent-client-web/react';

interface ViewOptionsProps {
  target?: HTMLElement | null;
  attentionControls?: ReactNode;
  triggerRef: RefObject<HTMLButtonElement>;
  headerVisible: boolean;
  sidebarVisible: boolean;
  inspectorVisible: boolean;
  compact: boolean;
  inert: boolean;
  onSetAllVisible(visible: boolean): void;
  onToggleHeader(): void;
  onToggleSidebar(): void;
  onToggleInspector(): void;
}

export function ViewOptions({ attentionControls, target, triggerRef, headerVisible, sidebarVisible, inspectorVisible, compact, inert, onSetAllVisible, onToggleHeader, onToggleSidebar, onToggleInspector }: ViewOptionsProps) {
  const t = useTranslate();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const focusedControl = useRef<string>();
  useLayoutEffect(() => {
    if (focusedControl.current && !inert) {
      containerRef.current?.querySelector<HTMLElement>(`[data-view-control="${focusedControl.current}"]`)?.focus({ preventScroll: true });
    }
  }, [target]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);

  function togglePanel(toggle: () => void): void {
    // A compact rail owns focus until it restores the persistent View trigger.
    if (compact) setOpen(false);
    toggle();
  }

  const controls = <div ref={containerRef} className="lab-view-options" {...(inert ? { inert: '' } : {})}
    onFocusCapture={event => { focusedControl.current = (event.target as HTMLElement).dataset.viewControl; }}
    onBlur={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) { focusedControl.current = undefined; setOpen(false); } }}
    onKeyDown={(event) => {
      if (event.key === 'Escape' && open) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
      }
    }}>
    <button ref={triggerRef} data-view-control="trigger" type="button" className="lab-view-options-trigger" aria-label={t('navigation.viewOptions.label')}
      aria-expanded={open} aria-controls="lab-view-options-panel" title={t('navigation.viewOptions.label')} onClick={() => setOpen((value) => !value)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="3" /><path d="M3 9h18M9 9v12" />
      </svg>
      <span>{t('navigation.viewOptions.view')}</span>
    </button>
    {open ? <section id="lab-view-options-panel" className="lab-view-options-panel" aria-label={t('navigation.viewOptions.label')} tabIndex={-1} data-view-control="panel">
      <div className="lab-view-options-heading">
        <p>{t('navigation.viewOptions.panels')}</p>
        <div className="lab-view-options-actions">
          {!compact ? <button type="button" data-view-control="show-all" onClick={() => onSetAllVisible(true)}>{t('navigation.viewOptions.showAll')}</button> : null}
          <button type="button" data-view-control="hide-all" onClick={() => onSetAllVisible(false)}>{t('navigation.viewOptions.hideAll')}</button>
        </div>
      </div>
      <label><span>{t('navigation.viewOptions.header')}</span><input data-view-control="header" type="checkbox" checked={headerVisible} onChange={onToggleHeader} /></label>
      <label><span>{t('navigation.viewOptions.sidebar')}</span><input data-view-control="sidebar" type="checkbox" aria-controls="lab-context" checked={sidebarVisible} onChange={() => togglePanel(onToggleSidebar)} /></label>
      <label><span>{t('navigation.viewOptions.replicaInspector')}</span><input data-view-control="inspector" type="checkbox" aria-controls="lab-inspector" checked={inspectorVisible} onChange={() => togglePanel(onToggleInspector)} /></label>
      {attentionControls}
    </section> : null}
  </div>;
  return target === null ? null : target ? createPortal(controls, target) : controls;
}
