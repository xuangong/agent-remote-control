import { expect, test } from '@playwright/test';
import { sessionLinkFixture } from './session-link-fixture';
import { showNewSession } from './session-navigation';

test('cached startup and foreground recovery keep the editor while business traffic waits for access', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  const f = await sessionLinkFixture();
  let release!: () => void;
  try {
    await page.goto(f.url);
    await page.getByRole('link', { name: 'Sign in through gateway' }).click();
    await page.getByRole('link', { name: 'Sign in as alice' }).click();
    await page.getByLabel('Connected Host').selectOption(f.hostId);
    await showNewSession(page);
    await page.getByTestId('session-create').click();
    const input = page.getByTestId('prompt-input');
    await expect(input).toBeEnabled();
    await input.fill('Seamless cache marker');
    await page.getByTestId('prompt-submit').click();
    await expect(page.locator('.agent-message-assistant').last()).toContainText('Seamless cache marker');
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(key => key.endsWith(':workspace')))).toBe(true);
    await input.fill('My unsent draft');
    const timeline = page.getByTestId('timeline');
    await timeline.evaluate(element => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -150, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 150);
      element.dispatchEvent(new Event('scroll'));
    });
    const readingTop = await timeline.evaluate(element => element.scrollTop);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    const gate = new Promise<void>(resolve => { release = resolve; });
    let waiting = true;
    const premature: string[] = [];
    page.on('request', request => { if (waiting && /\/u\/[^/]+\/v1\//.test(request.url())) premature.push(request.url()); });
    await page.route('**/auth/status', async route => { await gate; await route.continue(); });
    await page.reload();
    await expect(page.locator('.agent-message-assistant').last()).toContainText('Seamless cache marker');
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('My unsent draft');
    await expect.poll(async () => Math.abs(await timeline.evaluate(element => element.scrollTop) - readingTop)).toBeLessThan(4);
    await page.screenshot({ path: testInfo.outputPath('cached-workspace.png') });
    const editor = await input.elementHandle();
    await input.fill('Continue typing before authorization');
    expect(premature).toEqual([]);
    waiting = false; release();
    await expect(page.getByTestId('connection-summary')).toContainText('Ready');
    await expect.poll(() => editor!.evaluate(element => element.isConnected)).toBe(true);
    await expect(input).toHaveValue('Continue typing before authorization');
    await expect.poll(async () => Math.abs(await timeline.evaluate(element => element.scrollTop) - readingTop)).toBeLessThan(4);
    await expect(page.locator('.agent-message-assistant').last()).toContainText('Seamless cache marker');
    let finishResume!: () => void;
    const resume = new Promise<void>(resolve => { finishResume = resolve; });
    await page.route('**/auth/refresh', async route => { await resume; await route.continue(); });
    waiting = true; premature.length = 0;
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect(input).toBeVisible();
    await input.fill('Still editing during recovery');
    await expect(page.locator('.gateway-recovery')).toBeVisible({ timeout: 7000 });
    expect(premature).toEqual([]);
    expect(await editor!.evaluate(element => element.isConnected)).toBe(true);
    waiting = false; finishResume();
    await expect(page.locator('.gateway-recovery')).not.toBeVisible();
    await expect(input).toHaveValue('Still editing during recovery');
    await page.getByTestId('prompt-submit').click();
    await expect(page.locator('.agent-message-assistant').last()).toContainText('Still editing during recovery');
  } finally { release?.(); await f.close(); }
});

test('returning browsers automatically complete Gateway authorization without an extra sign-in click', async ({ page }) => {
  const f = await sessionLinkFixture({ automaticSignIn: true });
  try {
    await page.goto(f.url);
    await page.getByRole('link', { name: 'Sign in through gateway' }).click();
    await expect(page.getByLabel('Connected Host')).toBeVisible();
    await page.evaluate(() => sessionStorage.removeItem('agent-remote:automatic-sign-in'));
    await page.context().clearCookies();
    await page.reload();
    await expect(page.getByLabel('Connected Host')).toBeVisible();
    await expect(page).toHaveURL(f.url + '/');
    expect(await page.evaluate(() => !!sessionStorage.getItem('agent-remote:automatic-sign-in'))).toBe(true);
  } finally { await f.close(); }
});

