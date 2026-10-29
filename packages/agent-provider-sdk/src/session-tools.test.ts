import { expect, it, vi } from 'vitest';
import { bindAgentSessionToolNamespaces, bindAgentSessionTools } from './session-tools.js';

it('validates nested JSON-schema arguments before invoking a Host callback', async () => {
  const execute = vi.fn(async () => 'recorded');
  const [tool] = bindAgentSessionTools([{ name: 'update_work', description: 'Update work', inputSchema: {
    type: 'object', required: ['revision', 'phase'], additionalProperties: false,
    properties: { revision: { type: 'integer', minimum: 0 }, phase: { enum: ['ready', 'completed'] },
      evidence: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1 } }, additionalProperties: false } } },
  }, execute }]);
  for (const args of [{ revision: -1, phase: 'ready' }, { revision: 1 }, { revision: 1, phase: 'invalid' },
    { revision: 1, phase: 'ready', sessionId: 'replacement' }, { revision: 1, phase: 'ready', evidence: [{ id: '' }] }]) {
    await expect(tool!.execute(args)).rejects.toThrow(/Invalid arguments/);
  }
  expect(execute).not.toHaveBeenCalled();
  expect(await tool!.execute({ revision: 1, phase: 'ready', evidence: [{ id: 'turn-one' }] })).toBe('recorded');
}, 10000);

it('rejects duplicate names and unsupported schemas before binding tools', () => {
  const definition = { name: 'read_work', description: 'Read work', inputSchema: { type: 'object' }, execute: async () => '' };
  expect(() => bindAgentSessionTools([definition, definition])).toThrow(/unique/);
  expect(() => bindAgentSessionTools([{ ...definition, name: 'bad.name' }])).toThrow(/valid/);
  expect(() => bindAgentSessionTools([{ ...definition, inputSchema: { type: 'object', unsupportedKeyword: true } }])).toThrow(/unsupported/);
}, 10000);

it('snapshots schemas and fences callbacks when their session binding closes', async () => {
  let open = true; const execute = vi.fn(async () => 'ok');
  const schema = { type: 'object', required: ['limit'], properties: { limit: { type: 'integer' } } };
  const [tool] = bindAgentSessionTools([{ name: 'read_work', description: 'Read work', inputSchema: schema, execute }], () => { if (!open) throw new Error('Session is closed.'); });
  schema.required.length = 0;
  await expect(tool!.execute({})).rejects.toThrow(/Invalid arguments/);
  open = false; await expect(tool!.execute({ limit: 1 })).rejects.toThrow(/closed/); expect(execute).not.toHaveBeenCalled();
}, 10000);

const namespacedTool = (name: string) => ({ name, description: name, inputSchema: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => name });

it('binds tool namespaces with valid, unique names and keeps their deferral', async () => {
  const [bound] = bindAgentSessionToolNamespaces([{ name: 'agent_remote', description: 'Agent Remote Control', deferred: true, tools: [namespacedTool('call_for_support')] }]);
  expect(bound).toMatchObject({ name: 'agent_remote', description: 'Agent Remote Control', deferred: true });
  expect(await bound!.tools[0]!.execute({})).toBe('call_for_support');
  expect(() => bindAgentSessionToolNamespaces([{ name: 'bad name', description: '', tools: [namespacedTool('a')] }])).toThrow(/namespace/i);
  expect(() => bindAgentSessionToolNamespaces([{ name: 'a', description: '', tools: [namespacedTool('x')] }, { name: 'a', description: '', tools: [namespacedTool('y')] }])).toThrow(/unique/i);
  expect(() => bindAgentSessionToolNamespaces([{ name: 'tool_search', description: '', tools: [namespacedTool('x')] }])).toThrow(/reserved/i);
  expect(() => bindAgentSessionToolNamespaces([{ name: 'n', description: 'x'.repeat(1025), tools: [namespacedTool('x')] }])).toThrow(/description/i);
});
it('rejects a namespaced call while the session is unavailable', async () => {
  const [bound] = bindAgentSessionToolNamespaces([{ name: 'n', description: 'd', tools: [namespacedTool('x')] }], () => { throw new Error('closed'); });
  await expect(bound!.tools[0]!.execute({})).rejects.toThrow('closed');
});
