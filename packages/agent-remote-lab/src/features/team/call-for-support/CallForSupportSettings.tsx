import { useEffect, useMemo, useState } from 'react';
import { CallForSupportConflictError, errorWords, RemoteCallForSupportClient, type Translate } from '@orchardworks/agent-client';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { CallForSupportProfile, CallForSupportProfileInput } from '@orchardworks/agent-remote-protocol';
import { Pill } from '@orchardworks/agent-client-web/primitives';
import { workspaceFetch } from '../../../kernel/workspace-access.js';
import { SettingsRow, SettingsSection } from '../../../ui/SettingsRow.js';
import { ProfileEditor, type SupportProvider } from './ProfileEditor.js';
import './call-for-support.css';

interface Host { id: string; name: string; providers?: SupportProvider[] }
const errorMessage = (t: Translate, error: unknown) => errorWords(error, t, 'team.support.unavailable');
/** Every provider any Host offers, once. */
export function supportProviders(hosts: readonly Host[]): SupportProvider[] {
  const providers = new Map<string, SupportProvider>();
  for (const host of hosts) for (const provider of host.providers ?? []) if (!providers.has(provider.providerId)) providers.set(provider.providerId, provider);
  return [...providers.values()];
}
const summary = (t: Translate, profile: CallForSupportProfile) => [
  t('team.support.configurations', { count: profile.mandate.supporters.length, max: profile.mandate.maxSupporters }),
  profile.mandate.approval === 'every_roster' ? t('team.support.approvalEvery') : t('team.support.approvalMandate'),
  ...(profile.enableByDefault ? [t('team.support.onByDefault')] : []),
].join(' · ');

/** Settings → Call For Support: the account's support profiles. */
export function CallForSupportSettings({ baseUrl, enabled, hosts }: { baseUrl: string; enabled: boolean; hosts: Host[] }) {
  const t = useTranslate();
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
    } catch (failure) { setLoadError(errorMessage(t, failure)); }
  };
  useEffect(() => { setProfiles(undefined); if (enabled) void reload(); }, [client, enabled]);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); return true; }
    catch (failure) { setError(failure instanceof CallForSupportConflictError ? t('team.support.conflict') : errorMessage(t, failure)); if (failure instanceof CallForSupportConflictError) await reload(); return false; }
    finally { setBusy(false); }
  }
  async function save(input: CallForSupportProfileInput) {
    const target = editing;
    if (await run(async () => { setProfiles((await client.profile(target === 'new' || !target ? { type: 'create', profile: input } : { type: 'update', id: target.id, revision: target.revision, profile: input })).profiles); })) setEditing(undefined);
  }
  if (!enabled) return null;
  const providers = supportProviders(hosts);
  return <SettingsSection title={t('team.support.title')}>
    <p className="lab-setting-note">{t('team.support.profilesIntro')}</p>
    {profiles === undefined && !loadError ? <p className="lab-setting-note" role="status">{t('team.support.loadingProfiles')}</p> : null}
    {profiles?.map(profile => <SettingsRow key={profile.id} label={profile.name} hint={[summary(t, profile), profile.description].filter(Boolean).join(' · ')}>
      <span className="lab-support-actions">
        <Pill disabled={busy} onClick={() => { setError(''); setEditing(profile); }}>{t('common.edit')}</Pill>
        {deleting === profile.id
          ? <><Pill disabled={busy} onClick={() => setDeleting(undefined)}>{t('team.support.keep')}</Pill><Pill disabled={busy} onClick={() => void run(async () => { setProfiles((await client.profile({ type: 'delete', id: profile.id, revision: profile.revision })).profiles); setDeleting(undefined); })}>{t('team.support.deleteProfile')}</Pill></>
          : <Pill disabled={busy} aria-label={t('team.support.deleteNamed', { name: profile.name })} onClick={() => setDeleting(profile.id)}>{t('common.delete')}</Pill>}
      </span>
    </SettingsRow>)}
    {profiles && !profiles.length ? <p className="lab-setting-note">{t('team.support.noProfiles')}</p> : null}
    {!providers.length ? <p className="lab-setting-note">{t('team.support.connectHost')}</p> : null}
    {loadError ? <p className="lab-setting-note" role="alert">{loadError}<Pill onClick={() => void reload()}>{t('common.retry')}</Pill></p> : null}
    {error && !editing ? <p className="lab-setting-note" role="alert">{error}</p> : null}
    <div className="lab-setting-actions">
      <Pill disabled={busy || profiles === undefined || profiles.length >= 32 || !providers.length} onClick={() => { setError(''); setEditing('new'); }}>{t('team.support.newProfile')}</Pill>
    </div>
    {editing ? <ProfileEditor profile={editing === 'new' ? undefined : editing} providers={providers} hosts={hosts} busy={busy} error={error}
      onSave={input => void save(input)} onClose={() => { setEditing(undefined); setError(''); }} /> : null}
  </SettingsSection>;
}
