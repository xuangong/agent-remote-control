// The local native-prefix succession flow over the real Node Relay: a custom Provider adapter, the Workbench's directory client and
// the debugger runtime, checked over HTTP and WebSocket and across a Relay restart.
// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { createProtocolValidationServer } from '@orchardworks/agent-relay-node/protocol-validation-server';
import type { AgentPersistenceHandle } from '@orchardworks/agent-provider-sdk';
import { createDebuggerRuntime } from './runtime.js';
// @ts-expect-error Test-only adapter fixture is also used by standalone package smoke.
import { createPrefixAdapter } from './fixtures/prefix-adapter.mjs';
import { SessionDirectoryClient } from '@orchardworks/agent-remote-lab/directory-client';

const servers: ReturnType<typeof createProtocolValidationServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });

it('runs local prefix prepare and commit with stable source anchors over HTTP and WebSocket', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'lab-local-prefix-'));
  const adapter = createPrefixAdapter(root), origin = 'http://127.0.0.1:5175';
  const options = { providers: [adapter], labOrigin: origin, successionStateDirectory: join(root, 'state') };
  const server = createProtocolValidationServer(options); servers.push(server);
  const { url } = await server.http.listen(0);
  const post = (path: string, body: unknown) => fetch(`${url}/v1/remote/${path}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const providerId = 'prefix-fixture';
  const client = (baseUrl: string) => new SessionDirectoryClient(baseUrl, (input, init) => fetch(input, { ...init, headers: { ...init?.headers, origin } }));
  const assertNewReference = async (baseUrl: string, operationId: string) => {
    const created = await client(baseUrl).create(providerId, operationId, { cwd: root, sourceNativeSessionId: 'candidate-1' });
    const history = JSON.parse(await adapter.readSource(created.nativeSessionId, {}));
    expect(history.sourceSessionId).toBe('candidate-1');
    expect(JSON.stringify(history)).toContain('original history'); expect(JSON.stringify(history)).not.toContain('discarded tail');
  };
  const source = await (await post('create', { providerId, operationId: 'source', cwd: root })).json();
  const reader = await (await post('create', { providerId, operationId: 'reader', cwd: root, sourceNativeSessionId: source.nativeSessionId })).json();
  let old: Awaited<ReturnType<typeof createDebuggerRuntime>> | undefined;
  try {
    const before = JSON.parse(await adapter.readSource(reader.nativeSessionId, {})); expect(before.sourceSessionId).toBe(source.nativeSessionId);
    const description = await post('succession/describe', { providerId, nativeSessionId: reader.nativeSessionId, preparation: { kind: 'native_prefix', turnId: 'turn', messageId: 'message-1' } });
    expect(description.status).toBe(200); const { role } = await description.json();
    old = await createDebuggerRuntime(reader.agentId, { relayUrl: url, origin }); await old.ready(3000);
    const prepared = await post('succession/prepare', { operationId: 'edit', roleId: role.id, expectedRevision: 1, from: role.current, preparation: { kind: 'native_prefix', turnId: 'turn', messageId: 'message-1' } });
    expect(await prepared.json()).toMatchObject({ record: { phase: 'ready' } });
    await expect(adapter.readSource('candidate-1', {})).rejects.toThrow();
    await expect(client(url).create(providerId, 'pending-source', { cwd: root, sourceNativeSessionId: 'candidate-1' })).rejects.toMatchObject({ status: 404 });
    const committed = await post('succession/commit', { operationId: 'edit', expectedRevision: 1, roleId: role.id });
    expect(await committed.json()).toMatchObject({ record: { phase: 'committed' }, locator: { nativeSessionId: 'candidate-1' } });
    await assertNewReference(url, 'new-reference-before-restart');
    await expect(client(url).create(providerId, 'foreign-source', { cwd: root, sourceNativeSessionId: 'foreign' })).rejects.toMatchObject({ status: 404 });
    await expect(old.client.sendMessage('obsolete')).rejects.toThrow();
    expect(JSON.parse(await adapter.readSource('candidate-1', { sourceContext: before.sourceContext }))).toMatchObject({ sourceSessionId: source.nativeSessionId });
    await expect(adapter.readSource(reader.nativeSessionId, {})).rejects.toThrow();
    const attached = await post('attach', { providerId, nativeSessionId: reader.nativeSessionId }); expect(await attached.json()).toMatchObject({ nativeSessionId: 'candidate-1' });
    old.close(); await server.close(); servers.splice(servers.indexOf(server), 1);
    const restarted = createProtocolValidationServer(options); servers.push(restarted); const next = await restarted.http.listen(0);
    // A cold source-reference create must restore B without a preceding directory attach.
    await assertNewReference(next.url, 'new-reference-after-restart');
    const restored = await fetch(`${next.url}/v1/remote/attach`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ providerId, nativeSessionId: reader.nativeSessionId }), signal: AbortSignal.timeout(5000) });
    expect(await restored.json()).toMatchObject({ nativeSessionId: 'candidate-1' });
    expect(JSON.parse(await adapter.readSource('candidate-1', { sourceContext: before.sourceContext }))).toMatchObject({ sourceSessionId: source.nativeSessionId });
    expect((await adapter.state()).forks).toBe(1); expect((await adapter.state()).creates).toBe(4);
    expect((await adapter.state()).sessions['candidate-1'].texts).toEqual(['original history']);
    await restarted.close(); servers.splice(servers.indexOf(restarted), 1);
  } finally { old?.close(); if (servers.includes(server)) { await server.close(); servers.splice(servers.indexOf(server), 1); } await rm(root, { recursive: true, force: true }); }
}, 20000);

it.each(['external', 'unknown', 'error', 'unmarked', 'absent', 'changed', 'changed-after-validation', 'unsupported', 'missing-create', 'noncallable-verify', 'invalid-bound'] as const)('checks custom directory source grant state %s before native prefix effects', async (grantState) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'lab-custom-prefix-'));
  const adapter = createPrefixAdapter(root), origin = 'http://127.0.0.1:5175', providerId = adapter.descriptor.providerId;
  if (grantState === 'unsupported') delete adapter.nativePrefix;
  if (grantState === 'missing-create') delete adapter.nativePrefix.create;
  if (grantState === 'noncallable-verify') adapter.nativePrefix.verify = true;
  if (grantState === 'invalid-bound') adapter.nativePrefix.createdSessionIdMaxLength = 0;
  let described = false, externalAfterValidation = false;
  if (adapter.nativePrefix) {
    const capability = adapter.nativePrefix, validate = capability.validate, create = capability.create;
    if (typeof validate === 'function') capability.validate = async function (target: unknown) {
      expect(this).toBe(capability); await validate.call(this, target);
      if (grantState === 'changed-after-validation' && described) externalAfterValidation = true;
    };
    if (typeof create === 'function') capability.create = function (...args: unknown[]) { expect(this).toBe(capability); return create.apply(this, args); };
  }
  let handle: AgentPersistenceHandle | undefined;
  let opens = 0;
  let corruptHistory = false;
  const externalTools = grantState === 'external' ? { tools: [{ name: 'read_source_session', description: 'External source grant', inputSchema: { type: 'object' }, execute: async () => 'external source' }] } : {};
  const source = { providerId, supportsSourceReferences: true,
    ...(grantState === 'unmarked' ? {} : { sourceGrantState: async () => {
      if (grantState === 'error') throw new Error('Grant state unavailable.');
      if (grantState === 'changed') return described ? 'external' as const : 'absent' as const;
      if (grantState === 'changed-after-validation') return externalAfterValidation ? 'external' as const : 'absent' as const;
      return grantState === 'external' || grantState === 'unknown' ? grantState : 'absent' as const;
    } }),
    list: () => [{ nativeSessionId: 'external-reader', providerId, title: 'External reader', state: 'idle' as const, createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z' }], workspaces: () => [],
    create: async () => 'external-reader', open: async () => {
      opens++;
      const session = handle ? await adapter.resumeSession(handle, externalTools) : await adapter.createSession({ sessionId: 'external-reader', cwd: root, ...externalTools });
      handle = (await session.runtimeInfo()).persistence;
      if (corruptHistory) return new Proxy(session, { get(target, name) {
        if (name === 'runtimeInfo') return async () => ({ ...await target.runtimeInfo(), persistence: { ...handle!, opaque: 'wrong-exact-handle' } });
        const value = Reflect.get(target, name, target); return typeof value === 'function' ? value.bind(target) : value;
      } });
      return session;
    } };
  const options = { providers: [adapter], directories: [source], labOrigin: origin, successionStateDirectory: join(root, 'state') };
  let server = createProtocolValidationServer(options);
  try {
    const { url } = await server.http.listen(0);
    const post = (action: string, body: unknown) => fetch(`${url}/v1/remote/succession/${action}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    const response = await post('describe', { providerId, nativeSessionId: 'external-reader', preparation: { kind: 'native_prefix', turnId: 'turn', messageId: 'message-1' } });
    expect(response.status).toBe(200);
    const description = await response.json();
    expect(description.eligibility.status).toBe(grantState === 'absent' || grantState === 'changed' || grantState === 'changed-after-validation' ? 'ready' : 'unavailable');
    described = true;
    const { role } = description;
    const prepared = await post('prepare', { operationId: 'external-edit', roleId: role.id, expectedRevision: 1, from: role.current, preparation: { kind: 'native_prefix', turnId: 'turn', messageId: 'message-1' } });
    expect(prepared.status).toBe(200);
    expect(await prepared.json()).toMatchObject({ record: { phase: grantState === 'absent' ? 'ready' : 'rejected' } });
    expect((await adapter.state()).forks).toBe(grantState === 'absent' ? 1 : 0);
    if (grantState === 'absent') {
      expect(await (await post('commit', { operationId: 'external-edit', roleId: role.id, expectedRevision: 1 })).json()).toMatchObject({ record: { phase: 'committed' } });
      await server.close(); server = createProtocolValidationServer(options);
      const restored = await server.http.listen(0);
      const response = await fetch(`${restored.url}/v1/remote/attach`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ providerId, nativeSessionId: 'external-reader' }), signal: AbortSignal.timeout(5000) });
      expect(await response.json()).toMatchObject({ nativeSessionId: 'candidate-1' });
      expect(opens).toBe(1); expect((await adapter.state()).forks).toBe(1);
      const client = new SessionDirectoryClient(restored.url, (input, init) => fetch(input, { ...init, headers: { ...init?.headers, origin } }));
      corruptHistory = true;
      await expect(client.attachHistorical(providerId, 'external-reader', role.id)).rejects.toMatchObject({ status: 409 });
      corruptHistory = false;
      const historical = await client.attachHistorical(providerId, 'external-reader', role.id);
      expect(historical.nativeSessionId).toBe('external-reader'); expect(opens).toBe(3);
      const old = await createDebuggerRuntime(historical.agentId, { relayUrl: restored.url, origin });
      try { await old.ready(3000); await expect(old.client.sendMessage('historical custom input')).rejects.toThrow(); }
      finally { old.close(); }
      expect((await adapter.state()).creates).toBe(1);
    }
    if (grantState === 'external') {
      expect(await adapter.readSource('external-reader', {})).toBe('external source');
      await server.close(); server = createProtocolValidationServer(options);
      const restored = await server.http.listen(0);
      const response = await fetch(`${restored.url}/v1/remote/attach`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ providerId, nativeSessionId: 'external-reader' }), signal: AbortSignal.timeout(5000) });
      expect(response.status).toBe(200);
      expect(await adapter.readSource('external-reader', {})).toBe('external source');
      expect(opens).toBe(2); expect((await adapter.state()).creates).toBe(1);
    }
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
}, 20000);
