// Window and view actions: choose, create, edit, add and bind.
import { errorWords, keyedError } from '@orchardworks/agent-client';
import { providerAfterHostChange } from '../state/creation-choice.js';
import { paneDraftOwners } from '../state/draft-ownership.js';
import type { SessionPanel } from '../state/panels.js';
import { windowPrimaryViewId, type Team } from '@orchardworks/agent-remote-protocol';
import { sessionConnectionFailure } from '../components/SessionConnectionNotice.js';
import { useEffect } from 'react';
import type { RemoteHost } from '../components/HostPairing.js';
import type { RemoteHostStateSlice } from './useRemoteHostState.js';
import type { WorkbenchRecordsSlice } from './useWorkbenchRecords.js';
import type { ConversationConnectionsSlice } from './useConversationConnections.js';
import type { ActiveSessionSlice } from './useActiveSession.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { ProviderStateSlice } from './useProviderState.js';
import type { ProviderCreationSlice } from './useProviderCreation.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { SessionSuccessionBindingSlice } from './useSessionSuccessionBinding.js';
import type { PanelsAndShortcutsSlice } from './usePanelsAndShortcuts.js';
import type { ViewSessionStateSlice } from './useViewSessionState.js';
import type { DocksAndBotSelectionSlice } from './useDocksAndBotSelection.js';
import type { AppInputs } from './types.js';
import { useTranslate } from '@orchardworks/agent-client-web/react';

