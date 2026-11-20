import type { AgentReplicaState, RemoteSessionStatus, Translate } from '@orchardworks/agent-client';
import { useTranslate } from '@orchardworks/agent-client-web/react';

export function ReplicaInspector({ state, sessionStatus, providerName }: { state?: AgentReplicaState; sessionStatus: RemoteSessionStatus; providerName?: string }) {
  const t = useTranslate();
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
  return <section className="lab-panel lab-replica-inspector" data-testid="replica-inspector" aria-label={t('diagnostics.inspector.title')}>
    <p className="lab-eyebrow">{t('diagnostics.inspector.snapshot')}</p>
    {snapshot ? <>
      <div className="lab-status-row">
        <strong data-testid="session-status">{snapshot.status}</strong>
        <span>{providerName ?? snapshot.providerId}</span>
      </div>
      <dl className="lab-state-grid">
        <div><dt>{t('diagnostics.inspector.agent')}</dt><dd><code title={snapshot.id}>{snapshot.id}</code></dd></div>
        <div><dt>{t('diagnostics.inspector.providerSession')}</dt><dd>{snapshot.runtimeInfo.sessionId ? <code title={snapshot.runtimeInfo.sessionId}>{snapshot.runtimeInfo.sessionId}</code> : '—'}</dd></div>
        <div><dt>{t('diagnostics.inspector.connection')}</dt><dd data-testid="connection-status">{sessionStatusLabel(sessionStatus, t)}</dd></div>
        <div><dt>{t('diagnostics.entry.turn')}</dt><dd>{snapshot.activeTurn?.turnId ? <code title={snapshot.activeTurn.turnId}>{snapshot.activeTurn.turnId}</code> : '—'}</dd></div>
        <div><dt>{t('diagnostics.inspector.model')}</dt><dd>{snapshot.model ?? snapshot.runtimeInfo.model ?? '—'}</dd></div>
        <div><dt>{t('diagnostics.inspector.mode')}</dt><dd>{snapshot.runtimeInfo.mode ?? '—'}</dd></div>
      </dl>
    </> : <><p data-testid="session-status">{t('diagnostics.inspector.noAgent')}</p><p>{t('diagnostics.inspector.connection')} <span data-testid="connection-status">{sessionStatusLabel(sessionStatus, t)}</span></p></>}
    <p className="lab-eyebrow">{t('diagnostics.inspector.sync')}</p>
    <dl className="lab-state-grid">
      <div><dt>{t('diagnostics.inspector.epoch')}</dt><dd data-testid="timeline-epoch">{timeline?.epoch ? <code title={timeline.epoch}>{timeline.epoch}</code> : '—'}</dd></div>
      <div><dt>{t('diagnostics.inspector.pendingEpoch')}</dt><dd data-testid="timeline-pending-epoch">{timeline?.pendingEpoch ? <code title={timeline.pendingEpoch}>{timeline.pendingEpoch}</code> : t('diagnostics.inspector.none')}</dd></div>
      <div><dt>{t('diagnostics.inspector.contiguous')}</dt><dd>{Math.max(0, (timeline?.nextSeq ?? 1) - 1)}</dd></div>
      <div><dt>{t('diagnostics.inspector.pendingLive')}</dt><dd>{timeline?.pendingLive.length ?? 0}</dd></div>
      <div><dt>{t('diagnostics.inspector.pendingInteractions')}</dt><dd>{state?.pendingInteractions.length ?? 0}</dd></div>
      <div><dt>{t('diagnostics.inspector.retiredEpochs')}</dt><dd>{state?.retiredEpochs.length ? state.retiredEpochs.map((epoch) => <code key={epoch} title={epoch}>{epoch}</code>) : t('diagnostics.inspector.none')}</dd></div>
      <div><dt>{t('diagnostics.inspector.resources')}</dt><dd>{Object.keys(state?.resources ?? {}).length}</dd></div>
    </dl>
    <div className="lab-capabilities"><span>{t('diagnostics.inspector.capabilities')}</span><ul>
      {capabilityRows.map(([label, supported]) => <li key={label}>{label} {supported ? t('diagnostics.inspector.available') : t('diagnostics.inspector.unavailable')}</li>)}
    </ul></div>
    <section className="lab-inspector-group" aria-label={t('diagnostics.inspector.clientDiagnostics')}>
      <h3>{t('diagnostics.inspector.clientDiagnostics')}</h3>
      {state?.diagnostics.length ? state.diagnostics.map((diagnostic, index) => <p key={`${diagnostic.code}-${index}`}>
        <code>{diagnostic.code}</code> {diagnostic.message}
      </p>) : <p>{t('diagnostics.inspector.noDiagnostics')}</p>}
    </section>
  </section>;
}

function sessionStatusLabel(status: RemoteSessionStatus, t: Translate): string {
  switch (status) {
    case 'connecting': return t('diagnostics.connection.connecting');
    case 'catching_up': return t('diagnostics.connection.catchingUp');
    case 'disconnected': return t('diagnostics.connection.disconnected');
    case 'unavailable': return t('common.unavailable');
    case 'ready': return t('diagnostics.connection.ready');
    case 'idle': return t('diagnostics.connection.ready');
  }
}
