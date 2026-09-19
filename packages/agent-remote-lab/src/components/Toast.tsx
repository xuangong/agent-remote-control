import { useVisualViewport } from '../hooks/useVisualViewport.js';
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

type ToastTone = 'info' | 'error';
interface ToastMessage { id: string; title: string; message: string; tone: ToastTone; revision: number }
interface ToastService {
  show(id: string, title: string, message: string, tone: ToastTone): void;
  dismiss(id: string): void;
}
const ToastContext = createContext<ToastService | undefined>(undefined);

/** Transient notifications supplement persistent, actionable feedback at its source. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const viewport = useVisualViewport();
  const [messages, setMessages] = useState<ToastMessage[]>([]);
  const dismiss = useCallback((id: string) => setMessages(current => current.some(item => item.id === id) ? current.filter(item => item.id !== id) : current), []);
  const show = useCallback((id: string, title: string, message: string, tone: ToastTone) => {
    setMessages(current => {
      const prior = current.find(item => item.id === id);
      if (prior?.title === title && prior.message === message && prior.tone === tone) return current;
      return [...current.filter(item => item.id !== id), { id, title, message, tone, revision: (prior?.revision ?? 0) + 1 }].slice(-3);
    });
  }, []);
  const service = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  return <ToastContext.Provider value={service}>{children}
    <section ref={viewport} className="lab-toast-region" aria-label="Notifications">
      {messages.map(message => <Toast key={`${message.id}:${message.revision}`} value={message} dismiss={dismiss} />)}
    </section>
  </ToastContext.Provider>;
}

/** A stable source updates one toast; polling the same failure never restarts its timer. */
export function useFeedbackToast(title: string, message: string | undefined, tone: ToastTone = 'error'): void {
  const service = useContext(ToastContext);
  const id = useId();
  useEffect(() => {
    if (message) service?.show(id, title, message, tone);
    else service?.dismiss(id);
  }, [service, id, title, message, tone]);
  useEffect(() => () => service?.dismiss(id), [service, id]);
}

function Toast({ value, dismiss }: { value: ToastMessage; dismiss(id: string): void }) {
  const previousFocus = useRef(document.activeElement);
  const close = () => {
    dismiss(value.id);
    if (previousFocus.current instanceof HTMLElement && previousFocus.current.isConnected) previousFocus.current.focus({ preventScroll: true });
  };
  const duration = value.tone === 'error' ? 10000 : 6000;
  const [remaining, setRemaining] = useState(duration);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(document.visibilityState === 'hidden');
  const paused = hovered || focused || hidden;
  useEffect(() => {
    const update = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  useEffect(() => {
    if (paused) return;
    let last = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now(), elapsed = now - last;
      last = now; setRemaining(value => Math.max(0, value - elapsed));
    }, 250);
    return () => window.clearInterval(timer);
  }, [paused]);
  useEffect(() => { if (remaining === 0) dismiss(value.id); }, [remaining, dismiss, value.id]);
  return <div className="lab-toast" data-tone={value.tone} role="status" aria-live="polite" aria-atomic="true"
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
    <div className="lab-toast-heading"><strong>{value.title}</strong>
      <button type="button" aria-label={`Dismiss notification: ${value.title}`} onClick={close}>×</button>
    </div>
    <p>{value.message}</p>
    <span className="lab-toast-countdown" aria-hidden="true">{paused ? 'Auto-dismiss paused' : `Closes in ${Math.ceil(remaining / 1000)}s`}</span>
    <div className="lab-toast-progress" aria-hidden="true"><span style={{ width: `${remaining / duration * 100}%` }} /></div>
  </div>;
}
