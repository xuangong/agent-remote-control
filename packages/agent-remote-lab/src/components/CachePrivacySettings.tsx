import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { cacheProtectionState, setClearCacheOnClose, subscribeCacheProtection } from '../conversation-storage.js';

export function CachePrivacySettings() {
  const protection = useSyncExternalStore(subscribeCacheProtection, cacheProtectionState, cacheProtectionState);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const label = useId(), description = useId();
  async function change(next: boolean) {
    setError(false);
    try { await setClearCacheOnClose(next); setConfirming(false); }
    catch { setError(true); }
  }
  return <div className="lab-display-settings lab-cache-settings">
    <h2>Privacy on this device</h2>
    <div className="lab-cache-setting">
      <span id={label}>Clear chat cache on close</span>
      <button ref={trigger} type="button" role="switch" aria-checked={protection.enabled} aria-labelledby={label} aria-describedby={description}
        disabled={protection.clearing} onClick={() => { if (protection.enabled) void change(false); else setConfirming(true); }}>
        <span aria-hidden="true" />
      </button>
    </div>
    <p id={description}>{protection.enabled
      ? 'Chat data stays in this page only. Refreshing or closing loses local drafts and recovery data.'
      : 'Keep local chat data for faster reopening and draft recovery.'}</p>
    {protection.clearing ? <p role="status">Removing saved chat data…</p> : null}
    {protection.failed ? <p role="alert">Some saved data could not be removed. <button type="button" onClick={() => void change(true)}>Retry cleanup</button></p> : null}
    {error ? <p role="alert">The preference could not be saved. Check browser storage and try again.</p> : null}
    {confirming ? <CacheProtectionConfirmation onCancel={() => { setConfirming(false); trigger.current?.focus({ preventScroll: true }); }} onConfirm={() => void change(true)} busy={protection.clearing} error={error} /> : null}
  </div>;
}
function CacheProtectionConfirmation({ onCancel, onConfirm, busy, error }: { onCancel(): void; onConfirm(): void; busy: boolean; error: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const label = useId(), description = useId();
  useEffect(() => {
    const focus = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { if (focus?.isConnected) focus.focus({ preventScroll: true }); };
  }, []);
  return createPortal(<dialog ref={dialog} className="lab-favorite-dialog lab-cache-confirmation" aria-labelledby={label} aria-describedby={description}
    onKeyDown={event => event.stopPropagation()} onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <header><h2 id={label}>Keep chat data in this page only?</h2></header>
    <div className="lab-cache-confirmation-body" id={description}>
      <p><strong>Less left on this device.</strong> Removes saved chat content, text and image drafts, recent sessions, and tracking data. All open tabs stop saving new copies.</p>
      <p><strong>Less recovery.</strong> Refreshing, closing, or a system reload loses unsent drafts, images, and local send-status records. Conversations must load again. Switching apps alone keeps this page intact.</p>
      <p>Remote history and Favorites stay unchanged. This does not sign out: sign out before handing this device to someone else.</p>
    </div>
    {error ? <p role="alert">The preference could not be saved. Please try again.</p> : null}
    <footer><button type="button" autoFocus disabled={busy} onClick={onCancel}>Cancel</button><button type="button" className="lab-favorite-primary" disabled={busy} onClick={onConfirm}>{busy ? 'Clearing…' : 'Enable protection'}</button></footer>
  </dialog>, document.body);
}
