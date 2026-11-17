import { afterEach } from 'vitest';
import { createOperationCache } from './operation-cache.js';
import { createOperationExecutor } from './operation-settlement.js';
import { createSessionWire, type SessionWireAgent, type SessionWireOptions } from './session-wire.js';

const caches = new Set<ReturnType<typeof createOperationCache>>();
afterEach(async () => {
  await Promise.all([...caches].map(cache => cache.close()));
  caches.clear();
});

export function createSettledSessionWire(
  agent: SessionWireAgent | (() => SessionWireAgent), send: (json: string) => void, options: SessionWireOptions = {},
) {
  const cache = createOperationCache();
  caches.add(cache);
  return createSessionWire(agent, send, { executeOperation: createOperationExecutor(cache, 'test'), ...options });
}
