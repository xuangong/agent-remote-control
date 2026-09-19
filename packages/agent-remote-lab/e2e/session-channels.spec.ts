import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ timeout: 20_000 });

function observeChannels(page: Page) {
  const sockets: { mode: string; closed: boolean }[] = [];
  const subscriptions = new Map<number, { mode: string; agentId: string }>();
  const activityMessages: string[] = [];
  const errors: string[] = [];
  const historyRequests: URL[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (/\/v1\/sessions\/[^/]+\/timeline$/.test(url.pathname)) historyRequests.push(url);
  });
  page.on('websocket', socket => {
    const url = new URL(socket.url());
    if (!url.pathname.startsWith('/v1/')) return;
    const state = { mode: url.searchParams.get('observation') ?? 'legacy', closed: false };
    sockets.push(state);
    socket.on('close', () => { state.closed = true; });
    socket.on('framesent', ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (frame.type === 'subscribe') subscriptions.set(frame.subscriptionId, { mode: state.mode, agentId: frame.agentId });
      if (frame.type === 'unsubscribe') subscriptions.delete(frame.subscriptionId);
    });
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (frame.type === 'closed') subscriptions.delete(frame.subscriptionId);
      if (state.mode === 'activity' && frame.type === 'message') activityMessages.push(frame.message.type);
    });
  });
  return {
    sockets, activityMessages, errors, historyRequests,
    fullSessions: () => [...subscriptions.values()].filter(value => value.mode === 'session').map(value => value.agentId).sort(),
  };
}

async function initialize(page: Page) {
  await page.goto('/e2e/fixtures/session-channels.html');
  await expect(page.locator('#primary-state')).toHaveText('a:ready');
  await expect(page.locator('#activity-state')).toContainText('a:ready');
  await expect(page.locator('#activity-state')).toContainText('b:ready');
  return {
    a: (await page.locator('#fixture').getAttribute('data-agent-a'))!,
    b: (await page.locator('#fixture').getAttribute('data-agent-b'))!,
  };
}

test('restores shared channels after page resume and reuses them for subsequent switches', async ({ page }) => {
  const wire = observeChannels(page);
  await initialize(page);
  expect(wire.sockets).toHaveLength(2);
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect.poll(() => wire.sockets.filter(socket => socket.closed).length).toBe(2);
  await expect(page.locator('#primary-state')).toHaveText('a:ready');
  await expect(page.locator('#activity-state')).toContainText('a:ready');
  await expect(page.locator('#activity-state')).toContainText('b:ready');
  await expect.poll(() => wire.sockets.filter(socket => !socket.closed).map(socket => socket.mode).sort()).toEqual(['activity', 'session']);
  expect(wire.sockets).toHaveLength(4);
  for (const name of ['B', 'A', 'B']) {
    await page.getByRole('button', { name: `Primary ${name}`, exact: true }).click();
    await expect(page.locator('#primary-state')).toHaveText(`${name.toLowerCase()}:ready`);
    expect(wire.sockets).toHaveLength(4);
  }
  expect(wire.errors).toEqual([]);
});

