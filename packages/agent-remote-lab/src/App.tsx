import { ToastProvider } from './components/Toast.js';
import { useWorkbenchShell } from './app/useWorkbenchShell.js';
import { useRequestedSession } from './app/useRequestedSession.js';
import { useWorkbenchRecords } from './app/useWorkbenchRecords.js';
import { useConversationConnections } from './app/useConversationConnections.js';
import { useViewTargets } from './app/useViewTargets.js';
import { useProviderState } from './app/useProviderState.js';
import { useSessionSuccessionBinding } from './app/useSessionSuccessionBinding.js';
import { useDocksAndBotSelection } from './app/useDocksAndBotSelection.js';
import { useViewSessionState } from './app/useViewSessionState.js';
import { usePanelsAndShortcuts } from './app/usePanelsAndShortcuts.js';
import { useRemoteHostState } from './app/useRemoteHostState.js';
import { useSideSelection } from './app/useSideSelection.js';
import { useProviderCreation } from './app/useProviderCreation.js';
import { useActiveSession } from './app/useActiveSession.js';
import { useWindowViewActions } from './app/useWindowViewActions.js';
import { useSharedFeedsAndTpm } from './app/useSharedFeedsAndTpm.js';
import { useHostAndStack } from './app/useHostAndStack.js';
import { useSessionOpening } from './app/useSessionOpening.js';
import { useFocusedAsk } from './app/useFocusedAsk.js';
import { useWindowModeActions } from './app/useWindowModeActions.js';
import { useSideNavigation } from './app/useSideNavigation.js';
import { useAttentionAndRoster } from './app/useAttentionAndRoster.js';
import { useCommandSearch } from './app/useCommandSearch.js';
import { useSessionTitles } from './app/useSessionTitles.js';
import { useTraceNavigation } from './app/useTraceNavigation.js';
import { useCommunicationsAndForks } from './app/useCommunicationsAndForks.js';
import { useSendingAndSuccession } from './app/useSendingAndSuccession.js';
import { useQuotesAndReferences } from './app/useQuotesAndReferences.js';
import { useSessionViewPresentation } from './app/useSessionViewPresentation.js';
import { useViewModel } from './app/useViewModel.js';
import { WorkbenchView } from './app/WorkbenchView.js';
import type { AppInputs, AppLate, AppProps } from './app/types.js';
export type { AppActions, AppProps, LabTransport } from './app/types.js';


export function App(props: AppProps) {
  return <ToastProvider><AppContent {...props} /></ToastProvider>;
}
function AppContent({
  baseUrl = window.location.origin,
  transport: injectedTransport,
  directory: injectedDirectory,
  hostService,
  initialState,
  initialSessionStatus = 'idle',
  initialProviderName,
  actions,
  fixtureAction,
  accountAction,
  userScoped = false,
}: AppProps) {
  const inputs: AppInputs = { baseUrl, injectedTransport, injectedDirectory, hostService, initialState, initialSessionStatus, initialProviderName, actions, fixtureAction, accountAction, userScoped };
  const late = {} as AppLate;
  const scope1 = { ...inputs, ...useWorkbenchShell(inputs) };
  const scope2 = { ...scope1, ...useRequestedSession(scope1) };
  const scope3 = { ...scope2, ...useWorkbenchRecords(scope2) };
  const scope4 = { ...scope3, ...useConversationConnections(scope3) };
  const scope5 = { ...scope4, ...useViewTargets() };
  const scope6 = { ...scope5, ...useProviderState(scope5) };
  const scope7 = { ...scope6, ...useSessionSuccessionBinding(scope6, late) };
  const scope8 = { ...scope7, ...useDocksAndBotSelection(scope7) };
  const scope9 = { ...scope8, ...useViewSessionState(scope8, late) };
  const scope10 = { ...scope9, ...usePanelsAndShortcuts(scope9) };
  const scope11 = { ...scope10, ...useRemoteHostState(scope10) };
  const scope12 = { ...scope11, ...useSideSelection(scope11, late) };
  const scope13 = { ...scope12, ...useProviderCreation(scope12, late) };
  const scope14 = { ...scope13, ...useActiveSession(scope13) };
  const scope15 = { ...scope14, ...useWindowViewActions(scope14) };
  const scope16 = { ...scope15, ...useSharedFeedsAndTpm(scope15) };
  const scope17 = { ...scope16, ...useHostAndStack(scope16, late) };
  const scope18 = { ...scope17, ...useSessionOpening(scope17, late) };
  const scope19 = { ...scope18, ...useFocusedAsk(scope18, late) };
  const scope20 = { ...scope19, ...useWindowModeActions(scope19) };
  const scope21 = { ...scope20, ...useSideNavigation(scope20) };
  const scope22 = { ...scope21, ...useAttentionAndRoster(scope21, late) };
  const scope23 = { ...scope22, ...useCommandSearch(scope22) };
  const scope24 = { ...scope23, ...useSessionTitles(scope23) };
  const scope25 = { ...scope24, ...useTraceNavigation(scope24) };
  const scope26 = { ...scope25, ...useCommunicationsAndForks(scope25) };
  const scope27 = { ...scope26, ...useSendingAndSuccession(scope26) };
  const scope28 = { ...scope27, ...useQuotesAndReferences(scope27) };
  const scope29 = { ...scope28, ...useSessionViewPresentation(scope28) };
  const scope30 = { ...scope29, ...useViewModel(scope29) };

  return <WorkbenchView scope={scope30} />;
}



