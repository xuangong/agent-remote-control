import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { conversationSessionStorage } from '../conversation-storage.js';
import { decodeBotPlace, parseWorkbenchRoute, persistedBotPlace, windowRouteFields, writeWorkbenchRoute, type BotPlace, type WindowRouteFields, type WorkbenchMode } from '../workbench-mode.js';

interface ModeState { mode: WorkbenchMode; place?: BotPlace; rosterVisible: boolean }
export function useWorkbenchMode(scope: string) {
  const runtime = useMemo(() => {
    const botKey = `agent-remote:recovery:${scope}:bot-place`, windowKey = `agent-remote:recovery:${scope}:window-route`;
    const saved = (() => { try { return JSON.parse(conversationSessionStorage.getItem(botKey) ?? 'null'); } catch { return undefined; } })();
    const bot = { place: decodeBotPlace(saved?.place), rosterVisible: typeof saved?.rosterVisible === 'boolean' ? saved.rosterVisible : true };
    let windowRoute: WindowRouteFields = {};
    try { const value = JSON.parse(conversationSessionStorage.getItem(windowKey) ?? 'null'); if (value && typeof value === 'object') windowRoute = windowRouteFields(new URL(`https://route/?${new URLSearchParams(value)}`)); } catch { /* Page-local navigation still works. */ }
    const explicit = parseWorkbenchRoute(new URL(location.href));
    let preference: WorkbenchMode = 'window'; try { if (localStorage.getItem('agent-remote:workbench-mode') === 'bot') preference = 'bot'; } catch { /* Window is the default. */ }
    let state: ModeState = { mode: explicit?.mode ?? preference, place: explicit?.place ?? bot.place, rosterVisible: explicit?.place ? explicit.place.kind === 'section' : bot.rosterVisible };
    if (explicit?.mode === 'bot' && explicit.place) { bot.place = explicit.place; bot.rosterVisible = explicit.place.kind === 'section'; }
    const listeners = new Set<() => void>();
    const persist = () => {
      try { localStorage.setItem('agent-remote:workbench-mode', state.mode); } catch { /* Retain the page-local preference. */ }
      try { conversationSessionStorage.setItem(botKey, JSON.stringify({ place: persistedBotPlace(bot.place), rosterVisible: bot.rosterVisible })); } catch { /* Retain the page-local place. */ }
    };
    const publish = () => { state = { mode: state.mode, ...bot }; persist(); for (const listener of listeners) listener(); };
    const write = () => { const url = writeWorkbenchRoute(new URL(location.href), state.mode, bot.place, windowRoute); if (url.href !== location.href) history.replaceState(history.state, '', url); };
    return {
      getSnapshot: () => state,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      initialize: () => { if (!explicit && state.mode === 'bot') write(); persist(); },
      setMode: (mode: WorkbenchMode) => {
        if (mode === state.mode) return;
        if (state.mode === 'window') {
          windowRoute = windowRouteFields(new URL(location.href));
          try { conversationSessionStorage.setItem(windowKey, JSON.stringify(windowRoute)); } catch { /* The captured route stays on this page. */ }
        }
        state = { ...state, mode }; write(); publish();
      },
      select: (place: BotPlace) => { bot.place = place; bot.rosterVisible = place.kind === 'section'; state = { ...state, mode: 'bot' }; write(); publish(); },
      back: () => { bot.rosterVisible = true; publish(); },
      acceptSectionRoute: (groupId: string) => { bot.place = { kind: 'section', groupId }; bot.rosterVisible = true; state = { ...state, mode: 'bot' }; write(); publish(); },
      navigate: () => {
        const route = parseWorkbenchRoute(new URL(location.href));
        if (!route) return;
        if (route.mode === 'bot' && route.place) { bot.place = route.place; bot.rosterVisible = route.place.kind === 'section'; }
        state = { ...state, mode: route.mode }; publish();
      },
    };
  }, [scope]);
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  useEffect(() => { runtime.initialize(); addEventListener('popstate', runtime.navigate); return () => removeEventListener('popstate', runtime.navigate); }, [runtime]);
  return { ...state, setMode: runtime.setMode, select: runtime.select, back: runtime.back, acceptSectionRoute: runtime.acceptSectionRoute };
}
