import type { ReactNode } from 'react';
import type { AgentProviderDescriptor } from '@borgee/agent-provider-sdk';
import type { AgentPersistenceHandle } from '@borgee/agent-provider-sdk';

export type ProviderCatalogStatus = 'loading' | 'ready' | 'empty' | 'error';

export interface ProviderSessionControlsProps {
  providers: readonly AgentProviderDescriptor[];
  selectedProviderId: string;
  catalogStatus: ProviderCatalogStatus;
  catalogError?: string;
  creating: boolean;
  children?: ReactNode;
  configurationLocked?: boolean;
  planning?: boolean;
  onPlanningChange?(active: boolean): void;
  persistence?: AgentPersistenceHandle;
  onSelectedProviderChange(providerId: string): void;
  onRetryProviders(): void;
  onCreateSession(): void;
  onResumeSession?(): void;
}

export function ProviderSessionControls({ providers, selectedProviderId, catalogStatus, catalogError, creating, persistence, children, configurationLocked, planning = false, onPlanningChange, onSelectedProviderChange, onRetryProviders, onCreateSession, onResumeSession }: ProviderSessionControlsProps) {
  const canCreate = providers.some((provider) => provider.providerId === selectedProviderId) && !creating;
  const canResume = persistence !== undefined && onResumeSession !== undefined && !creating;
  return <section className="lab-panel lab-provider-controls" aria-label="Provider and session controls">
    <p className="lab-eyebrow">Session intake</p>
    <label htmlFor="provider-select">Provider</label>
    <select id="provider-select" data-testid="provider-select" value={selectedProviderId} onChange={(event) => onSelectedProviderChange(event.target.value)} disabled={providers.length === 0 || creating || configurationLocked}>
      {providers.length === 0 ? <option value="">No provider registered</option> : providers.map((provider) => <option key={provider.providerId} value={provider.providerId}>{provider.displayName}</option>)}
    </select>
    {onPlanningChange ? <>
      <label htmlFor="session-mode">New session mode</label>
      <select id="session-mode" value={planning ? 'planning' : 'normal'} onChange={(event) => onPlanningChange(event.target.value === 'planning')} disabled={!canCreate} aria-describedby="session-mode-note">
        <option value="normal">Normal chat</option><option value="planning">Planning</option>
      </select>
      <p id="session-mode-note" className="lab-control-note">Planning requires Provider support.</p>
    </> : null}
    {children}
    <button type="button" data-testid="session-create" onClick={onCreateSession} disabled={!canCreate} aria-describedby="session-create-note">{creating ? 'Opening session…' : 'Open session'}</button>
    {catalogStatus === 'loading' ? <p className="lab-control-note" role="status" aria-live="polite">Loading providers</p> : null}
    {catalogStatus === 'empty' ? <p id="session-create-note" className="lab-control-note">No Provider is registered in this lab server.</p> : null}
    {catalogStatus === 'error' ? <p id="session-create-note" className="lab-control-note" role="alert">{catalogError}<button type="button" data-testid="provider-retry" onClick={onRetryProviders}>Retry providers</button></p> : null}
    {catalogStatus !== 'empty' && catalogStatus !== 'error' ? <p id="session-create-note" className="lab-control-note">Creates a session through the relay.</p> : null}
    <button type="button" data-testid="session-resume" onClick={onResumeSession} disabled={!canResume} aria-describedby="session-resume-note">Resume session</button>
    <p id="session-resume-note" className="lab-control-note" role="status" aria-live="polite">{creating ? 'A session transition is in progress.' : persistence ? `Resume is available for ${persistence.sessionId}.` : 'No resumable session is active.'}</p>
  </section>;
}
