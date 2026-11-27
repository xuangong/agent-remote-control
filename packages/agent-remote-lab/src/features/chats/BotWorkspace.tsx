import { forwardRef, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ComponentType } from 'react';
import { DeviceLinkContext } from '../../kernel/device-link.js';
import type { Team } from '@orchardworks/agent-remote-protocol';
import { BotRooms } from './BotRooms.js';
import type { useWindowWorkspace } from '../windows/useWindowWorkspace.js';
import type { useWorkbenchMode } from '../../kernel/useWorkbenchMode.js';
import type { useOtherSessions } from './useOtherSessions.js';
import { useVisualViewport } from '../../kernel/useVisualViewport.js';
import { usePhoneLayout } from '../../kernel/usePhoneLayout.js';
import type { BotRosterModel, BotRow } from '../../kernel/bot-roster.js';
import type { BotPlace } from '../../kernel/workbench-mode.js';
import { BotRoster, botPlaceKey } from './BotRoster.js';
import { useSharedFeed, type SharedFeedsSnapshot } from '../../kernel/shared-feeds.js';
import { projectShared, useSharedRoster } from './shared-roster.js';
import { useBotActions, type BotInfo } from './BotActions.js';
import { useGroupActions } from './useGroupActions.js';
import { AsleepNotice } from '../../conversation/AsleepNotice.js';
import { SessionConversationMount, type SessionSurfaceDescriptor } from '../../conversation/SessionConversationSurfaces.js';
import { SidebarHeader } from '../../kernel/SidebarHeader.js';
import { IconButton } from '../../ui/IconButton.js';
import { Button } from '../../ui/Button.js';
import { Icon } from '../../ui/Icon.js';
import { botViews, type BotPicture } from '@orchardworks/agent-remote-protocol';
import { errorWords } from '@orchardworks/agent-client';
import { OpeningReplyContext, TimelineSkeleton, useTranslate } from '@orchardworks/agent-client-web/react';
import { AssistantTopBar } from './AssistantTopBar.js';
import { AssistantDetailsHostContext, type AssistantDetailsHost } from '../../conversation/assistant/details-host.js';
import { useAssistantNames } from '../../kernel/names-context.js';
import { useContextMenu } from '../../ui/ContextMenu.js';
import { OrchardMark } from '@orchardworks/agent-client-web/primitives';
import { shortcutKeys } from '../../kernel/shortcuts.js';
import { applePlatform } from '../../kernel/platform.js';
import { useNavigationStack } from './useNavigationStack.js';
import { keepRecent, type KeptConversation } from './kept-conversations.js';
import './bot-workspace.css';

/** What Bot mode shows of the selected group while it is acquired: whether it loads, why it is unavailable, and a retry. */
export interface BotSelection { loading: boolean; error?: string; retry(): Promise<void> }

export interface BotWorkspaceProps {
  visible: boolean; compact: boolean; scope: string;
  /** The account's rooms, from the Teams the page keeps (bots design 10). */
  rooms?: readonly Team[];
  /** Settings or the directory is over this workspace: it keeps its conversation and its draft, but is out of sight and reach. */
  covered?: boolean;
  workspace: ReturnType<typeof useWindowWorkspace>;
  navigation: ReturnType<typeof useWorkbenchMode>;
  selected: BotSelection;
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
  /** A Host's display name for a Host ID. */
  hostName?(hostId: string): string;
  /** Opens New bot, which starts a session in a group of its own. */
  onNewBot?(): void;
  /** Where a bot runs, for its details. */
  botInfo?(place: { groupId: string; viewId: string }): BotInfo | undefined;
  /** Shows a bot's tile in Window mode, keeping this place for the way back. */
  onPinToWindow?(place: { groupId: string; viewId: string }): void;
  /** Opens search across chats and messages: the rail has it on a desktop, the list's header on a phone. */
  onSearch?(): void;
}

/** Whether a conversation shows: at phone width one screen shows at a time, the list as home, and an unavailable assistant leaves the list on screen. */
export function botConversationShown(facts: { place?: BotPlace; phone: boolean; rosterVisible: boolean; unavailable: boolean }): boolean {
  return !!facts.place && facts.place.kind !== 'section' && !facts.unavailable && (!facts.phone || !facts.rosterVisible);
}

