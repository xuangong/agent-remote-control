import { expect, it } from 'vitest';
import { bindAgentSessionTools } from '@orchardworks/agent-provider-sdk';
import { handleRoleRequest, roleInput } from './role-routes.js';
import { roleRequest } from './role-command.js';

const schema = { type: 'object', properties: { to: { type: 'string' }, messageIds: { type: 'array', items: { type: 'string' }, minItems: 1 }, limit: { type: 'integer', minimum: 1 },
  fresh: { type: 'boolean' }, context: { type: 'object', properties: { commit: { type: 'string' } }, additionalProperties: false } }, required: ['to'], additionalProperties: false };
const calls: unknown[] = [];
const tools = bindAgentSessionTools([{ name: 'send_team_message', description: 'Send.', inputSchema: schema, execute: async args => { calls.push(args); return JSON.stringify({ sent: true }); } },
  { name: 'read_note', description: 'Read.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => 'plain text' }]);
const session = { kind: 'session' as const, ref: { providerId: 'codex', nativeSessionId: 'member' } };

it('turns kebab-case options into the input the tool\'s schema describes', () => {
  expect(roleInput(schema, [['to', 'leader'], ['message-ids', 'a'], ['message-ids', 'b'], ['limit', '3'], ['fresh', 'true'], ['context', '{"commit":"abc1234"}']]))
    .toEqual({ to: 'leader', messageIds: ['a', 'b'], limit: 3, fresh: true, context: { commit: 'abc1234' } });
  for (const options of [[['unknown', 'x']], [['limit', 'many']], [['fresh', 'yes']], [['context', '{']], [['to', 'a'], ['to', 'b']]] as Array<Array<[string, string]>>) {
    expect(() => roleInput(schema, options)).toThrow();
  }
});

it('lists and runs the role\'s tools with their own validation, for the session that holds the role only', async () => {
  const listed = await handleRoleRequest({ command: 'list' }, session, async () => tools);
  expect(listed).toEqual({ result: { commands: [{ command: 'send-team-message', description: 'Send.', input: schema }, { command: 'read-note', description: 'Read.', input: expect.any(Object) }] } });
  expect(await handleRoleRequest(await roleRequest(['send-team-message', '--to', 'leader', '--input', '{"limit":2}']), session, async () => tools)).toEqual({ result: { sent: true } });
  expect(calls).toEqual([{ limit: 2, to: 'leader' }]);
  expect(await handleRoleRequest({ command: 'run', name: 'read_note' }, session, async () => tools)).toEqual({ result: { value: 'plain text' } });
  expect(await handleRoleRequest({ command: 'run', name: 'send-team-message', options: [['limit', '0'], ['to', 'x']] }, session, async () => tools)).toMatchObject({ error: { code: 'invalid_request' } });
  expect(await handleRoleRequest({ command: 'run', name: 'send-team-message' }, session, async () => tools)).toMatchObject({ error: { code: 'invalid_request' } });
  expect(await handleRoleRequest({ command: 'run', name: 'archive' }, session, async () => tools)).toMatchObject({ error: { code: 'role_command_unavailable' } });
  expect(await handleRoleRequest({ command: 'run', name: 'archive' }, session, async () => [])).toMatchObject({ error: { code: 'role_command_unavailable', message: 'This session holds no role with commands.' } });
  expect(await handleRoleRequest({ command: 'list' }, { kind: 'owner' }, async () => tools)).toMatchObject({ error: { code: 'invalid_request' } });
  await expect(roleRequest(['send-team-message', 'leader'])).rejects.toMatchObject({ code: 'invalid_request' });
  await expect(roleRequest(['send-team-message', '--input', '[1]'])).rejects.toMatchObject({ code: 'invalid_request' });
});
