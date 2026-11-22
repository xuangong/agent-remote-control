// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { PushDevice, PushSubscriptionRequest } from '@orchardworks/agent-remote-protocol';
import { createPushDevice, pushAvailability, reconcilePush, type BrowserSubscription, type PushFacts, type PushRegistration } from './push-device.js';

const KEY = 'BJCvH34pg0ewCKH6gjeQ0zKQ5AVHcXEq9FAwfZ2q8QgvchIBo6aNBy69BP9Gu4ndH8GG7coRd_b2m8QvfdaK0T4';
const OTHER_KEY = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';
const DESKTOP: PushFacts = { serviceWorker: true, pushManager: true, notifications: true, ios: false, installed: false, permission: 'default', relayKey: true };

describe('where push works', () => {
  it.each([
    ['a desktop browser', {}, 'available'],
    ['an iPhone tab: only the app on the Home Screen', { ios: true, pushManager: false }, 'install'],
    ['an iPhone tab even where the browser has the API', { ios: true }, 'install'],
    ['the app on an iPhone\'s Home Screen', { ios: true, installed: true }, 'available'],
    ['the app on an older iPhone without push', { ios: true, installed: true, pushManager: false }, 'unsupported'],
    ['a page without its service worker (a development build)', { serviceWorker: false }, 'unsupported'],
    ['a browser without notifications', { notifications: false }, 'unsupported'],
    ['before the Relay answered', { relayKey: undefined }, 'checking'],
    ['a Relay that sends no pushes', { relayKey: false }, 'server'],
    ['a site whose notifications are blocked', { permission: 'denied' }, 'blocked'],
    ['a site that already allows them', { permission: 'granted' }, 'available'],
  ] as const)('%s: %s', (_name, change, availability) => {
    expect(pushAvailability({ ...DESKTOP, ...change } as PushFacts)).toBe(availability);
  });
});

describe('bringing the browser and the Relay together at a start', () => {
  const kept = { endpoint: 'https://fcm.googleapis.com/fcm/send/a', locale: 'en' as const };
  it.each([
    ['nothing kept: nothing to do', {}, { endpoint: kept.endpoint, key: KEY }, 'none'],
    ['both agree', { device: kept }, { endpoint: kept.endpoint, key: KEY }, 'none'],
    ['the browser dropped its subscription: the Relay forgets it', { device: kept }, undefined, 'forget'],
    ['made with an older key: subscribe again', { device: kept }, { endpoint: kept.endpoint, key: OTHER_KEY }, 'resubscribe'],
    ['a browser that does not say its key is taken at its word', { device: kept }, { endpoint: kept.endpoint }, 'none'],
    ['the browser has a new endpoint', { device: kept }, { endpoint: 'https://fcm.googleapis.com/fcm/send/b', key: KEY }, 'save'],
    ['the language changed', { device: { ...kept, locale: 'zh' as const } }, { endpoint: kept.endpoint, key: KEY }, 'save'],
    ['the switch changed', { device: { ...kept, paused: true as const } }, { endpoint: kept.endpoint, key: KEY }, 'save'],
  ] as const)('%s', (_name, relay, browser, action) => {
    expect(reconcilePush({ publicKey: KEY, ...relay }, browser, { locale: 'en', paused: false })).toBe(action);
  });
});

