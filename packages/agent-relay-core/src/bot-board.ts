/**
 * A standing bot's board (bots design 6.1), kept on its inbox: items with who does them, the brief they were handed away with and
 * where they stand, and a plan note. Every write names the version it read; a stale write is applied field by field and says what it
 * overwrote. A change to an item another bot holds is told to that bot, written from the record.
 */
import { BOARD_BRIEF_LIMIT, BOARD_FIELDS, BOARD_ITEM_LIMIT, BOARD_KEEP_MS, BOARD_OPEN_LIMIT, BOARD_PLAN_CHANGES, boardItemOpen, itemChangedText, type Board, type BoardField, type BoardItem,
  type BoardLink, type BoardStatus, type TeamInbox } from '@orchardworks/agent-remote-protocol';
import type { Assistant, AssistantBrokerPorts } from './assistants.js';
import type { BotInboxes } from './inboxes.js';
import type { BotWork } from './bot-work.js';

const fail = (message: string): never => { throw new Error(message); };
type Writer = BoardItem['updatedBy'];
/** What a writer sets of one item; `assignee` is a bot id or self, resolved by the caller. A new item has no key. */
export interface ItemEdit { key?: number; version?: number; title?: string; status?: BoardStatus; assignee?: string; parent?: number | null; links?: BoardLink[]; brief?: string; result?: string }
export interface PlanEdit { text: string; why: string; version?: number }
/** A line the Relay queues for a bot, written from the record; `key` makes a repeated notice queue once. */
export interface ItemNotice { to: string; text: string; key: unknown[] }
export interface Overwrite { field: BoardField | 'plan'; was: unknown; by: Writer }
export interface ItemResult { key: number; version: number; overwrote?: Overwrite[] }
export interface BoardWrite { items: ItemResult[]; plan?: { version: number; overwrote?: Overwrite[] }; notices: ItemNotice[] }

/** Items finished for a week are dropped, and the oldest finished ones beyond the board's size. */
function prune(board: Board, now: number): void {
  board.items = board.items.filter(item => boardItemOpen(item.status) || now - (item.closedAt ?? item.updatedAt) < BOARD_KEEP_MS);
  while (board.items.length > BOARD_ITEM_LIMIT) {
    const oldest = board.items.filter(item => !boardItemOpen(item.status)).sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))[0];
    if (!oldest) return;
    board.items.splice(board.items.indexOf(oldest), 1);
  }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** The board of an inbox, created empty, with its finished items of a week ago dropped. */
export function boardOf(box: TeamInbox, now: number): Board {
  const board = box.board ??= { next: 1, items: [] };
  prune(board, now);
  return board;
}
const openCount = (board: Board) => board.items.filter(item => boardItemOpen(item.status)).length;
const itemOf = (board: Board, key: number) => board.items.find(item => item.key === key) ?? fail(`No item ${key} on the board; read it with board.`);
const view = (item: BoardItem, field: BoardField): unknown => field === 'parent' ? item.parent ?? null : item[field] ?? null;

/** Sets the fields of an edit that differ from the item, as one write: the version and who and when. Returns the fields it changed. */
function apply(item: BoardItem, edit: ItemEdit, by: Writer, now: number): BoardField[] {
  const changed: BoardField[] = [];
  for (const field of BOARD_FIELDS) {
    const value = edit[field];
    if (value === undefined || same(value, view(item, field))) continue;
    if (field === 'parent' && value === null) delete item.parent; else (item as Record<string, unknown>)[field] = value;
    changed.push(field);
  }
  if (!changed.length) return changed;
  item.version++; item.updatedBy = by; item.updatedAt = now;
  for (const field of changed) item.changedAt[field] = item.version;
  if (boardItemOpen(item.status)) delete item.closedAt; else item.closedAt ??= now;
  return changed;
}
function checkParent(board: Board, key: number, parent: number | null | undefined): void {
  if (parent === undefined || parent === null) return;
  for (let at: number | undefined = parent; at !== undefined; at = itemOf(board, at).parent) if (at === key) fail('An item cannot be its own ancestor.');
}
/** What the item's assignee reads about a change, and what its old assignee does when the item moves on. */
function notices(board: string, before: Pick<BoardItem, 'title' | 'assignee' | 'status' | 'brief'> | undefined, item: BoardItem): ItemNotice[] {
  const told = (to: string, what: string): ItemNotice => ({ to, text: itemChangedText({ title: item.title, what }), key: ['item-notice', board, item.key, item.version, to] });
  const out: ItemNotice[] = [];
  if (before && before.assignee !== item.assignee && before.assignee !== 'self') out.push(told(before.assignee, 'reassigned'));
  if (item.assignee === 'self') return out;
  if (!before || before.assignee !== item.assignee) { out.push(told(item.assignee, 'assigned to you')); return out; }
  const what = [...before.title !== item.title ? [`retitled to "${item.title}"`] : [], ...before.brief !== item.brief ? ['brief changed'] : [],
    ...before.status !== item.status && item.status === 'cancelled' ? ['cancelled'] : []];
  if (what.length) out.push(told(item.assignee, what.join('; ')));
  return out;
}
const snapshot = (item: BoardItem) => ({ title: item.title, assignee: item.assignee, status: item.status, brief: item.brief });

