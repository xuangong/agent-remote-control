import { expect, it } from 'vitest';
import { parseWorkbenchRoute, writeWorkbenchRoute, windowRouteFields } from './workbench-mode.js';
it('parses explicit Bot locators and gives ordinary Window/session links precedence', () => {
  expect(parseWorkbenchRoute(new URL('https://test/?mode=bot&section=s&bot=v'))).toEqual({ mode: 'bot', place: { kind: 'bot', groupId: 's', viewId: 'v' } });
  expect(parseWorkbenchRoute(new URL('https://test/?mode=bot&section=s'))).toEqual({ mode: 'bot', place: { kind: 'section', groupId: 's' } });
  expect(parseWorkbenchRoute(new URL('https://test/?window=w'))).toEqual({ mode: 'window' });
  expect(parseWorkbenchRoute(new URL('https://test/?host=h&provider=p&session=s'))).toEqual({ mode: 'window' });
  expect(parseWorkbenchRoute(new URL('https://test/?debug=1'))).toBeUndefined();
});
it('writes one route while preserving unrelated parameters and hashes', () => {
  const initial = new URL('https://test/?debug=1&window=w&host=old&provider=p&session=old&parent=x&agent=a&intent=history&keepOriginal=1#trace');
  const url = writeWorkbenchRoute(initial, 'bot', { kind: 'bot', groupId: 's', viewId: 'v' });
  expect(url.search).toBe('?debug=1&mode=bot&section=s&bot=v'); expect(url.hash).toBe('#trace');
  const fallback = writeWorkbenchRoute(url, 'bot', { kind: 'session', session: { hostId: 'h', providerId: 'p', nativeSessionId: 'n', title: 'Title', agentId: 'secret' } });
  expect(fallback.search).toBe('?debug=1&mode=bot&host=h&provider=p&session=n');
  expect(writeWorkbenchRoute(fallback, 'window', undefined, { window: 'w' }).search).toBe('?debug=1&window=w');
});
it('captures only Window navigation fields', () => {
  expect(windowRouteFields(new URL('https://test/?window=w&host=h&debug=1&mode=bot&section=s&bot=v'))).toEqual({ window: 'w', host: 'h' });
});
