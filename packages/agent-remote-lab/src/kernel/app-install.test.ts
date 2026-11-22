// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { installOffer, installPlatform, keepInstallPrompt, promptInstall, useInstallOffer, type InstallView } from './app-install.js';
import { renderHook } from '../test/render-hook.js';

const AGENTS = {
  iPhone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  iPhoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1',
  iPadDesktopMode: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  safari17: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  safari16: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15',
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  edgeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  firefoxMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:132.0) Gecko/20100101 Firefox/132.0',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
} as const;

describe('the platform', () => {
  it.each([
    ['iPhone Safari', AGENTS.iPhone, 5, 'ios'],
    ['iPhone Chrome, which adds to the home screen from its share menu', AGENTS.iPhoneChrome, 5, 'ios'],
    ['an iPad that asks for desktop pages: a Mac with touch points', AGENTS.iPadDesktopMode, 5, 'ios'],
    ['Safari 17 on a Mac', AGENTS.safari17, 0, 'safari-mac'],
    ['Safari 16 on a Mac, before Add to Dock', AGENTS.safari16, 0, 'other'],
    ['Chrome on a Mac', AGENTS.chromeMac, 0, 'other'],
    ['Edge on Windows', AGENTS.edgeWindows, 0, 'other'],
    ['Firefox on a Mac', AGENTS.firefoxMac, 0, 'other'],
    ['Chrome on Android', AGENTS.android, 5, 'other'],
  ] as const)('%s', (_name, agent, touchPoints, platform) => {
    expect(installPlatform(agent, touchPoints)).toBe(platform);
  });
});

describe('the offer', () => {
  it.each([
    ['the installed app offers nothing', true, true, 'other', 'none'],
    ['the installed app on an iPhone offers nothing', true, false, 'ios', 'none'],
    ['a browser that gave its prompt', false, true, 'other', 'prompt'],
    ['an iPhone: the home screen instructions', false, false, 'ios', 'home-screen'],
    ['Safari on a Mac: the Dock instructions', false, false, 'safari-mac', 'dock'],
    ['a browser that gave no prompt, such as Firefox or an installed Chrome app\'s tab', false, false, 'other', 'none'],
  ] as const)('%s', (_name, installed, promptAvailable, platform, offer) => {
    expect(installOffer({ installed, promptAvailable, platform })).toBe(offer);
  });
});

describe('the browser\'s prompt', () => {
  const page = (agent: string): InstallView => ({ navigator: { userAgent: agent, maxTouchPoints: 0 }, matchMedia: () => ({ matches: false }) });

  it('is kept from the page\'s start, offered, spent on use, and gone once the app is installed', async () => {
    const target = new EventTarget();
    keepInstallPrompt(target as unknown as Window);
    const { result } = await renderHook(() => useInstallOffer(page(AGENTS.chromeMac)));
    expect(result.current).toBe('none');
    const prompted: string[] = [];
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt: async () => { prompted.push('prompt'); }, userChoice: Promise.resolve({ outcome: 'accepted' as const }) });
    act(() => { target.dispatchEvent(event); });
    // The browser's own banner gives way to the entry in Settings.
    expect(event.defaultPrevented).toBe(true);
    expect(result.current).toBe('prompt');
    let installed: boolean | undefined;
    await act(async () => { installed = await promptInstall(); });
    expect(installed).toBe(true);
    expect(prompted).toEqual(['prompt']);
    expect(result.current).toBe('none');
    await expect(promptInstall()).resolves.toBe(false);
    act(() => { target.dispatchEvent(Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt: async () => {}, userChoice: Promise.resolve({ outcome: 'dismissed' as const }) })); });
    expect(result.current).toBe('prompt');
    act(() => { target.dispatchEvent(new Event('appinstalled')); });
    expect(result.current).toBe('none');
  });
});
