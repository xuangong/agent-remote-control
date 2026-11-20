// The brand, connection summary and the Workbench and Trace tabs.
import type { AppScope } from '../types.js';

export function AppBar({ scope }: { readonly scope: Pick<AppScope, 'activeAgentId' | 'activeView' | 'attach' | 'backgroundInert' | 'closePage' | 'connectionAgentId' | 'connectionProviderName' | 'connectionStatusLabel' | 'connectionSummaryRef' | 'directory' | 'handleViewKeyDown' | 'headerHidden' | 'openSession' | 'openedSessions' | 'setHeaderViewTarget' | 'showView' | 'state' | 'traceTabRef' | 'transitioning' | 'windowWorkspace' | 'workbenchTabRef'> }) {
  const { activeAgentId, activeView, attach, backgroundInert, closePage, connectionAgentId, connectionProviderName, connectionStatusLabel, connectionSummaryRef, directory, handleViewKeyDown, headerHidden, openSession, openedSessions, setHeaderViewTarget, showView, state, traceTabRef, transitioning, windowWorkspace, workbenchTabRef } = scope;
  return <>
    <header className="lab-app-bar" hidden={headerHidden || windowWorkspace.unavailable}>
      <div className="lab-brand">
        <div ref={setHeaderViewTarget} data-pane-selection-ignore className="lab-global-view-slot" />
        <div>
          <p>Agent Remote Control</p>
          <h1>Agent conversations</h1>
        </div>
      </div>
      <details
        ref={connectionSummaryRef}
        className="lab-session-summary"
        data-testid="connection-summary"
        aria-label={`${connectionProviderName}. Agent ${connectionAgentId}. ${connectionStatusLabel}`}
        onBlur={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}
      >
        <summary aria-label="Connection details" title="Connection details"><span className={`lab-status-dot lab-status-${state?.agent?.status ?? 'disconnected'}`} aria-hidden="true" />
        <span>{connectionProviderName}</span>
        <span className="lab-connection-status" aria-live="polite">{connectionStatusLabel}</span><span aria-hidden="true">▾</span></summary>
        <div className="lab-connection-details"><strong>{connectionProviderName}</strong><code>{connectionAgentId}</code>
        {directory && activeAgentId ? <button type="button" className="lab-session-reconnect" disabled={transitioning} onClick={() => {
          const saved = openedSessions.find((item) => item.agentId === activeAgentId);
          if (saved) void openSession(saved); else attach(activeAgentId);
        }}>Reconnect</button> : null}
        </div>
      </details>
      <nav className="lab-view-switcher" role="tablist" aria-label="Observatory views" {...backgroundInert}>
        <button
          ref={workbenchTabRef}
          id="lab-workbench-tab"
          type="button"
          role="tab"
          aria-selected={activeView === 'workbench'}
          aria-controls="lab-workbench"
          tabIndex={activeView === 'workbench' ? 0 : -1}
          onClick={() => showView('workbench')}
          onKeyDown={handleViewKeyDown}
        >Workbench</button>
        <button
          ref={traceTabRef}
          id="lab-trace-tab"
          type="button"
          role="tab"
          aria-selected={activeView === 'trace'}
          aria-controls="lab-trace"
          tabIndex={activeView === 'trace' ? 0 : -1}
          onClick={() => { showView('trace'); closePage(); }}
          onKeyDown={handleViewKeyDown}
        >Trace</button>
      </nav>
    </header>
  </>;
}
