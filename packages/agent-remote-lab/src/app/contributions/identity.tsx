// What a view says about who answers in it: the assistant's name and avatar, its details, and where its details are stored.
import type { AgentReplicaState, Translate } from '@orchardworks/agent-client';
import { isBotView, type WindowBotDetails } from '@orchardworks/agent-remote-protocol';
import type { SessionViewContribution, SessionViewContext } from '../../conversation/session-view-contribution.js';
import { StarButton } from '../../features/sessions/SessionFavorites.js';
import { BotPicture } from '../../kernel/BotPicture.js';
import { botRole } from '../../kernel/bot-roster.js';
import { rankInPlace } from '../../kernel/assistant-groups.js';
import { SessionLink } from '../../kernel/SessionLink.js';
import { sessionConnectionFailure } from '../../kernel/SessionConnectionNotice.js';
import { windowSessionBinding } from '../../kernel/window-workspace.js';
import type { SessionEntry } from '../../kernel/session-tree.js';
import type { PresentationScope } from './scope.js';

export type IdentityContributionInputs = Pick<PresentationScope, 'assistantNames' | 'bindDirectorySession' | 'favorites' | 'navigation' | 'openSession' | 'remoteHosts' | 'revealEarlier' | 'setSessionNotice' | 'sharedWindow' | 'succession' | 'windowWorkspace'> & { t: Translate };

/** A bot at work: running a turn, not waiting for the owner, and connected to its agent. */
export function botWorking(state: AgentReplicaState | undefined): boolean {
  const agent = state?.agent;
  return !!agent && (agent.status === 'running' || agent.status === 'starting') && !state!.pendingInteractions.length
    && agent.runtimeInfo.connection?.state !== 'unavailable';
}

export const identityContribution = (inputs: IdentityContributionInputs) => (view: SessionViewContext): SessionViewContribution => {
  const { assistantNames, bindDirectorySession, favorites, navigation, openSession, remoteHosts, revealEarlier, setSessionNotice, sharedWindow, succession, windowWorkspace, t } = inputs;
  const { context, options, botPresentation, source, view: windowView, windowBot, host, available, openBot } = view;

  /** Stores an assistant's own name with its group, for every device; a group without bot details gets them first. */
  function renameAssistant(groupId: string, viewId: string, name: string) {
    const trimmed = name.trim(), group = windowWorkspace.readGroup(groupId);
    if (!trimmed || !group) return;
    const change = { type: 'bot.update' as const, viewId, details: { ...group.bots?.members[viewId], name: trimmed } };
    void windowWorkspace.operateGroup(groupId, group.bots ? change : { type: 'batch', operations: [{ type: 'bots.add', rank: rankInPlace(windowWorkspace.groups, groupId) }, change] })
      .catch(error => setSessionNotice(sessionConnectionFailure(error, false, t)));
  }

  // A bot's details (its picture and its own process mode) are stored with its group, in Bot mode and in a Window of bots alike;
  // a view in a group without bots has none and chooses only this device's default.
  const botGroupId = options.bot?.groupId ?? (windowBot ? sharedWindow!.id : undefined), botViewId = options.bot?.viewId ?? (windowBot ? windowView!.id : undefined);
  const botDetails = botGroupId && botViewId ? windowWorkspace.readGroup(botGroupId)?.bots?.members[botViewId] : undefined;
  // Who answers: the assistant's name and its avatar, which works while it does. The avatar is the one the roster draws for
  // the same Window view: its stored picture, or the picture of its view id. The name is the account's (assistantNames),
  // never the session's title, which stays the conversation's subtitle.
  const providerName = (providerId: string, hostId = source.hostId) => remoteHosts.find(item => item.id === hostId)?.providers?.find(provider => provider.providerId === providerId)?.displayName;
  const nameGroupId = options.bot?.groupId ?? (windowView ? sharedWindow?.id : undefined), nameViewId = options.bot?.viewId ?? windowView?.id;
  const assistant = { name: nameGroupId && nameViewId ? assistantNames.view(nameGroupId, nameViewId) : assistantNames.session(source),
    session: { hostId: source.hostId, providerId: source.providerId, nativeSessionId: source.nativeSessionId },
    avatar: <BotPicture id={botViewId ?? windowView?.id ?? source.viewId} picture={botDetails?.picture} size={26} mood={botWorking(context.state) ? 'working' : 'idle'} /> };
  // Where it works and the sessions behind it, for its details: the Host and agent, the agents before a handoff, the chain.
  const chain = succession.historyNavigationFor(source);
  const earlier = chain?.predecessor && !chain.history ? [...chain.ancestors].reverse().concat(chain.predecessor) : [];
  const details = {
    id: botViewId ?? windowView?.id ?? source.viewId, ...(botDetails?.picture ? { picture: botDetails.picture } : {}), name: assistant.name,
    ...(botDetails?.label ? { label: botDetails.label } : {}), ...(windowView && botRole(windowView, t) ? { role: botRole(windowView, t)! } : {}),
    mood: botWorking(context.state) ? 'working' as const : 'idle' as const,
    where: { host: host?.name ?? source.hostId, ...(host ? { online: host.online } : {}), provider: providerName(source.providerId) ?? source.providerId,
      earlier: earlier.map(session => providerName(session.providerId, session.hostId ?? source.hostId) ?? session.providerId) },
    sessions: {
      session: source,
      chain: { navigation: chain, open: async (session: SessionEntry, intent?: 'history') => {
        // Bot mode opens an earlier session on its own, as Other sessions does; a Window opens it in the tile.
        if (options.bot || options.fallback) { navigation.select({ kind: 'session', session: { ...session, hostId: session.hostId ?? source.hostId } }); return true; }
        return windowBot ? revealEarlier(windowView!.id, session)
        : windowView && sharedWindow ? bindDirectorySession({ ...session, sessionIntent: intent }, { windowId: sharedWindow.id, viewId: windowView.id, binding: JSON.stringify(windowView.binding ?? null) })
        // Outside a Window the primary conversation opens it in place, as its handoff line did.
        : openSession(session, undefined, undefined, false, undefined, intent);
      } },
      tools: <><StarButton session={source} favorites={favorites} /><SessionLink session={available ? source : windowSessionBinding(source)} sessionIntent={context.operationBinding.historical ? 'history' : undefined} /></>,
    },
    // A tile's assistant opens in Bot mode, keeping the Window's place.
    ...(openBot ? { action: { label: t('card.openInBot'), icon: 'person' as const, onSelect: openBot } } : {}),
    // A tile's assistant is renamed in its group's details; Bot mode's host renames a bot, and a session in no group keeps its name.
    ...(!botPresentation && sharedWindow && windowView && isBotView(windowView) ? { rename: (name: string) => renameAssistant(sharedWindow.id, windowView.id, name) } : {}),
  };
  const processAssistant = botGroupId && botViewId ? {
    details: botDetails,
    update: (next: WindowBotDetails) => { void windowWorkspace.operateGroup(botGroupId, { type: 'bot.update', viewId: botViewId, details: next }).catch(error => setSessionNotice(sessionConnectionFailure(error, false, t))); },
  } : undefined;
  return {
    props: {
      assistant,
      details,
      conversationTitle: source.title,
      processAssistant,
      // Bot mode's top bar is the conversation's heading; a Window tile has the assistant's own header.
      headingMode: botPresentation ? 'assistant' as const : 'tile' as const,
    },
  };
};
