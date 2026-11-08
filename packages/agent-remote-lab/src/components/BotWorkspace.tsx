import { useEffect, useRef, useState } from 'react';
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
import './bot-workspace.css';

export interface BotWorkspaceProps {
  visible: boolean; compact: boolean; scope: string;
  workspace: ReturnType<typeof useWindowWorkspace>;
  navigation: ReturnType<typeof useWorkbenchMode>;
  selected: ReturnType<typeof useBotWorkspace>;
  roster: BotRosterModel; directory: ReturnType<typeof useOtherSessions>;
  describeConversation(place: BotPlace): SessionSurfaceDescriptor | undefined;
}
export function BotWorkspace({ visible, compact, scope, workspace, navigation, selected, roster, directory, describeConversation }: BotWorkspaceProps) {
  const root = useVisualViewport(), heading = useRef<HTMLHeadingElement>(null), keyboardOpen = useRef(false), returning = useRef(false);
  const [creating, setCreating] = useState(false), [title, setTitle] = useState(''), [error, setError] = useState<string>();
  const currentScope = useRef(scope); currentScope.current = scope;
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
  function back() { returning.current = true; navigation.back(); }
  async function save(retry = false) {
    const requestScope = scope; setError(undefined);
    try {
      const id = await (retry ? workspace.retrySection() : workspace.createSection(title));
      if (currentScope.current !== requestScope) return;
      setCreating(false); setTitle(''); navigation.select({ kind: 'section', groupId: id });
    } catch (reason) { if (currentScope.current === requestScope) setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  return <main ref={root} className="lab-bot-workspace" hidden={!visible} {...(!visible ? { inert: '' } : {})} data-workbench-mode="bot" data-compact={compact || undefined}
    onPointerDown={event => event.stopPropagation()} onFocus={event => event.stopPropagation()}
    onKeyDown={event => {
      if (event.defaultPrevented || event.nativeEvent.isComposing || event.key !== 'Escape') return;
      if (creating) { event.preventDefault(); setCreating(false); }
      else if (compact && showConversation) { event.preventDefault(); back(); }
    }}>
    <aside className="lab-bot-roster" hidden={compact && showConversation}>
      <header className="lab-bot-roster-heading"><h1>Bots</h1><WorkbenchModeSwitch mode={navigation.mode} onChange={navigation.setMode} /></header>
      {unavailable ? availabilityNotice : null}
      {creating ? <form className="lab-bot-new-section" aria-label="New section" onSubmit={event => { event.preventDefault(); void save(); }}
        onKeyDown={event => { if (!event.nativeEvent.isComposing && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setCreating(false); } }}>
        <label>Section title<input autoFocus required maxLength={256} aria-label="Section title" disabled={saving || creation.state === 'unknown'} value={title} onChange={event => setTitle(event.target.value)} /></label>
        <div><button type="submit" disabled={saving || creation.state === 'unknown' || !title.trim()}>Save</button><button type="button" onClick={() => setCreating(false)}>Cancel</button></div>
      </form> : null}
      {saving ? <p role="status">Saving section…</p> : null}
      {error || creation.error ? <p role="alert">{error ?? creation.error}</p> : null}
      {creation.state === 'unknown' ? <p role="status">Section creation is not confirmed. <button type="button" onClick={() => void save(true)}>Retry</button></p> : null}
      <div onClickCapture={event => { keyboardOpen.current = event.detail === 0; }}><BotRoster model={roster} place={place} onSelect={navigation.select}
        onNewSection={() => { setCreating(true); setError(undefined); }} directoryControls={<div className="lab-bot-directory-controls">
          {directory.sources.map(source => <div key={source.id}><small>{source.hostId} · {source.providerId}</small>
            {!source.online ? <p>Host offline</p> : null}{source.loading ? <p role="status">Loading sessions…</p> : null}
            {source.error ? <p role="alert">{source.error}</p> : null}
            <button type="button" disabled={!source.online || source.loading} onClick={() => void directory.refresh(source.id)}>Refresh</button>
            {source.hasMore && !source.expired ? <button type="button" disabled={!source.online || source.loading} onClick={() => void directory.loadMore(source.id)}>Load more</button> : null}
          </div>)}
        </div>} /></div>
    </aside>
    <section className="lab-bot-conversation" aria-label="Bot conversation" hidden={compact && !showConversation}>
      <header className="lab-bot-conversation-toolbar">
        {compact ? <button type="button" aria-label="Back to bots" onClick={back}>Back</button> : null}
        <h2 ref={heading} tabIndex={-1}>{place?.kind === 'session' ? place.session.title : selected.view?.binding.title ?? descriptor?.props.target.title ?? selected.group?.window.title ?? 'Choose a bot'}</h2>
        {compact ? <WorkbenchModeSwitch mode={navigation.mode} onChange={navigation.setMode} /> : null}
      </header>
      {!unavailable ? availabilityNotice : null}
      {descriptor ? <SessionConversationMount mode="bot" active={visible && showConversation} descriptor={{ ...descriptor, props: { ...descriptor.props, visible: visible && showConversation, active: visible && showConversation, fixedDisplayMode: 'content' } }} />
        : !selected.loading && !selected.error ? <p className="lab-bot-empty">{place?.kind === 'section' ? 'No bot selected. Choose a bot from this section.' : 'Choose a bot to continue its conversation.'}</p> : null}
    </section>
  </main>;
}
