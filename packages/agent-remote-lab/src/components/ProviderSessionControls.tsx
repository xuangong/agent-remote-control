import type { ReactNode } from 'react';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { AgentProviderDescriptor } from '@orchardworks/agent-provider-sdk';
import type { AgentPersistenceHandle } from '@orchardworks/agent-provider-sdk';

export type ProviderCatalogStatus = 'loading' | 'ready' | 'empty' | 'error';

export interface ProviderSessionChoice extends AgentProviderDescriptor { selectionId?: string }

export interface ProviderSessionControlsProps {
  providers: readonly ProviderSessionChoice[];
  selectedProviderId: string;
  catalogStatus: ProviderCatalogStatus;
  catalogError?: string;
  creating: boolean;
  unavailableReason?: string;
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

export function ProviderSessionControls({ providers, selectedProviderId, catalogStatus, catalogError, creating, unavailableReason, persistence, children, configurationLocked, planning = false, onPlanningChange, onSelectedProviderChange, onRetryProviders, onCreateSession, onResumeSession }: ProviderSessionControlsProps) {
  const t = useTranslate();
  const canCreate = providers.some((provider) => (provider.selectionId ?? provider.providerId) === selectedProviderId) && !creating && !unavailableReason;
  const canResume = persistence !== undefined && onResumeSession !== undefined && !creating;
  return <section className="lab-panel lab-provider-controls" aria-label={t('sessions.provider.region')}>
    <p className="lab-eyebrow">{t('sessions.provider.newSession')}</p>
    <label htmlFor="provider-select">{t('sessions.provider.label')}</label>
    <select id="provider-select" data-testid="provider-select" value={selectedProviderId} onChange={(event) => onSelectedProviderChange(event.target.value)} disabled={providers.length === 0 || creating || configurationLocked}>
      {!selectedProviderId && providers.length > 0 ? <option value="" disabled>{t('sessions.provider.select')}</option> : null}
      {providers.length === 0 ? <option value="">{t('sessions.provider.none')}</option> : providers.map((provider) => <option key={provider.selectionId ?? provider.providerId} value={provider.selectionId ?? provider.providerId}>{provider.displayName}</option>)}
    </select>
    {onPlanningChange ? <>
      <label htmlFor="session-mode">{t('sessions.provider.modeLabel')}</label>
      <select id="session-mode" value={planning ? 'planning' : 'normal'} onChange={(event) => onPlanningChange(event.target.value === 'planning')} disabled={!canCreate} aria-describedby="session-mode-note">
        <option value="normal">{t('sessions.provider.modeNormal')}</option><option value="planning">{t('sessions.provider.modePlanning')}</option>
      </select>
      <p id="session-mode-note" className="lab-control-note">{t('sessions.provider.planningNote')}</p>
    </> : null}
    {children}
    <button type="button" data-testid="session-create" onClick={onCreateSession} disabled={!canCreate} aria-describedby="session-create-note">{creating ? t('sessions.provider.creating') : t('sessions.provider.openSession')}</button>
    {catalogStatus === 'loading' ? <p className="lab-control-note" role="status" aria-live="polite">{t('sessions.provider.loading')}</p> : null}
    {catalogStatus === 'empty' ? <p id="session-create-note" className="lab-control-note">{t('sessions.provider.noneInLab')}</p> : null}
    {catalogStatus === 'error' ? <p id="session-create-note" className="lab-control-note" role="alert">{catalogError}<button type="button" data-testid="provider-retry" onClick={onRetryProviders}>{t('sessions.provider.retry')}</button></p> : null}
    {catalogStatus !== 'empty' && catalogStatus !== 'error' ? <p id="session-create-note" className="lab-control-note">{unavailableReason ?? t('sessions.provider.createNote')}</p> : null}
    <button type="button" data-testid="session-resume" onClick={onResumeSession} disabled={!canResume} aria-describedby="session-resume-note">{t('sessions.provider.resume')}</button>
    <p id="session-resume-note" className="lab-control-note" role="status" aria-live="polite">{creating ? t('sessions.provider.transition') : persistence ? t('sessions.provider.resumeAvailable', { sessionId: persistence.sessionId }) : t('sessions.provider.noResumable')}</p>
  </section>;
}
