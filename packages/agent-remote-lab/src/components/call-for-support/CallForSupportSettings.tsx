import { useEffect, useMemo, useState } from 'react';
import { CallForSupportConflictError, RemoteCallForSupportClient } from '@orchardworks/agent-remote-web/headless';
import type { CallForSupportProfile, CallForSupportProfileInput } from '@orchardworks/agent-remote-protocol';
import { workspaceFetch } from '../../workspace-access.js';
import { ProfileEditor, type SupportProvider } from './ProfileEditor.js';
import './call-for-support.css';

interface Host { id: string; name: string; providers?: SupportProvider[] }
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Call For Support is unavailable.';
/** Every provider any Host offers, once. */
export function supportProviders(hosts: readonly Host[]): SupportProvider[] {
  const providers = new Map<string, SupportProvider>();
  for (const host of hosts) for (const provider of host.providers ?? []) if (!providers.has(provider.providerId)) providers.set(provider.providerId, provider);
  return [...providers.values()];
}
const summary = (profile: CallForSupportProfile) => [
  `${profile.mandate.supporters.length} ${profile.mandate.supporters.length === 1 ? 'configuration' : 'configurations'}, up to ${profile.mandate.maxSupporters} at a time`,
  profile.mandate.approval === 'every_roster' ? 'you approve every roster' : 'rosters within the profile start at once',
  ...(profile.enableByDefault ? ['on by default'] : []),
].join(' · ');

/** Settings → Call For Support: the account's support profiles. */
export function CallForSupportSettings({ baseUrl, enabled, hosts }: { baseUrl: string; enabled: boolean; hosts: Host[] }) {
  const client = useMemo(() => new RemoteCallForSupportClient(baseUrl, workspaceFetch), [baseUrl]);
  const [profiles, setProfiles] = useState<CallForSupportProfile[]>();
  const [editing, setEditing] = useState<CallForSupportProfile | 'new'>(), [deleting, setDeleting] = useState<string>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [loadError, setLoadError] = useState('');
  const reload = async () => {
    try {
      const next = (await client.read()).profiles;
      setProfiles(next); setLoadError('');
      // An open edit continues from the current revision; the editor keeps the user's changes.
      setEditing(current => current && current !== 'new' ? next.find(profile => profile.id === current.id) : current);
    } catch (failure) { setLoadError(errorMessage(failure)); }
  };
  useEffect(() => { setProfiles(undefined); if (enabled) void reload(); }, [client, enabled]);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); return true; }
    catch (failure) { setError(failure instanceof CallForSupportConflictError ? 'The profile changed elsewhere. It was reloaded; apply your change again.' : errorMessage(failure)); if (failure instanceof CallForSupportConflictError) await reload(); return false; }
    finally { setBusy(false); }
  }
  async function save(input: CallForSupportProfileInput) {
    const target = editing;
    if (await run(async () => { setProfiles((await client.profile(target === 'new' || !target ? { type: 'create', profile: input } : { type: 'update', id: target.id, revision: target.revision, profile: input })).profiles); })) setEditing(undefined);
  }
  if (!enabled) return null;
  const providers = supportProviders(hosts);
  return <div className="lab-display-settings lab-support-settings">
    <h2>Call For Support</h2>
    <p className="lab-support-muted">Profiles describe kinds of support a session can call for: who coordinates, which supporters, where they work and how much they may use.</p>
    {profiles === undefined && !loadError ? <p role="status">Loading support profiles…</p> : null}
    {profiles?.length ? <ul className="lab-support-profiles">{profiles.map(profile => <li key={profile.id}>
      <div><strong>{profile.name}</strong><small>{summary(profile)}</small>{profile.description ? <small>{profile.description}</small> : null}</div>
      <div className="lab-support-actions">
        <button type="button" disabled={busy} onClick={() => { setError(''); setEditing(profile); }}>Edit</button>
        {deleting === profile.id
          ? <><button type="button" disabled={busy} onClick={() => setDeleting(undefined)}>Keep</button><button type="button" disabled={busy} onClick={() => void run(async () => { setProfiles((await client.profile({ type: 'delete', id: profile.id, revision: profile.revision })).profiles); setDeleting(undefined); })}>Delete profile</button></>
          : <button type="button" disabled={busy} aria-label={`Delete ${profile.name}`} onClick={() => setDeleting(profile.id)}>Delete</button>}
      </div>
    </li>)}</ul> : profiles ? <p className="lab-control-note">No support profiles yet.</p> : null}
    <button type="button" disabled={busy || profiles === undefined || profiles.length >= 32 || !providers.length} onClick={() => { setError(''); setEditing('new'); }}>New support profile</button>
    {!providers.length ? <p className="lab-control-note">Connect a Host to choose providers for supporters.</p> : null}
    {loadError ? <p role="alert">{loadError} <button type="button" onClick={() => void reload()}>Retry</button></p> : null}
    {error && !editing ? <p role="alert">{error}</p> : null}
    {editing ? <ProfileEditor profile={editing === 'new' ? undefined : editing} providers={providers} hosts={hosts} busy={busy} error={error}
      onSave={input => void save(input)} onClose={() => { setEditing(undefined); setError(''); }} /> : null}
  </div>;
}
