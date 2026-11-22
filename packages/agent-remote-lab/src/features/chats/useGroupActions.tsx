import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { WindowGroupOperation } from '@orchardworks/agent-remote-protocol';
import { errorWords, type MessageKey } from '@orchardworks/agent-client';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { useWindowWorkspace } from '../windows/useWindowWorkspace.js';
import type { BotRow } from '../../kernel/bot-roster.js';
import { isPersonalGroup, orderedGroups, planMove, rankInPlace, reorderGroup, type AssistantPlace, type GroupNotifications, type GroupRankChange, type GroupSection } from '../../kernel/assistant-groups.js';
import { useAssistantNames } from '../../kernel/names-context.js';
import type { MenuEntry } from '../../ui/Menu.js';
import { AddAssistantsSheet, GroupNameSheet, GroupNotificationsSheet, MoveToGroupSheet } from './GroupSheets.js';

type Workspace = Pick<ReturnType<typeof useWindowWorkspace>, 'groups' | 'readGroup' | 'operateGroup' | 'rename' | 'createGroup' | 'moveAssistant' | 'deleteGroup'>;
type Open =
  | { kind: 'new' }
  | { kind: 'rename'; groupId: string; title: string }
  | { kind: 'notifications'; groupId: string; title: string }
  | { kind: 'add'; groupId: string; title: string }
  | { kind: 'move'; row: BotRow };

/**
 * The group operations of the directory and of an assistant's card (I5): New group, Rename, Mute, Notifications, Move up and
 * down, Add assistants; and for an assistant Pin, Mute, Move to group and Remove from group. Every change is a group
 * operation or a move the rules in `assistant-groups` plan, shared by every device. `onMoved` follows an assistant that moved.
 */