/**
 * Bot mode: three floating panels on the warm ground, the assistants, the conversation and its details (I3 plan, B2).
 * The details are closed by default below the compact width; at phone width one screen shows at a time, the list as home,
 * and the details open as a sheet.
 */
export function BotWorkspace({ visible, covered = false, compact, scope, rooms, workspace, navigation, selected, roster, projectRoster, directory, describeConversation, mount: Mount = SessionConversationMount, hostName = id => id, botInfo, onNewBot, onPinToWindow, onSearch }: BotWorkspaceProps) {
  const t = useTranslate();
  const names = useAssistantNames();
  const phone = usePhoneLayout();
  const root = useVisualViewport(), title = useRef<HTMLButtonElement>(null), keyboardOpen = useRef(false), returning = useRef(false);
  const [error, setError] = useState<string>();
  const currentScope = useRef(scope); currentScope.current = scope;
  const rosterId = useId(), detailsId = useId(), rosterElement = useRef<HTMLElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const place = navigation.place, key = place && botPlaceKey(place);
  const conversation = !!place && place.kind !== 'section';
  const descriptor = conversation ? describeConversation(place) : undefined;
  const unavailable = phone && !!selected.error && !descriptor;
  const showConversation = botConversationShown({ ...(place ? { place } : {}), phone, rosterVisible: navigation.rosterVisible, unavailable });
  // The conversations under the one on screen stay mounted, parked, and the one a phone is leaving stays on screen while it slides out.
  const keptConversations = useRef<readonly KeptConversation<BotPlace, SessionSurfaceDescriptor>[]>([]);
  const keptScope = useRef(scope);
  if (keptScope.current !== scope) { keptScope.current = scope; keptConversations.current = []; }
  const kept = keepRecent(keptConversations.current, key, key && place && descriptor ? { key, place, description: descriptor } : undefined);
  useLayoutEffect(() => { keptConversations.current = kept; });
  const stack = useNavigationStack({ root, list: rosterElement, phone, showConversation, shownKey: showConversation ? key : undefined, onBack: () => back() });
  // What the conversation panel shows: the chosen conversation, or the one a phone is sliding away from.
  const leaving = !showConversation && stack.motion === 'pop' ? kept.find(item => item.key === stack.leavingKey) : undefined;
  const panelPlace = leaving ? leaving.place : place, panelKey = leaving ? leaving.key : key;
  const panelConversation = !!panelPlace && panelPlace.kind !== 'section';
  const panelDescriptor = leaving ? leaving.description : descriptor;
  const panelShown = showConversation || !!leaving;
  const offline = useContext(DeviceLinkContext)?.notice?.state === 'offline';
  const availabilityNotice = selected.loading ? <p role="status">{t('navigation.botWorkspace.opening')}</p> : selected.error && place?.kind !== 'session'
    ? <p role="alert">{selected.error} <button type="button" onClick={() => void selected.retry()}>{t('common.retry')}</button></p> : null;
  const creation = workspace.sectionCreationState, saving = creation.state === 'saving';
  const actions = useBotActions({ scope, workspace, onSelect: navigation.select, onError: setError });
  // An assistant that moves to another group while open here stays open at its new place.
  const groupActions = useGroupActions({ workspace, defaultTitle: t('navigation.groups.default'), onMoved: (from, to) => {
    const shown = navigation.place;
    if (shown?.kind === 'bot' && shown.groupId === from.groupId && shown.viewId === from.viewId) navigation.select({ kind: 'bot', ...to });
  } });
  // A right-click (or Shift-F10) on a chat offers the assistant's own actions: pin, mute, rename and move (kernel/context-menus.ts).
  const contextMenu = useContextMenu();
  const chatMenu = (row: BotRow, anchor: HTMLElement, point?: { x: number; y: number }) =>
    contextMenu.show(anchor, t('card.more', { name: row.name }), groupActions.assistantMenu(row), point);
  const botSection = panelPlace?.kind === 'bot' ? roster.sections.find(section => section.groupId === panelPlace.groupId) : undefined;
  const botRow = panelPlace?.kind === 'bot' ? botSection?.rows.find(row => row.viewId === panelPlace.viewId) : undefined;
  // A bot put to sleep elsewhere while open here: its conversation is released until it is woken.
  const asleep = panelPlace?.kind === 'bot' && !!workspace.readGroup(panelPlace.groupId)?.bots?.members[panelPlace.viewId]?.asleep;
  // The details sit beside the conversation from the compact width up; below it they wait to be opened.
  const [detailsOpen, setDetailsOpen] = useState(!compact);
  useEffect(() => { setDetailsOpen(!compact); }, [compact]);
  const [detailsSlot, setDetailsSlot] = useState<HTMLElement | null>(null);
  const [toolsSlot, setToolsSlot] = useState<HTMLElement | null>(null);
  const detailsShown = detailsOpen && !!panelDescriptor && panelShown;
  const info = panelPlace?.kind === 'bot' ? botInfo?.(panelPlace) : undefined;
  const detailsHost: AssistantDetailsHost = {
    surface: phone ? 'sheet' : 'panel', slot: detailsSlot, tools: toolsSlot, open: detailsShown, setOpen: setDetailsOpen,
    ...(botRow && botSection ? { actions: actions.cardActions(botRow, botSection.title, groupActions.assistantMenu(botRow, { rename: false })),
      ...(onPinToWindow ? { action: { label: t('card.pin'), icon: 'window' as const, onSelect: () => onPinToWindow({ groupId: botRow.groupId, viewId: botRow.viewId }) } } : {}),
      setPicture: (picture: BotPicture) => actions.setPicture(botRow, picture), rename: (name: string) => actions.rename(botRow, name) } : {}),
    ...(info ? { where: info } : {}),
    ...(botRow?.reply?.preview ? { latestReply: botRow.reply.preview } : {}),
  };
  // Choosing another bot dismisses a notice about the last one.
  useEffect(() => { if (place?.kind === 'bot') actions.clearNotice(); }, [key]);
  useEffect(() => { setError(undefined); }, [scope]);
  // A bot opened with the keyboard takes focus to its title. The title is a button only once the conversation is described, so the
  // intent waits for it instead of being spent on a title that cannot take focus yet.
  const titleFocusable = !!descriptor;
  useEffect(() => {
    if (!visible) return;
    if (returning.current && navigation.rosterVisible) {
      returning.current = false;
      [...root.current?.querySelectorAll<HTMLButtonElement>('[data-bot-place]') ?? []].find(row => row.dataset.botPlace === key)?.focus({ preventScroll: true });
    } else if (keyboardOpen.current && showConversation && title.current) { keyboardOpen.current = false; title.current.focus({ preventScroll: true }); }
  }, [visible, key, showConversation, navigation.rosterVisible, titleFocusable]);
  // A browser may drop the scroll position of a list it stops displaying, so the list's own is kept and put back when it returns.
  const rosterScroll = useRef(0);
  useLayoutEffect(() => { if (phone && !showConversation && rosterElement.current) rosterElement.current.scrollTop = rosterScroll.current; }, [phone, showConversation]);
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
    } catch (reason) { if (currentScope.current === requestScope) setError(errorWords(reason, t, 'navigation.botWorkspace.failed')); }
  }
  // An assistant is called by its name, never by its session's title (often its first prompt).
  const name = panelPlace?.kind === 'session' ? names.session(panelPlace.session)
    : panelPlace?.kind === 'bot' ? botRow?.name ?? names.view(panelPlace.groupId, panelPlace.viewId) : '';
  return <main ref={root} className="lab-bot-workspace" hidden={!visible || covered} {...(!visible || covered ? { inert: '' } : {})} data-workbench-mode="bot" data-compact={compact || undefined} data-phone={phone || undefined}
    data-details={detailsShown && !phone || undefined} data-chat={phone && showConversation || undefined}
    data-navigation={phone ? stack.motion : undefined}
    onClickCapture={() => { if (phone && !showConversation && rosterElement.current) rosterScroll.current = rosterElement.current.scrollTop; }}
    onPointerDown={event => event.stopPropagation()} onFocus={event => event.stopPropagation()}
    onKeyDown={event => {
      if (event.defaultPrevented || event.nativeEvent.isComposing || event.key !== 'Escape') return;
      if (phone && showConversation) { event.preventDefault(); back(); }
    }}>
    <h1 className="lab-bot-title agent-visually-hidden">{t('navigation.chats')}</h1>
    <aside ref={rosterElement} id={rosterId} className="lab-bot-roster orchard-panel" hidden={phone && showConversation && stack.motion !== 'push' && !stack.peek}>
      <SidebarHeader brand actions={onNewBot || phone && onSearch ? <>
        {phone && onSearch ? <IconButton icon="search" label={t('navigation.search')} onClick={onSearch} /> : null}
        {onNewBot ? <IconButton icon="plus" label={t('assistants.new')} onClick={onNewBot} /> : null}</> : undefined} />
      {unavailable ? availabilityNotice : null}
      {saving ? <p className="lab-bot-notice" role="status">{t('navigation.botWorkspace.saving')}</p> : null}
      {error || creation.error ? <p className="lab-bot-notice" role="alert">{error ?? creation.error}</p> : null}
      {creation.state === 'unknown' ? <p className="lab-bot-notice" role="status">{t('navigation.botWorkspace.groupUnconfirmed')} <button type="button" onClick={() => void retryGroup()}>{t('common.retry')}</button></p> : null}
      {actions.notice}
      {groupActions.error ? <p className="lab-bot-notice" role="alert">{groupActions.error}</p> : groupActions.notice ? <p className="lab-bot-notice" role="status">{groupActions.notice}</p> : null}
      <div className="lab-bot-roster-scroll" onClickCapture={event => { keyboardOpen.current = event.detail === 0; }}>{rooms ? <BotRooms scope={scope} rooms={rooms} /> : null}<SharedBotRoster model={roster} groups={workspace.groups} knowledge={workspace.groupsKnowledge} project={projectRoster} place={place} onSelect={open} hostName={hostName} compact={phone} menu={chatMenu}
        directoryControls={<div className="lab-bot-directory-controls">
          {directory.sources.map(source => <div key={source.id}><small>{hostName(source.hostId)} · {source.providerId}</small>
            {!source.online ? <p>{t('navigation.botWorkspace.hostOffline')}</p> : null}{source.loading ? <p role="status">{t('navigation.botWorkspace.loadingSessions')}</p> : null}
            {source.error ? <p role="alert">{source.error}</p> : null}
            <button type="button" disabled={!source.online || source.loading} onClick={() => void directory.refresh(source.id)}>{t('common.refresh')}</button>
            {source.hasMore && !source.expired ? <button type="button" disabled={!source.online || source.loading} onClick={() => void directory.loadMore(source.id)}>{t('navigation.botWorkspace.loadMore')}</button> : null}
          </div>)}
        </div>} /></div>
      {/* When the Relay cannot be reached the roster is the device's copy, and says so in one quiet line below the list, which moves no row. */}
      {offline ? <p className="lab-bot-notice lab-bot-offline" role="status">{t('navigation.savedChats')}</p> : null}
    </aside>
    {phone ? <div ref={stack.scrim} className="lab-bot-scrim" aria-hidden="true" /> : null}
    <section ref={stack.conversation} className="lab-bot-conversation orchard-panel" aria-label={t('navigation.botConversation')} hidden={phone && !panelShown}>
      {panelConversation ? <SharedTopBar ref={title} place={panelPlace} row={botRow} project={projectRoster} name={name}
        detailsOpen={detailsShown} detailsId={detailsId} onToggleDetails={panelDescriptor ? () => setDetailsOpen(open => !open) : undefined}
        leading={phone ? <Button ref={backButton} variant="plain" className="lab-bot-back" aria-label={t('assistants.back')} onClick={back}><Icon name="chevron-left" size={20} />{t('assistants.backShort')}</Button> : undefined}
        trailing={<span ref={setToolsSlot} className="lab-assistant-tools" />} /> : null}
      {!unavailable ? availabilityNotice : null}
      {asleep && panelDescriptor ? <AsleepNotice onWake={() => panelPlace?.kind === 'bot' && void actions.wake(panelPlace)} /> : null}
      {/* Each kept conversation has its slot: the one on screen is shown, the others wait parked and detached with their state. */}
      {kept.map(item => item.key === panelKey && panelShown
        ? <div key={item.key} className="lab-bot-slot"><AssistantDetailsHostContext.Provider value={detailsHost}>
          <Mount mode="bot" active={visible} descriptor={{ ...item.description, props: { ...item.description.props, visible, active: visible, folded: asleep } }} />
        </AssistantDetailsHostContext.Provider></div>
        : <div key={item.key} className="lab-bot-slot" hidden>
          <Mount mode="bot" active={false} descriptor={{ ...item.description, props: { ...item.description.props, visible: false, active: false } }} />
        </div>)}
      {panelDescriptor ? null
        : selected.loading || selected.error ? null
        // A conversation was chosen and its group has not loaded: its layout holds the place, and nothing says it is missing.
        : place?.kind === 'bot' || place?.kind === 'session' ? <div className="lab-bot-pending"><OpeningReplyContext.Provider value={botRow?.reply?.preview}><TimelineSkeleton /></OpeningReplyContext.Provider></div>
        // Before the roster loads, nobody is known to be missing: the welcome keeps its place and says nothing yet.
        : workspace.groupsKnowledge && workspace.groupsKnowledge !== 'confirmed' && !workspace.groups.length ? <div className="lab-bot-welcome" data-quiet><OrchardMark size={56} /><h2>&nbsp;</h2><p>&nbsp;</p></div>
        : <div className="lab-bot-welcome">
          <OrchardMark size={56} />
          <h2>{t('assistants.chooseTitle')}</h2>
          <p>{place?.kind === 'section' ? t('assistants.chooseInGroup') : t('assistants.chooseHint', { keys: shortcutKeys('search', applePlatform()).shown })}</p>
        </div>}
    </section>
    <aside ref={setDetailsSlot} id={detailsId} className="lab-assistant-details orchard-panel" aria-label={t('details.title')} hidden={!detailsShown || phone}>
      <header className="lab-assistant-details-head"><h2>{t('details.title')}</h2>
        <IconButton icon="close" label={t('details.close')} onClick={() => setDetailsOpen(false)} /></header>
    </aside>
    {actions.sheets}
    {groupActions.sheets([])}
    {contextMenu.menu}
  </main>;
}

