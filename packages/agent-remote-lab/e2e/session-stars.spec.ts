import { expect, test, type Page } from '@playwright/test';
import { openSessionsPage } from './all-sessions';

/** The Track capsule. `.lab-tracking-floating` is also the class of the floating Window, Team and TPM capsules. */
const track = (page: Page) => page.locator('.lab-tracking-floating').filter({ has: page.getByRole('button', { name: 'Tracked sessions', exact: true }) });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('agent-remote:track-view', 'true');
    localStorage.setItem('agent-remote:tpm-view', 'false');
  });
});

test('opens live tracking without a second attach or background history downloads', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  let attachments = 0;
  let opening = false;
  await page.route('**/v1/stars', route => route.fulfill({ json: { stars: [] } }));
  await page.route('**/v1/remote/hosts/host/attach', async route => {
    attachments += 1;
    // Attachment is deliberately unavailable after tracking is ready.
    await route.fulfill(!opening ? { json: { agentId: 'background-session' } }
      : { status: 504, json: { error: 'Redundant attachment timed out' } });
  });
  await page.route('**/v1/remote/hosts/host/vscode-tunnel', route => route.fulfill({ json: { status: 'stopped', processAlive: false, revision: 0 } }));
  await page.route('**/v1/remote/hosts/host/previews', route => route.fulfill({ json: { revision: 1, registrations: [] } }));
  await page.addInitScript(() => localStorage.setItem(`agent-remote-tracking:${location.origin}/u/alice/`, JSON.stringify([
    { hostId: 'host', providerId: 'recorded', nativeSessionId: 'background-session', title: 'Build checks', starredAt: 1 },
  ])));
  await page.goto('/e2e/fixtures/session-stars.html?switching=1');
  await expect(track(page).locator('.lab-tracking-counts [data-session-status="idle"]')).toHaveText('1');
  expect(await page.evaluate(() => performance.getEntriesByName('tracked-content-loaded').length)).toBe(0);
  await page.getByRole('button', { name: 'Tracked sessions', exact: true }).click();
  const beforeOpen = attachments;
  opening = true;
  await page.evaluate(() => performance.mark('tracked-open'));
  await track(page).locator('.lab-session-row').click();
  await expect(page.locator('.lab-primary-conversation .agent-message-assistant')).toContainText('Conversation for background-session');
  await expect(page.locator('.lab-primary-conversation .lab-conversation-status')).toHaveText('Ready');
  expect(attachments).toBe(beforeOpen);
  await expect(track(page).locator('.lab-tracking-count')).toHaveText('0');
  await expect(page).toHaveURL(/session=background-session/);
  const duration = await page.evaluate(() => performance.measure('tracked-switch', 'tracked-open', 'tracked-content-loaded').duration);
  await testInfo.attach('fixture-switch-timing', { body: JSON.stringify({ durationMs: duration, attachRequestsOnClick: attachments - beforeOpen }), contentType: 'application/json' });
  expect(errors).toEqual([]);
});

test('moves the tracking button without opening it and keeps the menu inside the viewport', async ({ page }, testInfo) => {
  if (testInfo.project.name.includes('mobile')) await page.setViewportSize({ width: 320, height: 740 });
  await page.route('**/v1/stars', route => route.fulfill({ json: { stars: [] } }));
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
  await page.setViewportSize({ width: 280, height: 400 });
  await expect.poll(async () => {
    const box = (await button.boundingBox())!;
    const bottom = await page.evaluate(() => visualViewport ? visualViewport.offsetTop + visualViewport.height : innerHeight);
    return box.y + box.height <= bottom;
  }).toBe(true);
  await button.focus();
  const before = (await button.boundingBox())!;
  await button.press('ArrowUp');
  expect((await button.boundingBox())!.y).toBeLessThan(before.y);
  await expect(button).toHaveAttribute('aria-expanded', 'false');
});

