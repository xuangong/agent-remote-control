import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { directory, indexIsCurrent, parseItem, readItems, renderIndex, writeIndex } from './open-items.mjs';

const item = ({ id = 'O7', title = 'A title', found = 'M11', owner = 'M12', status = 'open' } = {}) =>
  `# ${id}: ${title}\n\n- Found in: ${found}\n- Owner step: ${owner}\n- Status: ${status}\n\n## Item\n\nWhat is wrong.\n\n## Status\n\n${status}\n`;
const readme = '# Open items\n\nHand-written text.\n\n<!-- open-items:start (generated from the item files by scripts/open-items.mjs; pnpm postmerge writes it on main) -->\nstale\n<!-- open-items:end -->\n\nMore text.\n';

/** A repository root with the given item files and the index. */
function root(files) {
  const path = mkdtempSync(join(tmpdir(), 'arc-open-items-'));
  mkdirSync(join(path, directory), { recursive: true });
  for (const [name, text] of Object.entries({ 'README.md': readme, ...files })) writeFileSync(join(path, directory, name), text);
  return path;
}

test('an item file gives its id and title from the heading, its three fields and its state', () => {
  assert.deepEqual(parseItem('O7.md', item({ status: 'closed in M12' })),
    { id: 'O7', number: 7, title: 'A title', found: 'M11', owner: 'M12', status: 'closed in M12', state: 'closed' });
  assert.equal(parseItem('O7.md', item({ status: 'partly closed (2026-11-21): the rest' })).state, 'partly closed');
});

test('an item file that the index cannot read is refused with its name', () => {
  assert.throws(() => parseItem('O8.md', item()), /O8\.md: the first heading must be "# O8: <title>"/);
  assert.throws(() => parseItem('O7.md', item().replace('- Owner step: M12\n', '')), /O7\.md: no "- Owner step: " line/);
  assert.throws(() => parseItem('O7.md', item({ status: 'done' })), /the status must start with "open", "partly closed", "closed": "done"/);
  assert.throws(() => parseItem('O7.md', item({ status: 'opened' })), /the status must start with/);
});

test('the index counts the items by state and lists them by number, with the cells escaped', () => {
  const items = [item({ id: 'O10', status: 'closed' }), item({ id: 'O9', title: 'Settings | Computers', status: 'partly closed' }), item({ id: 'O2' })]
    .map(text => parseItem(`${/# (O\d+)/.exec(text)[1]}.md`, text)).sort((a, b) => a.number - b.number);
  assert.equal(renderIndex(items), [
    '1 open, 1 partly closed and 1 closed.',
    '',
    '| # | Item | Found in | Owner step | Status |',
    '|---|---|---|---|---|',
    '| [O2](O2.md) | A title | M11 | M12 | open |',
    '| [O9](O9.md) | Settings \\| Computers | M11 | M12 | partly closed |',
    '| [O10](O10.md) | A title | M11 | M12 | closed |',
  ].join('\n'));
});

test('writing the index replaces only its generated part, once, and a new item file makes it stale', () => {
  const path = root({ 'O10.md': item({ id: 'O10' }), 'O2.md': item({ id: 'O2', status: 'closed' }) });
  try {
    assert.deepEqual(readItems(path).map(({ id }) => id), ['O2', 'O10']);
    assert.equal(indexIsCurrent(path), false);
    assert.equal(writeIndex(path), true);
    const text = readFileSync(join(path, directory, 'README.md'), 'utf8');
    assert.ok(text.startsWith('# Open items\n\nHand-written text.\n\n<!-- open-items:start'));
    assert.ok(text.endsWith('| [O10](O10.md) | A title | M11 | M12 | open |\n<!-- open-items:end -->\n\nMore text.\n'));
    assert.equal(indexIsCurrent(path), true);
    assert.equal(writeIndex(path), false);
    writeFileSync(join(path, directory, 'O11.md'), item({ id: 'O11' }));
    assert.equal(indexIsCurrent(path), false);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test('the repository\'s item files all parse, and their index lists each once', () => {
  const repository = new URL('../..', import.meta.url).pathname;
  const items = readItems(repository);
  assert.ok(items.length >= 60);
  assert.equal(new Set(items.map(({ id }) => id)).size, items.length);
});
