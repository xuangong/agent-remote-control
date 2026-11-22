import type { WorkbenchMode } from '../workbench-mode.js';
import type { NativeSessionOwner, ResourceResponseState, AgentCommand, AgentCommandResult, AgentMessageOptions, AgentInteractionResponse, AgentPersistenceHandle, AgentProviderDescriptor, AgentSessionConfig, AgentSessionResponse, ResourceBinding } from '@orchardworks/agent-remote-protocol';
import type { useSessionTracking } from '../hooks/useSessionTracking.js';
import type { SessionConnectionMessage } from '../components/SessionConnectionNotice.js';
import type { ReactNode } from 'react';
import type { AgentReplicaState, RemoteAgentTransport, RemoteSessionStatus } from '@orchardworks/agent-client';
import type { HostPairingService } from '../kernel/remote-host.js';
import type { SessionDirectoryClient, OpenedSession, SessionSummary } from '../directory-client.js';
import type { LabWorkbenchActions } from '../components/LabWorkbench.js';
import type { useAskConversations } from '../hooks/useAskConversations.js';
import type { SideSelections } from '../side-tree.js';
import type { Dispatch, SetStateAction } from 'react';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { WorkbenchRecordsSlice } from './useWorkbenchRecords.js';
import type { ConversationConnectionsSlice } from './useConversationConnections.js';
import type { ViewTargetsSlice } from './useViewTargets.js';
import type { ProviderStateSlice } from './useProviderState.js';
import type { SessionSuccessionBindingSlice } from './useSessionSuccessionBinding.js';
import type { DocksAndBotSelectionSlice } from './useDocksAndBotSelection.js';
import type { ViewSessionStateSlice } from './useViewSessionState.js';
import type { PanelsAndShortcutsSlice } from './usePanelsAndShortcuts.js';
import type { RemoteHostStateSlice } from './useRemoteHostState.js';
import type { SideSelectionSlice } from './useSideSelection.js';
import type { ProviderCreationSlice } from './useProviderCreation.js';
import type { ActiveSessionSlice } from './useActiveSession.js';
import type { WindowViewActionsSlice } from './useWindowViewActions.js';
import type { SharedFeedsAndTpmSlice } from './useSharedFeedsAndTpm.js';
import type { HostAndStackSlice } from './useHostAndStack.js';
import type { SessionOpeningSlice } from './useSessionOpening.js';
import type { FocusedAskSlice } from './useFocusedAsk.js';
import type { WindowModeActionsSlice } from './useWindowModeActions.js';
import type { SideNavigationSlice } from './useSideNavigation.js';
import type { AttentionAndRosterSlice } from './useAttentionAndRoster.js';
import type { CommandSearchSlice } from './useCommandSearch.js';
import type { SessionTitlesSlice } from './useSessionTitles.js';
import type { TraceNavigationSlice } from './useTraceNavigation.js';
import type { CommunicationsAndForksSlice } from './useCommunicationsAndForks.js';
import type { SendingAndSuccessionSlice } from './useSendingAndSuccession.js';
import type { QuotesAndReferencesSlice } from './useQuotesAndReferences.js';
import type { SessionViewPresentationSlice } from './useSessionViewPresentation.js';
import type { ViewModelSlice } from './useViewModel.js';

export interface LabTransport extends RemoteAgentTransport {
  listProviders(): Promise<readonly AgentProviderDescriptor[]>;
  createAgent(agentId: string, providerId: string, config: AgentSessionConfig): Promise<AgentSessionResponse>;
  resumeAgent(agentId: string, persistence: AgentPersistenceHandle): Promise<AgentSessionResponse>;
}

export interface AppActions extends LabWorkbenchActions {
  loadOlder?(): void | Promise<void>;
  retryMessage?(id: string): Promise<void>;
  deleteMessage?(id: string): void;
  sendMessage?(text: string, options?: AgentMessageOptions): Promise<void>;
  steer?(text: string): Promise<void>;
  cancel?(): Promise<void>;
  setPlanning?(active: boolean): Promise<void>;
  setSessionSetting?(id: string, value: string): Promise<void>;
  listCommands?(): Promise<AgentCommand[]>;
  executeCommand?(id: string, args: string): Promise<AgentCommandResult>;
  respondToInteraction?(requestId: string, response: AgentInteractionResponse): Promise<void>;
  requestResource?(binding: ResourceBinding): Promise<void | ResourceResponseState>;
  resolveResource?(locator: string, sourceLocator?: string): Promise<ResourceBinding>;
  advanceFixture?(): void | Promise<void>;
  rehydrateFixture?(): void | Promise<void>;
  stopReader?(): void | Promise<void>;
}

