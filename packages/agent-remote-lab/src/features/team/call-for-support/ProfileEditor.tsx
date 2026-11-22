import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isCallForSupportProfileInput, type CallForSupportMandate, type CallForSupportProfile, type CallForSupportProfileInput, type CallForSupportWorkspaceKind } from '@orchardworks/agent-remote-protocol';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { MessageKey } from '@orchardworks/agent-client';
import './call-for-support.css';

export interface SupportProvider { providerId: string; displayName: string }
export interface SupportHost { id: string; name: string }
type Budget = NonNullable<CallForSupportMandate['budget']>;
const workspaceLabels: Record<CallForSupportWorkspaceKind, MessageKey> = { shared: 'team.profile.workspaceShared', worktree: 'team.profile.workspaceWorktree', remote: 'team.profile.workspaceRemote' };

export function newProfileInput(providers: readonly SupportProvider[]): CallForSupportProfileInput {
  return { name: '', description: '', coordinator: {}, enableByDefault: false,
    mandate: { supporters: [{ providerId: providers[0]?.providerId ?? '', model: '' }], maxSupporters: 2, workspaces: ['shared'], remoteHosts: [], approval: 'every_roster' } };
}
const inputOf = ({ id: _id, revision: _revision, updatedAt: _updatedAt, ...input }: CallForSupportProfile): CallForSupportProfileInput => structuredClone(input);
const optional = (value: string) => value.trim() ? value.trim() : undefined;
const count = (value: string) => value.trim() ? Number(value) : undefined;
/** The input with empty optional fields removed, as the Relay validates it. */
function normalized(draft: CallForSupportProfileInput): CallForSupportProfileInput {
  const { budget, ...mandate } = draft.mandate;
  const limits = Object.fromEntries(Object.entries(budget ?? {}).filter(([, value]) => value !== undefined && Number.isFinite(value))) as Budget;
  return { ...draft, name: draft.name.trim(), description: draft.description.trim(),
    coordinator: Object.fromEntries(Object.entries(draft.coordinator).filter(([, value]) => value)) as CallForSupportProfileInput['coordinator'],
    mandate: { ...mandate, supporters: mandate.supporters.map(({ reasoningEffort, ...row }) => ({ ...row, model: row.model.trim(), ...(reasoningEffort?.trim() ? { reasoningEffort: reasoningEffort.trim() } : {}) })),
      remoteHosts: mandate.workspaces.includes('remote') ? mandate.remoteHosts : [], ...(Object.keys(limits).length ? { budget: limits } : {}) } };
}

