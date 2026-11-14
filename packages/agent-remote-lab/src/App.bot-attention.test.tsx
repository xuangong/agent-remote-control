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
