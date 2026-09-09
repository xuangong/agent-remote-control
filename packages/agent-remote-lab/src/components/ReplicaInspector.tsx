import type { AgentReplicaState, RemoteSessionStatus } from '@borgee/agent-remote-web';

export function ReplicaInspector({ state, sessionStatus, providerName }: { state?: AgentReplicaState; sessionStatus: RemoteSessionStatus; providerName?: string }) {
  const snapshot = state?.agent;
  const timeline = state?.timeline;
  const capabilities = snapshot?.capabilities;
  const capabilityRows: Array<[string, boolean]> = capabilities ? [
    ['history', capabilities.history],
    ['send message', capabilities.sendMessage],
    ['steer', capabilities.steer],
    ['cancel', capabilities.cancel],
    ['resource read', capabilities.readResource],
    ['question', capabilities.interactions.question],
    ['plan approval', capabilities.interactions.planApproval],
    ['tool approval', capabilities.interactions.toolApproval],
  ] : [];
  return <section className="lab-panel lab-replica-inspector" data-testid="replica-inspector" aria-label="Replica Inspector">
    <p className="lab-eyebrow">Agent Snapshot</p>
    {snapshot ? <>
      <div className="lab-status-row">
        <strong data-testid="session-status">{snapshot.status}</strong>
        <span>{providerName ?? snapshot.providerId}</span>
      </div>
      <dl className="lab-state-grid">
        <div><dt>Agent</dt><dd><code title={snapshot.id}>{snapshot.id}</code></dd></div>
        <div><dt>Provider session</dt><dd>{snapshot.runtimeInfo.sessionId ? <code title={snapshot.runtimeInfo.sessionId}>{snapshot.runtimeInfo.sessionId}</code> : '—'}</dd></div>
        <div><dt>Connection</dt><dd data-testid="connection-status">{sessionStatusLabel(sessionStatus)}</dd></div>
        <div><dt>Turn</dt><dd>{snapshot.activeTurn?.turnId ? <code title={snapshot.activeTurn.turnId}>{snapshot.activeTurn.turnId}</code> : '—'}</dd></div>
        <div><dt>Model</dt><dd>{snapshot.model ?? snapshot.runtimeInfo.model ?? '—'}</dd></div>
        <div><dt>Mode</dt><dd>{snapshot.runtimeInfo.mode ?? '—'}</dd></div>
      </dl>
    </> : <><p data-testid="session-status">No Agent</p><p>Connection <span data-testid="connection-status">{sessionStatusLabel(sessionStatus)}</span></p></>}
    <p className="lab-eyebrow">Timeline synchronization</p>
    <dl className="lab-state-grid">
      <div><dt>Epoch</dt><dd data-testid="timeline-epoch">{timeline?.epoch ? <code title={timeline.epoch}>{timeline.epoch}</code> : '—'}</dd></div>
      <div><dt>Contiguous sequence</dt><dd>{Math.max(0, (timeline?.nextSeq ?? 1) - 1)}</dd></div>
      <div><dt>Pending live</dt><dd>{timeline?.pendingLive.length ?? 0}</dd></div>
      <div><dt>Pending interactions</dt><dd>{state?.pendingInteractions.length ?? 0}</dd></div>
      <div><dt>Retired epochs</dt><dd>{state?.retiredEpochs.length ? state.retiredEpochs.map((epoch) => <code key={epoch} title={epoch}>{epoch}</code>) : 'none'}</dd></div>
      <div><dt>Resources</dt><dd>{Object.keys(state?.resources ?? {}).length}</dd></div>
    </dl>
    <div className="lab-capabilities"><span>Declared capabilities</span><ul>
      {capabilityRows.map(([label, supported]) => <li key={label}>{label} {supported ? 'available' : 'unavailable'}</li>)}
    </ul></div>
    <section className="lab-inspector-group" aria-label="Client diagnostics">
      <h3>Client diagnostics</h3>
      {state?.diagnostics.length ? state.diagnostics.map((diagnostic, index) => <p key={`${diagnostic.code}-${index}`}>
        <code>{diagnostic.code}</code> {diagnostic.message}
      </p>) : <p>No public client diagnostics observed.</p>}
    </section>
  </section>;
}

function sessionStatusLabel(status: RemoteSessionStatus): string {
  switch (status) {
    case 'connecting': return 'Connecting';
    case 'catching_up': return 'Synchronizing';
    case 'disconnected': return 'Reconnecting';
    case 'ready': return 'Ready';
    case 'idle': return 'Ready';
  }
}
