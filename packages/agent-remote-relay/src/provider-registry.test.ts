import { describe, expect, it } from 'vitest';

import type { AgentProviderAdapter } from '@borgee/agent-provider-sdk';

import { ProviderRegistry } from './provider-registry.js';

function adapter(providerId: string, displayName: string): AgentProviderAdapter {
  return {
    descriptor: { providerId, displayName },
    async createSession() {
      throw new Error('not used');
    },
    async resumeSession() {
      throw new Error('not used');
    },
  };
}

describe('ProviderRegistry', () => {
  it('lists registered descriptors in registration order', () => {
    const registry = new ProviderRegistry([
      adapter('first', 'First Provider'),
      adapter('second', 'Second Provider'),
    ]);

    expect(registry.list()).toEqual([
      { providerId: 'first', displayName: 'First Provider' },
      { providerId: 'second', displayName: 'Second Provider' },
    ]);
    expect(registry.require('second').descriptor.providerId).toBe('second');
  });

  it('rejects duplicate provider identities', () => {
    expect(() => new ProviderRegistry([
      adapter('duplicate', 'One'),
      adapter('duplicate', 'Two'),
    ])).toThrow(/duplicate/i);
  });
});
