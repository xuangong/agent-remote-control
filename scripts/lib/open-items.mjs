// The open items of docs/superpowers/open-items: one file per item, and an index generated from the files, so that opening,
// closing or moving an item edits only its own file. Task branches never write the index; pnpm postmerge writes it on main.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const directory = 'docs/superpowers/open-items';
const start = '<!-- open-items:start (generated from the item files by scripts/open-items.mjs; pnpm postmerge writes it on main) -->';
const end = '<!-- open-items:end -->';
const states = ['open', 'partly closed', 'closed'];
const fields = { 'Found in': 'found', 'Owner step': 'owner', Status: 'status' };

/** One item file: its id and title from the heading, and the Found in, Owner step and Status fields below it. */
export function parseItem(name, text) {
  const heading = /^# (O\d+): (.+)$/m.exec(text);
  if (!heading || `${heading[1]}.md` !== name) throw new Error(`${name}: the first heading must be "# ${name.replace(/\.md$/, '')}: <title>".`);
  const item = { id: heading[1], number: Number(heading[1].slice(1)), title: heading[2].trim() };
  for (const [label, key] of Object.entries(fields)) {
    const field = new RegExp(`^- ${label}: (.+)$`, 'm').exec(text);
    if (!field) throw new Error(`${name}: no "- ${label}: " line.`);
    item[key] = field[1].trim();
  }
  item.state = [...states].sort((a, b) => b.length - a.length).find(state => item.status === state || item.status.startsWith(`${state} `));
  if (!item.state) throw new Error(`${name}: the status must start with ${states.map(state => `"${state}"`).join(', ')}: "${item.status}".`);
  return item;
}

/** The items of the directory at `root`, by number. */
export function readItems(root) {
  return readdirSync(join(root, directory)).filter(name => /^O\d+\.md$/.test(name))
    .map(name => parseItem(name, readFileSync(join(root, directory, name), 'utf8')))
    .sort((a, b) => a.number - b.number);
}

const cell = text => text.replaceAll('|', '\\|');
/** The generated part of the index: a count by state and one row per item. */
export function renderIndex(items) {
  const counts = states.map(state => `${items.filter(item => item.state === state).length} ${state}`);
  return [
    `${counts.slice(0, -1).join(', ')} and ${counts.at(-1)}.`,
    '',
    '| # | Item | Found in | Owner step | Status |',
    '|---|---|---|---|---|',
    ...items.map(item => `| [${item.id}](${item.id}.md) | ${cell(item.title)} | ${cell(item.found)} | ${cell(item.owner)} | ${cell(item.status)} |`),
  ].join('\n');
}

/** The index text with its generated part replaced; the hand-written text around the markers stays. */
export function withIndex(text, items) {
  const from = text.indexOf(start), to = text.indexOf(end);
  if (from < 0 || to < from) throw new Error(`${directory}/README.md has no generated part between "${start}" and "${end}".`);
  return `${text.slice(0, from + start.length)}\n${renderIndex(items)}\n${text.slice(to)}`;
}

/** Writes the index of the directory at `root` when it differs, and says whether it did. */
export function writeIndex(root) {
  const path = join(root, directory, 'README.md');
  const before = readFileSync(path, 'utf8');
  const after = withIndex(before, readItems(root));
  if (after !== before) writeFileSync(path, after);
  return after !== before;
}

/** Whether the committed index lists the item files as they are. */
export function indexIsCurrent(root) {
  const text = readFileSync(join(root, directory, 'README.md'), 'utf8');
  return withIndex(text, readItems(root)) === text;
}
