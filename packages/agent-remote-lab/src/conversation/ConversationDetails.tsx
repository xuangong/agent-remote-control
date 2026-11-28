// The assistant's details for a conversation: what its place and its presentation know, with this conversation's process
// mode, settings and files. They open in the host's panel, as a sheet on a phone, or in a tile's own panel.
import { lazy, Suspense, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { UnattendedView } from '@orchardworks/agent-remote-protocol';
import { createPortal } from 'react-dom';
import { sessionFiles, timelineEntryKey, type AgentReplicaState, type RemoteSessionState, type RemoteSessionStatus } from '@orchardworks/agent-client';
import { FilePreviewContext, useTaskDirectory, useTranslate, type AgentChildSessionView } from '@orchardworks/agent-client-web/react';
import type { AssistantRef } from './assistant/AssistantDetails.js';
import { ModelSettings } from './assistant/ModelSettings.js';
import { PlanningControl } from './PlanningControl.js';
import type { AssistantDetailsHost } from './assistant/details-host.js';
import type { useProcessMode } from './useProcessMode.js';
import type { MissionChoice } from './assistant/MissionEditor.js';
import type { MemoryChoice } from './assistant/MemoryList.js';
import type { BoardChoice } from './assistant/board-model.js';
import type { RoutinesChoice } from './assistant/RoutinesList.js';
import { useWatchTeamRoster } from '../kernel/useTeamRoster.js';
import type { LabWorkbenchActions, SessionWorkbenchProps } from './session-workbench-props.js';

/** The details' code stays out of the App chunk; a conversation that can show them loads it once it is on screen, before a click. */
const loadDetails = () => import('./assistant/AssistantDetails.js');
const AssistantDetails = lazy(() => loadDetails().then(module => ({ default: module.AssistantDetails })));

export function ConversationDetails({ host, visible, state, details, assistant, displayScope, process, mission, memory, botId, session, sessionStatus, readOnly, mutationBlocked, draftOnly, actions,
  renderSessionSettingError, childrenFor, onOpenChildSession, workspaceLink, nativeSession }: {
  host: AssistantDetailsHost | undefined; visible: boolean; state?: AgentReplicaState; details?: SessionWorkbenchProps['details']; assistant: SessionWorkbenchProps['assistant'];
  displayScope?: string; process: ReturnType<typeof useProcessMode>; mission?: MissionChoice; memory?: MemoryChoice; /** The bot's record, when this conversation is a bot's. */ botId?: string; session: RemoteSessionState; sessionStatus: RemoteSessionStatus;
  readOnly: boolean; mutationBlocked: boolean; draftOnly: boolean; actions: LabWorkbenchActions; renderSessionSettingError?(error: unknown): ReactNode;
  childrenFor?(nativeSessionId: string): readonly AgentChildSessionView[]; onOpenChildSession?(child: AgentChildSessionView): void | Promise<void>; workspaceLink?: ReactNode;
  /** The session on screen, `<providerId>/<nativeSessionId>`. */
  nativeSession?: string;
}) {
  const t = useTranslate();
  useEffect(() => { if (host) void loadDetails().catch(() => undefined); }, [!!host]);
  const filePreview = useContext(FilePreviewContext);
  const directory = useTaskDirectory();
  const [providerId, ...rest] = nativeSession?.split('/') ?? [];
  const detailsShown = !!host?.open && visible && (host.surface === 'sheet' || !!host.slot);
  const tasks = detailsShown && directory && providerId && rest.length ? directory.owned({ providerId, nativeSessionId: rest.join('/') }) : [];
  const boardOf = detailsShown && botId ? directory?.boardOf?.(botId) : undefined;
  const board: BoardChoice | undefined = boardOf && directory && (boardOf.items.length || boardOf.plan || directory.writeBoard) && botId ? {
    board: boardOf, name: id => directory.botName?.(id) ?? id, choices: directory.assignees?.(botId) ?? [],
    staffBoard: id => directory.boardOf?.(id), canOpen: id => directory.canOpenBot?.(id) ?? false, open: id => directory.openBot?.(id),
    ...(directory.writeBoard ? { save: edit => directory.writeBoard!(botId, edit) } : {}) } : undefined;
  const routinesOf = detailsShown && botId ? directory?.routinesOf?.(botId) : undefined;
  const [account, reloadAccount] = useAccountUnattended(routinesOf ? directory?.unattendedOf : undefined);
  const botPaused = !!(botId && account?.settings.bots?.[botId]?.paused);
  const models = state?.agent?.runtimeInfo.settings?.find(setting => setting.id === 'model' && setting.category === 'model')?.options.map(option => ({ value: option.value, label: option.label }));
  const hold = account?.settings.paused ? 'paused' : account?.absent ? 'absence' : botPaused ? 'bot_paused' : account?.tripped.some(item => item.scope === 'account' || item.scope === botId) ? 'budget' : undefined;
  const routines: RoutinesChoice | undefined = routinesOf && directory?.routineAct && botId ? { routines: routinesOf, zone: account?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, ...(hold ? { hold } : {}), botPaused, ...(models?.length ? { models } : {}),
    ...(directory?.setUnattended ? { pauseBot: async (paused: boolean) => { await directory.setUnattended!({ bots: { [botId]: { paused } } }); reloadAccount(); } } : {}),
    ...(directory.hookUrl ? { hookUrl: directory.hookUrl } : {}),
    save: async spec => hookOf(await directory.routineAct!({ action: 'routine_set', botId, ...spec })),
    rotateHook: async name => hookOf(await directory.routineAct!({ action: 'routine_rotate_hook', botId, name })), pause: async (name, paused) => { await directory.routineAct!({ action: 'routine_pause', botId, name, paused }); },
    remove: async name => { await directory.routineAct!({ action: 'routine_delete', botId, name }); }, test: async name => { await directory.routineAct!({ action: 'routine_test', botId, name }); } } : undefined;
  useWatchTeamRoster(!!board);
  const workLog = detailsShown && botId && directory?.workLog ? directory.workLog(botId) : [];
  const answering = detailsShown && botId && directory?.answering ? directory.answering(botId) : [];
  const bots = detailsShown && botId && directory?.staff ? directory.staff(botId) : [];
  const chiefs = detailsShown && botId ? directory?.chief?.(botId) : undefined;
  const pages = detailsShown && botId ? directory?.pagesOf?.(botId) ?? [] : [];
  const primaryState = detailsShown && botId ? directory?.primary?.(botId) : undefined;
  // The files of a timeline that has not loaded are unknown, not none: the section waits rather than say nothing was changed.
  const files = useMemo(() => detailsShown && state?.timeline.initialized ? sessionFiles(state.timeline.entries) : undefined, [detailsShown, state?.timeline.initialized, state?.timeline.entries]);
  const reportedSession = state?.agent?.runtimeInfo.sessionId;
  const lastTurn = detailsShown ? Date.parse(state?.timeline.entries.at(-1)?.timestamp ?? '') || undefined : undefined;
  const assistantRef: AssistantRef | undefined = detailsShown ? {
    id: details?.id ?? displayScope ?? 'assistant', name: details?.name ?? assistant?.name ?? t('conversation.assistant'), ...details,
    ...(host?.action ? { action: host.action } : {}), ...(host?.actions ? { actions: host.actions } : {}),
    ...(host?.where ? { where: host.where } : {}), ...(host?.setPicture ? { setPicture: host.setPicture } : {}),
    ...(host?.rename ? { rename: host.rename } : {}),
    ...(routines ? { routines } : {}), process, ...(mission ? { mission } : {}), ...(memory ? { memory } : {}),
    ...(chiefs && botId && directory?.setChief ? { chief: { ...chiefs, move: (chief: string | null) => directory.setChief!(botId, chief) } } : {}), ...(primaryState && botId && directory?.setPrimary ? { primary: { ...primaryState, set: (primary: boolean) => directory.setPrimary!(botId, primary) } } : {}), ...(pages.length ? { pages } : {}), ...(tasks.length ? { tasks } : {}), ...(board ? { board } : {}), ...(answering.length ? { answering } : {}), ...(workLog.length ? { workLog } : {}), ...(bots.length ? { bots } : {}),
    sessions: { ...details?.sessions, ...(lastTurn ? { time: lastTurn } : {}), ...(state?.agent?.cwd ? { directory: state.agent.cwd } : {}), ...(reportedSession ? { sessionId: reportedSession } : {}),
      subagents: reportedSession ? childrenFor?.(reportedSession) ?? [] : [], ...(onOpenChildSession ? { openSubagent: onOpenChildSession } : {}),
      tools: <>{details?.sessions?.tools}{workspaceLink}</> },
    ...(state?.agent && !draftOnly ? { settings: <ModelSettings state={state} sessionState={session} readOnly={readOnly || mutationBlocked}
      {...(actions.setSessionSetting ? { onSelect: (id: string, value: string) => actions.setSessionSetting!(id, value) } : {})} {...(renderSessionSettingError ? { renderError: renderSessionSettingError } : {})}
      planning={<PlanningControl sessionState={session} key={state.agent.id} state={state} sessionStatus={sessionStatus} onSetPlanning={actions.setPlanning} />} /> } : {}),
    files, ...(filePreview && state ? { openFile: (file, trigger) => {
      const entry = state.timeline.entries.find(item => timelineEntryKey(item) === file.entryKey);
      filePreview.open({ locator: file.path, returnFocus: trigger, context: { scopeKey: JSON.stringify([state.agent?.id, file.entryKey]), bindings: entry?.resources ?? [],
        resources: state.resources, ...(actions.resolveResource ? { resolveResource: actions.resolveResource } : {}), ...(actions.requestResource ? { requestResource: actions.requestResource } : {}) } });
    } } : {}),
  } : undefined;
  const panel = assistantRef && host ? <Suspense fallback={null}><AssistantDetails assistant={assistantRef} surface={host.surface} onClose={() => host.setOpen(false)} /></Suspense> : null;
  return panel && host?.surface === 'panel' && host.slot ? createPortal(panel, host.slot) : panel;
}

/** The account's unattended work while a bot's routines are on screen: read when they open and once a minute after, while the page is visible. */
function useAccountUnattended(load: (() => Promise<UnattendedView | undefined>) | undefined): readonly [UnattendedView | undefined, () => void] {
  const [view, setView] = useState<UnattendedView>(), [reads, setReads] = useState(0);
  useEffect(() => {
    if (!load) return;
    let live = true;
    const read = () => { void load().then(next => { if (live) setView(next); }, () => undefined); };
    read();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') read(); }, 60_000);
    return () => { live = false; clearInterval(timer); };
  }, [load, reads]);
  return [view, () => setReads(count => count + 1)];
}

/** The token of a webhook address the Relay returned with a routine change, if it did. */
const hookOf = (result: unknown): { token: string } | undefined => {
  const hook = (result as { hook?: { token?: unknown } } | undefined)?.hook;
  return typeof hook?.token === 'string' ? { token: hook.token } : undefined;
};
