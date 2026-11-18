import { pageHidden, watchPageVisibility } from '../page-lifecycle.js';
import { watchPagePolling } from './page-polling.js';

/**
 * The shared feed socket (the session channel that carries session states, reads, drafts and outbox) is the page's evidence that its Relay
 * view is live. When it reopens after a loss, whatever the page learned from lists in the meantime may be stale, so list loaders refetch.
 * While it stays open, becoming visible again refetches nothing.
 */
const listeners = new Set<() => void>();

/** Called by the channel pool each time the feed socket becomes ready again after it was lost. */
export function notifyFeedReopened(): void {
  for (const listener of [...listeners]) listener();
}

export function watchFeedReopen(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Refreshes when the feed reopens: at once for a visible page; for a hidden one, once when the page is shown again (the list is due). A page that
 * becomes visible with a live feed refreshes nothing.
 */
export function watchFeedRefresh(refresh: () => unknown): () => void {
  let due = false;
  const stopFeed = watchFeedReopen(() => { if (pageHidden()) due = true; else void refresh(); });
  const visible = () => { if (due && !pageHidden()) { due = false; void refresh(); } };
  const unwatch = watchPageVisibility(visible);
  return () => { stopFeed(); unwatch(); };
}

/**
 * A list loader's refresh schedule, and the only one: once now, every `intervalMs` while the page is visible (five minutes unless the list moves
 * faster), and when the feed socket reopens (`watchFeedRefresh`). A page that becomes visible with a live feed refetches nothing and restarts the interval.
 */
export function watchList(refresh: () => unknown, intervalMs = 300_000): () => void {
  const stopPolling = watchPagePolling(refresh, intervalMs);
  const stopFeed = watchFeedRefresh(refresh);
  return () => { stopPolling(); stopFeed(); };
}
