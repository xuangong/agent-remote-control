// Settings > Assistants with this device's push (I5c): the real Assistants settings over the real push hook, which reaches the browser's
// service worker registration, push manager and permission, and the Relay's /u/alice/v1/push-subscriptions, which a spec routes.
// ?notifications=off turns this device's Notifications switch off. The words follow the browser's language.
import { createRoot } from 'react-dom/client';
import { LocaleProvider, browserLocale } from '@orchardworks/agent-client-web/react';
import { bindLanguage } from '@orchardworks/agent-client-web/browser';
import { AssistantSettings, type DeviceNotifications } from '../../src/features/settings/AssistantSettings.js';
import { settingsGroups } from '../../src/features/settings/settings-groups.js';
import { usePushDevice } from '../../src/kernel/usePushDevice.js';
import '../../src/session-view-styles';
import '../../src/features/settings/settings.css';
import './orchard-primitives.css';

const params = new URLSearchParams(location.search);
const enabled = params.get('notifications') !== 'off';
const touch = matchMedia('(pointer: coarse)').matches;

function Fixture() {
  const push = usePushDevice(new URL('/u/alice/', location.origin).href, true, { locale: browserLocale(), paused: !enabled });
  const notifications: DeviceNotifications = { enabled, available: !touch, permission: 'default', requestFailed: false, request() {}, set() {}, push };
  const items = settingsGroups({ account: true, notificationsAvailable: !touch }).find(group => group.id === 'assistants')!.items;
  return <main className="lab-settings" style={{ padding: 16, maxWidth: 720 }}><AssistantSettings items={items} notifications={notifications} /></main>;
}
createRoot(document.getElementById('root')!).render(<LocaleProvider language={bindLanguage(document, localStorage, window)}><Fixture /></LocaleProvider>);
