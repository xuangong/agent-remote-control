import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { OpenedSession } from '../directory-client.js';
import { sessionKey } from '../session-tree.js';
import { originalForkSource, currentForkSource, sideNavigationTarget, sideLinkPending, sideLinkVisible, type SessionFork } from '../session-forks.js';

export function ForkIcon() {
  return <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="4" cy="3" r="1.75" /><circle cx="12" cy="3" r="1.75" /><circle cx="4" cy="13" r="1.75" /><path d="M4 4.75v6.5M12 4.75v1a3 3 0 0 1-3 3H4" /></svg>;
}
type UnlinkSide = (fork: SessionFork) => Promise<void>;

export function ForkReference({ fork, onOpen, onUnlink, onRecover }: { fork: SessionFork; onOpen(session: OpenedSession): void; onUnlink?: UnlinkSide; onRecover?: UnlinkSide }) {
  if (!sideLinkVisible(fork)) return null;
  const currentSource = currentForkSource(fork);
  const contextId = fork.remote ? fork.nativeSourceRef?.nativeSessionId ?? fork.source.nativeSessionId : fork.source.nativeSessionId;
  const origin = fork.nativeSourceRef;
  const sourceKnown = !fork.remote || !origin || contextId === fork.source.nativeSessionId && origin.providerId === fork.source.providerId
    && !!fork.hostLocator && fork.hostLocator.hostId === (fork.source.hostId ?? 'local') && fork.hostLocator.controllerId === origin.controllerId;
  const contextTitle = sourceKnown ? fork.source.title : contextId;
  return <details className="lab-fork-reference">
    <summary className="agent-skill-tag" title={`Context from ${contextId}`}>
      <span className="lab-fork-symbol" aria-hidden="true">&amp;<span><ForkIcon /></span></span>
      <span className="lab-fork-title">{contextTitle}</span>
    </summary>
    <div className="lab-fork-reference-details">
      <strong>Context from {contextTitle}</strong>
      {fork.mode === 'reference' ? <p>Source reference · Read on demand. New source messages may be read.</p> : <>
      <p>Fixed snapshot · {fork.itemCount} items · {new Date(fork.capturedAt).toLocaleString()}</p>
      <p>Later source messages are not included.</p>
      {fork.shortenedToolCount ? <p>{fork.shortenedToolCount} tool records shortened. User and assistant messages are preserved.</p> : null}
      <small>Boundary {fork.boundary.epoch} / {fork.boundary.seq}</small>
      </>}
      <code>{contextId}</code>
      {sourceKnown ? <button type="button" onClick={() => onOpen(originalForkSource(fork))}>Open source session</button> : null}
      {!sourceKnown || sessionKey(currentSource) !== sessionKey(fork.source) ? <button type="button" onClick={() => onOpen(currentSource)}>Open current source session</button> : null}
      {onUnlink ? <UnlinkAction fork={fork} onUnlink={onUnlink} onRecover={onRecover} /> : null}
    </div>
  </details>;
}
export function ForkEntries({ forks, onOpen, onUnlink, onRecover, selectedChild }: { forks: readonly SessionFork[]; onOpen(fork: SessionFork): void; onUnlink?: UnlinkSide; onRecover?: UnlinkSide; selectedChild?: string | null }) {
  const linked = forks.filter(sideLinkVisible);
  if (!linked.length) return null;
  return <nav className="lab-fork-entries" aria-label="Forked sessions"><span className="lab-side-list-label">Sides · {linked.length}</span>{linked.map((fork, index) =>
    <ForkEntry key={fork.id} fork={fork} index={index} selectedChild={selectedChild} onOpen={onOpen} onUnlink={onUnlink} onRecover={onRecover} />)}</nav>;
}

function ForkEntry({ fork, index, selectedChild, onOpen, onUnlink, onRecover }: { fork: SessionFork; index: number; selectedChild?: string | null; onOpen(fork: SessionFork): void; onUnlink?: UnlinkSide; onRecover?: UnlinkSide }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const target = sideNavigationTarget(fork);
  const label = `Side ${index + 1} · ${fork.firstInput?.trim().slice(0, 72) || target?.title || 'New session'}`;
  const close = useCallback(() => { setOpen(false); trigger.current?.focus({ preventScroll: true }); }, []);
  const dismiss = useCallback(() => setOpen(false), []);
  return <span className="lab-fork-entry">
    <button type="button" aria-pressed={!!target && selectedChild === sessionKey(target)} title={label} onClick={() => onOpen(fork)}><ForkIcon /><span>{label}</span></button>
    {onUnlink ? <>
      <button type="button" className="lab-fork-menu-trigger" ref={trigger} aria-label={`Actions for ${label}`} title={`Actions for ${label}`}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen(value => !value)}>⋯</button>
      {open ? <ForkMenu id={menuId} label={`Actions for ${label}`} trigger={trigger} close={close} dismiss={dismiss}>
        <UnlinkAction fork={fork} onUnlink={onUnlink} onRecover={onRecover} onComplete={close} menu />
      </ForkMenu> : null}
    </> : null}
  </span>;
}

function ForkMenu({ id, label, trigger, close, dismiss, children }: { id: string; label: string; trigger: RefObject<HTMLButtonElement>; close(): void; dismiss(): void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = panel.current, button = trigger.current;
    if (!element || !button) return;
    const position = () => {
      const anchor = button.getBoundingClientRect();
      const bounds = element.getBoundingClientRect();
      element.style.left = `${Math.max(8, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 8))}px`;
      element.style.top = `${Math.max(8, anchor.top - bounds.height - 6)}px`;
    };
    position();
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(position);
    resize?.observe(element);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => { resize?.disconnect(); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [trigger]);
  useEffect(() => {
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !trigger.current?.contains(event.target)) dismiss();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [trigger, dismiss]);
  return createPortal(<div ref={panel} id={id} className="lab-fork-menu" role="menu" aria-label={label}
    onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
    onBlur={event => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget) && !trigger.current?.contains(event.relatedTarget)) dismiss(); }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
    {children}
  </div>, document.body);
}

function UnlinkAction({ fork, onUnlink, onRecover, onComplete, menu = false }: { fork: SessionFork; onUnlink: UnlinkSide; onRecover?: UnlinkSide; onComplete?(): void; menu?: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const recovering = sideLinkPending(fork);
  const unlink = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setPending(true); setError(undefined);
    try { if (recovering) { if (!onRecover) throw new Error('Refresh workspace access before retrying this link change.'); await onRecover(fork); } else await onUnlink(fork); onComplete?.(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Unable to unlink this side session. Try again.'); }
    finally { inFlight.current = false; setPending(false); }
  };
  return <>
    <button type="button" className="lab-fork-unlink" role={menu ? 'menuitem' : undefined} disabled={pending} onClick={() => void unlink()}>{pending ? recovering ? 'Checking link change…' : 'Unlinking…' : recovering ? 'Retry link change' : 'Unlink side session'}</button>
    {recovering ? <p className="lab-control-note" role="status">Link change pending confirmation.</p> : null}
    {error ? <p className="lab-fork-action-error" role="alert">{error}</p> : null}
  </>;
}
