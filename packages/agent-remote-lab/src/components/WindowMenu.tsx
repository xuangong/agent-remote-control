import { useEffect, useId, useRef, useState } from 'react';
import type { WindowSessionBinding } from '@orchardworks/agent-remote-protocol';
import type { useWindowWorkspace } from '../hooks/useWindowWorkspace.js';
import { useTrackingPosition } from '../hooks/useTrackingPosition.js';
import { WindowWorkspaces } from './WindowWorkspaces.js';

/** The floating entry manages presentation; hiding it does not change the Window. */
export function WindowMenu({ workspace, current, visible, inert = false }: {
  workspace: ReturnType<typeof useWindowWorkspace>; current?: WindowSessionBinding; visible: boolean; inert?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { root, style, handlers, edge } = useTrackingPosition('agent-remote:window-position');
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const expanded = open && visible && !inert;
  const count = new Set([...workspace.windows.map(window => window.id), ...(workspace.window ? [workspace.window.id] : [])]).size;
  useEffect(() => { if (!visible || inert) setOpen(false); }, [visible, inert]);
  useEffect(() => {
    if (!expanded) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [expanded, root]);
  function close() { setOpen(false); trigger.current?.focus({ preventScroll: true }); }
  return <div ref={root} className="lab-tracking-floating lab-window-floating" data-edge={edge} style={style} {...handlers}
    data-hidden={!visible || undefined} data-open={expanded || undefined} aria-hidden={!visible || undefined}
    {...(!visible || inert ? { inert: '' } : {})}
    onKeyDown={event => { if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); close(); } }}>
    <button ref={trigger} type="button" className="lab-session-popover-trigger" aria-label="Windows" aria-expanded={expanded}
      aria-controls={panelId} onClick={() => setOpen(value => !value)}>
      <span>Window</span><span>{count}</span>
    </button>
    <section id={panelId} className="lab-session-popover-panel lab-window-panel" aria-label="Windows" hidden={!expanded}>
      <div className="lab-directory-heading"><h2>Windows</h2><button type="button" aria-label="Close Windows" onClick={close}>×</button></div>
      <div className="lab-window-panel-scroll"><WindowWorkspaces workspace={workspace} current={current} active={expanded} /></div>
    </section>
  </div>;
}
