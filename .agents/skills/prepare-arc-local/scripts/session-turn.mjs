// Runs one real model turn in a new session on this checkout's local instance.
// Usage, from the checkout root: node .agents/skills/prepare-arc-local/scripts/session-turn.mjs ["Claude Code"|Codex] [evidence directory]
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = process.cwd();
const providerName = process.argv[2] ?? 'Claude Code';
const evidence = process.argv[3] ?? '.tmp/local';
mkdirSync(evidence, { recursive: true });
// Read the origin once: this status call signs in, so never repeat it per step.
const { origin } = JSON.parse(execFileSync('pnpm', ['--silent', 'local', 'status', '--json'], { cwd: root, encoding: 'utf8' }));
const { chromium } = createRequire(join(root, 'packages/agent-remote-lab/package.json'))('@playwright/test');
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator('main.lab-shell').waitFor({ timeout: 30_000 });
    // 1. Choose the development Host.
    const host = page.getByRole('combobox').first();
    const label = (await host.locator('option').allTextContents()).find(text => text.startsWith('Dev · '));
    if (!label) throw new Error('The Host list has no Dev · Host; check pnpm local status.');
    await host.selectOption({ label });
    // 2. Add an empty view, select it, and open the new-session form for it.
    await page.getByRole('button', { name: 'New session view' }).click();
    await page.getByText('Choose a session from the sidebar').last().click();
    await page.getByRole('button', { name: /New session/ }).first().click();
    // 3. Remember which views already have a composer, then open the session.
    const panes = '.lab-session-family-pane[data-view-id]';
    const before = await page.locator(panes).evaluateAll(list => list.filter(pane => pane.querySelector('[data-testid="prompt-input"]')).map(pane => pane.dataset.viewId));
    await page.locator('#provider-select').selectOption({ label: providerName });
    await page.getByTestId('session-create').click();
    // 4. The new session is the view that gained a composer. Pin it by id: other views may already show the same answer.
    const created = await page.waitForFunction(([selector, ids]) => [...document.querySelectorAll(selector)]
      .find(pane => !ids.includes(pane.dataset.viewId) && pane.querySelector('[data-testid="prompt-input"]'))?.dataset.viewId,
    [panes, before], { timeout: 60_000 });
    const view = page.locator(`${panes}[data-view-id="${await created.jsonValue()}"]`);
    await page.screenshot({ path: join(evidence, 'session-created.png') });
    // 5. The answer is not in the prompt, so the user's own message cannot satisfy the check.
    await view.getByTestId('prompt-input').click();
    await page.keyboard.type('Reply with the words LOCAL and OK joined by a hyphen, and nothing else.');
    await view.getByTestId('prompt-submit').click();
    const reply = view.locator('.agent-message-assistant', { hasText: 'LOCAL-OK' });
    try { await reply.first().waitFor({ timeout: 120_000 }); }
    catch (error) { await page.screenshot({ path: join(evidence, 'turn-timeout.png') }); throw error; }
    await page.screenshot({ path: join(evidence, 'turn-reply.png') });
    console.log(`${providerName} replied in view ${await view.getAttribute('data-view-id')}: ${(await reply.first().innerText()).replace(/\s+/g, ' ')}`);
  } finally {
    // Close the page first: an open page keeps polling and gets 401s once its session ends.
    for (const open of context.pages()) await open.close().catch(() => {});
    // Mirrors scripts/local/session.mjs: the page's session would otherwise stay open on the instance.
    await context.request.post(origin + '/auth/logout', { headers: { origin, 'content-type': 'application/json' }, data: '{}', timeout: 10_000 }).catch(() => {});
  }
} finally {
  await browser.close();
}
