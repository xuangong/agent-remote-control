import { isBotView, type WindowView } from '@orchardworks/agent-remote-protocol';

const count = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;

/**
 * How a Window reads in its row, its toolbar and the command palette: its bots, and how many are open once any is folded
 * or asleep (an asleep bot stands folded in a Window). A Window without bots counts its views.
 */
export function windowSummary(views: readonly WindowView[], asleep: (viewId: string) => boolean = () => false): string {
  const bots = views.filter(isBotView);
  if (!bots.length) return views.length ? count(views.length, 'view', 'views') : 'Empty';
  const open = bots.filter(view => !view.collapsed && !asleep(view.id)).length;
  return open === bots.length ? count(bots.length, 'bot', 'bots') : `${count(bots.length, 'bot', 'bots')} · ${open} open`;
}
