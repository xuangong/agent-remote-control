import type { ResourceResponseState } from '@orchardworks/agent-remote-protocol';
import { useContext, useMemo, useRef, useState } from 'react';
import type {
  AgentInteractionResponse,
  ResourceBinding,
} from '@orchardworks/agent-remote-protocol';

import type { AgentReplicaState } from '../replica/types.js';
import type { SessionLinkResolver } from './items/ToolCallItem.js';
import { AgentChildSessionList, type AgentChildSessionView } from './AgentChildSessionList.js';
import { InteractionPanel } from './InteractionPanel.js';
import type { QuestionDraft } from './interactions/QuestionCard.js';
import type { RendererRegistry } from './renderer-registry.js';
import { ConversationEntry } from './ConversationEntry.js';
import { createTimelineRenderModel, type TimelineRenderEntry } from './timeline-render-model.js';
import { groupRuntimeNotices, RuntimeNoticeGroup, useRuntimeNoticeDisclosure, type RuntimeNoticePresentation } from './RuntimeNoticeGroup.js';
import type { PreviewController } from './PreviewActions.js';
import { usePreviewController } from './PreviewContext.js';
import { OutgoingMessageItem } from './OutgoingMessageItem.js';
import { TimelineDisplay, TimelineLettersVisible, isContentOnlyItem } from './TimelineDisplay.js';
import { timelineEntryKey } from '../replica/timeline-entry-key.js';
import { useTimelineAction } from './useTimelineAction.js';

export type AgentTimelineState = AgentReplicaState;

export interface AgentTimelineProps {
  readonly searchEntryKey?: string;
  readonly searchRequestId?: number;
  readonly onEditPrompt?: (entry: import('@orchardworks/agent-remote-protocol').ProjectedTimelineEntry) => Promise<void>;
  readonly state: AgentReplicaState;
  readonly onRetryMessage?: (id: string) => Promise<void>;
  readonly onDeleteMessage?: (id: string) => void;
  readonly onInspectEntry?: (entryKey: string) => void;
  readonly inspectedEntryKey?: string;
  readonly inspectedRequestId?: number;
  readonly childrenFor?: (nativeSessionId: string) => readonly AgentChildSessionView[];
  readonly resolveSessionLink?: SessionLinkResolver;
  readonly registry?: RendererRegistry;
  readonly showHeader?: boolean;
  readonly onOpenChildSession?: (child: AgentChildSessionView) => void | Promise<void>;
  readonly historyLoading?: boolean;
  readonly historyError?: string;
  readonly onLoadOlder?: () => void | Promise<void>;
  readonly onInteractionResponse?: (requestId: string, response: AgentInteractionResponse) => Promise<void>;
  readonly interactionDisabled?: boolean;
  readonly interactionsWaitingForConnection?: boolean;
  readonly interactionsReadOnly?: boolean;
  readonly onResourceRequest?: (binding: ResourceBinding) => Promise<void | ResourceResponseState>;
  readonly onResourceResolve?: (locator: string, sourceLocator?: string) => Promise<ResourceBinding>;
  readonly questionDrafts?: Readonly<Record<string, QuestionDraft>>;
  readonly onQuestionDraftChange?: (requestId: string, draft: QuestionDraft) => void;
  readonly previewController?: PreviewController;
}

