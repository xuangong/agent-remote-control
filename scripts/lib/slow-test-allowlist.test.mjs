import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const { tests } = JSON.parse(readFileSync(new URL('../slow-test-allowlist.json', import.meta.url), 'utf8'));

test('every allowlisted slow test names the test and says why it is slow', () => {
  for (const entry of tests) {
    assert.equal(typeof entry, 'object', 'an entry is { test, reason }');
    assert.match(entry.test, /^packages\/[^ ]+ > .+/, entry.test);
    assert.ok(entry.reason.length >= 40, `the reason of ${entry.test} is written`);
  }
});

test('no test is listed twice', () => {
  const keys = tests.map(entry => entry.test);
  assert.equal(new Set(keys).size, keys.length);
});
