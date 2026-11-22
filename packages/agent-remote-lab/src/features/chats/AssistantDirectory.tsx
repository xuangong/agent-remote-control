import { errorWords } from '@orchardworks/agent-client';
import { useEffect, useState } from 'react';
import { hasBotAppearance, hasWindowAppearance, type WindowGroupOperation } from '@orchardworks/agent-remote-protocol';
import { FloatingPanel, Pill } from '@orchardworks/agent-client-web/primitives';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { SharedFeedsSnapshot } from '../../kernel/shared-feeds.js';
import type { BotRosterModel, BotRow } from '../../kernel/bot-roster.js';
import { groupSections, rankInPlace, type GroupSection } from '../../kernel/assistant-groups.js';
import { botPlaceForTile, type BotPlace } from '../../kernel/workbench-mode.js';
import type { useWindowWorkspace } from '../windows/useWindowWorkspace.js';
import { BotMember } from './BotRoster.js';
import { useSharedRoster } from './shared-roster.js';
import { useGroupActions } from './useGroupActions.js';
import { Menu, type MenuEntry } from '../../ui/Menu.js';
import { Icon } from '../../ui/Icon.js';

type Workspace = Parameters<typeof useGroupActions>[0]['workspace'] & Pick<ReturnType<typeof useWindowWorkspace>, 'readGroup' | 'operateGroup' | 'groups'>;

/**
 * The directory of every assistant of the account, by group in the groups' order with the default group last: the resting
 * and the hidden ones are listed and marked, a hidden one can be shown in Chats, each group has its actions (add, rename,
 * mute, notifications, order, and where it shows), and each assistant its own (pin, mute, move). Choosing an assistant
 * opens it in Chats.
 */
export function AssistantDirectory({ model, project, workspace, focusGroup, hostName = id => id, onOpen, onNew }: {
  model: BotRosterModel; project?(shared: SharedFeedsSnapshot): BotRosterModel; workspace: Workspace;
  /** The group the address names; the directory scrolls to it. */
  focusGroup?: string; hostName?(hostId: string): string; onOpen(place: BotPlace): void; onNew?(): void;
}) {
  const t = useTranslate();
  const defaultTitle = t('navigation.groups.default');
  const roster = useSharedRoster(model, project);
  const sections = groupSections(roster, workspace.groups, { order: 'roster', defaultTitle });
  const actions = useGroupActions({ workspace, defaultTitle });
  const [error, setError] = useState<string>();
  useEffect(() => { if (focusGroup) document.getElementById(`directory-group-${focusGroup}`)?.scrollIntoView?.({ block: 'start' }); }, [focusGroup, sections.length]);

  async function operate(groupId: string, operation: WindowGroupOperation | undefined) {
    if (!operation) return true;
    setError(undefined); actions.clear();
    try { await workspace.operateGroup(groupId, operation); return true; }
    catch (reason) { setError(errorWords(reason, t, 'windows.unsaved')); return false; }
  }
  /** A hidden assistant, or one of a group hidden in Chats, shows there again: the same change opening a tile in Bot mode makes. */
  const showInChats = (row: BotRow) => {
    const group = workspace.readGroup(row.groupId);
    return operate(row.groupId, group ? botPlaceForTile(group, row.viewId, rankInPlace(workspace.groups, row.groupId))?.edit : undefined);
  };
  async function open(row: BotRow) {
    if (row.hiddenInChats && !await showInChats(row)) return;
    onOpen({ kind: 'bot', groupId: row.groupId, viewId: row.viewId });
  }
  /** Where the group shows: Window mode and Chats, each of which it can leave while the other keeps it. */
  function appearanceActions(groupId: string): MenuEntry[] {
    const group = workspace.readGroup(groupId);
    if (!group) return [];
    return [
      hasWindowAppearance(group)
        ? { label: t('navigation.hideInWindow'), icon: 'eye-off', disabled: !hasBotAppearance(group), onSelect: () => void operate(groupId, { type: 'window.remove' }) }
        : { label: t('navigation.showInWindow'), icon: 'sidebar', onSelect: () => void operate(groupId, { type: 'window.add' }) },
      hasBotAppearance(group)
        ? { label: t('navigation.hideInBot'), icon: 'eye-off', disabled: !hasWindowAppearance(group), onSelect: () => void operate(groupId, { type: 'bots.hide' }) }
        : { label: t('navigation.showInChats'), icon: 'chat', onSelect: () => void operate(groupId, group.bots ? { type: 'bots.show' } : { type: 'batch', operations: [{ type: 'bots.add', rank: rankInPlace(workspace.groups, groupId) }, { type: 'bots.show' }] }) },
    ];
  }
  const groupMenu = (section: GroupSection): MenuEntry[] => section.groupId
    ? [...actions.groupMenu(section, sections), { kind: 'separator' }, ...appearanceActions(section.groupId)] : [];
  const notice = error ?? actions.error;
  return <FloatingPanel as="section" label={t('navigation.directoryTitle')} className="lab-directory">
    <header className="lab-directory-head">
      <h1>{t('navigation.directoryTitle')}</h1>
      <Pill onClick={actions.newGroup}>{t('navigation.groups.new')}</Pill>
      {onNew ? <Pill variant="primary" onClick={onNew}>{t('assistants.new')}</Pill> : null}
    </header>
    {notice ? <p className="lab-bot-notice" role="alert">{notice}</p> : actions.notice ? <p className="lab-bot-notice" role="status">{actions.notice}</p> : null}
    {!sections.length ? <p className="lab-bot-empty">{t('navigation.directoryEmpty')}</p> : null}
    <div className="lab-directory-groups">
      {sections.map(section => { const key = section.groupId ?? 'default';
        return <section key={key} id={`directory-group-${key}`} className="lab-bot-section lab-directory-group" aria-labelledby={`directory-title-${key}`}
          data-focus={!!section.groupId && focusGroup === section.groupId || undefined} data-default-group={!section.groupId || undefined}>
          <div className="lab-bot-section-head">
            <h2 id={`directory-title-${key}`}>{section.title}
              {section.hiddenInChats ? <span className="lab-bot-role">{t('navigation.groupHiddenInChats')}</span> : null}
              {section.muted ? <span className="lab-bot-muted" role="img" aria-label={t('navigation.groups.muted')}><Icon name="bell-off" size={14} /></span> : null}
              {section.unread ? <span className="lab-bot-section-unread" role="img" aria-label={t('assistants.unread')} /> : null}</h2>
            {section.groupId ? <Menu label={t('assistants.groupActions', { group: section.title })} items={groupMenu(section)} /> : null}
          </div>
          {!section.rows.length ? <p className="lab-bot-empty">{t('navigation.directoryGroupEmpty')}</p> : null}
          {section.rows.map(row => <BotMember key={`${row.groupId}/${row.viewId}`} row={row} current={false} compact={false} hostName={hostName} onSelect={() => void open(row)}
            marks={<>{row.details.asleep ? <span className="lab-bot-role">{t('navigation.resting')}</span> : null}{row.hiddenInChats && !section.hiddenInChats ? <span className="lab-bot-role">{t('navigation.hiddenInChats')}</span> : null}</>}
            extra={<span className="lab-directory-row-actions">
              {row.hiddenInChats && !section.hiddenInChats ? <Pill className="lab-directory-show" onClick={() => void showInChats(row)}>{t('navigation.showInChats')}</Pill> : null}
              <Menu label={t('card.more', { name: row.name })} items={actions.assistantMenu(row)} />
            </span>} />)}
        </section>; })}
    </div>
    {actions.sheets(sections.flatMap(section => section.rows))}
  </FloatingPanel>;
}
