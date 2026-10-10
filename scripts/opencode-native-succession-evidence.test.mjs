import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const enabled = process.env.AGENT_OPENCODE_SUCCESSION_EVIDENCE === '1';
const expectedHash = '4f5979c2dadb06fbff1335335afaaea274e58f92e79aa43cf2ed98618d555422';
const expectedExecutable = '/opt/homebrew/Cellar/opencode/1.18.18/bin/opencode';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fileDigest = async path => createHash('sha256').update(await readFile(path)).digest('hex');

// This opt-in raw SDK experiment neither enables succession nor uses /api/session.
test('OpenCode existing execution API crash evidence', { skip: !enabled, timeout: 100000 }, async t => {
  const report = { startedAt: new Date().toISOString(), nativeRequests: [], modelRequests: [], processes: [], cases: [], cleanup: {} };
  let probe;
  let emptyRecovered = false;
  try {
    const environment = await preflight();
    report.identity = environment.identity;
    await t.test('recovers the exact committed empty B after SIGKILL', { timeout: 30000 }, async caseTest => {
      const observation = { kind: 'empty-committed-candidate', classification: 'unresolved' };
      report.cases.push(observation);
      try {
        probe = await makeProbe(environment, report);
        await probe.verifyIsolation(caseTest.signal);
        await probe.start(caseTest.signal);
        observation.beforeCreate = await probe.snapshots(caseTest.signal);
        probe.assertConfig(observation.beforeCreate.config);
        await probe.persist();
        const created = await probe.call('create', { directory: probe.cwd, title: 'Isolated succession evidence', model: { providerID: 'arc', id: 'fixture' } }, caseTest.signal);
        assert.match(created.id, /^ses_[A-Za-z0-9]+$/);
        assert.equal(await realpath(created.directory), probe.cwd);
        probe.witness.candidateId = created.id;
        probe.witness.roleCommittedTo = created.id;
        probe.witness.creationPhase = 'returned-exact-id-and-committed';
        await probe.persist();
        observation.beforeCrash = { session: created, messages: await probe.call('messages', { sessionID: created.id, directory: probe.cwd, limit: 100 }, caseTest.signal), facts: await probe.snapshots(caseTest.signal, created.id) };
        assert.deepEqual(observation.beforeCrash.messages, []);
        assert.equal(report.modelRequests.length, 0);
        await probe.kill('SIGKILL');
        await probe.start(caseTest.signal);
        const saved = await probe.reload();
        assert.equal(saved.roleCommittedTo, saved.candidateId);
        observation.afterCrash = { session: await probe.call('get', { sessionID: saved.candidateId, directory: saved.cwd }, caseTest.signal), messages: await probe.call('messages', { sessionID: saved.candidateId, directory: saved.cwd, limit: 100 }, caseTest.signal), facts: await probe.snapshots(caseTest.signal, saved.candidateId) };
        assert.equal(observation.afterCrash.session.id, saved.candidateId);
        assert.equal(await realpath(observation.afterCrash.session.directory), saved.cwd);
        assert.deepEqual(observation.afterCrash.messages, []);
        assert.equal(report.modelRequests.length, 0);
        assert.equal(report.nativeRequests.filter(row => row.method === 'POST' && row.path === '/session').length, 1);
        observation.classification = 'verified-exact-empty-candidate-recovery';
        emptyRecovered = true;
      } catch (error) {
        observation.classification = probe?.witness.roleCommittedTo ? 'unresolved-committed-candidate-recovery' : 'blocked-before-candidate-commit';
        observation.error = error.message;
        throw error;
      }
    });
    await t.test('reads exact first U after response loss and crash without replay', { timeout: 30000, skip: !emptyRecovered }, async caseTest => {
      const observation = { kind: 'lost-ack-first-input', classification: 'unresolved' };
      report.cases.push(observation);
      try {
        const saved = await probe.reload();
        const composedText = `BEGIN_ISOLATED_CONTEXT\n${saved.pendingContext.content}\nEND_ISOLATED_CONTEXT\n\nCount the three words: amber birch cedar.`;
        const parts = [{ type: 'text', text: composedText }];
        probe.witness.input = { messageId: `msg_${(BigInt(Date.now()) * 4096n).toString(16).padStart(12, '0')}${randomBytes(10).toString('hex')}`, recipient: saved.candidateId, contextId: saved.pendingContext.id, contextDigest: digest(saved.pendingContext), parts, composedText, payloadDigest: digest(parts), phase: 'dispatch-intended' };
        await probe.persist();
        await probe.dispatchWithLostResponse(caseTest.signal);
        const beforeCrashMessages = await probe.call('messages', { sessionID: saved.candidateId, directory: saved.cwd, limit: 100 }, caseTest.signal);
        observation.beforeCrash = { facts: await probe.snapshots(caseTest.signal, saved.candidateId), responseHeldIncomplete: probe.heldIncomplete(), proxy: probe.proxyEvidence(), assistantCompleted: beforeCrashMessages.some(row => row.info.role === 'assistant' && row.info.time?.completed !== undefined) };
        assert.equal(observation.beforeCrash.responseHeldIncomplete, true);
        assert.equal(observation.beforeCrash.proxy.forwarded, 1);
        assert.equal(observation.beforeCrash.proxy.clientResponseDelivered, false);
        assert.equal(observation.beforeCrash.assistantCompleted, false);
        await probe.kill('SIGKILL');
        const requestsAtCrash = report.modelRequests.length;
        await probe.start(caseTest.signal);
        const durable = await probe.reload();
        assert.equal(durable.input.phase, 'dispatch-intended');
        assert.equal(durable.roleCommittedTo, durable.input.recipient);
        assert.equal(durable.input.contextId, durable.pendingContext.id);
        assert.equal(durable.input.contextDigest, digest(durable.pendingContext));
        assert.equal(durable.input.payloadDigest, digest(durable.input.parts));
        observation.session = await probe.call('get', { sessionID: durable.input.recipient, directory: durable.cwd }, caseTest.signal);
        assert.equal(observation.session.id, durable.input.recipient);
        assert.equal(await realpath(observation.session.directory), durable.cwd);
        observation.message = await probe.call('message', { sessionID: durable.input.recipient, messageID: durable.input.messageId, directory: durable.cwd }, caseTest.signal);
        assert.equal(observation.message.info.role, 'user');
        assert.equal(observation.message.info.id, durable.input.messageId);
        assert.equal(observation.message.info.sessionID, durable.input.recipient);
        assert.deepEqual(observation.message.parts.map(part => ({ type: part.type, text: part.text })), durable.input.parts);
        assert.ok(observation.message.parts.every(part => part.messageID === durable.input.messageId && part.sessionID === durable.input.recipient));
        const messages = await probe.call('messages', { sessionID: durable.input.recipient, directory: durable.cwd, limit: 100 }, caseTest.signal);
        observation.enumeration = { count: messages.length, occurrencesOfU: messages.filter(row => row.info.id === durable.input.messageId).length, assistantCompleted: messages.some(row => row.info.role === 'assistant' && row.info.time?.completed !== undefined) };
        assert.equal(observation.enumeration.occurrencesOfU, 1);
        assert.equal(observation.enumeration.assistantCompleted, false);
        observation.afterCrash = await probe.snapshots(caseTest.signal, durable.input.recipient);
        observation.reconciliationModelRequestDelta = report.modelRequests.length - requestsAtCrash;
        assert.equal(observation.reconciliationModelRequestDelta, 0);
        assert.equal(report.nativeRequests.filter(row => row.path.endsWith('/prompt_async')).length, 1);
        observation.classification = 'verified-exact-input-materialization';
      } catch (error) {
        observation.classification = 'unresolved-input-outcome-no-replay';
        observation.error = error.message;
        throw error;
      }
    });
    if (!emptyRecovered) report.cases.push({ kind: 'lost-ack-first-input', classification: 'not-run-empty-candidate-not-established' });
  } finally {
    let cleanupError;
    if (probe) try { await probe.cleanup(); } catch (error) { cleanupError = error; report.cleanup.error = error.message; }
    report.finishedAt = new Date().toISOString();
    if (probe) {
      const output = process.env.AGENT_OPENCODE_SUCCESSION_EVIDENCE_OUTPUT;
      if (output) await writeFile(output, JSON.stringify(probe.sanitize(report), null, 2) + '\n', { flag: 'wx' });
      console.log(JSON.stringify({ cases: report.cases.map(({ kind, classification }) => ({ kind, classification })), cleanup: report.cleanup, output: output ?? null }));
    }
    if (cleanupError) throw cleanupError;
  }
});