export function useGroupActions({ workspace, defaultTitle, onMoved }: { workspace: Workspace; defaultTitle: string; onMoved?(from: AssistantPlace, to: AssistantPlace): void }) {
  const t = useTranslate();
  const names = useAssistantNames();
  const [open, setOpen] = useState<Open>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  async function run(task: () => Promise<unknown>, failure: MessageKey): Promise<boolean> {
    setBusy(true); setError(undefined); setNotice(undefined);
    try { await task(); return true; }
    catch (reason) { if (mounted.current) setError(errorWords(reason, t, failure)); return false; }
    finally { if (mounted.current) setBusy(false); }
  }
  /** The operation on a group that needs a section first, which a group formed in Window mode gains in the same change. */
  const asSection = (groupId: string, operation: WindowGroupOperation): WindowGroupOperation => workspace.readGroup(groupId)?.bots ? operation
    : { type: 'batch', operations: [{ type: 'bots.add', rank: rankInPlace(workspace.groups, groupId) }, ...(operation.type === 'batch' ? operation.operations : [operation])] };
  const settings = (groupId: string, next: { muted: boolean; notifications: GroupNotifications }) => run(() => workspace.operateGroup(groupId,
    asSection(groupId, { type: 'section.settings', ...(next.muted ? { muted: true as const } : {}), ...(next.notifications === 'needs_you' ? { notifications: 'needs_you' as const } : {}) })), 'navigation.groups.failed');
  const groupSettings = (groupId: string) => {
    const bots = workspace.readGroup(groupId)?.bots;
    return { muted: !!bots?.muted, notifications: bots?.notifications === 'needs_you' ? 'needs_you' as const : 'all' as const };
  };
  /** The groups people made, as the directory lists them, where a group moves up or down. */
  const listed = (sections: readonly GroupSection[]) => sections.flatMap(section => { const group = section.groupId ? workspace.readGroup(section.groupId) : undefined; return group ? [group] : []; });

  /** A reorder's rank changes, one group at a time. */
  const reorder = (changes: readonly GroupRankChange[]) => run(async () => { for (const change of changes) await workspace.operateGroup(change.groupId, change.operation); }, 'navigation.groups.failed');
  function groupMenu(section: GroupSection, sections: readonly GroupSection[]): MenuEntry[] {
    const groupId = section.groupId;
    if (!groupId) return [];
    const current = groupSettings(groupId), ordered = listed(sections);
    const up = reorderGroup(workspace.groups, ordered, groupId, -1), down = reorderGroup(workspace.groups, ordered, groupId, 1);
    return [
      { label: t('navigation.groups.add'), icon: 'plus', onSelect: () => setOpen({ kind: 'add', groupId, title: section.title }) },
      { label: t('navigation.groups.rename'), icon: 'pencil', onSelect: () => setOpen({ kind: 'rename', groupId, title: section.title }) },
      current.muted ? { label: t('navigation.groups.unmute'), icon: 'bell', onSelect: () => void settings(groupId, { ...current, muted: false }) }
        : { label: t('navigation.groups.mute'), icon: 'bell-off', onSelect: () => void settings(groupId, { ...current, muted: true }) },
      { label: t('navigation.groups.notifications'), icon: 'bell', onSelect: () => setOpen({ kind: 'notifications', groupId, title: section.title }) },
      { label: t('navigation.groups.moveUp'), icon: 'arrow-up', disabled: !up, onSelect: () => { if (up) void reorder(up); } },
      { label: t('navigation.groups.moveDown'), icon: 'arrow-down', disabled: !down, onSelect: () => { if (down) void reorder(down); } },
      // Only an empty group is deleted here: its assistants move out first, so deleting never takes an assistant away.
      { label: t('navigation.groups.delete'), icon: 'trash', destructive: true, disabled: !!workspace.readGroup(groupId)?.window.views.length,
        onSelect: () => void run(() => workspace.deleteGroup(groupId), 'navigation.groups.failed') },
    ];
  }

  /** Replaces a bot's details on every device; a group formed in Window mode becomes a section in the same change. */
  function details(row: Pick<BotRow, 'groupId' | 'viewId'>, change: (details: NonNullable<BotRow['details']>) => BotRow['details']) {
    const current = workspace.readGroup(row.groupId)?.bots?.members[row.viewId] ?? {};
    return run(() => workspace.operateGroup(row.groupId, asSection(row.groupId, { type: 'bot.update', viewId: row.viewId, details: change(current) })), 'navigation.botActions.failed');
  }
  const without = (value: BotRow['details'], key: 'pinned' | 'muted') => { const { [key]: _removed, ...rest } = value; return rest; };
  /** The group an assistant is in, as people see it: absent for the default group. */
  const groupOf = (row: Pick<BotRow, 'groupId'>) => { const group = workspace.readGroup(row.groupId); return group && !isPersonalGroup(group) ? group : undefined; };

  async function move(row: BotRow, target: string | undefined) {
    const plan = planMove(workspace.groups, { groupId: row.groupId, viewId: row.viewId }, target, { names, newId: () => crypto.randomUUID() });
    if ('refused' in plan) { setError(t(`navigation.groups.refused.${plan.refused}`)); return false; }
    if (!plan.steps.length) return true;
    const title = target ? workspace.readGroup(target)?.window.title ?? defaultTitle : defaultTitle;
    if (!await run(() => workspace.moveAssistant(plan.steps), 'navigation.groups.moveFailed')) return false;
    if (mounted.current) setNotice(t('navigation.groups.moved', { name: row.name, group: title }));
    onMoved?.({ groupId: row.groupId, viewId: row.viewId }, plan.place);
    return true;
  }

  /** An assistant's own entries: Pin to top, Mute, Move to group and, in a group people made, Remove from it. */
  function assistantMenu(row: BotRow): MenuEntry[] {
    const group = groupOf(row);
    return [
      row.details.pinned ? { label: t('card.unpin'), icon: 'pin', onSelect: () => void details(row, current => without(current, 'pinned')) }
        : { label: t('card.pinTop'), icon: 'pin', onSelect: () => void details(row, current => ({ ...current, pinned: true })) },
      row.details.muted ? { label: t('card.unmute'), icon: 'bell', onSelect: () => void details(row, current => without(current, 'muted')) }
        : { label: t('card.mute'), icon: 'bell-off', onSelect: () => void details(row, current => ({ ...current, muted: true })) },
      { label: t('card.moveTo'), icon: 'folder', onSelect: () => setOpen({ kind: 'move', row }) },
      ...(group ? [{ label: t('card.removeFromGroup', { group: group.window.title }), icon: 'folder' as const, onSelect: () => void move(row, undefined) }] : []),
    ];
  }

  const close = () => { if (!busy) { setOpen(undefined); setError(undefined); } };
  /** The sheets, given every assistant (for Add assistants). */
  function sheets(everyone: readonly BotRow[]): ReactNode {
    if (!open) return null;
    if (open.kind === 'new') return <GroupNameSheet title={t('navigation.groups.new')} busy={busy} error={error} onClose={close}
      onSave={name => void run(() => workspace.createGroup(name), 'navigation.groups.failed').then(done => { if (done && mounted.current) setOpen(undefined); })} />;
    if (open.kind === 'rename') return <GroupNameSheet title={t('navigation.groups.renameTitle', { group: open.title })} initial={open.title} busy={busy} error={error} onClose={close}
      onSave={name => void run(async () => { await (await workspace.rename(open.groupId, name)).saved; }, 'navigation.groups.failed').then(done => { if (done && mounted.current) setOpen(undefined); })} />;
    if (open.kind === 'notifications') return <GroupNotificationsSheet group={open.title} {...groupSettings(open.groupId)} busy={busy} error={error} onClose={close}
      onChange={next => void settings(open.groupId, next)} />;
    if (open.kind === 'add') return <AddAssistantsSheet group={open.title} busy={busy} error={error} onClose={close}
      candidates={everyone.filter(row => row.groupId !== open.groupId)}
      groupTitle={row => groupOf(row)?.window.title ?? defaultTitle} onAdd={row => void move(row, open.groupId)} />;
    const row = open.row, here = groupOf(row)?.window.id;
    return <MoveToGroupSheet name={row.name} {...(here ? { current: here } : {})} busy={busy} error={error} onClose={close}
      choices={[...orderedGroups(workspace.groups).map(group => ({ id: group.window.id, title: group.window.title })), { title: defaultTitle }]}
      onMove={target => void move(row, target).then(done => { if (done && mounted.current) setOpen(undefined); })} />;
  }
  return { groupMenu, assistantMenu, sheets, newGroup: () => setOpen({ kind: 'new' }), move, busy, error, notice, clear: () => { setError(undefined); setNotice(undefined); } };
}
