import { lazy, Suspense } from 'react';
import { PROCESS_MODES, type ProcessMode } from '@orchardworks/agent-client';
import { Pill, SegmentedControl, Toggle } from '@orchardworks/agent-client-web/primitives';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { useDeviceProcessMode, useLettersVisible, writeDeviceProcessMode } from '../../conversation/useProcessMode.js';
import type { PushDeviceControls } from '../../kernel/usePushDevice.js';
import type { SettingsItemId } from './settings-groups.js';
import { SettingsRow, SettingsSection } from './SettingsRow.js';

/** The audit loads with the section that shows it. */
const BotAudit = lazy(() => import('./BotAudit.js').then(module => ({ default: module.BotAudit })));

/** This device's session notifications as the attention hook keeps them. */
export interface DeviceNotifications {
  readonly enabled: boolean; readonly available: boolean; set(enabled: boolean): void;
  /** What the browser allows: `default` still asks, `denied` needs the person's settings. */
  readonly permission: 'default' | 'granted' | 'denied' | 'unsupported'; readonly requestFailed: boolean; request(): void;
  /** Push on this device ("Notify me on this device"), which reaches it when no page of Orchard runs; a page without it shows no push row. */
  readonly push?: PushDeviceControls;
}

/** Settings > Assistants: what every assistant on this device shares, which each assistant's own details can override only for the process display. */
export function AssistantSettings({ items, notifications, baseUrl }: { items: readonly SettingsItemId[]; notifications: DeviceNotifications; baseUrl?: string }) {
  const t = useTranslate();
  const mode = useDeviceProcessMode() ?? 'concise';
  const [letters, setLetters] = useLettersVisible();
  return <>
    <SettingsSection>
      <SettingsRow label={t('settings.process')} hint={t('settings.process.hint')}>
        <SegmentedControl<ProcessMode> label={t('settings.process')} options={PROCESS_MODES.map(value => ({ value, label: t(`process.${value}` as const) }))} value={mode} onChange={writeDeviceProcessMode} />
      </SettingsRow>
      {items.includes('notifications') ? <SettingsRow label={t('settings.notifications')} hint={t('settings.notifications.hint')}>
        <Toggle label={t('settings.notifications')} checked={notifications.enabled} onChange={notifications.set} />
      </SettingsRow> : null}
      {items.includes('notifications') && notifications.enabled && notifications.permission === 'default' ? <SettingsRow label={t('settings.notifications.allow')}><Pill onClick={notifications.request}>{t('settings.notifications.allow')}</Pill></SettingsRow> : null}
      {items.includes('notifications') && notifications.permission === 'denied' ? <p className="lab-setting-note">{t('settings.notifications.blocked')}</p> : null}
      {items.includes('notifications') && notifications.requestFailed ? <p className="lab-setting-note">{t('settings.notifications.failed')}</p> : null}
      {items.includes('push') && notifications.push ? <PushRow push={notifications.push} paused={notifications.enabled === false}
        blockedSaid={items.includes('notifications') && notifications.permission === 'denied'} /> : null}
      <SettingsRow label={t('settings.letters')} hint={t('settings.letters.hint')}>
        <Toggle label={t('settings.letters')} checked={letters} onChange={setLetters} />
      </SettingsRow>
    </SettingsSection>
    {items.includes('audit') && baseUrl !== undefined ? <SettingsSection title={t('settings.audit')}>
      <p className="lab-setting-note">{t('settings.audit.hint')}</p>
      <Suspense fallback={null}><BotAudit baseUrl={baseUrl} /></Suspense>
    </SettingsSection> : null}
  </>;
}

/**
 * "Notify me on this device": one tap where push works (it asks the browser's permission from that tap), and where it does not, why: an
 * iPhone or iPad tab (Apple delivers pushes only to the app on the Home Screen), a browser without push, a Relay that sends none, or a
 * site whose notifications are blocked.
 */
function PushRow({ push, paused, blockedSaid }: { push: PushDeviceControls; paused: boolean; blockedSaid: boolean }) {
  const t = useTranslate();
  const usable = push.availability === 'available' || push.status === 'on';
  // A site whose notifications are blocked is said once: by the Notifications row above, where the page has one.
  const blocked = (push.availability === 'blocked' || push.failure === 'denied') && !blockedSaid;
  const why = push.availability === 'install' ? 'push.install' : push.availability === 'unsupported' ? 'push.unsupported' : push.availability === 'server' ? 'push.server'
    : blocked ? 'push.blocked' : undefined;
  return <>
    <SettingsRow label={t('push.title')} hint={t('push.hint')}>
      {usable ? <Toggle label={t('push.title')} checked={push.status === 'on'} disabled={push.status === 'working' || push.status === 'checking'}
        onChange={next => { if (next) push.enable(); else push.disable(); }} /> : null}
    </SettingsRow>
    {why && push.status !== 'on' ? <p className="lab-setting-note" data-push-note={push.availability}>{t(why)}</p> : null}
    {push.status === 'on' && paused ? <p className="lab-setting-note">{t('push.paused')}</p> : null}
    {push.failure && push.failure !== 'denied' ? <p className="lab-setting-note" role="status">{t('push.failed')}</p> : null}
  </>;
}
