import { boardItemOpen, type Board, type BoardItem, type BoardItemEdit, type BoardPlanEdit, type BoardWriteResult } from '@orchardworks/agent-remote-protocol';

/** The board of a standing bot as its details show and edit it. */
export interface BoardChoice {
  readonly board: Board;
  /** The name of a bot an item names as its assignee. */
  name(botId: string): string;
  /** The bots an item may be assigned to besides the bot itself. */
  readonly choices: readonly { readonly botId: string; readonly name: string }[];
  /** The read only board of a standing bot an item is assigned to. */
  staffBoard?(botId: string): Board | undefined;
  canOpen?(botId: string): boolean;
  open?(botId: string): void;
  /** Absent: the board is shown, never edited. */
  save?(edit: { items?: readonly BoardItemEdit[]; plan?: BoardPlanEdit }): Promise<BoardWriteResult>;
}

/** The open items as a tree by parent, and the finished ones apart. An open item whose parent is finished or gone stands at the top. */
export function boardTree(items: readonly BoardItem[]): { roots: readonly BoardNode[]; finished: readonly BoardItem[] } {
  const open = items.filter(item => boardItemOpen(item.status)).sort((a, b) => a.key - b.key), keys = new Set(open.map(item => item.key));
  const node = (item: BoardItem): BoardNode => ({ item, children: open.filter(child => child.parent === item.key).map(node) });
  return { roots: open.filter(item => item.parent === undefined || !keys.has(item.parent)).map(node),
    finished: items.filter(item => !boardItemOpen(item.status)).sort((a, b) => (b.closedAt ?? b.updatedAt) - (a.closedAt ?? a.updatedAt)) };
}
export interface BoardNode { readonly item: BoardItem; readonly children: readonly BoardNode[] }

/** The fields of an item the person changed in the form, as the write the Relay takes; empty when nothing changed. */
export function itemEdit(item: BoardItem, form: { title: string; status: BoardItem['status']; assignee: string; brief: string }): BoardItemEdit | undefined {
  const title = form.title.trim(), brief = form.brief.trim();
  const fields: Partial<BoardItemEdit> = {
    ...title && title !== item.title ? { title } : {}, ...form.status !== item.status ? { status: form.status } : {},
    ...form.assignee !== item.assignee ? { assignee: form.assignee } : {}, ...brief && brief !== (item.brief ?? '') ? { brief } : {} };
  return Object.keys(fields).length ? { key: item.key, version: item.version, ...fields } : undefined;
}
