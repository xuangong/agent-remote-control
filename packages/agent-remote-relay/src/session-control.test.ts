import { describe, expect, it, vi } from 'vitest';
import { SessionControlRegistry } from './session-control.js';

describe('session interaction ownership', () => {
  it('reports the remote owner kind and preserves it across proof-based reconnects', () => {
    const registry = new SessionControlRegistry();
    const a = registry.attach('one', vi.fn());
    const b = registry.attach('one', vi.fn());
    const first = a.request('acquire', a.state().revision, undefined, true, 'web');
    expect(b.state()).toMatchObject({ ownerKind: 'web', access: 'read_only' });
    a.close();
    const resumed = registry.attach('one', vi.fn());
    resumed.request('acquire', resumed.state().revision, first.token, true, 'headless');
    expect(b.state()).toMatchObject({ ownerKind: 'web' });
    b.request('take_over', b.state().revision, undefined, false, 'headless');
    expect(resumed.state()).toMatchObject({ ownerKind: 'headless', access: 'read_only' });
    b.close();
    expect(resumed.state()).not.toHaveProperty('ownerKind');
    resumed.request('take_over', resumed.state().revision);
    expect(resumed.state()).toMatchObject({ ownerKind: 'unknown' });
    resumed.close(); registry.close();
  });
  it('permits one writer and fences delayed operations after takeover', () => {
    const registry = new SessionControlRegistry();
    const a = registry.attach('session', vi.fn());
    const b = registry.attach('session', vi.fn());
    const first = a.request('acquire', a.state().revision);
    expect(first.access).toBe('control');
    expect(b.request('acquire', b.state().revision).access).toBe('read_only');
    const revision = b.state().revision;
    const second = b.request('take_over', revision);
    expect(second.access).toBe('control');
    expect(() => a.assert(first.token)).toThrowError(/read.only/i);
    expect(() => a.request('take_over', revision)).toThrowError(/changed/i);
    expect(() => b.assert(second.token)).not.toThrow();
    const third = a.request('take_over', a.state().revision);
    expect(() => a.assert(first.token)).toThrowError(/read.only/i);
    expect(() => a.assert(third.token)).not.toThrow();
    a.close(); b.close(); registry.close();
  });

  it('resumes a disconnected owner without allowing a revoked owner to reclaim', () => {
    const registry = new SessionControlRegistry();
    const a = registry.attach('session', vi.fn());
    const first = a.request('acquire', a.state().revision);
    a.close();
    const b = registry.attach('session', vi.fn());
    expect(b.request('acquire', b.state().revision).access).toBe('read_only');
    const resumed = registry.attach('session', vi.fn());
    const second = resumed.request('acquire', resumed.state().revision, first.token);
    expect(second.access).toBe('control');
    b.request('take_over', b.state().revision);
    const stale = registry.attach('session', vi.fn());
    expect(stale.request('acquire', stale.state().revision, second.token).access).toBe('read_only');
    b.close(); resumed.close(); stale.close(); registry.close();
  });

  it('reserves control during mobile disconnects, then releases without selecting a viewer', () => {
    vi.useFakeTimers();
    const registry = new SessionControlRegistry({ graceMs: 30_000 });
    const a = registry.attach('session', vi.fn());
    const b = registry.attach('session', vi.fn());
    const first = a.request('acquire', a.state().revision);
    a.close();
    vi.advanceTimersByTime(29_999);
    expect(b.state().available).toBe(false);
    vi.advanceTimersByTime(1);
    expect(b.state()).toMatchObject({ access: 'read_only', available: true });
    expect(b.request('acquire', b.state().revision, first.token).access).toBe('read_only');
    expect(b.request('take_over', b.state().revision).access).toBe('control');
    b.close(); registry.close(); vi.useRealTimers();
  });
});

it('shares proof within a page and releases short-lived headless ownership on close', () => {
  const registry = new SessionControlRegistry();
  const a = registry.attach('one', vi.fn());
  const token = a.request('acquire', a.state().revision, undefined, false).token;
  const samePage = registry.attach('one', vi.fn());
  samePage.request('acquire', samePage.state().revision, token, false);
  a.close();
  expect(() => samePage.assert(token)).not.toThrow();
  const viewer = registry.attach('one', vi.fn());
  expect(viewer.state().available).toBe(false);
  samePage.close();
  expect(viewer.state()).toMatchObject({ available: true, access: 'read_only' });
  viewer.close(); registry.close();
});

it('fences all browser writers while a native CLI owns the session', () => {
  const registry = new SessionControlRegistry();
  const updates: unknown[] = [];
  const page = registry.attach('native', state => updates.push(state));
  const granted = page.request('acquire', page.state().revision);
  registry.setNativeOwner('native', {kind:'native_cli',generation:'generation-one'});
  expect(page.state()).toMatchObject({access:'read_only',available:false,nativeOwner:{kind:'native_cli',generation:'generation-one'}});
  expect(()=>page.assert(granted.token)).toThrow(/read.only/);
  expect(()=>page.request('take_over',page.state().revision)).toThrow(/native/i);
  registry.setNativeOwner('native', undefined);
  expect(page.state()).toMatchObject({available:true,access:'read_only'});
  expect(updates.length).toBeGreaterThan(1);
  page.close();registry.close();
});
