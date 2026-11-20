import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { conversationSessionStorage } from '../conversation-storage.js';
import { PHONE_LAYOUT_QUERY } from './usePhoneLayout.js';
import { DEFAULT_VIEW_STORAGE_KEY, destinationOf, destinationUrl, initialMode, readDefaultView, type DestinationPlace, type SettingsGroupId } from '../destinations.js';
import { decodeBotPlace, parseWorkbenchRoute, persistedBotPlace, windowRouteFields, writeWorkbenchRoute, type BotPlace, type WindowRouteFields, type WorkbenchMode } from '../workbench-mode.js';

/** Settings or the directory shown over the mode, which keeps its own place underneath. */
export interface PagePlace { readonly destination: 'settings' | 'assistants'; readonly group?: SettingsGroupId }
interface ModeState { mode: WorkbenchMode; place?: BotPlace; rosterVisible: boolean; page: PagePlace | undefined }
/** Marks the history entry of a page a phone pushed (Me, then a group), so Back returns to the one before it. */
const PAGE_ENTRY = 'agentRemotePage';
const pageOf = (url: URL, mode: WorkbenchMode): PagePlace | undefined => {
  const place = destinationOf(url, mode);
  return place.destination === 'settings' || place.destination === 'assistants' ? { destination: place.destination, ...(place.group ? { group: place.group } : {}) } : undefined;
};
/** Marks the history entry a phone pushes when it opens a conversation from the assistant list. */
const CONVERSATION_ENTRY = 'agentRemoteConversation';
const isPhone = () => typeof window.matchMedia === 'function' && window.matchMedia(PHONE_LAYOUT_QUERY).matches;
export function useWorkbenchMode(scope: string) {
  const runtime = useMemo(() => {
    const botKey = `agent-remote:recovery:${scope}:bot-place`, windowKey = `agent-remote:recovery:${scope}:window-route`;
    const saved = (() => { try { return JSON.parse(conversationSessionStorage.getItem(botKey) ?? 'null'); } catch { return undefined; } })();
    const bot = { place: decodeBotPlace(saved?.place), rosterVisible: typeof saved?.rosterVisible === 'boolean' ? saved.rosterVisible : true };
    let windowRoute: WindowRouteFields = {};
    try { const value = JSON.parse(conversationSessionStorage.getItem(windowKey) ?? 'null'); if (value && typeof value === 'object') windowRoute = windowRouteFields(new URL(`https://route/?${new URLSearchParams(value)}`)); } catch { /* Page-local navigation still works. */ }
    const explicit = parseWorkbenchRoute(new URL(location.href));
    const phone = isPhone();
    let stored: WorkbenchMode | undefined; try { const value = localStorage.getItem('agent-remote:workbench-mode'); if (value === 'bot' || value === 'window') stored = value; } catch { /* The default view decides. */ }
    let defaultView = readDefaultView(null); try { defaultView = readDefaultView(localStorage.getItem(DEFAULT_VIEW_STORAGE_KEY)); } catch { /* Last used. */ }
    // On a phone the assistant list is home, whatever the stored mode, unless the address names a window or an assistant.
    const phoneHome = phone && explicit?.mode !== 'window' && !(explicit?.mode === 'bot' && explicit.place && explicit.place.kind !== 'section');
    if (phoneHome) bot.rosterVisible = true;
    const mode = initialMode({ ...(explicit ? { named: explicit.mode } : {}), ...(stored ? { stored } : {}), defaultView, phone });
    let state: ModeState = { mode, place: explicit?.place ?? bot.place, rosterVisible: explicit?.place ? explicit.place.kind === 'section' : bot.rosterVisible, page: pageOf(new URL(location.href), mode) ?? (explicit?.place?.kind === 'section' ? { destination: 'assistants' } : undefined) };
    if (explicit?.mode === 'bot' && explicit.place) { bot.place = explicit.place; bot.rosterVisible = explicit.place.kind === 'section'; }
    const listeners = new Set<() => void>();
    const persist = () => {
      try { localStorage.setItem('agent-remote:workbench-mode', state.mode); } catch { /* Retain the page-local preference. */ }
      try { conversationSessionStorage.setItem(botKey, JSON.stringify({ place: persistedBotPlace(bot.place), rosterVisible: bot.rosterVisible })); } catch { /* Retain the page-local place. */ }
    };
    const publish = () => { state = { mode: state.mode, page: state.page, ...bot }; persist(); for (const listener of listeners) listener(); };
    /** Leaving Window mode keeps its route, so coming back returns to the same Window and session. */
    const keepWindowRoute = () => {
      if (state.mode !== 'window') return;
      windowRoute = windowRouteFields(new URL(location.href));
      try { conversationSessionStorage.setItem(windowKey, JSON.stringify(windowRoute)); } catch { /* The captured route stays on this page. */ }
    };
    const write = () => { const url = destinationUrl(writeWorkbenchRoute(new URL(location.href), state.mode, bot.place, windowRoute), state.page ?? { destination: 'chats' }); if (url.href !== location.href) history.replaceState(history.state, '', url); };
    const api = {
      getSnapshot: () => state,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      initialize: () => { if (!explicit && state.mode === 'bot') write(); persist(); },
      /** Shows a mode; Window mode may be shown at a given route (a pinned assistant's Window) in place of the one it kept. */
      setMode: (mode: WorkbenchMode, route?: WindowRouteFields) => {
        if (mode === state.mode && !route && !state.page) return;
        keepWindowRoute();
        if (mode === 'window' && route) {
          windowRoute = route;
          try { conversationSessionStorage.setItem(windowKey, JSON.stringify(windowRoute)); } catch { /* The route stays on this page. */ }
        }
        state = { ...state, mode, page: undefined }; write(); publish();
      },
      // Choosing a bot from Window mode (Open in Bot mode, search) keeps the Window's place for the way back. On a phone,
      // opening a conversation from the list is a history entry: the system back gesture and the browser's Back return to it.
      select: (place: BotPlace) => {
        const push = isPhone() && state.mode === 'bot' && bot.rosterVisible && place.kind !== 'section';
        keepWindowRoute(); bot.place = place; bot.rosterVisible = place.kind === 'section'; state = { ...state, mode: 'bot', page: undefined };
        if (push) history.pushState({ ...history.state, [CONVERSATION_ENTRY]: true }, '', writeWorkbenchRoute(new URL(location.href), 'bot', bot.place, windowRoute));
        else write();
        publish();
      },
      back: () => {
        if (history.state?.[CONVERSATION_ENTRY]) { history.back(); return; }
        bot.rosterVisible = true; publish();
      },
      acceptSectionRoute: (groupId: string) => { bot.place = { kind: 'section', groupId }; bot.rosterVisible = true; state = { ...state, mode: 'bot' }; write(); publish(); },
      /** Shows Settings or the directory over the mode (a history entry when `push`), or returns to the mode's own place. */
      open: (place: DestinationPlace, how: 'push' | 'replace' = 'replace') => {
        if (place.destination === 'chats' || place.destination === 'windows') { api.setMode(place.destination === 'chats' ? 'bot' : 'window'); return; }
        keepWindowRoute();
        state = { ...state, page: { destination: place.destination, ...(place.group ? { group: place.group } : {}) } as PagePlace };
        const url = destinationUrl(writeWorkbenchRoute(new URL(location.href), state.mode, bot.place, windowRoute), place);
        if (how === 'push') history.pushState({ ...history.state, [PAGE_ENTRY]: true }, '', url); else history.replaceState(history.state, '', url);
        publish();
      },
      /** Leaves a pushed page entry the way the system's Back does; a page opened in place goes up to its list. */
      closePage: () => {
        if (history.state?.[PAGE_ENTRY]) history.back();
        else api.open(state.page?.destination === 'settings' && state.page.group ? { destination: 'settings' } : { destination: state.mode === 'bot' ? 'chats' : 'windows' });
      },
      popped: () => {
        const url = new URL(location.href), route = parseWorkbenchRoute(url);
        const page = pageOf(url, route?.mode ?? state.mode) ?? (route?.place?.kind === 'section' ? { destination: 'assistants' as const } : undefined);
        if (route?.mode === 'bot' && route.place) { bot.place = route.place; bot.rosterVisible = route.place.kind === 'section'; }
        // Back from a conversation a phone opened from the list shows the list again.
        if (route?.mode === 'bot' && isPhone() && !history.state?.[CONVERSATION_ENTRY]) bot.rosterVisible = true;
        state = { ...state, mode: route?.mode ?? state.mode, page }; publish();
      },
    };
    return api;
  }, [scope]);
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  useEffect(() => { runtime.initialize(); addEventListener('popstate', runtime.popped); return () => removeEventListener('popstate', runtime.popped); }, [runtime]);
  /** Where the reader is, as the rail and the tab bar show it: the page over the mode, or the mode itself. */
  const destination: DestinationPlace = state.page ?? { destination: state.mode === 'bot' ? 'chats' : 'windows' };
  return { ...state, destination, setMode: runtime.setMode, select: runtime.select, back: runtime.back, acceptSectionRoute: runtime.acceptSectionRoute, open: runtime.open, closePage: runtime.closePage };
}