test('shares sidebar and title favorites while retaining only local activity tracking', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  let stars: Record<string, unknown>[] = [{ hostId: 'host', providerId: 'recorded', nativeSessionId: 'background-session', title: 'Build checks', starredAt: 1, available: true, online: true, hostName: 'Work Mac' }];
  await page.route('**/v1/stars', route => {
    const method = route.request().method();
    if (method === 'POST') stars = [...stars, { ...route.request().postDataJSON(), starredAt: 1, available: true, online: true, hostName: 'Work Mac' }];
    if (method === 'DELETE') stars = stars.filter(item => item.nativeSessionId !== route.request().postDataJSON().nativeSessionId);
    return route.fulfill({ json: { stars } });
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
  await page.getByRole('button', { name: 'Star Research notes', exact: true }).last().click();
  const favorites = mobile ? page.locator('.lab-title-favorites section') : page.locator('#lab-sessions-page [aria-label="Favorites"]');
  await expect(favorites.getByText('Research notes', { exact: true })).toBeVisible();
  await favorites.getByRole('button', { name: 'Track Research notes', exact: true }).click();
  if (mobile) { await page.getByRole('button', { name: 'Close Favorites', exact: true }).click(); await expect(title).toBeFocused(); }
  await page.getByRole('button', { name: 'Tracked sessions', exact: true }).click();
  await expect(track(page).locator('section')).not.toContainText('Research notes');
  await expect(track(page).locator('.lab-tracking-count')).toHaveText('0');
  await page.getByRole('button', { name: 'Close Tracked sessions' }).click();
  if (mobile) await title.click();
  await favorites.getByRole('button', { name: 'Track Build checks', exact: true }).click();
  if (mobile) await page.getByRole('button', { name: 'Close Favorites', exact: true }).click();
  await page.getByRole('button', { name: 'Tracked sessions', exact: true }).click();
  await expect(track(page).locator('section')).toContainText('Ready');
  await expect(track(page).locator('.lab-tracking-count')).toHaveText('1');
  await expect(page.getByTestId('prompt-input')).toHaveText('Keep my draft');
  await page.getByRole('button', { name: 'Close Tracked sessions' }).click();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture-activity', { detail: 'waiting' })));
  await expect(page.getByLabel('1 session status changes', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Tracked sessions', exact: true }).click();
  await expect(track(page).locator('section')).toContainText('Waiting');
  await expect(page.getByLabel('1 session status changes', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New status for Build checks. Mark as seen', exact: true }).click();
  await expect(page.getByLabel('1 session status changes', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('tracking.png') });
  await page.goto('/e2e/fixtures/session-stars.html');
  await page.getByRole('button', { name: 'Tracked sessions', exact: true }).click();
  await expect(track(page).locator('section')).toContainText('Build checks');
  await track(page).locator('section').getByRole('button', { name: 'Untrack Build checks', exact: true }).click();
  await expect(track(page).locator('section')).toContainText('current session');
  expect(stars).toHaveLength(2);
  await page.getByRole('button', { name: 'Close Tracked sessions' }).click();
  if (mobile) await title.click();
  await favorites.getByRole('button', { name: 'Unstar Research notes', exact: true }).last().click();
  await expect(favorites.locator('.lab-favorite-list')).not.toContainText('Research notes');
  expect(stars).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('favorites.png') });
});


test('uses consistent status colors for mobile titles and grouped tracking counts', async ({ page }, testInfo) => {
  await page.route('**/v1/stars', route => route.fulfill({ json: { stars: [] } }));
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

test('pulses for unread pending and completed work, prioritizes pending, and marks each changed session', async ({ page }, testInfo) => {
  await page.route('**/v1/stars', route => route.fulfill({ json: { stars: [] } }));
  await page.route('**/v1/remote/hosts/host/attach', route => route.fulfill({ json: { agentId: route.request().postDataJSON().nativeSessionId } }));
  await page.addInitScript(() => {
    const sessions = ['Needs input', 'Finished work'].map(nativeSessionId => ({
      hostId: 'host', providerId: 'recorded', nativeSessionId, title: nativeSessionId, starredAt: 1,
    }));
    localStorage.setItem(`agent-remote-tracking:${location.origin}/u/alice/`, JSON.stringify(sessions));
  });
  if (testInfo.project.name.includes('mobile')) await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/e2e/fixtures/session-stars.html');
  const floating = track(page);
  const trigger = page.getByRole('button', { name: 'Tracked sessions', exact: true });
  const panel = floating.locator('section');
  const pendingIndicator = page.getByRole('button', { name: 'New status for Needs input. Mark as seen', exact: true });
  const idleIndicator = page.getByRole('button', { name: 'New status for Finished work. Mark as seen', exact: true });
  const activity = async (agentId: string, status: string) => {
    await page.evaluate(detail => window.dispatchEvent(new CustomEvent('fixture-activity', { detail })), { agentId, status });
  };
  await expect(floating.locator('[data-session-status="idle"].lab-tracking-count')).toHaveText('2');
  await expect(trigger).toHaveCSS('animation-name', 'none');
  await trigger.click();
  await expect(panel.locator('.lab-tracked-change')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close Tracked sessions' }).click();
  await activity('Needs input', 'running'); await activity('Finished work', 'running');
  await expect(trigger).toHaveCSS('animation-name', 'none');
  await activity('Finished work', 'idle');
  await expect(floating).toHaveAttribute('data-alert', 'idle');
  await expect(trigger).toHaveCSS('animation-name', 'lab-tracking-idle-pulse');
  await trigger.click();
  await expect(idleIndicator).toBeVisible();
  await expect(floating).toHaveAttribute('data-alert', 'idle');
  await activity('Needs input', 'waiting');
  await expect(floating).toHaveAttribute('data-alert', 'pending');
  await expect(trigger).toHaveCSS('animation-name', 'lab-tracking-pending-pulse');
  await expect(pendingIndicator).toBeVisible();
  const backgrounds = await trigger.evaluate(element => {
    const animation = element.getAnimations().find(value => value instanceof CSSAnimation)!;
    animation.pause(); animation.currentTime = 0;
    const first = getComputedStyle(element).backgroundColor;
    animation.currentTime = 800;
    const second = getComputedStyle(element).backgroundColor;
    animation.play();
    return [first, second];
  });
  expect(backgrounds[0]).not.toBe(backgrounds[1]);
  await page.getByRole('button', { name: 'Close Tracked sessions' }).click();
  await trigger.click();
  await expect(pendingIndicator).toBeVisible();
  await expect(idleIndicator).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(trigger).toHaveCSS('animation-name', 'none');
  await expect(floating).toHaveAttribute('data-alert', 'pending');
  await page.screenshot({ path: testInfo.outputPath('pending-reminders.png') });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await pendingIndicator.click();
  await expect(pendingIndicator).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Needs input Waiting · recorded', exact: true })).toBeFocused();
  await expect(floating).toHaveAttribute('data-alert', 'idle');
  await expect(trigger).toHaveCSS('animation-name', 'lab-tracking-idle-pulse');
  await activity('Needs input', 'waiting');
  await expect(floating).toHaveAttribute('data-alert', 'idle');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.screenshot({ path: testInfo.outputPath('idle-reminders.png') });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await idleIndicator.click();
  await expect(panel.locator('.lab-tracked-change')).toHaveCount(0);
  await expect(trigger).toHaveCSS('animation-name', 'none');
  await page.getByRole('button', { name: 'Close Tracked sessions' }).click();
  await activity('Needs input', 'running'); await activity('Needs input', 'waiting');
  await expect(floating).toHaveAttribute('data-alert', 'pending');
  await activity('Needs input', 'running');
  await expect(trigger).toHaveCSS('animation-name', 'none');
  await trigger.click();
  await expect(pendingIndicator).toBeVisible();
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', page.viewportSize()!.width);
});


test('draws the tracking edge from applied content and closes immediately when the activity target is reached', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  if (testInfo.project.name.includes('mobile')) await page.setViewportSize({ width: 320, height: 740 });
  await page.route('**/v1/stars', route => route.fulfill({ json: { stars: [] } }));
  await page.route('**/v1/remote/hosts/host/attach', route => route.fulfill({ json: { agentId: 'background-session' } }));
  await page.route('**/v1/remote/hosts/host/vscode-tunnel', route => route.fulfill({ json: { status: 'stopped', processAlive: false, revision: 0 } }));
  await page.route('**/v1/remote/hosts/host/previews', route => route.fulfill({ json: { revision: 1, registrations: [] } }));
  await page.addInitScript(() => localStorage.setItem(`agent-remote-tracking:${location.origin}/u/alice/`, JSON.stringify([
    { hostId: 'host', providerId: 'recorded', nativeSessionId: 'background-session', title: 'Build checks', starredAt: 1 },
  ])));
  await page.goto('/e2e/fixtures/session-stars.html?switching=1&catchup=1');
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
