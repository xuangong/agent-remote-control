import { expect, it } from 'vitest';
import { runShare, type ShareChoice, type ShareIO } from './share-command.js';

type Step = (prompt: string, choices: readonly ShareChoice[]) => string | undefined;
const pick = (value: string): Step => (_prompt, choices) => {
  expect(choices.some(choice => choice.value === value), `Missing choice ${value}`).toBe(true);
  return value;
};
function fixture(steps: Step[], answers: string[] = []) {
  const items = Array.from({ length: 24 }, (_, index) => ({
    providerId: 'codex', nativeSessionId: `id-${index}`, title: index < 20 ? 'Recent work' : 'Archive query',
    workspace: index < 20 ? '/first/project' : '/second/project',
    createdAt: '2026-09-01T00:00:00Z', updatedAt: new Date(Date.UTC(2026, 8, 21, 0, 30 - index)).toISOString(), state: 'idle',
  }));
  let output = '', pageReads = 0;
  const validated: string[] = [], urls: string[] = [];
  const io: ShareIO = {
    write: text => { output += text; },
    ask: async () => { const answer = answers.shift(); if (answer === undefined) throw Error('Unexpected text input'); return answer; },
    select: async (prompt, choices) => { const step = steps.shift(); if (!step) throw Error(`Unexpected selection: ${prompt}`); return step(prompt, choices); },
    qr: async url => { urls.push(url); return 'QR'; },
  };
  const run = () => runShare(['list-sessions'], async request => {
    if (request.action === 'share-context') return { hostId: 'host', serverUrl: 'https://agents.example',
      providers: [{ providerId: 'codex', displayName: 'Codex' }] };
    if (request.nativeSessionId) {
      validated.push(String(request.nativeSessionId));
      return { status: 200, body: JSON.stringify(items.find(item => item.nativeSessionId === request.nativeSessionId)) };
    }
    pageReads += 1;
    expect(request.cursor === undefined || request.cursor === 'older').toBe(true);
    return { status: 200, body: JSON.stringify({ items: request.cursor ? items.slice(20) : items.slice(0, 20),
      hasMore: !request.cursor, nextCursor: request.cursor ? undefined : 'older' }) };
  }, io);
  return { run, items, validated, urls, get output() { return output; }, get pageReads() { return pageReads; } };
}

it.each(['ARCHIVE QUERY', 'ID-23'])('searches titles and IDs beyond the loaded page using %s', async query => {
  const f = fixture([
    pick('recent'),
    (prompt, choices) => { expect(f.pageReads).toBe(1); return pick('search')(prompt, choices); },
    (_prompt, choices) => {
      expect(choices.filter(choice => choice.value.startsWith('session:')).every(choice => choice.label.includes('Archive query'))).toBe(true);
      return choices.find(choice => choice.description?.includes('Session: id-23'))!.value;
    },
  ], [query]);
  await f.run();
  expect(f.pageReads).toBe(2);
  expect(f.validated).toEqual(['id-23']);
  expect(f.urls).toEqual(['https://agents.example/?host=host&provider=codex&session=id-23']);
});

it('searches full folder paths and scopes same-title sessions to the exact selected directory', async () => {
  const f = fixture([
    pick('folders'),
    (_prompt, choices) => {
      expect(choices.filter(choice => choice.value.startsWith('folder:')).map(choice => choice.label)).toEqual([
        '/first/project (20)', '/second/project (4)',
      ]);
      return 'search';
    },
    (_prompt, choices) => {
      const folders = choices.filter(choice => choice.value.startsWith('folder:'));
      expect(folders.map(choice => choice.label)).toEqual(['/second/project (4)']);
      return folders[0]!.value;
    },
    pick('search'),
    (_prompt, choices) => {
      expect(choices.filter(choice => choice.value.startsWith('session:'))).toHaveLength(4);
      return choices.find(choice => choice.description?.includes('Session: id-22'))!.value;
    },
  ], ['SECOND/project', 'Archive']);
  await f.run();
  expect(f.validated).toEqual(['id-22']);
  expect(f.pageReads).toBe(2);
});

it('clears empty searches and changes browsing modes without fetching cached pages again', async () => {
  const f = fixture([
    pick('recent'), pick('search'),
    (prompt, choices) => {
      expect(prompt).toContain('No matches');
      expect(choices.some(choice => choice.value.startsWith('session:'))).toBe(false);
      return pick('clear')(prompt, choices);
    },
    pick('back'), pick('folders'), pick('back'), pick('recent'),
    (_prompt, choices) => choices.find(choice => choice.description?.includes('Session: id-0'))!.value,
  ], ['nonexistent']);
  await f.run();
  expect(f.validated).toEqual(['id-0']);
  expect(f.pageReads).toBe(2);
});

it('cancels at the mode menu before reading native catalogs', async () => {
  const f = fixture([() => undefined]);
  await f.run();
  expect(f.pageReads).toBe(0);
  expect(f.urls).toEqual([]);
  expect(f.output).toContain('Sharing cancelled.');
});

it('keeps sessions without a directory discoverable in folder mode', async () => {
  const f = fixture([
    pick('folders'),
    (_prompt, choices) => choices.find(choice => choice.label.startsWith('(no directory)'))!.value,
    (_prompt, choices) => choices.find(choice => choice.description?.includes('Session: id-23'))!.value,
  ]);
  delete (f.items[23] as { workspace?: string }).workspace;
  await f.run();
  expect(f.validated).toEqual(['id-23']);
});

it('matches multiple Unicode search terms without treating folder names as session titles', async () => {
  const f = fixture([
    pick('recent'), pick('search'),
    (_prompt, choices) => {
      const sessions = choices.filter(choice => choice.value.startsWith('session:'));
      expect(sessions).toHaveLength(1);
      return sessions[0]!.value;
    },
  ], ['修复  ＡＰＩ']);
  f.items[23]!.title = '中文 API 修复';
  f.items[22]!.workspace = '/中文 API 修复';
  await f.run();
  expect(f.validated).toEqual(['id-23']);
});

it('preserves provider identity when the same folder contains identical session IDs and titles', async () => {
  const steps: Step[] = [pick('folders'), (_prompt, choices) => choices[0]!.value,
    (_prompt, choices) => choices.find(choice => choice.label.startsWith('[claude]'))!.value];
  const urls: string[] = [];
  await runShare(['list-sessions'], async request => {
    if (request.action === 'share-context') return { hostId: 'host', serverUrl: 'https://agents.example',
      providers: [{ providerId: 'codex', displayName: 'Codex' }, { providerId: 'claude', displayName: 'Claude' }] };
    const item = { providerId: request.providerId, nativeSessionId: 'same-id', title: 'Same title', workspace: '/project',
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', state: 'idle' };
    return { status: 200, body: JSON.stringify(request.nativeSessionId ? item : { items: [item], hasMore: false }) };
  }, {
    write: () => {}, ask: async () => { throw Error('Unexpected text input'); },
    select: async (prompt, choices) => steps.shift()!(prompt, choices),
    qr: async url => { urls.push(url); return 'QR'; },
  });
  expect(urls).toEqual(['https://agents.example/?host=host&provider=claude&session=same-id']);
});
