// The rail (desktop) or the tab bar (phone): the same four destinations, the current one from the Workbench's mode and page.
import { useCallback } from 'react';
import { usePhoneLayout } from '../../hooks/usePhoneLayout.js';
import type { DestinationPlace } from '../../destinations.js';
import { NavigationRail } from '../../shell/NavigationRail.js';
import { TabBar } from '../../shell/TabBar.js';
import { useDeviceLink } from '../../shell/DeviceLinkIndicator.js';
import { applePlatform } from '../../platform.js';
import type { AppScope } from '../types.js';

/** Moves to a destination: Chats and Windows choose a mode, Settings and the directory open over the current one (a history entry the first time). */
export function useGo(navigation: AppScope['navigation']) {
  return useCallback((place: DestinationPlace) => navigation.open(place, navigation.page ? 'replace' : 'push'), [navigation]);
}

export function NavigationChrome({ scope }: { readonly scope: Pick<AppScope, 'account' | 'navigation' | 'openSearch'> }) {
  const { account, navigation, openSearch } = scope;
  const phone = usePhoneLayout();
  const notice = useDeviceLink();
  const go = useGo(navigation);
  const name = account?.name || account?.email || account?.id;
  return phone ? <TabBar current={navigation.destination} onGo={go} {...(notice ? { notice } : {})} />
    : <NavigationRail current={navigation.destination} onGo={go} onSearch={openSearch} searchKeys={applePlatform() ? '⌘K' : 'Ctrl+K'} {...(name ? { accountName: name } : {})} {...(notice ? { notice } : {})} />;
}
