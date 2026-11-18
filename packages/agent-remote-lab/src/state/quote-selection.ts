/**
 * Quote selection: the messages a person is selecting to quote into another session, and the notice after quoting.
 *
 * Contract
 * - Pure reducer. One selection exists at a time, owned by one view and one timeline epoch.
 * - Selecting in the same view and epoch adds or removes keys; selecting in another view, or after the timeline was
 *   reloaded (a new epoch), starts a new selection and drops the old one with its progress and error.
 * - Selecting dismisses the notice of an earlier quote and clears the error.
 * - Creating a destination session marks the selection busy and remembers the creation id, so a retry reuses it.
 * - Events for a view that no longer owns the selection change nothing.
 * - A quote that succeeds clears the selection; one that fails keeps it, not busy, with the error.
 */
export interface QuoteSelection {
  readonly viewId: string;
  readonly epoch: string | null;
  readonly keys: ReadonlySet<string>;
  readonly creationId?: string;
  readonly busy?: boolean;
  readonly error?: string;
}

export interface QuoteNotice { readonly viewId: string; readonly message: string; readonly open?: () => Promise<void> }

export interface QuoteState { readonly selection?: QuoteSelection; readonly notice?: QuoteNotice }

export type QuoteEvent =
  | { readonly type: 'select'; readonly viewId: string; readonly epoch: string | null; readonly keys: Iterable<string>; readonly value: boolean }
  | { readonly type: 'cancel' }
  | { readonly type: 'notice.dismiss' }
  | { readonly type: 'creating'; readonly viewId: string; readonly creationId: string }
  | { readonly type: 'quoted'; readonly viewId: string; readonly notice?: QuoteNotice }
  | { readonly type: 'failed'; readonly viewId: string; readonly error: string };

export const noQuote: QuoteState = {};

export function reduceQuote(state: QuoteState, event: QuoteEvent): QuoteState {
  const current = state.selection;
  switch (event.type) {
    case 'select': {
      const same = current?.viewId === event.viewId && current.epoch === event.epoch;
      const keys = new Set(same ? current.keys : []);
      for (const key of event.keys) if (event.value) keys.add(key); else keys.delete(key);
      return { selection: { ...(same ? current : {}), viewId: event.viewId, epoch: event.epoch, keys, error: undefined } };
    }
    case 'cancel': return { ...state, selection: undefined };
    case 'notice.dismiss': return { ...state, notice: undefined };
    case 'creating': return current?.viewId === event.viewId ? { ...state, selection: { ...current, creationId: event.creationId, busy: true, error: undefined } } : state;
    case 'quoted': return { selection: current?.viewId === event.viewId ? undefined : current, ...(event.notice ? { notice: event.notice } : state.notice ? { notice: state.notice } : {}) };
    case 'failed': return current?.viewId === event.viewId ? { ...state, selection: { ...current, busy: false, error: event.error } } : state;
  }
}

/** The keys selected in a view of a timeline epoch, when that view owns the selection. */
export function selectedKeys(state: QuoteState, viewId: string, epoch: string | null): ReadonlySet<string> | undefined {
  const selection = state.selection;
  return selection?.viewId === viewId && selection.epoch === epoch ? selection.keys : undefined;
}
