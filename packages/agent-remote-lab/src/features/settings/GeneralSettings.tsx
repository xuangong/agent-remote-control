import { useSyncExternalStore } from 'react';
import { SegmentedControl, Toggle } from '@orchardworks/agent-client-web/primitives';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { Appearance, LanguageBinding } from '@orchardworks/agent-client-web/browser';
import { deviceChoices } from '../../kernel/device-choices.js';
import { DEFAULT_VIEWS, DEFAULT_VIEW_STORAGE_KEY, readDefaultView, type DefaultView } from '../../kernel/destinations.js';
import { MobileDisplaySettings } from './MobileDisplaySettings.js';
import { SettingsRow, SettingsSection } from './SettingsRow.js';
import { useDeviceChoice } from './device-choice.js';

const APPEARANCES: readonly Appearance[] = ['system', 'light', 'dark'];
type LanguageChoice = LanguageBinding['value'];
const LANGUAGES: readonly LanguageChoice[] = ['browser', 'zh', 'en'];
const CHANGE = 'agent-remote:default-view-change';

/** This device's stored default view; written the way the page reads it at its next open. */
function useDefaultView(): [DefaultView, (next: DefaultView) => void] {
  const subscribe = (listener: () => void) => { addEventListener('storage', listener); addEventListener(CHANGE, listener); return () => { removeEventListener('storage', listener); removeEventListener(CHANGE, listener); }; };
  const read = () => { try { return localStorage.getItem(DEFAULT_VIEW_STORAGE_KEY); } catch { return null; } };
  const stored = useSyncExternalStore(subscribe, read, read);
  return [readDefaultView(stored), next => {
    try { if (next === 'last') localStorage.removeItem(DEFAULT_VIEW_STORAGE_KEY); else localStorage.setItem(DEFAULT_VIEW_STORAGE_KEY, next); } catch { /* This page keeps the choice. */ }
    dispatchEvent(new Event(CHANGE));
  }];
}

/** Settings > General: how this device looks and what it opens on. Every choice shows at once. */
export function GeneralSettings() {
  const t = useTranslate();
  const { appearance, language, motion } = deviceChoices();
  const theme = useDeviceChoice(appearance, () => appearance.value);
  const lang = useDeviceChoice(language, () => language.value);
  const reduced = useDeviceChoice(motion, () => motion.reduced);
  const systemReduced = motion.systemReduced;
  const [defaultView, setDefaultView] = useDefaultView();
  return <>
    <SettingsSection title={t('settings.general.look')}>
      <SettingsRow label={t('settings.theme')}>
        <SegmentedControl<Appearance> label={t('settings.theme')} options={APPEARANCES.map(value => ({ value, label: t(`settings.theme.${value}` as const) }))} value={theme} onChange={appearance.set} />
      </SettingsRow>
      <SettingsRow label={t('settings.language')} hint={t('settings.language.hint')}>
        <SegmentedControl<LanguageChoice> label={t('settings.language')} options={LANGUAGES.map(value => ({ value, label: t(`settings.language.${value}` as const) }))} value={lang} onChange={language.set} />
      </SettingsRow>
      <SettingsRow label={t('settings.motion')} hint={systemReduced ? t('settings.motion.system') : t('settings.motion.hint')}>
        <Toggle label={t('settings.motion')} checked={reduced} disabled={systemReduced} onChange={next => motion.set(next ? 'reduce' : 'system')} />
      </SettingsRow>
    </SettingsSection>
    <SettingsSection title={t('settings.general.opening')}>
      <SettingsRow label={t('settings.defaultView')} hint={t('settings.defaultView.hint')}>
        <SegmentedControl<DefaultView> label={t('settings.defaultView')} options={DEFAULT_VIEWS.map(value => ({ value, label: t(`settings.defaultView.${value}` as const) }))} value={defaultView} onChange={setDefaultView} />
      </SettingsRow>
    </SettingsSection>
    {/* The display settings carry their own heading, as every moved section does. */}
    <SettingsSection><div className="lab-setting-legacy"><MobileDisplaySettings /></div></SettingsSection>
  </>;
}
