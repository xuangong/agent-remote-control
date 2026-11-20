import { forwardRef, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ComponentType } from 'react';
import type { useWindowWorkspace } from '../hooks/useWindowWorkspace.js';
import type { useWorkbenchMode } from '../hooks/useWorkbenchMode.js';
import type { useBotWorkspace } from '../hooks/useBotWorkspace.js';
import type { useOtherSessions } from '../hooks/useOtherSessions.js';
import { useVisualViewport } from '../hooks/useVisualViewport.js';
import { usePhoneLayout } from '../hooks/usePhoneLayout.js';
import type { BotRosterModel, BotRow } from '../bot-roster.js';
import type { BotPlace } from '../workbench-mode.js';
import { BotRoster, botDisplayName, botPlaceKey } from './BotRoster.js';
import { useSharedFeed, type SharedFeedsSnapshot } from '../shared-feeds.js';
import { useBotActions, type BotInfo } from './BotActions.js';
import { AsleepNotice } from './AsleepNotice.js';
import { SessionConversationMount, type SessionSurfaceDescriptor } from './SessionConversationSurfaces.js';
import { SidebarHeader } from '../shell/SidebarHeader.js';
import { IconButton } from '../ui/IconButton.js';
import { Button } from '../ui/Button.js';
import { Icon } from '../ui/Icon.js';
import type { MenuEntry } from '../ui/Menu.js';
import { botViews, hasBotAppearance, hasWindowAppearance, type BotPicture } from '@orchardworks/agent-remote-protocol';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { assistantName } from '@orchardworks/agent-client';
import type { BotSection } from '../bot-roster.js';
import { AssistantTopBar } from './assistant/AssistantTopBar.js';
import { AssistantDetailsHostContext, type AssistantDetailsHost } from './assistant/details-host.js';
import { DeviceLinkSlot } from './assistant/DeviceLinkSlot.js';
import './bot-workspace.css';

export interface BotWorkspaceProps {
  visible: boolean; compact: boolean; scope: string;
  workspace: ReturnType<typeof useWindowWorkspace>;
  navigation: ReturnType<typeof useWorkbenchMode>;
  selected: ReturnType<typeof useBotWorkspace>;
  /** Who the bots are, for the selected bot's menu. */
  roster: BotRosterModel;
  /**
   * The roster with the account's shared IM state (statuses, replies, unread, drafts, waiting messages). The roster
   * projects it itself, so a frame of the shared feeds renders the roster and nothing else. Defaults to `roster`.
   */
  projectRoster?(shared: SharedFeedsSnapshot): BotRosterModel;
  directory: ReturnType<typeof useOtherSessions>;
  describeConversation(place: BotPlace): SessionSurfaceDescriptor | undefined;
  /** Mounts a described conversation; the Workbench's surfaces by default. */
  mount?: ComponentType<ComponentProps<typeof SessionConversationMount>>;
  /** Whether the desktop roster is hidden; the state lives in App so the shell shortcut can toggle it. Phone layouts ignore it. */
  rosterCollapsed: boolean; onToggleRoster(): void;
  /** Opens search; the roster's header offers it. */
  onSearch?(): void;
  /** A Host's display name for a Host ID. */
  hostName?(hostId: string): string;
  /** Opens New bot, which starts a session in a group of its own. */
  onNewBot?(): void;
  /** Where a bot runs, for its details. */
  botInfo?(place: { groupId: string; viewId: string }): BotInfo | undefined;
  /** Shows a bot's tile in Window mode, keeping this place for the way back. */
  onPinToWindow?(place: { groupId: string; viewId: string }): void;
}

/**
 * Bot mode: three floating panels on the warm ground, the assistants, the conversation and its details (I3 plan, B2).
 * The details are closed by default below the compact width; at phone width one screen shows at a time, the list as home,
 * and the details open as a sheet.
 */
