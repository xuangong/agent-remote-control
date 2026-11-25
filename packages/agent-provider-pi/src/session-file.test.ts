import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { activeBranch, findPiSessionFile, lastSelections, listPiSessionFiles, parsePiSession, piAgentDirectory, piSessionDirectory, readPiSession, sessionTitle } from './session-file.js';

const ID = '0f5c51e2-71e4-4ab9-b111-e054c951bc6a';
const header = (id = ID, cwd = '/work') => JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-11-26T00:00:00.000Z', cwd });
const message = (id: string, parentId: string | null, role: string, content: unknown) => JSON.stringify({ type: 'message', id, parentId, timestamp: '2026-11-26T00:00:01.000Z', message: { role, content, timestamp: 1 } });

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const sessions = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sessions-')); roots.push(root);
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); }
  return root;
};

describe('pi session files', () => {
  it('keeps the profile and session directories pi uses, with the overrides it reads', () => {
    expect(piAgentDirectory({ HOME: '/h' })).toBe('/h/.pi/agent');
    expect(piAgentDirectory({ HOME: '/h', PI_CODING_AGENT_DIR: '/p' })).toBe('/p');
    expect(piSessionDirectory({ HOME: '/h' })).toBe('/h/.pi/agent/sessions');
    expect(piSessionDirectory({ HOME: '/h', PI_CODING_AGENT_DIR: '/p', PI_CODING_AGENT_SESSION_DIR: '/s' })).toBe('/s');
  });

  it('parses the header and the entries, leaving out a line cut short and refusing a file without a valid header', () => {
    const parsed = parsePiSession([header(), message('a', null, 'user', 'hi'), '{"type":"message","id":"b","parent', ''].join('\n'));
    expect(parsed?.header).toMatchObject({ id: ID, cwd: '/work' });
    expect(parsed?.entries.map(entry => entry.id)).toEqual(['a']);
    expect(parsePiSession(message('a', null, 'user', 'hi'))).toBeUndefined();
    expect(parsePiSession(header('not-a-uuid'))).toBeUndefined();
    expect(parsePiSession(`${header()}\n${header()}`)).toBeUndefined();
  });

  it('follows the parents from the last entry, so the branch pi continues on is the one shown', () => {
    const parsed = parsePiSession([header(), message('a', null, 'user', 'one'), message('b', 'a', 'assistant', []), message('c', 'a', 'user', 'branch'), message('d', 'c', 'assistant', [])].join('\n'))!;
    expect(activeBranch(parsed.entries).map(entry => entry.id)).toEqual(['a', 'c', 'd']);
    const loop = parsePiSession([header(), message('a', 'b', 'user', 'x'), message('b', 'a', 'user', 'y')].join('\n'))!;
    expect(activeBranch(loop.entries).length).toBeLessThanOrEqual(2);
  });

  it('titles a session by its latest name, else by its first prompt', () => {
    const entries = parsePiSession([header(), message('a', null, 'user', [{ type: 'text', text: '  Fix   the\nbuild ' }])].join('\n'))!.entries;
    expect(sessionTitle(entries)).toBe('Fix the build');
    const named = [...entries, { type: 'session_info', id: 'n1', parentId: 'a', name: 'Old' }, { type: 'session_info', id: 'n2', parentId: 'n1', name: ' New name ' }];
    expect(sessionTitle(named)).toBe('New name');
    expect(sessionTitle([])).toBeUndefined();
  });

  it('reads the model and thinking level a session last used', () => {
    const entries = [{ type: 'model_change', provider: 'a', modelId: 'x' }, { type: 'model_change', provider: 'b', modelId: 'y' }, { type: 'thinking_level_change', thinkingLevel: 'high' }];
    expect(lastSelections(entries)).toEqual({ model: 'b/y', thinkingLevel: 'high' });
  });

  it('lists the sessions under every working-directory folder and finds one by its id', async () => {
    const other = '1a5c51e2-71e4-4ab9-b111-e054c951bc6b';
    const root = sessions({
      [`--work--/2026-11-26T00-00-00-000Z_${ID}.jsonl`]: [header(), message('a', null, 'user', 'first')].join('\n'),
      [`--other--/2026-11-26T00-00-00-000Z_${other}.jsonl`]: [header(other, '/other'), message('a', null, 'user', 'second')].join('\n'),
      '--bad--/notes.txt': 'x',
      [`--bad--/2026-11-26T00-00-00-000Z_${ID.replace('0f5c', '1111')}.jsonl`]: 'not json',
    });
    const listed = await listPiSessionFiles(root);
    expect(listed.map(entry => [entry.id, entry.cwd, entry.title]).sort()).toEqual([[ID, '/work', 'first'], [other, '/other', 'second']].sort());
    expect(await findPiSessionFile(root, other)).toBe(join(root, '--other--', `2026-11-26T00-00-00-000Z_${other}.jsonl`));
    expect(await findPiSessionFile(root, '2a5c51e2-71e4-4ab9-b111-e054c951bc6c')).toBeUndefined();
    expect(await findPiSessionFile(root, '../x')).toBeUndefined();
    expect(await listPiSessionFiles(join(root, 'missing'))).toEqual([]);
    expect((await readPiSession(join(root, '--work--', `2026-11-26T00-00-00-000Z_${ID}.jsonl`)))?.header.id).toBe(ID);
    expect(await readPiSession(join(root, 'missing'))).toBeUndefined();
  });

  it('titles a long session from the head and the tail of its file without reading it whole', async () => {
    const filler = Array.from({ length: 3000 }, (_, index) => message(`f${index}`, index ? `f${index - 1}` : null, 'assistant', [{ type: 'text', text: 'x'.repeat(200) }]));
    const name = JSON.stringify({ type: 'session_info', id: 'zz', parentId: 'f2999', timestamp: '2026-11-26T00:00:02.000Z', name: 'Tail name' });
    const root = sessions({ [`--w--/2026-11-26T00-00-00-000Z_${ID}.jsonl`]: [header(), ...filler, name].join('\n') });
    expect((await listPiSessionFiles(root))[0]?.title).toBe('Tail name');
  });
});
