import { expect, it } from 'vitest';
import { isCodexDaemonRestart, isCodexDaemonStatus } from './codex-daemon.js';

const revision = '00000000-0000-4000-8000-000000000001';
it('validates daemon intent and outcome snapshots without accepting arbitrary commands', () => {
  expect(isCodexDaemonRestart({ revision, operationId: revision })).toBe(true);
  expect(isCodexDaemonRestart({ revision, operationId: revision, command: 'stop' })).toBe(false);
  expect(isCodexDaemonRestart({ operationId: revision })).toBe(false);
  for (const phase of ['idle', 'restarting', 'ready', 'failed', 'unknown']) {
    expect(isCodexDaemonStatus({ revision, phase, updatedAt: 1 })).toBe(true);
  }
  for (const value of [{ phase: 'ready', updatedAt: 1 }, { revision, phase: 'running', updatedAt: 1 },
    { revision, phase: 'ready', updatedAt: 1, token: 'private' }]) expect(isCodexDaemonStatus(value)).toBe(false);
});
