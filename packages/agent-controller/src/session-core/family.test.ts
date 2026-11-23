import type { HandoffAdmissionState } from '@orchardworks/agent-session-runtime';
import { describe, expect, it } from 'vitest';

import { handoffRefusal, nativeFamily, type FamilyBinding, type HandoffInput } from './family.js';

const binding = (nativeSessionId: string, extra: Partial<FamilyBinding> = {}): FamilyBinding => ({ agentId: `agent-${nativeSessionId}`, providerId: 'codex', nativeSessionId, ...extra });
const quiet = (extra: Partial<HandoffAdmissionState> = {}): HandoffAdmissionState => ({
  connected: true, synchronized: true, closed: false, status: 'idle', activeTurn: false, pendingInteractions: 0, commandWork: 0, settingWork: false, ...extra,
});
const input = (extra: Partial<HandoffInput> = {}): HandoffInput => ({ own: quiet(), bound: true, ownCursor: { epoch: 'e', seq: 4 }, children: [], unsettledRecipient: false, ...extra });

describe('native family', () => {
  it('holds the session, its children and their children, of one provider, the session first', () => {
    const bindings = [binding('grandchild', { parentNativeSessionId: 'child' }), binding('root'), binding('child', { parentNativeSessionId: 'root' }),
      binding('other'), binding('root', { providerId: 'claude' }), binding('stranger', { parentNativeSessionId: 'other' })];
    expect(nativeFamily(bindings, 'codex', 'root').map(item => item.nativeSessionId)).toEqual(['root', 'child', 'grandchild']);
  });

  it('is empty for a session with no binding', () => {
    expect(nativeFamily([binding('a')], 'codex', 'missing')).toEqual([]);
  });

  it('holds only the children of a session that has no binding of its own', () => {
    expect(nativeFamily([binding('child', { parentNativeSessionId: 'root' })], 'codex', 'root').map(item => item.nativeSessionId)).toEqual(['child']);
  });
});

describe('the quiescence rule of a succession', () => {
  it('lets an idle, connected, synchronized session with nothing in flight proceed', () => {
    expect(handoffRefusal(input())).toBeUndefined();
  });

  it.each([
    ['has no runtime', { own: undefined }],
    ['is not connected', { own: quiet({ connected: false }) }],
    ['is not synchronized', { own: quiet({ synchronized: false }) }],
    ['is closed', { own: quiet({ closed: true }) }],
    ['is running', { own: quiet({ status: 'running' }) }],
    ['has an active turn', { own: quiet({ activeTurn: true }) }],
    ['has a pending interaction', { own: quiet({ pendingInteractions: 1 }) }],
    ['has command work', { own: quiet({ commandWork: 1 }) }],
    ['has setting work', { own: quiet({ settingWork: true }) }],
    ['has an unsettled Team recipient', { unsettledRecipient: true }],
  ] as Array<[string, Partial<HandoffInput>]>)('refuses a session that %s', (_name, change) => {
    expect(handoffRefusal(input(change))).toEqual({ code: 'succession_not_quiescent', message: 'Session has active, unknown or unsynchronized Host work.' });
  });

  it('refuses an unbound session, unless the caller allows it missing', () => {
    expect(handoffRefusal(input({ bound: false, own: undefined }))?.code).toBe('succession_not_quiescent');
    expect(handoffRefusal(input({ bound: false, own: undefined, allowMissing: true }))).toBeUndefined();
  });

  it('refuses a timeline that moved past the captured boundary, by epoch or by sequence, or has no cursor', () => {
    const boundary = { epoch: 'e', seq: 4 };
    expect(handoffRefusal(input({ captured: boundary }))).toBeUndefined();
    for (const ownCursor of [{ epoch: 'other', seq: 4 }, { epoch: 'e', seq: 5 }, undefined]) {
      expect(handoffRefusal(input({ captured: boundary, ownCursor }))).toEqual({ code: 'succession_boundary_changed', message: 'Source history changed beyond the captured handoff boundary.' });
    }
  });

  it('asks nothing of the cursor when no boundary was captured', () => {
    expect(handoffRefusal(input({ ownCursor: undefined }))).toBeUndefined();
  });

  it('reports the session\'s own work before the boundary, and the boundary before its children', () => {
    expect(handoffRefusal(input({ own: quiet({ activeTurn: true }), captured: { epoch: 'x', seq: 0 } }))?.code).toBe('succession_not_quiescent');
    expect(handoffRefusal(input({ captured: { epoch: 'x', seq: 0 }, children: [quiet({ activeTurn: true })] }))?.code).toBe('succession_boundary_changed');
  });

  it.each([
    ['has no runtime', undefined],
    ['is not connected', quiet({ connected: false })],
    ['is not synchronized', quiet({ synchronized: false })],
    ['is running', quiet({ status: 'running' })],
    ['has an active turn', quiet({ activeTurn: true })],
    ['has a pending interaction', quiet({ pendingInteractions: 2 })],
    ['has command work', quiet({ commandWork: 1 })],
    ['has setting work', quiet({ settingWork: true })],
  ])('refuses a succession while a child %s', (_name, child) => {
    expect(handoffRefusal(input({ children: [quiet(), child] }))).toEqual({ code: 'succession_not_quiescent', message: 'Session has unresolved child work.' });
  });

  it('does not let a closed child block the session', () => {
    expect(handoffRefusal(input({ children: [quiet({ closed: true })] }))).toBeUndefined();
  });
});
