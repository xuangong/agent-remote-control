/**
 * Quote targets: the views a set of selected messages can be quoted into.
 *
 * Contract
 * - Pure. The catalog is every Window the device knows plus the open one, each once, with the open Window first.
 * - A view qualifies when it holds a session that is not the source (by view and by session), is not a history or Ask
 *   child, and is an ordinary session or a Team conversation.
 * - Windows other than the open one appear only when they have a qualifying view.
 */
import type { WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { parseWindowFeature } from '../../kernel/window-feature-views.js';
import { sessionKey } from '../../kernel/session-tree.js';
import { translator, type Translate } from '@orchardworks/agent-client';

export interface QuoteTargetView { readonly viewId: string; readonly title: string; readonly detail: string }
export interface QuoteTargetWindow { readonly id: string; readonly title: string; readonly current: boolean; readonly views: readonly QuoteTargetView[] }

const placement = { primary: 'client.quote.placementMain', dock: 'client.quote.placementDock', float: 'client.quote.placementFloat', attached: 'client.quote.placementSide' } as const;

export function quoteTargets(
  known: readonly WorkspaceWindow[], open: WorkspaceWindow | undefined,
  source: { readonly viewId: string; readonly session: Parameters<typeof sessionKey>[0] },
  t: Translate = translator('en'),
): QuoteTargetWindow[] {
  const catalog = [...new Map([...known, ...(open ? [open] : [])].map(window => [window.id, window])).values()];
  return catalog.map(window => ({
    id: window.id, title: window.title || t('client.quote.untitledWindow'), current: window.id === open?.id,
    views: window.views.filter(view => {
      const feature = parseWindowFeature(view.feature);
      return view.id !== source.viewId && !!view.binding && view.binding.sessionIntent !== 'history' && !view.binding.parentNativeSessionId
        && (!feature || feature.kind === 'team') && sessionKey(view.binding) !== sessionKey(source.session);
    }).map(view => ({ viewId: view.id, title: view.binding!.title || t('client.quote.untitledSession'), detail: t(placement[view.placement]) })),
  })).filter(window => window.current || window.views.length).sort((a, b) => Number(b.current) - Number(a.current));
}
