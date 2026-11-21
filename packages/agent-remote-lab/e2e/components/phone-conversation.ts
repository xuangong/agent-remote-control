import { expect, type Page } from '@playwright/test';

/**
 * A conversation on the real Window-mode Workbench (the `session-stars` fixture mounts the whole App on a stubbed transport) with a
 * `visualViewport` that a test drives: a browser has no software keyboard to open, so the test reports the keyboard as the visual
 * viewport a phone reports. The decisions of the viewport and keyboard hooks are unit tested; these specs check the layout that a
 * real browser makes of them.
 */
export const conversationFixture = '/e2e/fixtures/session-stars.html?switching&control';
/** The same page with thirty long rows, which the conversation keeps from its first render. */
export const longConversationFixture = '/e2e/fixtures/session-stars.html?long&control';

export async function openConversation(page: Page, size = { width: 390, height: 844 }, standalone = false, fixture = conversationFixture) {
  await page.setViewportSize(size);
  await page.addInitScript(({ size, standalone }) => {
    if (standalone) Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    const viewport = Object.assign(new EventTarget(), { width: size.width, height: size.height, offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  }, { size, standalone });
  await page.route('**/v1/favorites', route => route.fulfill({ json: { revision: 0, folders: [], stars: [] } }));
  await page.route('**/v1/remote/hosts/host/vscode-tunnel', route => route.fulfill({ json: { status: 'stopped', processAlive: false, revision: 0 } }));
  await page.route('**/v1/remote/hosts/host/previews', route => route.fulfill({ json: { revision: 1, registrations: [] } }));
  await page.goto(fixture);
  const input = page.getByTestId('prompt-input');
  await expect(input).toBeEnabled();
  return input;
}

/** The keyboard takes the lower part of the screen: the visual viewport shrinks and the browser pans it down. */
export const raiseKeyboard = (page: Page, bounds: { height: number; offsetTop: number }, resizeWindow = false) => page.evaluate(({ bounds, resizeWindow }) => {
  Object.assign(window.visualViewport!, bounds);
  if (resizeWindow) {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: bounds.height });
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: bounds.height });
    window.dispatchEvent(new Event('resize'));
  }
  window.visualViewport!.dispatchEvent(new Event('resize'));
}, { bounds, resizeWindow });

export const lowerKeyboard = (page: Page, height = 844) => page.evaluate(height => {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: height });
  Object.assign(window.visualViewport!, { height, offsetTop: 0 });
  window.visualViewport!.dispatchEvent(new Event('resize'));
}, height);

/** The text of the draft in the composer. */
export const draftOf = (page: Page) => page.getByTestId('prompt-input').evaluate(element => element instanceof HTMLTextAreaElement ? element.value : (element as HTMLElement).innerText.replace(/\n$/, ''));
