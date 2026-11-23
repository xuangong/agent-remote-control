// Settings or the Assistants directory, over whichever mode is current; the mode keeps its place, so leaving returns to it.
import { useMemo } from 'react';
import { usePhoneLayout } from '../../kernel/usePhoneLayout.js';
import { AssistantDirectory } from '../../features/chats/AssistantDirectory.js';
import { SettingsPage, type SettingsContext } from '../../features/settings/SettingsPage.js';
import { RecordedPlaybackControls } from '../../features/diagnostics/RecordedPlaybackControls.js';
import type { SettingsGroupId } from '../../kernel/destinations.js';
import { useDeviceLink } from '../../kernel/DeviceLinkIndicator.js';
import type { AppScope } from '../types.js';

type PageScope = Pick<AppScope, 'account' | 'accessReady' | 'attention' | 'baseUrl' | 'botRoster' | 'closeInspector' | 'dispatchPanels' | 'directory' | 'hostClient' | 'hostsLoaded' | 'navigation' | 'openNewBot'
  | 'openPreviewSource' | 'previewClient' | 'previewHost' | 'projectSharedDirectory' | 'remoteHosts' | 'showView' | 'userScoped' | 'vscodeTunnelClient' | 'windowWorkspace' | 'clientActions' | 'retryHosts'>;

export function PageSurface({ scope }: { readonly scope: PageScope }) {
  const { navigation, userScoped, directory } = scope;
  const page = navigation.page;
  const phone = usePhoneLayout();
  return <main className="lab-page" data-workbench-mode="page" data-page={page?.destination} hidden={!page} {...(!page ? { inert: '' } : {})}>
    {page?.destination === 'assistants' ? <DirectoryPage scope={scope} /> : null}
    {page?.destination === 'settings' ? <SettingsSurface scope={scope} group={page.group} phone={phone} userScoped={userScoped} directoryAvailable={!!directory} /> : null}
  </main>;
}

function DirectoryPage({ scope }: { readonly scope: PageScope }) {
  const { botRoster, directory, navigation, openNewBot, projectSharedDirectory, remoteHosts, windowWorkspace } = scope;
  const place = navigation.place;
  return <AssistantDirectory model={botRoster} project={projectSharedDirectory} workspace={windowWorkspace} {...(place?.kind === 'section' ? { focusGroup: place.groupId } : {})}
    hostName={id => remoteHosts.find(host => host.id === id)?.name ?? id} onOpen={navigation.select} {...(directory ? { onNew: openNewBot } : {})} />;
}

function SettingsSurface({ scope, group, phone, userScoped, directoryAvailable }: { readonly scope: PageScope; group?: SettingsGroupId; phone: boolean; userScoped: boolean; directoryAvailable: boolean }) {
  const { account, attention, baseUrl, closeInspector, dispatchPanels, hostClient, hostsLoaded, navigation, openPreviewSource, previewClient, previewHost, remoteHosts, showView, vscodeTunnelClient, clientActions, retryHosts } = scope;
  const notice = useDeviceLink(phone);
  const context = useMemo<SettingsContext>(() => ({
    facts: { account: !!account, notificationsAvailable: attention.notifications.available },
    ...(account ? { account } : {}), baseUrl, notifications: attention.notifications,
    computers: { hosts: remoteHosts, loaded: hostsLoaded, service: hostClient, previewClient, tunnelService: vscodeTunnelClient, ...(previewHost && previewHost.access !== 'shared' ? { activePreviewHostId: previewHost.id } : {}),
      openPreviewSource: (sessionId, itemId, hostId) => { navigation.setMode('window'); void openPreviewSource(sessionId, itemId, hostId); }, onRevoked: retryHosts },
    openTrace: () => { navigation.setMode('window'); showView('trace'); },
    openInspector: () => { navigation.setMode('window'); closeInspector(); dispatchPanels({ type: 'inspector.open' }); },
    ...(clientActions?.advanceFixture || clientActions?.rehydrateFixture || clientActions?.stopReader ? { playback: <RecordedPlaybackControls onAdvance={clientActions.advanceFixture} onRehydrate={clientActions.rehydrateFixture} onStopReader={clientActions.stopReader} /> } : {}),
  }), [account, attention.notifications, baseUrl, remoteHosts, hostsLoaded, hostClient, previewClient, vscodeTunnelClient, previewHost, userScoped, directoryAvailable, clientActions]);
  return <SettingsPage context={context} group={group} phone={phone} {...(notice ? { linkNotice: notice } : {})}
    onGroup={next => next ? navigation.open({ destination: 'settings', group: next }, phone ? 'push' : 'replace') : navigation.closePage()} />;
}
