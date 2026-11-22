// Component projects: webkit-mobile
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { installLifecycle } from '@orchardworks/agent-e2e/lifecycle';

// Push notifications (I5c). The permission flow of Settings > Assistants, "Notify me on this device", on its fixture page with the Relay's
// answers routed; and the service worker's push and click handling in a real worker, with the installed app of the lifecycle simulator
// and an ended page for "no page runs". A headless browser has no push service and grants no notification permission, so the browser's
// push manager and its prompt are modelled (`modelPushBrowser`); the person's answer to the prompt is the test's.

const KEY = 'BJCvH34pg0ewCKH6gjeQ0zKQ5AVHcXEq9FAwfZ2q8QgvchIBo6aNBy69BP9Gu4ndH8GG7coRd_b2m8QvfdaK0T4';
const BROWSER_KEYS = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/component-device';
const iphone = (name: string) => name === 'webkit-mobile';
const SETTINGS = '/e2e/fixtures/push-settings.html';

/**
 * A browser with push: its permission prompt answers `answer`, and its push manager subscribes at ENDPOINT; the app's worker is registered.
 * `pushApi: false` is a browser without the Push API, as an iPhone's Safari tab is: iOS (16.4 and later) gives it only to the installed app.
 */
async function modelPushBrowser(page: Page, answer: 'granted' | 'denied', pushApi = true) {
  await page.addInitScript(({ endpoint, keys, answer, pushApi }) => {
    // iOS gives the Push and Notifications APIs only to the installed app; WebKit's iPhone emulation has neither in any page.
    if (!pushApi) { Reflect.deleteProperty(window, 'PushManager'); Reflect.deleteProperty(window, 'Notification'); }
    else {
      if (!('PushManager' in window)) Object.defineProperty(window, 'PushManager', { configurable: true, value: class PushManager {} });
      if (!('Notification' in window)) Object.defineProperty(window, 'Notification', { configurable: true, writable: true, value: class Notification {} });
    }
    const state = { permission: 'default' as NotificationPermission, prompts: 0, keys: [] as number[], subscription: null as unknown };
    Object.defineProperty(window, '__pushModel', { value: state });
    if (!pushApi) return;
    Object.defineProperty(Notification, 'permission', { configurable: true, get: () => state.permission });
    Notification.requestPermission = async () => { state.prompts += 1; state.permission = answer; return state.permission; };
    const subscription = (key: ArrayBuffer) => ({ endpoint, options: { applicationServerKey: key }, toJSON: () => ({ endpoint, keys }),
      unsubscribe: async () => { state.subscription = null; return true; } });
    const pushManager = { getSubscription: async () => state.subscription,
      subscribe: async (options: { applicationServerKey: Uint8Array }) => { state.keys.push(options.applicationServerKey.length); state.subscription = subscription(options.applicationServerKey.slice().buffer); return state.subscription; } };
    // The production build registers the app's worker; this development build does not, so the registration is modelled too.
    if (navigator.serviceWorker) navigator.serviceWorker.getRegistration = async () => ({ pushManager }) as unknown as ServiceWorkerRegistration;
  }, { endpoint: ENDPOINT, keys: BROWSER_KEYS, answer, pushApi });
}

/** The Relay's answers for alice's push subscriptions, kept as the Relay keeps them. */
async function routeRelay(page: Page, options: { publicKey?: string } = { publicKey: KEY }) {
  const saved: unknown[] = [];
  let device: Record<string, unknown> | undefined;
  await page.route('**/u/alice/v1/push-subscriptions', async route => {
    const method = route.request().method();
    if (method === 'POST') { const body = route.request().postDataJSON() as Record<string, unknown>; saved.push(body); device = { endpoint: body.endpoint, locale: body.locale, ...(body.paused ? { paused: true } : {}) }; }
    if (method === 'DELETE') { saved.push('forget'); device = undefined; }
    await route.fulfill({ json: { ...(options.publicKey ? { publicKey: options.publicKey } : {}), ...(device ? { device } : {}) } });
  });
  return { saved };
}

