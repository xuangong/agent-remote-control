import { useContext, useId, useState, type FormEvent } from 'react';
import { errorWords } from '@orchardworks/agent-client';
import { BOARD_BRIEF_LIMIT, BOARD_PLAN_LIMIT, boardItemOpen, type Board, type BoardItemEdit, type BoardItem, type BoardOverwrite, type BoardWriteResult } from '@orchardworks/agent-remote-protocol';
import { LocaleContext, useTranslate } from '@orchardworks/agent-client-web/react';
import { dateLocale, replyTime } from '../../kernel/reply-time.js';
import { Icon } from '../../ui/Icon.js';
import { boardTree, itemEdit, type BoardChoice, type BoardNode } from './board-model.js';

type Translate = ReturnType<typeof useTranslate>;
const STATUSES = ['open', 'working', 'waiting', 'done', 'cancelled'] as const;
const clip = (text: string) => text.length > 60 ? `${text.slice(0, 59)}…` : text;

/**
 * A standing bot's board (bots plan 8g): the plan note with its changes and whys, then the open items as a tree by parent, finished
 * ones folded under Done. An item assigned to a standing staff bot opens into that bot's board, read only, one level. The person edits
 * items and the plan note in place; a stale edit says what it replaced.
 */
export function BoardList({ choice }: { choice: BoardChoice }) {
  const t = useTranslate();
  const [notice, setNotice] = useState<readonly string[]>([]), [error, setError] = useState<string>(), [pending, setPending] = useState(false);
  const save = choice.save && (async (edit: Parameters<NonNullable<BoardChoice['save']>>[0]) => {
    setPending(true); setError(undefined); setNotice([]);
    try { const result = await choice.save!(edit); setNotice(overwritten(result, choice, t)); return true; }
    catch (reason) { setError(errorWords(reason, t, 'details.boardSaveFailed')); return false; }
    finally { setPending(false); }
  });
  return <div className="lab-assistant-sessions lab-board">
    <PlanNote board={choice.board} choice={choice} save={save} pending={pending} />
    <BoardTree board={choice.board} choice={choice} ownerName={t('details.boardSelf')} save={save} pending={pending} depth={0} />
    {save ? <NewItem board={choice.board} choice={choice} ownerName={t('details.boardSelf')} save={save} pending={pending} /> : null}
    {notice.map(line => <p key={line} role="status" className="lab-board-notice">{line}</p>)}
    {error ? <p role="alert" className="lab-board-notice">{error}</p> : null}
  </div>;
}

type Save = ((edit: Parameters<NonNullable<BoardChoice['save']>>[0]) => Promise<boolean>) | undefined;

/** What a stale edit replaced, one line each, from the Relay's answer. */
function overwritten(result: BoardWriteResult, choice: BoardChoice, t: Translate): string[] {
  const words = (value: unknown, field: BoardOverwrite['field']): string => field === 'status' ? t(`details.boardStatus.${value as BoardItem['status']}`)
    : field === 'assignee' ? (value === 'self' ? t('details.boardSelf') : choice.name(String(value))) : field === 'links' ? String((value as unknown[]).length) : clip(String(value ?? ''));
  return [...result.items.flatMap(item => item.overwrote ?? []), ...result.plan?.overwrote ?? []].map(over => t('details.boardOverwrote', {
    field: t(`details.boardField.${over.field}`), was: `“${words(over.was, over.field)}”`, by: over.by === 'person' ? t('details.boardYou') : choice.name(over.by) }));
}

/** A new item the person adds: a title, and optionally who does it, a brief and the item it belongs under. */
function NewItem({ board, choice, ownerName, save, pending }: { board: Board; choice: BoardChoice; ownerName: string; save: NonNullable<Save>; pending: boolean }) {
  const t = useTranslate();
  const [form, setForm] = useState<{ title: string; assignee: string; brief: string; parent: string }>();
  const parents = board.items.filter(item => boardItemOpen(item.status));
  async function submit(event: FormEvent) {
    event.preventDefault();
    const title = form?.title.trim(), brief = form?.brief.trim();
    if (!form || !title) return;
    const item: BoardItemEdit = { title, ...form.assignee !== 'self' ? { assignee: form.assignee } : {}, ...brief ? { brief } : {}, ...form.parent ? { parent: Number(form.parent) } : {} };
    if (await save({ items: [item] })) setForm(undefined);
  }
  if (!form) return <button type="button" className="lab-assistant-action" onClick={() => setForm({ title: '', assignee: 'self', brief: '', parent: '' })}>{t('details.boardNew')}</button>;
  return <form onSubmit={event => void submit(event)} className="lab-board-form" aria-label={t('details.boardNew')} data-board-new>
    <label>{t('details.boardTitle')}<input maxLength={120} value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} /></label>
    <label>{t('details.boardAssign')}<select value={form.assignee} onChange={event => setForm({ ...form, assignee: event.target.value })}>
      {[{ botId: 'self', name: ownerName }, ...choice.choices].map(bot => <option key={bot.botId} value={bot.botId}>{bot.name}</option>)}</select></label>
    <label>{t('details.boardBriefField')}<textarea rows={3} maxLength={BOARD_BRIEF_LIMIT} value={form.brief} onChange={event => setForm({ ...form, brief: event.target.value })} /></label>
    {parents.length ? <label>{t('details.boardParent')}<select value={form.parent} onChange={event => setForm({ ...form, parent: event.target.value })}>
      <option value="">{t('details.boardNoParent')}</option>{parents.map(item => <option key={item.key} value={item.key}>{item.title}</option>)}</select></label> : null}
    <span className="lab-assistant-task-actions">
      <button type="submit" className="lab-assistant-action" disabled={pending || !form.title.trim()}>{t('details.boardCreate')}</button>
      <button type="button" className="lab-assistant-action" onClick={() => setForm(undefined)}>{t('details.boardDiscard')}</button>
    </span>
  </form>;
}

