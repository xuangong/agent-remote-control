// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { decodePushReminder, type SessionActivityState, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import type { PushMessage, PushOutcome } from './push-sender.js';
import { createPushReminders, type ReminderState } from './push-reminders.js';
import { createSessionPresence } from './session-presence.js';
import type { SavedPushSubscription } from '../state.js';

// The Relay's reminders over stub ports: the account's states, groups and devices are set by the test, and the sender records what
// it was asked to push. The decision itself is decidePush's table; this checks what the Relay feeds it and what it sends.
const KEYS = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
const NOW = 1_790_000_000_000;
const session = (nativeSessionId: string) => ({ hostId: 'host', providerId: 'codex', nativeSessionId });
const subscription = (device: string, extra: Partial<SavedPushSubscription> = {}): SavedPushSubscription =>
  ({ subject: 'alice', device, endpoint: `https://fcm.googleapis.com/fcm/send/${device}`, keys: KEYS, locale: 'en', createdAt: 1, updatedAt: 1, ...extra });
const group = (id: string, views: Array<[string, string]>, bots?: WindowGroup['bots'], presentation?: WindowGroup['presentation']): WindowGroup => ({
  window: { id, title: id, revision: 1, views: views.map(([viewId, nativeSessionId]) => ({ id: viewId, placement: 'primary', binding: { ...session(nativeSessionId), title: nativeSessionId } })) } as unknown as WindowGroup['window'],
  ...(bots ? { bots } : {}), ...(presentation ? { presentation } : {}) });

function relay(options: { groups?: WindowGroup[]; devices?: SavedPushSubscription[]; signedOut?: string[] } = {}) {
  let states: ReminderState[] = [];
  const pushed: Array<{ endpoint: string; message: PushMessage }> = [];
  const presence = createSessionPresence();
  const devices = options.devices ?? [subscription('phone')];
  const reminders = createPushReminders({
    sender: { deliver: async (target, message): Promise<PushOutcome> => { pushed.push({ endpoint: target.endpoint, message }); return { status: 'sent' }; } },
    subscriptions: { subjects: () => devices.length ? ['alice'] : [], list: subject => devices.filter(item => item.subject === subject) },
    presence, states: () => states, groups: () => options.groups ?? [group('g1', [['v1', 's1'], ['v2', 's2']], { rank: 'm', members: { v1: { name: 'Chief' } } })],
    signedIn: (_subject, device) => !options.signedOut?.includes(device), now: () => NOW,
  });
  return {
    reminders, pushed, presence,
    report(entries: Array<[string, SessionActivityState, number?]>) {
      states = entries.map(([id, state, updatedAt]) => ({ ...session(id), state, ...(updatedAt ? { updatedAt } : {}) }));
      return reminders.observe();
    },
    payloads: () => pushed.map(item => decodePushReminder(item.message.payload)),
  };
}

