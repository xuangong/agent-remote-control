import type { RemoteHostCatalog } from '@orchardworks/agent-session-runtime';
import { describe, expect, it } from 'vitest';

import { createProviderRegistry } from './provider-registry.js';
import { HostRequestError } from './requests.js';
import type { AgentHostProviderRegistration } from './types.js';

const registration = (providerId: string, directoryProviderId = providerId) => ({
  adapter: { descriptor: { providerId } }, directory: { providerId: directoryProviderId },
}) as unknown as AgentHostProviderRegistration;

function registry() {
  const disposed: string[] = [];
  const created: string[] = [];
  const instance = createProviderRegistry(({ directory }) => {
    created.push(directory.providerId);
    return { dispose: () => { disposed.push(directory.providerId); } } as unknown as RemoteHostCatalog;
  });
  return { instance, disposed, created };
}

describe('provider registry', () => {
  it('lists registrations and ids in the order they were added', () => {
    const { instance } = registry();
    const a = registration('claude'), b = registration('codex');
    instance.add(a);
    instance.add(b);
    expect(instance.all()).toEqual([a, b]);
    expect(instance.ids()).toEqual(['claude', 'codex']);
    expect(instance.has('codex')).toBe(true);
    expect(instance.get('claude')).toBe(a);
  });

  it('keeps one catalog for each provider added, made from its registration', () => {
    const { instance, created } = registry();
    instance.add(registration('claude'));
    expect(created).toEqual(['claude']);
    expect(instance.catalog('claude')).toBeDefined();
    expect(instance.catalog('codex')).toBeUndefined();
  });

  it('answers nothing for an unknown provider, and a 400 request error when it is required', () => {
    const { instance } = registry();
    expect(instance.get('ghost')).toBeUndefined();
    expect(instance.has('ghost')).toBe(false);
    expect(() => instance.require('ghost')).toThrow(HostRequestError);
    try { instance.require('ghost'); } catch (error) {
      expect(error).toMatchObject({ status: 400, code: 'invalid_provider' });
    }
  });

  it('returns the registration of a known provider when it is required', () => {
    const { instance } = registry();
    const a = registration('claude');
    instance.add(a);
    expect(instance.require('claude')).toBe(a);
  });

  it('refuses a provider added twice, and leaves the first in place', () => {
    const { instance, created } = registry();
    const first = registration('claude');
    instance.add(first);
    expect(() => instance.add(registration('claude'))).toThrow('Duplicate Agent Host provider: claude.');
    expect(instance.require('claude')).toBe(first);
    expect(created).toEqual(['claude']);
  });

  it('refuses a registration whose directory names another provider, and holds nothing of it', () => {
    const { instance, created } = registry();
    expect(() => instance.add(registration('claude', 'codex'))).toThrow('Directory provider identity does not match claude.');
    expect(instance.has('claude')).toBe(false);
    expect(instance.catalog('claude')).toBeUndefined();
    expect(created).toEqual([]);
  });

  it('disposes every catalog', () => {
    const { instance, disposed } = registry();
    instance.add(registration('claude'));
    instance.add(registration('codex'));
    instance.dispose();
    expect(disposed).toEqual(['claude', 'codex']);
  });

  it('hands out copies of its lists, so a caller cannot change what it holds', () => {
    const { instance } = registry();
    instance.add(registration('claude'));
    instance.all().length = 0;
    instance.ids().push('x');
    expect(instance.ids()).toEqual(['claude']);
    expect(instance.all()).toHaveLength(1);
  });
});
