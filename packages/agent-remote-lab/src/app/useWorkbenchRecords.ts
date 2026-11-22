// Opened sessions, forks, side activity, quotes, new and removed bots and the creation locks.
import { noQuote, reduceQuote } from '../features/session-links/quote-selection.js';
import { useSyncReducer } from '../conversation/useSyncReducer.js';
import { useToast } from '../kernel/Toast.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CreateSessionOptions, OpenedSession } from '../kernel/directory-client.js';
import { ForkStore, type SessionFork } from '../kernel/session-forks.js';
import { readOpenedSessions } from './helpers.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { AppInputs } from './types.js';

export function useWorkbenchRecords(scope: Pick<AppInputs & RequestedSessionSlice & WorkbenchShellSlice, 'baseUrl' | 'cachedState' | 'directory' | 'transport' | 'windowMode' | 'withConfirmedTitle'>) {
  const { baseUrl, cachedState, directory, transport, windowMode, withConfirmedTitle } = scope;

  const [openedSessionRecords, setOpenedSessions] = useState<OpenedSession[]>(() => directory || cachedState ? readOpenedSessions(baseUrl) : []);

  const openedSessions = useMemo(() => openedSessionRecords.map(withConfirmedTitle), [openedSessionRecords, withConfirmedTitle]);

  const openedSessionsRef = useRef(openedSessions);

  openedSessionsRef.current = openedSessions;

  const forkStore = useMemo(() => new ForkStore(baseUrl), [baseUrl]);

  const [forkRevision, setForkRevision] = useState(0);

  useEffect(() => forkStore.subscribe(() => setForkRevision((value) => value + 1)), [forkStore]);

  const [sideSessionRecords, setSideSessions] = useState<OpenedSession[]>([]);

  const storedSideSessions = useMemo(() => sideSessionRecords.map(withConfirmedTitle), [sideSessionRecords, withConfirmedTitle]);

  const [letterReveals, setLetterReveals] = useState<Record<string, { key: string; requestId: number; align: 'start' }>>({});

  const letterRequest = useRef<AbortController>();

  useEffect(() => () => letterRequest.current?.abort(), [baseUrl, transport]);

  const [sideActivity, setSideActivity] = useState<Record<string, import('@orchardworks/agent-remote-protocol').AgentStatus | undefined>>({});

  const observeSideActivity = useCallback((agentId: string, activity: import('@orchardworks/agent-remote-protocol').AgentStatus | undefined) => {
    setSideActivity(current => current[agentId] === activity ? current : { ...current, [agentId]: activity });
  }, []);

  // An unlinked window stays mounted so drafts, scrolling and subscriptions survive.
  const [detachedSideRoot, setDetachedSideRoot] = useState<string>();

  const appliedUnlinks = useMemo(() => new Map<string, number>(), [forkStore]);

  const toast = useToast(windowMode);

  // One Window create at a time from the sidebar's New menu; the item is disabled until it settles.
  const creatingWindowRef = useRef(false);

  const [creatingWindow, setCreatingWindow] = useState(false);

  const sideRequests = useRef(new Map<string, number>());

  const forkReservation = useRef<{ key: string; record: SessionFork }>();

  const forkBusy = useRef(false);

  const [forkInputStatus, setForkInputStatus] = useState<{ agentId: string; pending: boolean; error?: string }>();

  // Messages being selected in one session view to quote into another; creationId keeps a retried new session single.
  const [quote, dispatchQuote] = useSyncReducer(reduceQuote, noQuote);

  const { selection: quoteSelection, notice: quoteNotice } = quote;

  const [referencePicker, setReferencePicker] = useState<string>();

  const [sessionOptions, setSessionOptions] = useState<CreateSessionOptions>({});

  const [directoryRevision, setDirectoryRevision] = useState(0);

  const creationReservation = useRef<{ operationId: string; options: CreateSessionOptions; providerId: string; destination?: { windowId: string; viewId: string; binding: string }; bot?: true }>();

  const [creationLocked, setCreationLocked] = useState(false);

  /** Bot mode's New bot sheet, and the failure of its last start. */
  const [newBot, setNewBot] = useState<{ open: boolean; failure?: string }>({ open: false });

  /** A bot of the shown Window waiting for confirmation before it is removed from the group. */
  const [removingBot, setRemovingBot] = useState<{ windowId: string; viewId: string }>();
  return { setOpenedSessions, openedSessions, openedSessionsRef, forkStore, forkRevision, setSideSessions, storedSideSessions, letterReveals, setLetterReveals, letterRequest, sideActivity, observeSideActivity, detachedSideRoot, setDetachedSideRoot, appliedUnlinks, toast, creatingWindowRef, creatingWindow, setCreatingWindow, sideRequests, forkReservation, forkBusy, forkInputStatus, setForkInputStatus, quote, dispatchQuote, quoteSelection, quoteNotice, referencePicker, setReferencePicker, sessionOptions, setSessionOptions, directoryRevision, setDirectoryRevision, creationReservation, creationLocked, setCreationLocked, newBot, setNewBot, removingBot, setRemovingBot };
}

export type WorkbenchRecordsSlice = ReturnType<typeof useWorkbenchRecords>;
