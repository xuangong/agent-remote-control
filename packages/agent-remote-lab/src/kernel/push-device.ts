/**
 * "Notify me on this device" (Settings > Assistants, I5c): this device's Web Push subscription, so the Relay reaches it when no page of
 * Orchard runs. The rules are pure; `createPushDevice` drives them over ports (the browser's push manager and permission, the Relay).
 * - Where push works (`pushAvailability`): a desktop or Android browser with a service worker and the Push API, and on an iPhone or iPad
 *   only the app added to the home screen, which is Apple's rule. Elsewhere Settings says why it does not.
 * - One tap (`enable`) asks the browser's permission first, while the tap still counts as the person's gesture, then subscribes with the
 *   Relay's VAPID key and gives the subscription to the Relay with the device's language and its own Notifications switch.
 * - Each page start reconciles the browser's subscription with what the Relay keeps (`reconcilePush`): a subscription the browser no
 *   longer holds is forgotten, one made with an older key is made again, and a new endpoint, language or switch is told to the Relay.
 */
import type { PushDevice, PushLocale, PushSubscriptionRequest } from '@orchardworks/agent-remote-protocol';

/** Whether this device can turn push on, or why it cannot. */
export type PushAvailability = 'checking' | 'available' | 'install' | 'unsupported' | 'blocked' | 'server';

/** What the page knows of this browser and of the Relay. */
export interface PushFacts {
  /** A secure origin with a service worker registered (a production build), and the Push and Notifications APIs. */
  readonly serviceWorker: boolean;
  readonly pushManager: boolean;
  readonly notifications: boolean;
  /** An iPhone or iPad, where only the app added to the home screen receives pushes. */
  readonly ios: boolean;
  readonly installed: boolean;
  readonly permission: NotificationPermission;
  /** The Relay sends pushes (it has a key), does not, or has not said yet. */
  readonly relayKey?: boolean;
}

export function pushAvailability(facts: PushFacts): PushAvailability {
  if (facts.ios && !facts.installed) return 'install';
  if (!facts.serviceWorker || !facts.pushManager || !facts.notifications) return 'unsupported';
  if (facts.relayKey === undefined) return 'checking';
  if (!facts.relayKey) return 'server';
  if (facts.permission === 'denied') return 'blocked';
  return 'available';
}

/** The browser's subscription as reconciling reads it. */
export interface BrowserPush { readonly endpoint: string; readonly key?: string }
/** What a page start does about this device's subscription. */
export type PushReconcile = 'none' | 'forget' | 'resubscribe' | 'save';

/**
 * What the page does with the Relay's record of this device and the browser's subscription: nothing when they agree, forget the record
 * the browser no longer backs, subscribe again when the browser's was made with another key, and save what changed.
 */
export function reconcilePush(relay: PushDevice, browser: BrowserPush | undefined, wanted: { locale: PushLocale; paused: boolean }): PushReconcile {
  const kept = relay.device;
  if (!kept) return 'none';
  if (!browser) return 'forget';
  if (relay.publicKey && browser.key && browser.key !== relay.publicKey) return 'resubscribe';
  if (browser.endpoint !== kept.endpoint || kept.locale !== wanted.locale || !!kept.paused !== wanted.paused) return 'save';
  return 'none';
}

/** A subscription as the browser hands it out. */
export interface BrowserSubscription {
  readonly endpoint: string;
  readonly options?: { readonly applicationServerKey?: ArrayBuffer | null };
  toJSON(): { endpoint?: string; keys?: Record<string, string> };
  unsubscribe(): Promise<boolean>;
}
export interface PushRegistration {
  readonly pushManager: {
    getSubscription(): Promise<BrowserSubscription | null>;
    subscribe(options: { userVisibleOnly: true; applicationServerKey: Uint8Array }): Promise<BrowserSubscription>;
  };
}
export interface PushPorts {
  /** The browser's facts; whether a worker is registered and what the Relay says, the controller finds out itself. */
  facts(): Omit<PushFacts, 'relayKey' | 'serviceWorker'>;
  readonly relay: { device(): Promise<PushDevice>; subscribe(request: PushSubscriptionRequest): Promise<PushDevice>; unsubscribe(): Promise<PushDevice> };
  /** The page's service worker registration, when it has one. */
  registration(): Promise<PushRegistration | undefined>;
  requestPermission(): Promise<NotificationPermission>;
}
export interface PushSettings { locale(): PushLocale; paused(): boolean }

export type PushStatus = 'checking' | 'off' | 'on' | 'working' | 'failed';
export interface PushDeviceView {
  readonly availability: PushAvailability;
  readonly status: PushStatus;
  /** Why the last tap did not turn push on: the browser's permission was refused, the browser could not subscribe, or the Relay refused. */
  readonly failure?: 'denied' | 'subscribe' | 'relay';
}

