import { describe, it } from 'vitest';

import { journalStoreCases, memoryJournalStoreUnderTest } from './testing.js';

describe('MemoryJournalStore', () => {
  for (const { name, run } of journalStoreCases) it(name, () => run(memoryJournalStoreUnderTest));
});
