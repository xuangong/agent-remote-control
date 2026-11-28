import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { adoptedView } from '../features/windows/bot-workbench-binding.js';
import { workbenchFromTeams } from '../features/windows/bot-workbench-teams.js';
import type { WorkbenchModel, WorkbenchTile } from '../features/windows/bot-workbench.js';
import { readExpanded, writeExpanded } from '../features/windows/workbench-expansion.js';
import { conversationLocalStorage } from '../kernel/conversation-storage.js';
import { useWatchTeamRoster } from '../kernel/useTeamRoster.js';
import type { AppScope } from './types.js';

const ledgerKey = (scope: string) => `agent-remote:recovery:${scope}:workbench-ledger`;
/** The ledger panel is open by default where the desktop has room for it, and the person's choice is kept on this device. */
function readLedgerOpen(scope: string): boolean {
  try { const value = conversationLocalStorage.getItem(ledgerKey(scope)); if (value === '1' || value === '0') return value === '1'; } catch { /* The width decides. */ }
  return typeof window !== 'undefined' && window.innerWidth >= 1180;
}

/**
 * The shown Window as a bot workbench: its model, derived from the Window and the Teams the page holds, and what the person does
 * to derived tiles. Expanding and selecting a derived tile is this device's state; keeping one writes it into the Window.
 */
export function useBotWorkbench(scope: Pick<AppScope, 'baseUrl' | 'sharedWindow' | 'teamRoster' | 'windowWorkspace'>) {
  const { baseUrl, sharedWindow, teamRoster, windowWorkspace } = scope;
  const windowId = sharedWindow?.id;
  // On a phone the workbench is a stack: the list is home and a pushed screen is a tile or the ledger. Back is the page's own history.
  const [screen, setScreen] = useState<string>(() => (history.state as { agentRemoteWorkbench?: string } | null)?.agentRemoteWorkbench ?? 'home');
  useEffect(() => {
    const popped = () => setScreen((history.state as { agentRemoteWorkbench?: string } | null)?.agentRemoteWorkbench ?? 'home');
    window.addEventListener('popstate', popped);
    return () => window.removeEventListener('popstate', popped);
  }, []);
  const [ledgerOpen, setLedgerOpenState] = useState(() => readLedgerOpen(baseUrl));
  const [local, setLocal] = useState<{ windowId?: string; expanded: ReadonlySet<string>; selected?: string }>({ expanded: new Set() });
  const current = local.windowId === windowId ? local : { windowId, expanded: readExpanded(baseUrl, windowId), selected: undefined };
  const previous = useRef<readonly string[]>([]);
  const teams = teamRoster?.baseUrl === baseUrl ? teamRoster.tasks : undefined;
  const model: WorkbenchModel | undefined = useMemo(() => sharedWindow
    ? workbenchFromTeams(sharedWindow, teams, { expanded: current.expanded, held: current.selected ? [current.selected] : [], previous: previous.current }) : undefined,
  [sharedWindow, teams, current.expanded, current.selected]);
  useWatchTeamRoster(!!model?.botId);
  useLayoutEffect(() => { previous.current = model?.derived.map(tile => tile.id) ?? []; });
  const change = useCallback((next: { expanded?: ReadonlySet<string>; selected?: string | null }) => {
    setLocal(() => {
      const expanded = next.expanded ?? current.expanded;
      if (windowId && next.expanded) writeExpanded(baseUrl, windowId, expanded);
      return { windowId, expanded, selected: next.selected === null ? undefined : next.selected ?? current.selected };
    });
  }, [baseUrl, windowId, current.expanded, current.selected]);
  const owns = (id: string) => id.startsWith('group:') || !!model?.derived.some(tile => tile.id === id) || !!model?.ended.some(tile => tile.id === id) || !!model?.answerTiles.some(tile => tile.id === id);
  return {
    screen,
    openScreen: (id: string) => { history.pushState({ ...(history.state as object | null), agentRemoteWorkbench: id }, ''); setScreen(id); },
    back: () => { if ((history.state as { agentRemoteWorkbench?: string } | null)?.agentRemoteWorkbench) history.back(); else setScreen('home'); },
    model, bound: !!model?.botId, selected: current.selected, owns, teams, ledgerOpen, expandedIds: current.expanded,
    setLedgerOpen: (open: boolean) => { setLedgerOpenState(open); try { conversationLocalStorage.setItem(ledgerKey(baseUrl), open ? '1' : '0'); } catch { /* This page keeps the choice. */ } },
    /** Brings a tile to the person: expanded, selected (so it holds its place) and scrolled into view. */
    focus: (id: string) => {
      const next = new Set(current.expanded); next.add(id); change({ expanded: next, selected: id });
      requestAnimationFrame(() => document.querySelector(`[data-primary-group-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }));
    },
    select: (id: string) => change({ selected: id }),
    clearSelection: () => { if (current.selected) change({ selected: null }); },
    setFolded: (id: string, folded: boolean) => { const next = new Set(current.expanded); if (folded) next.delete(id); else next.add(id); change({ expanded: next, ...(folded && current.selected === id ? { selected: null } : { selected: id }) }); },
    /** Keeps a derived tile in the Window as an ordinary tile; it then stays after its sub-session ends. */
    keep: async (tile: WorkbenchTile) => {
      if (!tile.locator || !sharedWindow) return;
      await Promise.resolve(windowWorkspace.authority?.operate({ type: 'view.create', view: adoptedView(tile, `kept-${tile.taskId ?? tile.id.replace(/[^A-Za-z0-9_.:-]/g, '-')}`) }));
      const next = new Set(current.expanded); next.delete(tile.id); change({ expanded: next, selected: null });
    },
  };
}