/**
 * Writes items and the plan of one board in a change. `own`: the writer is the temporary bot the item was created for, which writes
 * its status, links and result and may leave out the version, being the only writer of them.
 */
export function writeBoard(box: TeamInbox, edits: readonly ItemEdit[] | undefined, plan: PlanEdit | undefined, by: Writer, now: number, own?: number): BoardWrite {
  const board = boardOf(box, now), written: ItemResult[] = [], told: ItemNotice[] = [], owner = box.botId;
  for (const edit of edits ?? []) {
    if (own !== undefined) {
      if ((edit.key ?? own) !== own) fail('A temporary bot writes the item it was created for, and no other.');
      if (edit.title !== undefined || edit.assignee !== undefined || edit.parent !== undefined || edit.brief !== undefined) fail('A temporary bot writes only the status, links and result of its item.');
    }
    if (edit.key === undefined && own === undefined) {
      const title = edit.title ?? fail('A new item needs a title.');
      if (edit.version !== undefined) fail('A new item names no version; name a key to change one.');
      if (openCount(board) >= BOARD_OPEN_LIMIT && boardItemOpen(edit.status ?? 'open')) fail(`Your board holds ${BOARD_OPEN_LIMIT} open items; finish or cancel one first.`);
      const key = board.next++;
      checkParent(board, key, edit.parent);
      const item: BoardItem = { key, title, status: 'open', assignee: 'self', links: [], version: 1, changedAt: {}, updatedBy: by, updatedAt: now };
      board.items.push(item);
      apply(item, { ...edit, version: undefined }, by, now);
      // The item is one write whatever fields it had.
      item.version = 1; item.changedAt = {};
      written.push({ key, version: 1 }); told.push(...notices(owner, undefined, item));
      continue;
    }
    const item = itemOf(board, edit.key ?? own!);
    const read = edit.version ?? (own !== undefined ? item.version : fail(`Name the version of item ${item.key} you read (it is ${item.version} now).`));
    const before = snapshot(item), reopening = !boardItemOpen(item.status) && edit.status !== undefined && boardItemOpen(edit.status);
    if (reopening && openCount(board) >= BOARD_OPEN_LIMIT) fail(`Your board holds ${BOARD_OPEN_LIMIT} open items; finish or cancel one first.`);
    checkParent(board, item.key, edit.parent);
    // A write based on an older version replaces what changed since by field, and says so.
    const overwrote = read < item.version
      ? BOARD_FIELDS.filter(field => edit[field] !== undefined && (item.changedAt[field] ?? 0) > read && !same(edit[field], view(item, field))).map((field): Overwrite => ({ field, was: view(item, field), by: item.updatedBy }))
      : [];
    apply(item, edit, by, now);
    written.push({ key: item.key, version: item.version, ...(overwrote.length ? { overwrote } : {}) });
    told.push(...notices(owner, before, item));
  }
  let planned: BoardWrite['plan'];
  if (plan) {
    const current = board.plan, read = plan.version ?? 0;
    const overwrote: Overwrite[] = current && read < current.version && current.text !== plan.text ? [{ field: 'plan', was: current.text, by: current.changes.at(-1)?.by ?? by }] : [];
    const changes = [...current?.changes ?? [], { at: now, by, why: plan.why }].slice(-BOARD_PLAN_CHANGES);
    board.plan = { text: plan.text, version: (current?.version ?? 0) + 1, changes };
    planned = { version: board.plan.version, ...(overwrote.length ? { overwrote } : {}) };
  }
  return { items: written, ...(planned ? { plan: planned } : {}), notices: told };
}

/**
 * The assignee and brief an item takes when work is handed away with it (create_bot or message naming it): the item is working while
 * its assignee does it. The brief is the first one the assignee got, so a follow-up leaves it. Returns what to tell the former assignee.
 */
