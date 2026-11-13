import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { applyWindowOperation, type WindowBotDetails, type WindowGroupOperation } from '@orchardworks/agent-remote-protocol';
import type { useWindowWorkspace } from '../hooks/useWindowWorkspace.js';
import { appendedRank, type BotRow, type BotSection } from '../bot-roster.js';
import type { BotPlace } from '../workbench-mode.js';
import type { MenuEntry } from '../ui/Menu.js';
import { Sheet } from '../ui/Sheet.js';
import { Button } from '../ui/Button.js';
import { BotPicture, botDisplayName } from './BotRoster.js';

/** Where a bot runs, for its Info sheet. App knows the Hosts, the providers and the bot's handoff chain. */
export interface BotInfo {
  host: string; online?: boolean; provider: string;
  /** The providers of the bot's earlier sessions, oldest first. */
  earlier: readonly string[];
}
type OpenSheet = { kind: 'info' | 'label' | 'remove'; row: BotRow; groupTitle: string };
type Workspace = Pick<ReturnType<typeof useWindowWorkspace>, 'readGroup' | 'operateGroup' | 'groups'>;
const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** “Its session keeps running.”, then what closes with the bot: “Edge cases” and 1 Ask close with it. */
function removalMessage(closing: { asks: number; bots: string[] } | undefined): string {
  const items = [...closing?.bots.map(name => `“${name}”`) ?? [], ...closing?.asks ? [plural(closing.asks, 'Ask', 'Asks')] : []];
  if (!items.length) return 'Its session keeps running.';
  const list = items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
  const single = items.length === 1 && !(closing!.asks > 1 && !closing!.bots.length);
  return `Its session keeps running. ${list} ${single ? 'closes' : 'close'} with it.`;
}
/** What closes with a bot: its Asks and the views attached to it or closing with it, such as a Team leader's members. */
function closingWith(workspace: Workspace, row: BotRow): { asks: number; bots: string[] } {
  const group = workspace.readGroup(row.groupId);
  // The bot may already be gone (removed here or on another device) while its sheet is still closing.
  if (!group?.window.views.some(view => view.id === row.viewId)) return { asks: 0, bots: [] };
  const staying = new Set(applyWindowOperation(group.window, { type: 'view.close', viewId: row.viewId }).views.map(view => view.id));
  const leaving = group.window.views.filter(view => !staying.has(view.id) && view.id !== row.viewId);
  return { asks: leaving.filter(view => view.feature?.kind === 'ask').length,
    bots: leaving.filter(view => view.feature?.kind !== 'ask' && view.binding).map(view => botDisplayName(view.binding!)) };
}

/**
 * A bot's own actions (Info, Label, Hide in Bot mode, Remove from group) and the group's way to show hidden bots again.
 * Every change is a group operation, shared by every device; a group formed from sessions gains its bot details in the same change.
 */
