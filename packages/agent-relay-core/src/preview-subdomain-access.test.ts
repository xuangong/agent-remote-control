import { expect, it } from 'vitest';
import { createSubdomainPreviewAccess } from './preview-subdomain-access.js';

it('binds handoff proofs to the target browser and revokes sessions with their control login', async () => {
  let active = true;
  const origin = 'https://agents.example.test';
  const target = 'https://t-preview.example.test';
  const access = createSubdomainPreviewAccess({ origin, lookup: url => url.origin === target ? { hostId: 'host', previewId: 'one' } : undefined,
    authorize: async entry => active && entry.subject === 'alice' && entry.source.headers.get('cookie') === 'control=alice' });
  try {
    const challenge = await access.handle(new Request(target + '/_arc/challenge', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ path: '/docs?q=1#part' }) }));
    expect(challenge!.status).toBe(200);
    expect(challenge!.headers.get('access-control-allow-origin')).toBe(origin);
    const cookie = challenge!.headers.get('set-cookie')!.split(';')[0]!;
    const { challenge: id } = await challenge!.json() as { challenge: string };
    expect(await access.approve(id, new Request(origin, { headers: { cookie: 'control=bob' } }), 'bob')).toBeUndefined();
    const code = await access.approve(id, new Request(origin, { headers: { cookie: 'control=alice' } }), 'alice');
    const redeem = (browserCookie: string) => access.handle(new Request(target + '/_arc/enter', { method: 'POST', headers: { origin: target, cookie: browserCookie, 'content-type': 'application/json' }, body: JSON.stringify({ code }) }));
    expect((await redeem(''))!.status).toBe(401);
    const entered = await redeem(cookie);
    expect(entered!.status).toBe(200);
    expect(await entered!.json()).toEqual({ url: '/docs?q=1#part' });
    expect(entered!.headers.get('set-cookie')).toContain('Path=/; HttpOnly; SameSite=Strict; Secure');
    expect((await redeem(cookie))!.status).toBe(401);
    const previewCookie = entered!.headers.get('set-cookie')!.split(';')[0]!;
    const request = new Request(target + '/api', { headers: { cookie: previewCookie } });
    expect(await access.authenticate(request)).toMatchObject({ subject: 'alice', previewId: 'one' });
    expect((await access.authenticate(new Request(target + '/api', { method: 'POST', headers: { cookie: previewCookie, origin: 'https://evil.test' } })) as Response).status).toBe(403);
    active = false;
    expect((await access.authenticate(request) as Response).status).toBe(401);
  } finally { access.close(); }
});

it('allows time for login but limits approved proofs, concurrent redemption, and tunnel scope', async () => {
  let time = 0;
  const origin = 'https://agents.example.test';
  const target = 'https://t-one.example.test';
  const other = 'https://t-two.example.test';
  const access = createSubdomainPreviewAccess({ origin, now: () => time,
    lookup: url => [target, other].includes(url.origin) ? { hostId: 'host', previewId: url.origin } : undefined,
    authorize: async () => true });
  const post = (host: string, path: string, body: unknown, cookie = '', from = origin) => access.handle(new Request(host + path,
    { method: 'POST', headers: { origin: from, cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const challenge = async () => {
    const response = (await post(target, '/_arc/challenge', { path: '/docs' }))!;
    return { id: (await response.json()).challenge as string, cookie: response.headers.get('set-cookie')!.split(';')[0]! };
  };
  try {
    const first = await challenge(); const second = await challenge();
    expect(first.cookie.split('=')[0]).not.toBe(second.cookie.split('=')[0]);
    time = 120_000;
    const approvals = await Promise.all([access.approve(first.id, new Request(origin), 'alice'), access.approve(first.id, new Request(origin), 'alice')]);
    expect(approvals.filter(Boolean)).toHaveLength(1);
    const code = approvals.find(Boolean)!;
    expect((await post(other, '/_arc/enter', { code }, first.cookie))!.status).toBe(401);
    const entries = await Promise.all([post(target, '/_arc/enter', { code }, first.cookie), post(target, '/_arc/enter', { code }, first.cookie)]);
    expect(entries.map(r => r!.status).sort()).toEqual([200, 401]);
    const cookie = entries.find(r => r!.status === 200)!.headers.get('set-cookie')!.split(';')[0]!;
    expect((await access.authenticate(new Request(other + '/docs', { headers: { cookie } })) as Response).status).toBe(401);
    const secondCode = await access.approve(second.id, new Request(origin), 'alice');
    time += 60_001;
    expect((await post(target, '/_arc/enter', { code: secondCode }, second.cookie))!.status).toBe(401);
    expect((await post(target, '/_arc/challenge', {}, '', 'https://evil.test'))!.status).toBe(403);
    expect((await post(target, '/_arc/challenge', { path: '//evil.test' }))!.status).toBe(400);
    expect((await post(target, '/_arc/challenge', { path: '/_arc/renew' }))!.status).toBe(400);
    const session = await access.authenticate(new Request(target + '/docs', { headers: { cookie } }));
    expect(session).not.toBeInstanceOf(Response);
    let revoked = false;
    if (!(session instanceof Response)) access.watch(session, () => { revoked = true; });
    time += 3_600_001; await access.enforce(); expect(revoked).toBe(true);
  } finally { access.close(); }
});
