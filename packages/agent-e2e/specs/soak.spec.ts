import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { createWindowView } from '@orchardworks/agent-remote-protocol';
import { crossHostFixture } from './cross-host-fixture';

// Stage 7's soak (see performance/README.md): not part of the suite. Run on purpose, for example
// ARC_SOAK_MINUTES=60 npx playwright test e2e/soak.spec.ts --project=chromium-desktop
// Two Controllers whose native sessions answer at once; nothing runs a model.
const minutes = Number(process.env.ARC_SOAK_MINUTES ?? 0);
// Sends stop halfway: conversations grow with each message, so only the quiet half can show a leak.
const sendMinutes = Number(process.env.ARC_SOAK_SEND_MINUTES ?? minutes / 2);
const output = resolve(process.env.ARC_PERFORMANCE_OUTPUT ?? '.tmp/soak.json');
// Diagnostics, off by default: heap snapshots at the given minutes, written beside the output (ARC_SOAK_SNAPSHOTS=12,32),
// and runs without the Laptop's absences or without the mode switches (ARC_SOAK_HOST_AWAY=0, ARC_SOAK_MODE_SWITCHES=0),
// to tell what a growth comes from.
const snapshotMinutes = (process.env.ARC_SOAK_SNAPSHOTS ?? '').split(',').filter(Boolean).map(Number);
const hostAway = process.env.ARC_SOAK_HOST_AWAY !== '0', modeSwitches = process.env.ARC_SOAK_MODE_SWITCHES !== '0';
const sessions = (host: string, providerId: string) => Array.from({ length: 6 }, (_, index) => ({ providerId, nativeSessionId: `${host.toLowerCase()}-${index}`,
  title: `${host} ${index}`, history: Array.from({ length: 20 }, (_, turn) => turn % 2 ? `${host} answer ${turn} `.repeat(20) : `Question ${turn}`) }));

interface Sample { minute: number; heapMB: number; nodes: number; listeners: number; sockets: number; requests: number; errors: number; sends: number }

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
    const conversation = bot.getByRole('region', { name: 'Bot conversation', exact: true });
    const sample = async (minute: number) => {
      // Every sample is taken on the same screen, the first bot with its history shown, so samples compare like with
      // like: which bot is on screen changes the DOM by thousands of nodes, as the bots that received messages are longer.
      await row(names[0]!).click();
      await expect(conversation.getByRole('heading', { name: names[0]!, exact: true })).toBeVisible();
      await expect(conversation.locator('.agent-message-assistant').filter({ hasText: 'Studio answer 19' })).toHaveCount(1, { timeout: 30_000 });
      await page.waitForTimeout(1_000);
      await cdp.send('HeapProfiler.collectGarbage');
      const { metrics } = await cdp.send('Performance.getMetrics');
      const metric = (name: string) => metrics.find(item => item.name === name)?.value ?? 0;
      samples.push({ minute, heapMB: Math.round(metric('JSHeapUsedSize') / 1e4) / 100, nodes: metric('Nodes'), listeners: metric('JSEventListeners'), sockets, requests, errors: errors.length, sends });
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, JSON.stringify({ minutes, samples, errors: errors.slice(0, 50), failures: failures.slice(0, 100) }, null, 2));
      if (snapshotMinutes.includes(minute)) {
        const chunks: string[] = [], collect = ({ chunk }: { chunk: string }) => { chunks.push(chunk); };
        await cdp.send('HeapProfiler.enable');
        cdp.on('HeapProfiler.addHeapSnapshotChunk', collect);
        await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
        cdp.off('HeapProfiler.addHeapSnapshotChunk', collect);
        await writeFile(output.replace(/\.json$/, '') + `-${minute}.heapsnapshot`, chunks.join(''));
      }
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
    let step = 0, nextSample = 0, laptopAway = false, sends = 0;
    while (elapsed() < minutes) {
      const minute = elapsed();
      if (minute >= nextSample) { await sample(Math.round(minute)); nextSample += 1; }
      const name = names[step % names.length]!;
      await row(name).click();
      // Every fourth switch sends a message, which its Host answers (unless that Host is away).
      if (minute < sendMinutes && step % 4 === 3 && !(laptopAway && name.startsWith('Laptop'))) { await send(page, `Soak message ${step}`); sends++; }
      // Every 24 switches (about two minutes) the page goes to Window mode and back.
      if (modeSwitches && step % 24 === 23) { await mode('window'); await page.waitForTimeout(2_000); await mode('bot'); }
      // The Laptop leaves for a minute every ten.
      const decade = Math.floor(minute / 10), inDecade = minute - decade * 10;
      if (hostAway && !laptopAway && decade > 0 && inDecade < 1) { await fixture.host('Laptop').disconnect(); laptopAway = true; }
      else if (laptopAway && inDecade >= 1) { await fixture.host('Laptop').reconnect(); laptopAway = false; }
      step++;
      await page.waitForTimeout(5_000);
    }
    await sample(minutes);
    // Budgets: once sends stop and the conversations stop growing, a few minutes in, the heap and the DOM stay flat while
    // switching, mode changes and the Host's absences go on; requests per minute stay flat; sockets stay bounded; no errors.
    const quiet = samples.find(item => item.minute >= sendMinutes + 5) ?? samples[0]!, last = samples.at(-1)!;
    expect(last.heapMB, JSON.stringify(samples)).toBeLessThanOrEqual(quiet.heapMB * 1.1);
    expect(last.nodes, JSON.stringify(samples)).toBeLessThanOrEqual(quiet.nodes * 1.1);
    const perMinute = (from: Sample, to: Sample) => (to.requests - from.requests) / Math.max(1, to.minute - from.minute);
    const early = samples.find(item => item.minute >= quiet.minute + 10) ?? last, late = samples.find(item => item.minute >= last.minute - 10) ?? quiet;
    expect(perMinute(late, last), JSON.stringify(samples)).toBeLessThanOrEqual(perMinute(quiet, early) * 1.25);
    expect(Math.max(...samples.map(item => item.sockets))).toBeLessThanOrEqual(12);
    expect(errors).toEqual([]);
  } finally { await fixture.close(); }
});
