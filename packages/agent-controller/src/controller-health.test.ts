import { expect, it } from 'vitest';
import { createControllerHealth } from './controller-health.js';

function health(natives: Array<{ providerId: string; version?: string }> = [], launcher: { managed: boolean; version?: string } = { managed: true, version: '0.2.57' }) {
  let now = 1_000_000;
  const value = createControllerHealth({ natives: () => natives, launcher, now: () => now });
  return { health: value, advance(ms: number) { now += ms; } };
}

it('reports nothing for a quiet Controller with verified agents and a current launcher', () => {
  const { health: value } = health([{ providerId: 'claude', version: '2.1.247' }, { providerId: 'codex', version: '0.162.0' }]);
  value.request('session_attach', 200);
  const snapshot = value.snapshot();
  expect(snapshot.warnings).toEqual([]);
  expect(snapshot.requestFailures).toEqual([]);
  expect(snapshot.natives).toEqual([
    { providerId: 'claude', version: '2.1.247', verified: '2.1.296', newer: false },
    { providerId: 'codex', version: '0.162.0', verified: '0.162.0', newer: false },
  ]);
});

it('warns about a session that browsers keep reopening and forgets failures older than an hour', () => {
  const f = health();
  for (let index = 0; index < 59; index++) f.health.request('session_attach', 409, 'native_session_owned');
  expect(f.health.snapshot().warnings).toEqual([]);
  f.health.request('session_attach', 409, 'native_session_owned');
  const snapshot = f.health.snapshot();
  expect(snapshot.requestFailures).toEqual([{ operation: 'session_attach', status: 409, code: 'native_session_owned', count: 60, lastAt: 1_000_000 }]);
  expect(snapshot.warnings).toEqual([expect.objectContaining({ code: 'repeated_attach_failure', severity: 'warning', count: 60, message: expect.stringContaining('native CLI') })]);
  f.advance(60 * 60_000 + 1);
  expect(f.health.snapshot().warnings).toEqual([]);
});

it('warns about native crash loops and unstable Relay connections', () => {
  const f = health();
  for (let index = 0; index < 5; index++) f.health.nativeExit('claude', 'unexpected');
  f.health.nativeExit('codex', 'requested');
  for (let index = 0; index < 6; index++) f.health.uplinkDrop();
  const snapshot = f.health.snapshot();
  expect(snapshot.warnings.map(warning => warning.code)).toEqual(['native_start_loop', 'uplink_unstable']);
  expect(snapshot.uplinkDrops).toEqual({ count: 6, lastAt: 1_000_000 });
  f.advance(10 * 60_000 + 1);
  expect(f.health.snapshot().warnings.map(warning => warning.code)).toEqual(['uplink_unstable']);
});

it('notes unverified native versions and a launcher that predates version reporting', () => {
  const { health: value } = health([{ providerId: 'codex', version: '0.163.0' }, { providerId: 'copilot', version: '1.0.83' }], { managed: true });
  expect(value.snapshot().warnings).toEqual([
    expect.objectContaining({ code: 'legacy_launcher', severity: 'notice' }),
    expect.objectContaining({ code: 'unverified_native_version', severity: 'notice', message: expect.stringContaining('codex 0.163.0 is newer than 0.162.0') }),
  ]);
});
