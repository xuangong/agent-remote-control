import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {expect, it} from 'vitest';
import {fixture, observe, reply, waitFor} from './native-fixture.js';

it('persists a native Copilot rename during a turn without adding prompts or interrupting it', async () => {
  let finish: (() => void) | undefined;
  const f = await fixture((body, response) => {finish = () => { if (!response.writableEnded) reply(response, body, 'RENAME_TURN_FINISHED'); };});
  try {
    const session = await f.provider.createSession({sessionId:'rename',cwd:f.cwd,model:'gpt-4.1'});
    const seen = observe(session);
    await session.sendMessage('Hold this fixture turn.');
    await waitFor(() => finish);
    const handle = (await session.runtimeInfo()).persistence!;
    expect(await f.provider.renameSession(handle.sessionId,'Native renamed 会话')).toBe('Native renamed 会话');
    expect(await f.provider.renameSession(handle.sessionId,'Native renamed 会话')).toBe('Native renamed 会话');
    expect((await session.runtimeInfo()).status).toBe('running');
    finish!();
    await waitFor(() => seen.events().some(event => event.type === 'turn_completed'));
    await f.provider.releaseSession(handle.sessionId);
    await session.dispose(); await seen.done;
    expect(await f.provider.readSessionTitle(handle.sessionId)).toBe('Native renamed 会话');
    expect((await f.provider.listSessions()).find(item => item.nativeSessionId === handle.sessionId)?.title).toBe('Native renamed 会话');
    const events = (await readFile(join(f.home,'profile','session-state',handle.sessionId,'events.jsonl'),'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(events.filter(event => event.type === 'user.message')).toHaveLength(1);
    const resumed = await f.provider.resumeSession(handle);
    expect(await f.provider.readSessionTitle(handle.sessionId)).toBe('Native renamed 会话');
    expect(await f.provider.renameSession(handle.sessionId,'Renamed after resume')).toBe('Renamed after resume');
    await resumed.dispose();
    expect(f.requests).toHaveLength(1); expect(f.errors).toEqual([]);
  } finally {finish?.(); await f.close();}
}, 30000);
