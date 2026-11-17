import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';

import { PROTOCOL_VERSION } from '@orchardworks/agent-remote-protocol';
import { recordScenario, scenarios, transcriptDirectory, type ScenarioContext } from '../src/scenarios/index.js';
import { serializeTranscript } from '../src/transcript.js';

// Records every scenario, or the ones named in ARC_TRANSCRIPT_SCENARIOS (comma separated), into ARC_TRANSCRIPT_OUT
// (default: this package's transcripts directory). ARC_RECORDINGS_ROOT names the directory that holds the provider packages.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.env.ARC_TRANSCRIPT_OUT ?? join(packageRoot, 'transcripts');
const wanted = process.env.ARC_TRANSCRIPT_SCENARIOS?.split(',');
const recordingsRoot = process.env.ARC_RECORDINGS_ROOT ?? join(packageRoot, '..');
const recordingDirectory = { codex: 'agent-provider-codex/src/journal-fixtures', claude: 'agent-provider-claude/src/journal-fixtures', copilot: 'agent-provider-copilot/tests/fixtures/journal' } as const;
const context: ScenarioContext = { recording: (provider, name) => JSON.parse(readFileSync(join(recordingsRoot, recordingDirectory[provider], `${name}.json`), 'utf8')) };

for (const scenario of scenarios.filter(candidate => !wanted || wanted.includes(candidate.name))) {
  it(`records ${scenario.seam} ${scenario.name}`, async () => {
    const transcript = await recordScenario(scenario, context, { protocolVersion: PROTOCOL_VERSION, recordedAt: process.env.ARC_RECORDED_AT ?? 'baseline/im-session-2026-11-18' });
    const directory = join(out, transcriptDirectory(scenario));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${scenario.name}.jsonl`), serializeTranscript(transcript));
  });
}
