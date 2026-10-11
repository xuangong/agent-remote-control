import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CopilotAgentProvider } from '../src/provider.js';
import { fixture, observe, reply, waitFor } from './native-fixture.js';

it('reads actual native history through the loaded SDK and a cold profile without resuming or changing ownership', async () => {
  const f = await fixture((body, response) => reply(response, body, 'SOURCE_SQLITE_ANSWER'));
  try {
    const session = await f.provider.createSession({ sessionId: 'source', cwd: f.cwd, model: 'native-fixture' });
    const seen = observe(session); await session.sendMessage('SOURCE_SQLITE_REQUIREMENT');
    await waitFor(() => seen.events().some(event => event.type === 'turn_completed'));
    const id = (await session.runtimeInfo()).sessionId!;
    expect((await f.provider.readSessionHistory(id, { query: 'SOURCE_SQLITE' })).entries.map(entry => entry.text)).toEqual(['SOURCE_SQLITE_REQUIREMENT', 'SOURCE_SQLITE_ANSWER']);
    await f.provider.dispose(); await seen.done;
    const directory = join(f.home, 'profile', 'session-state', id), path = join(directory, 'events.jsonl');
    const before = await readFile(path), files = await readdir(directory);
    const cold = new CopilotAgentProvider({ executable: '/must-not-start-for-history', env: { COPILOT_HOME: join(f.home, 'profile') } });
    expect((await cold.readSessionHistory(id, { query: 'SOURCE_SQLITE' })).entries.map(entry => entry.text)).toEqual(['SOURCE_SQLITE_REQUIREMENT', 'SOURCE_SQLITE_ANSWER']);
    expect(await readFile(path)).toEqual(before); expect(await readdir(directory)).toEqual(files);
    expect(f.requests).toHaveLength(1); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
}, 30000);
