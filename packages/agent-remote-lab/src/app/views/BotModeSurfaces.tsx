// The Bot mode workspace and its sheets.
import { BotWorkspace } from '../../features/chats/BotWorkspace.js';
import { NewBotSheet } from '../../features/chats/NewBotSheet.js';
import { SessionConversationMount } from '../../conversation/SessionConversationSurfaces.js';
import type { RemoteHost } from '../../kernel/remote-host.js';
import { RemoveBotSheet } from '../../features/chats/RemoveBotSheet.js';
import type { AppScope } from '../types.js';

export function BotModeSurfaces({ scope }: { readonly scope: Pick<AppScope, 'assistantNames' | 'baseUrl' | 'botHandoff' | 'botRoster' | 'compactLayout' | 'createAgent' | 'creationUnavailableReason' | 'describeBot' | 'describeBotConversation' | 'directory' | 'navigation' | 'newBot' | 'openNewBot' | 'openSearch' | 'otherSessions' | 'pinToWindow' | 'projectSharedRoster' | 'providerChoiceList' | 'providerId' | 'remoteHosts' | 'removingBot' | 'retainedHandoff' | 'selectHost' | 'selectProvider' | 'selectableHosts' | 'selectedBot' | 'selectedHost' | 'selectedProviderChoice' | 'sessionOptions' | 'setNewBot' | 'setRemovingBot' | 'setSessionOptions' | 'sharedWindow' | 'successionProgress' | 'transitioning' | 'windowMode' | 'windowWorkspace'> }) {
  const { assistantNames, baseUrl, botHandoff, botRoster, compactLayout, createAgent, creationUnavailableReason, describeBot, describeBotConversation, directory, navigation, newBot, openNewBot, openSearch, otherSessions, pinToWindow, projectSharedRoster, providerChoiceList, providerId, remoteHosts, removingBot, retainedHandoff, selectHost, selectProvider, selectableHosts, selectedBot, selectedHost, selectedProviderChoice, sessionOptions, setNewBot, setRemovingBot, setSessionOptions, sharedWindow, successionProgress, transitioning, windowMode, windowWorkspace } = scope;
  return <>
    {botHandoff ? successionProgress : null}{retainedHandoff ? <div hidden {...{ inert: '' }}><SessionConversationMount mode="bot" active={false} descriptor={retainedHandoff} /></div> : null}
    <BotWorkspace visible={!windowMode} covered={!!navigation.page} compact={compactLayout} scope={baseUrl} workspace={windowWorkspace} navigation={navigation} selected={selectedBot} roster={botRoster} projectRoster={projectSharedRoster} directory={otherSessions} describeConversation={describeBotConversation}
      hostName={hostId => remoteHosts.find(host => host.id === hostId)?.name ?? hostId} botInfo={describeBot}
      onNewBot={directory ? openNewBot : undefined} onSearch={openSearch} onPinToWindow={place => void pinToWindow(place.groupId, place.viewId)} />
    {removingBot && windowMode && sharedWindow?.id === removingBot.windowId && sharedWindow.views.some(view => view.id === removingBot.viewId) ? (() => {
      const view = sharedWindow.views.find(item => item.id === removingBot.viewId)!;
      return <RemoveBotSheet name={view.binding ? assistantNames.view(sharedWindow.id, view.id) : 'Session view'} window={sharedWindow} viewId={view.id}
        onCancel={() => setRemovingBot(undefined)}
        onRemove={() => { windowWorkspace.authority?.operate({ type: 'view.close', viewId: view.id }); setRemovingBot(undefined); }} />;
    })() : null}
    {!windowMode && directory && newBot.open ? <NewBotSheet open onClose={() => setNewBot({ open: false })}
      hosts={selectableHosts.map(host => ({ id: host.id, name: host.name, disabled: host.online === false }))} hostId={selectedHost.id}
      onHostChange={id => { const host = selectableHosts.find(item => item.id === id); if (host) selectHost(host as RemoteHost); }}
      providers={providerChoiceList.map(choice => ({ id: choice.selectionId, name: choice.displayName }))} providerId={selectedProviderChoice?.selectionId ?? ''} nativeProviderId={selectedProviderChoice ? providerId : ''} onProviderChange={selectProvider}
      directory={directory} options={sessionOptions} onOptionsChange={setSessionOptions} canBrowse={remoteHosts.find(host => host.id === selectedHost.id)?.access !== 'shared'}
      unavailableReason={windowWorkspace.sectionCreationState.state === 'unknown' ? 'A new group is not confirmed yet. Retry it in the roster first.' : creationUnavailableReason}
      starting={transitioning} failure={newBot.failure} onStart={() => void createAgent(true)} /> : null}
  </>;
}
