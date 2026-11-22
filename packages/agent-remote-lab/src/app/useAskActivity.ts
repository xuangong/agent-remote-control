import { askActivityOf, askSourcesOf } from '../features/team/ask-visibility.js';
import { useMemo } from 'react';
import { compositionSession } from '../kernel/session-composition.js';
import type { AppInputs } from './types.js';
import type { WorkbenchRecordsSlice } from './useWorkbenchRecords.js';
import type { FocusedAskSlice } from './useFocusedAsk.js';
import type { SessionOpeningSlice } from './useSessionOpening.js';
import type { SideSelectionSlice } from './useSideSelection.js';
import type { SessionSuccessionBindingSlice } from './useSessionSuccessionBinding.js';
import type { ViewSessionStateSlice } from './useViewSessionState.js';
import type { WindowModeActionsSlice } from './useWindowModeActions.js';
import type { HostAndStackSlice } from './useHostAndStack.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { ConversationConnectionsSlice } from './useConversationConnections.js';
import type { ActiveSessionSlice } from './useActiveSession.js';
import type { PanelsAndShortcutsSlice } from './usePanelsAndShortcuts.js';
import type { DocksAndBotSelectionSlice } from './useDocksAndBotSelection.js';
import type { WindowViewActionsSlice } from './useWindowViewActions.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { ViewTargetsSlice } from './useViewTargets.js';
import type { ProviderCreationSlice } from './useProviderCreation.js';

// The Asks that have a session to watch.
export function useAskActivity(scope: Pick<AppInputs & WorkbenchRecordsSlice & FocusedAskSlice & SessionOpeningSlice & SideSelectionSlice & SessionSuccessionBindingSlice & ViewSessionStateSlice & WindowModeActionsSlice & HostAndStackSlice & WorkbenchShellSlice & ConversationConnectionsSlice & ActiveSessionSlice & PanelsAndShortcutsSlice & DocksAndBotSelectionSlice & WindowViewActionsSlice & RequestedSessionSlice & ViewTargetsSlice & ProviderCreationSlice, 'ask' | 'askWindowsVisible' | 'compactLayout' | 'sharedWindow' | 'succession'>) {
  const { ask, askWindowsVisible, compactLayout, sharedWindow, succession } = scope;

  const askSources = useMemo(() => askSourcesOf(succession.document.slots, succession.document.asks, compositionSession),
    [succession.document, succession.document.editRevision]);

  const askActivitySessions = useMemo(() => askActivityOf(askSources, (source, owner) => {
    const entry = ask.entryFor(source, owner);
    return { target: entry.record?.target, attached: !!entry.attached, enabled: ask.isEnabled(source, owner), expanded: ask.isOpen(source, owner), view: ask.sharedView(owner) };
  }, { window: sharedWindow, visible: askWindowsVisible, compact: compactLayout }), [askSources, ask.revision, askWindowsVisible, sharedWindow, compactLayout]);
  return { askSources, askActivitySessions };
}

export type AskActivitySlice = ReturnType<typeof useAskActivity>;
