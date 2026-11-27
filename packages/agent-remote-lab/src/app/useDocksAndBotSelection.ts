// Window actions, docks, the selected bot and the bot presentation.
import { hasBotAppearance, isBotView, primaryWindowViews, type WindowView, type Team } from '@orchardworks/agent-remote-protocol';
import { useBotWorkspace } from '../hooks/useBotWorkspace.js';
import { windowBindingKey } from '../kernel/window-composition.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSuccessionBindingSlice } from './useSessionSuccessionBinding.js';
import type { WorkbenchRecordsSlice } from './useWorkbenchRecords.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { AppInputs } from './types.js';

export function useDocksAndBotSelection(scope: Pick<AppInputs & SessionSuccessionBindingSlice & WorkbenchRecordsSlice & WorkbenchShellSlice, 'accessReady' | 'canRead' | 'activated' | 'baseUrl' | 'navigation' | 'sharedWindow' | 'succession' | 'toast' | 'transport' | 'windowActions' | 'windowMode' | 'windowWorkspace'>) {
  const { accessReady, canRead, activated, baseUrl, navigation, sharedWindow, succession, toast, transport, windowActions, windowMode, windowWorkspace } = scope;

  // A notice is cleared once a toast shows it; while toasts are inactive (Bot mode) it waits.
  useEffect(() => {
    if (!windowActions.notice || !toast) return;
    toast.show('window-action', 'Window', windowActions.notice, windowActions.noticeTone ?? 'error');
    windowActions.setNotice(undefined);
  }, [windowActions.notice, windowActions.noticeTone, toast]);

  const [agentControlOpen, setAgentControlOpen] = useState(false);

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  // Docking a view in the open Window shows the docks again, and so does closing its last dock; switching Windows keeps the choice.

  const selectedBot = useBotWorkspace(windowWorkspace, succession, navigation.place, activated && accessReady && !windowMode, canRead && !windowMode);

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
  return { agentControlOpen, setAgentControlOpen, deleteConfirmOpen, setDeleteConfirmOpen, selectedBot, botPresentation, primaryGroups };
}

export type DocksAndBotSelectionSlice = ReturnType<typeof useDocksAndBotSelection>;
