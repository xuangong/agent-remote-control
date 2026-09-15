import { useEffect, useRef, useState, type RefObject } from 'react';

interface ViewOptionsProps {
  triggerRef: RefObject<HTMLButtonElement>;
  headerVisible: boolean;
  sidebarVisible: boolean;
  inspectorVisible: boolean;
  compact: boolean;
  inert: boolean;
  simpleConversation?: boolean;
  onToggleSimpleConversation?(): void;
  onSetAllVisible(visible: boolean): void;
  onToggleHeader(): void;
  onToggleSidebar(): void;
  onToggleInspector(): void;
}

export function ViewOptions({ triggerRef, headerVisible, sidebarVisible, inspectorVisible, compact, inert, simpleConversation, onToggleSimpleConversation, onSetAllVisible, onToggleHeader, onToggleSidebar, onToggleInspector }: ViewOptionsProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
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

  return <div ref={containerRef} className="lab-view-options" {...(inert ? { inert: '' } : {})}
    onBlur={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={(event) => {
      if (event.key === 'Escape' && open) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
      }
    }}>
    <button ref={triggerRef} type="button" className="lab-view-options-trigger" aria-label="View options"
      aria-expanded={open} aria-controls="lab-view-options-panel" title="View options" onClick={() => setOpen((value) => !value)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="3" /><path d="M3 9h18M9 9v12" />
      </svg>
      <span>View</span>
    </button>
    {open ? <section id="lab-view-options-panel" className="lab-view-options-panel" aria-label="View options">
      {onToggleSimpleConversation ? <label><span>Simple conversation view</span><input type="checkbox" aria-label="Simple conversation view" checked={simpleConversation ?? false} onChange={onToggleSimpleConversation} /></label> : null}
      <div className="lab-view-options-heading">
        <p>Panels</p>
        <div className="lab-view-options-actions">
          {!compact ? <button type="button" onClick={() => onSetAllVisible(true)}>Show all</button> : null}
          <button type="button" onClick={() => onSetAllVisible(false)}>Hide all</button>
        </div>
      </div>
      <label><span>Header</span><input type="checkbox" checked={headerVisible} onChange={onToggleHeader} /></label>
      <label><span>Sidebar</span><input type="checkbox" aria-controls="lab-context" checked={sidebarVisible} onChange={() => togglePanel(onToggleSidebar)} /></label>
      <label><span>Replica Inspector</span><input type="checkbox" aria-controls="lab-inspector" checked={inspectorVisible} onChange={() => togglePanel(onToggleInspector)} /></label>
    </section> : null}
  </div>;
}
