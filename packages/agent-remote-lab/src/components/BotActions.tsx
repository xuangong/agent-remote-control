import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { BotPicture, WindowBotDetails, WindowGroupOperation } from '@orchardworks/agent-remote-protocol';
import { errorWords } from '@orchardworks/agent-client';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { useWindowWorkspace } from '../hooks/useWindowWorkspace.js';
import { appendedRank, type BotRow, type BotSection } from '../bot-roster.js';
import type { BotPlace } from '../workbench-mode.js';
import type { MenuEntry } from '../ui/Menu.js';
import { Sheet } from '@orchardworks/agent-client-web/primitives';
import { Button } from '../ui/Button.js';
import { RemoveBotSheet } from './RemoveBotSheet.js';

/** Where a bot runs, for its details. App knows the Hosts, the providers and the bot's handoff chain. */
export interface BotInfo {
  host: string; online?: boolean; provider: string;
  /** The providers of the bot's earlier sessions, oldest first. */
  earlier: readonly string[];
}
type OpenSheet = { kind: 'label' | 'remove'; row: BotRow; groupTitle: string };
type Workspace = Pick<ReturnType<typeof useWindowWorkspace>, 'readGroup' | 'operateGroup' | 'groups'>;
/**
 * A bot's own actions, on its name card (Label…, Sleep or Wake, Hide in Bot mode, Remove from group…), its avatar, and the
 * group's way to show hidden bots again. Every change is a group operation, shared by every device; a group formed from
 * sessions gains its bot details in the same change.
 */
