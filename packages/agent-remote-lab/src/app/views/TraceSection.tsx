// The Trace view.
import { Suspense } from 'react';
import { LazyTraceView as TraceView, useEverShown } from '../lazy-screens.js';
import type { AppScope } from '../types.js';

export function TraceSection({ scope }: { readonly scope: Pick<AppScope, 'accessReady' | 'activeOpened' | 'activeView' | 'conversationActions' | 'hostOffline' | 'inspectTimelineEntry' | 'pageOpen' | 'primaryNavigation' | 'setTraceViewTarget' | 'state' | 'status' | 'traceRequest' | 'traceScope' | 'windowMode'> }) {
  const { accessReady, activeOpened, activeView, conversationActions, hostOffline, inspectTimelineEntry, pageOpen, primaryNavigation, setTraceViewTarget, state, status, traceRequest, traceScope, windowMode } = scope;
  const opened = useEverShown(activeView === 'trace' && !pageOpen);
  return <>
      <section
        id="lab-trace"
        data-testid="trace-view"
        role="tabpanel"
        aria-labelledby="lab-trace-tab"
        hidden={activeView !== 'trace' || pageOpen}
      >
        {opened ? <Suspense fallback={null}><TraceView key={traceScope} state={state} visible={windowMode && activeView === 'trace' && !pageOpen}
          headingStart={<div ref={setTraceViewTarget} data-pane-selection-ignore className="lab-global-view-slot" />}
          sessionTitle={activeOpened?.title} sessionStatus={!accessReady ? 'connecting' : hostOffline ? 'disconnected' : status}
          revealEntry={traceRequest?.view === 'trace' ? traceRequest : undefined}
          onShowConversation={key => inspectTimelineEntry(key, 'workbench')}
          resolveSessionLink={primaryNavigation.resolveSessionLink} onLoadOlder={!hostOffline ? conversationActions.loadOlder : undefined} /></Suspense> : null}
      </section>
  </>;
}
