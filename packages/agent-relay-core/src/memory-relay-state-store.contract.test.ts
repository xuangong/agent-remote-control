import { describe, it } from 'vitest';

import { memoryRelayStateStoreUnderTest, relayStateStoreCases } from './testing.js';

describe('MemoryRelayStateStore', () => {
  for (const { name, run } of relayStateStoreCases) it(name, () => run(memoryRelayStateStoreUnderTest));
});