export function useBotActions({ scope, workspace, onSelect, onError }: {
  scope: string; workspace: Workspace; onSelect(place: BotPlace): void; onError(error: string | undefined): void;
}) {
  const t = useTranslate();
  const [open, setOpen] = useState<OpenSheet>();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; undo?(): Promise<void> }>();
  const currentScope = useRef(scope); currentScope.current = scope;
  useEffect(() => { setOpen(undefined); setNotice(undefined); setBusy(false); }, [scope]);

  async function run(groupId: string, operation: WindowGroupOperation): Promise<boolean> {
    const requestScope = scope; setBusy(true); onError(undefined);
    try { await workspace.operateGroup(groupId, operation); return true; }
    catch (reason) { if (currentScope.current === requestScope) onError(errorWords(reason, t, 'navigation.botActions.failed')); return false; }
    finally { if (currentScope.current === requestScope) setBusy(false); }
  }
  function update(row: Pick<BotRow, 'groupId' | 'viewId'>, details: WindowBotDetails) {
    const change = { type: 'bot.update', viewId: row.viewId, details } as const;
    return run(row.groupId, workspace.readGroup(row.groupId)?.bots ? change
      : { type: 'batch', operations: [{ type: 'bots.add', rank: appendedRank(workspace.groups) }, change] });
  }
  const without = <K extends keyof WindowBotDetails>(details: WindowBotDetails, key: K): WindowBotDetails => {
    const { [key]: _removed, ...rest } = details; return rest;
  };
  async function hide(row: BotRow) {
    setNotice(undefined);
    if (!await update(row, { ...row.details, hidden: true })) return;
    onSelect({ kind: 'section', groupId: row.groupId });
    setNotice({ text: t('navigation.botActions.hiddenNotice', { name: row.name }), undo: async () => {
      setNotice(undefined);
      const current = workspace.readGroup(row.groupId)?.bots?.members[row.viewId] ?? {};
      if (await update(row, without(current, 'hidden'))) onSelect({ kind: 'bot', groupId: row.groupId, viewId: row.viewId });
    } });
  }
  /** Sleep is quiet on every device: the bot's conversation is released until someone opens it, which wakes it. */
  async function sleep(row: BotRow) {
    setNotice(undefined);
    if (!await update(row, { ...row.details, asleep: true })) return;
    onSelect({ kind: 'section', groupId: row.groupId });
    setNotice({ text: t('navigation.botActions.asleepNotice', { name: row.name }), undo: async () => {
      setNotice(undefined);
      if (await wake(row)) onSelect({ kind: 'bot', groupId: row.groupId, viewId: row.viewId });
    } });
  }
  function wake(row: Pick<BotRow, 'groupId' | 'viewId'>) {
    const current = workspace.readGroup(row.groupId)?.bots?.members[row.viewId] ?? {};
    return current.asleep ? update(row, without(current, 'asleep')) : Promise.resolve(true);
  }
  async function saveLabel(event: Pick<FormEvent, 'preventDefault'>, label: string | undefined) {
    event.preventDefault();
    if (!open) return;
    const current = workspace.readGroup(open.row.groupId)?.bots?.members[open.row.viewId] ?? {};
    if (await update(open.row, label ? { ...current, label } : without(current, 'label'))) setOpen(undefined);
  }
  async function remove() {
    if (!open) return;
    const { row } = open;
    if (await run(row.groupId, { type: 'view.close', viewId: row.viewId })) { setOpen(undefined); onSelect({ kind: 'section', groupId: row.groupId }); }
  }

  /** The actions of a bot's name card; asleep, it offers Wake in place of Sleep. */
  function cardActions(row: BotRow, groupTitle: string): MenuEntry[] {
    return [
      { label: t('card.label'), icon: 'pencil', onSelect: () => { setDraft(row.details.label ?? ''); setOpen({ kind: 'label', row, groupTitle }); } },
      row.details.asleep ? { label: t('card.wake'), icon: 'moon', onSelect: () => void wake(row) } : { label: t('card.sleep'), icon: 'moon', onSelect: () => void sleep(row) },
      { label: t('card.hide'), icon: 'eye-off', onSelect: () => void hide(row) },
      { label: t('card.remove'), icon: 'trash', destructive: true, onSelect: () => setOpen({ kind: 'remove', row, groupTitle }) },
    ];
  }
  /** A bot's new avatar, for every device. */
  function setPicture(row: Pick<BotRow, 'groupId' | 'viewId'>, picture: BotPicture) {
    const current = workspace.readGroup(row.groupId)?.bots?.members[row.viewId] ?? {};
    void update(row, { ...current, picture });
  }
  /** The assistant's own name, for every device; an empty name keeps the one it has. */
  function rename(row: Pick<BotRow, 'groupId' | 'viewId'>, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const current = workspace.readGroup(row.groupId)?.bots?.members[row.viewId] ?? {};
    void update(row, { ...current, name: trimmed });
  }
  function groupMenu(section: BotSection): MenuEntry[] {
    if (!section.hidden.length) return [];
    return [{ label: t('navigation.botActions.showHidden'), icon: 'list', onSelect: () => {
      const group = workspace.readGroup(section.groupId);
      if (!group?.bots) return;
      setNotice(undefined);
      void run(section.groupId, { type: 'batch', operations: section.hidden.map(viewId => ({ type: 'bot.update' as const, viewId, details: without(group.bots!.members[viewId] ?? {}, 'hidden') })) });
    } }];
  }

  const close = () => { if (!busy) setOpen(undefined); };
  const row = open?.row, name = row?.name ?? '';
  const sheets: ReactNode = !open || !row ? null
    : open.kind === 'label' ? <Sheet open title={t('navigation.botActions.label')} detent="content" onClose={close}>
      <form className="lab-bot-sheet-form" onSubmit={event => void saveLabel(event, draft.trim() || undefined)}>
        <input aria-label={t('navigation.botActions.label')} autoFocus maxLength={120} placeholder={t('navigation.botActions.labelPlaceholder')} value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} />
        <p className="lab-sheet-note">{t('navigation.botActions.labelNote', { name })}</p>
        <div className="lab-sheet-actions">
          {row.details.label ? <Button variant="plain" className="lab-sheet-leading" disabled={busy} onClick={event => void saveLabel(event, undefined)}>{t('navigation.botActions.removeLabel')}</Button> : null}
          <Button disabled={busy} onClick={close}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={busy || !draft.trim() || draft.trim() === row.details.label} aria-busy={busy || undefined}>{t('common.save')}</Button>
        </div>
      </form>
    </Sheet>
    : <RemoveBotSheet name={name} groupTitle={open.groupTitle} window={workspace.readGroup(row.groupId)?.window} viewId={row.viewId} busy={busy}
      onCancel={close} onRemove={() => void remove()} />;
  const noticeLine: ReactNode = notice ? <p className="lab-bot-notice" role="status">{notice.text}
    {notice.undo ? <button type="button" onClick={() => void notice.undo!()}>{t('navigation.botActions.undo')}</button> : null}</p> : null;
  return { cardActions, setPicture, rename, groupMenu, wake, sheets, notice: noticeLine, clearNotice: () => setNotice(undefined) };
}
