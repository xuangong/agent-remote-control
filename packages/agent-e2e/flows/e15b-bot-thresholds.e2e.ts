// E15b, the person's thresholds on bot chains (bots design 7), on the real stack with the push service simulator. The person turns on
// "Notify me on this device" and sets a reply-depth threshold in Settings > Assistants. With no page running, two bots exchange messages
// so a chain passes it: the audit shows the chain as passed, exactly one "needs you" push for the chain's first bot reaches the push
// service, and nothing stops: the next message in the chain is delivered. `E2E_BROWSER=webkit` runs it in WebKit.
import type { Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { startPushService, type PushService } from '@orchardworks/agent-remote-fixtures/push-service';
import { hasTools, inputs, team } from './bot-team.js';
import { launchBrowser, openPage } from './browser.js';
import { modelBrowserPush } from './push-device.js';

let stack: Stack; let browser: Browser; let push: PushService;
beforeAll(async () => {
  push = await startPushService();
  stack = await startStack({ teams: true, tools: true, pushServices: [push.origin], sessions: {
    chief: { title: 'Chief', history: [{ role: 'user', text: 'Plan the release.' }, { role: 'assistant', text: 'Chief is ready.' }] },
    tracker: { title: 'Tracker', history: [{ role: 'user', text: 'Track the build.' }, { role: 'assistant', text: 'Tracker is ready.' }] },
  } });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); await stack?.close(); await push?.close(); });

it('E15b: a chain that passes the reply-depth threshold is shown as passed and sends one reminder, and nothing in it stops', async () => {
  const { context, page } = await openPage(browser, stack.origin + '/?page=settings&group=assistants');
  const status = await (await context.request.get(stack.origin + '/auth/status')).json() as { basePath: string };
  const relay = await (await context.request.get(`${stack.origin}${status.basePath}v1/push-subscriptions`)).json() as { publicKey: string };
  const subscription = await push.subscribe({ applicationServerKey: relay.publicKey });
  await modelBrowserPush(page, subscription);
  await team(stack, context);
  await hasTools(stack, 'chief'); await hasTools(stack, 'tracker');
  // The person turns push on for this device and sets the threshold; both are the page's own controls.
  await page.goto(stack.origin + '/?page=settings&group=assistants');
  const notify = page.getByRole('switch', { name: 'Notify me on this device', exact: true });
  await notify.click();
  await expect.poll(() => notify.getAttribute('aria-checked'), { timeout: 10_000 }).toBe('true');
  const thresholds = page.getByRole('form', { name: 'Tell me when a chain passes' });
  await thresholds.getByLabel('Reply depth').fill('1');
  await thresholds.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await (await context.request.get(stack.origin + status.basePath + 'v1/remote/chains')).json() as { thresholds: { depth?: number } }).thresholds.depth, { timeout: 10_000 }).toBe(1);
  expect(push.received()).toEqual([]);

  // The operating system ends the app: no page shows the chief's conversation while Chief asks and Tracker answers.
  await page.close();
  const sent = await stack.provider.useTool('chief', 'message', { to: 'Tracker', text: 'Is the release branch cut?' }) as { messageId: string; outcome: string };
  expect(sent.outcome).toBe('delivered');
  await expect.poll(() => inputs(stack, 'tracker').some(input => input.kind === 'assistant' && input.body === 'Is the release branch cut?'), { timeout: 20_000 }).toBe(true);
  await expect.poll(() => push.received().length, { timeout: 15_000 }).toBe(1);

  // The audit shows the chain as passed.
  const audit = await context.newPage();
  await audit.goto(stack.origin + '/?page=settings&group=assistants');
  await expect.poll(() => audit.locator('.lab-bot-audit > ul > li').filter({ hasText: 'Passed: Reply depth' }).count(), { timeout: 20_000 }).toBeGreaterThan(0);
  // Nothing stopped: the answer in the same chain is delivered, and it sends no second reminder.
  expect(await stack.provider.useTool('tracker', 'message', { to: 'Chief', text: 'Cut and tagged.', reply_to: sent.messageId })).toMatchObject({ outcome: 'delivered' });
  await expect.poll(() => inputs(stack, 'chief').some(input => input.kind === 'assistant' && input.body === 'Cut and tagged.'), { timeout: 20_000 }).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 1_500));
  const received = push.received();
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({ endpoint: subscription.endpoint, status: 201 });
  const [delivered] = await push.delivered(subscription.endpoint);
  expect(JSON.parse(delivered!.payload!)).toMatchObject({ v: 1, kind: 'needs_you', name: 'Chief' });
  expect(delivered!.payload).not.toMatch(/release branch|tagged/);
  await context.close();
});
