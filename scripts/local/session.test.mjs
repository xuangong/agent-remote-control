import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { test } from 'node:test';
import { approveCommandLine, screenshot, signedInUser, userApi, withUserSession } from './session.mjs';

const LOCAL_USER = JSON.stringify({ user: { id: 'devbox' }, basePath: '/u/abc/' });
// What a real instance sets: the session, the browser identity and a login cookie it clears again.
const SIGNED_IN_COOKIES = ['devbox_session=s1; Path=/; HttpOnly', 'devbox_browser=b1; Path=/', 'devbox_login=; Path=/; Max-Age=0'];

async function fakeInstance(t, { statusCode = 200, statusBody = LOCAL_USER, cookies = SIGNED_IN_COOKIES, logoutStatus = 204,
  cliAnswer = [200, '{"status":"approved"}'] } = {}) {
  const calls = [];
  const server = createServer(async (request, response) => {
    calls.push({ method: request.method, url: request.url, cookie: request.headers.cookie, origin: request.headers.origin,
      contentType: request.headers['content-type'], body: await text(request) });
    if (request.url === '/auth/status') {
      response.writeHead(statusCode, { 'content-type': 'application/json', 'set-cookie': cookies });
      return response.end(statusBody);
    }
    if (request.url === '/u/abc/v1/remote/hosts') {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end('{"hosts":[]}');
    }
    if (request.url?.startsWith('/u/abc/v1/')) { response.writeHead(204); return response.end(); }
    if (request.url === '/auth/logout') { response.writeHead(logoutStatus); return response.end(); }
    if (request.url === '/auth/cli') { response.writeHead(cliAnswer[0], { 'content-type': 'application/json' }); return response.end(cliAnswer[1]); }
    response.writeHead(404);
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { origin: `http://127.0.0.1:${server.address().port}`, calls };
}

const requests = calls => calls.map(call => `${call.method} ${call.url}`);

/** An origin nothing listens on, so the connection is refused at once. */
async function closedOrigin() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

test('calls the user API with the local session and signs out', async t => {
  const f = await fakeInstance(t);
  assert.deepEqual(await userApi(f.origin, 'v1/remote/hosts'), { status: 200, body: '{"hosts":[]}' });
  assert.deepEqual(requests(f.calls), ['GET /auth/status', 'GET /u/abc/v1/remote/hosts', 'POST /auth/logout']);
  const api = f.calls[1];
  assert.equal(api.cookie, 'devbox_session=s1; devbox_browser=b1');
  assert.equal(api.origin, f.origin);
  assert.equal(api.contentType, undefined);
  assert.equal(f.calls[0].cookie, undefined);
});

test('signs out with the session cookie and origin', async t => {
  const f = await fakeInstance(t);
  await signedInUser(f.origin);
  assert.deepEqual(requests(f.calls), ['GET /auth/status', 'POST /auth/logout']);
  const logout = f.calls[1];
  assert.equal(logout.cookie, 'devbox_session=s1; devbox_browser=b1');
  assert.equal(logout.origin, f.origin);
  assert.equal(logout.contentType, 'application/json');
  assert.equal(logout.body, '{}');
});

test('forwards a POST body with its content type', async t => {
  const f = await fakeInstance(t);
  const result = await userApi(f.origin, 'v1/remote/pairings', { method: 'post', data: '{"purpose":"host-only"}' });
  assert.equal(result.status, 204);
  const api = f.calls[1];
  assert.equal(`${api.method} ${api.url}`, 'POST /u/abc/v1/remote/pairings');
  assert.equal(api.contentType, 'application/json');
  assert.equal(api.body, '{"purpose":"host-only"}');
  assert.equal(api.origin, f.origin);
});

test('allows a command line sign-in as the local user and signs out', async t => {
  const f = await fakeInstance(t);
  await approveCommandLine(f.origin, 'BCDFGHJK');
  assert.deepEqual(requests(f.calls), ['GET /auth/status', 'POST /auth/cli', 'POST /auth/logout']);
  const approval = f.calls[1];
  assert.equal(approval.cookie, 'devbox_session=s1; devbox_browser=b1');
  assert.equal(approval.origin, f.origin);
  assert.equal(approval.contentType, 'application/json');
  assert.deepEqual(JSON.parse(approval.body), { code: 'BCDFGHJK', decision: 'approve' });
});

test('reports a command line sign-in the instance did not allow', async t => {
  const expired = await fakeInstance(t, { cliAnswer: [410, '{"error":"This sign-in expired or was already answered."}'] });
  await assert.rejects(approveCommandLine(expired.origin, 'BCDFGHJK'),
    /did not allow the command line sign-in \(HTTP 410: This sign-in expired or was already answered\.\)/);
  assert.deepEqual(requests(expired.calls), ['GET /auth/status', 'POST /auth/cli', 'POST /auth/logout']);
  const refused = await fakeInstance(t, { cliAnswer: [200, '{"status":"denied"}'] });
  await assert.rejects(approveCommandLine(refused.origin, 'BCDFGHJK'), /did not allow the command line sign-in \(HTTP 200\)/);
});

test('rejects paths outside the user API before signing in', async () => {
  for (const path of ['/auth/status', 'remote/hosts', 'v1/two words', undefined]) {
    await assert.rejects(userApi('http://127.0.0.1:9', path), /start with v1\//);
  }
});

test('rejects paths that climb out of the user API, signing out afterwards', async t => {
  const f = await fakeInstance(t);
  for (const path of ['v1/../../auth/sessions', 'v1/%2e%2e/%2e%2e/auth/sessions', 'v1/%2E%2E/../auth/sessions', 'v1/..\\..\\auth\\sessions']) {
    await assert.rejects(userApi(f.origin, path), /start with v1\//, path);
  }
  assert.deepEqual([...new Set(requests(f.calls))].sort(), ['GET /auth/status', 'POST /auth/logout']);
  assert.equal(requests(f.calls).filter(call => call === 'POST /auth/logout').length, 4);
});

test('rejects data a request cannot carry before signing in', async () => {
  const origin = 'http://127.0.0.1:9';
  await assert.rejects(userApi(origin, 'v1/x', { method: 'POST', data: { purpose: 'host-only' } }), /API data must be a JSON string\./);
  await assert.rejects(userApi(origin, 'v1/x', { method: 'POST', data: 42 }), /API data must be a JSON string\./);
  await assert.rejects(userApi(origin, 'v1/x', { data: '{}' }), /GET and HEAD requests cannot carry --data\./);
  await assert.rejects(userApi(origin, 'v1/x', { method: 'head', data: '{}' }), /GET and HEAD requests cannot carry --data\./);
});

test('makes an exhausted sign-in limit explicit', async t => {
  const f = await fakeInstance(t, { statusCode: 429, statusBody: '{"error":"Too many requests."}', cookies: [] });
  await assert.rejects(signedInUser(f.origin), /The instance's sign-in limit \(30 per minute\) is exhausted; retry within a minute\./);
  assert.deepEqual(requests(f.calls), ['GET /auth/status']);
});

test('needs a session cookie and ignores cookies the instance clears', async t => {
  for (const cookies of [[], ['devbox_browser=b1; Path=/'], ['devbox_session=; Path=/; Max-Age=0', 'devbox_browser=b1; Path=/'], ['devbox_session=s1; Path=/; max-age=0']]) {
    const f = await fakeInstance(t, { cookies });
    await assert.rejects(signedInUser(f.origin), /The instance did not issue a session cookie\./, cookies.join(' | '));
    // Without a session there is nothing to sign out of.
    assert.deepEqual(requests(f.calls), ['GET /auth/status']);
  }
});

test('names the instance it cannot reach and keeps the cause', async () => {
  const origin = await closedOrigin();
  const error = await signedInUser(origin).catch(caught => caught);
  assert.match(error.message, new RegExp(`^Cannot reach the instance at ${origin}: .*ECONNREFUSED`));
  assert.ok(error.cause);
});

test('reports an unavailable local identity', async t => {
  const f = await fakeInstance(t, { statusCode: 401 });
  await assert.rejects(signedInUser(f.origin), new RegExp(`instance at ${f.origin} says its local identity is unavailable \\(401\\)`));
});

test('rejects an instance that does not return its local user, signing out afterwards', async t => {
  const answers = ['<html>sign in</html>', '', 'null', '{"user":{"id":"someone"},"basePath":"/u/abc/"}', '{"user":{"id":"devbox"}}',
    '{"user":{"id":"devbox"},"basePath":"/elsewhere/"}'];
  for (const statusBody of answers) {
    const f = await fakeInstance(t, { statusBody });
    await assert.rejects(signedInUser(f.origin), new RegExp(`The instance at ${f.origin} did not return its local user\\.$`), statusBody);
    assert.deepEqual(requests(f.calls), ['GET /auth/status', 'POST /auth/logout'], statusBody);
  }
});

test('signs out and rethrows when the action fails', async t => {
  const f = await fakeInstance(t);
  const failure = new Error('the action failed');
  await assert.rejects(withUserSession(f.origin, async () => { throw failure; }), caught => caught === failure);
  assert.deepEqual(requests(f.calls), ['GET /auth/status', 'POST /auth/logout']);
});

test('keeps the result when signing out fails', async t => {
  const f = await fakeInstance(t, { logoutStatus: 500 });
  assert.deepEqual(await userApi(f.origin, 'v1/remote/hosts'), { status: 200, body: '{"hosts":[]}' });
  assert.equal(await withUserSession(f.origin, async ({ basePath }) => basePath), '/u/abc/');
  assert.equal(requests(f.calls).filter(call => call === 'POST /auth/logout').length, 2);
});

// A stand-in for the Playwright package, so the browser flow runs without a browser.
const FAKE_PLAYWRIGHT = `
const state = () => globalThis.fakePlaywright;
const record = (...event) => state().events.push(event);
exports.chromium = {
  async launch(options) {
    record('launch', options);
    if (state().launchError) throw new Error(state().launchError);
    return {
      async newContext(options) {
        record('context', options);
        return {
          request: { async post(url, options) { record('logout', url, options); if (state().logoutError) throw new Error(state().logoutError); } },
          async newPage() {
            return {
              async goto(url, options) { record('goto', url, options); if (state().gotoError) throw new Error(state().gotoError); },
              locator(selector) { return { first: () => ({ async waitFor(options) { record('wait', selector, options); } }) }; },
              async waitForTimeout(milliseconds) { record('pause', milliseconds); },
              async screenshot(options) { record('screenshot', options); },
            };
          },
        };
      },
      async close() { record('close'); },
    };
  },
};
`;

async function sourceWithFakePlaywright(t, state) {
  const source = await mkdtemp(join(tmpdir(), 'session-source-'));
  t.after(() => rm(source, { recursive: true, force: true }));
  const lab = join(source, 'packages/agent-remote-lab');
  await mkdir(join(lab, 'node_modules/@playwright/test'), { recursive: true });
  await writeFile(join(lab, 'package.json'), '{"name":"fake-lab"}');
  await writeFile(join(lab, 'node_modules/@playwright/test/index.js'), FAKE_PLAYWRIGHT);
  globalThis.fakePlaywright = state;
  t.after(() => { delete globalThis.fakePlaywright; });
  return source;
}

const names = events => events.map(([name]) => name);

test('rejects a viewport or page path that cannot be used before loading Playwright', async () => {
  const source = '/nonexistent-source';
  const options = { source, origin: 'http://127.0.0.1:9', output: '/tmp/page.png' };
  for (const viewport of ['abc', '100x100', '1440', '1440x', 'x900', '1440x900x2']) {
    await assert.rejects(screenshot({ ...options, viewport }), /Viewport must look like 1440x900\./, viewport);
  }
  await assert.rejects(screenshot({ ...options, path: 'settings' }), /Page paths start with \//);
});

test('says how to get Playwright ready when it is not installed', async t => {
  const source = await mkdtemp(join(tmpdir(), 'session-empty-'));
  t.after(() => rm(source, { recursive: true, force: true }));
  const error = await screenshot({ source, origin: 'http://127.0.0.1:9', output: join(source, 'page.png') }).catch(caught => caught);
  assert.equal(error.message, `Playwright is not ready in ${source}. Install dependencies there, then run pnpm --filter @orchardworks/agent-remote-lab exec playwright install chromium.`);
  assert.ok(error.cause);
});

test('says how to get Playwright ready when its browser is missing', async t => {
  const events = [];
  const source = await sourceWithFakePlaywright(t, { events, launchError: "Executable doesn't exist" });
  const error = await screenshot({ source, origin: 'http://127.0.0.1:9', output: '/tmp/page.png' }).catch(caught => caught);
  assert.match(error.message, new RegExp(`^Playwright is not ready in ${source}\\. .*playwright install chromium\\.$`));
  assert.equal(error.cause.message, "Executable doesn't exist");
  assert.deepEqual(names(events), ['launch']);
});

test('captures the page, then signs its session out and closes the browser', async t => {
  const events = [];
  const source = await sourceWithFakePlaywright(t, { events });
  const origin = 'http://127.0.0.1:4100';
  await screenshot({ source, origin, path: '/?host=a', output: '/tmp/page.png', viewport: '800x600', fullPage: true });
  assert.deepEqual(names(events), ['launch', 'context', 'goto', 'wait', 'pause', 'screenshot', 'logout', 'close']);
  const byName = Object.fromEntries(events.map(([name, ...details]) => [name, details]));
  assert.deepEqual(byName.context[0].viewport, { width: 800, height: 600 });
  assert.equal(byName.goto[0], `${origin}/?host=a`);
  assert.equal(byName.wait[0], 'main.lab-shell');
  assert.deepEqual(byName.screenshot[0], { path: '/tmp/page.png', fullPage: true });
  // The context's own request client shares the page's cookies, so this ends the very session the page was given.
  assert.equal(byName.logout[0], `${origin}/auth/logout`);
  assert.deepEqual(byName.logout[1], { headers: { origin, 'content-type': 'application/json' }, data: '{}', timeout: 10_000 });
});

test('uses the default viewport, wait target and page when they are undefined', async t => {
  const events = [];
  const source = await sourceWithFakePlaywright(t, { events });
  await screenshot({ source, origin: 'http://127.0.0.1:4100', output: '/tmp/page.png', viewport: undefined, waitFor: undefined, fullPage: undefined, path: undefined });
  const byName = Object.fromEntries(events.map(([name, ...details]) => [name, details]));
  assert.deepEqual(byName.context[0].viewport, { width: 1440, height: 900 });
  assert.equal(byName.goto[0], 'http://127.0.0.1:4100/');
  assert.equal(byName.wait[0], 'main.lab-shell');
  assert.equal(byName.screenshot[0].fullPage, false);
});

test('names the page that did not show up and still signs out and closes', async t => {
  const events = [];
  const source = await sourceWithFakePlaywright(t, { events, gotoError: 'net::ERR_CONNECTION_REFUSED' });
  const error = await screenshot({ source, origin: 'http://127.0.0.1:4100', path: '/sessions', output: '/tmp/page.png', waitFor: 'main.lab-shell' }).catch(caught => caught);
  assert.equal(error.message, 'The page http://127.0.0.1:4100/sessions did not show main.lab-shell within 30 seconds.');
  assert.equal(error.cause.message, 'net::ERR_CONNECTION_REFUSED');
  assert.deepEqual(names(events), ['launch', 'context', 'goto', 'logout', 'close']);
});

test('does not fail the screenshot when the page session cannot be signed out', async t => {
  const events = [];
  const source = await sourceWithFakePlaywright(t, { events, logoutError: 'socket hang up' });
  await screenshot({ source, origin: 'http://127.0.0.1:4100', output: '/tmp/page.png' });
  assert.deepEqual(names(events).slice(-3), ['screenshot', 'logout', 'close']);
});
