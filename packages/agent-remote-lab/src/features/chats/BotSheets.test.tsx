// @vitest-environment jsdom
import { act } from 'react';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { LocaleContext } from '@orchardworks/agent-client-web/react';
import { render } from '../../test/setup.js';
import { NewBotSheet } from './NewBotSheet.js';
import { RemoveBotSheet } from './RemoveBotSheet.js';
import { ViewOptions } from '../windows/ViewOptions.js';

const dialogMethods = ['showModal', 'close'] as const;
const originalDialog = Object.fromEntries(dialogMethods.map(name => [name, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)]));
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); } });
});
afterAll(() => {
  for (const name of dialogMethods) {
    const original = originalDialog[name];
    if (original) Object.defineProperty(HTMLDialogElement.prototype, name, original);
    else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>)[name];
  }
});
const zh = (node: JSX.Element) => <LocaleContext.Provider value="zh">{node}</LocaleContext.Provider>;

it('asks before removing an assistant, in English and in Chinese', async () => {
  const sheet = <RemoveBotSheet name="Helper" groupTitle="Research" window={undefined} viewId="v1" onCancel={() => {}} onRemove={() => {}} />;
  expect((await render(sheet)).textContent).toContain('Remove “Helper”?');
  const chinese = (await render(zh(sheet))).textContent!;
  expect(chinese).toContain('移除“Helper”？');
  expect(chinese).toContain('取消');
  expect(chinese).toContain('它的会话会继续运行。');
});

it('speaks Chinese in the New assistant sheet', async () => {
  const text = (await render(zh(<NewBotSheet open onClose={() => {}} hosts={[{ id: 'h', name: 'Lab' }]} hostId="h" onHostChange={() => {}} providers={[]} providerId="" nativeProviderId=""
    onProviderChange={() => {}} options={{}} onOptionsChange={() => {}} canBrowse={false} starting={false} onStart={() => {}} />))).textContent!;
  expect(text).toContain('没有可用的 provider');
  expect(text).toContain('开始');
});

it('speaks Chinese in the View options panel', async () => {
  const container = await render(zh(<ViewOptions triggerRef={{ current: null }} headerVisible sidebarVisible inspectorVisible={false} compact={false} inert={false}
    onSetAllVisible={() => {}} onToggleHeader={() => {}} onToggleSidebar={() => {}} onToggleInspector={() => {}} />));
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="视图选项"]')!.click());
  expect(container.textContent).toContain('面板');
  expect(container.textContent).toContain('全部隐藏');
});
