import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isCallForSupportProfileInput, type CallForSupportMandate, type CallForSupportProfile, type CallForSupportProfileInput, type CallForSupportWorkspaceKind } from '@orchardworks/agent-remote-protocol';
import './call-for-support.css';

export interface SupportProvider { providerId: string; displayName: string }
export interface SupportHost { id: string; name: string }
type Budget = NonNullable<CallForSupportMandate['budget']>;
const workspaceLabels: Record<CallForSupportWorkspaceKind, string> = { shared: 'Shared (read-only)', worktree: 'Own worktree', remote: 'Remote Host' };

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
    {allowWorker ? <option value="">Worker's provider</option> : null}
    {providers.map(provider => <option key={provider.providerId} value={provider.providerId}>{provider.displayName}</option>)}
    {value && !providers.some(provider => provider.providerId === value) ? <option value={value}>{value}</option> : null}
  </select></label>;
  return createPortal(<dialog ref={dialog} className="lab-favorite-dialog lab-support-dialog" data-team-dialog aria-labelledby={label}
    onKeyDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><h2 id={label}>{profile ? 'Edit support profile' : 'New support profile'}</h2><button type="button" aria-label="Close profile editor" disabled={busy} onClick={onClose}>×</button></header>
    <form onSubmit={event => {
      event.preventDefault();
      const input = normalized(draft);
      if (!isCallForSupportProfileInput(input) || input.mandate.supporters.some(row => !row.providerId)) { setInvalid(true); return; }
      onSave(input);
    }}>
      <label>Name<input required disabled={busy} maxLength={128} value={draft.name} placeholder="Cross review" onChange={event => update({ name: event.target.value })} /></label>
      <label>Description<textarea disabled={busy} maxLength={4000} value={draft.description} placeholder="What this support is for, and when a worker should call it" onChange={event => update({ description: event.target.value })} /></label>
      <fieldset><legend>Coordinator</legend>
        <div className="lab-support-row lab-support-host-row">
          {providerSelect(draft.coordinator.providerId ?? '', providerId => update({ coordinator: { ...draft.coordinator, providerId: optional(providerId) } }), 'Provider', true)}
          <label>Model<input disabled={busy} maxLength={256} value={draft.coordinator.model ?? ''} placeholder="Provider default" onChange={event => update({ coordinator: { ...draft.coordinator, model: optional(event.target.value) } })} /></label>
          <label>Effort<input disabled={busy} maxLength={64} value={draft.coordinator.reasoningEffort ?? ''} placeholder="Default" onChange={event => update({ coordinator: { ...draft.coordinator, reasoningEffort: optional(event.target.value) } })} /></label>
        </div>
      </fieldset>
      <fieldset><legend>Allowed supporters</legend>
        {mandate.supporters.map((row, index) => <div key={index} className="lab-support-row" role="group" aria-label={`Supporter configuration ${index + 1}`}>
          {providerSelect(row.providerId, providerId => updateMandate({ supporters: mandate.supporters.map((item, at) => at === index ? { ...item, providerId } : item) }), 'Provider')}
          <label>Model<input required disabled={busy} maxLength={256} value={row.model} onChange={event => updateMandate({ supporters: mandate.supporters.map((item, at) => at === index ? { ...item, model: event.target.value } : item) })} /></label>
          <label>Effort<input disabled={busy} maxLength={64} value={row.reasoningEffort ?? ''} placeholder="Default" onChange={event => updateMandate({ supporters: mandate.supporters.map((item, at) => at === index ? { ...item, reasoningEffort: event.target.value } : item) })} /></label>
          <button type="button" disabled={busy || mandate.supporters.length === 1} aria-label={`Remove supporter configuration ${index + 1}`} onClick={() => updateMandate({ supporters: mandate.supporters.filter((_, at) => at !== index) })}>Remove</button>
        </div>)}
        <button type="button" className="lab-favorite-text-action" disabled={busy || mandate.supporters.length >= 8} onClick={() => updateMandate({ supporters: [...mandate.supporters, { providerId: providers[0]?.providerId ?? '', model: '' }] })}>Add configuration</button>
        <label>Supporters at a time<input type="number" min={1} max={6} disabled={busy} value={mandate.maxSupporters} onChange={event => updateMandate({ maxSupporters: Number(event.target.value) })} /></label>
      </fieldset>
      <fieldset><legend>Workspaces</legend>
        <div className="lab-support-inline">{(Object.keys(workspaceLabels) as CallForSupportWorkspaceKind[]).map(kind => <label key={kind}><input type="checkbox" disabled={busy} checked={mandate.workspaces.includes(kind)}
          onChange={event => updateMandate({ workspaces: event.target.checked ? [...mandate.workspaces, kind] : mandate.workspaces.filter(item => item !== kind) })} />{workspaceLabels[kind]}</label>)}</div>
        {mandate.workspaces.includes('remote') ? <>
          {mandate.remoteHosts.map((row, index) => <div key={index} className="lab-support-row lab-support-host-row" role="group" aria-label={`Remote Host ${index + 1}`}>
            <label>Host<select disabled={busy} value={row.hostId} onChange={event => updateMandate({ remoteHosts: mandate.remoteHosts.map((item, at) => at === index ? { ...item, hostId: event.target.value } : item) })}>
              {hosts.map(host => <option key={host.id} value={host.id}>{host.name}</option>)}</select></label>
            <label>Repository path<input required disabled={busy} maxLength={2048} value={row.workspace} onChange={event => updateMandate({ remoteHosts: mandate.remoteHosts.map((item, at) => at === index ? { ...item, workspace: event.target.value } : item) })} /></label>
            <button type="button" disabled={busy} aria-label={`Remove remote Host ${index + 1}`} onClick={() => updateMandate({ remoteHosts: mandate.remoteHosts.filter((_, at) => at !== index) })}>Remove</button>
          </div>)}
          <button type="button" className="lab-favorite-text-action" disabled={busy || !hosts.length || mandate.remoteHosts.length >= 8} onClick={() => updateMandate({ remoteHosts: [...mandate.remoteHosts, { hostId: hosts[0]!.id, workspace: '' }] })}>Add remote Host</button>
        </> : null}
      </fieldset>
      <fieldset><legend>Approval and budget</legend>
        <label>Rosters<select disabled={busy} value={mandate.approval} onChange={event => updateMandate({ approval: event.target.value as CallForSupportMandate['approval'] })}>
          <option value="every_roster">I approve every roster</option><option value="within_mandate">Start rosters within this profile at once</option></select></label>
        <div className="lab-support-row lab-support-host-row">
          <label>Tokens per call<input type="number" min={1} disabled={busy} value={budget.tokensPerCall ?? ''} placeholder="No limit" onChange={event => updateBudget('tokensPerCall', event.target.value)} /></label>
          <label>Tokens in total<input type="number" min={1} disabled={busy} value={budget.tokensTotal ?? ''} placeholder="No limit" onChange={event => updateBudget('tokensTotal', event.target.value)} /></label>
          <label>Cost in USD<input type="number" min={0} step="0.01" disabled={busy} value={budget.costUsdTotal ?? ''} placeholder="No limit" onChange={event => updateBudget('costUsdTotal', event.target.value)} /></label>
        </div>
      </fieldset>
      <div className="lab-support-inline"><label><input type="checkbox" disabled={busy} checked={draft.enableByDefault} onChange={event => update({ enableByDefault: event.target.checked })} />Enable for sessions without their own choice</label></div>
      {invalid ? <p role="alert">Check the profile: a name, at least one supporter with a model, at least one workspace, and a repository for every remote Host.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <footer><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="lab-favorite-primary" disabled={busy}>{profile ? 'Save profile' : 'Create profile'}</button></footer>
    </form>
  </dialog>, document.body);
}
