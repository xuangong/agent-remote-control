import { useRef, useState } from 'react';
import type {
  AgentChildSession,
  AgentInteractionResponse,
  ResourceBinding,
} from '@borgee/agent-remote-protocol';

import type { AgentReplicaState } from '../replica/types.js';
import { AgentChildSessionList } from './AgentChildSessionList.js';
import { InteractionPanel } from './InteractionPanel.js';
import type { QuestionDraft } from './interactions/QuestionCard.js';
import { ResourceList } from './ResourceList.js';
import type { RendererRegistry } from './renderer-registry.js';
import { TimelineItemRenderer } from './TimelineItemRenderer.js';
import { createTimelineRenderModel } from './timeline-render-model.js';

export type AgentTimelineState = AgentReplicaState;

export interface AgentTimelineProps {
  readonly state: AgentReplicaState;
  readonly registry?: RendererRegistry;
  readonly showHeader?: boolean;
  readonly onOpenChildSession?: (child: AgentChildSession) => void | Promise<void>;
  readonly historyLoading?: boolean;
  readonly historyError?: string;
  readonly onLoadOlder?: () => void | Promise<void>;
  readonly onInteractionResponse?: (requestId: string, response: AgentInteractionResponse) => Promise<void>;
  readonly onResourceRequest?: (binding: ResourceBinding) => Promise<void>;
  readonly questionDrafts?: Readonly<Record<string, QuestionDraft>>;
  readonly onQuestionDraftChange?: (requestId: string, draft: QuestionDraft) => void;
}

export function AgentTimeline({
  state,
  registry,
  showHeader = true,
  onLoadOlder,
  historyLoading,
  historyError,
  onOpenChildSession,
  onInteractionResponse,
  onResourceRequest,
  questionDrafts,
  onQuestionDraftChange,
}: AgentTimelineProps) {
  const renderModel = createTimelineRenderModel(state.timeline.epoch, state.timeline.entries);
  const discovered = useRef({ identity: '', order: new Map<string, number>() });
  const identity = JSON.stringify([state.agent?.providerId, state.agent?.id]);
  if (discovered.current.identity !== identity) discovered.current = { identity, order: new Map() };
  const children = [...(state.agent?.runtimeInfo.childSessions ?? [])];
  for (const child of children) {
    if (!discovered.current.order.has(child.nativeSessionId)) discovered.current.order.set(child.nativeSessionId, discovered.current.order.size);
  }
  children.sort((a, b) => (Date.parse(a.createdAt) - Date.parse(b.createdAt))
    || discovered.current.order.get(a.nativeSessionId)! - discovered.current.order.get(b.nativeSessionId)!);
  const replies = new Map<string, string>();
  const calls = new Map<string, string>();
  for (const { entry, key } of renderModel) {
    if (!entry.turnId) continue;
    if (entry.item.type === 'assistant_message') replies.set(entry.turnId, key);
    if (entry.item.type === 'tool_call') calls.set(entry.item.callId, entry.turnId);
  }
  const childrenByReply = new Map<string, AgentChildSession[]>();
  const unassociated: AgentChildSession[] = [];
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
      {renderModel.length === 0
        ? <p className="agent-timeline-empty">No timeline activity.</p>
        : renderModel.map(({ entry, key, messageGroup }) => <div className="agent-timeline-entry" key={key} data-entry-key={key}>
            <TimelineItemRenderer item={entry.item} messageGroup={messageGroup} />
            {registry?.render(entry.item)}
            <ResourceList bindings={entry.resources} resources={state.resources} onRequest={onResourceRequest} />
            <AgentChildSessionList children={childrenByReply.get(key) ?? []} onOpenChildSession={onOpenChildSession} />
          </div>)}
    </div>

    <AgentChildSessionList key={identity} children={unassociated} label="Session subagents" onOpenChildSession={onOpenChildSession} />

    {state.pendingInteractions.length > 0 ? <aside className="agent-interactions" aria-label="Pending interactions">
      {state.pendingInteractions.map((request) => <InteractionPanel
        key={JSON.stringify([state.agent?.id, request.requestId])}
        request={request}
        onResponse={onInteractionResponse}
        questionDraft={questionDrafts?.[request.requestId]}
        onQuestionDraftChange={onQuestionDraftChange ? (draft) => onQuestionDraftChange(request.requestId, draft) : undefined}
      />)}
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
