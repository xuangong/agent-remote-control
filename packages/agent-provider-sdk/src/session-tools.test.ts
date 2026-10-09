import { expect, it, vi } from 'vitest';
import { bindAgentSessionTools } from './session-tools.js';

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