/** The roster on screen: it follows the shared feeds itself, so their frames render it and not the workspace around it. */
function SharedBotRoster({ model, project, ...props }: ComponentProps<typeof BotRoster> & { project?(shared: SharedFeedsSnapshot): BotRosterModel }) {
  return <BotRoster model={useSharedRoster(model, project)} {...props} />;
}

/** The conversation's top bar says the same sentence as the assistant's row, from the same shared feeds. */
const SharedTopBar = forwardRef<HTMLButtonElement, Omit<ComponentProps<typeof AssistantTopBar>, 'id' | 'picture' | 'status' | 'name'> & {
  place: BotPlace; row?: BotRow; project?(shared: SharedFeedsSnapshot): BotRosterModel; name: string;
}>(function SharedTopBar({ place, row, project, name, ...props }, ref) {
  const shared = useSharedFeed(snapshot => project && row ? snapshot : undefined);
  const current = useMemo(() => row && project && shared ? projectShared(project, shared).sections.find(section => section.groupId === row.groupId)?.rows.find(item => item.viewId === row.viewId) ?? row : row, [row, project, shared]);
  const id = place.kind === 'bot' ? place.viewId : place.kind === 'session' ? `${place.session.providerId}:${place.session.nativeSessionId}` : place.groupId;
  return <AssistantTopBar ref={ref} id={id} picture={current?.details.picture} name={current ? current.name : name} status={current?.assistant} {...props} />;
});
