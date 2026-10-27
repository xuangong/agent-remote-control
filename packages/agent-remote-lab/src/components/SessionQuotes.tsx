import { useEffect, useId, useState } from 'react';
import { excerptMessageCount } from '@orchardworks/agent-remote-web/react';
import { removeQuotes, useViewQuotes } from '../session-quotes.js';
import './session-quotes.css';

/** A session view that can receive a quote, located by its Window and session. */
export interface QuoteTarget { viewId: string; title: string; detail?: string }
export interface QuoteTargetWindow { id: string; title: string; current: boolean; views: readonly QuoteTarget[] }
/** A new session in the source's workspace, opened beside it in the current Window. */
export const NEW_SESSION_TARGET = 'new-session';

/** Starts selecting this view's messages; an icon, so it keeps the session toolbar one row high. */
export function QuoteMessagesButton({ onClick }: { onClick(): void }) {
  return <button type="button" className="lab-quote-trigger" aria-label="Quote messages" title="Select messages to quote in another session view" onClick={onClick}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 11H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v4c0 3-1.5 5-4 6M19 11h-4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v4c0 3-1.5 5-4 6" />
    </svg>
  </button>;
}

/** Shown in the view whose messages are being selected: the count, where to quote them, and the action. */
export function QuoteSelectionBar({ count, windows, busy, error, onQuote, onCancel }: {
  count: number; windows: readonly QuoteTargetWindow[]; busy: boolean; error?: string;
  onQuote(target: { windowId: string; viewId: string }): void; onCancel(): void;
}) {
  const label = useId();
  const current = windows.find(window => window.current) ?? windows[0];
  const [windowId, setWindowId] = useState(current?.id ?? '');
  const window = windows.find(item => item.id === windowId) ?? current;
  const options = [...(window?.views ?? []), ...(window?.current ? [{ viewId: NEW_SESSION_TARGET, title: 'New session in this workspace' }] : [])];
  const [viewId, setViewId] = useState('');
  const view = options.find(option => option.viewId === viewId) ?? options[0];
  useEffect(() => { if (!windows.some(item => item.id === windowId) && current) setWindowId(current.id); }, [windows, windowId, current]);
  return <section className="lab-quote-bar" aria-labelledby={label}>
    <p id={label} role="status">{count ? `${count} ${count === 1 ? 'message' : 'messages'} selected` : 'Select the messages to quote'}<small>Shift-click selects a range.</small></p>
    <div className="lab-quote-target">
      <label>Window<select value={window?.id ?? ''} disabled={busy} onChange={event => { setWindowId(event.target.value); setViewId(''); }}>
        {windows.map(item => <option key={item.id} value={item.id}>{item.current ? `${item.title} (this Window)` : item.title}</option>)}
      </select></label>
      <label>Session view<select value={view?.viewId ?? ''} disabled={busy || !options.length} onChange={event => setViewId(event.target.value)}>
        {options.map(option => <option key={option.viewId} value={option.viewId}>{'detail' in option && option.detail ? `${option.title} · ${option.detail}` : option.title}</option>)}
      </select></label>
    </div>
    <div className="lab-quote-actions">
      <button type="button" className="lab-favorite-primary" disabled={busy || !count || !window || !view} onClick={() => onQuote({ windowId: window!.id, viewId: view!.viewId })}>{busy ? 'Quoting…' : 'Quote'}</button>
      <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}

/** After quoting into a view the page does not show, where the quote went. */
export function QuoteNotice({ message, onOpen, onDismiss }: { message: string; onOpen?(): void; onDismiss(): void }) {
  return <p className="lab-quote-notice" role="status">{message}
    {onOpen ? <button type="button" onClick={onOpen}>Open</button> : null}
    <button type="button" aria-label="Dismiss" onClick={onDismiss}>×</button></p>;
}

/** The quotes waiting in a view's composer; the next message carries them. */
export function QuoteAttachments({ scope, viewId }: { scope: string; viewId: string }) {
  const excerpts = useViewQuotes(scope, viewId);
  if (!excerpts.length) return null;
  return <ul className="lab-quote-attachments" aria-label="Quotes for the next message">
    {excerpts.map(excerpt => {
      const count = excerptMessageCount(excerpt);
      return <li key={excerpt.id}>
        <span className="lab-quote-attachment-kicker">Quote</span>
        <span className="lab-quote-attachment-title" title={excerpt.source.title}>{excerpt.source.title || 'Untitled session'}</span>
        <span className="lab-quote-attachment-count">{count} {count === 1 ? 'message' : 'messages'}</span>
        <button type="button" aria-label={`Remove quote from ${excerpt.source.title || 'untitled session'}`} title="Remove quote" onClick={() => removeQuotes(scope, viewId, [excerpt.id])}>×</button>
      </li>;
    })}
  </ul>;
}
