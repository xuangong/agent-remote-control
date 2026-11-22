import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { isPushDevice, isPushSubscriptionRequest, PushReminderSchema } from './push-notifications.js';
import { assistantAddress, decodePushReminder, encodePushReminder, pushReminderKind, pushTag, type PushReminder } from './push-reminder.js';

const KEYS = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
const REMINDER: PushReminder = { v: 1, kind: 'needs_you', name: 'Chief', locale: 'en', url: '/?mode=bot&section=g1&bot=v1', tag: 'sabc', at: 1_790_000_000_000 };

describe('a subscription request', () => {
  it('takes the browser\'s subscription with the device\'s language and switch', () => {
    expect(isPushSubscriptionRequest({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: KEYS, locale: 'zh' })).toBe(true);
    expect(isPushSubscriptionRequest({ endpoint: 'https://web.push.apple.com/abc', keys: KEYS, locale: 'en', paused: true })).toBe(true);
  });
  it.each([
    ['no keys', { endpoint: 'https://fcm.googleapis.com/x/abc', locale: 'en' }],
    ['a public key that is no 65-byte point', { endpoint: 'https://fcm.googleapis.com/x/abc', keys: { ...KEYS, p256dh: KEYS.auth }, locale: 'en' }],
    ['an auth secret of another length', { endpoint: 'https://fcm.googleapis.com/x/abc', keys: { ...KEYS, auth: `${KEYS.auth}AA` }, locale: 'en' }],
    ['an endpoint that is no URL', { endpoint: 'fcm.googleapis.com/abc', keys: KEYS, locale: 'en' }],
    ['a language the reminders do not speak', { endpoint: 'https://fcm.googleapis.com/x/abc', keys: KEYS, locale: 'fr' }],
    ['paused false', { endpoint: 'https://fcm.googleapis.com/x/abc', keys: KEYS, locale: 'en', paused: false }],
    ['another field', { endpoint: 'https://fcm.googleapis.com/x/abc', keys: KEYS, locale: 'en', expirationTime: null }],
  ])('refuses %s', (_name, value) => { expect(isPushSubscriptionRequest(value)).toBe(false); });
  it('says what the Relay keeps of the device', () => {
    expect(isPushDevice({})).toBe(true);
    expect(isPushDevice({ publicKey: KEYS.p256dh, device: { endpoint: 'https://fcm.googleapis.com/x/abc', locale: 'en' } })).toBe(true);
    expect(isPushDevice({ publicKey: 'short' })).toBe(false);
  });
});

describe('a reminder\'s payload', () => {
  const INVALID = [{ ...REMINDER, v: 2 }, { ...REMINDER, kind: 'message' }, { ...REMINDER, preview: 'Deploy the site?' }, { ...REMINDER, url: 'https://evil.example/' },
    { ...REMINDER, url: '/?a b' }, { ...REMINDER, tag: 'x'.repeat(33) }, { ...REMINDER, name: '' }, { ...REMINDER, name: 'x'.repeat(81) }, { ...REMINDER, locale: 'fr' },
    { ...REMINDER, at: -1 }, { ...REMINDER, at: 1.5 }, (({ at: _at, ...rest }) => rest)(REMINDER), [REMINDER], null];
  it('reads back what was written, and nothing else', () => {
    expect(decodePushReminder(encodePushReminder(REMINDER))).toEqual(REMINDER);
    for (const text of [undefined, '', 'not json', ...INVALID.map(value => JSON.stringify(value))]) expect(decodePushReminder(text)).toBeUndefined();
  });
  it('reads exactly what its schema accepts, though it reads without the schema library', () => {
    for (const value of [REMINDER, { ...REMINDER, kind: 'finished', locale: 'zh', name: 'x'.repeat(80) }, ...INVALID]) {
      expect(decodePushReminder(JSON.stringify(value)) !== undefined, JSON.stringify(value)).toBe(Value.Check(PushReminderSchema, value));
    }
  });
  it('maps a page\'s reminders to its kinds', () => {
    expect([pushReminderKind('waiting'), pushReminderKind('idle')]).toEqual(['needs_you', 'finished']);
  });
  it('tags a session the same every time, apart from every other session, within a push service\'s Topic', () => {
    const session = { hostId: 'host-1', providerId: 'codex', nativeSessionId: 'thread-1' };
    expect(pushTag(session)).toBe(pushTag({ ...session }));
    expect(pushTag(session)).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    expect(new Set(Array.from({ length: 500 }, (_, index) => pushTag({ ...session, nativeSessionId: `thread-${index}` }))).size).toBe(500);
    expect(pushTag({ hostId: 'a', providerId: 'b', nativeSessionId: 'c' })).not.toBe(pushTag({ hostId: 'a', providerId: 'bc', nativeSessionId: '' }));
  });
  it('addresses an assistant\'s conversation as Bot mode writes it', () => {
    expect(assistantAddress('group:1', 'view-2')).toBe('/?mode=bot&section=group%3A1&bot=view-2');
  });
});
