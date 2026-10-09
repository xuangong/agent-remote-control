import { describe, expect, it, vi } from 'vitest';
import { SessionControlRegistry } from './session-control.js';

describe('shared session connection access', () => {
  it('authorizes each client independently and never transfers access between pages', () => {
    const registry = new SessionControlRegistry();
    const a = registry.attach('session', vi.fn());
    const b = registry.attach('session', vi.fn());
    try {
      const first = a.request('acquire', a.state().revision, undefined, true, 'web');
      const second = b.request('acquire', b.state().revision, undefined, false, 'headless');
      expect(first.access).toBe('control');
      expect(second.access).toBe('control');
      expect(first.token).not.toBe(second.token);
      expect(a.state()).not.toHaveProperty('ownerKind');
      expect(b.state()).not.toHaveProperty('ownerKind');
      b.request('take_over', b.state().revision);
      expect(() => a.assert(first.token)).not.toThrow();
      expect(() => b.assert(second.token)).not.toThrow();
    } finally { a.close(); b.close(); registry.close(); }
  });

  it('binds revisions and proofs to one connection even when a legacy resume token is supplied', () => {
    const registry = new SessionControlRegistry();
    const a = registry.attach('session', vi.fn());
    const b = registry.attach('session', vi.fn());
    const other = registry.attach('other', vi.fn());
    try {
      const first = a.request('acquire', a.state().revision);
      expect(() => b.assert(first.token)).toThrow(/read.only/i);
      expect(() => b.request('acquire', first.revision)).toThrow(/changed/i);
      const second = b.request('acquire', b.state().revision, first.token);
      expect(second.access).toBe('control');
      expect(second.token).not.toBe(first.token);
      expect(() => b.assert(first.token)).toThrow(/read.only/i);
      expect(() => other.assert(second.token)).toThrow(/read.only/i);
      expect(() => b.assert(second.token)).not.toThrow();
    } finally { a.close(); b.close(); other.close(); registry.close(); }
  });

  it('reconnects immediately without a page owner or disconnect grace and keeps other pages active', () => {
    const registry = new SessionControlRegistry();
    const a = registry.attach('session', vi.fn());
    const b = registry.attach('session', vi.fn());
    const first = a.request('acquire', a.state().revision);
    const second = b.request('acquire', b.state().revision);
    a.close();
    const resumed = registry.attach('session', vi.fn());
    try {
      expect(resumed.state().available).toBe(true);
      const next = resumed.request('acquire', resumed.state().revision, first.token);
      expect(next.access).toBe('control');
      expect(next.token).not.toBe(first.token);
      expect(() => a.assert(first.token)).toThrow(/read.only/i);
      expect(() => resumed.assert(first.token)).toThrow(/read.only/i);
      expect(() => b.assert(second.token)).not.toThrow();
      expect(() => resumed.assert(next.token)).not.toThrow();
    } finally { b.close(); resumed.close(); registry.close(); }
  });

  it('revokes every page before publishing a native ownership change and requires fresh grants after release', () => {
    const registry = new SessionControlRegistry();
    const updates: unknown[] = [];
    let verifyOther: (() => void) | undefined;
    const a = registry.attach('native', state => { updates.push(state); verifyOther?.(); });
    const b = registry.attach('native', state => updates.push(state));
    const first = a.request('acquire', a.state().revision);
    const second = b.request('acquire', b.state().revision);
    const owner = {kind: 'native_cli' as const, generation: 'generation-one'};
    verifyOther = () => expect(() => b.assert(second.token)).toThrow(/read.only/i);
    try {
      registry.setNativeOwner('native', owner);
      for (const page of [a, b]) {
        expect(page.state()).toMatchObject({access: 'read_only', available: false, nativeOwner: owner});
        expect(page.state()).not.toHaveProperty('token');
        expect(() => page.request('take_over', page.state().revision)).toThrow(/native/i);
      }
      expect(() => a.assert(first.token)).toThrow(/read.only/i);
      registry.setNativeOwner('native', undefined);
      for (const page of [a, b]) {
        expect(page.state()).toMatchObject({access: 'read_only', available: true});
        expect(page.state()).not.toHaveProperty('nativeOwner');
      }
      expect(updates).toHaveLength(4);
      expect(() => a.request('acquire', first.revision)).toThrow(/changed/i);
      const next = a.request('acquire', a.state().revision, first.token);
      const also = b.request('acquire', b.state().revision, second.token);
      expect(next.access).toBe('control'); expect(also.access).toBe('control');
      expect(() => a.assert(first.token)).toThrow(/read.only/i);
      expect(() => b.assert(second.token)).toThrow(/read.only/i);
      expect(() => a.assert(next.token)).not.toThrow();
      expect(() => b.assert(also.token)).not.toThrow();
    } finally { a.close(); b.close(); registry.close(); }
  });

  it('keeps a native owner authoritative when every page disconnects', () => {
    const registry = new SessionControlRegistry();
    registry.setNativeOwner('native', {kind: 'controller', generation: 'external-controller'});
    const first = registry.attach('native', vi.fn());
    expect(() => first.request('acquire', first.state().revision)).toThrow(/native/i);
    first.close();
    const next = registry.attach('native', vi.fn());
    try {
      expect(next.state()).toMatchObject({access: 'read_only', available: false, nativeOwner: {generation: 'external-controller'}});
      registry.setNativeOwner('native', undefined);
      expect(next.request('acquire', next.state().revision).access).toBe('control');
    } finally { next.close(); registry.close(); }
  });

  it('revokes all outstanding grants when the registry closes', () => {
    const registry = new SessionControlRegistry();
    const a = registry.attach('one', vi.fn());
    const b = registry.attach('two', vi.fn());
    const first = a.request('acquire', a.state().revision);
    const second = b.request('acquire', b.state().revision);
    registry.close();
    for (const [page, token] of [[a, first.token], [b, second.token]] as const) {
      expect(page.state()).toMatchObject({access: 'read_only', available: false});
      expect(() => page.assert(token)).toThrow(/read.only/i);
      expect(() => page.request('acquire', page.state().revision)).toThrow(/closed/i);
      page.close();
    }
  });
});
