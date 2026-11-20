import { isBotView, type WindowView } from '@orchardworks/agent-remote-protocol';
import { translator, type Translate } from '@orchardworks/agent-client';

/**
 * How a Window reads in its row, its toolbar and the command palette: its bots, and how many are open once any is folded
 * or asleep (an asleep bot stands folded in a Window). A Window without bots counts its views.
 */
export function windowSummary(views: readonly WindowView[], asleep: (viewId: string) => boolean = () => false, t: Translate = translator('en')): string {
  const bots = views.filter(isBotView);
  if (!bots.length) return views.length ? t('windows.summary.views', { count: views.length }) : t('windows.summary.empty');
  const open = bots.filter(view => !view.collapsed && !asleep(view.id)).length;
  const total = t('windows.summary.bots', { count: bots.length });
  return open === bots.length ? total : t('windows.summary.botsOpen', { bots: total, open });
}
