import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentCommand, AgentCommandResult } from '@orchardworks/agent-remote-protocol';
import type { SessionEntry } from '../session-tree.js';
import { SessionAttentionNotifications } from '../session-notifications.js';
import type { SessionObservation } from '../tracking-state.js';

export const TrackViewCommand = { id: 'console:track', name: 'track', kind: 'command', description: 'Toggle Track view; use /track on or /track off', inputHint: '[on|off]' } satisfies AgentCommand;
export const TrackViewScope = createContext<((args: string) => Promise<AgentCommandResult>) | undefined>(undefined);
const trackKey = 'agent-remote:track-view';
const notificationKey = 'agent-remote:desktop-notifications';
function preference(key: string): boolean | undefined {
  try { const value = localStorage.getItem(key); return value === 'true' ? true : value === 'false' ? false : undefined; }
  catch { return undefined; }
}
function save(key: string, value: boolean): void { try { localStorage.setItem(key, String(value)); } catch { /* Page-local preferences remain usable. */ } }
function permission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

export function useSessionAttention(scope: string, active: boolean, onOpen: (session: SessionEntry) => void) {
  const [mobile, setMobile] = useState(() => window.matchMedia?.('(pointer: coarse)').matches ?? false);
  const [trackChoice, setTrackChoice] = useState(() => preference(trackKey));
  const [notificationChoice, setNotificationChoice] = useState(() => preference(notificationKey) ?? true);
  const [notificationPermission, setPermission] = useState(permission);
  const [permissionError, setPermissionError] = useState(false);
  const latest = useRef({ active, mobile, notificationChoice, onOpen });
  latest.current = { active, mobile, notificationChoice, onOpen };
  const notifier = useMemo(() => new SessionAttentionNotifications(scope,
    () => latest.current.active && !latest.current.mobile && latest.current.notificationChoice,
    session => latest.current.onOpen(session)), [scope]);
  const mountedNotifier = useRef<SessionAttentionNotifications>();
  useEffect(() => {
    mountedNotifier.current = notifier;
    return () => {
      mountedNotifier.current = undefined;
      queueMicrotask(() => { if (mountedNotifier.current !== notifier) notifier.dispose(); });
    };
  }, [notifier]);
  useEffect(() => {
    const media = window.matchMedia?.('(pointer: coarse)');
    const resize = () => setMobile(media?.matches ?? false);
    media?.addEventListener('change', resize);
    const refresh = () => { setPermission(permission()); setTrackChoice(preference(trackKey)); setNotificationChoice(preference(notificationKey) ?? true); };
    window.addEventListener('storage', refresh); window.addEventListener('focus', refresh);
    return () => { media?.removeEventListener('change', resize); window.removeEventListener('storage', refresh); window.removeEventListener('focus', refresh); };
  }, []);
  const entryRequest = useRef(false);
  const gestureRequest = useRef(false);
  const requestingPermission = useRef(false);
  const requestPermission = useCallback(async () => {
    if (permission() !== 'default') { setPermission(permission()); return; }
    if (requestingPermission.current) return;
    entryRequest.current = true; requestingPermission.current = true; setPermissionError(false);
    try {
      await Notification.requestPermission();
      // A blocked automatic request can return denied while site permission remains default.
      setPermission(permission());
    } catch { setPermissionError(true); }
    finally { requestingPermission.current = false; }
  }, []);
  // Prepare permission on entry, before any session needs attention.
  useEffect(() => {
    if (active && !mobile && notificationChoice && notificationPermission === 'default' && !entryRequest.current) void requestPermission();
  }, [active, mobile, notificationChoice, notificationPermission, requestPermission]);
  // If automatic prompting is blocked, retry once with a trusted user gesture.
  useEffect(() => {
    if (!active || mobile || !notificationChoice || notificationPermission !== 'default') return;
    const request = (event: Event) => {
      if (!event.isTrusted || gestureRequest.current || requestingPermission.current) return;
      if (event instanceof KeyboardEvent && event.key !== 'Enter') return;
      gestureRequest.current = true;
      void requestPermission();
    };
    document.addEventListener('pointerup', request); document.addEventListener('keydown', request);
    return () => { document.removeEventListener('pointerup', request); document.removeEventListener('keydown', request); };
  }, [active, mobile, notificationChoice, notificationPermission, requestPermission]);
  const trackVisible = trackChoice ?? mobile;
  function setTrackVisible(value: boolean) { save(trackKey, value); setTrackChoice(value); }
  async function executeTrack(args: string): Promise<AgentCommandResult> {
    const arg = args.trim().toLowerCase();
    if (!['', 'on', 'off', 'enable', 'disable'].includes(arg)) throw new Error('Use /track, /track on, or /track off.');
    const next = arg ? arg === 'on' || arg === 'enable' : !trackVisible;
    setTrackVisible(next);
    return { text: `Track view ${next ? 'shown' : 'hidden'}.` };
  }
  const observe = useCallback((session: SessionEntry, value: SessionObservation) => { void notifier.observe(session, value); }, [notifier]);
  const controls = <>
    <label><span>Track view</span><input type="checkbox" checked={trackVisible} onChange={event => setTrackVisible(event.target.checked)} /></label>
    {!mobile ? <>
      <label><span>Session notifications</span><input type="checkbox" checked={notificationChoice} disabled={notificationPermission === 'unsupported'} onChange={event => {
        save(notificationKey, event.target.checked); setNotificationChoice(event.target.checked);
        if (event.target.checked) void requestPermission();
      }} /></label>
      {notificationChoice && notificationPermission === 'default' ? <button type="button" onClick={() => void requestPermission()}>Allow browser notifications</button> : null}
      {notificationPermission === 'denied' ? <small>Notifications are blocked. Allow them in this site’s browser settings.</small> : null}
      {notificationPermission === 'unsupported' ? <small>Browser notifications are unavailable. Use Track view for reminders.</small> : null}
      {permissionError ? <small>Permission could not be requested. Try Allow browser notifications again.</small> : null}
    </> : null}
  </>;
  return { enabled: active && !mobile && notificationChoice && notificationPermission === 'granted', trackVisible, setTrackVisible, executeTrack, controls, observe, notifier };
}