test('confirmed device protection clears disk copies across tabs without interrupting live drafts', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  const f = await sessionLinkFixture({ automaticSignIn: true });
  const context = page.context();
  let second: typeof page | undefined;
  let release!: () => void;
  try {
    await page.goto(f.url);
    await page.getByRole('link', { name: 'Sign in through gateway' }).click();
    await page.getByLabel('Connected Host').selectOption(f.hostId);
    await showNewSession(page);
    await page.getByTestId('session-create').click();
    const input = page.getByTestId('prompt-input');
    await expect(input).toBeEnabled();
    await input.fill('Private conversation marker');
    await page.getByTestId('prompt-submit').click();
    await expect(page.locator('.agent-message-assistant').last()).toContainText('Private conversation marker');
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(key => key.endsWith(':workspace')))).toBe(true);
    await input.fill('Private unsent draft');
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open('agent-remote-image-drafts', 2);
        open.onupgradeneeded = () => {
          if (!open.result.objectStoreNames.contains('drafts')) open.result.createObjectStore('drafts', { keyPath: 'key' });
          if (!open.result.objectStoreNames.contains('images')) open.result.createObjectStore('images', { keyPath: 'key' }).createIndex('imageId', 'imageId');
        };
        open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
      });
      const tx = db.transaction(['drafts', 'images'], 'readwrite');
      tx.objectStore('drafts').put({ key: 'previous-draft', scope: 'previous-account', parts: [{ type: 'text', text: 'Old image caption' }] });
      tx.objectStore('images').put({ key: 'previous-image', scope: 'previous-account', imageId: 'old-image', blobBytes: new Uint8Array([1, 2, 3]).buffer });
      await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); }); db.close();
    });
    const url = page.url();
    second = await context.newPage();
    await second.goto(url);
    await expect(second.getByTestId('prompt-input')).toBeEnabled();
    await second.getByTestId('prompt-input').fill('Other tab draft');
    await second.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await page.bringToFront();
    if ((page.viewportSize()?.width ?? 1280) <= 1180) {
      await page.getByRole('button', { name: 'Open sessions', exact: true }).click();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
    } else await page.getByRole('button', { name: 'Sidebar settings' }).click();
    const toggle = page.getByRole('switch', { name: 'Clear chat cache on close' });
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    const dialog = page.getByRole('dialog', { name: 'Keep chat data in this page only?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('does not sign out');
    await page.screenshot({ path: testInfo.outputPath('cache-protection-confirmation.png') });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await page.evaluate(() => Object.keys(localStorage).some(key => key.endsWith(':workspace')))).toBe(true);
    await toggle.click();
    await dialog.getByRole('button', { name: 'Enable protection' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(toggle).toBeChecked();
    expect(await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>(resolve => { const open = indexedDB.open('agent-remote-image-drafts', 2); open.onsuccess = () => resolve(open.result); });
      const tx = db.transaction(['drafts', 'images'], 'readonly');
      const drafts = tx.objectStore('drafts').count(), images = tx.objectStore('images').count();
      await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); }); db.close();
      return [drafts.result, images.result];
    })).toEqual([0, 0]);
    const contentKeys = () => [localStorage, sessionStorage].flatMap(storage => Object.keys(storage).filter(key => /^(agent-remote:(recovery:)|agent-remote-(forks:|ask:|opened:|tracking:|conversation-history)|arc:prompt-edit)/.test(key)));
    await expect.poll(() => page.evaluate(contentKeys)).toEqual([]);
    await second.bringToFront();
    await expect(second.getByTestId('prompt-input')).toHaveValue('Other tab draft');
    await second.getByTestId('prompt-input').fill('Still private');
    await second.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide'));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await expect.poll(() => second!.evaluate(contentKeys)).toEqual([]);
    await expect(second.getByTestId('prompt-input')).toHaveValue('Still private');
    await second.getByTestId('prompt-submit').click();
    await expect(second.locator('.agent-message-assistant').last()).toContainText('Still private');
    await expect.poll(() => second!.evaluate(contentKeys)).toEqual([]);
    await second.close(); second = undefined;
    await page.bringToFront();
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/auth/status', async route => { await gate; await route.continue(); });
    await page.reload();
    await expect(page.locator('.lab-shell')).toBeVisible();
    await expect(page.locator('.agent-message-assistant')).toHaveCount(0);
    await expect.poll(() => page.evaluate(contentKeys)).toEqual([]);
    release();
    await expect(page.getByTestId('prompt-input')).toBeEnabled();
    await expect(page.getByTestId('prompt-input')).toHaveValue('');
    await expect(page.locator('.agent-message-assistant').last()).toContainText('Still private');
  } finally { release?.(); await second?.close(); await f.close(); }
});
