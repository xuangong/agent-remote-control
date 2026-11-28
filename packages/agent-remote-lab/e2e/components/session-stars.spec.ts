import { expect, test, type Page } from '@playwright/test';
import { openSessionsPage } from '../all-sessions';

/** The Track capsule, floating or (while the desktop sidebar shows) in the sidebar's Shortcuts. `.lab-tracking-floating` is also the class of the floating Window capsule. */
const track = (page: Page) => page.locator('.lab-tracking-floating, .lab-sidebar-shortcut-track').filter({ has: page.getByRole('button', { name: 'Tracked sessions', exact: true }) });

test.beforeEach(async ({ page }, testInfo) => {
  // A phone's home is the assistant list and its Sessions are reached through the Orchard tabs; these pages are the desktop shell.
  test.skip(testInfo.project.name.includes('mobile'), 'The phone shell does not show the desktop sidebar these pages exercise.');
  await page.addInitScript(() => {
    localStorage.setItem('agent-remote:track-view', 'true');
  });
});

test('moves the tracking button without opening it and keeps the menu inside the viewport', async ({ page }, testInfo) => {
  if (testInfo.project.name.includes('mobile')) await page.setViewportSize({ width: 320, height: 740 });
  await page.route('**/v1/favorites', route => route.fulfill({ json: { revision: 0, folders: [], stars: [] } }));
  await page.goto('/e2e/fixtures/session-stars.html');
  const button = page.getByRole('button', { name: 'Tracked sessions', exact: true });
  const initial = (await button.boundingBox())!;
  const viewport = page.viewportSize()!;
  if (testInfo.project.name.includes('mobile')) {
    const input = await page.context().newCDPSession(page);
    await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: initial.x + initial.width / 2, y: initial.y + initial.height / 2 }] });
    await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 45, y: viewport.height - 50 }] });
    await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await input.detach();
  } else {
    await page.mouse.move(initial.x + initial.width / 2, initial.y + initial.height / 2);
    await page.mouse.down();
    await page.mouse.move(45, viewport.height - 50, { steps: 12 });
    await page.mouse.up();
  }
  const moved = (await button.boundingBox())!;
  expect(moved.y).toBeGreaterThan(initial.y + 100);
  expect(moved.x).toBeLessThan(60);
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await button.click();
  const panel = track(page).locator('section');
  await expect(panel).toBeVisible();
  const bounds = (await panel.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
  await page.screenshot({ path: testInfo.outputPath('tracking-moved.png') });
  await page.goto('/e2e/fixtures/session-stars.html');
  const restored = (await button.boundingBox())!;
  expect(Math.abs(restored.x - moved.x)).toBeLessThan(2);
  expect(Math.abs(restored.y - moved.y)).toBeLessThan(2);
  await button.focus();
  const before = (await button.boundingBox())!;
  await button.press('ArrowUp');
  expect((await button.boundingBox())!.y).toBeLessThan(before.y);
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  // A narrow window docks the button; it stays inside the visible area.
  await page.setViewportSize({ width: 280, height: 400 });
  await expect.poll(async () => {
    const box = (await button.boundingBox())!;
    const bottom = await page.evaluate(() => visualViewport ? visualViewport.offsetTop + visualViewport.height : innerHeight);
    return box.y + box.height <= bottom;
  }).toBe(true);
});