export function useWindowViewActions(scope: Pick<AppInputs & RemoteHostStateSlice & WorkbenchRecordsSlice & ConversationConnectionsSlice & ActiveSessionSlice & RequestedSessionSlice & ProviderStateSlice & ProviderCreationSlice & WorkbenchShellSlice & SessionSuccessionBindingSlice & PanelsAndShortcutsSlice & ViewSessionStateSlice & DocksAndBotSelectionSlice, 'baseUrl' | 'compactLayout' | 'creatingWindowRef' | 'creationLocked' | 'currentHost' | 'dispatchPanels' | 'draftOwnerBinding' | 'presentedSelection' | 'providerChoiceList' | 'providerId' | 'providers' | 'restoredHostSelection' | 'selectedHost' | 'sessionPanel' | 'sessionWindows' | 'setAgentControlOpen' | 'setCreatePlanning' | 'setCreatingWindow' | 'setDeleteConfirmOpen' | 'setLocalProviderId' | 'setSelectedHost' | 'setSessionNotice' | 'setSessionOptions' | 'sharedWindow' | 'sidebarWindow' | 'succession' | 'toast' | 'transitionRef' | 'windowMode' | 'windowWorkspace'>) {
  const { baseUrl, compactLayout, creatingWindowRef, creationLocked, currentHost, dispatchPanels, draftOwnerBinding, presentedSelection, providerChoiceList, providerId, providers, restoredHostSelection, selectedHost, sessionPanel, sessionWindows, setAgentControlOpen, setCreatePlanning, setCreatingWindow, setDeleteConfirmOpen, setLocalProviderId, setSelectedHost, setSessionNotice, setSessionOptions, sharedWindow, sidebarWindow, succession, toast, transitionRef, windowMode, windowWorkspace } = scope;
  const t = useTranslate();


  function selectHost(host: RemoteHost, preferredId = providerId): void {
    if (creationLocked || transitionRef.current && !sidebarWindow) return;
    restoredHostSelection.current = true;
    const nextProviderId = providerAfterHostChange(host, providers, preferredId);
    setSelectedHost({ ...host, providerId: nextProviderId });
    if (host.id === 'local') setLocalProviderId(nextProviderId);
    setSessionOptions({});
    setCreatePlanning(false);
  }


  function selectProvider(selectionId: string): void {
    const choice = providerChoiceList.find((item) => item.selectionId === selectionId);
    if (!choice) return;
    selectHost(currentHost ?? selectedHost, choice.providerId);
  }

  function focusManagedWindow(event: { target: EventTarget }) {
    if (!windowMode) return;
    if (event.target instanceof Element && event.target.closest('[data-pane-selection-ignore]')) return;
    if (!sharedWindow && event.target instanceof Element && event.target.closest('.lab-ask-window') && !event.target.closest('[data-view-id]')) sessionWindows.focus();
  }

  function showWindowSessionChooser() { dispatchPanels({ type: 'chooser.show' }); }

  function chooseWindowSession(id: string) {
    sessionWindows.focus(id); showWindowSessionChooser();
  }

  /** Desktop: shows a sidebar panel as a page in place of the Window. */
  function openPage(panel: SessionPanel) { dispatchPanels({ type: 'page.open', panel }); }


  /** Shows a sidebar panel: a page on desktop, the drawer (instead of the inspector) on compact layouts. */
  function showPanel(panel: SessionPanel) { dispatchPanels({ type: 'panel.show', panel }); }

  /** Shows the new-session form. */
  function openNewSessionPanel() { showPanel('new'); }

  function createWindowFromMenu() {
    if (creatingWindowRef.current) return;
    creatingWindowRef.current = true; setCreatingWindow(true);
    void windowWorkspace.create().then(() => toast?.dismiss('new-window'),
      (error: unknown) => toast?.show('new-window', t('windows.notice.notCreated'), errorWords(error, t), 'error'))
      .finally(() => { creatingWindowRef.current = false; setCreatingWindow(false); });
  }

  function editWindow(operation: Parameters<typeof windowWorkspace.operate>[0]) {
    void windowWorkspace.operate(operation).catch(error => setSessionNotice(sessionConnectionFailure(error, false)));
  }

  function selectPrimaryGroup(id: string) {
    if (!windowMode) return;
    const current = windowWorkspace.readWindow();
    if (current?.selectedPrimaryViewId === id && current.selectedViewId && windowPrimaryViewId(current, current.selectedViewId) === id) return;
    windowWorkspace.authority?.operate({ type: 'view.select', viewId: id });
  }

  function createSessionView() {
    try { sessionWindows.create(); showWindowSessionChooser(); }
    catch (error) { setSessionNotice(sessionConnectionFailure(error, false)); }
  }

  /** Adds an empty session view and selects it, without opening the sessions page. */
  function addSessionView() {
    try { sessionWindows.create(); }
    catch (error) { setSessionNotice(sessionConnectionFailure(error, false)); }
  }

  /** The desktop Window toolbar, above the session views of an available shared Window. */
  const windowToolbarShown = !!sharedWindow && !compactLayout && !windowWorkspace.unavailable;

  // The toolbar's sheets belong to its Window: switching Windows, or the toolbar going away (a compact layout, Bot mode, an unavailable Window), closes them.
  useEffect(() => { setAgentControlOpen(false); setDeleteConfirmOpen(false); }, [windowWorkspace.client, sharedWindow?.id, windowToolbarShown, windowMode]);

  function windowDraftBinding(entry: (typeof sessionWindows.entries)[number]) {
    const owners = paneDraftOwners(succession.document.slots.find(slot => slot.id === entry.slotId), !!entry.managed, baseUrl);
    return owners ? { draftBinding: draftOwnerBinding(owners.text), imageDraftBinding: owners.image } : {};
  }

  function directoryDestination() {
    const current = windowWorkspace.readWindow();
    const view = presentedSelection(current);
    if (!current || !view) return;
    if (view.bindingPolicy === 'managed') throw keyedError('windows.error.managedView');
    return { windowId: current.id, viewId: view.id, binding: JSON.stringify(view.binding ?? null) };
  }
  return { selectHost, selectProvider, focusManagedWindow, showWindowSessionChooser, chooseWindowSession, openPage, showPanel, openNewSessionPanel, createWindowFromMenu, editWindow, selectPrimaryGroup, createSessionView, addSessionView, windowToolbarShown, windowDraftBinding, directoryDestination };
}

export type WindowViewActionsSlice = ReturnType<typeof useWindowViewActions>;
