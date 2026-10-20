import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ClaudeAgentSession } from './session.js';
import { nativeFixture, nativeReply } from './test-utils/native-fixture.js';

it.each([false, true])('executes a native tool in YOLO without approval with restricted sandbox %s', async restrictedNative => {
  let calls = 0;
  const fixture = await nativeFixture((_body, response) => {
    nativeReply(response, calls++ === 0
      ? [{ type: 'tool_use', id: 'yolo-write', name: 'Write', input: { file_path: join(fixture.cwd, 'yolo.txt'), content: 'YOLO verified\n' } }]
      : [{ type: 'text', text: 'YOLO_OK' }]);
  });
  const session = await ClaudeAgentSession.open({ sessionId: randomUUID(), cwd: fixture.cwd, model: 'claude-sonnet-4-5-20250929' }, { ...fixture.options, restrictedNative });
  const events: any[] = [];
  const pump = (async () => { for await (const item of session.observe()) if (item.type === 'observation') events.push(item.event); })();
  try {
    expect((await session.runtimeInfo()).settings).toContainEqual(expect.objectContaining({ id: 'permissions', value: 'default' }));
    await session.setSessionSetting('permissions', 'bypassPermissions');
    await session.setPlanning(true);
    await session.setPlanning(false);
    await session.sendMessage('Write yolo.txt in the current workspace.');
    await expect.poll(() => events.some(event => event.type === 'turn_completed'), { timeout: 10000 }).toBe(true);
    expect(await readFile(join(fixture.cwd, 'yolo.txt'), 'utf8')).toBe('YOLO verified\n');
    expect(events.some(event => event.type === 'interaction_requested')).toBe(false);
    expect((await session.runtimeInfo()).settings).toContainEqual(expect.objectContaining({ id: 'permissions', value: 'bypassPermissions' }));
    await session.setSessionSetting('permissions', 'default');
    expect((await session.runtimeInfo()).settings).toContainEqual(expect.objectContaining({ id: 'permissions', value: 'default' }));
  } finally { await session.dispose(); await pump; await fixture.close(); }
}, 20000);
