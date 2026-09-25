import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SessionStars } from '../../hooks/useSessionStars.js';
import type { VisibleSessionStar } from '../../session-stars-client.js';
import { SessionDirectoryClient } from '../../directory-client.js';

export function RenameSessionDialog({ favorites, session, onClose }: { favorites: SessionStars; session: VisibleSessionStar; onClose(): void }) {
  const providerName = session.providerId === 'codex' ? 'Codex' : session.providerId === 'copilot' ? 'GitHub Copilot' : session.providerId === 'claude' ? 'Claude Code' : session.providerId === 'opencode' ? 'OpenCode' : session.providerId;
  const dialog = useRef<HTMLDialogElement>(null), label = useId();
  const [title, setTitle] = useState(session.title), [saving, setSaving] = useState(false), [error, setError] = useState<string>();
  const intent = useRef<{ title: string; operationId: string }>();
  const inFlight = useRef(false), mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const focus = document.activeElement as HTMLElement | null;
    dialog.current?.showModal(); dialog.current?.querySelector('input')?.select();
    return () => { mounted.current = false; if (focus?.isConnected) focus.focus({ preventScroll: true }); };
  }, []);
  async function save() {
    const name = title.trim();
    if (inFlight.current || !name) return;
    if (name === session.title && !intent.current) { onClose(); return; }
    if (intent.current?.title !== name) intent.current = { title: name, operationId: crypto.randomUUID() };
    inFlight.current = true; setSaving(true); setError(undefined);
    try {
      const directory = new SessionDirectoryClient(favorites.scope, undefined, session.hostId);
      await directory.rename(session.providerId, session.nativeSessionId, name, intent.current.operationId);
      await favorites.refresh();
      if (mounted.current) onClose();
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : 'The session name could not be confirmed. Retry to check the same change.');
    } finally { inFlight.current = false; if (mounted.current) setSaving(false); }
  }
  const close = () => { if (!inFlight.current) onClose(); };
  return createPortal(<dialog ref={dialog} className="lab-favorite-dialog" data-favorites-dialog aria-labelledby={label}
    onKeyDown={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()} onBlur={e => e.stopPropagation()}
    onCancel={e => { e.preventDefault(); close(); }} onClose={close}>
    <header><h2 id={label}>Rename session</h2><button type="button" aria-label="Close session name editor" disabled={saving} onClick={close}>×</button></header>
    <form onSubmit={e => { e.preventDefault(); void save(); }}>
      <label>Name<input autoFocus required maxLength={session.providerId === 'copilot' ? 100 : 512} value={title} disabled={saving} onChange={e => setTitle(e.target.value)} /></label>
      <p className="lab-control-note">Updates the session name in {providerName}, too.</p>
      {error ? <p role="alert" className="lab-control-note">{error}</p> : null}
      <footer><button type="button" disabled={saving} onClick={close}>Cancel</button><button type="submit" className="lab-favorite-primary" disabled={saving || !title.trim()}>{saving ? 'Saving…' : 'Save'}</button></footer>
    </form>
  </dialog>, document.body);
}
