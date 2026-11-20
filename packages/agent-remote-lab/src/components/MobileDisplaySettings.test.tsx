import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { LocaleContext } from '@orchardworks/agent-client-web/react';
import { MobileDisplaySettings } from './MobileDisplaySettings.js';

let fullscreenElement: Element | null;
let standaloneMedia: boolean;
const button = (container: HTMLElement, label: string) => [...container.querySelectorAll('button')].find(item => item.textContent === label);

beforeEach(() => {
  fullscreenElement = null; standaloneMedia = false;
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
  Object.defineProperty(navigator, 'standalone', { configurable: true, value: false });
  window.matchMedia = ((query: string) => ({ matches: query.includes('standalone') && standaloneMedia, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  document.documentElement.requestFullscreen = vi.fn(async () => { fullscreenElement = document.documentElement; });
  document.exitFullscreen = vi.fn(async () => { fullscreenElement = null; });
});
afterEach(() => { Reflect.deleteProperty(document, 'fullscreenElement'); Reflect.deleteProperty(document, 'fullscreenEnabled'); Reflect.deleteProperty(navigator, 'standalone'); });

describe('MobileDisplaySettings', () => {
  it('enters and exits full screen and offers the matching action each time', async () => {
    const container = await render(<MobileDisplaySettings />);
    await act(async () => button(container, 'Enter full screen')!.click());
    expect(document.documentElement.requestFullscreen).toHaveBeenCalled();
    expect(button(container, 'Exit full screen')).toBeDefined();
    await act(async () => button(container, 'Exit full screen')!.click());
    expect(document.exitFullscreen).toHaveBeenCalled();
    expect(button(container, 'Enter full screen')).toBeDefined();
  });

  it('explains that the browser has no full screen and points to the Home Screen', async () => {
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: false });
    const container = await render(<MobileDisplaySettings />);
    expect(button(container, 'Enter full screen')).toBeUndefined();
    expect(container.textContent).toContain('This browser does not support page full screen.');
    expect(container.textContent).toContain('Add to Home Screen');
  });

  it('reports a rejected request without claiming success and keeps the action available', async () => {
    document.documentElement.requestFullscreen = vi.fn(async () => { throw new Error('Denied'); });
    const container = await render(<MobileDisplaySettings />);
    await act(async () => button(container, 'Enter full screen')!.click());
    expect(container.querySelector('[role=alert]')!.textContent).toContain('Full screen could not be changed');
    expect((button(container, 'Enter full screen') as HTMLButtonElement).disabled).toBe(false);
  });

  it('recognizes a Home Screen launch and drops the redundant controls', async () => {
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    const container = await render(<MobileDisplaySettings />);
    expect(container.textContent).toContain('Opened from your Home Screen');
    expect(button(container, 'Enter full screen')).toBeUndefined();
    expect(container.querySelector('details')).toBeNull();
  });
});

it('speaks Chinese when the device does', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const view = await render(<LocaleContext.Provider value="zh"><MobileDisplaySettings /></LocaleContext.Provider>);
  expect(view.querySelector('h2')?.textContent).toBe('显示');
  expect(view.textContent).toContain('不带地址栏打开');
});