test('reuses two physical channels across ordinary switches and concurrent side conversations', async ({ page }, testInfo) => {
  const wire = observeChannels(page);
  const ids = await initialize(page);
  await expect.poll(() => wire.sockets.map(socket => socket.mode).sort()).toEqual(['activity', 'session']);
  await expect.poll(wire.fullSessions).toEqual([ids.a]);
  expect(wire.historyRequests).toHaveLength(1);

  await page.getByRole('button', { name: 'Primary B', exact: true }).click();
  await expect(page.locator('#primary-state')).toHaveText('b:ready');
  await expect.poll(wire.fullSessions).toEqual([ids.b]);
  expect(wire.sockets).toHaveLength(2);
  expect(wire.sockets.every(socket => !socket.closed)).toBe(true);

  await page.getByRole('button', { name: 'Open side A', exact: true }).click();
  await expect(page.locator('#side-state')).toHaveText('a:ready');
  await expect(page.locator('#primary-state')).toHaveText('b:ready');
  await expect.poll(wire.fullSessions).toEqual([ids.a, ids.b].sort());
  await page.getByRole('button', { name: 'Send to primary', exact: true }).click();
  await expect(page.locator('#primary-timeline')).toContainText('Recorded reply: Browser channel acceptance message');
  await expect(page.locator('#side-timeline')).not.toContainText('Browser channel acceptance message');
  await page.screenshot({ path: testInfo.outputPath('parallel-session-channels.png'), fullPage: true });

  await page.getByRole('button', { name: 'Close side', exact: true }).click();
  await expect.poll(wire.fullSessions).toEqual([ids.b]);
  await expect(page.locator('#primary-state')).toHaveText('b:ready');
  expect(wire.sockets).toHaveLength(2);
  expect(wire.activityMessages.every(type => type === 'negotiated' || type === 'agent_activity')).toBe(true);
  expect(wire.errors).toEqual([]);
  await expect(page.locator('#error')).toBeEmpty();
  await page.getByRole('button', { name: 'Dispose channels', exact: true }).click();
  await expect.poll(() => wire.sockets.every(socket => socket.closed)).toBe(true);
});

test('renders cached history during an incremental recovery and waits for target ready before enabling commands', async ({ page }, testInfo) => {
  const wire = observeChannels(page);
  const ids = await initialize(page);
  const cached = await page.locator('#primary-timeline').textContent();
  expect(cached).toContain('Recorded history 1');
  await page.getByRole('button', { name: 'Primary B', exact: true }).click();
  await expect(page.locator('#primary-state')).toHaveText('b:ready');
  await expect.poll(wire.fullSessions).toEqual([ids.b]);
  await page.getByRole('button', { name: 'Advance A', exact: true }).click();
  await expect(page.locator('#advance-state')).toHaveText('advanced');
  expect(wire.historyRequests).toHaveLength(2);

  let releaseHistory!: () => void;
  const historyGate = new Promise<void>(resolve => { releaseHistory = resolve; });
  let recoveryUrl: URL | undefined;
  await page.route('**/v1/sessions/*/timeline?**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === `/v1/sessions/${ids.a}/timeline` && url.searchParams.get('direction') === 'after') {
      recoveryUrl = url;
      await historyGate;
    }
    await route.continue();
  });
  try {
    await page.getByRole('button', { name: 'Primary A', exact: true }).click();
    await expect.poll(() => recoveryUrl?.searchParams.get('direction')).toBe('after');
    await expect(page.locator('#primary-state')).toHaveText('a:catching_up');
    await expect(page.getByRole('button', { name: 'Send to primary', exact: true })).toBeDisabled();
    await expect(page.locator('#primary-timeline')).toHaveText(cached!);
    expect(recoveryUrl!.searchParams.get('seq')).toBe('6');
    expect(recoveryUrl!.searchParams.get('epoch')).toBeTruthy();
    expect(wire.sockets).toHaveLength(2);
    await expect.poll(wire.fullSessions).toEqual([ids.a]);
    await page.screenshot({ path: testInfo.outputPath('cached-history-while-synchronizing.png'), fullPage: true });
  } finally { releaseHistory(); }
  await expect(page.locator('#primary-state')).toHaveText('a:ready');
  await expect(page.getByRole('button', { name: 'Send to primary', exact: true })).toBeEnabled();
  await expect(page.locator('#primary-timeline')).toContainText('Live recorded output.');
  await expect(page.locator('#primary-timeline')).toContainText('Recorded history 1');
  expect(wire.historyRequests).toHaveLength(3);
  expect(wire.sockets).toHaveLength(2);
  expect(wire.errors).toEqual([]);
  await expect(page.locator('#error')).toBeEmpty();
});