const pushRow = (page: Page) => page.locator('.lab-setting-row').filter({ hasText: 'Notify me on this device' });
const pushSwitch = (page: Page) => pushRow(page).getByRole('switch', { name: 'Notify me on this device' });
const model = (page: Page) => page.evaluate(() => (window as unknown as { __pushModel: { prompts: number; keys: number[]; subscription: unknown } }).__pushModel)
  .then(state => ({ prompts: state.prompts, keys: state.keys, subscribed: !!state.subscription }));

test.describe('Notify me on this device', () => {
  test('one tap asks the browser, subscribes with the Relay\'s key and turns on; another turns it off', async ({ page }, info) => {
    test.skip(iphone(info.project.name), 'A browser tab on an iPhone has no push; the installed app has its own test.');
    await modelPushBrowser(page, 'granted');
    const relay = await routeRelay(page);
    await page.goto(SETTINGS);
    await expect(pushSwitch(page)).toHaveAttribute('aria-checked', 'false');
    await pushSwitch(page).click();
    await expect(pushSwitch(page)).toHaveAttribute('aria-checked', 'true');
    expect(await model(page)).toEqual({ prompts: 1, keys: [65], subscribed: true });
    expect(relay.saved).toEqual([{ endpoint: ENDPOINT, keys: BROWSER_KEYS, locale: 'en' }]);
    await page.screenshot({ path: info.outputPath('push-on.png') });
    await pushSwitch(page).click();
    await expect(pushSwitch(page)).toHaveAttribute('aria-checked', 'false');
    await expect(pushSwitch(page)).toBeEnabled();
    expect(relay.saved.at(-1)).toBe('forget');
    expect((await model(page)).subscribed).toBe(false);
  });

  test('a refused prompt says notifications are blocked, and nothing is subscribed', async ({ page }, info) => {
    test.skip(iphone(info.project.name), 'A browser tab on an iPhone has no push.');
    await modelPushBrowser(page, 'denied');
    const relay = await routeRelay(page);
    await page.goto(SETTINGS);
    await pushSwitch(page).click();
    await expect(page.locator('.lab-setting-note[data-push-note]')).toHaveText(/Notifications are blocked for this site/);
    expect(await model(page)).toEqual({ prompts: 1, keys: [], subscribed: false });
    expect(relay.saved).toEqual([]);
  });

  test('a Relay that sends no pushes is said to, with no switch', async ({ page }, info) => {
    test.skip(iphone(info.project.name), 'The iPhone tests cover the tab and the installed app.');
    await modelPushBrowser(page, 'granted');
    await routeRelay(page, {});
    await page.goto(SETTINGS);
    await expect(page.locator('.lab-setting-note[data-push-note="server"]')).toHaveText('This server does not send notifications.');
    await expect(pushSwitch(page)).toHaveCount(0);
  });

  test('on an iPhone, a browser tab explains the Home Screen, and the installed app turns push on', async ({ browser }, info) => {
    test.skip(!iphone(info.project.name), 'An iPhone\'s rule.');
    const tab = await browser.newPage({ ...info.project.use });
    await modelPushBrowser(tab, 'granted', false);
    await routeRelay(tab);
    await installLifecycle(tab);
    await tab.goto(SETTINGS);
    await expect(tab.locator('.lab-setting-note[data-push-note="install"]')).toHaveText(/only Orchard on the Home Screen can notify you/);
    await expect(pushSwitch(tab)).toHaveCount(0);
    await tab.screenshot({ path: info.outputPath('iphone-tab.png') });
    await tab.close();
    const installed = await browser.newPage({ ...info.project.use });
    await modelPushBrowser(installed, 'granted');
    const relay = await routeRelay(installed);
    await installLifecycle(installed, { standalone: true });
    await installed.goto(SETTINGS);
    await pushSwitch(installed).click();
    await expect(pushSwitch(installed)).toHaveAttribute('aria-checked', 'true');
    expect(relay.saved).toEqual([{ endpoint: ENDPOINT, keys: BROWSER_KEYS, locale: 'en' }]);
    await installed.screenshot({ path: info.outputPath('iphone-installed.png') });
    await installed.close();
  });
});

const CHIEF = '/?mode=bot&section=team&bot=chief';
const FIXTURE = '/e2e/fixtures/orchard-primitives.html';

