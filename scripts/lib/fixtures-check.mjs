import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const transcriptRoot = 'packages/agent-remote-fixtures/transcripts';
const seamOfDirectory = { uplink: 'S2', 'session-wire': 'S3' };
/** The directories that hold each provider's recordings and the golden rows beside them. */
export const recordingDirectories = [
  'packages/agent-provider-claude/src/journal-fixtures',
  'packages/agent-provider-codex/src/journal-fixtures',
  'packages/agent-provider-copilot/tests/fixtures/journal',
];

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const jsonFiles = directory => existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith('.json')).sort() : [];

/** The protocol version the code declares, read from the protocol package's version module. */
export function protocolVersionOf(root) {
  const text = readFileSync(join(root, 'packages/agent-remote-protocol/src/version.ts'), 'utf8');
  const version = /BORGEE_AGENT_REMOTE_PROTOCOL_VERSION\s*=\s*'([^']+)'/.exec(text)?.[1];
  if (!version) throw new Error('The protocol version module declares no version.');
  return version;
}

/**
 * Checks the committed fixtures: every transcript has a complete header, the protocol version the code declares, the scenario its file
 * is named for, numbered frames, and consumers that exist; every provider recording names the CLI version it was made with and has golden rows that name it, and no golden rows
 * file is left without its recording. Returns the problems found; an empty list means the fixtures are consistent.
 */
export function checkFixtures({ root, protocolVersion = protocolVersionOf(root) }) {
  const problems = [];
  for (const [directory, seam] of Object.entries(seamOfDirectory)) {
    const folder = join(root, transcriptRoot, directory);
    if (!existsSync(folder)) continue;
    for (const file of readdirSync(folder).filter(name => name.endsWith('.jsonl')).sort()) {
      const label = `${transcriptRoot}/${directory}/${file}`;
      const lines = readFileSync(join(folder, file), 'utf8').split('\n').filter(line => line.trim() !== '');
      let header;
      try { header = JSON.parse(lines[0] ?? ''); } catch { problems.push(`${label}: the first line is not JSON.`); continue; }
      if (header.kind !== 'transcript') problems.push(`${label}: the first line is not a transcript header.`);
      if (header.producedBy !== 'transcripts:record') problems.push(`${label}: producedBy is ${JSON.stringify(header.producedBy)}; a transcript is written only by pnpm transcripts:record.`);
      if (header.protocolVersion !== protocolVersion) problems.push(`${label}: recorded at protocol ${header.protocolVersion}, but the code declares ${protocolVersion}. Record the scenarios again and review the diff.`);
      if (header.seam !== seam) problems.push(`${label}: its header says ${header.seam}, but it lives under ${directory}.`);
      if (header.scenario !== file.slice(0, -'.jsonl'.length)) problems.push(`${label}: its header names scenario ${header.scenario}.`);
      if (!Array.isArray(header.consumers) || header.consumers.length === 0) problems.push(`${label}: no consumer names it, so nothing replays it.`);
      else for (const consumer of header.consumers) if (!existsSync(join(root, consumer))) problems.push(`${label}: consumer ${consumer} does not exist.`);
      const frames = lines.slice(1).map(line => { try { return JSON.parse(line); } catch { return {}; } }).filter(line => 'direction' in line);
      if (frames.length === 0) problems.push(`${label}: it holds no frame.`);
      frames.forEach((frame, at) => { if (frame.n !== at + 1) problems.push(`${label}: frame ${at + 1} is numbered ${frame.n}.`); });
    }
  }
  for (const directory of recordingDirectories) {
    const files = jsonFiles(join(root, directory));
    const recordings = files.filter(name => !name.endsWith('.rows.json')).map(name => name.slice(0, -'.json'.length));
    const goldens = files.filter(name => name.endsWith('.rows.json')).map(name => name.slice(0, -'.rows.json'.length));
    for (const name of recordings) {
      // A recorded fact holds for the CLI version that made it, so every recording names it (seams.md, "How fixtures are made").
      const { cli } = readJson(join(root, directory, `${name}.json`));
      if (typeof cli?.name !== 'string' || !/^\d+\.\d+\.\d+/.test(cli?.version ?? '')) problems.push(`${directory}/${name}.json: it does not name the CLI and the version it was made with ("cli": { "name", "version" }).`);
      if (!goldens.includes(name)) { problems.push(`${directory}/${name}.json: no golden rows (${name}.rows.json). Record them with the rows recorder and review them.`); continue; }
      const golden = readJson(join(root, directory, `${name}.rows.json`));
      if (golden.kind !== 'recording-rows' || golden.recording !== name) problems.push(`${directory}/${name}.rows.json: its header does not name the recording ${name}.`);
    }
    for (const name of goldens) if (!recordings.includes(name)) problems.push(`${directory}/${name}.rows.json: its recording ${name}.json is gone.`);
  }
  return problems;
}
