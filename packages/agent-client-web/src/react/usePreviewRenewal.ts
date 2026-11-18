import { watchPagePolling } from '../client/page-polling.js';
import { useEffect, useRef, useState } from 'react';
import { PreviewRequestError, type HttpPreviewClient, type PreviewRegistration } from '../client/preview-client.js';

interface RenewalIssue { message: string; terminal: boolean }

interface RetainedPreview { hostId?: string; registration?: PreviewRegistration; key: string; id: string; target: string; url?: string; error?: string }

export function previewRegistrationKey(hostId: string, id: string): string { return JSON.stringify([hostId, id]); }

export function usePreviewRenewal(client: HttpPreviewClient, hostId: string, canManage: boolean,
  entries: readonly RetainedPreview[], registrations: readonly PreviewRegistration[], refresh: () => Promise<void>) {
  const retained = new Map<string, RetainedPreview>();
  if (canManage) for (const entry of entries) {
    const registration = entry.registration ?? registrations.find(value => value.id === entry.id);
    const key = previewRegistrationKey(entry.hostId ?? hostId, entry.id);
    if (entry.url && !entry.error && registration?.status !== 'unregistered' && !registration?.pendingUnregister && !retained.has(key)) retained.set(key, entry);
  }
  const hasRetained = retained.size > 0;
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
        void client.renew(entry.hostId ?? hostId, entry.id, entry.target, request.signal).then(registration => {
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
    const wake = () => { due.clear(); if (document.visibilityState !== 'hidden') tick(); };
    const visible = () => { if (document.visibilityState === 'visible') wake(); };
    const stopPolling = hasRetained ? watchPagePolling(tick, 1000) : () => {};
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', wake);
    if (document.visibilityState !== 'hidden') tick();
    return () => {
      disposed = true; reconcile.current = () => {};
      stopPolling();
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('online', wake);
      window.removeEventListener('pageshow', wake);
      for (const request of pending.values()) request.abort();
    };
  }, [client, hostId, canManage, refresh, hasRetained]);

  useEffect(() => { if (document.visibilityState !== 'hidden') reconcile.current(); }, [entries, registrations, canManage]);
  return errors;
}
