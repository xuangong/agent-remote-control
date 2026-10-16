// @vitest-environment node
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createWindowView, PROTOCOL_VERSION } from '@orchardworks/agent-remote-protocol';
import { createDevboxServer } from './devbox.js';
import { onPreviewCleanup, previewFixture } from './preview-tunnel-fixture.js';

const cookies = (response: Response) => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'arc-devbox-preview-'));
  onPreviewCleanup(() => rm(directory, { recursive: true, force: true }));
  const webDist = join(directory, 'web'); await mkdir(webDist);
  await writeFile(join(webDist, 'index.html'), '<!doctype html><html><head></head><body><div id="root"></div></body></html>');
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const canonicalOrigin = `http://localhost:${port}`;
  const devbox = await createDevboxServer({ origin: canonicalOrigin, stateDir: join(directory, 'state'), webDist });
  await devbox.listen(port, '127.0.0.1'); onPreviewCleanup(() => devbox.close());
  const preview = await previewFixture({ previewDomain: 'arc.test', target: canonicalOrigin });
  const origin = new URL(await preview.entryUrl('/')).origin;
  const fetch = (path: string, init: RequestInit = {}) => preview.fetch(origin + path, { ...init, signal: init.signal ?? AbortSignal.timeout(5000) });
  const post = (url: string, body: unknown, cookie: string, requestOrigin: string) => preview.fetch(url, {
    method: 'POST', headers: { cookie, origin: requestOrigin, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  const challenge = await post(origin + '/_arc/challenge', { path: '/' }, '', preview.url);
  expect(challenge.status).toBe(200);
  const browserCookie = cookies(challenge); const { challenge: id } = await challenge.json();
  const approval = await post(preview.url + '/_arc/preview-authorize', { challenge: id }, preview.alice.cookie, preview.url);
  expect(approval.status).toBe(200); const { code } = await approval.json();
  const entered = await post(origin + '/_arc/enter', { code }, browserCookie, origin);
  expect(entered.status).toBe(200);
  return { ...preview, origin, canonicalOrigin, fetch, previewCookie: cookies(entered) };
}

it('opens Devbox through a root preview and retains its browser identity, Window writes and session channel', async () => {
  const f = await fixture();
  const page = await f.fetch('/?window=devbox-preview-window', { headers: { cookie: f.previewCookie }, redirect: 'manual' });
  expect(page.status, await page.clone().text()).toBe(200);
  expect(page.headers.get('location')).toBeNull();
  expect(await page.text()).toContain('name="agent-remote-devbox" content="true"');

  const status = await f.fetch('/auth/status', { headers: { cookie: f.previewCookie } });
  expect(status.status, await status.clone().text()).toBe(200);
  const state = await status.json(); const applicationCookie = cookies(status);
  expect(applicationCookie).toMatch(/(?:^|; )devbox_session=[A-Za-z0-9_-]{43}(?:;|$)/);
  expect(applicationCookie).toMatch(/(?:^|; )devbox_browser=/);
  expect(applicationCookie).not.toMatch(/(?:^|; )(?:__Host-|__Secure-)?arc[_-]/);
  expect(state).toMatchObject({ user: { id: 'devbox', name: 'Devbox' } });
  const headers = { cookie: f.previewCookie + '; ' + applicationCookie, origin: f.origin, 'content-type': 'application/json' };

  const repeated = await f.fetch('/auth/status', { headers });
  expect(repeated.status).toBe(200);
  expect(repeated.headers.getSetCookie().some(value => value.startsWith('devbox_session='))).toBe(false);
  expect((await repeated.json()).basePath).toBe(state.basePath);
  const browserSessions = await f.fetch('/auth/sessions', { headers });
  expect(browserSessions.status).toBe(200);
  expect((await browserSessions.json()).sessions).toHaveLength(1);

  const windows = state.basePath + 'v1/windows';
  const created = await f.fetch(windows, { method: 'POST', headers, body: JSON.stringify({
    operationId: 'preview-create-window', issuedAt: Date.now(),
    window: { schemaVersion: 2, id: 'devbox-preview-window', title: 'Preview transport', revision: 0,
      selectedPrimaryViewId: 'main', selectedViewId: 'main', views: [createWindowView('main', undefined, 'primary')] },
  }) });
  expect(created.status, await created.clone().text()).toBe(200);
  expect(await created.json()).toMatchObject({ result: { status: 'committed' } });
  const listed = await f.fetch(windows, { headers });
  expect(listed.status).toBe(200);
  expect(await listed.json()).toMatchObject({ windows: [{ id: 'devbox-preview-window', title: 'Preview transport' }] });

  const unchanged = await f.fetch(windows + '/devbox-preview-window/changes?afterRevision=0', {
    headers, signal: AbortSignal.timeout(17000),
  });
  expect(unchanged.status, await unchanged.clone().text()).toBe(200);
  expect(await unchanged.json()).toMatchObject({ window: { id: 'devbox-preview-window', revision: 0 } });

  const canonical = await fetch(f.canonicalOrigin + '/auth/status', { headers: { cookie: applicationCookie }, signal: AbortSignal.timeout(5000) });
  expect(canonical.status).toBe(200);
  expect((await canonical.json()).basePath).toBe(state.basePath);
  expect(canonical.headers.getSetCookie().some(value => value.startsWith('devbox_session='))).toBe(false);

  const socket = new WebSocket(f.transportUrl.replace('http:', 'ws:') + state.basePath + 'v1/session-channel?observation=activity', {
    headers: { host: new URL(f.origin).host, cookie: headers.cookie, origin: f.origin }, handshakeTimeout: 5000,
  });
  onPreviewCleanup(async () => { socket.terminate(); });
  expect(JSON.parse((await once(socket, 'message', { signal: AbortSignal.timeout(5000) }))[0].toString())).toMatchObject({ type: 'ready' });
  const pong = once(socket, 'message', { signal: AbortSignal.timeout(5000) });
  socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'ping' }));
  expect(JSON.parse((await pong)[0].toString())).toMatchObject({ type: 'pong' });
}, 20000);

it('rejects cross-site bootstrap and foreign-origin mutations through the Devbox preview', async () => {
  const f = await fixture();
  const crossSite = await f.fetch('/auth/status', { headers: { cookie: f.previewCookie, 'sec-fetch-site': 'cross-site' } });
  expect(crossSite.status, await crossSite.clone().text()).toBe(403);
  expect(crossSite.headers.getSetCookie()).toEqual([]);
  const status = await f.fetch('/auth/status', { headers: { cookie: f.previewCookie } });
  expect(status.status).toBe(200);
  const state = await status.json(); const cookie = f.previewCookie + '; ' + cookies(status);
  const rejected = await f.fetch(state.basePath + 'v1/windows', { method: 'POST',
    headers: { cookie, origin: 'https://untrusted.example', 'content-type': 'application/json' }, body: '{}' });
  expect(rejected.status).toBe(403);
  const windows = await f.fetch(state.basePath + 'v1/windows', { headers: { cookie } });
  expect(windows.status).toBe(200);
  expect(await windows.json()).toMatchObject({ windows: [] });
}, 20000);
