import type { AgentProviderAdapter, AgentProviderDescriptor } from '@borgee/agent-provider-sdk';

export class DuplicateProviderError extends Error {
  constructor(readonly providerId: string) {
    super(`Duplicate provider ID: ${providerId}`);
    this.name = 'DuplicateProviderError';
  }
}

export class ProviderNotFoundError extends Error {
  constructor(readonly providerId: string) {
    super(`Unknown provider ID: ${providerId}`);
    this.name = 'ProviderNotFoundError';
  }
}

export class ProviderRegistry {
  private readonly providers = new Map<string, AgentProviderAdapter>();

  constructor(adapters: readonly AgentProviderAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: AgentProviderAdapter): void {
    const providerId = adapter.descriptor.providerId;
    if (this.providers.has(providerId)) throw new DuplicateProviderError(providerId);
    this.providers.set(providerId, adapter);
  }

  list(): readonly AgentProviderDescriptor[] {
    return [...this.providers.values()].map(({ descriptor }) => ({ ...descriptor }));
  }

  require(providerId: string): AgentProviderAdapter {
    const provider = this.providers.get(providerId);
    if (!provider) throw new ProviderNotFoundError(providerId);
    return provider;
  }
}
