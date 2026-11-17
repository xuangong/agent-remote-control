import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';

import { playPartitionContract, type PartitionContractStep } from '@orchardworks/agent-relay-core/testing';

import { startPartitionServer } from '../tests/S5/partition-server.js';

// Plays the calls of journal-partition.contract.json against the partition server in process and writes the replies it gave.
// A changed reply shows as a diff of the file, which the owner reviews; the proxy's tests and the Workers tests then replay it.
const contract = createRequire(import.meta.url)('@orchardworks/agent-relay-core/journal-partition.contract.json') as PartitionContractStep[];
const file = join(dirname(fileURLToPath(import.meta.url)), '../../agent-relay-core/src/journal-partition.contract.json');

it('records the replies of the partition server', async () => {
  const server = await startPartitionServer();
  try {
    const played = await playPartitionContract(server.api, contract);
    writeFileSync(file, JSON.stringify(played, null, 2) + '\n');
  } finally { server.close(); }
});