/** The test worker, registered for the fixture pages and controlling `page`; Chromium hands the test its scope. */
async function pushWorker(context: BrowserContext, page: Page) {
  await page.evaluate(async () => { await navigator.serviceWorker.register('/e2e/fixtures/push-sw.ts', { type: 'module', scope: '/e2e/fixtures/' }); await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const worker = context.serviceWorkers().find(each => each.url().includes('/e2e/fixtures/push-sw.ts')) ?? await context.waitForEvent('serviceworker');
  return {
    worker,
    record: () => worker.evaluate(() => (self as unknown as { __push: { record: unknown[] } }).__push.record),
    click: (data: unknown) => worker.evaluate(value => (self as unknown as { __push: { click(data: unknown): Promise<unknown> } }).__push.click(value), data),
  };
}

test.describe('a reminder in the service worker', () => {
  test.beforeEach(({ browserName }) => { test.skip(browserName !== 'chromium', 'Only Chromium hands a test its service worker and delivers a push to it.'); });

  test('a push shows the assistant\'s name and the kind in the device\'s language, and sets the badge\'s dot', async ({ page, context }) => {
    await installLifecycle(page, { standalone: true });
    await page.goto(`${FIXTURE}?mode=window`);
    const sw = await pushWorker(context, page);
    const cdp = await context.newCDPSession(page);
    const registrations = new Promise<Array<{ registrationId: string; scopeURL: string }>>(resolve => cdp.on('ServiceWorker.workerRegistrationUpdated', event => resolve(event.registrations)));
    await cdp.send('ServiceWorker.enable');
    const registration = (await registrations).find(each => each.scopeURL.endsWith('/e2e/fixtures/'))!;
    const origin = new URL(page.url()).origin;
    const deliver = (reminder: Record<string, unknown>) => cdp.send('ServiceWorker.deliverPushMessage', { origin, registrationId: registration.registrationId, data: JSON.stringify(reminder) });
    await deliver({ v: 1, kind: 'needs_you', name: 'Chief', locale: 'en', url: CHIEF, tag: 'schief', at: 1 });
    await deliver({ v: 1, kind: 'finished', name: '团团', locale: 'zh', url: '/?mode=bot&section=team&bot=dango', tag: 'sdango', at: 2 });
    await deliver({ text: 'not a reminder' });
    await expect.poll(sw.record).toEqual([
      { type: 'show', title: 'Chief needs you', tag: 'schief', data: { url: CHIEF, at: 1, kind: 'needs_you' }, lang: 'en' }, { type: 'badge' },
      { type: 'show', title: '团团 做完了', tag: 'sdango', data: { url: '/?mode=bot&section=team&bot=dango', at: 2, kind: 'finished' }, lang: 'zh-CN' }, { type: 'badge' },
      { type: 'show', title: 'Orchard', tag: 'orchard', data: { url: '/', at: 0 } }, { type: 'badge' },
    ]);
  });

  test('a click focuses the installed app\'s page that shows the conversation, takes another there, and opens one when no page runs', async ({ page, context }) => {
    const lifecycle = await installLifecycle(page, { standalone: true });
    await page.goto(`${FIXTURE}${CHIEF}`.replace('/?', '?'));
    const sw = await pushWorker(context, page);
    const origin = new URL(page.url()).origin;
    // The installed app shows Chief: the click focuses it.
    await sw.click({ url: CHIEF });
    expect(await sw.record()).toEqual([{ type: 'focus', url: page.url() }]);
    // The app shows another place: the click takes it to Chief's conversation.
    await page.goto(`${FIXTURE}?mode=window`);
    await sw.click({ url: CHIEF });
    await page.waitForURL(`${origin}${CHIEF}`);
    // The operating system ended the app: no page runs, so the click opens the conversation.
    await lifecycle.kill();
    await expect.poll(() => sw.worker.evaluate(async () => (await (self as unknown as { clients: { matchAll(options: object): Promise<unknown[]> } }).clients.matchAll({ type: 'window', includeUncontrolled: true })).length)).toBe(0);
    await sw.click({ url: CHIEF });
    expect((await sw.record()).at(-1)).toEqual({ type: 'open', url: `${origin}${CHIEF}` });
  });
});
