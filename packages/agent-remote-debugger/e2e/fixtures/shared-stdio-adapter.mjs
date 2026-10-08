import { createAdapter as createStdioAdapter } from '../../src/fixtures/stdio-adapter.mjs';

/** Allows browser and CLI writers to exercise a provider's shared-control contract. */
export function createAdapter() {
  const adapter = createStdioAdapter();
  return { ...adapter, async createSession(config) {
    const session = await adapter.createSession(config);
    return { ...session, capabilities: { ...session.capabilities, sessionControl: 'shared' } };
  } };
}
