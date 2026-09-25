import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { prepareSharedCodex } from './codex-shared-startup.js';
it('starts a missing daemon for legacy private configuration and leaves an existing daemon running', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-shared-startup-'));
  try {
    const cli = join(root, 'cli.mjs');
    await writeFile(cli, `import {appendFileSync,existsSync,writeFileSync} from 'node:fs';
const action=process.argv.at(-1),root=process.env.AGENT_HOST_STATE_DIR;
appendFileSync(root+'/actions',action+'\\n');
if(action==='start')writeFileSync(root+'/running','yes');
process.exit(existsSync(root+'/running')?0:1);`);
    const env = {AGENT_HOST_CODEX_CONNECTION: 'private'};
    await prepareSharedCodex(root, env, cli);
    expect(env.AGENT_HOST_CODEX_CONNECTION).toBe('shared');
    expect(await readFile(join(root, 'actions'), 'utf8')).toBe('status\nstart\nstatus\n');
    await prepareSharedCodex(root, {AGENT_HOST_CODEX_CONNECTION: 'private'}, cli);
    expect(await readFile(join(root, 'actions'), 'utf8')).toBe('status\nstart\nstatus\nstatus\n');
    await prepareSharedCodex(root, {AGENT_HOST_CODEX_CONNECTION: 'shared'}, cli);
    expect(await readFile(join(root, 'actions'), 'utf8')).toBe('status\nstart\nstatus\nstatus\n');
    await prepareSharedCodex(root, {AGENT_HOST_CODEX_CONNECTION: 'shared', AGENT_HOST_CODEX_AUTO_START: '1'}, cli);
    expect(await readFile(join(root, 'actions'), 'utf8')).toBe('status\nstart\nstatus\nstatus\nstatus\n');
  } finally { await rm(root, {recursive: true, force: true}); }
});
it('does not migrate an explicitly restricted or custom-daemon configuration by starting another writer', async () => {
  await expect(prepareSharedCodex('/unused', {AGENT_HOST_CODEX_CONNECTION: 'private', AGENT_HOST_CODEX_TRUST_SHARED: '0'}, '/missing')).rejects.toThrow(/trust/i);
  await expect(prepareSharedCodex('/unused', {AGENT_HOST_CODEX_CONNECTION: 'private', AGENT_HOST_CODEX_SOCKET: '/custom/socket'}, '/missing')).rejects.toThrow(/custom/i);
});
