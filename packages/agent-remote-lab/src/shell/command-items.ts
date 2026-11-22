import type { AgentProviderDescriptor, WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import type { RemoteHost } from '../kernel/remote-host.js';
import { sessionKey } from '../kernel/session-tree.js';
import type { Appearance } from '@orchardworks/agent-client-web/browser';
import type { CommandItem } from './command-search.js';
import { translator, type Translate } from '@orchardworks/agent-client';

/** A session the palette lists: its identity and title, as All sessions opens it. */
export interface CommandSession { hostId: string; providerId: string; nativeSessionId: string; title: string; parentNativeSessionId?: string }
type SessionSource = { hostId?: string; providerId: string; nativeSessionId: string; title?: string; parentNativeSessionId?: string };

/** The sessions of every source once each, by `sessionKey`, in the order first seen; the first non-empty title names one. */
export function commandSessions(...sources: readonly (readonly SessionSource[])[]): CommandSession[] {
  const sessions = new Map<string, CommandSession>();
  for (const source of sources) for (const item of source) {
    const key = sessionKey(item), known = sessions.get(key);
    if (known) { if (!known.title && item.title) known.title = item.title; continue; }
    sessions.set(key, { hostId: item.hostId ?? 'local', providerId: item.providerId, nativeSessionId: item.nativeSessionId, title: item.title ?? '',
      ...(item.parentNativeSessionId ? { parentNativeSessionId: item.parentNativeSessionId } : {}) });
  }
  return [...sessions.values()].map(session => session.title ? session : { ...session, title: session.nativeSessionId });
}

/** "Host · Provider": the Host's name ("Lab server" for this server) and the provider's name when the Host reports it. */
export function sessionSubtitle(session: Pick<CommandSession, 'hostId' | 'providerId'>, hosts: readonly RemoteHost[], localProviders: readonly Pick<AgentProviderDescriptor, 'providerId' | 'displayName'>[], t: Translate = translator('en')): string | undefined {
  const host = hosts.find(candidate => candidate.id === session.hostId);
  const name = host?.name ?? (session.hostId === 'local' ? t('team.host.labServer') : undefined);
  if (!name) return undefined;
  const provider = (host?.providers ?? (session.hostId === 'local' ? localProviders : [])).find(item => item.providerId === session.providerId);
  return provider ? `${name} · ${provider.displayName}` : name;
}

/** The view that shows a session: one in the current Window if any, else the first in the Windows given. */
export function sessionViewLocation(windows: readonly WorkspaceWindow[], currentId: string | undefined, key: string): { windowId: string; viewId: string } | undefined {
  const ordered = [...windows.filter(window => window.id === currentId), ...windows.filter(window => window.id !== currentId)];
  for (const window of ordered) {
    const view = window.views.find(candidate => candidate.binding && sessionKey(candidate.binding) === key);
    if (view) return { windowId: window.id, viewId: view.id };
  }
}

/** The palette's three appearance actions, in the reader's words; the current one says so. English search words find them in any language. */
export function appearanceItems(current: Appearance, set: (next: Appearance) => void, t: Translate = translator('en')): CommandItem[] {
  return (['system', 'light', 'dark'] as const).map(appearance => ({ id: `appearance:${appearance}`, kind: 'action',
    title: t('navigation.palette.appearance', { theme: t(`settings.theme.${appearance}`) }),
    keywords: ['theme', 'dark mode', 'light mode', 'color scheme', t('settings.theme')], ...(appearance === current ? { subtitle: t('navigation.palette.current') } : {}), run: () => set(appearance) }));
}
