import { createPageLifecycle, installPageLifecycle, type PageEvents } from '../page-lifecycle.js';

/** A page made of two event targets, so a test hides it, shows it, suspends it and brings it back without a DOM. */
export interface StubbedPage extends PageEvents {
  readonly window: EventTarget;
  readonly document: EventTarget & { visibilityState: 'visible' | 'hidden' };
  /** Back to a visible page; listeners are the code under test's to remove. */
  reset(): void;
}

/** Installs a stub page as the client's page and returns it. */
export function stubBrowserPage(initial: 'visible' | 'hidden' = 'visible'): StubbedPage {
  let state = initial;
  const document = new EventTarget() as StubbedPage['document'];
  Object.defineProperty(document, 'visibilityState', { configurable: true, enumerable: true, get: () => state, set: (value: 'visible' | 'hidden') => { state = value; } });
  const page: StubbedPage = { window: new EventTarget(), document, reset: () => { state = initial; } };
  installPageLifecycle(createPageLifecycle(page));
  return page;
}

/** Installs the client's page from the `window` and `document` a test has stubbed as globals. */
export function installStubbedGlobalPage(): void {
  installPageLifecycle(createPageLifecycle({ window: globalThis.window as unknown as EventTarget, document: globalThis.document as unknown as PageEvents['document'] }));
}

export { installPageLifecycle };
