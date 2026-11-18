import { describe, expect, it } from 'vitest';

import type { FamilyBinding } from './family.js';
import { hasHeldChild, mayReconcileIdle, mayReleaseIdle, type IdleReleaseFacts } from './idle-release.js';

const binding = (nativeSessionId: string, extra: Partial<FamilyBinding> = {}): FamilyBinding => ({ agentId: `agent-${nativeSessionId}`, providerId: 'codex', nativeSessionId, ...extra });
const facts = (extra: Partial<IdleReleaseFacts> = {}): IdleReleaseFacts => ({ closed: false, uncertain: false, pending: false, directoryCanRelease: true, runtimeCanReleaseIdle: true, childHeld: false, ...extra });

describe('releasing an idle session', () => {
  it('releases a session nothing holds when its provider and runtime allow it', () => {
    expect(mayReleaseIdle(facts())).toBe(true);
  });

  it.each([
    ['the Controller is closed', { closed: true }],
    ['its idle state is uncertain', { uncertain: true }],
    ['its binding is still being made', { pending: true }],
    ['its provider does not allow the release', { directoryCanRelease: false }],
    ['its runtime cannot be released idle', { runtimeCanReleaseIdle: false }],
    ['a child still holds the connection', { childHeld: true }],
  ] as Array<[string, Partial<IdleReleaseFacts>]>)('keeps a session when %s', (_name, change) => {
    expect(mayReleaseIdle(facts(change))).toBe(false);
  });
});

describe('checking an uncertain session', () => {
  it('needs a directory that reconciles, a runtime that can be released idle and no held child', () => {
    expect(mayReconcileIdle({ directoryCanReconcile: true, runtimeCanReleaseIdle: true, childHeld: false })).toBe(true);
    expect(mayReconcileIdle({ directoryCanReconcile: false, runtimeCanReleaseIdle: true, childHeld: false })).toBe(false);
    expect(mayReconcileIdle({ directoryCanReconcile: true, runtimeCanReleaseIdle: false, childHeld: false })).toBe(false);
    expect(mayReconcileIdle({ directoryCanReconcile: true, runtimeCanReleaseIdle: true, childHeld: true })).toBe(false);
  });
});

describe('a held child', () => {
  const root = binding('root');
  const bindings = [root, binding('child', { parentNativeSessionId: 'root' }), binding('other-provider', { parentNativeSessionId: 'root', providerId: 'claude' }), binding('unrelated', { parentNativeSessionId: 'else' })];

  it('is a child of the same provider that the caller says is held', () => {
    expect(hasHeldChild(bindings, root, child => child.nativeSessionId === 'child')).toBe(true);
  });

  it('is not a child of another provider, nor of another parent, nor one nobody holds', () => {
    expect(hasHeldChild(bindings, root, child => child.nativeSessionId === 'other-provider' || child.nativeSessionId === 'unrelated')).toBe(false);
    expect(hasHeldChild(bindings, root, () => false)).toBe(false);
  });
});
