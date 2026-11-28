// Window selection, mode switching and the actions search runs.
import { errorWords, keyedError } from '@orchardworks/agent-client';
import { parseWindowFeature } from '../kernel/window-feature-views.js';
import type { WindowView, WindowSessionBinding } from '@orchardworks/agent-remote-protocol';
import type { BotSessionRef } from '../kernel/bot-roster.js';
import { botPlaceForTile, windowRouteForPin, type WorkbenchMode } from '../kernel/workbench-mode.js';
import { rankInPlace } from '../kernel/assistant-groups.js';
import { windowBindingKey } from '../kernel/window-composition.js';
import { windowCatalog } from '../features/windows/useWindowActions.js';
import { bindWorkbench, resolveWorkbench, standingBots, unbindWorkbench } from '../features/windows/bot-workbench-binding.js';
import { byRecentUse } from '../features/windows/window-recency.js';
import { workbenchFromTeams } from '../features/windows/bot-workbench-teams.js';
import { readExpanded } from '../features/windows/workbench-expansion.js';
import { attributionWindowOperation } from '../features/sessions/session-attribution-navigation.js';
import type { SessionAttribution } from '@orchardworks/agent-client';
import { useRef } from 'react';
import { compositionSelection } from '../kernel/session-composition.js';
import type { OpenedSession } from '../kernel/directory-client.js';
import { sessionKey } from '../kernel/session-tree.js';
import { sessionViewLocation, type CommandSession } from '../shell/command-items.js';
import { revealView, viewSelection } from '../features/windows/window-view-selection.js';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { SessionSuccessionBindingSlice } from './useSessionSuccessionBinding.js';
import type { SessionOpeningSlice } from './useSessionOpening.js';
import type { ViewSessionStateSlice } from './useViewSessionState.js';
import type { PanelsAndShortcutsSlice } from './usePanelsAndShortcuts.js';
import type { ActiveSessionSlice } from './useActiveSession.js';
import type { DocksAndBotSelectionSlice } from './useDocksAndBotSelection.js';
import type { WindowViewActionsSlice } from './useWindowViewActions.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { ProviderStateSlice } from './useProviderState.js';
import type { SharedFeedsSlice } from './useSharedFeeds.js';
import type { WorkbenchRecordsSlice } from './useWorkbenchRecords.js';
import type { AppInputs } from './types.js';

