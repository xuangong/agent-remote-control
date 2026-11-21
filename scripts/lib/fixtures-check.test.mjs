import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { checkFixtures } from './fixtures-check.mjs';

const header = overrides => JSON.stringify({ kind: 'transcript', producedBy: 'transcripts:record', seam: 'S3', scenario: 'open', protocolVersion: '1.8.0', consumers: ['tests/open.test.ts'], ...overrides });
const frame = n => JSON.stringify({ n, direction: 'browser->relay', message: {} });

function sample(files, check) {
  const root = mkdtempSync(join(tmpdir(), 'arc-fixtures-sample-'));
  const base = { 'tests/open.test.ts': '', ...files };
  for (const [path, text] of Object.entries(base)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  try { check(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

const transcript = 'packages/agent-remote-fixtures/transcripts/session-wire/open.jsonl';
const recordings = 'packages/agent-provider-codex/src/journal-fixtures';
const cli = JSON.stringify({ cli: { name: 'codex', version: '0.171.0' } });

test('consistent transcripts and recordings with golden rows are accepted', () => {
  sample({
    [transcript]: `${header()}\n${frame(1)}\n${frame(2)}\n`,
    [`${recordings}/settled.json`]: cli, [`${recordings}/settled.rows.json`]: JSON.stringify({ kind: 'recording-rows', recording: 'settled' }),
  }, root => assert.deepEqual(checkFixtures({ root, protocolVersion: '1.8.0' }), []));
});

test('a recording that does not name the CLI version it was made with is reported', () => {
  sample({
    [`${recordings}/settled.json`]: '{}', [`${recordings}/settled.rows.json`]: JSON.stringify({ kind: 'recording-rows', recording: 'settled' }),
    [`${recordings}/restart.json`]: JSON.stringify({ cli: { name: 'codex', version: 'latest' } }), [`${recordings}/restart.rows.json`]: JSON.stringify({ kind: 'recording-rows', recording: 'restart' }),
  }, root => {
    const problems = checkFixtures({ root, protocolVersion: '1.8.0' }).join('\n');
    assert.match(problems, /settled\.json: it does not name the CLI/);
    assert.match(problems, /restart\.json: it does not name the CLI/);
  });
});

test('a transcript recorded at another protocol version fails until it is recorded again', () => {
  sample({ [transcript]: `${header({ protocolVersion: '1.7.0' })}\n${frame(1)}\n` }, root => {
    const problems = checkFixtures({ root, protocolVersion: '1.8.0' });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /recorded at protocol 1\.7\.0.*declares 1\.8\.0/);
  });
});

test('a transcript with a wrong scenario, a missing consumer, a gap in its frames or a hand edit is reported', () => {
  sample({ [transcript]: `${header({ scenario: 'other', consumers: ['tests/gone.test.ts'], producedBy: 'hand' })}\n${frame(1)}\n${frame(3)}\n` }, root => {
    const problems = checkFixtures({ root, protocolVersion: '1.8.0' }).join('\n');
    assert.match(problems, /producedBy is "hand"/);
    assert.match(problems, /names scenario other/);
    assert.match(problems, /consumer tests\/gone\.test\.ts does not exist/);
    assert.match(problems, /frame 2 is numbered 3/);
  });
});

test('a transcript nothing replays is reported', () => {
  sample({ [transcript]: `${header({ consumers: [] })}\n${frame(1)}\n` }, root => {
    assert.match(checkFixtures({ root, protocolVersion: '1.8.0' }).join('\n'), /no consumer names it/);
  });
});

test('a recording without golden rows, and golden rows without their recording, are reported', () => {
  sample({
    [`${recordings}/settled.json`]: cli,
    [`${recordings}/gone.rows.json`]: JSON.stringify({ kind: 'recording-rows', recording: 'gone' }),
  }, root => {
    const problems = checkFixtures({ root, protocolVersion: '1.8.0' }).join('\n');
    assert.match(problems, /settled\.json: no golden rows/);
    assert.match(problems, /gone\.rows\.json: its recording gone\.json is gone/);
  });
});
