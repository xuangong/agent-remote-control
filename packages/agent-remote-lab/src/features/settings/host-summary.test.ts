import { expect, it } from 'vitest';
import { translator } from '@orchardworks/agent-client';
import { hostSummary, hostsState } from './host-summary.js';

it('summarizes the computers', () => {
  expect(hostSummary([], true)).toBe('No computers paired');
  expect(hostSummary([], false)).toBe('Checking computers…');
  expect(hostSummary([{ online: true }, { online: false }], true)).toBe('1 of 2 online');
  expect(hostSummary([{ online: true }], true)).toBe('1 computer online');
  expect(hostSummary([{ online: true }, { online: true }], true)).toBe('2 computers online');
  expect(hostSummary([{ online: false }, { online: false }], true)).toBe('All computers offline');
});

it('summarizes them in Chinese', () => {
  const zh = translator('zh');
  expect(hostSummary([{ online: true }, { online: true }], true, zh)).toBe('2 台电脑在线');
  expect(hostSummary([{ online: true }, { online: false }], true, zh)).toBe('2 台里 1 台在线');
});

it('gives the dot its state', () => {
  expect([[], [{ online: true }], [{ online: true }, { online: false }], [{ online: false }]].map(hosts => hostsState(hosts))).toEqual(['none', 'online', 'partial', 'offline']);
});
