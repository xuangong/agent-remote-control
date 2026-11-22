/**
 * Quote flow: the decisions between selecting messages and the quote landing in another session.
 *
 * Contract
 * - Pure. The shell reads the selection and the Windows, creates the excerpt, stores it and reveals the target.
 * - `quoteStart`: a request for a view that does not own the selection, or whose selection is busy creating its
 *   destination, does nothing (`ignore`). A selection made in an earlier timeline epoch is refused (`reloaded`): the
 *   messages it names may be gone.
 * - `quoteCreationId`: a quote into a new session creates it once; a retry reuses the id of the attempt that failed.
 * - `quoteSessionOptions`: the new session stands where the source stands (its directory and, unless `dsh`, its model).
 * - `quoteLanding`: a quote into the open Window reveals its target; a quote into another Window leaves a notice that
 *   names the session and the Window and offers to open it, and does not move the person.
 */
import type { QuoteSelection } from './quote-selection.js';
import type { CreateSessionOptions } from '../../kernel/directory-client.js';
import { translator, type Translate } from '@orchardworks/agent-client';

export const reloadedConversationMessage = 'This conversation was reloaded. Select the messages again.';

export function quoteStart(selection: QuoteSelection | undefined, viewId: string, epoch: string | null): 'ignore' | 'reloaded' | 'ready' {
  if (selection?.viewId !== viewId || selection.busy) return 'ignore';
  return epoch !== selection.epoch ? 'reloaded' : 'ready';
}

export function quoteCreationId(selection: Pick<QuoteSelection, 'creationId'>, fresh: () => string): string {
  return selection.creationId ?? fresh();
}

export function quoteSessionOptions(agent: { readonly cwd?: string | null; readonly model?: string | null }, providerId: string): CreateSessionOptions {
  return { ...(agent.cwd ? { cwd: agent.cwd } : {}), ...(agent.model && providerId !== 'dsh' ? { model: agent.model } : {}) };
}

export type QuoteLanding = { readonly kind: 'reveal' } | { readonly kind: 'notice'; readonly message: string; readonly windowId: string };

export function quoteLanding(windows: readonly { readonly id: string; readonly title: string; readonly current: boolean; readonly views: readonly { readonly viewId: string; readonly title: string }[] }[], target: { readonly windowId: string }, destination: string, t: Translate = translator('en')): QuoteLanding {
  const window = windows.find(item => item.id === target.windowId);
  if (!window || window.current) return { kind: 'reveal' };
  const title = window.views.find(item => item.viewId === destination)?.title ?? t('client.quote.theSession');
  return { kind: 'notice', windowId: target.windowId, message: t('client.quote.landed', { title, window: window.title }) };
}