function PlanNote({ board, choice, save, pending }: { board: Board; choice: BoardChoice; save: Save; pending: boolean }) {
  const t = useTranslate();
  const locale = useContext(LocaleContext);
  const id = useId();
  const [editing, setEditing] = useState<{ text: string; why: string }>();
  const plan = board.plan;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!editing || !save || !editing.text.trim() || !editing.why.trim()) return;
    if (await save({ plan: { text: editing.text.trim(), why: editing.why.trim(), ...plan ? { version: plan.version } : {} } })) setEditing(undefined);
  }
  return <section className="lab-board-plan" aria-label={t('details.boardPlan')} data-board-plan>
    <h4>{t('details.boardPlan')}</h4>
    {editing ? <form onSubmit={event => void submit(event)} className="lab-board-form">
      <label htmlFor={`${id}-text`}>{t('details.boardPlanText')}</label>
      <textarea id={`${id}-text`} rows={4} maxLength={BOARD_PLAN_LIMIT} value={editing.text} onChange={event => setEditing({ ...editing, text: event.target.value })} />
      <label htmlFor={`${id}-why`}>{t('details.boardPlanWhy')}</label>
      <input id={`${id}-why`} maxLength={200} value={editing.why} onChange={event => setEditing({ ...editing, why: event.target.value })} />
      <span className="lab-assistant-task-actions">
        <button type="submit" className="lab-assistant-action" disabled={pending || !editing.text.trim() || !editing.why.trim()}>{t('details.boardPlanSave')}</button>
        <button type="button" className="lab-assistant-action" onClick={() => setEditing(undefined)}>{t('details.boardDiscard')}</button>
      </span>
    </form> : <>
      {plan ? <p className="lab-board-text">{plan.text}</p> : <p className="lab-assistant-empty">{t('details.boardPlanEmpty')}</p>}
      {plan?.changes.length ? <details className="lab-board-changes"><summary>{t('details.boardPlanChanges', { count: plan.changes.length })}</summary>
        <ol>{[...plan.changes].reverse().map((change, index) => <li key={index}>{t('details.boardChange', { time: replyTime(change.at, undefined, dateLocale(locale), t), by: change.by === 'person' ? t('details.boardYou') : choice.name(change.by), why: change.why })}</li>)}</ol></details> : null}
      {save ? <button type="button" className="lab-assistant-action" onClick={() => setEditing({ text: plan?.text ?? '', why: '' })}>{plan ? t('details.boardPlanEdit') : t('details.boardPlanAdd')}</button> : null}
    </>}
  </section>;
}

interface TreeProps { board: Board; choice: BoardChoice; ownerName: string; save: Save; pending: boolean; depth: number }

function BoardTree({ board, choice, ownerName, save, pending, depth }: TreeProps) {
  const t = useTranslate();
  const { roots, finished } = boardTree(board.items);
  const rows = (nodes: readonly BoardNode[]) => <ul className="lab-assistant-chain lab-board-items">{nodes.map(node => <ItemRow key={node.item.key} node={node} choice={choice} ownerName={ownerName} save={save} pending={pending} depth={depth} />)}</ul>;
  return <>
    {roots.length ? rows(roots) : <p className="lab-assistant-empty">{t('details.boardEmpty')}</p>}
    {finished.length ? <details className="lab-board-done"><summary>{t('details.boardDone', { count: finished.length })}</summary>
      {rows(finished.map(item => ({ item, children: [] })))}</details> : null}
  </>;
}

