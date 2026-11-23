import { expect, it } from 'vitest';
import type { TeamHostCall } from '@orchardworks/agent-remote-protocol';
import { BotTools, workerToolsIn, WORKER_NAMESPACE } from './bot-tools.js';

// The Relay names the bots' main sessions on this Host with their missions; the stub answers as it would.
function fixture(bots: Array<{ nativeSessionId: string; mission?: string }>, tasks = true) {
  const calls: TeamHostCall[] = [];
  let listed = bots;
  const tools = new BotTools({ request: async call => { calls.push(call); return { bots: listed.map(bot => ({ providerId: 'codex', ...bot })) }; }, tasks: () => tasks });
  return { tools, calls, set: (next: typeof bots) => { listed = next; } };
}
const ref = (nativeSessionId: string) => ({ controllerId: 'controller', providerId: 'codex', nativeSessionId });

it('follows the bots the Relay names, with their missions, and tells listeners when they change', async () => {
  const f = fixture([{ nativeSessionId: 'chief', mission: 'Lead the release.' }]);
  let changes = 0; f.tools.onChange(() => { changes++; });
  await f.tools.refresh('controller');
  expect(f.calls).toEqual([{ action: 'bot_enablement' }]);
  expect(f.tools.tools(ref('chief'))).toBe('tasks');
  expect(f.tools.tools(ref('plain'))).toBe('none');
  expect(f.tools.standing(ref('chief'))).toContain('Your mission:\nLead the release.');
  expect(f.tools.standing(ref('plain'))).toBeUndefined();
  expect(changes).toBe(1);
  await f.tools.refresh('controller');
  expect(changes).toBe(1);
  f.set([{ nativeSessionId: 'chief', mission: 'Ship on Friday.' }]);
  await f.tools.refresh('controller');
  expect(changes).toBe(2);
  expect(f.tools.standing(ref('chief'))).toContain('Ship on Friday.');
});

it('offers nothing, and asks nothing, while the Relay has not acknowledged bots', async () => {
  const f = fixture([{ nativeSessionId: 'chief' }], false);
  await f.tools.refresh('controller');
  expect(f.calls).toEqual([]);
  expect(f.tools.enabled(ref('chief'))).toBe(false);
  await expect(f.tools.namespace(() => ref('chief'), false).tools.find(tool => tool.name === 'list_bots')!.execute({})).rejects.toThrow('Update the Relay to use tasks.');
});

it('counts a listed bots namespace as the tools a session was given, and a deferred one as none', () => {
  const namespace = fixture([]).tools.namespace(() => ref('chief'), false);
  expect(namespace.name).toBe(WORKER_NAMESPACE);
  expect(workerToolsIn([namespace])).toBe('tasks');
  expect(workerToolsIn([{ ...namespace, deferred: true }])).toBe('none');
  expect(workerToolsIn(undefined)).toBe('none');
});
