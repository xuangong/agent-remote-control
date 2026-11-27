// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { finishSessionUse, takeSessionUse, type SessionUsePage } from './session-use-page.js';

function page(href: string) {
  const state = { href };
  const replaceState = vi.fn((_state: unknown, _title: string, url: string) => { state.href = new URL(url, state.href).href; });
  const value = { get location() { const url = new URL(state.href); return { href: url.href, search: url.search }; }, history: { state: { keep: true }, replaceState } } as SessionUsePage;
  return { value, replaceState, href: () => state.href };
}
afterEach(() => finishSessionUse());

describe('the session use a page was opened with', () => {
  it('is read once, and the address no longer names the session', () => {
    const opened = page('https://arc.example/?host=desk&provider=claude&session=abc&as=bot&name=N&window=w1');
    expect(takeSessionUse(opened.value)).toEqual({ session: { hostId: 'desk', providerId: 'claude', nativeSessionId: 'abc' }, use: { kind: 'bot', name: 'N' } });
    expect(opened.href()).toBe('https://arc.example/?window=w1');
    expect(opened.replaceState).toHaveBeenCalledWith({ keep: true }, '', '/?window=w1');
  });

  it('is still there when a render asks again, until it is finished', () => {
    const opened = page('https://arc.example/?host=desk&provider=claude&session=abc&as=bot');
    const first = takeSessionUse(opened.value);
    expect(takeSessionUse(opened.value)).toEqual(first);
    finishSessionUse();
    expect(takeSessionUse(opened.value)).toBeUndefined();
  });

  it('leaves an ordinary session link alone', () => {
    const opened = page('https://arc.example/?host=desk&provider=claude&session=abc');
    expect(takeSessionUse(opened.value)).toBeUndefined();
    expect(opened.replaceState).not.toHaveBeenCalled();
  });
});
