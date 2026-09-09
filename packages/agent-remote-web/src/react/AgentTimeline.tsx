import { useRef, useState } from 'react';
import type {
  AgentInteractionResponse,
  ResourceBinding,
} from '@borgee/agent-remote-protocol';

import type { AgentReplicaState } from '../replica/types.js';
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
  onInteractionResponse,
  onResourceRequest,
  questionDrafts,
  onQuestionDraftChange,
}: AgentTimelineProps) {
  const renderModel = createTimelineRenderModel(state.timeline.epoch, state.timeline.entries);
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

    {state.timeline.hasOlder ? <HistoryControls
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
          </div>)}
    </div>

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

function HistoryControls({ onLoadOlder }: { readonly onLoadOlder?: () => void | Promise<void> }) {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();

  async function loadOlder(): Promise<void> {
    if (!onLoadOlder || inFlight.current) return;
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
      disabled={!onLoadOlder || pending}
      aria-busy={pending}
      onClick={() => { void loadOlder(); }}
    >{pending ? 'Loading earlier activity…' : 'Load earlier activity'}</button>
    {failure ? <p className="agent-history-error" role="alert">{failure}</p> : null}
  </div>;
}