export function assignItem(box: TeamInbox, key: number, assignee: string, brief: string, by: Writer, now: number): ItemNotice[] {
  const board = boardOf(box, now), item = board.items.find(entry => entry.key === key);
  if (!item) return [];
  const before = snapshot(item), moved = before.assignee !== assignee;
  const edit: ItemEdit = { assignee, ...moved || !item.brief ? { brief: brief.slice(0, BOARD_BRIEF_LIMIT) } : {}, ...item.status === 'open' ? { status: 'working' as const } : {} };
  if (moved) delete item.report;
  apply(item, edit, by, now);
  return before.assignee !== 'self' && moved ? [{ to: before.assignee, text: itemChangedText({ title: item.title, what: 'reassigned' }), key: ['item-notice', box.botId, key, item.version, before.assignee] }] : [];
}
/** The open item an assignee holds: the one named, or the only one it holds. */
export function heldItem(board: Board | undefined, assignee: string, key: number | undefined): BoardItem | undefined {
  const mine = (board?.items ?? []).filter(item => item.assignee === assignee && boardItemOpen(item.status));
  return key !== undefined ? mine.find(item => item.key === key) : mine.length === 1 ? mine[0] : undefined;
}
/** What a report of one status does to the item whose assignee made it, when the assignee is the chief's own temporary bot. */
const reported: Record<string, { status: BoardStatus; result?: true } | undefined> = { progress: { status: 'working' }, needs_input: { status: 'waiting' }, done: { status: 'done', result: true }, failed: { status: 'open' } };
/**
 * An assignee reported on its item: the line is its latest report, written from the record. The status and the result follow only
 * when `worker` (the assignee is the temporary bot created for the item, the chief's own worker); a standing bot's chief decides.
 * The item is the one named, or the only open one the assignee holds.
 */
export function reportItem(box: TeamInbox, assignee: string, key: number | undefined, status: string | undefined, text: string, worker: boolean, now: number): BoardItem | undefined {
  const item = heldItem(boardOf(box, now), assignee, key);
  if (!item) return undefined;
  item.report = `${status === 'failed' ? 'Failed: ' : ''}${text}`.slice(0, 300);
  const next = worker && status ? reported[status] : undefined;
  const changed = next ? apply(item, { status: next.status, ...next.result ? { result: text.slice(0, 300) } : {} }, assignee, now) : [];
  // The report is a write of its own when it changes nothing else.
  if (!changed.length) { item.version++; item.updatedBy = assignee; item.updatedAt = now; }
  return item;
}

/** The board's calls on the inbox of a standing bot. */
export class BotBoard {
  constructor(private readonly broker: AssistantBrokerPorts, private readonly inboxes: BotInboxes, private readonly work: BotWork) {}
  private async change<T>(bot: Assistant, update: (box: TeamInbox, now: number) => T): Promise<T> {
    const value = await this.broker.change(teams => {
      const now = this.broker.ports.now(), inbox = this.inboxes.prepare(teams, bot, now) ?? fail('Team capacity reached.');
      const result = update(inbox.inbox!, now);
      this.work.syncTimer(inbox, now);
      inbox.revision++; inbox.updatedAt = now;
      return result;
    });
    this.work.arm();
    return value;
  }
  /** The bot's board as it stands, with finished items of a week ago left out. */
  read(bot: Assistant): Board | undefined {
    const board = this.inboxes.current(this.broker.ports.read(), bot)?.inbox?.board;
    return board && { ...board, items: board.items.filter(item => boardItemOpen(item.status) || this.broker.ports.now() - (item.closedAt ?? item.updatedAt) < BOARD_KEEP_MS) };
  }
  write(bot: Assistant, edits: readonly ItemEdit[] | undefined, plan: PlanEdit | undefined, by: Writer, own?: number): Promise<BoardWrite> {
    return this.change(bot, (box, now) => writeBoard(box, edits, plan, by, now, own));
  }
  /** Work handed away names its item: the item records the assignee and the brief. */
  assign(bot: Assistant, key: number, assignee: string, brief: string, by: Writer): Promise<ItemNotice[]> {
    return this.change(bot, (box, now) => assignItem(box, key, assignee, brief, by, now));
  }
  report(bot: Assistant, assignee: string, key: number | undefined, status: string | undefined, text: string, worker: boolean): Promise<void> {
    return this.change(bot, (box, now) => { reportItem(box, assignee, key, status, text, worker, now); });
  }
}
