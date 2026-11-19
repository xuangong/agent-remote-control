import { describe, expect, it } from 'vitest';

import { leaseActivityLabel, leaseNoticeLabel, leaseView, type LeaseState } from './lease-view.js';
import type { AgentReplicaState } from '../replica/types.js';

type Control = AgentReplicaState['sessionControl'];
const cli = { kind: 'native_cli' as const, generation: 'g1' };
const other = { kind: 'controller' as const, generation: 'g2' };

const table: Array<{ name: string; control: Control; state: LeaseState; readOnly: boolean; checking: boolean; native: boolean; notice: string | undefined; activity: string | undefined }> = [
  { name: 'no control channel', control: undefined, state: 'unknown', readOnly: false, checking: false, native: false, notice: 'Ready to take control', activity: undefined },
  { name: 'checking access', control: { access: 'checking', available: false }, state: 'checking', readOnly: false, checking: true, native: false, notice: undefined, activity: undefined },
  { name: 'holding control', control: { access: 'control', available: true, revision: 'r' }, state: 'control', readOnly: false, checking: false, native: false, notice: 'Ready to take control', activity: undefined },
  { name: 'a terminal holds the session', control: { access: 'read_only', available: false, nativeOwner: cli }, state: 'native_cli', readOnly: true, checking: false, native: true, notice: 'Native CLI has control', activity: 'Native CLI has control' },
  { name: 'another Controller holds the session', control: { access: 'read_only', available: false, nativeOwner: other }, state: 'other_controller', readOnly: true, checking: false, native: true, notice: 'Another Controller has control', activity: 'Native control transferred' },
  { name: 'read-only with nobody holding it', control: { access: 'read_only', available: true }, state: 'read_only', readOnly: true, checking: false, native: false, notice: 'Ready to take control', activity: undefined },
];

describe('the lease view table', () => {
  it.each(table.map(row => [row.name, row] as const))('%s', (_name, row) => {
    expect(leaseView(row.control)).toEqual({ state: row.state, readOnly: row.readOnly, checking: row.checking, native: row.native });
    // A control check has no words: the session says nothing while it runs (target T5).
    if (row.state !== 'checking') expect(leaseNoticeLabel(row.state)).toBe(row.notice);
    expect(leaseActivityLabel(row.state)).toBe(row.activity);
  });
});
