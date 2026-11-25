import { expect, it } from 'vitest';
import { isHostStatus, ownerOnlyHostStatus, type HostStatus } from './host-status.js';

const status: HostStatus = {
  sampledAt: 1_794_582_892_491,
  sessions: { running: 2, waiting: 1, idle: 3, failed: 0 },
  cpu: { cores: 12, usage: 0.38 },
  memory: { total: 25_769_803_776, used: 15_246_000_128 },
  disks: [{ kind: 'home', path: '/Users/xian', total: 494_384_795_648, used: 474_000_000_000 }, { kind: 'workspace', path: '/Volumes/Projects', total: 2_048_000_000_000, used: 464_000_000_000 }],
  processes: [{ kind: 'session', label: 'claude', providerId: 'claude', cpu: 0.42, memory: 900_000_000 }, { kind: 'controller', label: 'controller', cpu: 0.02, memory: 120_000_000 }],
};

it('accepts a complete Host status and one with sessions only', () => {
  expect(isHostStatus(status)).toBe(true);
  expect(isHostStatus({ sampledAt: 1, sessions: { running: 0, waiting: 0, idle: 0, failed: 0 } })).toBe(true);
});

it('rejects usage outside 0..1, used beyond total and unknown fields', () => {
  expect(isHostStatus({ ...status, cpu: { cores: 12, usage: 1.2 } })).toBe(false);
  expect(isHostStatus({ ...status, memory: { total: 10, used: 11 } })).toBe(false);
  expect(isHostStatus({ ...status, disks: [{ kind: 'home', path: '/', total: 10, used: 11 }] })).toBe(false);
  expect(isHostStatus({ ...status, disks: [{ kind: 'scratch', path: '/', total: 10, used: 1 }] })).toBe(false);
  expect(isHostStatus({ ...status, extra: true })).toBe(false);
});

it('keeps only the session counts for a Host shared with the caller', () => {
  expect(ownerOnlyHostStatus(status, false)).toEqual({ sampledAt: status.sampledAt, sessions: status.sessions });
  expect(ownerOnlyHostStatus(status, true)).toEqual(status);
});

it('accepts processes largest memory first, at most 32, and rejects other orders or kinds', () => {
  const [big, small] = status.processes!;
  expect(isHostStatus({ ...status, processes: [small, big] })).toBe(false);
  expect(isHostStatus({ ...status, processes: [{ ...big, kind: 'browser' }] })).toBe(false);
  expect(isHostStatus({ ...status, processes: Array.from({ length: 33 }, () => small) })).toBe(false);
  expect(isHostStatus({ ...status, processes: Array.from({ length: 32 }, () => small) })).toBe(true);
});

it('shows a shared viewer no processes', () => {
  expect(ownerOnlyHostStatus(status, false).processes).toBeUndefined();
});
