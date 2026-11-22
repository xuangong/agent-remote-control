import type { ReactNode } from 'react';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { Pill } from '@orchardworks/agent-client-web/primitives';
import { LayoutDiagnosticsSettings } from './LayoutDiagnosticsSettings.js';
import { SettingsRow, SettingsSection } from './SettingsRow.js';

/** Settings > Advanced: layout diagnostics, Trace and the Replica Inspector; `playback` carries a recorded fixture's controls. */
export function AdvancedSettings({ openTrace, openInspector, playback }: { openTrace(): void; openInspector(): void; playback?: ReactNode }) {
  const t = useTranslate();
  return <>
    <LayoutDiagnosticsSettings />
    <SettingsSection title={t('settings.advanced.diagnosis')}>
      <SettingsRow label={t('settings.advanced.trace')}><Pill onClick={openTrace}>{t('common.open')}</Pill></SettingsRow>
      <SettingsRow label={t('settings.advanced.inspector')}><Pill onClick={openInspector}>{t('common.show')}</Pill></SettingsRow>
    </SettingsSection>
    {playback ? <SettingsSection><div className="lab-setting-legacy">{playback}</div></SettingsSection> : null}
  </>;
}
