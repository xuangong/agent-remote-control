import { relayStateStoreCases } from '@orchardworks/agent-relay-core/testing';
import { journalStoreCases } from '@orchardworks/agent-remote-journal/testing';
import { beforeAll, describe, expect, it } from 'vitest';

import { fixture } from './fixture.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
type CaseResult = { name: string; error?: string };

/** Runs every case of a store contract inside the Durable Object and names each failing case. */
async function failures(cases: ReadonlyArray<{ name: string }>, run: (index: number) => Promise<CaseResult>) {
  const failed: string[] = [];
  for (const [index, { name }] of cases.entries()) { const result = await run(index); if (result.error !== undefined) failed.push(`${name}: ${result.error}`); }
  return failed;
}

describe('the Durable Object SQLite stores run the store contract', () => {
  let f: Fixture;
  beforeAll(async () => { f = await fixture({ conformance: true, journals: {}, lifetime: 'file' }); }, 30_000);

  it(`runs the ${journalStoreCases.length} cases of the journal store contract`, async () => {
    expect(await failures(journalStoreCases, async index => {
      const response = await f.inspect(`partition/conformance-host/runConformance`, { method: 'POST', body: JSON.stringify([index]) });
      return (await response.json() as { result: CaseResult }).result;
    })).toEqual([]);
  });

  it(`runs the ${relayStateStoreCases.length} cases of the Relay state store contract`, async () => {
    expect(await failures(relayStateStoreCases, async index => await (await f.inspect(`conformance/state/${index}`)).json() as CaseResult)).toEqual([]);
  });
});
