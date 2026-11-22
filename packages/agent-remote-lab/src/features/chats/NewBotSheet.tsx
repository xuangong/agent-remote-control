import { useId } from 'react';
import type { CreateSessionOptions, SessionDirectoryClient } from '../../kernel/directory-client.js';
import { Sheet } from '@orchardworks/agent-client-web/primitives';
import { Button } from '../../ui/Button.js';
import { WorkspaceSelect } from '../../kernel/WorkspaceSelect.js';
import { useTranslate } from '@orchardworks/agent-client-web/react';

export interface NewBotChoice { id: string; name: string; disabled?: boolean }

/**
 * Bot mode's New assistant: where the session runs (Host, provider, workspace), nothing more; model and permissions are set in
 * its composer like any conversation's. Starting it creates the session and a group named after it, which then follows
 * the session's title until renamed.
 */
export function NewBotSheet({ open, onClose, hosts, hostId, onHostChange, providers, providerId, nativeProviderId, onProviderChange, directory, options, onOptionsChange,
  canBrowse, unavailableReason, starting, failure, onStart }: {
  open: boolean; onClose(): void;
  hosts: readonly NewBotChoice[]; hostId: string; onHostChange(hostId: string): void;
  /** `providerId` is the chosen entry of `providers`; `nativeProviderId` the Host's provider ID behind it, for its workspaces. */
  providers: readonly NewBotChoice[]; providerId: string; nativeProviderId: string; onProviderChange(id: string): void;
  directory?: SessionDirectoryClient; options: CreateSessionOptions; onOptionsChange(options: CreateSessionOptions): void; canBrowse: boolean;
  unavailableReason?: string; starting: boolean; failure?: string; onStart(): void;
}) {
  const t = useTranslate();
  const hostField = useId(), providerField = useId();
  const ready = !!providerId && providers.some(provider => provider.id === providerId) && !unavailableReason;
  return <Sheet open={open} title={t('assistants.new')} detent="content" onClose={() => { if (!starting) onClose(); }}>
    <form className="lab-new-bot" aria-label={t('assistants.new')} onSubmit={event => { event.preventDefault(); if (ready && !starting) onStart(); }}>
      <div className="lab-new-bot-fields">
        {hosts.length > 1 ? <div className="lab-new-bot-field"><label htmlFor={hostField}>{t('navigation.host')}</label>
          <select id={hostField} aria-label={t('navigation.host')} value={hostId} disabled={starting} onChange={event => onHostChange(event.target.value)}>
            {hosts.map(host => <option key={host.id} value={host.id} disabled={host.disabled}>{host.name}</option>)}
          </select></div>
          // One Host is still named: the bot runs there.
          : hosts.length === 1 ? <div className="lab-new-bot-field"><span>{t('navigation.host')}</span><span className="lab-new-bot-value">{hosts[0]!.name}</span></div> : null}
        <div className="lab-new-bot-field"><label htmlFor={providerField}>{t('navigation.provider')}</label>
          <select id={providerField} aria-label={t('navigation.provider')} value={providerId} disabled={starting || !providers.length} onChange={event => onProviderChange(event.target.value)}>
            {!providers.length ? <option value="">{t('navigation.newBot.noProvider')}</option> : null}
            {providers.map(provider => <option key={provider.id} value={provider.id} disabled={provider.disabled}>{provider.name}</option>)}
          </select></div>
        {directory && nativeProviderId ? <div className="lab-new-bot-field lab-new-bot-workspace"><WorkspaceSelect directory={directory} providerId={nativeProviderId} disabled={starting} canBrowse={canBrowse}
          value={{ workspaceId: options.cwd ? undefined : options.workspaceId, path: options.cwd }}
          onChange={selection => onOptionsChange({ ...options, workspaceId: selection.workspaceId, cwd: selection.workspaceId ? undefined : selection.path })} /></div> : null}
      </div>
      <p className="lab-sheet-note">{unavailableReason ?? t('navigation.newBot.note')}</p>
      {failure ? <p className="lab-sheet-message" role="alert">{failure}</p> : null}
      <div className="lab-sheet-actions">
        <Button disabled={starting} onClick={onClose}>{t('common.cancel')}</Button>
        <Button type="submit" variant="primary" disabled={!ready || starting} aria-busy={starting || undefined}>{starting ? t('navigation.newBot.starting') : t('navigation.newBot.start')}</Button>
      </div>
    </form>
  </Sheet>;
}
