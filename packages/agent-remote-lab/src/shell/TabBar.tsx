import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { Destination, DestinationPlace } from '../kernel/destinations.js';
import type { DeviceLinkNotice } from '../kernel/device-link.js';
import { Icon, type IconName } from '../ui/Icon.js';
import './shell.css';

const TABS: readonly { destination: Destination; icon: IconName; label: 'navigation.chats' | 'navigation.assistants' | 'navigation.windows' | 'navigation.me' }[] = [
  { destination: 'chats', icon: 'chat', label: 'navigation.chats' },
  { destination: 'assistants', icon: 'team', label: 'navigation.assistants' },
  { destination: 'windows', icon: 'grid', label: 'navigation.windows' },
  { destination: 'settings', icon: 'person', label: 'navigation.me' },
];

/** The phone's tab bar under every top-level screen: Chats, Assistants, Windows and Me, which holds the account and Settings. */
export function TabBar({ current, onGo, notice }: { current: DestinationPlace; onGo(place: DestinationPlace): void; notice?: DeviceLinkNotice }) {
  const t = useTranslate();
  return <nav className="lab-tab-bar" aria-label={t('navigation.main')}>
    {TABS.map(tab => <button key={tab.destination} type="button" className="lab-tab" aria-current={current.destination === tab.destination ? 'page' : undefined}
      onClick={() => onGo({ destination: tab.destination })}>
      <span className="lab-tab-icon"><Icon name={tab.icon} size={24} />{tab.destination === 'settings' && notice ? <span className="lab-link-dot" data-link={notice.state} role="img" aria-label={t(notice.state === 'offline' ? 'navigation.linkOffline' : 'navigation.linkSignIn')} /> : null}</span>
      <span className="lab-tab-label">{t(tab.label)}</span>
    </button>)}
  </nav>;
}
