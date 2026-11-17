import { relayStateStoreCases } from '@orchardworks/agent-relay-core/testing';
import { journalStoreCases } from '@orchardworks/agent-remote-journal/testing';
import { beforeAll, describe, expect, it } from 'vitest';

import { fixture } from './fixture.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
type CaseResult = { name: string; error?: string };

describe('the Durable Object SQLite stores run the store contract', () => {
  let f: Fixture;
  beforeAll(async () => { f = await fixture({ conformance: true, journals: {}, lifetime: 'file' }); }, 30_000);

  describe('journal store', () => {
    journalStoreCases.forEach(({ name }, index) => it(name, async () => {
      const response = await f.inspect(`partition/conformance-host/runConformance`, { method: 'POST', body: JSON.stringify([index]) });
      const { result } = await response.json() as { result: CaseResult };
      expect(result.error).toBeUndefined();
    }));
  });

  describe('Relay state store', () => {
    relayStateStoreCases.forEach(({ name }, index) => it(name, async () => {
      const result = await (await f.inspect(`conformance/state/${index}`)).json() as CaseResult;
      expect(result.error).toBeUndefined();
    }));
  });
});