test('shares sidebar and title favorites while retaining only local activity tracking', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const saved = (session: Record<string, unknown>, order: number) => ({ ...session, starredAt: 1, available: true, online: true, hostName: 'Work Mac',
    favoriteId: `favorite-${session.nativeSessionId}`, folderId: null, order });
  let stars: Record<string, unknown>[] = [saved({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'background-session', title: 'Build checks' }, 0)];
  let revision = 0;
  // Favorites are an account tree read and changed through v1/favorites since 4ef75855.
  await page.route('**/v1/favorites', route => {
    const command = route.request().method() === 'POST' ? route.request().postDataJSON() : undefined;
    if (command?.type === 'save-session') stars = [...stars, saved(command.session, stars.length)];
    if (command?.type === 'remove-session') stars = stars.filter(item => item.nativeSessionId !== command.session.nativeSessionId);
    if (command) revision++;
    return route.fulfill({ json: { revision, folders: [], stars } });
  });
  await page.route('**/v1/remote/hosts/host/attach', route => route.fulfill({ json: { agentId: 'agent-1' } }));
  await page.route('**/v1/remote/hosts/host/vscode-tunnel', route => route.fulfill({ json: { status: 'stopped', processAlive: false, revision: 0 } }));
  await page.route('**/v1/remote/hosts/host/previews', route => route.fulfill({ json: { revision: 1, registrations: [] } }));
  const mobile = testInfo.project.name.includes('mobile');
  if (mobile) await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/e2e/fixtures/session-stars.html');
  await expect(page.getByRole('region', { name: 'Opened sessions' })).toHaveCount(0);
  await expect(page.locator('.lab-primary-conversation .lab-conversation-status')).toHaveText('Working');
  await page.getByTestId('prompt-input').fill('Keep my draft');
  if (!mobile) await openSessionsPage(page);
  const title = page.getByRole('button', { name: 'Favorites', exact: true });
  if (mobile) await title.click();
  // A star opens the favorite editor (4ef75855); a new favorite goes to the root folder.
  await page.getByRole('button', { name: 'Star Research notes', exact: true }).last().click();
  const editor = page.getByRole('dialog', { name: 'Add favorite', exact: true });
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect.poll(() => stars.length).toBe(2);
  // Favorites is a page on desktop (it covers the Window, whose sessions then count as unseen) and a title menu on phones.
  const showFavorites = async () => { if (!mobile) await openSessionsPage(page, 'Favorites'); else if (!await page.locator('.lab-title-favorites section').isVisible()) await title.click(); };
  const leaveFavorites = async () => {
    if (mobile) { await page.getByRole('button', { name: 'Close Favorites', exact: true }).click(); await expect(title).toBeFocused(); }
    else await page.locator('#lab-sessions-page').getByRole('button', { name: 'Back to workbench', exact: true }).click();
  };
  await showFavorites();
  const favorites = page.locator(mobile ? '.lab-title-favorites section' : '#lab-sessions-page').getByRole('tree', { name: 'Favorites folders and sessions', exact: true });
  const favorite = (name: string) => favorites.getByRole('treeitem').filter({ hasText: name });
  // Track and Remove favorite live in each row's actions menu.
  const favoriteAction = async (name: string, action: 'Track' | 'Untrack' | 'Remove favorite') => {
    await favorite(name).getByRole('button', { name: `Actions for ${name}`, exact: true }).click();
    await page.getByRole('button', { name: action, exact: true }).click();
  };
  await expect(favorite('Research notes')).toBeVisible();
  await favoriteAction('Research notes', 'Track');
  await leaveFavorites();
  // The current session is tracked without appearing among the background sessions.
  await page.getByRole('button', { name: 'Tracked sessions', exact: true }).click();
  await expect(track(page).locator('section')).not.toContainText('Research notes');
  await expect(track(page).locator('.lab-tracking-count')).toHaveText('0');
  await page.getByRole('button', { name: 'Close Tracked sessions' }).click();
  await showFavorites();
  await favoriteAction('Build checks', 'Track');
  await leaveFavorites();
  await page.getByRole('button', { name: 'Tracked sessions', exact: true }).click();
  await expect(track(page).locator('section')).toContainText('Ready');
  await expect(track(page).locator('.lab-tracking-count')).toHaveText('1');
  await expect(page.getByTestId('prompt-input')).toHaveText('Keep my draft');
  await page.getByRole('button', { name: 'Close Tracked sessions' }).click();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture-activity', { detail: 'waiting' })));
  await expect(page.getByLabel('A tracked session needs attention', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Tracked sessions', exact: true }).click();
  await expect(track(page).locator('section')).toContainText('Waiting');
  await page.screenshot({ path: testInfo.outputPath('tracking.png') });
  await page.getByRole('button', { name: 'Close Tracked sessions' }).click();
  // Tracking is local to this browser and survives a reload; favorites are shared through the account.
  await page.goto('/e2e/fixtures/session-stars.html');
  await page.getByRole('button', { name: 'Tracked sessions', exact: true }).click();
  await expect(track(page).locator('section')).toContainText('Build checks');
  await page.getByRole('button', { name: 'Close Tracked sessions' }).click();
  await showFavorites();
  await favoriteAction('Build checks', 'Untrack');
  await leaveFavorites();
  await page.getByRole('button', { name: 'Tracked sessions', exact: true }).click();
  await expect(track(page).locator('section')).toContainText('current session');
  expect(stars).toHaveLength(2);
  await page.getByRole('button', { name: 'Close Tracked sessions' }).click();
  await showFavorites();
  await favoriteAction('Research notes', 'Remove favorite');
  await expect(favorite('Research notes')).toHaveCount(0);
  expect(stars).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('favorites.png') });
});


