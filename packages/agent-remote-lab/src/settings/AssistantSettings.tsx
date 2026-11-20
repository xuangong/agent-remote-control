import { PROCESS_MODES, type ProcessMode } from '@orchardworks/agent-client';
import { Pill, SegmentedControl, Toggle } from '@orchardworks/agent-client-web/primitives';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { useDeviceProcessMode, useLettersVisible, writeDeviceProcessMode } from '../hooks/useProcessMode.js';
import type { SettingsItemId } from './settings-groups.js';
import { SettingsRow, SettingsSection } from './SettingsRow.js';

/** This device's session notifications as the attention hook keeps them. */
export interface DeviceNotifications {
  readonly enabled: boolean; readonly available: boolean; set(enabled: boolean): void;
  /** What the browser allows: `default` still asks, `denied` needs the person's settings. */
  readonly permission: 'default' | 'granted' | 'denied' | 'unsupported'; readonly requestFailed: boolean; request(): void;
}

/** Settings > Assistants: what every assistant on this device shares, which each assistant's own details can override only for the process display. */
export function AssistantSettings({ items, notifications }: { items: readonly SettingsItemId[]; notifications: DeviceNotifications }) {
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
      <SettingsRow label={t('settings.letters')} hint={t('settings.letters.hint')}>
        <Toggle label={t('settings.letters')} checked={letters} onChange={setLetters} />
      </SettingsRow>
    </SettingsSection>
  </>;
}