/** A browser with a push manager and a permission the test sets, and a Relay that keeps one record. */
function device(options: { permission?: NotificationPermission; registered?: boolean; browserKey?: string; held?: boolean; relayDevice?: PushDevice['device']; relayRefuses?: boolean } = {}) {
  const log: string[] = [];
  let permission: NotificationPermission = options.permission === 'granted' ? 'granted' : 'default';
  let browser: BrowserSubscription | null = null;
  const subscription = (endpoint: string, key: string): BrowserSubscription => ({ endpoint, options: { applicationServerKey: Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='), c => c.charCodeAt(0)).buffer },
    toJSON: () => ({ endpoint, keys: { p256dh: OTHER_KEY, auth: AUTH } }), unsubscribe: async () => { log.push(`unsubscribe ${endpoint}`); browser = null; return true; } });
  if (options.held) browser = subscription('https://fcm.googleapis.com/fcm/send/held', options.browserKey ?? KEY);
  let relay: PushDevice = { publicKey: KEY, ...(options.relayDevice ? { device: options.relayDevice } : {}) };
  const registration: PushRegistration = { pushManager: {
    getSubscription: async () => browser,
    subscribe: async ({ applicationServerKey }) => { log.push(`subscribe ${applicationServerKey.length}`); browser = subscription('https://fcm.googleapis.com/fcm/send/new', KEY); return browser; },
  } };
  let locale: 'en' | 'zh' = 'en', paused = false;
  const controller = createPushDevice({
    facts: () => ({ pushManager: true, notifications: true, ios: false, installed: false, permission }),
    relay: {
      device: async () => relay,
      subscribe: async (request: PushSubscriptionRequest) => {
        log.push(`save ${request.endpoint} ${request.locale}${request.paused ? ' paused' : ''}`);
        if (options.relayRefuses) throw Object.assign(new Error('refused'), { name: 'PushRequestError' });
        relay = { publicKey: KEY, device: { endpoint: request.endpoint, locale: request.locale, ...(request.paused ? { paused: true as const } : {}) } }; return relay;
      },
      unsubscribe: async () => { log.push('forget'); relay = { publicKey: KEY }; return relay; },
    },
    registration: async () => options.registered === false ? undefined : registration,
    requestPermission: async () => { log.push('permission'); permission = options.permission === 'denied' ? 'denied' : 'granted'; return permission; },
  }, { locale: () => locale, paused: () => paused });
  return { controller, log, setLocale: (next: 'en' | 'zh') => { locale = next; }, setPaused: (next: boolean) => { paused = next; }, browser: () => browser };
}

describe('one tap', () => {
  it('asks the permission before anything else, subscribes with the Relay\'s key and gives the Relay the subscription', async () => {
    const d = device();
    await d.controller.refresh();
    expect(d.controller.view()).toEqual({ availability: 'available', status: 'off' });
    const tap = d.controller.enable();
    expect(d.log).toEqual(['permission']);
    await tap;
    expect(d.log).toEqual(['permission', 'subscribe 65', 'save https://fcm.googleapis.com/fcm/send/new en']);
    expect(d.controller.view()).toEqual({ availability: 'available', status: 'on' });
  });

  it('reuses a subscription the browser holds with the Relay\'s key, and makes a new one for another key', async () => {
    const same = device({ held: true });
    await same.controller.enable();
    expect(same.log).toEqual(['permission', 'save https://fcm.googleapis.com/fcm/send/held en']);
    const older = device({ held: true, browserKey: OTHER_KEY });
    await older.controller.enable();
    expect(older.log).toEqual(['permission', 'unsubscribe https://fcm.googleapis.com/fcm/send/held', 'subscribe 65', 'save https://fcm.googleapis.com/fcm/send/new en']);
  });

  it('says why when the permission is refused, the browser cannot subscribe or the Relay refuses', async () => {
    const denied = device({ permission: 'denied' });
    await denied.controller.refresh();
    expect(denied.controller.view().availability).toBe('available');
    await denied.controller.enable();
    expect(denied.controller.view()).toMatchObject({ status: 'failed', failure: 'denied', availability: 'blocked' });
    const noWorker = device({ registered: false });
    await noWorker.controller.enable();
    expect(noWorker.controller.view()).toMatchObject({ status: 'failed', failure: 'subscribe' });
    const refused = device({ relayRefuses: true });
    await refused.controller.enable();
    expect(refused.controller.view()).toMatchObject({ status: 'failed', failure: 'relay' });
  });

  it('turns off: the Relay forgets the device and the browser drops its subscription', async () => {
    const d = device({ permission: 'granted' });
    await d.controller.enable();
    await d.controller.disable();
    expect(d.log.slice(-2)).toEqual(['forget', 'unsubscribe https://fcm.googleapis.com/fcm/send/new']);
    expect([d.controller.view().status, d.browser()]).toEqual(['off', null]);
  });
});

describe('a start and a change', () => {
  it('forgets at the Relay a subscription the browser no longer holds, and tells it a new language or switch', async () => {
    const dropped = device({ relayDevice: { endpoint: 'https://fcm.googleapis.com/fcm/send/old', locale: 'en' } });
    await dropped.controller.refresh();
    expect([dropped.log, dropped.controller.view().status]).toEqual([['forget'], 'off']);
    const d = device({ permission: 'granted' });
    await d.controller.enable();
    d.setLocale('zh'); d.setPaused(true);
    await d.controller.sync();
    expect(d.log.at(-1)).toBe('save https://fcm.googleapis.com/fcm/send/new zh paused');
  });
});
