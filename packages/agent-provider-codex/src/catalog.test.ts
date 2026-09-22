import { expect, it } from 'vitest';
import { CodexAppServerProvider } from './provider.js';
import { createScriptedAppServer } from './test-utils/scripted-app-server.js';

it('lists native thread metadata with a cursor and disposes the discovery process', async () => {
  const app = createScriptedAppServer({
    'thread/list': () => ({ data: [
      { id: 'saved', name: 'Saved task', preview: 'Hello', cwd: '/project', createdAt: 100, updatedAt: 200, source: 'cli', status: { type: 'notLoaded' } },
      { id: 'child', source: { subAgent: { thread_spawn: {} } }, createdAt: 100, updatedAt: 200 },
    ], nextCursor: 'next' }),
  });
  const provider = new CodexAppServerProvider({ spawn: () => app.child });
  const page = await provider.listSessions({ limit: 30, cursor: 'before' });
  expect(page).toEqual({ sessions: [{
    nativeSessionId: 'saved', providerId: 'codex', title: 'Saved task', workspace: '/project',
    createdAt: '1970-01-01T00:01:40.000Z', updatedAt: '1970-01-01T00:03:20.000Z', state: 'unknown',
  }], nextCursor: 'next' });
  expect(app.requests.find((r) => r.method === 'thread/list')?.params).toMatchObject({ cursor: 'before', limit: 30, sortKey: 'updated_at' });
  expect(app.child.killed).toBe(true);
});

it('rejects malformed catalogs instead of silently hiding the failure', async () => {
  const app = createScriptedAppServer({ 'thread/list': () => ({ data: {} }) });
  const provider = new CodexAppServerProvider({ spawn: () => app.child });
  await expect(provider.listSessions()).rejects.toThrow('thread/list');
  expect(app.child.killed).toBe(true);
});

it('hydrates native model and cwd when resuming a discovered thread', async () => {
  const app = createScriptedAppServer({
    'thread/resume': () => ({ thread: { id: 'saved' }, cwd: '/original', model: 'native-model' }),
    'thread/read': () => ({ thread: { id: 'saved', turns: [] } }),
  });
  const provider = new CodexAppServerProvider({ spawn: () => app.child });
  const session = await provider.resumeSession({ providerId: 'codex', sessionId: 'saved', opaque: '{}' });
  try { expect(await session.runtimeInfo()).toMatchObject({ cwd: '/original', model: 'native-model' }); }
  finally { await session.dispose(); }
});

it('renames persisted native metadata without resuming or forking the session', async () => {
  let name = 'Original';
  const app = createScriptedAppServer({
    'thread/name/set': params => { name = String(params.name); return {}; },
    'thread/read': () => ({ thread: { id: 'saved', name } }),
  });
  const provider = new CodexAppServerProvider({ spawn: () => app.child });
  expect(await provider.renameSession('saved', '  New title  ')).toBe('New title');
  expect(app.requests.filter(r => r.method.startsWith('thread/')).map(r => r.method)).toEqual(['thread/name/set', 'thread/read']);
  expect(name).toBe('New title');
  expect(app.child.killed).toBe(true);
});
