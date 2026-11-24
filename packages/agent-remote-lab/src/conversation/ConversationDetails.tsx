// The assistant's details for a conversation: what its place and its presentation know, with this conversation's process
// mode, settings and files. They open in the host's panel, as a sheet on a phone, or in a tile's own panel.
import { lazy, Suspense, useContext, useEffect, useMemo, type ReactNode } from 'react';
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
  const board = detailsShown && directory?.board && providerId && rest.length ? directory.board({ providerId, nativeSessionId: rest.join('/') }) : [];
  const bots = detailsShown && botId && directory?.staff ? directory.staff(botId) : [];
  const chiefs = detailsShown && botId ? directory?.chief?.(botId) : undefined;
  const files = useMemo(() => detailsShown && state ? sessionFiles(state.timeline.entries) : [], [detailsShown, state?.timeline.entries]);
  const reportedSession = state?.agent?.runtimeInfo.sessionId;
  const lastTurn = detailsShown ? Date.parse(state?.timeline.entries.at(-1)?.timestamp ?? '') || undefined : undefined;
  const assistantRef: AssistantRef | undefined = detailsShown ? {
    id: details?.id ?? displayScope ?? 'assistant', name: details?.name ?? assistant?.name ?? t('conversation.assistant'), ...details,
    ...(host?.action ? { action: host.action } : {}), ...(host?.actions ? { actions: host.actions } : {}),
    ...(host?.where ? { where: host.where } : {}), ...(host?.setPicture ? { setPicture: host.setPicture } : {}),
    ...(host?.rename ? { rename: host.rename } : {}),
    process, ...(mission ? { mission } : {}), ...(memory ? { memory } : {}),
    ...(chiefs && botId && directory?.setChief ? { chief: { ...chiefs, move: (chief: string | null) => directory.setChief!(botId, chief) } } : {}), ...(tasks.length ? { tasks } : {}), ...(board.length ? { board } : {}), ...(bots.length ? { bots } : {}),
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
