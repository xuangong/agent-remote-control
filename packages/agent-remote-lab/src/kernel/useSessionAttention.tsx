import { keyedError } from '@orchardworks/agent-client';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentCommandResult } from '@orchardworks/agent-remote-protocol';
import type { ConsoleCommand } from '@orchardworks/agent-client-web/react';
import type { SessionEntry } from './session-tree.js';
import { SessionAttentionNotifications } from './session-notifications.js';
import type { SessionObservation } from './tracking-state.js';
import type { WorkbenchMode } from './workbench-mode.js';

export const TrackViewCommand = { id: 'console:track', name: 'track', kind: 'command', description: 'Toggle Track view; use /track on or /track off', descriptionKey: 'sessions.console.track', inputHint: '[on|off]' } satisfies ConsoleCommand;
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

export function useSessionAttention(scope: string, active: boolean, onOpen: (session: SessionEntry) => void, mode: WorkbenchMode = 'window') {
  const t = useTranslate();
  const translate = useRef(t); translate.current = t;
  const [mobile, setMobile] = useState(() => window.matchMedia?.('(pointer: coarse)').matches ?? false);
  const [trackChoice, setTrackChoice] = useState(() => preference(trackKey));
  const [notificationChoice, setNotificationChoice] = useState(() => preference(notificationKey) ?? true);
  const [notificationPermission, setPermission] = useState(permission);
  const [permissionError, setPermissionError] = useState(false);
  const clickScope = useMemo(() => ({ mode, lifetime: {} }), [scope, mode, active, mobile, notificationChoice]);
  const latest = useRef({ scope, active, mobile, notificationChoice, onOpen, clickScope });
  latest.current = { scope, active, mobile, notificationChoice, onOpen, clickScope };
  // Notifications speak the reader's language, as the page does.
  const notifier = useMemo(() => new SessionAttentionNotifications(scope,
    () => latest.current.scope === scope && latest.current.active && !latest.current.mobile && latest.current.notificationChoice,
    session => latest.current.onOpen(session), () => latest.current.clickScope, (key, params) => translate.current(key, params)), [scope]);
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
  // Every conversation reads the command through context: it keeps its identity and acts on the latest choice.
  const latestTrack = useRef({ trackVisible, setTrackVisible }); latestTrack.current = { trackVisible, setTrackVisible };
  const executeTrack = useCallback(async (args: string): Promise<AgentCommandResult> => {
    const arg = args.trim().toLowerCase();
    if (!['', 'on', 'off', 'enable', 'disable'].includes(arg)) throw keyedError('navigation.track.usage');
    const next = arg ? arg === 'on' || arg === 'enable' : !latestTrack.current.trackVisible;
    latestTrack.current.setTrackVisible(next);
    return { text: translate.current(next ? 'navigation.track.shown' : 'navigation.track.hidden') };
  }, []);
  const observe = useCallback((session: SessionEntry, value: SessionObservation) => { void notifier.observe(session, value); }, [notifier]);
  const controls = <>
    <label><span>{t('navigation.viewOptions.trackView')}</span><input type="checkbox" checked={trackVisible} onChange={event => setTrackVisible(event.target.checked)} /></label>
  </>;
  /** This device's session notifications, for an assistant's details: one choice that every assistant shares. */
  const notifications = { enabled: notificationChoice, available: !mobile && notificationPermission !== 'unsupported', permission: notificationPermission, requestFailed: permissionError, request: () => void requestPermission(), set(value: boolean) {
    save(notificationKey, value); setNotificationChoice(value);
    if (value) void requestPermission();
  } };
  return { enabled: active && !mobile && notificationChoice && notificationPermission === 'granted', trackVisible, setTrackVisible, executeTrack, controls, observe, notifier, notifications };
}
