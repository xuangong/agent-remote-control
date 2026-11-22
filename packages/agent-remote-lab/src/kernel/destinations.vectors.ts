import type { DestinationPlace, DefaultView } from './destinations.js';
import type { WorkbenchMode } from './workbench-mode.js';

/** Every address form the page writes, in each mode: the destination the rail and the tab bar mark. */
export const DESTINATION_VECTORS: readonly { readonly url: string; readonly mode: WorkbenchMode; readonly place: DestinationPlace }[] = [
  { url: '/', mode: 'window', place: { destination: 'windows' } },
  { url: '/', mode: 'bot', place: { destination: 'chats' } },
  { url: '/?mode=bot', mode: 'bot', place: { destination: 'chats' } },
  { url: '/?mode=bot&section=g1&bot=v1', mode: 'bot', place: { destination: 'chats' } },
  { url: '/?mode=bot&host=h&provider=claude&session=s1', mode: 'bot', place: { destination: 'chats' } },
  { url: '/?mode=window&window=w1', mode: 'window', place: { destination: 'windows' } },
  { url: '/?window=w1&host=h&provider=codex&session=s2', mode: 'window', place: { destination: 'windows' } },
  { url: '/?agent=a1', mode: 'window', place: { destination: 'windows' } },
  { url: '/?mode=bot&section=g1&bot=v1&page=settings', mode: 'bot', place: { destination: 'settings' } },
  { url: '/?page=settings&group=computers', mode: 'window', place: { destination: 'settings', group: 'computers' } },
  { url: '/?page=settings&group=nowhere', mode: 'window', place: { destination: 'settings' } },
  { url: '/?mode=bot&page=assistants', mode: 'bot', place: { destination: 'assistants' } },
  { url: '/?page=elsewhere', mode: 'bot', place: { destination: 'chats' } },
];

/** The mode a page opens in, for an address that names one or not, the stored mode, the default view and the width. */
export const INITIAL_MODE_VECTORS: readonly { readonly named?: WorkbenchMode; readonly stored?: WorkbenchMode; readonly defaultView: DefaultView; readonly phone: boolean; readonly mode: WorkbenchMode }[] = [
  { named: 'window', stored: 'bot', defaultView: 'chats', phone: true, mode: 'window' },
  { named: 'bot', stored: 'window', defaultView: 'windows', phone: false, mode: 'bot' },
  { defaultView: 'last', phone: false, mode: 'window' },
  { stored: 'bot', defaultView: 'last', phone: false, mode: 'bot' },
  { stored: 'window', defaultView: 'last', phone: false, mode: 'window' },
  { stored: 'window', defaultView: 'last', phone: true, mode: 'bot' },
  { stored: 'window', defaultView: 'chats', phone: false, mode: 'bot' },
  { stored: 'bot', defaultView: 'windows', phone: false, mode: 'window' },
  { stored: 'bot', defaultView: 'windows', phone: true, mode: 'window' },
  { defaultView: 'chats', phone: true, mode: 'bot' },
];
