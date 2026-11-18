/**
 * What the client needs to know about the page that hosts it: whether it is hidden, when it becomes visible, and when it comes back after
 * a suspension. The headless client reads the page only through this port; a browser binding installs one over `window` and `document`,
 * and a page-less host (a command line, a test) keeps the inert default, for which the page is always visible and never suspends.
 */
export interface PageLifecycle {
  hidden(): boolean;
  /** `change` runs each time the page turns hidden or visible. */
  watchVisibility(change: () => void): () => void;
  /** `resume` runs when the page is visible again or the network is back, with how long the page was suspended; `suspend` when it is hidden or leaves. */
  watchResume(resume: (suspendedMs: number) => void, suspend?: () => void): () => void;
}

/** The two event sources of a browser page. */
export interface PageEvents {
  readonly window: EventTarget;
  readonly document: EventTarget & { readonly visibilityState: string };
}

const inert: PageLifecycle = { hidden: () => false, watchVisibility: () => () => undefined, watchResume: () => () => undefined };
let installed: PageLifecycle = inert;

/** Installs the page of this process; no argument restores the inert default. */
export function installPageLifecycle(lifecycle?: PageLifecycle): void { installed = lifecycle ?? inert; }
export const pageHidden = (): boolean => installed.hidden();
export const watchPageVisibility = (change: () => void): (() => void) => installed.watchVisibility(change);
/** A suspended browser may retain a WebSocket object after its network connection dies. */
export const watchPageResume = (resume: (suspendedMs: number) => void, suspend?: () => void): (() => void) => installed.watchResume(resume, suspend);

/** The lifecycle of a page described by its events. A restore from the back-forward cache counts as a suspension. */
export function createPageLifecycle({ window: windowEvents, document: documentEvents }: PageEvents): PageLifecycle {
  const hiddenNow = () => documentEvents.visibilityState === 'hidden';
  return {
    hidden: hiddenNow,
    watchVisibility(change) {
      documentEvents.addEventListener('visibilitychange', change);
      return () => documentEvents.removeEventListener('visibilitychange', change);
    },
    watchResume(resume, suspend) {
      let hidden = hiddenNow();
      let hiddenAt = hidden ? Date.now() : undefined;
      const hide = () => {
        if (hidden) return;
        hiddenAt = Date.now(); hidden = true; suspend?.();
      };
      const visible = () => {
        if (hiddenNow()) { hide(); return; }
        if (hidden) {
          const duration = hiddenAt === undefined ? Infinity : Math.max(0, Date.now() - hiddenAt);
          hidden = false; hiddenAt = undefined; resume(duration);
        }
      };
      const show = (event: Event) => {
        if ((event as Event & { persisted?: boolean }).persisted && !hidden) { hidden = true; hiddenAt = undefined; }
        visible();
      };
      const online = () => { if (!hiddenNow()) resume(0); };
      documentEvents.addEventListener('visibilitychange', visible);
      windowEvents.addEventListener('pagehide', hide);
      windowEvents.addEventListener('pageshow', show);
      windowEvents.addEventListener('online', online);
      return () => {
        documentEvents.removeEventListener('visibilitychange', visible);
        windowEvents.removeEventListener('pagehide', hide);
        windowEvents.removeEventListener('pageshow', show);
        windowEvents.removeEventListener('online', online);
      };
    },
  };
}
