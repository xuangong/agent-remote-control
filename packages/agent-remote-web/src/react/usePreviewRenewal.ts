import { useEffect, useRef, useState } from 'react';
import { PreviewRequestError, type HttpPreviewClient, type PreviewRegistration } from '../client/preview-client.js';

interface RenewalIssue { message: string; terminal: boolean }

interface RetainedPreview { key: string; id: string; target: string; url?: string; error?: string }

export function usePreviewRenewal(client: HttpPreviewClient, hostId: string, canManage: boolean,
  entries: readonly RetainedPreview[], registrations: readonly PreviewRegistration[], refresh: () => Promise<void>) {
  const retained = new Map<string, RetainedPreview>();
  if (canManage) for (const entry of entries) {
    const registration = registrations.find(value => value.id === entry.id);
    if (entry.url && !entry.error && registration?.status !== 'unregistered' && !registration?.pendingUnregister && !retained.has(entry.id)) retained.set(entry.id, entry);
  }
  const current = useRef(retained);
  current.current = retained;
  const reconcile = useRef<() => void>(() => {});
  const [errors, setErrors] = useState<Record<string, RenewalIssue | undefined>>({});

  useEffect(() => {
    let disposed = false;
    const due = new Map<string, number>();
    const pending = new Map<string, AbortController>();
    const terminal = new Set<string>();
    setErrors({});
    const tick = () => {
      for (const [id, request] of pending) if (!current.current.has(id)) { request.abort(); pending.delete(id); }
      for (const id of due.keys()) if (!current.current.has(id)) due.delete(id);
      for (const id of terminal) if (!current.current.has(id)) terminal.delete(id);
      for (const [id, entry] of current.current) {
        if (terminal.has(id) || pending.has(id) || (due.get(id) ?? 0) > Date.now()) continue;
        const request = new AbortController();
        pending.set(id, request);
        const deadline = window.setTimeout(() => request.abort(), 20_000);
        const applicable = () => !disposed && current.current.get(id)?.key === entry.key && pending.get(id) === request;
        void client.renew(hostId, id, entry.target, request.signal).then(registration => {
          if (!applicable() || request.signal.aborted) return;
          due.set(id, Date.now() + Math.max(1000, Math.min(300_000, (registration.expiresAt - Date.now()) / 3)));
          setErrors(previous => ({ ...previous, [id]: undefined }));
          void refresh();
        }).catch(cause => {
          if (!applicable()) return;
          const removed = cause instanceof PreviewRequestError && cause.status === 409;
          if (removed) terminal.add(id);
          else due.set(id, Date.now() + 5000);
          setErrors(previous => ({ ...previous, [id]: {
            terminal: removed,
            message: removed ? 'This preview registration is no longer available or has been unregistered. Close and open it again.'
              : 'Preview renewal is waiting for the connection. Retrying automatically…',
          } }));
        }).finally(() => {
          window.clearTimeout(deadline);
          if (pending.get(id) === request) pending.delete(id);
        });
      }
    };
    reconcile.current = tick;
    const wake = () => { due.clear(); tick(); };
    const visible = () => { if (document.visibilityState === 'visible') wake(); };
    const timer = window.setInterval(tick, 1000);
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', wake);
    tick();
    return () => {
      disposed = true; reconcile.current = () => {};
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('online', wake);
      window.removeEventListener('pageshow', wake);
      for (const request of pending.values()) request.abort();
    };
  }, [client, hostId, canManage, refresh]);

  useEffect(() => { reconcile.current(); }, [entries, registrations, canManage]);
  return errors;
}
