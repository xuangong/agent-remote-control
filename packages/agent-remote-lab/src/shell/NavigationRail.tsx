import { useEffect, useRef, useState } from 'react';
import { FloatingPanel, OrchardMark } from '@orchardworks/agent-client-web/primitives';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { Destination, DestinationPlace } from '../destinations.js';
import type { DeviceLinkNotice } from '../device-link.js';
import { Icon, type IconName } from '../ui/Icon.js';
import { DeviceLinkWords } from './DeviceLinkIndicator.js';
import './shell.css';

const PLACES: readonly { destination: Exclude<Destination, 'settings'>; icon: IconName; label: 'navigation.chats' | 'navigation.assistants' | 'navigation.windows' }[] = [
  { destination: 'chats', icon: 'chat', label: 'navigation.chats' },
  { destination: 'assistants', icon: 'team', label: 'navigation.assistants' },
  { destination: 'windows', icon: 'grid', label: 'navigation.windows' },
];

/** The link's state as the rail's avatar dot shows it. */
export const linkState = (notice: DeviceLinkNotice | undefined) => notice ? notice.state : 'online';

/**
 * The desktop's icon rail, shared by both modes (design "Navigation and Settings"): the mark, Chats, Assistants, Windows
 * and Search, then Settings and the account's avatar with the device-link dot. The current place says so with aria-current.
 */
export function NavigationRail({ current, onGo, onSearch, searchKeys, accountName, notice }: {
  current: DestinationPlace; onGo(place: DestinationPlace): void; onSearch(): void; searchKeys: string; accountName?: string; notice?: DeviceLinkNotice;
}) {
  const t = useTranslate();
  const button = (icon: IconName, label: string, active: boolean, onClick: () => void, title = label) =>
    <button type="button" className="lab-rail-button" aria-label={label} title={title} aria-current={active ? 'page' : undefined} onClick={onClick}><Icon name={icon} size={24} /></button>;
  return <FloatingPanel as="aside" className="lab-rail">
    <nav aria-label={t('navigation.main')}>
      <OrchardMark size={34} className="lab-rail-mark" />
      {PLACES.map(place => <span key={place.destination} className="lab-rail-item">{button(place.icon, t(place.label), current.destination === place.destination, () => onGo({ destination: place.destination }))}</span>)}
      {button('search', t('navigation.search'), false, onSearch, t('navigation.searchShortcut', { keys: searchKeys }))}
      <span className="lab-rail-spacer" />
      {button('gear', t('common.settings'), current.destination === 'settings', () => onGo({ destination: 'settings' }))}
      <RailAccount name={accountName} notice={notice} onAccount={() => onGo({ destination: 'settings', group: 'account' })} />
    </nav>
  </FloatingPanel>;
}

/** The account's initial in a circle; its dot is the device link, and its popover says what the link needs. */
function RailAccount({ name, notice, onAccount }: { name?: string; notice?: DeviceLinkNotice; onAccount(): void }) {
  const t = useTranslate();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const state = linkState(notice);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  const who = name || t('navigation.accountUnknown');
  const status = t(state === 'online' ? 'navigation.linkOnline' : state === 'offline' ? 'navigation.linkOffline' : 'navigation.linkSignIn');
  return <span ref={root} className="lab-rail-account">
    <button type="button" className="lab-rail-button lab-rail-avatar" aria-label={`${t('navigation.account', { name: who })}. ${status}`} aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(value => !value)}>
      {/* An account without a name shows a person, not the initial of a placeholder phrase. */}
      {name ? <span className="lab-rail-initial" aria-hidden="true">{[...name][0]?.toUpperCase()}</span> : <Icon name="person" />}
      <span className="lab-link-dot" data-link={state} aria-hidden="true" />
    </button>
    {open ? <div className="lab-rail-popover orchard-panel" role="group" aria-label={t('navigation.account', { name: who })}>
      <strong>{who}</strong>
      {notice ? <DeviceLinkWords notice={notice} /> : <p className="lab-rail-link-line"><span className="lab-link-dot" data-link="online" aria-hidden="true" />{status}</p>}
      <button type="button" className="lab-rail-popover-action" onClick={() => { setOpen(false); onAccount(); }}>{t('settings.group.account')}</button>
    </div> : null}
  </span>;
}
