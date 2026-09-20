import { expect, it } from 'vitest';
import { createPreviewAccess } from './preview-access.js';

const origin = 'https://agents.example';
const previewOrigin = 'https://preview.example';
const source = new Request(origin + '/u/alice/', { headers: { cookie: 'secret-main-cookie=value' } });
it('rejects entry destinations that normalize outside the preview registration prefix', () => {
  const access = createPreviewAccess({ origin, previewOrigin, authorize: async () => true });
  expect(() => access.issue({ source, subject: 'alice', hostId: 'host', previewId: 'abc', path: '/../_arc/enter' })).toThrow(/destination/i);
  access.close();
}, 10000);

it('redeems a single-use fragment handoff and requires current authorization for every image or page', async () => {
  let authorized = true;
  const access = createPreviewAccess({ origin, previewOrigin, authorize: async () => authorized });
  const entry = access.issue({ source, subject: 'alice', hostId: 'host', previewId: 'abc', path: '/me?q=1#section' });
  const url = new URL(entry); expect(url.search).toBe('');
  const redeem = () => access.handle(new Request(previewOrigin + '/_arc/enter', {
    method: 'POST', headers: { origin: previewOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ code: url.hash.slice(1) }),
  }));
  const response = await redeem(); expect(response?.status).toBe(200);
  expect(await response!.json()).toEqual({ url: '/p/abc/me?q=1#section' });
  const cookie = response!.headers.get('set-cookie')!;
  expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('Secure'); expect(cookie).not.toContain('Domain=');
  expect((await redeem())?.status).toBe(401);
  const request = new Request(previewOrigin + '/p/abc/me', { headers: { cookie: cookie.split(';')[0]! } });
  const session = await access.authenticate(request); expect(session).toMatchObject({ subject: 'alice', hostId: 'host', previewId: 'abc' });
  authorized = false;
  expect(await access.authenticate(request)).toBeInstanceOf(Response);
  expect((await access.authenticate(request) as Response).status).toBe(401);
  access.close();
}, 10000);

it('rejects cross-registration cookies, cross-origin mutations, replay after expiry and an open redirect', async () => {
  let now = 100;
  const access = createPreviewAccess({ origin, previewOrigin, now: () => now, authorize: async () => true });
  expect(() => access.issue({ source, subject: 'alice', hostId: 'host', previewId: 'abc', path: '//evil.example/' })).toThrow();
  const entry = access.issue({ source, subject: 'alice', hostId: 'host', previewId: 'abc', path: '/' });
  now += 61_000;
  const response = await access.handle(new Request(previewOrigin + '/_arc/enter', { method: 'POST',
    headers: { origin: previewOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ code: new URL(entry).hash.slice(1) }) }));
  expect(response?.status).toBe(401);
  expect((await access.authenticate(new Request(previewOrigin + '/p/abc/', {method:'POST',headers:{origin:origin}})) as Response).status).toBe(403);
  expect((await access.authenticate(new Request(previewOrigin + '/p/other/', {headers:{cookie:'__Secure-arc_preview_abc=fake'}})) as Response).status).toBe(401);
  access.close();
}, 10000);


it('renews the HttpOnly cookie and its existing stream authorization without bypassing revocation', async () => {
  let now = 1000;
  let authorized = true;
  const access = createPreviewAccess({ origin, previewOrigin, now: () => now, authorize: async () => authorized });
  try {
    const entry = access.issue({ source, subject: 'alice', hostId: 'host', previewId: 'abc', path: '/' });
    const response = await access.handle(new Request(previewOrigin + '/_arc/enter', { method: 'POST',
      headers: { origin: previewOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ code: new URL(entry).hash.slice(1) }) }));
    const cookie = response!.headers.get('set-cookie')!.split(';')[0]!;
    const request = new Request(previewOrigin + '/p/abc/page', { headers: { cookie } });
    const session = await access.authenticate(request);
    if (session instanceof Response) throw new Error('Expected preview authorization');
    let cancelled = false;
    access.watch(session, () => { cancelled = true; });
    now += 50 * 60_000;
    const renew = () => access.handle(new Request(previewOrigin + '/p/abc/_arc/renew', { method: 'POST',
      headers: { cookie, origin: previewOrigin, 'content-type': 'application/json' }, body: '{}' }));
    const renewed = await renew();
    expect(renewed?.status).toBe(200);
    expect(renewed!.headers.get('set-cookie')).toContain(cookie + ';');
    expect(renewed!.headers.get('set-cookie')).toContain('HttpOnly');
    now += 20 * 60_000;
    await access.enforce();
    expect(cancelled).toBe(false);
    expect(await access.authenticate(request)).not.toBeInstanceOf(Response);
    authorized = false;
    expect((await renew())?.status).toBe(401);
    await access.enforce();
    expect(cancelled).toBe(true);
  } finally { access.close(); }
}, 10000);

