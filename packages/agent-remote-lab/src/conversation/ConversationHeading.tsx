// A conversation's heading in its four modes: inline (its own heading), toolbar (hidden; its tools go to the timeline), assistant
// (the assistant view's top bar is the heading, so none here) and tile (the assistant's header, with the tile's details panel).
import type { ReactNode } from 'react';
import type { AgentStatus } from '@orchardworks/agent-remote-protocol';
import type { SessionFacts, SessionNotice } from '@orchardworks/agent-client';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { SessionHeading } from './SessionHeading.js';
import { SessionHeadingActions, SessionHeadingActionsPresentationContext } from './SessionHeadingActions.js';
import { TileHeader } from './assistant/TileHeader.js';
import { IconButton } from '../ui/IconButton.js';
import type { ConversationHeadingMode, SessionWorkbenchProps } from './session-workbench-props.js';

/** The tile's details panel: open or closed, its element id, and how to toggle it. */
export interface TileDetails { open: boolean; id: string; setOpen(open: boolean | ((open: boolean) => boolean)): void }

export function ConversationHeading({ mode, assistant, conversationPath, sessionManager, headingStart, workspaceLink, viewOptions, headingContext, attributionToggle, attributionDetails,
  activity, activityLabel, host, notice, titled, displayScope, tileDetails, searchSlotRef }: {
  mode: ConversationHeadingMode; assistant: SessionWorkbenchProps['assistant']; conversationPath?: ReactNode; sessionManager?: ReactNode; headingStart?: ReactNode;
  workspaceLink?: ReactNode; viewOptions: ReactNode; headingContext?: ReactNode;
  /** The attributions' toggle and their details, as `SessionAttributions` gives them. */
  attributionToggle: ReactNode; attributionDetails: ReactNode;
  activity: AgentStatus | undefined; activityLabel: string; host?: SessionFacts['host']; notice?: SessionNotice;
  /** The view has a replica or a session to show: its title says Conversation rather than Ready. */
  titled: boolean; displayScope?: string; tileDetails: TileDetails;
  /** Where the timeline's search trigger goes in an inline heading or a tile's menu. */
  searchSlotRef(node: HTMLSpanElement | null): void;
}) {
  const t = useTranslate();
  if (mode === 'assistant') return null;
  const name = assistant?.name ?? t('conversation.assistant');
  return <div className="lab-workbench-heading-group" hidden={mode === 'toolbar' && !headingContext && !attributionDetails}>
    {mode === 'tile' ? <TileHeader name={name} avatar={assistant?.avatar} title={conversationPath} {...(assistant?.session ? { session: assistant.session } : {})}
      facts={{ activity: activity ?? 'unknown', ...(host ? { host } : {}), asleep: false, waitingToSend: false, ...(notice ? { notice } : {}) }}
      detailsOpen={tileDetails.open} detailsId={tileDetails.id} onToggleDetails={() => tileDetails.setOpen(open => !open)}
      // One ⋯ menu holds the tile's controls: its details, search, Info, star, close and the session's own actions.
      menu={<SessionHeadingActions alwaysCollapsed sessionKey={displayScope}><SessionHeadingActionsPresentationContext.Provider value="inline">
        <IconButton icon="person" className="lab-tile-details-toggle" label={t('details.open', { name })} aria-expanded={tileDetails.open}
          aria-controls={tileDetails.id} onClick={() => tileDetails.setOpen(open => !open)} />
        <span className="lab-heading-search-slot" ref={searchSlotRef} />{attributionToggle}{sessionManager}
      </SessionHeadingActionsPresentationContext.Provider></SessionHeadingActions>} />
    : <SessionHeading hidden={mode === 'toolbar'}
      leading={mode === 'inline' ? <>{headingStart}{workspaceLink}{viewOptions}<span className="lab-heading-search-slot" ref={searchSlotRef} /></> : undefined}
      trailing={mode === 'inline' ? <>{sessionManager}<span className="lab-conversation-status">{activityLabel}</span></> : undefined}>
        {conversationPath}
        <h2 hidden={!!conversationPath} className="agent-session-title" data-session-status={activity}>{titled ? t('assistants.conversation') : t('composer.view.ready')}</h2>
        {mode === 'inline' ? attributionToggle : null}
    </SessionHeading>}
    {attributionDetails}
    {headingContext}
  </div>;
}

/** Where a tile's assistant details open over the window on a wider screen; a phone opens them as a sheet instead. */
export function TileDetailsPanel({ tileDetails, slotRef }: { tileDetails: TileDetails; slotRef(node: HTMLElement | null): void }) {
  const t = useTranslate();
  return <aside ref={slotRef} id={tileDetails.id} className="lab-tile-details orchard-panel" aria-label={t('details.title')} hidden={!tileDetails.open}>
    <header className="lab-assistant-details-head"><h2>{t('details.title')}</h2>
      <IconButton icon="close" label={t('details.close')} onClick={() => tileDetails.setOpen(false)} /></header>
  </aside>;
}