function ItemRow({ node, choice, ownerName, save, pending, depth }: Omit<TreeProps, 'board'> & { node: BoardNode }) {
  const t = useTranslate();
  const locale = useContext(LocaleContext);
  const { item } = node;
  const [open, setOpen] = useState(false), [editing, setEditing] = useState<{ title: string; status: BoardItem['status']; assignee: string; brief: string }>();
  const doer = item.assignee === 'self' ? undefined : item.assignee;
  const doerName = doer ? choice.name(doer) : ownerName;
  const staff = depth === 0 && doer ? choice.staffBoard?.(doer) : undefined;
  const form = editing && itemEdit(item, editing);
  const finished = item.status === 'done' || item.status === 'cancelled';
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (form && save && await save({ items: [form] })) setEditing(undefined);
  }
  const assignees = [{ botId: 'self', name: ownerName }, ...choice.choices, ...doer && !choice.choices.some(bot => bot.botId === doer) ? [{ botId: doer, name: doerName }] : []];
  return <li data-board-item={item.key} data-status={item.status}>
    <div className="lab-assistant-session lab-board-line">
      <span className="lab-assistant-session-title lab-board-title">{item.title}</span>
      <small className="lab-board-status" data-status={item.status}>{t(`details.boardStatus.${item.status}`)}</small>
      <button type="button" className="lab-assistant-session-toggle" aria-expanded={open} aria-label={t('details.boardMore', { title: item.title })} onClick={() => setOpen(value => !value)}><Icon name="chevron-down" size={14} /></button>
    </div>
    <p className="lab-board-meta">{t('details.boardAssignee', { name: doerName })} · {replyTime(item.updatedAt, undefined, dateLocale(locale), t)}</p>
    {item.links.length ? <ul className="lab-board-links" aria-label={t('details.boardLinks')}>{item.links.map((link, index) => <li key={index}><code>{link.kind}: {link.kind === 'bot' ? choice.name(link.value) : link.value}</code></li>)}</ul> : null}
    {item.result ? <p className="lab-board-text">{t('details.boardResult', { text: item.result })}</p> : null}
    {item.report ? <p className="lab-board-text">{t('details.boardReport', { text: item.report })}</p> : null}
    {open ? <div className="lab-board-detail">
      <p className="lab-board-text">{item.brief ? t('details.boardBrief', { text: item.brief }) : t('details.boardNoBrief')}</p>
      {editing ? <form onSubmit={event => void submit(event)} className="lab-board-form">
        <label>{t('details.boardTitle')}<input maxLength={120} value={editing.title} onChange={event => setEditing({ ...editing, title: event.target.value })} /></label>
        <label>{t('details.boardStatusField')}<select value={editing.status} onChange={event => setEditing({ ...editing, status: event.target.value as BoardItem['status'] })}>
          {STATUSES.map(status => <option key={status} value={status}>{t(`details.boardStatus.${status}`)}</option>)}</select></label>
        <label>{t('details.boardAssign')}<select value={editing.assignee} onChange={event => setEditing({ ...editing, assignee: event.target.value })}>
          {assignees.map(bot => <option key={bot.botId} value={bot.botId}>{bot.name}</option>)}</select></label>
        <label>{t('details.boardBriefField')}<textarea rows={3} maxLength={BOARD_BRIEF_LIMIT} value={editing.brief} onChange={event => setEditing({ ...editing, brief: event.target.value })} /></label>
        <span className="lab-assistant-task-actions">
          <button type="submit" className="lab-assistant-action" disabled={pending || !form}>{t('details.boardSave')}</button>
          <button type="button" className="lab-assistant-action" onClick={() => setEditing(undefined)}>{t('details.boardDiscard')}</button>
        </span>
      </form> : <span className="lab-assistant-task-actions">
        {doer && choice.canOpen?.(doer) ? <button type="button" className="lab-assistant-action" onClick={() => choice.open?.(doer)}>{t('details.boardOpenDoer', { name: doerName })}</button> : null}
        {save ? <button type="button" className="lab-assistant-action" onClick={() => setEditing({ title: item.title, status: item.status, assignee: item.assignee, brief: item.brief ?? '' })}>{t('details.boardEdit')}</button> : null}
        {save && !finished ? <button type="button" className="lab-assistant-action" disabled={pending} onClick={() => void save({ items: [{ key: item.key, version: item.version, status: 'cancelled' }] })}>{t('details.boardCancel')}</button> : null}
      </span>}
      {doer && depth === 0 ? <section className="lab-board-staff" aria-label={t('details.boardStaff', { name: doerName })} data-staff-board={doer}>
        <h4>{t('details.boardStaff', { name: doerName })}</h4>
        {staff ? <>
          <PlanNote board={staff} choice={choice} save={undefined} pending={false} />
          <BoardTree board={staff} choice={choice} ownerName={doerName} save={undefined} pending={false} depth={1} />
        </> : <p className="lab-assistant-empty">{t('details.boardStaffEmpty', { name: doerName })}</p>}
      </section> : null}
    </div> : null}
    {node.children.length ? <ul className="lab-assistant-chain lab-board-items lab-board-children">{node.children.map(child => <ItemRow key={child.item.key} node={child} choice={choice} ownerName={ownerName} save={save} pending={pending} depth={depth} />)}</ul> : null}
  </li>;
}
