import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { botGroup, botTarget, mountBotApp, seedGroup, until } from './test/bot-mode-fixtures.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/'); });

const host = { hostId: 'local', online: true, confirmedAgeMs: 0 };
const state = (id: string, value: 'running' | 'waiting' | 'idle', extra: { replyAt?: number; preview?: string } = {}) => {
  const { title: _title, ...session } = botTarget(id);
  return { ...session, state: value, ageMs: 0, ...extra };
};

it('follows bots through the shared channel without a stream each and reminds of the ones not on screen', async () => {
  const scope = 'http://localhost/u/bot-shared-attention/';
  seedGroup(scope, botGroup('A')); history.replaceState(null, '', '/?window=A');
  const notices: Array<{ title: string; options: NotificationOptions }> = [];
  vi.stubGlobal('Notification', class { static permission = 'granted'; close() {} constructor(readonly title: string, readonly options: NotificationOptions) { notices.push(this); } });
  const app = await mountBotApp(scope, { hosted: true });
  const status = (name: string) => [...app.container.querySelectorAll<HTMLElement>('[aria-label="Bots"] .lab-bot-row')]
    .find(row => row.querySelector('.lab-bot-name')?.textContent === name)?.querySelector('.lab-bot-status')?.textContent ?? '';
  try {
    await until(() => expect(app.workspace().window?.id).toBe('A'));
    await app.switchMode('bot');
    await act(async () => app.button('A1').click());
    await until(() => expect(app.container.querySelector('.lab-bot-conversation [role="textbox"]')).not.toBeNull());
    await act(async () => app.emitStates({ snapshot: true, hosts: [host], states: [state('A1', 'running'), state('A2', 'running')] }));
    await until(() => expect(status('A2')).toBe('Working'));
    // No bot is followed through a stream of its own.
    expect(app.activityListeners.size).toBe(0);
    await act(async () => app.emitStates({ states: [state('A1', 'idle', { replyAt: 5, preview: 'Done.' }), state('A2', 'waiting')] }));
    await until(() => expect(status('A2')).toBe('Needs you'));
    // A1 is on screen: no reminder for it.
    await until(() => expect(notices.map(notice => [notice.title, notice.options.body])).toEqual([['Session needs your input', 'A2']]));
    await act(async () => app.emitStates({ states: [state('A2', 'running')] }));
    await act(async () => app.emitStates({ states: [state('A2', 'idle', { replyAt: 9, preview: 'Shipped.' })] }));
    await until(() => expect(notices.map(notice => notice.title)).toEqual(['Session needs your input', 'Session completed']));
  } finally { await app.close(); }
});

it("shows each bot's latest reply and time, a dot while it is unread, and marks it read once its conversation is on screen", async () => {
  const scope = 'http://localhost/u/bot-unread/';
  seedGroup(scope, botGroup('A')); history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope, { hosted: true });
  const row = (name: string) => [...app.container.querySelectorAll<HTMLElement>('[aria-label="Bots"] .lab-bot-row')]
    .find(item => item.querySelector('.lab-bot-name')?.textContent === name);
  try {
    await until(() => expect(app.workspace().window?.id).toBe('A'));
    await app.switchMode('bot');
    const today = new Date(); today.setHours(10, 42, 0, 0);
    await act(async () => {
      app.emitReads({ snapshot: true, since: today.getTime() - 60_000, reads: [] });
      app.emitStates({ snapshot: true, hosts: [host], states: [state('A1', 'idle', { replyAt: today.getTime(), preview: 'Release notes are ready.' }), state('A2', 'idle', { replyAt: today.getTime() - 120_000, preview: 'Old news.' })] });
    });
    await until(() => expect(row('A1')?.querySelector('.lab-bot-preview')?.textContent).toBe('Release notes are ready.'));
    expect(row('A1')!.querySelector('.lab-bot-time')!.textContent).toBe(today.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
    // A1 replied after positions started and was never read: a dot, never a number. A2's reply came before.
    expect(row('A1')!.dataset.unread).toBe('true');
    expect(row('A1')!.querySelector('.lab-bot-unread')).not.toBeNull();
    expect(row('A1')!.textContent).not.toMatch(/\b1\b/);
    expect(row('A2')!.dataset.unread).toBeUndefined();
    expect(app.container.querySelector('#bot-section-A .lab-bot-section-unread')).not.toBeNull();
    // Opening A1 marks it read up to its reply, for every device.
    await act(async () => row('A1')!.click());
    await until(() => expect(app.markedReads).toEqual([{ nativeSessionId: 'A1', readAt: today.getTime() }]));
    await until(() => expect(row('A1')!.dataset.unread).toBeUndefined());
    expect(app.container.querySelector('#bot-section-A .lab-bot-section-unread')).toBeNull();
    // A newer reply while A1 is on screen is read at once; one marked on another device clears A2's dot here.
    await act(async () => app.emitStates({ states: [state('A2', 'idle', { replyAt: today.getTime() + 1_000, preview: 'New from A2.' })] }));
    await until(() => expect(row('A2')!.dataset.unread).toBe('true'));
    await act(async () => app.emitReads({ reads: [{ hostId: 'local', providerId: 'recorded', nativeSessionId: 'A2', readAt: today.getTime() + 1_000 }] }));
    await until(() => expect(row('A2')!.dataset.unread).toBeUndefined());
  } finally { await app.close(); }
});
