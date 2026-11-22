// The slices of the Workbench state that session view contributions read their inputs from.
import type { AppInputs } from '../types.js';
import type { SessionSuccessionBindingSlice } from '../useSessionSuccessionBinding.js';
import type { ViewSessionStateSlice } from '../useViewSessionState.js';
import type { ProviderStateSlice } from '../useProviderState.js';
import type { RequestedSessionSlice } from '../useRequestedSession.js';
import type { WorkbenchRecordsSlice } from '../useWorkbenchRecords.js';
import type { WorkbenchShellSlice } from '../useWorkbenchShell.js';
import type { SendingAndSuccessionSlice } from '../useSendingAndSuccession.js';
import type { RemoteHostStateSlice } from '../useRemoteHostState.js';
import type { FocusedAskSlice } from '../useFocusedAsk.js';
import type { SideNavigationSlice } from '../useSideNavigation.js';
import type { PanelsAndShortcutsSlice } from '../usePanelsAndShortcuts.js';
import type { TraceNavigationSlice } from '../useTraceNavigation.js';
import type { QuotesAndReferencesSlice } from '../useQuotesAndReferences.js';
import type { CommunicationsAndForksSlice } from '../useCommunicationsAndForks.js';
import type { SessionOpeningSlice } from '../useSessionOpening.js';
import type { SideSelectionSlice } from '../useSideSelection.js';
import type { ActiveSessionSlice } from '../useActiveSession.js';
import type { AttentionAndRosterSlice } from '../useAttentionAndRoster.js';
import type { WindowModeActionsSlice } from '../useWindowModeActions.js';

export type PresentationScope = AppInputs & SessionSuccessionBindingSlice & ViewSessionStateSlice & ProviderStateSlice & RequestedSessionSlice & WorkbenchRecordsSlice & WorkbenchShellSlice & SendingAndSuccessionSlice & RemoteHostStateSlice & FocusedAskSlice & SideNavigationSlice & PanelsAndShortcutsSlice & TraceNavigationSlice & QuotesAndReferencesSlice & CommunicationsAndForksSlice & SessionOpeningSlice & SideSelectionSlice & ActiveSessionSlice & AttentionAndRosterSlice & WindowModeActionsSlice;
