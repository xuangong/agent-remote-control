import { useEffect, useState } from 'react';
import { hasBotAppearance, hasWindowAppearance, type WindowGroupOperation } from '@orchardworks/agent-remote-protocol';
import { FloatingPanel, Pill } from '@orchardworks/agent-client-web/primitives';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { SharedFeedsSnapshot } from '../../shared-feeds.js';
import { appendedRank, type BotRosterModel, type BotRow, type BotSection } from '../../bot-roster.js';
import { botPlaceForTile, type BotPlace } from '../../workbench-mode.js';
import type { useWindowWorkspace } from '../../hooks/useWindowWorkspace.js';
import { BotMember } from '../BotRoster.js';
import { useSharedRoster } from '../shared-roster.js';
import { Menu, type MenuEntry } from '../../ui/Menu.js';

type Workspace = Pick<ReturnType<typeof useWindowWorkspace>, 'readGroup' | 'operateGroup' | 'groups'>;

/**
 * The directory of every assistant of the account, by Window group in catalog order: the resting and the hidden ones are
 * listed and marked, a hidden one can be shown in Chats, and each group has its actions. Choosing an assistant opens it in Chats.
 */
export function AssistantDirectory({ model, project, workspace, focusGroup, hostName = id => id, onOpen, onNew }: {
  model: BotRosterModel; project?(shared: SharedFeedsSnapshot): BotRosterModel; workspace: Workspace;
  /** The group the address names; the directory scrolls to it. */
  focusGroup?: string; hostName?(hostId: string): string; onOpen(place: BotPlace): void; onNew?(): void;
}) {
  const t = useTranslate();
  const sections = useSharedRoster(model, project).sections;
  const [error, setError] = useState<string>();
  useEffect(() => { if (focusGroup) document.getElementById(`directory-group-${focusGroup}`)?.scrollIntoView?.({ block: 'start' }); }, [focusGroup, sections.length]);

  async function operate(groupId: string, operation: WindowGroupOperation | undefined) {
    if (!operation) return true;
    setError(undefined);
    try { await workspace.operateGroup(groupId, operation); return true; }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return false; }
  }
  /** A hidden assistant, or one of a group hidden in Chats, shows there again: the same change opening a tile in Bot mode makes. */
  const showInChats = (row: BotRow) => {
    const group = workspace.readGroup(row.groupId);
    return operate(row.groupId, group ? botPlaceForTile(group, row.viewId, appendedRank(workspace.groups))?.edit : undefined);
  };
  async function open(row: BotRow) {
    if (row.hiddenInChats && !await showInChats(row)) return;
    onOpen({ kind: 'bot', groupId: row.groupId, viewId: row.viewId });
  }
  function groupActions(section: BotSection): MenuEntry[] {
    const group = workspace.readGroup(section.groupId);
    if (!group) return [];
    return [
      hasWindowAppearance(group)
        ? { label: t('navigation.hideInWindow'), icon: 'eye-off', disabled: !hasBotAppearance(group), onSelect: () => void operate(section.groupId, { type: 'window.remove' }) }
        : { label: t('navigation.showInWindow'), icon: 'sidebar', onSelect: () => void operate(section.groupId, { type: 'window.add' }) },
      hasBotAppearance(group)
        ? { label: t('navigation.hideInBot'), icon: 'eye-off', disabled: !hasWindowAppearance(group), onSelect: () => void operate(section.groupId, { type: 'bots.hide' }) }
        : { label: t('navigation.showInChats'), icon: 'chat', onSelect: () => void operate(section.groupId, group.bots ? { type: 'bots.show' } : { type: 'batch', operations: [{ type: 'bots.add', rank: appendedRank(workspace.groups) }, { type: 'bots.show' }] }) },
    ];
  }
  return <FloatingPanel as="section" label={t('navigation.directoryTitle')} className="lab-directory">
    <header className="lab-directory-head">
      <h1>{t('navigation.directoryTitle')}</h1>
      {onNew ? <Pill variant="primary" onClick={onNew}>{t('assistants.new')}</Pill> : null}
    </header>
    {error ? <p className="lab-bot-notice" role="alert">{error}</p> : null}
    {!sections.length ? <p className="lab-bot-empty">{t('navigation.directoryEmpty')}</p> : null}
    <div className="lab-directory-groups">
      {sections.map(section => <section key={section.groupId} id={`directory-group-${section.groupId}`} className="lab-bot-section lab-directory-group" aria-labelledby={`directory-title-${section.groupId}`} data-focus={focusGroup === section.groupId || undefined}>
        <div className="lab-bot-section-head">
          <h2 id={`directory-title-${section.groupId}`}>{section.title}{section.hiddenInChats ? <span className="lab-bot-role">{t('navigation.groupHiddenInChats')}</span> : null}{section.unread ? <span className="lab-bot-section-unread" role="img" aria-label={t('assistants.unread')} /> : null}</h2>
          <Menu label={t('assistants.groupActions', { group: section.title })} items={groupActions(section)} />
        </div>
        {!section.rows.length ? <p className="lab-bot-empty">{t('navigation.directoryGroupEmpty')}</p> : null}
        {section.rows.map(row => <BotMember key={row.viewId} row={row} current={false} compact={false} hostName={hostName} onSelect={() => void open(row)}
          marks={<>{row.details.asleep ? <span className="lab-bot-role">{t('navigation.resting')}</span> : null}{row.hiddenInChats && !section.hiddenInChats ? <span className="lab-bot-role">{t('navigation.hiddenInChats')}</span> : null}</>}
          extra={row.hiddenInChats && !section.hiddenInChats ? <Pill className="lab-directory-show" onClick={() => void showInChats(row)}>{t('navigation.showInChats')}</Pill> : undefined} />)}
      </section>)}
    </div>
  </FloatingPanel>;
}