describe('what the Relay pushes', () => {
  it('pushes a needs-you reminder with the assistant\'s name, its address, the session\'s tag and the decision\'s time', async () => {
    const r = relay();
    expect(r.report([['s1', 'running']])).toEqual([]);
    expect(r.report([['s1', 'waiting']])).toEqual([{ subject: 'alice', session: session('s1'), kind: 'needs_you', devices: ['phone'] }]);
    await r.reminders.settled();
    expect(r.pushed).toHaveLength(1);
    const [{ message }] = r.pushed;
    const payload = r.payloads()[0]!;
    expect(payload).toEqual({ v: 1, kind: 'needs_you', name: 'Chief', locale: 'en', url: '/?mode=bot&section=g1&bot=v1', tag: payload.tag, at: NOW });
    expect(message).toMatchObject({ topic: payload.tag, ttlSeconds: 86_400, urgency: 'high' });
    expect(message.payload).not.toMatch(/s1|codex|host/);
  });

  it('pushes a finished turn at normal urgency, and an unnamed assistant by the name every device calls it, in the device\'s language', async () => {
    const r = relay({ devices: [subscription('phone', { locale: 'zh' }), subscription('desk')] });
    r.report([['s2', 'running']]);
    r.report([['s2', 'idle']]);
    await r.reminders.settled();
    expect(r.payloads().map(payload => [payload?.kind, payload?.locale])).toEqual([['finished', 'zh'], ['finished', 'en']]);
    const [chinese, english] = r.payloads().map(payload => payload!.name);
    expect(chinese).not.toBe(english);
    expect(r.pushed.map(item => item.message.urgency)).toEqual(['normal', 'normal']);
    expect(r.pushed[0]!.message.ttlSeconds).toBe(6 * 3600);
  });

  it('pushes nothing on the first sight of an account, for a session in no group, or for a change worth no reminder', async () => {
    const r = relay();
    expect(r.report([['s1', 'waiting'], ['s9', 'running']])).toEqual([]);
    expect(r.report([['s1', 'running'], ['s9', 'waiting']])).toEqual([]);
    expect(r.report([['s1', 'failed']])).toEqual([]);
    await r.reminders.settled();
    expect(r.pushed).toEqual([]);
  });

  it('pushes nothing while a visible page of the account shows the session, and again once it stops showing it', () => {
    const r = relay();
    r.report([['s1', 'running']]);
    let inUse = true;
    const release = r.presence.add('alice', session('s1'), () => inUse);
    expect(r.report([['s1', 'waiting', 1]])).toEqual([]);
    r.report([['s1', 'running', 2]]);
    inUse = false;
    expect(r.report([['s1', 'waiting', 3]])).toHaveLength(1);
    release();
    r.report([['s1', 'running', 4]]);
    expect(r.report([['s1', 'waiting', 5]])).toHaveLength(1);
    // Another account's page does not count.
    r.presence.add('bob', session('s1'), () => true);
    r.report([['s1', 'running', 6]]);
    expect(r.report([['s1', 'waiting', 7]])).toHaveLength(1);
  });

  it('pushes one reminder per session and state, and keeps a session\'s last state while it is not reported', () => {
    const r = relay();
    r.report([['s1', 'running', 1]]);
    expect(r.report([['s1', 'waiting', 2]])).toHaveLength(1);
    // The Host goes away and comes back in the same state: no news.
    expect(r.report([])).toEqual([]);
    expect(r.report([['s1', 'waiting', 2]])).toEqual([]);
    // The same state reported again after a flicker is not pushed twice.
    r.report([['s1', 'running', 2]]);
    expect(r.report([['s1', 'waiting', 2]])).toEqual([]);
  });

  it('follows the group\'s and the chat\'s settings and the devices\' own', () => {
    const muted = relay({ groups: [group('g1', [['v1', 's1']], { rank: 'm', members: { v1: { muted: true } } })] });
    muted.report([['s1', 'running']]);
    expect(muted.report([['s1', 'waiting']])).toEqual([]);
    const needsOnly = relay({ groups: [group('g1', [['v1', 's1']], { rank: 'm', members: {}, notifications: 'needs_you' })] });
    needsOnly.report([['s1', 'running']]);
    expect(needsOnly.report([['s1', 'idle']])).toEqual([]);
    const devices = relay({ devices: [subscription('phone', { paused: true }), subscription('desk'), subscription('old')], signedOut: ['old'] });
    devices.report([['s1', 'running']]);
    expect(devices.report([['s1', 'waiting']])[0]?.devices).toEqual(['desk']);
  });

  it('names a session by its view in a group shown in Bot mode before one hidden there', async () => {
    const r = relay({ groups: [group('hidden', [['h1', 's1']], { rank: 'a', members: { h1: { name: 'Hidden' } } }, { bots: false }), group('shown', [['v1', 's1']], { rank: 'b', members: { v1: { name: 'Shown' } } })] });
    r.report([['s1', 'running']]);
    r.report([['s1', 'waiting']]);
    await r.reminders.settled();
    expect(r.payloads()[0]).toMatchObject({ name: 'Shown', url: '/?mode=bot&section=shown&bot=v1' });
  });
});
