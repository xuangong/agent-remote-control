import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ClaudeAgentSession } from './session.js';
import { nativeFixture, nativeReply } from './test-utils/native-fixture.js';

const hasToolResult = (body: any): boolean => Array.isArray(body.messages)
  && body.messages.some((message: any) => Array.isArray(message.content) && message.content.some((part: any) => part?.type === 'tool_result'));

async function openWriteFixture(restrictedNative: boolean) {
  const fixture = await nativeFixture((body, response) => {
    nativeReply(response, hasToolResult(body)
      ? [{ type: 'text', text: 'WRITE_DONE' }]
      : [{ type: 'tool_use', id: 'native-write', name: 'Write', input: { file_path: join(fixture.cwd, 'yolo.txt'), content: 'YOLO verified\n' } }]);
  });
  const session = await ClaudeAgentSession.open({ sessionId: randomUUID(), cwd: fixture.cwd, model: 'claude-sonnet-4-5-20250929' }, { ...fixture.options, restrictedNative });
  const events: any[] = [];
  const pump = (async () => { for await (const item of session.observe()) if (item.type === 'observation') events.push(item.event); })();
  return { fixture, session, events, close: async () => { await session.dispose(); await pump; await fixture.close(); } };
}

it.each([false, true])('requests approval for the same native write in default mode with restricted sandbox %s', async restrictedNative => {
  const { fixture, session, events, close } = await openWriteFixture(restrictedNative);
  try {
    expect((await session.runtimeInfo()).settings).toContainEqual(expect.objectContaining({ id: 'permissions', value: 'default' }));
    await session.sendMessage('Write yolo.txt in the current workspace.');
    await expect.poll(() => events.some(event => event.type === 'interaction_requested' && event.request.kind === 'tool_approval'), { timeout: 10000 }).toBe(true);
    const request = events.find(event => event.type === 'interaction_requested' && event.request.kind === 'tool_approval');
    await session.respondToInteraction(request.request.requestId, { kind: 'tool_approval', decision: 'allow', scope: 'once' });
    await expect.poll(() => events.some(event => event.type === 'turn_completed'), { timeout: 10000 }).toBe(true);
    expect(await readFile(join(fixture.cwd, 'yolo.txt'), 'utf8')).toBe('YOLO verified\n');
  } finally { await close(); }
}, 20000);

it.each([false, true])('executes a native tool in YOLO without approval with restricted sandbox %s', async restrictedNative => {
  const { fixture, session, events, close } = await openWriteFixture(restrictedNative);
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
  } finally { await close(); }
}, 20000);