export function BotWorkspace({ visible, compact, scope, workspace, navigation, selected, roster, projectRoster, directory, describeConversation, mount: Mount = SessionConversationMount, rosterCollapsed, onToggleRoster, onSearch, hostName = id => id, botInfo, onNewBot, onPinToWindow }: BotWorkspaceProps) {
  const t = useTranslate();
  const phone = usePhoneLayout();
  const root = useVisualViewport(), title = useRef<HTMLButtonElement>(null), keyboardOpen = useRef(false), returning = useRef(false);
  const [error, setError] = useState<string>();
  const currentScope = useRef(scope); currentScope.current = scope;
  const rosterId = useId(), detailsId = useId(), rosterElement = useRef<HTMLElement>(null), rosterToggle = useRef<HTMLButtonElement | null>(null);
  const backButton = useRef<HTMLButtonElement>(null), toggleHadFocus = useRef(false);
  // React detaches the ref before it removes the node, so this sees whether the toggle had focus when a phone layout replaces it.
  const toggleRef = useCallback((node: HTMLButtonElement | null) => {
    if (!node && rosterToggle.current && rosterToggle.current === document.activeElement) toggleHadFocus.current = true;
    rosterToggle.current = node;
  }, []);
  const rosterHidden = !phone && rosterCollapsed;
  const place = navigation.place, key = place && botPlaceKey(place);
  const conversation = !!place && place.kind !== 'section';
  const descriptor = conversation ? describeConversation(place) : undefined;
  const unavailable = phone && !!selected.error && !descriptor;
  const showConversation = conversation && !unavailable && (!phone || !navigation.rosterVisible);
  const availabilityNotice = selected.loading ? <p role="status">Opening bot…</p> : selected.error && place?.kind !== 'session'
    ? <p role="alert">{selected.error} <button type="button" onClick={() => void selected.retry()}>Retry</button></p> : null;
  const creation = workspace.sectionCreationState, saving = creation.state === 'saving';
  const actions = useBotActions({ scope, workspace, onSelect: navigation.select, onError: setError });
  const botSection = place?.kind === 'bot' ? roster.sections.find(section => section.groupId === place.groupId) : undefined;
  const botRow = place?.kind === 'bot' ? botSection?.rows.find(row => row.viewId === place.viewId) : undefined;
  // A bot put to sleep elsewhere while open here: its conversation is released until it is woken.
  const asleep = place?.kind === 'bot' && !!workspace.readGroup(place.groupId)?.bots?.members[place.viewId]?.asleep;
  // The details sit beside the conversation from the compact width up; below it they wait to be opened.
  const [detailsOpen, setDetailsOpen] = useState(!compact);
  useEffect(() => { setDetailsOpen(!compact); }, [compact]);
  const [detailsSlot, setDetailsSlot] = useState<HTMLElement | null>(null);
  const [toolsSlot, setToolsSlot] = useState<HTMLElement | null>(null);
  const detailsShown = detailsOpen && !!descriptor && showConversation;
  const info = place?.kind === 'bot' ? botInfo?.(place) : undefined;
  const detailsHost: AssistantDetailsHost = {
    surface: phone ? 'sheet' : 'panel', slot: detailsSlot, tools: toolsSlot, open: detailsShown, setOpen: setDetailsOpen,
    ...(botRow && botSection ? { actions: [...actions.cardActions(botRow, botSection.title),
      ...(onPinToWindow ? [{ label: t('card.pin'), icon: 'window' as const, onSelect: () => onPinToWindow({ groupId: botRow.groupId, viewId: botRow.viewId }) }] : [])],
      setPicture: (picture: BotPicture) => actions.setPicture(botRow, picture) } : {}),
    ...(info ? { where: info } : {}),
  };
  // Choosing another bot dismisses a notice about the last one.
  useEffect(() => { if (place?.kind === 'bot') actions.clearNotice(); }, [key]);
  useEffect(() => { setError(undefined); }, [scope]);
  useEffect(() => {
    if (!visible) return;
    if (returning.current && navigation.rosterVisible) {
      returning.current = false;
      [...root.current?.querySelectorAll<HTMLButtonElement>('[data-bot-place]') ?? []].find(row => row.dataset.botPlace === key)?.focus({ preventScroll: true });
    } else if (keyboardOpen.current && showConversation) { keyboardOpen.current = false; title.current?.focus({ preventScroll: true }); }
  }, [visible, key, showConversation, navigation.rosterVisible]);
  // Hiding the roster (by its button or the shell shortcut) must not drop focus to the page: move it to the sidebar button.
  useLayoutEffect(() => {
    if (rosterHidden && rosterElement.current?.contains(document.activeElement)) rosterToggle.current?.focus({ preventScroll: true });
  }, [rosterHidden]);
  // A phone layout replaces the sidebar button with Back: keep focus on the conversation's top bar.
  useLayoutEffect(() => {
    if (!phone || !toggleHadFocus.current) return;
    toggleHadFocus.current = false;
    if (showConversation) (backButton.current ?? title.current)?.focus({ preventScroll: true });
  }, [phone]);
  /** A group's appearance in either mode, from its header menu; a group always stays visible in one of them. */
  function groupActions(section: BotSection): MenuEntry[] {
    const group = workspace.readGroup(section.groupId);
    if (!group) return [];
    const change = (operation: Parameters<typeof workspace.operateGroup>[1]) => {
      const requestScope = scope; setError(undefined);
      void workspace.operateGroup(section.groupId, operation).catch(reason => { if (currentScope.current === requestScope) setError(reason instanceof Error ? reason.message : String(reason)); });
    };
    const hidden = actions.groupMenu(section);
    return [
      hasWindowAppearance(group)
        ? { label: 'Hide in Window mode', icon: 'eye-off', disabled: !hasBotAppearance(group), onSelect: () => change({ type: 'window.remove' }) }
        : { label: 'Show in Window mode', icon: 'sidebar', onSelect: () => change({ type: 'window.add' }) },
      { label: 'Hide in Bot mode', icon: 'eye-off', disabled: !hasWindowAppearance(group), onSelect: () => change({ type: 'bots.hide' }) },
      ...hidden.length ? [{ kind: 'separator' as const }, ...hidden] : [],
    ];
  }
  // A phone moves between the list and a chat like a navigation stack: the chat pushes in, Back pops to the list at the
  // place it left. Hiding the list drops its scroll position, so it is kept here.
  const [motion, setMotion] = useState<'push' | 'pop'>();
  const rosterScroll = useRef(0);
  const phoneChat = phone && showConversation;
  const wasPhoneChat = useRef(phoneChat);
  useLayoutEffect(() => {
    if (wasPhoneChat.current === phoneChat) return;
    wasPhoneChat.current = phoneChat;
    if (phoneChat) setMotion('push');
    else if (phone) {
      setMotion('pop');
      if (rosterElement.current) rosterElement.current.scrollTop = rosterScroll.current;
    }
  }, [phoneChat, phone]);
  function back() { returning.current = true; navigation.back(); }
  /** Opening a sleeping bot wakes it for every device. */
  function open(next: BotPlace) {
    if (next.kind === 'bot' && workspace.readGroup(next.groupId)?.bots?.members[next.viewId]?.asleep) void actions.wake(next);
    navigation.select(next);
  }
  /** Retries an unconfirmed new group, then opens its bot. */
  async function retryGroup() {
    const requestScope = scope; setError(undefined);
    try {
      const id = await workspace.retrySection();
      if (currentScope.current !== requestScope || !id) return;
      const group = workspace.readGroup(id), bot = group ? botViews(group)[0] : undefined;
      navigation.select(bot ? { kind: 'bot', groupId: id, viewId: bot.id } : { kind: 'section', groupId: id });
    } catch (reason) { if (currentScope.current === requestScope) setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  // A session that is no bot is called by its agent, never by its title (often its first prompt).
  const name = place?.kind === 'session' ? assistantName({ key: botPlaceKey(place), providerId: place.session.providerId })
    : selected.view ? botDisplayName(selected.view.binding) : descriptor?.props.target.title ?? selected.group?.window.title ?? '';
  return <main ref={root} className="lab-bot-workspace" hidden={!visible} {...(!visible ? { inert: '' } : {})} data-workbench-mode="bot" data-compact={compact || undefined} data-phone={phone || undefined}
    data-roster-collapsed={rosterHidden || undefined} data-details={detailsShown && !phone || undefined}
    data-navigation={phone ? motion : undefined}
    onClickCapture={() => { if (phone && !showConversation && rosterElement.current) rosterScroll.current = rosterElement.current.scrollTop; }}
    onPointerDown={event => event.stopPropagation()} onFocus={event => event.stopPropagation()}
    onKeyDown={event => {
      if (event.defaultPrevented || event.nativeEvent.isComposing || event.key !== 'Escape') return;
      if (phone && showConversation) { event.preventDefault(); back(); }
    }}>
    <h1 className="lab-bot-title agent-visually-hidden">{t('assistants.title')}</h1>
    <aside ref={rosterElement} id={rosterId} className="lab-bot-roster orchard-panel" hidden={(phone && showConversation) || rosterHidden}>
      <SidebarHeader brand mode={navigation.mode} onModeChange={navigation.setMode} onSearch={onSearch} actions={onNewBot ? <IconButton icon="plus" label={t('assistants.new')} onClick={onNewBot} /> : undefined} />
      {unavailable ? availabilityNotice : null}
      {saving ? <p className="lab-bot-notice" role="status">Saving the new group…</p> : null}
      {error || creation.error ? <p className="lab-bot-notice" role="alert">{error ?? creation.error}</p> : null}
      {creation.state === 'unknown' ? <p className="lab-bot-notice" role="status">The new group is not confirmed. <button type="button" onClick={() => void retryGroup()}>Retry</button></p> : null}
      {actions.notice}
      <div className="lab-bot-roster-scroll" onClickCapture={event => { keyboardOpen.current = event.detail === 0; }}><SharedBotRoster model={roster} project={projectRoster} place={place} onSelect={open} hostName={hostName} groupActions={groupActions} compact={phone}
        rowActions={(row, section) => actions.cardActions(row, section.title)}
        directoryControls={<div className="lab-bot-directory-controls">
          {directory.sources.map(source => <div key={source.id}><small>{hostName(source.hostId)} · {source.providerId}</small>
            {!source.online ? <p>Host offline</p> : null}{source.loading ? <p role="status">Loading sessions…</p> : null}
            {source.error ? <p role="alert">{source.error}</p> : null}
            <button type="button" disabled={!source.online || source.loading} onClick={() => void directory.refresh(source.id)}>Refresh</button>
            {source.hasMore && !source.expired ? <button type="button" disabled={!source.online || source.loading} onClick={() => void directory.loadMore(source.id)}>Load more</button> : null}
          </div>)}
        </div>} /></div>
      <footer className="lab-bot-sidebar-foot"><DeviceLinkSlot shown={visible} /></footer>
    </aside>
    <section className="lab-bot-conversation orchard-panel" aria-label="Bot conversation" hidden={phone && !showConversation}>
      {conversation ? <SharedTopBar ref={title} place={place} row={botRow} project={projectRoster} name={name}
        detailsOpen={detailsShown} detailsId={detailsId} onToggleDetails={descriptor ? () => setDetailsOpen(open => !open) : undefined}
        leading={phone ? <Button ref={backButton} variant="plain" className="lab-bot-back" aria-label={t('assistants.back')} onClick={back}><Icon name="chevron-left" size={20} />{t('assistants.backShort')}</Button>
          : <IconButton ref={toggleRef} icon="sidebar" label={rosterCollapsed ? 'Show sidebar' : 'Hide sidebar'} aria-expanded={!rosterCollapsed} aria-controls={rosterId} onClick={onToggleRoster} />}
        trailing={<span ref={setToolsSlot} className="lab-assistant-tools" />} /> : null}
      {!unavailable ? availabilityNotice : null}
      {asleep && descriptor ? <AsleepNotice onWake={() => place?.kind === 'bot' && void actions.wake(place)} /> : null}
      {descriptor ? <AssistantDetailsHostContext.Provider value={detailsHost}>
        <Mount mode="bot" active={visible && showConversation} descriptor={{ ...descriptor, props: { ...descriptor.props, visible: visible && showConversation, active: visible && showConversation, folded: asleep } }} />
      </AssistantDetailsHostContext.Provider>
        : !selected.loading && !selected.error ? <p className="lab-bot-empty">{place?.kind === 'section' ? t('assistants.chooseInGroup') : t('assistants.choose')}</p> : null}
    </section>
    <aside ref={setDetailsSlot} id={detailsId} className="lab-assistant-details orchard-panel" aria-label={t('details.title')} hidden={!detailsShown || phone}>
      <header className="lab-assistant-details-head"><h2>{t('details.title')}</h2>
        <IconButton icon="close" label={t('details.close')} onClick={() => setDetailsOpen(false)} /></header>
    </aside>
    {actions.sheets}
  </main>;
}

/** One projection of the roster per frame of the shared feeds, read by the list and the top bar alike. */
const sharedProjections = new WeakMap<SharedFeedsSnapshot, { project(shared: SharedFeedsSnapshot): BotRosterModel; model: BotRosterModel }>();
function projectShared(project: (shared: SharedFeedsSnapshot) => BotRosterModel, shared: SharedFeedsSnapshot): BotRosterModel {
  const cached = sharedProjections.get(shared);
  if (cached?.project === project) return cached.model;
  const model = project(shared);
  sharedProjections.set(shared, { project, model });
  return model;
}

/** The roster on screen: it follows the shared feeds itself, so their frames render it and not the workspace around it. */
function SharedBotRoster({ model, project, ...props }: ComponentProps<typeof BotRoster> & { project?(shared: SharedFeedsSnapshot): BotRosterModel }) {
  const shared = useSharedFeed(snapshot => project ? snapshot : undefined);
  const projected = useMemo(() => project && shared ? projectShared(project, shared) : model, [project, shared, model]);
  return <BotRoster model={projected} {...props} />;
}

/** The conversation's top bar says the same sentence as the assistant's row, from the same shared feeds. */
const SharedTopBar = forwardRef<HTMLButtonElement, Omit<ComponentProps<typeof AssistantTopBar>, 'id' | 'picture' | 'status' | 'name'> & {
  place: BotPlace; row?: BotRow; project?(shared: SharedFeedsSnapshot): BotRosterModel; name: string;
}>(function SharedTopBar({ place, row, project, name, ...props }, ref) {
  const shared = useSharedFeed(snapshot => project && row ? snapshot : undefined);
  const current = useMemo(() => row && project && shared ? projectShared(project, shared).sections.find(section => section.groupId === row.groupId)?.rows.find(item => item.viewId === row.viewId) ?? row : row, [row, project, shared]);
  const id = place.kind === 'bot' ? place.viewId : place.kind === 'session' ? `${place.session.providerId}:${place.session.nativeSessionId}` : place.groupId;
  return <AssistantTopBar ref={ref} id={id} picture={current?.details.picture} name={current ? botDisplayName(current.binding) : name} status={current?.assistant} {...props} />;
});