import type { AccountFacts } from '../account.js';
export interface AppProps {
  baseUrl?: string;
  account?: AccountFacts;
  userScoped?: boolean;
  transport?: LabTransport;
  directory?: SessionDirectoryClient;
  hostService?: HostPairingService;
  initialState?: AgentReplicaState;
  initialSessionStatus?: RemoteSessionStatus;
  initialProviderName?: string;
  actions?: AppActions;
  fixtureAction?(agentId: string, action: 'advance' | 'rehydrate' | 'stop-reader'): void | Promise<void>;
}

export /** A step that search runs once `mode` is in front; `confirmed` steps also wait for a confirmed Window. */
type ModeStep = { mode: WorkbenchMode; run(): void; confirmed: boolean };

/** What the Workbench hooks read from each other when the hook that declares it runs later; each value is read inside a callback. */
export interface AppLate {
  stackPath: OpenedSession[];
  sideSelections: SideSelections;
  sideFocus: string | undefined;
  sideAnchor: string | undefined;
  addressSession: OpenedSession | undefined;
  expandedKeys: Set<string>;
  tracking: ReturnType<typeof useSessionTracking>;
  ask: ReturnType<typeof useAskConversations>;
  rememberSession: (value: OpenedSession) => void;
  setAttachingAgentId: Dispatch<SetStateAction<string | undefined>>;
  setSessionNotice: Dispatch<SetStateAction<SessionConnectionMessage | undefined>>;
  setSideSelections: (change: SideSelections | ((current: SideSelections) => SideSelections)) => void;
  setSideFocus: (change: string | ((current: string | undefined) => string | undefined) | undefined) => void;
  setSideAnchor: (change: string | ((current: string | undefined) => string | undefined) | undefined) => void;
  providerConnectionName: (hostId: string, selectedProviderId: string) => string;
  setNativeTakeover: Dispatch<SetStateAction<{ item: Pick<SessionSummary, 'providerId' | 'title' | 'nativeSessionId'> & { hostId?: string }; owner: NativeSessionOwner; message: string } | undefined>>;
}

/** The props `AppContent` resolves before its hooks run. */
export interface AppInputs {
  readonly baseUrl: string;
  readonly injectedTransport?: LabTransport;
  readonly injectedDirectory?: SessionDirectoryClient;
  readonly hostService?: HostPairingService;
  readonly initialState?: AgentReplicaState;
  readonly initialSessionStatus: RemoteSessionStatus;
  readonly initialProviderName?: string;
  readonly actions?: AppActions;
  readonly fixtureAction?: AppProps['fixtureAction'];
  readonly account?: AccountFacts;
  readonly userScoped: boolean;
}

/** Everything the hooks produced, in the order they ran. */
export type AppScope = AppInputs & WorkbenchShellSlice & RequestedSessionSlice & WorkbenchRecordsSlice & ConversationConnectionsSlice & ViewTargetsSlice & ProviderStateSlice & SessionSuccessionBindingSlice & DocksAndBotSelectionSlice & ViewSessionStateSlice & PanelsAndShortcutsSlice & RemoteHostStateSlice & SideSelectionSlice & ProviderCreationSlice & ActiveSessionSlice & WindowViewActionsSlice & SharedFeedsAndTpmSlice & HostAndStackSlice & SessionOpeningSlice & FocusedAskSlice & WindowModeActionsSlice & SideNavigationSlice & AttentionAndRosterSlice & CommandSearchSlice & SessionTitlesSlice & TraceNavigationSlice & CommunicationsAndForksSlice & SendingAndSuccessionSlice & QuotesAndReferencesSlice & SessionViewPresentationSlice & ViewModelSlice;