export function AgentTimeline({
  state,
  searchEntryKey,
  searchRequestId,
  onEditPrompt,
  onRetryMessage,
  onDeleteMessage,
  registry,
  resolveSessionLink,
  childrenFor,
  showHeader = true,
  onLoadOlder,
  historyLoading,
  historyError,
  onOpenChildSession,
  onInteractionResponse,
  interactionDisabled = false,
  interactionsWaitingForConnection = false,
  interactionsReadOnly = false,
  onResourceRequest,
  onResourceResolve,
  questionDrafts,
  onQuestionDraftChange,
  previewController,
  onInspectEntry,
  inspectedEntryKey,
  inspectedRequestId,
}: AgentTimelineProps) {
  const inheritedPreviewController = usePreviewController();
  const previews = previewController ?? inheritedPreviewController;
  const contentOnly = useContext(TimelineDisplay) === 'content';
  const lettersVisible = useContext(TimelineLettersVisible);
  const scopeKey = JSON.stringify([state.agent?.id, state.timeline.epoch]);
  const editPrompt = useTimelineAction(scopeKey, onEditPrompt);
  const inspectEntry = useTimelineAction(scopeKey, onInspectEntry);
  const resolveResource = useTimelineAction(scopeKey, onResourceResolve);
  const requestResource = useTimelineAction(scopeKey, onResourceRequest);
  const editablePrompts = useMemo(() => {
    const prompts = new Set<import('@orchardworks/agent-remote-protocol').ProjectedTimelineEntry>();
    const turns = new Set<string>();
    // Inspect the unfiltered timeline: hidden activity still proves a prompt is mid-turn.
    for (const entry of state.timeline.entries) {
      if (!entry.turnId) continue;
      const turn = JSON.stringify([entry.providerId, entry.turnId]);
      if (turns.has(turn)) continue;
      const incompleteBoundary = state.timeline.hasOlder && turns.size === 0;
      turns.add(turn);
      // The first loaded turn may start on an older page. Keep its edit action hidden until known.
      if (!incompleteBoundary && entry.item.type === 'user_message' && entry.item.messageId) prompts.add(entry);
    }
    return prompts;
  }, [state.timeline.entries, state.timeline.hasOlder]);
  const entries = useMemo(() => {
    if (!contentOnly && lettersVisible) return state.timeline.entries;
    return state.timeline.entries.filter(entry => {
      if (searchEntryKey !== undefined && timelineEntryKey(state.timeline.epoch, entry) === searchEntryKey) return true;
      if (!lettersVisible && entry.item.type === 'agent_communication') return false;
      return !contentOnly || isContentOnlyItem(entry.item);
    });
  }, [contentOnly, lettersVisible, state.timeline.entries, state.timeline.epoch, searchEntryKey]);
  const renderModel = useMemo(() => createTimelineRenderModel(state.timeline.epoch, entries), [state.timeline.epoch, entries]);
  const rows = useMemo(() => groupRuntimeNotices(renderModel, state.timeline.entries), [renderModel, state.timeline.entries]);
  const notices = useRuntimeNoticeDisclosure(scopeKey, searchEntryKey, inspectedEntryKey, searchRequestId, inspectedRequestId);
  const renderEntry = ({ entry, key, messageGroup }: TimelineRenderEntry, notice?: RuntimeNoticePresentation) =>
    <ConversationEntry key={key} entry={entry} entryKey={key}
      searchSelected={key === searchEntryKey} messageGroup={messageGroup} contentOnly={contentOnly} agentId={state.agent?.id}
      scopeKey={scopeKey} resources={state.resources}
      onEditPrompt={editablePrompts.has(entry) ? editPrompt : undefined}
      onInspectEntry={!contentOnly ? inspectEntry : undefined} inspected={inspectedEntryKey === key}
      resolveSessionLink={entry.item.type === 'tool_call' ? resolveSessionLink : undefined}
      onResourceResolve={resolveResource} onResourceRequest={requestResource}
      previews={previews} extension={!contentOnly ? registry?.render(entry.item) : undefined}
      {...notice} />;
  const outgoing = (state.outgoingMessages ?? []).filter(message => message.agentId === state.agent?.id);
  const discovered = useRef({ identity: '', order: new Map<string, number>() });
  const identity = JSON.stringify([state.agent?.providerId, state.agent?.id]);
  if (discovered.current.identity !== identity) discovered.current = { identity, order: new Map() };
  const nativeSessionId = state.agent?.runtimeInfo.sessionId;
  const recorded = nativeSessionId ? childrenFor?.(nativeSessionId) ?? [] : [];
  const children = [...new Map([...recorded, ...(state.agent?.runtimeInfo.childSessions ?? [])].map(child => [child.nativeSessionId, child])).values()];
  for (const child of children) {
    if (!discovered.current.order.has(child.nativeSessionId)) discovered.current.order.set(child.nativeSessionId, discovered.current.order.size);
  }
  children.sort((a, b) => (Date.parse(a.createdAt ?? '') - Date.parse(b.createdAt ?? ''))
    || discovered.current.order.get(a.nativeSessionId)! - discovered.current.order.get(b.nativeSessionId)!);
  return <section className="agent-remote-surface" aria-label="Agent timeline">
    {showHeader ? <header className="agent-surface-header">
      <div>
        <span className="agent-item-kicker">REMOTE SESSION</span>
        <h2>{state.agent?.id ?? 'Agent timeline'}</h2>
      </div>
      <div className="agent-surface-state">
        <span className={`agent-presence agent-state-${state.agent?.status ?? 'starting'}`} aria-hidden="true" />
        <span>{state.agent?.status ?? 'Connecting'}</span>
        {state.timeline.epoch ? <code>{state.timeline.epoch} · {Math.max(0, state.timeline.nextSeq - 1)}</code> : null}
      </div>
    </header> : null}

    {state.timeline.hasOlder ? <HistoryControls loading={historyLoading} error={historyError}
      key={JSON.stringify([state.agent?.id, state.timeline.epoch])}
      onLoadOlder={onLoadOlder}
    /> : null}

    <div className="agent-timeline-entries" aria-live="polite">
      {renderModel.length === 0 && outgoing.length === 0
        ? <p className="agent-timeline-empty">{contentOnly ? 'No conversation content in the loaded history.' : 'No timeline activity.'}</p>
        : rows.map(row => row.type === 'entry' ? renderEntry(row.value) : <RuntimeNoticeGroup key={row.key}
            entries={row.entries} expanded={notices.isExpanded(row.entries)} toggle={() => notices.toggle(row.entries)}
            renderEntry={renderEntry} />)}
      {outgoing.map(message => <OutgoingMessageItem key={message.id} message={message} resourceContext={onResourceResolve && onResourceRequest ? { scopeKey: JSON.stringify([state.agent?.id, state.timeline.epoch]), bindings: [], resources: state.resources, resolveResource: onResourceResolve, requestResource: onResourceRequest } : undefined} onRetry={onRetryMessage} onDelete={onDeleteMessage} />)}
    </div>

    <AgentChildSessionList childrenFor={childrenFor} key={identity} children={children} label="Session subagents" collapsible onOpenChildSession={onOpenChildSession} />

    {state.pendingInteractions.length > 0 ? <aside className="agent-interactions" aria-label="Pending interactions">
      {state.pendingInteractions.map((request) => <fieldset
        className="agent-interaction-lock"
        disabled={interactionDisabled}
        key={JSON.stringify([state.agent?.id, request.requestId])}
      ><InteractionPanel
          readOnly={interactionsReadOnly}
          waitingForConnection={interactionsWaitingForConnection}
          request={request}
          onResponse={onInteractionResponse}
          questionDraft={questionDrafts?.[request.requestId]}
          onQuestionDraftChange={onQuestionDraftChange ? (draft) => onQuestionDraftChange(request.requestId, draft) : undefined}
        /></fieldset>)}
    </aside> : null}
  </section>;
}

function HistoryControls({ onLoadOlder, loading = false, error }: { readonly onLoadOlder?: () => void | Promise<void>; loading?: boolean; error?: string }) {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();

  async function loadOlder(): Promise<void> {
    if (!onLoadOlder || inFlight.current || loading) return;
    inFlight.current = true;
    setPending(true);
    setFailure(undefined);
    try {
      await onLoadOlder();
    } catch (error) {
      setFailure(error instanceof Error && error.message ? error.message : 'Earlier activity could not be loaded.');
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return <div className="agent-history-controls">
    <button
      className="agent-load-older"
      type="button"
      disabled={!onLoadOlder || pending || loading}
      aria-busy={pending || loading}
      onClick={() => { void loadOlder(); }}
    >{pending || loading ? 'Loading earlier activity…' : 'Load earlier activity'}</button>
    {failure || error ? <p className="agent-history-error" role="alert">{failure ?? error}</p> : null}
  </div>;
}
