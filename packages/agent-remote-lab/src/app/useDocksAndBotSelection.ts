// Window actions, docks, the selected bot and the bot presentation.
import { hasBotAppearance, isBotView, primaryWindowViews, type WindowView, type Team } from '@orchardworks/agent-remote-protocol';
import { useBotWorkspace } from '../hooks/useBotWorkspace.js';
import { windowBindingKey } from '../window-composition.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DOCKS_HIDDEN_KEY } from './helpers.js';
import type { SessionSuccessionBindingSlice } from './useSessionSuccessionBinding.js';
import type { WorkbenchRecordsSlice } from './useWorkbenchRecords.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { AppInputs } from './types.js';

export function useDocksAndBotSelection(scope: Pick<AppInputs & SessionSuccessionBindingSlice & WorkbenchRecordsSlice & WorkbenchShellSlice, 'accessReady' | 'activated' | 'baseUrl' | 'navigation' | 'sharedWindow' | 'succession' | 'toast' | 'transport' | 'windowActions' | 'windowMode' | 'windowWorkspace'>) {
  const { accessReady, activated, baseUrl, navigation, sharedWindow, succession, toast, transport, windowActions, windowMode, windowWorkspace } = scope;

  // A notice is cleared once a toast shows it; while toasts are inactive (Bot mode) it waits.
  useEffect(() => {
    if (!windowActions.notice || !toast) return;
    toast.show('window-action', 'Window', windowActions.notice, windowActions.noticeTone ?? 'error');
    windowActions.setNotice(undefined);
  }, [windowActions.notice, windowActions.noticeTone, toast]);

  const [docksHidden, setDocksHidden] = useState(() => { try { return localStorage.getItem(DOCKS_HIDDEN_KEY) === '1'; } catch { return false; } });

  useEffect(() => { try { localStorage.setItem(DOCKS_HIDDEN_KEY, docksHidden ? '1' : '0'); } catch { /* Keep the choice for this page without storage. */ } }, [docksHidden]);

  const [agentControlOpen, setAgentControlOpen] = useState(false);

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  // Docking a view in the open Window shows the docks again, and so does closing its last dock; switching Windows keeps the choice.
  const dockViews = useRef<{ windowId?: string; ids: Set<string> }>({ ids: new Set() });

  const dockIds = (sharedWindow?.views ?? []).filter(view => view.placement === 'dock').map(view => view.id);

  const dockKey = dockIds.join('\n');

  useEffect(() => {
    const previous = dockViews.current, ids = new Set(dockIds);
    dockViews.current = { windowId: sharedWindow?.id, ids };
    if (!sharedWindow || previous.windowId !== sharedWindow.id) return;
    if (dockIds.some(id => !previous.ids.has(id)) || previous.ids.size > 0 && ids.size === 0) setDocksHidden(false);
  }, [sharedWindow?.id, dockKey]);

  // A docked view that is chosen (sidebar row, search) would stay invisible behind hidden docks, so they show again.
  const showDockOf = useCallback((view: Pick<WindowView, 'placement'>) => { if (view.placement === 'dock') setDocksHidden(false); }, []);

  const selectedBot = useBotWorkspace(windowWorkspace, succession, navigation.place, activated && accessReady && !windowMode);

  // A Team member's conversation in this workspace (the main conversation in a member's seat, a managed Team window, a Team
  // view of the current Window, or the selected bot): Team routing moves its seat to the member's successor, so the Team roster refreshes closely meanwhile.
  const teamConversationsOpen = !!succession.desired?.slot.metadata?.teamId || !!succession.document.windows?.some(window => window.managed)
    || !!sharedWindow?.views.some(view => view.feature?.kind === 'team') || selectedBot.view?.feature?.kind === 'team';

  const botPresentation = useMemo(() => ({ recovering: false, confirmed: undefined as { groupId: string; viewId: string; slotId: string; bindingKey: string } | undefined }), [baseUrl, transport]);

  if (!accessReady) botPresentation.recovering = true;

  if (selectedBot.group && selectedBot.view && selectedBot.slot) {
    botPresentation.recovering = false;
    botPresentation.confirmed = { groupId: selectedBot.group.window.id, viewId: selectedBot.view.id, slotId: selectedBot.slot.id, bindingKey: windowBindingKey(selectedBot.view.binding) };
  }

  const confirmedBot = botPresentation.confirmed;

  if (confirmedBot) {
    const place = navigation.place, group = windowWorkspace.readGroup(confirmedBot.groupId), view = group?.window.views.find(view => view.id === confirmedBot.viewId);
    if (place?.kind !== 'bot' || place.groupId !== confirmedBot.groupId || place.viewId !== confirmedBot.viewId
      || windowWorkspace.deletedWindowIds.includes(confirmedBot.groupId)
      || group && (!hasBotAppearance(group) || !view || !isBotView(view) || group.bots?.members[confirmedBot.viewId]?.hidden || windowBindingKey(view.binding) !== confirmedBot.bindingKey)) botPresentation.confirmed = undefined;
  }

  const primaryGroups = sharedWindow ? primaryWindowViews(sharedWindow) : [];
  return { docksHidden, setDocksHidden, agentControlOpen, setAgentControlOpen, deleteConfirmOpen, setDeleteConfirmOpen, showDockOf, selectedBot, teamConversationsOpen, botPresentation, primaryGroups };
}

export type DocksAndBotSelectionSlice = ReturnType<typeof useDocksAndBotSelection>;
