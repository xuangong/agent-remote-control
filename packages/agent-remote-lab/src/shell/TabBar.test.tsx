import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { LocaleContext } from '@orchardworks/agent-client-web/react';
import { TabBar } from './TabBar.js';

const noop = () => {};

it('shows Chats, Assistants, Windows and Me, the current one marked', async () => {
  for (const [current, label] of [[{ destination: 'chats' }, 'Chats'], [{ destination: 'assistants' }, 'Assistants'], [{ destination: 'windows' }, 'Windows'], [{ destination: 'settings' }, 'Me']] as const) {
    const container = await render(<TabBar current={current} onGo={noop} />);
    expect([...container.querySelectorAll('.lab-tab-label')].map(item => item.textContent)).toEqual(['Chats', 'Assistants', 'Windows', 'Me']);
    expect([...container.querySelectorAll('[aria-current="page"] .lab-tab-label')].map(item => item.textContent)).toEqual([label]);
  }
});

it('goes where a tab says, Me being Settings', async () => {
  const onGo = vi.fn();
  const container = await render(<TabBar current={{ destination: 'chats' }} onGo={onGo} />);
  const tabs = [...container.querySelectorAll<HTMLButtonElement>('.lab-tab')];
  for (const tab of tabs) await act(async () => tab.click());
  expect(onGo.mock.calls.map(call => call[0])).toEqual([{ destination: 'chats' }, { destination: 'assistants' }, { destination: 'windows' }, { destination: 'settings' }]);
});

it('puts the link dot on Me while the link needs the person', async () => {
  const notice = { state: 'sign_in' as const, signIn: { href: '/auth/login', onClick: noop }, retry: noop };
  const container = await render(<TabBar current={{ destination: 'chats' }} onGo={noop} notice={notice} />);
  expect(container.querySelector('.lab-tab:last-child .lab-link-dot')?.getAttribute('aria-label')).toBe('Signed out');
  expect(container.querySelectorAll('.lab-link-dot')).toHaveLength(1);
});

it('speaks Chinese when the device does', async () => {
  const container = await render(<LocaleContext.Provider value="zh"><TabBar current={{ destination: 'chats' }} onGo={noop} /></LocaleContext.Provider>);
  expect([...container.querySelectorAll('.lab-tab-label')].map(item => item.textContent)).toEqual(['聊天', '助手', '窗口', '我']);
});
