import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { gatewayRelayTestRuntime } from './gateway-relay-test-runtime.mjs';

const root = resolve(import.meta.dirname, '..');
const gateway = process.env.AGENT_REMOTE_GATEWAY_CHECKOUT;
if (!gateway && process.env.AGENT_REMOTE_TEST_DOCKER !== '1') throw new Error('Set AGENT_REMOTE_GATEWAY_CHECKOUT to the gateway worktree.');
const fetch = (input, init = {}) => globalThis.fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(10_000) });
const nextEvent = (emitter, name) => once(emitter, name, { signal: AbortSignal.timeout(10_000) });
const require = createRequire(join(root, 'packages/agent-remote-lab/package.json'));
const { chromium } = require('@playwright/test');
const { WebSocket } = require('ws');
const temporary = await mkdtemp(join(tmpdir(), 'agent-remote-gateway-'));
const processes = [];
const sockets = [];
let browser;
let runtime;
const logs = [];
function launch(command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.push(child);
  child.on('error', error => { child.startupError = error; });
  child.stdout.on('data', value => logs.push(value.toString()));
  child.stderr.on('data', value => logs.push(value.toString()));
  return child;
}
function stop(signal = 'SIGTERM') {
  for (const child of processes) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try { process.kill(-child.pid, signal); } catch { /* Process already exited. */ }
  }
}
const timeoutMs = process.env.AGENT_REMOTE_TEST_DOCKER === '1' ? 360_000 : 120_000;
const deadline = setTimeout(() => {
  stop('SIGKILL'); process.stderr.write('Gateway Relay test exceeded its process deadline.\n');
  Promise.resolve(runtime?.close()).finally(() => process.exit(124));
}, timeoutMs);
async function port() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
async function ready(file, child) {
  for (let i = 0; i < 150; i++) {
    try { return JSON.parse(await readFile(file, 'utf8')); } catch { /* Startup is still running. */ }
    if (child.startupError) throw child.startupError;
    if (child.exitCode !== null) throw new Error('Fixture exited before readiness.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Fixture startup exceeded 15 seconds.');
}
try {
  const relayPort = await port(); const gatewayPort = await port();
  const relayUrl = `http://127.0.0.1:${relayPort}`; const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  const env = { AGENT_REMOTE_RELAY_URL: relayUrl, AGENT_REMOTE_ISSUER: gatewayUrl, AGENT_REMOTE_SIGNING_SECRET: randomBytes(32).toString('base64url') };
  runtime = await gatewayRelayTestRuntime({ root, gateway, temporary, env, relayPort, gatewayPort, launch, ready });
  await runtime.start();
  browser = await chromium.launch({ headless: true, ...(process.env.AGENT_REMOTE_TEST_BROWSER ? { executablePath: process.env.AGENT_REMOTE_TEST_BROWSER } : {}) });
  const context = await browser.newContext(); const page = await context.newPage();
  page.setDefaultTimeout(10_000); page.setDefaultNavigationTimeout(15_000);
  await page.goto(relayUrl);
  await page.getByRole('link', { name: 'Sign in through gateway' }).waitFor();
  await context.addCookies([{ name: 'session_token', value: 'ses_agent_remote_alice', url: gatewayUrl }]);
  await page.goto(gatewayUrl + '/agent-remote');
  await page.waitForURL(relayUrl + '/');
  await page.getByRole('button', { name: 'Pair Agent Host', exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, '');
  const state = await page.evaluate(async () => (await fetch('/auth/status')).json());
  const pairing = await page.evaluate(async base => (await fetch(base + 'v1/remote/pairings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json(), state.basePath);
  assert.equal(pairing.serverUrl, relayUrl);
  let sharedCreations = 0;
  const sharedBindings = new Map();
  async function connectHost() {
    const host = new WebSocket(relayUrl.replace('http:', 'ws:') + '/ws/remote-host', { headers: { authorization: `Bearer ${pairing.key}` } }); sockets.push(host);
    await nextEvent(host, 'open'); const registered = nextEvent(host, 'message');
    host.send(JSON.stringify({ uplinkVersion: 2, type: 'register', credentialRotation: true, installationId: 'integration-host', name: 'Integration Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
    let reply = JSON.parse((await registered)[0].toString());
    if (reply.type === 'credential_issued') {
      pairing.key = reply.credential; const saved = nextEvent(host, 'message');
      host.send(JSON.stringify({ uplinkVersion: 2, type: 'credential_saved' }));
      reply = JSON.parse((await saved)[0].toString());
    }
    assert.equal(reply.type, 'registered');
    const hostId = reply.hostId;
    host.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'credential_issued') { pairing.key = message.credential; host.send(JSON.stringify({ uplinkVersion: 2, type: 'credential_saved' })); return; }
      if (message.type !== 'rpc_request') return;
      let creation;
      if (message.path === '/remote/create') {
        const input = JSON.parse(message.body);
        if (input.cwd === '/uncertain') {
          host.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: message.requestId, status: 503, body: JSON.stringify({ code: 'mutation_outcome_unknown', error: 'Uncertain native outcome' }) }));
          return;
        }
        creation = sharedBindings.get(input.requestId);
        if (!creation) { sharedCreations++; creation = { agentId: `shared-agent-${sharedCreations}`, nativeSessionId: `shared-native-${sharedCreations}` }; sharedBindings.set(input.requestId, creation); }
      }
      const body = creation ?? (message.path === '/remote/stop' ? { results: [{ agentId: 'test-agent', status: 'cancelled' }, { agentId: 'unsupported-agent', status: 'unsupported' }] } : message.path.startsWith('/remote/catalog/revision') ? { revision: '1' }
        : message.path.startsWith('/remote/catalog/session') ? { nativeSessionId: new URL(message.path, relayUrl).searchParams.get('nativeSessionId'), providerId: 'codex', title: 'Shared topic', state: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
        : message.path.startsWith('/remote/catalog') ? { items: [{ nativeSessionId: 'test-native', providerId: 'codex', title: 'Private test session', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: 'idle' }], revision: '1', hasMore: false }
        : message.path === '/remote/attach' ? ([...sharedBindings.values()].find(value => value.nativeSessionId === JSON.parse(message.body).nativeSessionId) ?? { agentId: 'test-agent', nativeSessionId: 'test-native' })
        : message.path.startsWith('/v1/sessions/') ? { restored: true }
        : message.path.startsWith('/remote/workspaces') ? { workspaces: [] } : { models: [] });
      host.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: message.requestId, status: 200, body: JSON.stringify(body) }));
    });
    return { host, hostId };
  }
  const { hostId } = await connectHost();
  await page.reload();
  await page.getByRole('option', { name: 'Integration Host · Online', exact: true }).waitFor({ state: 'attached' });
  const hosts = await page.evaluate(async base => (await fetch(base + 'v1/remote/hosts')).json(), state.basePath);
  assert.equal(hosts.hosts[0].id, hostId);
  await page.locator('#remote-host').selectOption(hostId);
  await page.getByText('Private test session', { exact: true }).first().waitFor();
  const bob = await browser.newContext(); const other = await bob.newPage(); other.setDefaultTimeout(10_000);
  await bob.addCookies([{ name: 'session_token', value: 'ses_agent_remote_bob', url: gatewayUrl }]);
  await other.goto(gatewayUrl + '/agent-remote'); await other.waitForURL(relayUrl + '/');
  const isolation = await other.evaluate(async alicePath => {
    const own = await (await fetch('/auth/status')).json();
    return { own: await (await fetch(own.basePath + 'v1/remote/hosts')).json(), forbidden: (await fetch(alicePath + 'v1/remote/hosts')).status, basePath: own.basePath };
  }, state.basePath);
  assert.deepEqual(isolation.own, { hosts: [] }); assert.equal(isolation.forbidden, 403); assert.notEqual(isolation.basePath, state.basePath);
  const shareRequest = (method, body) => fetch(gatewayUrl + `/api/agent-remote/hosts/${hostId}/shares`, { method,
    headers: { authorization: 'Bearer ses_agent_remote_alice', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await shareRequest('PUT', { email: 'bob@example.com', sessionLimit: 1 })).status, 200);
  const gatewayHosts = await fetch(gatewayUrl + '/api/agent-remote/hosts', { headers: { authorization: 'Bearer ses_agent_remote_bob' } });
  assert.equal(gatewayHosts.status, 200);
  assert.deepEqual((await gatewayHosts.json()).hosts[0].sessionQuota, { limit: 1, used: 0 });
  await other.goto(gatewayUrl + `/agent-remote?host=${hostId}`);
  await other.waitForURL(relayUrl + `/?host=${hostId}`);
  await other.waitForFunction(id => document.querySelector('#remote-host')?.value === id, hostId);
  const bobRequest = (path, body) => other.evaluate(async ({ path, body }) => {
    const state = await (await fetch('/auth/status')).json();
    const response = await fetch(state.basePath + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }, { path, body });
  const createPath = `v1/remote/hosts/${hostId}/create`;
  const creation = await bobRequest(createPath, { providerId: 'codex', requestId: 'topic-one' });
  assert.equal(creation.status, 200); assert.equal(sharedCreations, 1);
  assert.deepEqual(await bobRequest(createPath, { providerId: 'codex', requestId: 'topic-one' }), creation);
  assert.equal((await bobRequest(createPath, { providerId: 'codex', requestId: 'topic-two' })).body.code, 'session_quota_exceeded');
  assert.equal((await bobRequest(`v1/remote/hosts/${hostId}/attach`, { providerId: 'codex', nativeSessionId: 'test-native' })).status, 403);
  const privateCatalog = await bobRequest(`v1/remote/hosts/${hostId}/catalog?providerId=codex`);
  assert.equal(privateCatalog.status, 200); assert.equal(privateCatalog.body.items.length, 1);
  assert.equal(privateCatalog.body.items[0].title, 'Shared topic');
  await other.reload();
  await other.getByRole('status').filter({ hasText: 'Session creation allowance used: 1 / 1.' }).waitFor();
  assert.equal(await other.getByRole('button', { name: 'New session', exact: true }).isDisabled(), true);
  await other.screenshot({ path: join(temporary, 'shared-controller.png'), fullPage: true });
  assert.equal((await shareRequest('PUT', { email: 'bob@example.com', sessionLimit: 2 })).status, 200);
  assert.equal((await bobRequest(createPath, { providerId: 'codex', requestId: 'uncertain', cwd: '/uncertain' })).status, 503);
  assert.equal((await bobRequest(createPath, { providerId: 'codex', requestId: 'uncertain', cwd: '/uncertain' })).body.code, 'creation_outcome_unknown');
  const cookies = await context.cookies(relayUrl); const session = cookies.find(cookie => cookie.name === 'arc_session');
  assert.equal(session?.httpOnly, true); assert.equal(session?.sameSite, 'Strict');
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  assert.equal(storage.includes(session.value), false);
  const forwarded = await fetch(gatewayUrl + '/api/agent-remote/launch', { method: 'POST', headers: { authorization: 'Bearer ses_agent_remote_bob', 'content-type': 'application/json' }, body: JSON.stringify({ challenge: 'n'.repeat(43) }) });
  assert.equal(forwarded.status, 200);
  const { launchUrl } = await forwarded.json();
  await page.goto(launchUrl);
  await page.getByRole('heading', { name: 'Let’s try signing in again', exact: true }).waitFor();
  const retained = await page.evaluate(async () => (await fetch('/auth/status')).json());
  assert.equal(retained.basePath, state.basePath, 'A forwarded grant must not switch the victim account');
  await page.goto(relayUrl);
  await page.getByRole('option', { name: 'Integration Host · Online', exact: true }).waitFor({ state: 'attached' });
  const refreshed = await page.evaluate(async () => { const response = await fetch('/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); return { status: response.status, value: await response.json() }; });
  assert.equal(refreshed.status, 200); assert.equal(refreshed.value.basePath, state.basePath);
  const attached = await page.evaluate(async ({ base, hostId }) => (await fetch(base + `v1/remote/hosts/${hostId}/attach`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providerId: 'codex', nativeSessionId: 'test-native' }) })).json(), { base: state.basePath, hostId });
  assert.equal(attached.agentId, 'test-agent');
  await runtime.restart({ crash: true });
  const restored = await connectHost(); assert.equal(restored.hostId, hostId);
  await page.reload();
  await page.getByRole('option', { name: 'Integration Host · Online', exact: true }).waitFor({ state: 'attached' });
  const snapshot = await page.evaluate(async base => (await fetch(base + 'v1/sessions/test-agent/snapshot')).json(), state.basePath);
  assert.deepEqual(snapshot, { restored: true });
  const sharedAfterRestart = await bobRequest('v1/remote/hosts');
  assert.deepEqual(sharedAfterRestart.body.hosts[0].sessionQuota, { limit: 2, used: 2 });
  assert.equal((await bobRequest(createPath, { providerId: 'codex', requestId: 'uncertain', cwd: '/uncertain' })).body.code, 'creation_outcome_unknown');
  assert.deepEqual(await bobRequest(createPath, { providerId: 'codex', requestId: 'topic-one' }), creation);
  assert.equal((await bobRequest(createPath, { providerId: 'codex', requestId: 'topic-two' })).body.code, 'session_quota_exceeded');
  assert.equal(sharedCreations, 1);
  assert.equal((await shareRequest('DELETE', { email: 'bob@example.com' })).status, 200);
  assert.deepEqual((await bobRequest('v1/remote/hosts')).body, { hosts: [] });
  assert.equal(restored.host.readyState, WebSocket.OPEN);
  assert.equal((await shareRequest('PUT', { email: 'bob@example.com', sessionLimit: 1 })).status, 200);
  assert.equal((await bobRequest(createPath, { providerId: 'codex', requestId: 'topic-two' })).body.code, 'session_quota_exceeded');
  await page.locator('#remote-host').selectOption(hostId);
  await page.getByRole('button', { name: 'Rotate credential', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm rotation', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Rotation pending.' }).waitFor();
  assert.equal(restored.host.readyState, WebSocket.OPEN);
  await page.getByRole('button', { name: 'Stop work', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm stop', exact: true }).click();
  await page.getByText('Cancellation unsupported', { exact: false }).waitFor();
  assert.equal(restored.host.readyState, WebSocket.OPEN);
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36' });
  const phone = await mobile.newPage(); phone.setDefaultTimeout(10000);
  await mobile.addCookies([{ name: 'session_token', value: 'ses_agent_remote_alice', url: gatewayUrl }]);
  await phone.goto(gatewayUrl + `/agent-remote?host=${hostId}`); await phone.waitForURL(relayUrl + `/?host=${hostId}`);
  await phone.getByRole('button', { name: 'Settings', exact: true }).click();
  await phone.getByRole('region', { name: 'Controller settings' }).getByRole('button', { name: 'Security', exact: true }).click();
  const phoneSecurity = phone.getByRole('main', { name: 'Security', exact: true });
  await phoneSecurity.getByText('Android · Chrome', { exact: true }).waitFor();
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await phone.screenshot({ path: join(temporary, 'security-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Security', exact: true }).click();
  const securityPanel = page.getByRole('main', { name: 'Security', exact: true });
  await securityPanel.getByRole('button', { name: 'Sign out Android · Chrome', exact: true }).click();
  await securityPanel.getByRole('button', { name: 'Confirm sign out', exact: true }).click();
  await securityPanel.getByRole('status').filter({ hasText: 'Android · Chrome signed out.' }).waitFor();
  assert.equal(await phone.evaluate(async () => (await fetch('/auth/status')).status), 401);
  await page.screenshot({ path: join(temporary, 'security-desktop.png'), fullPage: true });
  await securityPanel.getByRole('button', { name: 'Back to conversation', exact: true }).click();
  await mobile.close();
  await page.screenshot({ path: join(temporary, 'controller.png'), fullPage: true });
  await page.locator('#remote-host').selectOption(hostId);
  await page.getByRole('button', { name: 'Revoke Host', exact: true }).click();
  const hostClosed = nextEvent(restored.host, 'close');
  await page.getByRole('button', { name: 'Confirm revoke', exact: true }).click(); await hostClosed;
  const revoked = await page.evaluate(async base => (await fetch(base + 'v1/remote/hosts')).json(), state.basePath);
  assert.deepEqual(revoked, { hosts: [] });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('link', { name: 'Sign in through gateway' }).waitFor();
  await bob.close(); await context.close();
  console.log('PASS: real gateway SQLite auth -> callback -> HttpOnly cookie -> controller -> Host catalog; two browser users isolated; forwarded login grant rejected; renewal, process restart with stable device/binding, device rotation without disconnect, explicit partial stop outcomes, mobile security management and other-browser revocation, device revoke and logout verified; shared Host Gateway APIs, selected-Host login, per-user catalog, cumulative quota, retry identity, quota and unresolved-reservation persistence, revoke/regrant verified. No CLI agents started.');
  console.log(`Runtime: ${runtime.runtime}${runtime.docker ? " (Docker)" : ""}; Evidence: ${temporary}`);
} catch (error) {
  await writeFile(join(temporary, 'failure.log'), logs.join(''));
  if (browser) { try { await browser.contexts()[0]?.pages()[0]?.screenshot({ path: join(temporary, 'failure.png'), fullPage: true }); } catch { /* Browser may already be closed. */ } }
  console.error(error); console.error(`Fixture diagnostics: ${temporary}`); process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.terminate();
  stop(); await browser?.close();
  await Promise.all(processes.map(child => child.exitCode !== null || child.signalCode !== null ? undefined : Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))])));
  stop('SIGKILL');
  try { await runtime?.close(); } finally { clearTimeout(deadline); }
}
