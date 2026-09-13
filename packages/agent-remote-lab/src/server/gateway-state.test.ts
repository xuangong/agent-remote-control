// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openGatewayState } from './gateway-state.js';
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function path() { const directory = mkdtempSync(join(tmpdir(), 'relay-state-')); directories.push(directory); return join(directory, 'state.json'); }
it('atomically restores private state and detects tampering or a different authority scope', () => {
  const file = path(); const state = openGatewayState<{ value: number }>(file, 'secret', 'origin');
  state.save({ value: 1 }); state.save({ value: 2 }); state.close();
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const restored = openGatewayState<{ value: number }>(file, 'secret', 'origin'); expect(restored.initial).toEqual({ value: 2 }); restored.close();
  expect(() => openGatewayState(file, 'other-secret', 'origin')).toThrow('does not match');
  const content = JSON.parse(readFileSync(file, 'utf8')); content.payload = '{"value":3}'; writeFileSync(file, JSON.stringify(content));
  expect(() => openGatewayState(file, 'secret', 'origin')).toThrow('does not match');
});
it('keeps ownership exclusive during stale recovery and never releases another owner lock', () => {
  const file = path(); writeFileSync(file + '.lock', '2147483647');
  writeFileSync(file + '.lock.recovery', '');
  expect(() => openGatewayState(file, 'secret', 'origin')).toThrow();
  expect(readFileSync(file + '.lock', 'utf8')).toBe('2147483647');
  rmSync(file + '.lock.recovery');
  const first = openGatewayState(file, 'secret', 'origin');
  expect(() => openGatewayState(file, 'secret', 'origin')).toThrow('Another Relay');
  const owner = JSON.stringify({ pid: process.pid, id: 'different-owner' }); writeFileSync(file + '.lock', owner);
  first.close(); expect(readFileSync(file + '.lock', 'utf8')).toBe(owner);
});
