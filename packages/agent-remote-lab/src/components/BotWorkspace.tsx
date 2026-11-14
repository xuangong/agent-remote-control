import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { useWindowWorkspace } from '../hooks/useWindowWorkspace.js';
import type { useWorkbenchMode } from '../hooks/useWorkbenchMode.js';
import type { useBotWorkspace } from '../hooks/useBotWorkspace.js';
import type { useOtherSessions } from '../hooks/useOtherSessions.js';
import { useVisualViewport } from '../hooks/useVisualViewport.js';
import type { BotRosterModel } from '../bot-roster.js';
import type { BotPlace } from '../workbench-mode.js';
import { BotRoster, botDisplayName, botPlaceKey } from './BotRoster.js';
import { useBotActions, type BotInfo } from './BotActions.js';
import { Menu } from '../ui/Menu.js';
import { WorkbenchModeSwitch } from './WorkbenchModeSwitch.js';
import { SessionConversationMount, type SessionSurfaceDescriptor } from './SessionConversationSurfaces.js';
import { SidebarHeader } from '../shell/SidebarHeader.js';
import { Toolbar } from '../ui/Toolbar.js';
import { IconButton } from '../ui/IconButton.js';
import { Button } from '../ui/Button.js';
import type { MenuEntry } from '../ui/Menu.js';
import { botViews, hasBotAppearance, hasWindowAppearance } from '@orchardworks/agent-remote-protocol';
import type { BotSection } from '../bot-roster.js';
import './bot-workspace.css';

