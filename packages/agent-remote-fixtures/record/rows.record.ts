import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';

import { rowsOfRecording, serializeRowsGolden } from '../src/recorded-rows.js';

// Writes `<recording>.rows.json` next to every provider recording: the rows the runtime holds for it, reviewed once.
// ARC_RECORDINGS_ROOT names the directory that holds the provider packages; ARC_ROWS_OUT writes the files somewhere else.
const root = process.env.ARC_RECORDINGS_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '../..');
const directories = { codex: 'agent-provider-codex/src/journal-fixtures', claude: 'agent-provider-claude/src/journal-fixtures', copilot: 'agent-provider-copilot/tests/fixtures/journal' } as const;

for (const [provider, directory] of Object.entries(directories)) {
  const names = readdirSync(join(root, directory)).filter(file => file.endsWith('.json') && !file.endsWith('.rows.json')).map(file => file.slice(0, -'.json'.length)).sort();
  for (const name of names) {
    it(`records the rows of ${provider} ${name}`, async () => {
      if (process.env.ARC_ROWS_OUT) mkdirSync(join(process.env.ARC_ROWS_OUT, provider), { recursive: true });
      const golden = await rowsOfRecording(JSON.parse(readFileSync(join(root, directory, `${name}.json`), 'utf8')));
      writeFileSync(join(process.env.ARC_ROWS_OUT ? join(process.env.ARC_ROWS_OUT, provider) : join(root, directory), `${name}.rows.json`), serializeRowsGolden({ kind: 'recording-rows', producedBy: 'transcripts:record', provider, recording: name, ...golden }));
    });
  }
}
