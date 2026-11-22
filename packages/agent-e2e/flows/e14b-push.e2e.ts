// E14b, push reminders of the installed app (I5c), on the real stack with the push service simulator in place of the browsers' push
// services. A person turns on "Notify me on this device" in Settings > Assistants. While the page shows the assistant, it asks for an
// approval: the page shows it and no push goes out. The person allows it and the app is ended by the operating system; the assistant
// asks again with no page running: exactly one push reaches the push service, signed by the Relay for it, which the browser's keys
// decrypt to the assistant's name and "needs you", and nothing of the conversation. A headless browser has no push service, so the
// browser's push manager hands out the simulator's subscription and its permission prompt is answered "allow".
// `E2E_BROWSER=webkit` runs it in WebKit.
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startStack, type ScriptedStep, type Stack } from '@orchardworks/agent-e2e/stack';
import { startPushService, type PushService, type SimulatedSubscription } from '@orchardworks/agent-remote-fixtures/push-service';
import { launchBrowser, openPage } from './browser.js';
import { goTo, openSettings, send, waitForEntries } from './page.js';

let stack: Stack; let browser: Browser; let push: PushService;
const PROMPT = 'Deploy the site';
/** The turn the prompt starts: an approval the page answers, a build that outlasts the page, and an approval asked with no page running. */
const turns = (text: string): ScriptedStep[] => text === PROMPT ? [
  { approval: 'Deploy?', command: 'deploy --staging' },
  { tool: 'Bash', input: 'npm run build', output: 'Built', ms: 3_000 },
  { approval: 'Publish?', command: 'deploy --production' },
] : [];

beforeAll(async () => {
  push = await startPushService();
  stack = await startStack({ turns, pushServices: [push.origin], sessions: { site: { title: 'Site', history: [{ role: 'user', text: 'Hello' }, { role: 'assistant', text: 'Ready to deploy.' }] } } });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); await stack?.close(); await push?.close(); });

/** The browser's push as a headless browser cannot give it: the prompt answers "allow" and the push manager subscribes at the simulator. */
async function modelBrowserPush(page: Page, subscription: SimulatedSubscription): Promise<void> {
  await page.addInitScript(({ endpoint, keys }) => {
    const allowed = 'arc-e2e:notification-permission';
    Object.defineProperty(Notification, 'permission', { configurable: true, get: () => localStorage.getItem(allowed) ?? 'default' });
    Notification.requestPermission = async () => { localStorage.setItem(allowed, 'granted'); return 'granted'; };
    // The browser keeps its subscription across the page's loads, as a real one does.
    const kept = 'arc-e2e:push-subscription';
    const made = (key: number[]) => ({ endpoint, options: { applicationServerKey: new Uint8Array(key).buffer }, toJSON: () => ({ endpoint, keys }),
      unsubscribe: async () => { localStorage.removeItem(kept); return true; } });
    PushManager.prototype.getSubscription = async () => { const key = localStorage.getItem(kept); return (key ? made(JSON.parse(key)) : null) as PushSubscription | null; };
    PushManager.prototype.subscribe = async (options?: PushSubscriptionOptionsInit) => {
      const key = [...options!.applicationServerKey as Uint8Array];
      localStorage.setItem(kept, JSON.stringify(key));
      return made(key) as unknown as PushSubscription;
    };
  }, subscription);
}

it('E14b: a need with no page running sends exactly one push, named for the assistant; a page that shows the session sends none', async () => {
  // The Relay's key, which the browser's subscription is made with.
  const status = await (await fetch(`${stack.origin}/auth/status`)).json() as { basePath?: string };
  expect(status.basePath).toMatch(/^\/u\//);
  const { context, page } = await openPage(browser, stack.sessionUrl('site'));
  const relay = await (await context.request.get(`${stack.origin}${status.basePath}v1/push-subscriptions`)).json() as { publicKey: string };
  const subscription = await push.subscribe({ applicationServerKey: relay.publicKey });
  await modelBrowserPush(page, subscription);
  await page.reload();
  await waitForEntries(page, 2);
  const name = (await page.locator('.lab-tile-name:visible').first().innerText()).trim();

  // One tap in Settings > Assistants turns push on for this device.
  await openSettings(page, 'Assistants');
  const notify = page.getByRole('switch', { name: 'Notify me on this device', exact: true });
  await notify.click();
  await expect.poll(() => notify.getAttribute('aria-checked'), { timeout: 10_000 }).toBe('true');
  // The assistant's conversation in Chats, whose row shows what the Relay shares of its state.
  await goTo(page, 'Chats');
  const row = page.locator('.lab-bot-row').filter({ hasText: name }).first();
  await row.click();
  await waitForEntries(page, 2);

  // The assistant asks while the page shows it: once the Relay has the need (the row says so), still no push has gone out.
  await send(page, PROMPT);
  const card = page.locator('.agent-turn').last().locator('.agent-turn-requests .agent-tool-approval');
  await card.waitFor({ timeout: 15_000 });
  await expect.poll(() => row.getAttribute('data-state'), { timeout: 15_000 }).toBe('needs_you');
  expect(push.received()).toEqual([]);

  // The person allows it, and the operating system ends the app while the build runs: no page runs when the assistant asks again.
  await card.getByRole('button', { name: 'Allow', exact: true }).click();
  await card.waitFor({ state: 'detached', timeout: 10_000 });
  await context.close();
  await expect.poll(() => push.received().length, { timeout: 15_000 }).toBe(1);
  await new Promise(resolve => setTimeout(resolve, 1_500));
  const received = push.received();
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({ endpoint: subscription.endpoint, status: 201, headers: { urgency: 'high', contentEncoding: 'aes128gcm' },
    vapid: { publicKey: relay.publicKey, claims: { aud: push.origin } } });
  const [delivered] = await push.delivered(subscription.endpoint);
  const reminder = JSON.parse(delivered!.payload!) as Record<string, unknown>;
  expect(reminder).toEqual({ v: 1, kind: 'needs_you', name, locale: 'en', url: expect.stringMatching(/^\/\?mode=bot&section=[^&]+&bot=[^&]+$/), tag: received[0]!.headers.topic, at: expect.any(Number) });
  expect(delivered!.payload).not.toMatch(/Deploy|deploy|Publish|Site|Ready/);
});
