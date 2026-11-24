// The browser's push as a headless browser cannot give it, shared by the flows that run the Relay's push reminders on the push service simulator.
import type { Page } from '@playwright/test';
import type { SimulatedSubscription } from '@orchardworks/agent-remote-fixtures/push-service';

/** The browser's push as a headless browser cannot give it: the prompt answers "allow" and the push manager subscribes at the simulator. */
export async function modelBrowserPush(page: Page, subscription: SimulatedSubscription): Promise<void> {
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