export interface BotWorkspaceProps {
  visible: boolean; compact: boolean; scope: string;
  workspace: ReturnType<typeof useWindowWorkspace>;
  navigation: ReturnType<typeof useWorkbenchMode>;
  selected: ReturnType<typeof useBotWorkspace>;
  roster: BotRosterModel; directory: ReturnType<typeof useOtherSessions>;
  describeConversation(place: BotPlace): SessionSurfaceDescriptor | undefined;
  /** Whether the desktop roster is hidden; the state lives in App so the shell shortcut can toggle it. Compact layouts ignore it. */
  rosterCollapsed: boolean; onToggleRoster(): void;
  /** Opens search; the roster's header offers it. */
  onSearch?(): void;
  /** A Host's display name for a Host ID. */
  hostName?(hostId: string): string;
  /** Opens New bot, which starts a session in a group of its own. */
  onNewBot?(): void;
  /** Where a bot runs, for its Info sheet. */
  botInfo?(place: { groupId: string; viewId: string }): BotInfo | undefined;
}
export function BotWorkspace({ visible, compact, scope, workspace, navigation, selected, roster, directory, describeConversation, rosterCollapsed, onToggleRoster, onSearch, hostName = id => id, botInfo, onNewBot }: BotWorkspaceProps) {
  const root = useVisualViewport(), heading = useRef<HTMLHeadingElement>(null), keyboardOpen = useRef(false), returning = useRef(false);
  const [error, setError] = useState<string>();
  const currentScope = useRef(scope); currentScope.current = scope;
  const rosterId = useId(), rosterElement = useRef<HTMLElement>(null), rosterToggle = useRef<HTMLButtonElement | null>(null);
  const backButton = useRef<HTMLButtonElement>(null), toggleHadFocus = useRef(false);
  // React detaches the ref before it removes the node, so this sees whether the toggle had focus when a compact layout replaces it.
  const toggleRef = useCallback((node: HTMLButtonElement | null) => {
    if (!node && rosterToggle.current && rosterToggle.current === document.activeElement) toggleHadFocus.current = true;
    rosterToggle.current = node;
  }, []);
  const rosterHidden = !compact && rosterCollapsed;
  const place = navigation.place, key = place && botPlaceKey(place);
  const conversation = !!place && place.kind !== 'section';
  const descriptor = conversation ? describeConversation(place) : undefined;
  const unavailable = compact && !!selected.error && !descriptor;
  const showConversation = conversation && !unavailable && (!compact || !navigation.rosterVisible);
  const availabilityNotice = selected.loading ? <p role="status">Opening bot…</p> : selected.error && place?.kind !== 'session'
    ? <p role="alert">{selected.error} <button type="button" onClick={() => void selected.retry()}>Retry</button></p> : null;
  const creation = workspace.sectionCreationState, saving = creation.state === 'saving';
  const actions = useBotActions({ scope, workspace, onSelect: navigation.select, onError: setError, botInfo });
  const botSection = place?.kind === 'bot' ? roster.sections.find(section => section.groupId === place.groupId) : undefined;
  const botRow = place?.kind === 'bot' ? botSection?.rows.find(row => row.viewId === place.viewId) : undefined;
  const botMenu = botRow && botSection && descriptor ? <Menu label={`Bot actions: ${botDisplayName(botRow.binding)}`} items={actions.botMenu(botRow, botSection.title)} /> : null;
  // Choosing another bot dismisses a notice about the last one.
  useEffect(() => { if (place?.kind === 'bot') actions.clearNotice(); }, [key]);
  useEffect(() => { setError(undefined); }, [scope]);
  useEffect(() => {
    if (!visible) return;
    if (returning.current && navigation.rosterVisible) {
      returning.current = false;
      [...root.current?.querySelectorAll<HTMLButtonElement>('[data-bot-place]') ?? []].find(row => row.dataset.botPlace === key)?.focus({ preventScroll: true });
    } else if (keyboardOpen.current && showConversation) { keyboardOpen.current = false; heading.current?.focus({ preventScroll: true }); }
  }, [visible, key, showConversation, navigation.rosterVisible]);
  // Hiding the roster (by its button or the shell shortcut) must not drop focus to the page: move it to the sidebar button.
  useLayoutEffect(() => {
    if (rosterHidden && rosterElement.current?.contains(document.activeElement)) rosterToggle.current?.focus({ preventScroll: true });
  }, [rosterHidden]);
  // A compact layout replaces the sidebar button with Back: keep focus on the conversation's toolbar.
  useLayoutEffect(() => {
    if (!compact || !toggleHadFocus.current) return;
    toggleHadFocus.current = false;
    if (showConversation) (backButton.current ?? heading.current)?.focus({ preventScroll: true });
  }, [compact]);
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
  function back() { returning.current = true; navigation.back(); }
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
  return <main ref={root} className="lab-bot-workspace" hidden={!visible} {...(!visible ? { inert: '' } : {})} data-workbench-mode="bot" data-compact={compact || undefined} data-roster-collapsed={rosterHidden || undefined}
    onPointerDown={event => event.stopPropagation()} onFocus={event => event.stopPropagation()}
    onKeyDown={event => {
      if (event.defaultPrevented || event.nativeEvent.isComposing || event.key !== 'Escape') return;
      if (compact && showConversation) { event.preventDefault(); back(); }
    }}>
    <h1 className={compact && !showConversation ? 'lab-bot-title' : 'lab-bot-title agent-visually-hidden'}>Bots</h1>
    <aside ref={rosterElement} id={rosterId} className="lab-bot-roster" hidden={(compact && showConversation) || rosterHidden}>
      <SidebarHeader mode={navigation.mode} onModeChange={navigation.setMode} onSearch={onSearch} actions={onNewBot ? <IconButton icon="plus" label="New bot" onClick={onNewBot} /> : undefined} />
      {unavailable ? availabilityNotice : null}
      {saving ? <p className="lab-bot-notice" role="status">Saving the new group…</p> : null}
      {error || creation.error ? <p className="lab-bot-notice" role="alert">{error ?? creation.error}</p> : null}
      {creation.state === 'unknown' ? <p className="lab-bot-notice" role="status">The new group is not confirmed. <button type="button" onClick={() => void retryGroup()}>Retry</button></p> : null}
      {actions.notice}
      <div onClickCapture={event => { keyboardOpen.current = event.detail === 0; }}><BotRoster model={roster} place={place} onSelect={navigation.select} hostName={hostName} groupActions={groupActions} compact={compact}
        directoryControls={<div className="lab-bot-directory-controls">
          {directory.sources.map(source => <div key={source.id}><small>{hostName(source.hostId)} · {source.providerId}</small>
            {!source.online ? <p>Host offline</p> : null}{source.loading ? <p role="status">Loading sessions…</p> : null}
            {source.error ? <p role="alert">{source.error}</p> : null}
            <button type="button" disabled={!source.online || source.loading} onClick={() => void directory.refresh(source.id)}>Refresh</button>
            {source.hasMore && !source.expired ? <button type="button" disabled={!source.online || source.loading} onClick={() => void directory.loadMore(source.id)}>Load more</button> : null}
          </div>)}
        </div>} /></div>
    </aside>
    <section className="lab-bot-conversation" aria-label="Bot conversation" hidden={compact && !showConversation}>
      <Toolbar className="lab-bot-conversation-toolbar" titleRef={heading} titleFocusable
        leading={compact ? <Button ref={backButton} variant="plain" aria-label="Back to bots" onClick={back}>Back</Button>
          : <IconButton ref={toggleRef} icon="sidebar" label={rosterCollapsed ? 'Show sidebar' : 'Hide sidebar'} aria-expanded={!rosterCollapsed} aria-controls={rosterId} onClick={onToggleRoster} />}
        title={place?.kind === 'session' ? place.session.title : selected.view?.binding.title ?? descriptor?.props.target.title ?? selected.group?.window.title ?? 'Choose a bot'}
        trailing={compact ? <><WorkbenchModeSwitch mode={navigation.mode} onChange={navigation.setMode} />{botMenu}</> : botMenu ?? undefined} />
      {!unavailable ? availabilityNotice : null}
      {descriptor ? <SessionConversationMount mode="bot" active={visible && showConversation} descriptor={{ ...descriptor, props: { ...descriptor.props, visible: visible && showConversation, active: visible && showConversation, fixedDisplayMode: 'content' } }} />
        : !selected.loading && !selected.error ? <p className="lab-bot-empty">{place?.kind === 'section' ? 'No bot selected. Choose a bot from this group.' : 'Choose a bot to continue its conversation.'}</p> : null}
    </section>
    {actions.sheets}
  </main>;
}