export function useWindowModeActions(scope: Pick<AppInputs & SessionSuccessionBindingSlice & SessionOpeningSlice & ViewSessionStateSlice & PanelsAndShortcutsSlice & ActiveSessionSlice & DocksAndBotSelectionSlice & WindowViewActionsSlice & WorkbenchShellSlice & ProviderStateSlice & SharedFeedsSlice & WorkbenchRecordsSlice, 'addSessionView' | 'askView' | 'baseUrl' | 'closeContext' | 'closeInspector' | 'closePage' | 'compactLayout' | 'createWindowFromMenu' | 'expandedKeys' | 'modeSteps' | 'navigation' | 'openDirectorySession' | 'openSession' | 'presentedViewId' | 'setQueuedModeSteps' | 'sharedViewForSlot' | 'sharedWindow' | 'showView' | 'sideRequests' | 'succession' | 'teamRoster' | 'windowActions' | 'windowWorkspace' | 'assistantNames'>) {
  const { assistantNames, addSessionView, askView, baseUrl, closeContext, closeInspector, closePage, compactLayout, createWindowFromMenu, expandedKeys, modeSteps, navigation, openDirectorySession, openSession, presentedViewId, setQueuedModeSteps, sharedViewForSlot, sharedWindow, showView, sideRequests, succession, teamRoster, windowActions, windowWorkspace } = scope;
  const t = useTranslate();

  function isViewVisible(slotId: string) {
    if (!sharedWindow) return expandedKeys.has(slotId);
    const view = sharedViewForSlot(slotId);
    if (!view) return false;
    let root = view;
    while (root.attachedTo) {
      const parent = sharedWindow.views.find(item => item.id === root.attachedTo);
      if (!parent) return false;
      root = parent;
    }
    if (compactLayout) return presentedViewId === view.id;
    return !view.collapsed && !root.collapsed;
  }

  /**
   * The session that drives a bot now: after a handoff, the successor its view's slot follows (the view keeps naming the
   * session it was opened with); otherwise the view's own session. Status, replies and reminders follow this one.
   */
  function currentBotSession(groupId: string, viewId: string, binding: WindowSessionBinding): BotSessionRef {
    const slotId = succession.document.windowBindings?.find(entry => entry.windowId === groupId && entry.viewId === viewId && entry.bindingKey === windowBindingKey(binding))?.slotId;
    const slot = slotId ? succession.document.slots.find(item => item.id === slotId) : undefined;
    const selected = slot ? compositionSelection(slot) : undefined;
    return selected ? { hostId: selected.hostId ?? binding.hostId, providerId: selected.providerId, nativeSessionId: selected.nativeSessionId }
      : { hostId: binding.hostId, providerId: binding.providerId, nativeSessionId: binding.nativeSessionId };
  }

  /** A bot's sessions before its handoffs, most recent first, where this page knows its chain. */
  function earlierBotSessions(groupId: string, viewId: string, binding: WindowSessionBinding): BotSessionRef[] {
    const hostId = binding.hostId ?? 'local';
    const slotId = succession.document.windowBindings?.find(entry => entry.windowId === groupId && entry.viewId === viewId && entry.bindingKey === windowBindingKey(binding))?.slotId;
    const current = currentBotSession(groupId, viewId, binding);
    const chain = slotId ? succession.historyNavigationFor({ ...current, title: binding.title, viewId: slotId }) : undefined;
    const earlier = chain?.predecessor && !chain.history ? [chain.predecessor, ...chain.ancestors] : [];
    return earlier.map(session => ({ hostId: session.hostId ?? hostId, providerId: session.providerId, nativeSessionId: session.nativeSessionId }));
  }

  /** Selects a view of the open Window as its sidebar row does: expanded, selected and scrolled into view, in place of a page. */
  function selectWindowView(view: WindowView) {
    const failed = (error: unknown) => windowActions.setNotice(errorWords(error, t, 'windows.notice.viewNotSelected'));
    try { void windowWorkspace.operate(viewSelection(view)).catch(failed); } catch (error) { failed(error); return; }
    revealView(view.id); closePage();
  }

  /**
   * Queues a step for when `mode` is in front; a step for another mode than the one shown is dropped. Entering Window
   * mode restores the page's Window, which would supersede a Window opened or created in the same turn, so steps never
   * run in the turn that switches. A step that edits the open Window (`confirmed`) also waits until the Window is
   * confirmed, since a cached Window shown while it loads is read-only.
   */
  function inMode(mode: WorkbenchMode, run: () => void, confirmed = false) {
    modeSteps.current.push({ mode, run, confirmed }); setQueuedModeSteps(value => value + 1);
  }

  /** Focuses the shown mode's main heading, else the rail's (or tab bar's) current destination, unless focus is already inside it. */
  function focusShownMode(mode: WorkbenchMode) {
    const root = document.querySelector<HTMLElement>(`[data-workbench-mode="${mode}"]`);
    if (!root || root.hidden || root.contains(document.activeElement)) return;
    const shown = (element: HTMLElement) => !element.closest('[hidden], [inert]');
    const target = [...root.querySelectorAll<HTMLElement>('button.lab-assistant-title, .ui-toolbar-title[tabindex="-1"], #lab-workbench')].find(shown)
      ?? document.querySelector<HTMLElement>('.lab-rail [aria-current="page"], .lab-tab-bar [aria-current="page"]') ?? undefined;
    target?.focus({ preventScroll: true });
  }

  async function openWindowFromSearch(id: string) {
    try { await windowWorkspace.open(id); closePage(); }
    catch (error) { windowActions.setNotice(errorWords(error, t, 'windows.notice.windowNotOpened')); }
  }

  /**
   * Opens a session from search: in the view that shows it (in the open Window first, else opening the Window that
   * has it), or else in the presented view, as All sessions does.
   */
  async function openSessionFromSearch(session: CommandSession) {
    const key = sessionKey(session), current = windowWorkspace.readWindow();
    const location = sessionViewLocation(windowCatalog(windowWorkspace), current?.id, key);
    if (!location) { void openDirectorySession(session); return; }
    if (location.windowId !== current?.id) {
      try { await windowWorkspace.open(location.windowId); }
      catch (error) { windowActions.setNotice(errorWords(error, t, 'windows.notice.windowNotOpened')); return; }
    }
    // Only select once that Window is open: a newer navigation may have replaced it while it loaded.
    const open = windowWorkspace.readWindow();
    const view = open?.id === location.windowId ? open.views.find(candidate => candidate.binding && sessionKey(candidate.binding) === key) : undefined;
    if (view) selectWindowView(view);
  }

  // Palette items and deferred steps call the functions of the latest render, not of the render that built them.
  const searchRuns = useRef({ inMode, switchMode, openWindowFromSearch, openSessionFromSearch, createWindowFromMenu, addSessionView, focusShownMode });

  /** Shows a mode; when the mode changes, focus moves into it once it shows (the palette's opener is in the hidden mode). */
  function switchMode(mode: WorkbenchMode) {
    if (navigation.mode === mode) return;
    navigation.setMode(mode); inMode(mode, () => searchRuns.current.focusShownMode(mode));
  }

  searchRuns.current = { inMode, switchMode, openWindowFromSearch, openSessionFromSearch, createWindowFromMenu, addSessionView, focusShownMode };

  /**
   * Opens a tile's assistant in Bot mode (I3 plan, B5): its group first gains what it needs to show there, and the Window's
   * place is kept for the way back.
   */
  async function openInBotMode(groupId: string, viewId: string): Promise<void> {
    const group = windowWorkspace.readGroup(groupId);
    const target = group ? botPlaceForTile(group, viewId, rankInPlace(windowWorkspace.groups, groupId)) : undefined;
    if (!target) return;
    try { if (target.edit) await windowWorkspace.operateGroup(groupId, target.edit); }
    catch (error) { windowActions.setNotice(errorWords(error, t, 'windows.notice.botNotOpened')); return; }
    navigation.select(target.place);
    inMode('bot', () => searchRuns.current.focusShownMode('bot'));
  }

  /**
   * Pins a Bot-mode assistant to a window (I3 plan, B5): its group shows in Window mode (shown there first when it was
   * hidden) with the assistant's tile presented; the Bot place is kept for the way back.
   */
  async function pinToWindow(groupId: string, viewId: string): Promise<void> {
    const group = windowWorkspace.readGroup(groupId);
    if (!group) return;
    const pin = windowRouteForPin(group, viewId);
    try {
      if (pin.request.kind === 'show') await windowWorkspace.operateGroup(groupId, pin.request.edit);
      // The Window opens while Bot mode still shows, so Window mode comes up with it rather than empty for a frame.
      await windowWorkspace.open(pin.route.window);
    } catch (error) { windowActions.setNotice(errorWords(error, t, 'windows.notice.botNotPinned')); return; }
    // Window mode comes up at the pinned Window, never at another one or none for a frame, and on a phone not under its drawer.
    closeContext();
    navigation.setMode('window', { window: pin.route.window });
    inMode('window', () => searchRuns.current.focusShownMode('window'));
    inMode('window', () => {
      void windowWorkspace.open(pin.route.window).then(() => {
        const open = windowWorkspace.readWindow(), view = open?.id === pin.route.window ? open.views.find(item => item.id === pin.viewId) : undefined;
        if (view) selectWindowView(view);
      }).catch(error => windowActions.setNotice(errorWords(error, t, 'windows.notice.windowNotOpened')));
    });
  }

  /**
   * Opens a bot's workbench in Window mode: the one this device used last, else a new one made for it. Creation is lazy, so a
   * bot with a staff of twelve does not leave twelve Windows behind.
   */
  async function openWorkbench(botId: string): Promise<void> {
    const groups = windowWorkspace.groups;
    let id = resolveWorkbench(groups, botId, byRecentUse(baseUrl, groups.map(group => group.window)).map(window => window.id))?.window.id;
    try {
      if (!id) {
        const bot = standingBots(groups).find(item => item.botId === botId);
        if (!bot) throw keyedError('windows.error.botGone');
        id = await windowWorkspace.createBotWorkbench(botId, assistantNames.view(bot.groupId, bot.viewId), bot.binding);
      }
      await windowWorkspace.open(id);
    } catch (error) { windowActions.setNotice(errorWords(error, t, 'windows.workbench.notice.notOpened')); return; }
    closeContext();
    navigation.setMode('window', { window: id });
    inMode('window', () => searchRuns.current.focusShownMode('window'));
  }

  /** Binds the open Window to a bot: its main session becomes the first tile; the Window's own tiles stay. */
  async function bindWorkbenchToBot(botId: string): Promise<void> {
    const open = windowWorkspace.readWindow(), bot = standingBots(windowWorkspace.groups).find(item => item.botId === botId);
    if (!open || !bot) return;
    try { await windowWorkspace.operate({ type: 'layout.apply', layout: bindWorkbench(open, botId, bot.binding) }); }
    catch (error) { windowActions.setNotice(errorWords(error, t, 'windows.workbench.notice.notChanged')); }
  }

  /** Unbinds the open Window: it becomes a free workbench and keeps its tiles. */
  async function unbindWorkbenchFromBot(): Promise<void> {
    const open = windowWorkspace.readWindow();
    if (!open) return;
    // What the person had open stays: the expanded derived tiles become ordinary tiles; folded groups are not written.
    const expanded = readExpanded(baseUrl, open.id), teams = teamRoster?.baseUrl === baseUrl ? teamRoster.tasks : undefined;
    const model = workbenchFromTeams(open, teams, { expanded, held: [], previous: [] });
    const kept = [...model.derived, ...model.ended].filter(tile => expanded.has(tile.id));
    try { await windowWorkspace.operate({ type: 'layout.apply', layout: unbindWorkbench(open, kept) }); }
    catch (error) { windowActions.setNotice(errorWords(error, t, 'windows.workbench.notice.notChanged')); }
  }

  async function navigateAttribution(attribution: SessionAttribution): Promise<void> {
    const target = attribution.target;
    if (!target) return;
    // A group is a Team of an earlier build; there is none to show now.
    if (target.kind === 'group') throw keyedError('windows.error.groupGone');
    const current = windowWorkspace.readWindow();
    showView('workbench'); closeContext();
    if (compactLayout) closeInspector();
    if (current) {
      const operation = attributionWindowOperation(current, target, attribution.value, crypto.randomUUID());
      if (operation.type === 'view.select') {
        let view = current.views.find(view => view.id === operation.viewId);
        while (view?.attachedTo) view = current.views.find(parent => parent.id === view!.attachedTo);
        const feature = parseWindowFeature(view?.feature);
        if (feature?.kind === 'ask') askView.setVisible(true);
      }
      // Navigation finishes locally; Window save state owns background persistence feedback.
      void windowWorkspace.operate(operation).catch(() => {});
    } else if (!await openSession({ ...target, title: attribution.value }, undefined, undefined, false, undefined, target.sessionIntent)) {
      throw keyedError('windows.error.relatedNotOpened');
    }
  }

  function sideRequestKey(source: OpenedSession) {
    return (source as OpenedSession & { viewId?: string }).viewId ?? sessionKey(source);
  }


  function nextSideRequest(source: OpenedSession): number {
    const key = sideRequestKey(source);
    const request = (sideRequests.current.get(key) ?? 0) + 1;
    sideRequests.current.set(key, request);
    return request;
  }
  return { isViewVisible, currentBotSession, earlierBotSessions, inMode, searchRuns, switchMode, navigateAttribution, sideRequestKey, nextSideRequest, openInBotMode, pinToWindow, openWorkbench, bindWorkbenchToBot, unbindWorkbenchFromBot };
}

export type WindowModeActionsSlice = ReturnType<typeof useWindowModeActions>;