test('uses consistent status colors for mobile titles and grouped tracking counts', async ({ page }, testInfo) => {
  await page.route('**/v1/favorites', route => route.fulfill({ json: { revision: 0, folders: [], stars: [] } }));
  await page.route('**/v1/remote/hosts/host/attach', route => route.fulfill({ json: { agentId: route.request().postDataJSON().nativeSessionId } }));
  await page.addInitScript(() => {
    const sessions = ['working-session', 'pending-session', 'idle-one', 'idle-two', 'recorded-session'].map(nativeSessionId => ({
      hostId: 'host', providerId: 'recorded', nativeSessionId, title: nativeSessionId, starredAt: 1,
    }));
    localStorage.setItem(`agent-remote-tracking:${location.origin}/u/alice/`, JSON.stringify(sessions));
  });
  const mobile = testInfo.project.name.includes('mobile');
  if (mobile) await page.setViewportSize({ width: 320, height: 740 });
  for (const status of ['running', 'waiting', 'idle']) {
    await page.goto(`/e2e/fixtures/session-stars.html?status=${status}`);
    const counts = track(page).locator('.lab-tracking-counts');
    await expect(counts.locator('[data-session-status="idle"]')).toHaveText('4');
    for (const [agentId, activity] of [['working-session', 'running'], ['pending-session', 'waiting']]) {
      await page.evaluate(detail => window.dispatchEvent(new CustomEvent('fixture-activity', { detail })), { agentId, status: activity });
    }
    await expect(counts.locator('.lab-tracking-count')).toHaveText(['1', '1', '2']);
    const colors: Record<string, string> = {};
    for (const activity of ['running', 'waiting', 'idle']) {
      colors[activity] = await counts.locator(`[data-session-status="${activity}"]`).evaluate(el => getComputedStyle(el).color);
    }
    expect(colors.running).toBe('rgb(26, 116, 49)');
    expect(colors.waiting).toBe('rgb(201, 52, 0)');
    expect(colors.idle).toBe('rgb(29, 29, 31)');
    if (mobile) {
      const title = page.locator('.lab-favorites-title');
      await expect(title).toHaveCSS('color', colors[status]!);
      const trigger = page.getByRole('button', { name: 'Favorites', exact: true });
      await trigger.hover();
      await expect(title).toHaveCSS('color', colors[status]!);
      await expect(trigger).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(trigger).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
      expect((await trigger.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await trigger.click();
      await expect(page.locator('.lab-title-favorites section')).toBeVisible();
      await page.getByRole('button', { name: 'Close Favorites', exact: true }).click();
      await expect(trigger).toBeFocused();
    }
    await page.getByRole('button', { name: 'Tracked sessions', exact: true }).click();
    const panel = track(page).locator('section');
    for (const [title, activity] of [['working-session', 'running'], ['pending-session', 'waiting'], ['idle-one', 'idle'], ['idle-two', 'idle']] as const) {
      await expect(panel.locator('strong', { hasText: title })).toHaveCSS('color', colors[activity]!);
    }
    await expect(panel).not.toContainText('recorded-session');
    await page.screenshot({ path: testInfo.outputPath(`status-colors-${status}.png`) });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture-activity', { detail: { agentId: 'working-session', status: 'idle' } })));
    await expect(counts.locator('[data-session-status="running"]')).toHaveCount(0);
    await expect(counts.locator('[data-session-status="idle"]')).toHaveText('3');
  }
});

test('draws the tracking edge from applied content and closes immediately when the activity target is reached', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  if (testInfo.project.name.includes('mobile')) await page.setViewportSize({ width: 320, height: 740 });
  await page.route('**/v1/favorites', route => route.fulfill({ json: { revision: 0, folders: [], stars: [] } }));
  await page.route('**/v1/remote/hosts/host/attach', route => route.fulfill({ json: { agentId: 'background-session' } }));
  await page.route('**/v1/remote/hosts/host/vscode-tunnel', route => route.fulfill({ json: { status: 'stopped', processAlive: false, revision: 0 } }));
  await page.route('**/v1/remote/hosts/host/previews', route => route.fulfill({ json: { revision: 1, registrations: [] } }));
  await page.addInitScript(() => localStorage.setItem(`agent-remote-tracking:${location.origin}/u/alice/`, JSON.stringify([
    { hostId: 'host', providerId: 'recorded', nativeSessionId: 'background-session', title: 'Build checks', starredAt: 1 },
  ])));
  // The session's Controller grants control, so catching up ends with the same composer instead of a Read only notice.
  await page.goto('/e2e/fixtures/session-stars.html?switching=1&catchup=1&control=1');
  await expect(track(page).locator('.lab-tracking-counts [data-session-status="idle"]')).toHaveText('1');
  const trigger = page.getByRole('button', { name: 'Tracked sessions', exact: true });
  await page.mouse.move(0, 0);
  const normalBorder = await trigger.evaluate(node => getComputedStyle(node).borderTopColor);
  await trigger.click(); await track(page).locator('.lab-session-row').click();
  const ring = page.locator('.lab-tracking-catch-up');
  await expect(ring).toHaveAttribute('data-state', 'catching_up');
  const composer = page.locator('.lab-primary-conversation .lab-composer-dock');
  const geometry = await composer.boundingBox();
  const input = page.getByTestId('prompt-input');
  await input.fill('Draft while catching up');
  await page.waitForTimeout(1200);
  await expect(ring).toHaveAttribute('aria-valuenow', '0');
  await expect(trigger).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
  await expect(ring.locator('rect')).toHaveCSS('stroke-dashoffset', '100px');
  await expect(ring.locator('rect')).toHaveCSS('stroke', normalBorder);
  await page.screenshot({ path: testInfo.outputPath('catch-up-empty.png') });
  await page.evaluate(() => window.dispatchEvent(new Event('fixture-history')));
  await expect(ring).toHaveAttribute('aria-valuenow', '33');
  const rect = ring.locator('rect');
  expect(await rect.evaluate(node => (node as SVGGraphicsElement).getBBox().width)).toBeGreaterThan(40);
  expect(await rect.evaluate(node => getComputedStyle(node).strokeWidth)).toBe(await trigger.evaluate(node => getComputedStyle(node).borderTopWidth));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture-content', { detail: 2 })));
  await expect(ring).toHaveAttribute('aria-valuenow', '66');
  await expect.poll(() => rect.evaluate(node => parseFloat(getComputedStyle(node).strokeDashoffset))).toBeCloseTo(100 / 3, 2);
  await page.screenshot({ path: testInfo.outputPath('catch-up-partial.png') });
  const completion = await page.evaluate(() => new Promise<{ state?: string; offset: string; transition: string; border: string; visibility: string }>(resolve => {
    window.dispatchEvent(new CustomEvent('fixture-content', { detail: 3 }));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const ring = document.querySelector<HTMLElement>('.lab-tracking-catch-up')!;
      const style = getComputedStyle(ring.querySelector('rect')!);
      resolve({ state: ring.dataset.state, offset: style.strokeDashoffset, transition: style.transitionDuration,
        border: getComputedStyle(ring.closest('button')!).borderTopColor, visibility: getComputedStyle(ring).visibility });
    }));
  }));
  expect(completion).toEqual({ state: 'complete', offset: '0px', transition: '0s', border: normalBorder, visibility: 'hidden' });
  await expect(input).toHaveText('Draft while catching up');
  expect(await composer.boundingBox()).toEqual(geometry);
  await page.screenshot({ path: testInfo.outputPath('catch-up-complete.png') });
  await expect(trigger).toHaveCSS('border-top-color', normalBorder);
  await expect(ring).toHaveCSS('visibility', 'hidden');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(trigger).toHaveCSS('border-top-color', normalBorder);
  // The overlay never intercepts the existing menu or movement controls.
  await trigger.click(); await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(errors).toEqual([]);
});