it('extends stream access on traffic beyond the original deadline, then expires while idle', async () => {
  let now = 1000;
  let authorized = true;
  const access = createPreviewAccess({ origin, previewOrigin, now: () => now, authorize: async () => authorized });
  try {
    const entry = access.issue({ source, subject: 'alice', hostId: 'host', previewId: 'abc', path: '/' });
    const response = await access.handle(new Request(previewOrigin + '/_arc/enter', { method: 'POST',
      headers: { origin: previewOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ code: new URL(entry).hash.slice(1) }) }));
    expect(response!.headers.get('set-cookie')).not.toContain('Max-Age');
    const cookie = response!.headers.get('set-cookie')!.split(';')[0]!;
    const request = new Request(previewOrigin + '/p/abc/socket', { headers: { cookie } });
    const session = await access.authenticate(request);
    if (session instanceof Response) throw new Error('Expected access');
    let cancelled = false;
    access.watch(session, () => { cancelled = true; });
    now += 50 * 60_000; expect(access.activity(session)).toBe(true);
    now += 50 * 60_000; expect(access.activity(session)).toBe(true);
    await access.enforce(); expect(cancelled).toBe(false);
    expect(await access.authenticate(request)).not.toBeInstanceOf(Response);
    authorized = false;
    await access.enforce(); expect(cancelled).toBe(true);
    authorized = true;
    now += 61 * 60_000;
    expect(access.activity(session)).toBe(false);
    expect((await access.authenticate(request) as Response).status).toBe(401);
  } finally { access.close(); }
}, 10000);


it('binds redemption and subsequent access to the receiving browser identity', async () => {
  let active = true;
  const access = createPreviewAccess({ origin, previewOrigin: origin,
    authorize: async session => active && session.source.headers.get('cookie') === 'browser=alice',
    authorizeBrowser: async (request, session) => request.headers.get('cookie')?.includes('browser=' + session.subject) === true,
  });
  try {
    const entry = access.issue({ source: new Request(origin, { headers: { cookie: 'browser=alice' } }), subject: 'alice', hostId: 'host', previewId: 'abc', path: '/' });
    const redeem = (cookie = '') => access.handle(new Request(origin + '/_arc/enter', { method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ code: new URL(entry).hash.slice(1) }) }));
    expect((await redeem())?.status).toBe(401);
    expect((await redeem('browser=bob'))?.status).toBe(401);
    const results = await Promise.all([redeem('browser=alice'), redeem('browser=alice')]);
    expect(results.map(result => result!.status).sort()).toEqual([200, 401]);
    const cookie = results.find(result => result!.status === 200)!.headers.get('set-cookie')!.split(';')[0]!;
    const request = (identity: string) => new Request(origin + '/p/abc/', { headers: { cookie: cookie + identity } });
    expect((await access.authenticate(request('')) as Response).status).toBe(401);
    expect((await access.authenticate(request('; browser=bob')) as Response).status).toBe(401);
    const session = await access.authenticate(request('; browser=alice'));
    expect(session).not.toBeInstanceOf(Response);
    if (session instanceof Response) throw new Error('Expected session');
    let cancelled = false;
    access.watch(session, () => { cancelled = true; });
    active = false;
    await access.enforce();
    expect(cancelled).toBe(true);
    expect((await access.authenticate(request('; browser=alice')) as Response).status).toBe(401);
  } finally { access.close(); }
}, 10000);
