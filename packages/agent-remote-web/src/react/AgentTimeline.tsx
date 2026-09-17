import { useRef, useState } from 'react';
import type {
  AgentInteractionResponse,
  ResourceBinding,
} from '@agent-remote-controller/agent-remote-protocol';

import type { AgentReplicaState } from '../replica/types.js';
import type { SessionLinkResolver } from './items/ToolCallItem.js';
import { AgentChildSessionList, type AgentChildSessionView } from './AgentChildSessionList.js';
import { InteractionPanel } from './InteractionPanel.js';
import type { QuestionDraft } from './interactions/QuestionCard.js';
import { ResourceList } from './ResourceList.js';
import type { RendererRegistry } from './renderer-registry.js';
import { TimelineItemRenderer } from './TimelineItemRenderer.js';
import { createTimelineRenderModel } from './timeline-render-model.js';
import { PreviewActions, type PreviewController } from './PreviewActions.js';
import { usePreviewController } from './PreviewContext.js';
import { OutgoingMessageItem } from './OutgoingMessageItem.js';

export type AgentTimelineState = AgentReplicaState;

export interface AgentTimelineProps {
  readonly state: AgentReplicaState;
  readonly onInspectEntry?: (entryKey: string) => void;
  readonly inspectedEntryKey?: string;
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
  readonly onResourceRequest?: (binding: ResourceBinding) => Promise<void>;
  readonly onResourceResolve?: (locator: string, sourceLocator?: string) => Promise<ResourceBinding>;
  readonly questionDrafts?: Readonly<Record<string, QuestionDraft>>;
  readonly onQuestionDraftChange?: (requestId: string, draft: QuestionDraft) => void;
  readonly previewController?: PreviewController;
}

export function AgentTimeline({
  state,
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
  onResourceRequest,
  onResourceResolve,
  questionDrafts,
  onQuestionDraftChange,
  previewController,
  onInspectEntry,
  inspectedEntryKey,
}: AgentTimelineProps) {
  const inheritedPreviewController = usePreviewController();
  const previews = previewController ?? inheritedPreviewController;
  const renderModel = createTimelineRenderModel(state.timeline.epoch, state.timeline.entries);
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
  const replies = new Map<string, string>();
  const calls = new Map<string, string>();
  for (const { entry, key } of renderModel) {
    if (!entry.turnId) continue;
    if (entry.item.type === 'assistant_message') replies.set(entry.turnId, key);
    if (entry.item.type === 'tool_call') calls.set(entry.item.callId, entry.turnId);
  }
  const childrenByReply = new Map<string, AgentChildSessionView[]>();
  const unassociated: AgentChildSessionView[] = [];
  for (const child of children) {
    const turnId = child.parentTurnId ?? (child.parentCallId ? calls.get(child.parentCallId) : undefined);
    const key = turnId ? replies.get(turnId) : undefined;
    if (key) childrenByReply.set(key, [...(childrenByReply.get(key) ?? []), child]);
    else unassociated.push(child);
  }
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
        ? <p className="agent-timeline-empty">No timeline activity.</p>
        : renderModel.map(({ entry, key, messageGroup }) => <div className="agent-timeline-entry" key={key} data-entry-key={key} data-inspected={inspectedEntryKey === key || undefined} tabIndex={onInspectEntry ? -1 : undefined}>
            {onInspectEntry ? <button className="agent-inspect-entry" type="button" aria-label={`Inspect event #${entry.seqStart} in Trace`} title="Inspect in Trace" onClick={() => onInspectEntry(key)}>
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 4h5m-5 6h5m-5 6h5M5 4v12m6-6h6m-3-3 3 3-3 3" /></svg>
            </button> : null}
            <TimelineItemRenderer item={entry.item} messageGroup={messageGroup} resolveSessionLink={resolveSessionLink}
              resources={state.resources} resourceBindings={entry.resources}
              resourceScopeKey={JSON.stringify([state.agent?.id, state.timeline.epoch])}
              onResourceResolve={onResourceResolve} onResourceRequest={onResourceRequest} />
            {previews && state.agent?.id ? <PreviewActions agentId={state.agent.id} itemId={key} text={previewText(entry.item)} controller={previews} /> : null}
            {registry?.render(entry.item)}
            <ResourceList bindings={entry.resources} resources={state.resources} onRequest={onResourceRequest} />
            <AgentChildSessionList childrenFor={childrenFor} children={childrenByReply.get(key) ?? []} onOpenChildSession={onOpenChildSession} />
          </div>)}
      {outgoing.map(message => <OutgoingMessageItem key={message.id} message={message} />)}
    </div>

    <AgentChildSessionList childrenFor={childrenFor} key={identity} children={unassociated} label="Session subagents" collapsible onOpenChildSession={onOpenChildSession} />

    {state.pendingInteractions.length > 0 ? <aside className="agent-interactions" aria-label="Pending interactions">
      {state.pendingInteractions.map((request) => <fieldset
        className="agent-interaction-lock"
        disabled={interactionDisabled}
        key={JSON.stringify([state.agent?.id, request.requestId])}
      ><InteractionPanel
          request={request}
          onResponse={onInteractionResponse}
          questionDraft={questionDrafts?.[request.requestId]}
          onQuestionDraftChange={onQuestionDraftChange ? (draft) => onQuestionDraftChange(request.requestId, draft) : undefined}
        /></fieldset>)}
    </aside> : null}
  </section>;
}

function previewText(item: AgentReplicaState['timeline']['entries'][number]['item']): string {
  switch (item.type) {
    case 'user_message':
    case 'assistant_message':
    case 'reasoning': return item.text;
    case 'error': return item.message;
    case 'tool_call': return [toolDetailText(item.detail), ...(item.result?.content.map(content => content.type === 'text' ? content.text : JSON.stringify(content.value)) ?? [])].join('\n');
    case 'todo': return item.items.map(task => task.text).join('\n');
    case 'interaction': return JSON.stringify(item.request);
    case 'compaction': return '';
  }
}

function toolDetailText(detail: Extract<AgentReplicaState['timeline']['entries'][number]['item'], { type: 'tool_call' }>['detail']): string {
  switch (detail.type) {
    case 'shell': return detail.command;
    case 'read':
    case 'edit':
    case 'write': return detail.filePath;
    case 'search': return detail.query;
    case 'fetch': return detail.url;
    case 'other': return detail.description;
  }
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
