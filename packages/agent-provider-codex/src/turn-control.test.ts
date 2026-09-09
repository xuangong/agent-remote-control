import { expect, it } from 'vitest';
import { CodexAppServerProvider } from './provider.js';
import { createScriptedAppServer } from './test-utils/scripted-app-server.js';

it('steers and interrupts the active native turn and rejects controls after completion', async () => {
  const app = createScriptedAppServer({
    'thread/start': () => ({ thread: { id: 'thread' } }),
    'turn/start': () => ({ turn: { id: 'turn' } }),
    'turn/steer': () => ({ turnId: 'turn' }),
  });
  const session = await new CodexAppServerProvider({ spawn: () => app.child }).createSession({ sessionId: 'local' });
  try {
    expect(session.capabilities).toMatchObject({ steer: true, cancel: true });
    await expect(session.cancel!()).rejects.toThrow('active turn');
    await session.sendMessage('Start');
    await session.steer!('Use a smaller example');
    await session.cancel!();
    expect(app.requests.find((r) => r.method === 'turn/steer')?.params).toEqual({ threadId: 'thread', expectedTurnId: 'turn', input: [{ type: 'text', text: 'Use a smaller example', text_elements: [] }] });
    expect(app.requests.find((r) => r.method === 'turn/interrupt')?.params).toEqual({ threadId: 'thread', turnId: 'turn' });
    app.child.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'interrupted' } } }) + '\n');
    await expect(session.steer!('Too late')).rejects.toThrow('active turn');
  } finally { await session.dispose(); }
});