const toBase64url = (bytes: ArrayBuffer | Uint8Array) => {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromBase64url = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), character => character.charCodeAt(0));
const browserPush = (subscription: BrowserSubscription | null | undefined): BrowserPush | undefined => subscription ? {
  endpoint: subscription.endpoint, ...(subscription.options?.applicationServerKey ? { key: toBase64url(subscription.options.applicationServerKey) } : {}) } : undefined;

export type PushDeviceController = ReturnType<typeof createPushDevice>;

export function createPushDevice(ports: PushPorts, settings: PushSettings) {
  let view: PushDeviceView = { availability: 'checking', status: 'checking' };
  let relay: PushDevice | undefined;
  let registered = false;
  const listeners = new Set<() => void>();
  const set = (next: Partial<PushDeviceView>) => {
    const { failure: _failure, ...rest } = view;
    view = { ...rest, ...next, availability: pushAvailability({ ...ports.facts(), serviceWorker: registered, ...(relay ? { relayKey: !!relay.publicKey } : {}) }) };
    for (const listener of listeners) listener();
  };
  const request = (subscription: BrowserSubscription): PushSubscriptionRequest => {
    const json = subscription.toJSON();
    return { endpoint: subscription.endpoint, keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' }, locale: settings.locale(), ...(settings.paused() ? { paused: true as const } : {}) };
  };
  const registration = async () => {
    const found = await ports.registration().catch(() => undefined);
    registered = !!found;
    return found;
  };
  const current = async () => (await registration())?.pushManager.getSubscription().catch(() => null) ?? null;
  async function subscribeAgain(target: PushRegistration, key: string, old: BrowserSubscription | null): Promise<void> {
    await old?.unsubscribe().catch(() => false);
    const fresh = await target.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64url(key) });
    relay = await ports.relay.subscribe(request(fresh));
  }

  return {
    view: (): PushDeviceView => view,
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Asks the Relay and the browser, and brings them together (`reconcilePush`). */
    async refresh(): Promise<void> {
      const browser = await current();
      try { relay = await ports.relay.device(); } catch { set({ status: view.status === 'checking' ? 'off' : view.status }); return; }
      const action = reconcilePush(relay, browserPush(browser), { locale: settings.locale(), paused: settings.paused() });
      try {
        if (action === 'forget') relay = await ports.relay.unsubscribe();
        else if (action === 'save' && browser) relay = await ports.relay.subscribe(request(browser));
        else if (action === 'resubscribe' && relay.publicKey) { const target = await registration(); if (target) await subscribeAgain(target, relay.publicKey, browser); }
      } catch { /* The next start tries again; the Relay's record stays as it was. */ }
      set({ status: relay.device ? 'on' : 'off' });
    },
    /** The one tap: the permission first, while the tap is the person's gesture, then the subscription. */
    async enable(): Promise<void> {
      const asking = ports.requestPermission();
      set({ status: 'working' });
      const permission = await asking.catch(() => 'default' as NotificationPermission);
      if (permission !== 'granted') { set(permission === 'denied' ? { status: 'failed', failure: 'denied' } : { status: 'off' }); return; }
      try {
        relay ??= await ports.relay.device();
        const target = await registration();
        if (!relay.publicKey || !target) { set({ status: 'failed', failure: 'subscribe' }); return; }
        const existing = await target.pushManager.getSubscription().catch(() => null);
        const browser = browserPush(existing);
        if (existing && (!browser?.key || browser.key === relay.publicKey)) relay = await ports.relay.subscribe(request(existing));
        else await subscribeAgain(target, relay.publicKey, existing);
        set({ status: 'on' });
      } catch (error) {
        set({ status: 'failed', failure: error instanceof Error && error.name === 'PushRequestError' ? 'relay' : 'subscribe' });
      }
    },
    /** Turns push off on this device: the Relay forgets it, and the browser drops its subscription. */
    async disable(): Promise<void> {
      set({ status: 'working' });
      try { relay = await ports.relay.unsubscribe(); } catch { set({ status: 'on' }); return; }
      await (await current())?.unsubscribe().catch(() => false);
      set({ status: 'off' });
    },
    /** Tells the Relay this device's language or switch changed, while push is on. */
    async sync(): Promise<void> {
      if (view.status !== 'on') return;
      const browser = await current();
      if (!browser) return;
      try { relay = await ports.relay.subscribe(request(browser)); } catch { /* Told again at the next start. */ }
      set({});
    },
  };
}