/** Defines what a kind of support may use: who coordinates, which supporters, where they work, how much and with whose approval. */
export function ProfileEditor({ profile, providers, hosts, busy, error, onSave, onClose }: {
  profile?: CallForSupportProfile; providers: readonly SupportProvider[]; hosts: readonly SupportHost[]; busy: boolean; error?: string;
  onSave(input: CallForSupportProfileInput): void; onClose(): void;
}) {
  const t = useTranslate();
  const [draft, setDraft] = useState<CallForSupportProfileInput>(() => profile ? inputOf(profile) : newProfileInput(providers));
  const [invalid, setInvalid] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), label = useId();
  useEffect(() => {
    const focus = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { if (focus?.isConnected) focus.focus({ preventScroll: true }); };
  }, []);
  const mandate = draft.mandate, budget = mandate.budget ?? {};
  const update = (change: Partial<CallForSupportProfileInput>) => { setInvalid(false); setDraft(current => ({ ...current, ...change })); };
  const updateMandate = (change: Partial<CallForSupportMandate>) => update({ mandate: { ...mandate, ...change } });
  const updateBudget = (key: keyof Budget, value: string) => updateMandate({ budget: { ...budget, [key]: count(value) } });
  const providerSelect = (value: string, onChange: (value: string) => void, labelText: string, allowWorker = false) => <label>{labelText}<select disabled={busy} value={value} onChange={event => onChange(event.target.value)}>
    {allowWorker ? <option value="">{t('team.profile.workersProvider')}</option> : null}
    {providers.map(provider => <option key={provider.providerId} value={provider.providerId}>{provider.displayName}</option>)}
    {value && !providers.some(provider => provider.providerId === value) ? <option value={value}>{value}</option> : null}
  </select></label>;
  return createPortal(<dialog ref={dialog} className="lab-favorite-dialog lab-support-dialog" data-team-dialog aria-labelledby={label}
    onKeyDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><h2 id={label}>{profile ? t('team.profile.edit') : t('team.profile.new')}</h2><button type="button" aria-label={t('team.profile.close')} disabled={busy} onClick={onClose}>×</button></header>
    <form onSubmit={event => {
      event.preventDefault();
      const input = normalized(draft);
      if (!isCallForSupportProfileInput(input) || input.mandate.supporters.some(row => !row.providerId)) { setInvalid(true); return; }
      onSave(input);
    }}>
      <label>{t('team.profile.name')}<input required disabled={busy} maxLength={128} value={draft.name} placeholder={t('team.profile.namePlaceholder')} onChange={event => update({ name: event.target.value })} /></label>
      <label>{t('team.profile.description')}<textarea disabled={busy} maxLength={4000} value={draft.description} placeholder={t('team.profile.descriptionPlaceholder')} onChange={event => update({ description: event.target.value })} /></label>
      <fieldset><legend>{t('team.profile.coordinator')}</legend>
        <div className="lab-support-row lab-support-host-row">
          {providerSelect(draft.coordinator.providerId ?? '', providerId => update({ coordinator: { ...draft.coordinator, providerId: optional(providerId) } }), t('team.profile.provider'), true)}
          <label>{t('team.profile.model')}<input disabled={busy} maxLength={256} value={draft.coordinator.model ?? ''} placeholder={t('team.profile.providerDefault')} onChange={event => update({ coordinator: { ...draft.coordinator, model: optional(event.target.value) } })} /></label>
          <label>{t('team.profile.effort')}<input disabled={busy} maxLength={64} value={draft.coordinator.reasoningEffort ?? ''} placeholder={t('team.profile.default')} onChange={event => update({ coordinator: { ...draft.coordinator, reasoningEffort: optional(event.target.value) } })} /></label>
        </div>
      </fieldset>
      <fieldset><legend>{t('team.profile.supporters')}</legend>
        {mandate.supporters.map((row, index) => <div key={index} className="lab-support-row" role="group" aria-label={t('team.profile.supporterConfig', { index: index + 1 })}>
          {providerSelect(row.providerId, providerId => updateMandate({ supporters: mandate.supporters.map((item, at) => at === index ? { ...item, providerId } : item) }), t('team.profile.provider'))}
          <label>{t('team.profile.model')}<input required disabled={busy} maxLength={256} value={row.model} onChange={event => updateMandate({ supporters: mandate.supporters.map((item, at) => at === index ? { ...item, model: event.target.value } : item) })} /></label>
          <label>{t('team.profile.effort')}<input disabled={busy} maxLength={64} value={row.reasoningEffort ?? ''} placeholder={t('team.profile.default')} onChange={event => updateMandate({ supporters: mandate.supporters.map((item, at) => at === index ? { ...item, reasoningEffort: event.target.value } : item) })} /></label>
          <button type="button" disabled={busy || mandate.supporters.length === 1} aria-label={t('team.profile.removeSupporterConfig', { index: index + 1 })} onClick={() => updateMandate({ supporters: mandate.supporters.filter((_, at) => at !== index) })}>{t('common.remove')}</button>
        </div>)}
        <button type="button" className="lab-favorite-text-action" disabled={busy || mandate.supporters.length >= 8} onClick={() => updateMandate({ supporters: [...mandate.supporters, { providerId: providers[0]?.providerId ?? '', model: '' }] })}>{t('team.profile.addConfiguration')}</button>
        <label>{t('team.profile.atATime')}<input type="number" min={1} max={6} disabled={busy} value={mandate.maxSupporters} onChange={event => updateMandate({ maxSupporters: Number(event.target.value) })} /></label>
      </fieldset>
      <fieldset><legend>{t('team.profile.workspaces')}</legend>
        <div className="lab-support-inline">{(Object.keys(workspaceLabels) as CallForSupportWorkspaceKind[]).map(kind => <label key={kind}><input type="checkbox" disabled={busy} checked={mandate.workspaces.includes(kind)}
          onChange={event => updateMandate({ workspaces: event.target.checked ? [...mandate.workspaces, kind] : mandate.workspaces.filter(item => item !== kind) })} />{t(workspaceLabels[kind])}</label>)}</div>
        {mandate.workspaces.includes('remote') ? <>
          {mandate.remoteHosts.map((row, index) => <div key={index} className="lab-support-row lab-support-host-row" role="group" aria-label={t('team.profile.remoteHostNumbered', { index: index + 1 })}>
            <label>{t('team.profile.host')}<select disabled={busy} value={row.hostId} onChange={event => updateMandate({ remoteHosts: mandate.remoteHosts.map((item, at) => at === index ? { ...item, hostId: event.target.value } : item) })}>
              {hosts.map(host => <option key={host.id} value={host.id}>{host.name}</option>)}</select></label>
            <label>{t('team.profile.repositoryPath')}<input required disabled={busy} maxLength={2048} value={row.workspace} onChange={event => updateMandate({ remoteHosts: mandate.remoteHosts.map((item, at) => at === index ? { ...item, workspace: event.target.value } : item) })} /></label>
            <button type="button" disabled={busy} aria-label={t('team.profile.removeRemoteHost', { index: index + 1 })} onClick={() => updateMandate({ remoteHosts: mandate.remoteHosts.filter((_, at) => at !== index) })}>{t('common.remove')}</button>
          </div>)}
          <button type="button" className="lab-favorite-text-action" disabled={busy || !hosts.length || mandate.remoteHosts.length >= 8} onClick={() => updateMandate({ remoteHosts: [...mandate.remoteHosts, { hostId: hosts[0]!.id, workspace: '' }] })}>{t('team.profile.addRemoteHost')}</button>
        </> : null}
      </fieldset>
      <fieldset><legend>{t('team.profile.approvalAndBudget')}</legend>
        <label>{t('team.profile.rosters')}<select disabled={busy} value={mandate.approval} onChange={event => updateMandate({ approval: event.target.value as CallForSupportMandate['approval'] })}>
          <option value="every_roster">{t('team.profile.approveEvery')}</option><option value="within_mandate">{t('team.profile.startWithin')}</option></select></label>
        <div className="lab-support-row lab-support-host-row">
          <label>{t('team.profile.tokensPerCall')}<input type="number" min={1} disabled={busy} value={budget.tokensPerCall ?? ''} placeholder={t('team.profile.noLimit')} onChange={event => updateBudget('tokensPerCall', event.target.value)} /></label>
          <label>{t('team.profile.tokensTotal')}<input type="number" min={1} disabled={busy} value={budget.tokensTotal ?? ''} placeholder={t('team.profile.noLimit')} onChange={event => updateBudget('tokensTotal', event.target.value)} /></label>
          <label>{t('team.profile.costUsd')}<input type="number" min={0} step="0.01" disabled={busy} value={budget.costUsdTotal ?? ''} placeholder={t('team.profile.noLimit')} onChange={event => updateBudget('costUsdTotal', event.target.value)} /></label>
        </div>
      </fieldset>
      <div className="lab-support-inline"><label><input type="checkbox" disabled={busy} checked={draft.enableByDefault} onChange={event => update({ enableByDefault: event.target.checked })} />{t('team.profile.enableByDefault')}</label></div>
      {invalid ? <p role="alert">{t('team.profile.invalid')}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <footer><button type="button" disabled={busy} onClick={onClose}>{t('common.cancel')}</button><button className="lab-favorite-primary" disabled={busy}>{profile ? t('team.profile.save') : t('team.profile.create')}</button></footer>
    </form>
  </dialog>, document.body);
}