async function bound(work, ms, label) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms); })]); }
  finally { clearTimeout(timer); }
}

async function until(check, signal, ms, label) {
  const expires = Date.now() + ms;
  while (Date.now() < expires) {
    signal.throwIfAborted();
    const value = await check();
    if (value) return value;
    await delay(25, undefined, { signal });
  }
  throw new Error(`${label} exceeded ${ms}ms`);
}

async function listen(server) {
  await bound(new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }), 1000, 'loopback listener');
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
  server.closeAllConnections();
  if (server.listening) await bound(new Promise(resolve => server.close(resolve)), 1000, 'loopback listener close');
}

async function preflight() {
  assert.equal(process.platform, 'darwin', 'The experiment requires the macOS sandbox.');
  assert.equal(process.arch, 'arm64');
  const executable = process.env.AGENT_OPENCODE_TEST_EXECUTABLE;
  assert.ok(isAbsolute(executable ?? ''), 'Supply an explicit absolute AGENT_OPENCODE_TEST_EXECUTABLE.');
  const selected = await realpath(executable);
  assert.equal(selected, await realpath(expectedExecutable));
  assert.equal(await fileDigest(selected), expectedHash, 'Installed native bytes differ from the reviewed preflight.');
  const sdkRoot = await realpath(new URL('../packages/agent-provider-opencode/node_modules/@opencode-ai/sdk', import.meta.url));
  const sdkPackage = JSON.parse(await readFile(join(sdkRoot, 'package.json'), 'utf8'));
  const sdkPath = join(sdkRoot, sdkPackage.exports['./v2/client'].import);
  const sdkVersion = sdkPackage.version;
  assert.equal(sdkVersion, '1.18.31');
  const deniedHome = await realpath(userInfo().homedir);
  assert.notEqual(deniedHome, '/');
  for (const path of [selected, sdkPath, process.execPath, tmpdir()]) {
    const rel = relative(deniedHome, await realpath(path));
    assert.ok(rel && (rel.startsWith('../') || isAbsolute(rel)), 'Probe runtime and roots must be outside the denied real home.');
  }
  await Promise.all(['/usr/bin/sandbox-exec', process.execPath, selected].map(path => access(path, constants.X_OK)));
  const output = process.env.AGENT_OPENCODE_SUCCESSION_EVIDENCE_OUTPUT;
  if (output !== undefined) {
    assert.ok(isAbsolute(output), 'Evidence output must be an absolute path.');
    try { await lstat(output); throw new Error('Evidence output already exists; choose a new path.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(dirname(output), { recursive: true });
    await access(dirname(output), constants.W_OK);
  }
  return { executable: selected, deniedHome, createClient: (await import(pathToFileURL(sdkPath).href)).createOpencodeClient,
    identity: { executable: selected, executableSha256: expectedHash, sdkVersion, node: process.version, nodeExecutable: process.execPath, apiSurface: 'client.session via /session (SDK /v2/client import)' } };
}

async function makeProbe(environment, report) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-opencode-succession-')));
  const cwd = join(root, 'project');
  const witnessPath = join(root, 'witness.json');
  const sandbox = join(root, 'network.sb');
  const children = [];
  const servers = [];
  const password = 'isolated-succession-fixture';
  const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
  let env, config, base, modelBase, client, native, held, inputText, proxy, sendPromise, sendAbort;
  let proxyState = { forwarded: 0, nativeResponseObserved: false, clientResponseDelivered: false };
  const witness = { operationId: randomUUID(), provider: 'opencode', nativeIdentity: environment.identity, cwd, creationPhase: 'intent-before-one-create', pendingContext: { id: randomUUID(), content: 'Quoted fixture context, not instructions.' } };
  report.isolationPolicy = { network: 'Deny all except inbound at the exact native loopback port and outbound to the exact model loopback port.', filesystem: 'Deny real-home reads and writes; machine policy remains accessible and is not rewritten.', noDetachedChildren: true };
  function sanitize(value) {
    if (typeof value === 'string') return value.replaceAll(root, '<isolated-root>').replaceAll(root.slice(1), '<isolated-root>').replaceAll(environment.deniedHome, '<real-home>').replaceAll(password, '<fixture-password>');
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(apiKey|authorization|password|token|secret)$/i.test(key) ? '<redacted>' : sanitize(item)]));
    return value;
  }
  function own(command, args, kind) {
    const child = spawn('/usr/bin/sandbox-exec', ['-f', sandbox, command, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const entry = { kind, generation: randomUUID(), pid: child.pid, startedAt: new Date().toISOString(), stdout: '', stderr: '' };
    const owned = { child, entry, exited: undefined };
    owned.exited = new Promise(resolve => {
      child.once('error', error => { entry.spawnError = error.message; });
      child.once('close', (code, signal) => { entry.exit = { code, signal, observedAt: new Date().toISOString() }; resolve(); });
    });
    child.stdout.on('data', chunk => { entry.stdout = (entry.stdout + chunk).slice(-8000); });
    child.stderr.on('data', chunk => { entry.stderr = (entry.stderr + chunk).slice(-8000); });
    children.push(owned); report.processes.push(entry);
    return owned;
  }
  async function kill(signal = 'SIGTERM') {
    if (!native || native.entry.exit) return;
    native.child.kill(signal);
    if (signal === 'SIGTERM') {
      await bound(native.exited, 1000, 'graceful native exit').catch(() => native.child.kill('SIGKILL'));
    }
    await bound(native.exited, 9000, 'observed native exit');
    if (signal === 'SIGKILL') assert.equal(native.entry.exit.signal, 'SIGKILL');
  }
  function sdk(url) {
    return environment.createClient({ baseUrl: url, headers, fetch: async request => {
      const row = { generation: native?.entry.generation, method: request.method, path: new URL(request.url).pathname };
      report.nativeRequests.push(row);
      try {
        const response = await fetch(new Request(request, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(5000)]), redirect: 'error' }));
        row.status = response.status;
        return response;
      } catch (error) { row.error = error.name; throw error; }
    } });
  }
  async function call(method, parameters, signal) {
    signal.throwIfAborted();
    const result = await client.session[method](parameters, { signal });
    if (!result.response?.ok || result.error !== undefined) throw new Error(`Public session.${method} failed: HTTP ${result.response?.status ?? 'unknown'}; ${String(JSON.stringify(result.error)).slice(0, 2000)}`);
    return result.data;
  }
  async function publicGet(path, signal, timeout = 5000) {
    const row = { generation: native?.entry.generation, method: 'GET', path: path.split('?')[0] };
    report.nativeRequests.push(row);
    const response = await fetch(base + path, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]), redirect: 'error' });
    row.status = response.status;
    const text = await response.text();
    if (!response.ok) throw new Error(`Public GET ${row.path} failed: HTTP ${response.status}; ${text.slice(0, 2000)}`);
    return JSON.parse(text);
  }
  async function start(signal) {
    signal.throwIfAborted();
    assert.ok(!native || native.entry.exit, 'Previous native generation must have exited.');
    native = own(environment.executable, ['serve', '--print-logs', '--hostname', '127.0.0.1', '--port', new URL(base).port], 'native-server');
    client = sdk(base);
    const health = await until(async () => {
      if (native.entry.exit || native.entry.spawnError) throw new Error(`Native startup exited: ${native.entry.stderr}`);
      try { return await publicGet('/global/health', signal, 300); }
      catch (error) { signal.throwIfAborted(); return undefined; }
    }, signal, 9500, 'native startup/health');
    native.entry.health = health;
    assert.equal(health.version, '1.18.18');
  }
  async function persist() {
    const temporary = join(root, `witness-${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(witness)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, witnessPath);
    const directory = await open(root, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async function reload() {
    const saved = JSON.parse(await readFile(witnessPath, 'utf8'));
    assert.equal(saved.operationId, witness.operationId);
    assert.equal(saved.configDigest, digest(saved.config));
    assert.equal(saved.profileDigest, digest(saved.profile));
    return saved;
  }
  async function snapshots(signal, sessionID) {
    const suffix = `?directory=${encodeURIComponent(cwd)}`;
    const facts = {};
    for (const [name, path] of [['config', '/config'], ['status', '/session/status'], ['permissions', '/permission'], ['questions', '/question'], ['agents', '/agent']]) facts[name] = await publicGet(path + suffix, signal);
    if (sessionID) facts.children = await call('children', { sessionID, directory: cwd }, signal);
    return facts;
  }
  function assertConfig(effective) {
    for (const key of ['plugin', 'mcp', 'instructions', 'share', 'autoupdate', 'snapshot', 'permission', 'tools', 'compaction', 'model', 'small_model', 'enabled_providers']) assert.deepEqual(effective[key], config[key], `Fixture policy ${key} was unsupported or changed by effective policy; do not override it.`);
    for (const name of ['plan', 'general', 'explore', 'title', 'summary', 'compaction']) assert.equal(effective.agent?.[name]?.disable, true, `Fixture agent ${name} was not disabled.`);
  }
  async function verifyIsolation(signal) {
    const control = createServer((request, response) => { report.isolationControlHits = (report.isolationControlHits ?? 0) + 1; response.end('control'); });
    servers.push(control);
    const controlBase = await listen(control);
    const code = `
      import { createServer } from 'node:http';
      import { readdir } from 'node:fs/promises';
      const result = {};
      result.modelLoopbackStatus = (await fetch(${JSON.stringify(modelBase + '/isolation')}, {signal:AbortSignal.timeout(1000)})).status;
      for (const [name, url] of Object.entries({otherLoopbackDenied:${JSON.stringify(controlBase)},externalDenied:'http://1.1.1.1'})) {
        try { await fetch(url, {signal:AbortSignal.timeout(800)}); result[name] = false; } catch { result[name] = true; }
      }
      try { await readdir(${JSON.stringify(environment.deniedHome)}); result.realHomeDenied = false; } catch (error) { result.realHomeDenied = ['EACCES','EPERM'].includes(error.code); }
      const forbidden = createServer();
      result.otherInboundDenied = await new Promise(resolve => { forbidden.once('error', error => resolve(['EACCES','EPERM'].includes(error.code))); forbidden.listen(0, '127.0.0.1', () => forbidden.close(() => resolve(false))); });
      const allowed = createServer((request, response) => { response.setHeader('Connection', 'close'); response.end('isolated-inbound'); allowed.close(); });
      allowed.listen(${Number(new URL(base).port)}, '127.0.0.1', () => console.log(JSON.stringify({...result,ready:true})));
    `;
    const worker = own(process.execPath, ['--input-type=module', '-e', code], 'sandbox-selftest');
    await until(() => {
      if (worker.entry.exit) throw new Error(`Sandbox self-test exited early: ${worker.entry.stderr}`);
      return worker.entry.stdout.includes('"ready":true');
    }, signal, 4500, 'sandbox self-test ready');
    report.isolation = JSON.parse(worker.entry.stdout.trim());
    const inbound = await fetch(base, { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) });
    report.isolation.exactNativeInbound = await inbound.text();
    await bound(worker.exited, 1000, 'sandbox self-test exit');
    assert.equal(worker.entry.exit.code, 0);
    assert.deepEqual(report.isolation, { modelLoopbackStatus: 204, otherLoopbackDenied: true, externalDenied: true, realHomeDenied: true, otherInboundDenied: true, ready: true, exactNativeInbound: 'isolated-inbound' });
    assert.equal(report.isolationControlHits ?? 0, 0);
    await closeServer(control);
  }
  async function dispatchWithLostResponse(signal) {
    const saved = await reload();
    inputText = saved.input.composedText;
    proxy = createServer(async (request, response) => {
      try {
        assert.equal(request.method, 'POST');
        assert.equal(new URL(request.url, base).pathname, `/session/${saved.input.recipient}/prompt_async`);
        let body = '';
        for await (const chunk of request) { body += chunk; assert.ok(body.length < 64000); }
        const parsed = JSON.parse(body);
        assert.equal(parsed.messageID, saved.input.messageId);
        assert.deepEqual(parsed.parts, saved.input.parts);
        proxyState.forwarded++;
        assert.equal(proxyState.forwarded, 1, 'No second input dispatch is authorized.');
        const upstream = await fetch(new URL(request.url, base), { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), redirect: 'error' });
        await upstream.arrayBuffer();
        proxyState.nativeResponseObserved = true;
        proxyState.nativeStatus = upstream.status;
        // Deliberately withhold every byte of the real acknowledgement.
      } catch (error) { proxyState.error = error.message; response.destroy(); }
    });
    servers.push(proxy);
    const proxyBase = await listen(proxy);
    sendAbort = new AbortController();
    sendPromise = sdk(proxyBase).session.promptAsync({ sessionID: saved.input.recipient, directory: saved.cwd, messageID: saved.input.messageId, model: { providerID: 'arc', modelID: 'fixture' }, parts: saved.input.parts }, { signal: AbortSignal.any([signal, sendAbort.signal]) }).then(result => { proxyState.clientResponseDelivered = Boolean(result.response); proxyState.senderError = result.error?.name; }, () => undefined);
    await until(() => {
      if (proxyState.error) throw new Error(proxyState.error);
      return held && proxyState.nativeResponseObserved;
    }, signal, 5000, 'held substantive request and lost native acknowledgement');
    assert.equal(proxyState.nativeStatus, 204, 'The status is proxy evidence only, not materialization evidence.');
    assert.equal(held.writableEnded, false);
    sendAbort.abort();
    await bound(sendPromise, 1000, 'discard volatile sender state');
    sendPromise = undefined; sendAbort = undefined;
    await closeServer(proxy);
  }
  async function cleanup() {
    sendAbort?.abort();
    for (const worker of children.filter(worker => !worker.entry.exit)) worker.child.kill('SIGTERM');
    await bound(Promise.all(children.map(worker => worker.exited)), 1000, 'graceful owned cleanup').catch(() => {
      for (const worker of children.filter(worker => !worker.entry.exit)) worker.child.kill('SIGKILL');
    });
    let cleanupError;
    try { await bound(Promise.all(children.map(worker => worker.exited)), 8000, 'observed owned exits'); }
    catch (error) { cleanupError = error; }
    for (const server of servers) await closeServer(server);
    report.cleanup.allOwnedExitsObserved = children.every(worker => worker.entry.exit);
    report.cleanup.remainingOwnedPids = children.filter(worker => !worker.entry.exit).map(worker => worker.child.pid);
    try { report.witness = await reload(); } catch (error) { report.cleanup.witnessReadError = error.message; }
    if (cleanupError || !report.cleanup.allOwnedExitsObserved) {
      report.cleanup.profilesRemoved = false;
      report.cleanup.retainedRoot = root;
      throw cleanupError ?? new Error('Keep isolated root until owned exits are observed.');
    }
    await rm(root, { recursive: true, force: true });
    report.cleanup.profilesRemoved = true;
  }
  try {
    env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', OPENCODE_DISABLE_AUTO_UPDATE: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_SERVER_PASSWORD: password, ARC_FIXTURE_KEY: 'fixture-only' };
    for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR']) {
      env[key] = join(root, key.toLowerCase());
      await mkdir(env[key]);
    }
    await mkdir(cwd);
    report.envKeys = Object.keys(env).sort();
    report.fixtureHttpRequests = [];
    const model = createServer(async (request, response) => {
      try {
        const path = request.url;
        assert.ok(report.fixtureHttpRequests.length < 40, 'Fixture request bound exceeded.');
        report.fixtureHttpRequests.push({ method: request.method, path });
        if (path === '/isolation') { response.writeHead(204).end(); return; }
        if (path !== '/v1/chat/completions' || request.method !== 'POST') { response.writeHead(404).end(); return; }
        let body = '';
        for await (const chunk of request) { body += chunk; assert.ok(body.length < 256000); }
        const input = JSON.parse(body);
        const texts = (input.messages ?? []).flatMap(message => (typeof message.content === 'string' ? [message.content] : (message.content ?? []).filter(part => part.type === 'text').map(part => part.text)).map(text => ({ role: message.role, text })));
        const system = texts.filter(row => row.role === 'system').map(row => row.text).join('\n');
        const substantive = inputText && system.startsWith('You are opencode, an interactive CLI tool') && texts.some(row => row.role === 'user' && row.text === inputText);
        const title = !substantive && /^You are (?:a |an )?title (?:generator|generation)/i.test(system);
        const summary = !substantive && /^You are (?:a summarization assistant|an AI assistant tasked with summarizing)/i.test(system);
        const classification = title ? 'auxiliary-title' : summary ? 'auxiliary-summary' : substantive ? 'substantive-user-turn' : 'unclassified';
        report.modelRequests.push({ classification, model: input.model, bodyDigest: digest(input), toolCount: input.tools?.length ?? 0, texts: texts.map(({ role, text }) => ({ role, length: text.length, digest: digest(text), excerpt: text.slice(0, 600) })) });
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (substantive) { held = response; response.flushHeaders(); return; }
        if (!title && !summary) { response.flushHeaders(); return; }
        for (const [delta, finish_reason] of [[{ role: 'assistant', content: 'Isolated fixture' }, null], [{}, 'stop']]) response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        response.end('data: [DONE]\n\n');
      } catch (error) { report.fixtureError = error.message; response.destroy(); }
    });
    servers.push(model);
    modelBase = await listen(model);
    const allocator = createServer();
    servers.push(allocator);
    base = await listen(allocator);
    await closeServer(allocator);
    config = { model: 'arc/fixture', small_model: 'arc/fixture', enabled_providers: ['arc'],
      provider: { arc: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `${modelBase}/v1`, apiKey: 'fixture-only' }, models: { fixture: { name: 'Fixture', limit: { context: 128000, output: 8192 } } } } },
      plugin: [], mcp: {}, instructions: [], permission: { '*': 'deny' }, tools: { '*': false }, share: 'disabled', autoupdate: false, snapshot: false, compaction: { auto: false },
      agent: Object.fromEntries(['plan', 'general', 'explore', 'title', 'summary', 'compaction'].map(name => [name, { disable: true }])) };
    await writeFile(join(cwd, 'opencode.json'), JSON.stringify(config));
    witness.config = config;
    witness.configDigest = digest(config);
    witness.profile = Object.fromEntries(['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR'].map(key => [key, env[key]]));
    witness.profileDigest = digest(witness.profile);
    await persist();
    await writeFile(sandbox, `(version 1)\n(allow default)\n(deny network*)\n(allow network-inbound (local ip "localhost:${new URL(base).port}"))\n(allow network-bind (local ip "localhost:${new URL(base).port}"))\n(allow network-outbound (remote ip "localhost:${new URL(modelBase).port}"))\n(deny file-read* (subpath ${JSON.stringify(environment.deniedHome)}))\n(deny file-write* (subpath ${JSON.stringify(environment.deniedHome)}))\n`);
    report.sandboxProfile = await readFile(sandbox, 'utf8');
  } catch (error) { await cleanup(); throw error; }
  return { cwd, witness, verifyIsolation, start, call, snapshots, assertConfig, persist, reload, kill, cleanup, dispatchWithLostResponse, heldIncomplete: () => Boolean(held && !held.writableEnded), proxyEvidence: () => ({ ...proxyState }), sanitize };
}
