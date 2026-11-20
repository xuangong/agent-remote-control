/**
 * Where the reader is, as the rail and the tab bar show it (design "Navigation and Settings"): Chats (Bot mode), Assistants (the
 * directory), Windows (Window mode) or Settings. The mode keeps its own place in the address (workbench-mode.ts); Settings and the
 * directory are `page=settings&group=…` and `page=assistants` written over it, so leaving them returns to the same chat or Window.
 * Pure: the hook passes the address and the mode in.
 */
import type { WorkbenchMode } from './workbench-mode.js';

export type Destination = 'chats' | 'assistants' | 'windows' | 'settings';
export type SettingsGroupId = 'general' | 'assistants' | 'computers' | 'privacy' | 'advanced' | 'account';
export const SETTINGS_GROUP_IDS: readonly SettingsGroupId[] = ['general', 'assistants', 'computers', 'privacy', 'advanced', 'account'];
export interface DestinationPlace { readonly destination: Destination; readonly group?: SettingsGroupId }

const isGroup = (value: string | null): value is SettingsGroupId => SETTINGS_GROUP_IDS.includes(value as SettingsGroupId);

/** The current destination: an overlay page first, then the mode underneath. */
export function destinationOf(url: URL, mode: WorkbenchMode): DestinationPlace {
  const page = url.searchParams.get('page'), group = url.searchParams.get('group');
  if (page === 'settings') return isGroup(group) ? { destination: 'settings', group } : { destination: 'settings' };
  if (page === 'assistants') return { destination: 'assistants' };
  return { destination: mode === 'bot' ? 'chats' : 'windows' };
}

/** The mode a destination shows underneath: Chats and Windows choose one, Settings and the directory keep the current one. */
export function modeOf(destination: Destination, current: WorkbenchMode): WorkbenchMode {
  return destination === 'chats' ? 'bot' : destination === 'windows' ? 'window' : current;
}

/** The address of a destination over the current one: only `page` and `group` change, every other parameter stays as it was. */
export function destinationUrl(url: URL, target: DestinationPlace): URL {
  const next = new URL(url);
  next.searchParams.delete('page'); next.searchParams.delete('group');
  if (target.destination === 'settings') {
    next.searchParams.set('page', 'settings');
    if (target.group) next.searchParams.set('group', target.group);
  } else if (target.destination === 'assistants') next.searchParams.set('page', 'assistants');
  return next;
}

/** What Orchard shows first when an address names no place (Settings > General). */
export type DefaultView = 'chats' | 'windows' | 'last';
export const DEFAULT_VIEW_STORAGE_KEY = 'agent-remote:default-view';
export const DEFAULT_VIEWS: readonly DefaultView[] = ['chats', 'windows', 'last'];
export function readDefaultView(stored: string | null | undefined): DefaultView {
  return stored === 'chats' || stored === 'windows' ? stored : 'last';
}

/**
 * The mode a page opens in. An address that names a mode wins; then the device's default view; "last used" is the stored mode,
 * except on a phone, whose home is Chats (I3b) unless the reader chose Windows.
 */
export function initialMode({ named, stored, defaultView, phone }: { named?: WorkbenchMode; stored?: WorkbenchMode; defaultView: DefaultView; phone: boolean }): WorkbenchMode {
  if (named) return named;
  if (defaultView === 'chats') return 'bot';
  if (defaultView === 'windows') return 'window';
  return phone ? 'bot' : stored ?? 'window';
}
