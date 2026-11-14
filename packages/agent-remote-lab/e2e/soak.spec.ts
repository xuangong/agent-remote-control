import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { createWindowView } from '@orchardworks/agent-remote-protocol';
import { crossHostFixture } from './cross-host-fixture';

// Stage 7's soak (see performance/README.md): not part of the suite. Run on purpose, for example
// ARC_SOAK_MINUTES=60 npx playwright test e2e/soak.spec.ts --project=chromium-desktop
// Two Controllers whose native sessions answer at once; nothing runs a model.
const minutes = Number(process.env.ARC_SOAK_MINUTES ?? 0);
const output = resolve(process.env.ARC_PERFORMANCE_OUTPUT ?? '.tmp/soak.json');
const sessions = (host: string, providerId: string) => Array.from({ length: 6 }, (_, index) => ({ providerId, nativeSessionId: `${host.toLowerCase()}-${index}`,
  title: `${host} ${index}`, history: Array.from({ length: 20 }, (_, turn) => turn % 2 ? `${host} answer ${turn} `.repeat(20) : `Question ${turn}`) }));

interface Sample { minute: number; heapMB: number; nodes: number; listeners: number; sockets: number; requests: number; errors: number }

test('soak: bot switches, sends, mode switches and a Host leaving and coming back, without growth', async ({ page, context }) => {
  test.skip(!minutes, 'Run on purpose with ARC_SOAK_MINUTES.');
  test.setTimeout((minutes + 5) * 60_000);
  const fixture = await crossHostFixture([
    { name: 'Studio', providers: [{ providerId: 'codex', displayName: 'Codex' }], sessions: sessions('Studio', 'codex') },
    { name: 'Laptop', providers: [{ providerId: 'claude', displayName: 'Claude' }], sessions: sessions('Laptop', 'claude') }]);
  const errors: string[] = [];
  let requests = 0, sockets = 0;
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text().slice(0, 300)); });
  page.on('pageerror', error => errors.push(`pageerror: ${error.message.slice(0, 300)}`));
  page.on('request', () => { requests++; });
  const failures: string[] = [];
  page.on('response', response => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    const label = `${response.request().method()} ${url.pathname.replace(/[0-9a-f-]{20,}/g, ':id')}${url.search ? '?…' : ''} ${response.status()}`;
    void response.json().then((body: { code?: string; error?: string }) => failures.push(`${label} ${body.code ?? ''} ${(body.error ?? '').slice(0, 160)}`), () => failures.push(label));
  });
  page.on('websocket', socket => { sockets++; socket.on('close', () => { sockets--; }); });
  try {
    await fixture.seed(context);
    const windows = fixture.windows(context);
    const names: string[] = [];
    // Three groups of four bots, two on each Host.
    for (let group = 0; group < 3; group++) {
      const views = [0, 1].flatMap(offset => {
        const index = group * 2 + offset;
        names.push(`Studio ${index}`, `Laptop ${index}`);
        return [createWindowView(`S${index}`, { hostId: fixture.host('Studio').hostId, providerId: 'codex', nativeSessionId: `studio-${index}`, title: `Studio ${index}` }, 'primary'),
          createWindowView(`L${index}`, { hostId: fixture.host('Laptop').hostId, providerId: 'claude', nativeSessionId: `laptop-${index}`, title: `Laptop ${index}` }, 'primary')];
      });
      await windows.create({ schemaVersion: 3, id: fixture.newOperationId(), revision: 0, title: `Group ${group}`, views, selectedViewId: views[0]!.id, selectedPrimaryViewId: views[0]!.id });
    }
    await page.goto(`${fixture.origin}/?mode=bot`);
    const bot = page.locator('[data-workbench-mode="bot"]');
    const row = (name: string) => bot.getByRole('navigation', { name: 'Bots', exact: true }).getByRole('button', { name, exact: true });
    await expect(row(names[0]!)).toBeVisible({ timeout: 30_000 });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const samples: Sample[] = [];
    const sample = async (minute: number) => {
      await cdp.send('HeapProfiler.collectGarbage');
      const { metrics } = await cdp.send('Performance.getMetrics');
      const metric = (name: string) => metrics.find(item => item.name === name)?.value ?? 0;
      samples.push({ minute, heapMB: Math.round(metric('JSHeapUsedSize') / 1e4) / 100, nodes: metric('Nodes'), listeners: metric('JSEventListeners'), sockets, requests, errors: errors.length });
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, JSON.stringify({ minutes, samples, errors: errors.slice(0, 50), failures: failures.slice(0, 100) }, null, 2));
    };
    const mode = async (value: 'window' | 'bot') => {
      const region = page.locator(`[data-workbench-mode="${value === 'bot' ? 'window' : 'bot'}"]`);
      if (value === 'bot') {
        const trigger = region.getByRole('button', { name: 'View options', exact: true });
        if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
        await region.getByRole('region', { name: 'View options', exact: true }).getByRole('button', { name: 'Bot mode', exact: true }).click();
      } else await region.getByRole('button', { name: 'Window mode', exact: true }).locator('visible=true').click();
      await expect(page.locator(`[data-workbench-mode="${value}"]`)).toBeVisible();
    };
    const send = async (page: Page, text: string) => {
      const input = bot.getByTestId('prompt-input').locator('visible=true');
      await expect(input).toBeEnabled({ timeout: 30_000 });
      await input.fill(text);
      await expect(bot.getByTestId('prompt-submit')).toBeEnabled({ timeout: 30_000 });
      await input.press('Enter');
      await expect(bot.locator('.agent-message-assistant').filter({ hasText: text })).toHaveCount(1, { timeout: 30_000 });
    };
    const started = Date.now(), elapsed = () => (Date.now() - started) / 60_000;
    let step = 0, nextSample = 0, laptopAway = false;
    while (elapsed() < minutes) {
      const minute = elapsed();
      if (minute >= nextSample) { await sample(Math.round(minute)); nextSample += 1; }
      const name = names[step % names.length]!;
      await row(name).click();
      // Every fourth switch sends a message, which its Host answers (unless that Host is away).
      if (step % 4 === 3 && !(laptopAway && name.startsWith('Laptop'))) await send(page, `Soak message ${step}`);
      // Every 24 switches (about two minutes) the page goes to Window mode and back.
      if (step % 24 === 23) { await mode('window'); await page.waitForTimeout(2_000); await mode('bot'); }
      // The Laptop leaves for a minute every ten.
      const decade = Math.floor(minute / 10), inDecade = minute - decade * 10;
      if (!laptopAway && decade > 0 && inDecade < 1) { await fixture.host('Laptop').disconnect(); laptopAway = true; }
      else if (laptopAway && inDecade >= 1) { await fixture.host('Laptop').reconnect(); laptopAway = false; }
      step++;
      await page.waitForTimeout(5_000);
    }
    await sample(minutes);
    // Budgets: no growth after the first ten minutes; sockets bounded; no errors.
    const settled = samples.find(item => item.minute >= 10) ?? samples[0]!, last = samples.at(-1)!;
    expect(last.heapMB, JSON.stringify(samples)).toBeLessThanOrEqual(settled.heapMB * 1.15);
    expect(last.nodes, JSON.stringify(samples)).toBeLessThanOrEqual(settled.nodes * 1.15);
    expect(Math.max(...samples.map(item => item.sockets))).toBeLessThanOrEqual(12);
    expect(errors).toEqual([]);
  } finally { await fixture.close(); }
});