export function useBotActions({ scope, workspace, onSelect, onError, botInfo }: {
  scope: string; workspace: Workspace; onSelect(place: BotPlace): void; onError(error: string | undefined): void;
  botInfo?(place: { groupId: string; viewId: string }): BotInfo | undefined;
}) {
  const [open, setOpen] = useState<OpenSheet>();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; undo?(): Promise<void> }>();
  const currentScope = useRef(scope); currentScope.current = scope;
  useEffect(() => { setOpen(undefined); setNotice(undefined); setBusy(false); }, [scope]);

  async function run(groupId: string, operation: WindowGroupOperation): Promise<boolean> {
    const requestScope = scope; setBusy(true); onError(undefined);
    try { await workspace.operateGroup(groupId, operation); return true; }
    catch (reason) { if (currentScope.current === requestScope) onError(message(reason)); return false; }
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
    setNotice({ text: `Hidden in Bot mode: “${botDisplayName(row.binding)}” stays in its Window.`, undo: async () => {
      setNotice(undefined);
      const current = workspace.readGroup(row.groupId)?.bots?.members[row.viewId] ?? {};
      if (await update(row, without(current, 'hidden'))) onSelect({ kind: 'bot', groupId: row.groupId, viewId: row.viewId });
    } });
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

  function botMenu(row: BotRow, groupTitle: string): MenuEntry[] {
    return [
      { label: 'Info', icon: 'person', onSelect: () => setOpen({ kind: 'info', row, groupTitle }) },
      { label: 'Label…', icon: 'pencil', onSelect: () => { setDraft(row.details.label ?? ''); setOpen({ kind: 'label', row, groupTitle }); } },
      { kind: 'separator' },
      { label: 'Hide in Bot mode', icon: 'eye-off', onSelect: () => void hide(row) },
      { label: 'Remove from group…', icon: 'trash', destructive: true, onSelect: () => setOpen({ kind: 'remove', row, groupTitle }) },
    ];
  }
  function groupMenu(section: BotSection): MenuEntry[] {
    if (!section.hidden.length) return [];
    return [{ label: 'Show hidden bots', icon: 'list', onSelect: () => {
      const group = workspace.readGroup(section.groupId);
      if (!group?.bots) return;
      setNotice(undefined);
      void run(section.groupId, { type: 'batch', operations: section.hidden.map(viewId => ({ type: 'bot.update' as const, viewId, details: without(group.bots!.members[viewId] ?? {}, 'hidden') })) });
    } }];
  }

  const close = () => { if (!busy) setOpen(undefined); };
  const row = open?.row, name = row ? botDisplayName(row.binding) : '';
  const info = open?.kind === 'info' && row ? botInfo?.({ groupId: row.groupId, viewId: row.viewId }) : undefined;
  const closing = open?.kind === 'remove' && row ? closingWith(workspace, row) : undefined;
  const sheets: ReactNode = !open || !row ? null
    : open.kind === 'info' ? <Sheet open title={name} detent="content" onClose={close}>
      <div className="lab-bot-info-head">
        <BotPicture picture={row.details.picture} name={name} size={56} />
        {row.role || row.details.label ? <p className="lab-bot-name-line">{row.role ? <span className="lab-bot-role">{row.role}</span> : null}
          {row.details.label ? <span className="lab-bot-label">{row.details.label}</span> : null}</p> : null}
      </div>
      <dl className="lab-bot-info">
        <div><dt>Group</dt><dd>{open.groupTitle}</dd></div>
        <div><dt>Host</dt><dd>{info?.host ?? row.binding.hostId}{info?.online === false ? <small> · Offline</small> : null}</dd></div>
        <div><dt>Provider</dt><dd>{info?.provider ?? row.binding.providerId}</dd></div>
        {info?.earlier.length ? <div><dt>Earlier</dt><dd>{info.earlier.join(' → ')}</dd></div> : null}
      </dl>
    </Sheet>
    : open.kind === 'label' ? <Sheet open title="Label" detent="content" onClose={close}>
      <form className="lab-bot-sheet-form" onSubmit={event => void saveLabel(event, draft.trim() || undefined)}>
        <input aria-label="Label" autoFocus maxLength={120} placeholder="Reviewer, On call…" value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} />
        <p className="lab-sheet-note">{`Shown beside “${name}” in Bot mode on every device. The role tag stays.`}</p>
        <div className="lab-sheet-actions">
          {row.details.label ? <Button variant="plain" className="lab-sheet-leading" disabled={busy} onClick={event => void saveLabel(event, undefined)}>Remove label</Button> : null}
          <Button disabled={busy} onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !draft.trim() || draft.trim() === row.details.label} aria-busy={busy || undefined}>Save</Button>
        </div>
      </form>
    </Sheet>
    : <Sheet open title={`Remove “${name}” from “${open.groupTitle}”?`} detent="content" onClose={close}>
      <p className="lab-sheet-message">{removalMessage(closing)}</p>
      <div className="lab-sheet-actions">
        <Button disabled={busy} onClick={close}>Cancel</Button>
        <Button variant="destructive" disabled={busy} aria-busy={busy || undefined} onClick={() => void remove()}>Remove</Button>
      </div>
    </Sheet>;
  const noticeLine: ReactNode = notice ? <p className="lab-bot-notice" role="status">{notice.text}
    {notice.undo ? <button type="button" onClick={() => void notice.undo!()}>Undo</button> : null}</p> : null;
  return { botMenu, groupMenu, sheets, notice: noticeLine, clearNotice: () => setNotice(undefined) };
}
