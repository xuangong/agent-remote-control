// What a view says about its Trace: opening an entry in the Trace, and revealing the entry the Trace or a letter asked for.
import type { SessionViewContribution, SessionViewContext } from '../../conversation/session-view-contribution.js';
import type { PresentationScope } from './scope.js';

export type TraceContributionInputs = Pick<PresentationScope, 'letterReveals' | 'setTraceNavigation' | 'showView' | 'state' | 'traceRequest' | 'traceRequestCounter' | 'windowWorkspace'>;

export const traceContribution = ({ letterReveals, setTraceNavigation, showView, state, traceRequest, traceRequestCounter, windowWorkspace }: TraceContributionInputs) => ({ context, source, view, botPresentation }: SessionViewContext): SessionViewContribution => ({
  props: {
    onInspectEntry: botPresentation ? undefined : (key: string) => {
      if (view) windowWorkspace.authority?.operate({ type: 'view.select', viewId: view.id });
      setTraceNavigation({ scope: JSON.stringify([context.state?.agent?.id, context.state?.timeline.epoch]), key, view: 'trace', requestId: ++traceRequestCounter.current });
      showView('trace');
    },
    revealEntry: botPresentation ? undefined : letterReveals[source.agentId] ?? (traceRequest?.view === 'workbench' && context.state?.agent?.id === state?.agent?.id ? traceRequest : undefined),
  },
});
