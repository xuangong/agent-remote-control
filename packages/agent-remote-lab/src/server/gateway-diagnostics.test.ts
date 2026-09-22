// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { RelayDiagnostic } from '@orchardworks/agent-remote-hosted/relay-diagnostics';
import { openGatewayDiagnostics } from './gateway-diagnostics.js';
import { openGatewayState } from './gateway-state.js';
import { createGatewayRelay } from './gateway-relay.js';

const auth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 'diagnostic-test-secret-01234567890123456789' };
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function file() { const directory = mkdtempSync(join(tmpdir(), 'relay-diagnostics-')); directories.push(directory); return join(directory, 'state.json'); }
function entry(id = 'event-1', hostId = 'host-1', timestamp = new Date().toISOString()): RelayDiagnostic {
  return { id, hostId, timestamp, source: 'relay', relayInstanceId: 'relay-1', event: 'relay_started' };
}

it('restores private diagnostic snapshots without changing the business state', async () => {
  const stateFile = file(); const state = openGatewayState(stateFile, auth.secret, 'business');
  state.save({ preserved: true }); state.close();
  const before = readFileSync(stateFile, 'utf8'); const diagnostic = entry();
  const store = openGatewayDiagnostics(stateFile, auth);
  await store.save([entry('old')]); await store.save([diagnostic]);
  expect(openGatewayDiagnostics(stateFile, auth).initial).toEqual([diagnostic]);
  expect(statSync(stateFile + '.diagnostics.json').mode & 0o777).toBe(0o600);
  expect(readFileSync(stateFile, 'utf8')).toBe(before);
  expect(readdirSync(join(stateFile, '..')).filter(name => name.endsWith('.tmp'))).toEqual([]);
});

it('discards unreadable, oversized, malformed, or differently scoped snapshots during startup', async () => {
  const stateFile = file(); const path = stateFile + '.diagnostics.json';
  expect(openGatewayDiagnostics(stateFile, auth).initial).toEqual([]);
  writeFileSync(path, '{broken'); expect(openGatewayDiagnostics(stateFile, auth).initial).toEqual([]);
  writeFileSync(path, 'x'.repeat(8 * 1024 * 1024 + 1)); expect(openGatewayDiagnostics(stateFile, auth).initial).toEqual([]);
  await openGatewayDiagnostics(stateFile, auth).save([entry()]);
  for (const changed of [{ ...auth, origin: 'https://another.example' }, { ...auth, issuer: 'https://another.example' }, { ...auth, secret: 'different-secret' }]) {
    expect(openGatewayDiagnostics(stateFile, changed).initial).toEqual([]);
  }
  rmSync(path); mkdirSync(path);
  expect(openGatewayDiagnostics(stateFile, auth).initial).toEqual([]);
});

it('filters malformed and expired records and bounds snapshots before saving and after loading', async () => {
  const stateFile = file(); const path = stateFile + '.diagnostics.json'; const now = Date.now();
  const entries = Array.from({ length: 18 * 300 }, (_, index) => entry(String(index), 'host-' + Math.floor(index / 300), new Date(now - 10_000 + index).toISOString()));
  const invalid = { ...entry('unsafe'), message: 'must never persist' };
  const expired = entry('expired', 'host-expired', new Date(now - 86_400_001).toISOString());
  await openGatewayDiagnostics(stateFile, auth).save([...entries, invalid, expired]);
  const persisted = JSON.parse(readFileSync(path, 'utf8'));
  const restored = openGatewayDiagnostics(stateFile, auth).initial as RelayDiagnostic[];
  expect(restored).toHaveLength(4096);
  expect(Math.max(...Array.from(new Set(restored.map(value => value.hostId)), hostId => restored.filter(value => value.hostId === hostId).length))).toBeLessThanOrEqual(256);
  expect(readFileSync(path, 'utf8')).not.toContain('must never persist');
  persisted.entries = [...entries, invalid, expired]; writeFileSync(path, JSON.stringify(persisted));
  expect(openGatewayDiagnostics(stateFile, auth).initial).toEqual(restored);
});

it('leaves business writes usable after diagnostic writes fail and cleans temporary files', async () => {
  const stateFile = file(); const path = stateFile + '.diagnostics.json'; mkdirSync(path);
  const diagnostics = openGatewayDiagnostics(stateFile, auth);
  await expect(diagnostics.save([entry()])).rejects.toThrow();
  expect(readdirSync(join(stateFile, '..')).filter(name => name.endsWith('.tmp'))).toEqual([]);
  const state = openGatewayState(stateFile, auth.secret, 'business');
  await state.commit({ preserved: true }); state.close();
  const restored = openGatewayState(stateFile, auth.secret, 'business');
  try { expect(restored.initial).toEqual({ preserved: true }); } finally { restored.close(); }
});

it('starts a real HTTP Relay with unavailable diagnostic storage', async () => {
  const stateFile = file(); mkdirSync(stateFile + '.diagnostics.json');
  const relay = createGatewayRelay({ ...auth, origin: 'http://127.0.0.1:0', stateFile });
  try {
    const { url } = await relay.listen(0);
    const response = await fetch(url + '/auth/login', { redirect: 'manual', signal: AbortSignal.timeout(3000) });
    expect(response.status).toBe(303);
    expect(statSync(stateFile).isFile()).toBe(true);
  } finally { await relay.close(); }
});
