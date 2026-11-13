import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { useWindowWorkspace } from '../hooks/useWindowWorkspace.js';
import type { useWorkbenchMode } from '../hooks/useWorkbenchMode.js';
import type { useBotWorkspace } from '../hooks/useBotWorkspace.js';
import type { useOtherSessions } from '../hooks/useOtherSessions.js';
import { useVisualViewport } from '../hooks/useVisualViewport.js';
import type { BotRosterModel } from '../bot-roster.js';
import type { BotPlace } from '../workbench-mode.js';
import { BotRoster, botPlaceKey } from './BotRoster.js';
import { WorkbenchModeSwitch } from './WorkbenchModeSwitch.js';
import { SessionConversationMount, type SessionSurfaceDescriptor } from './SessionConversationSurfaces.js';
import { SidebarHeader } from '../shell/SidebarHeader.js';
import { Toolbar } from '../ui/Toolbar.js';
import { IconButton } from '../ui/IconButton.js';
import { Button } from '../ui/Button.js';
import type { MenuEntry } from '../ui/Menu.js';
import { hasBotAppearance, hasWindowAppearance } from '@orchardworks/agent-remote-protocol';
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
}
export function BotWorkspace({ visible, compact, scope, workspace, navigation, selected, roster, directory, describeConversation, rosterCollapsed, onToggleRoster, onSearch, hostName = id => id }: BotWorkspaceProps) {
  const root = useVisualViewport(), heading = useRef<HTMLHeadingElement>(null), keyboardOpen = useRef(false), returning = useRef(false);
  const [creating, setCreating] = useState(false), [title, setTitle] = useState(''), [error, setError] = useState<string>();
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
  useEffect(() => { setCreating(false); setTitle(''); setError(undefined); }, [scope]);
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
  function startSection() { setCreating(true); setError(undefined); }
  /** A group's appearance in either mode, from its header menu; a group always stays visible in one of them. */
  function groupActions(section: BotSection): MenuEntry[] {
    const group = workspace.readGroup(section.groupId);
    if (!group) return [];
    const change = (operation: Parameters<typeof workspace.operateGroup>[1]) => {
      const requestScope = scope; setError(undefined);
      void workspace.operateGroup(section.groupId, operation).catch(reason => { if (currentScope.current === requestScope) setError(reason instanceof Error ? reason.message : String(reason)); });
    };
    return [
      hasWindowAppearance(group)
        ? { label: 'Hide in Window mode', icon: 'eye-off', disabled: !hasBotAppearance(group), onSelect: () => change({ type: 'window.remove' }) }
        : { label: 'Show in Window mode', icon: 'sidebar', onSelect: () => change({ type: 'window.add' }) },
      { label: 'Hide in Bot mode', icon: 'eye-off', disabled: !hasWindowAppearance(group), onSelect: () => change({ type: 'bots.hide' }) },
    ];
  }
  function back() { returning.current = true; navigation.back(); }
  async function save(retry = false) {
    const requestScope = scope; setError(undefined);
    try {
      const id = await (retry ? workspace.retrySection() : workspace.createSection(title));
      if (currentScope.current !== requestScope) return;
      setCreating(false); setTitle(''); navigation.select({ kind: 'section', groupId: id });
    } catch (reason) { if (currentScope.current === requestScope) setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  return <main ref={root} className="lab-bot-workspace" hidden={!visible} {...(!visible ? { inert: '' } : {})} data-workbench-mode="bot" data-compact={compact || undefined} data-roster-collapsed={rosterHidden || undefined}
    onPointerDown={event => event.stopPropagation()} onFocus={event => event.stopPropagation()}
    onKeyDown={event => {
      if (event.defaultPrevented || event.nativeEvent.isComposing || event.key !== 'Escape') return;
      if (creating) { event.preventDefault(); setCreating(false); }
      else if (compact && showConversation) { event.preventDefault(); back(); }
    }}>
    <h1 className={compact && !showConversation ? 'lab-bot-title' : 'lab-bot-title agent-visually-hidden'}>Bots</h1>
    <aside ref={rosterElement} id={rosterId} className="lab-bot-roster" hidden={(compact && showConversation) || rosterHidden}>
      <SidebarHeader mode={navigation.mode} onModeChange={navigation.setMode} onSearch={onSearch} actions={<IconButton icon="plus" label="New section" onClick={startSection} />} />
      {unavailable ? availabilityNotice : null}
      {creating ? <form className="lab-bot-new-section" aria-label="New section" onSubmit={event => { event.preventDefault(); void save(); }}
        onKeyDown={event => { if (!event.nativeEvent.isComposing && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setCreating(false); } }}>
        <label>Section title<input autoFocus required maxLength={256} aria-label="Section title" disabled={saving || creation.state === 'unknown'} value={title} onChange={event => setTitle(event.target.value)} /></label>
        <div><button type="submit" disabled={saving || creation.state === 'unknown' || !title.trim()}>Save</button><button type="button" onClick={() => setCreating(false)}>Cancel</button></div>
      </form> : null}
      {saving ? <p role="status">Saving section…</p> : null}
      {error || creation.error ? <p role="alert">{error ?? creation.error}</p> : null}
      {creation.state === 'unknown' ? <p role="status">Section creation is not confirmed. <button type="button" onClick={() => void save(true)}>Retry</button></p> : null}
      <div onClickCapture={event => { keyboardOpen.current = event.detail === 0; }}><BotRoster model={roster} place={place} onSelect={navigation.select} hostName={hostName} groupActions={groupActions}
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
        trailing={compact ? <WorkbenchModeSwitch mode={navigation.mode} onChange={navigation.setMode} /> : undefined} />
      {!unavailable ? availabilityNotice : null}
      {descriptor ? <SessionConversationMount mode="bot" active={visible && showConversation} descriptor={{ ...descriptor, props: { ...descriptor.props, visible: visible && showConversation, active: visible && showConversation, fixedDisplayMode: 'content' } }} />
        : !selected.loading && !selected.error ? <p className="lab-bot-empty">{place?.kind === 'section' ? 'No bot selected. Choose a bot from this group.' : 'Choose a bot to continue its conversation.'}</p> : null}
    </section>
  </main>;
}
