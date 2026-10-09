import { beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ client: {} as any, native: {} as any, config: {} as any }));
vi.mock('@github/copilot-sdk', () => ({ RuntimeConnection: { forStdio: (value: unknown) => value }, CopilotClient: class { constructor() { return mock.client; } } }));
import { CopilotAgentProvider } from './provider.js';
beforeEach(() => {
  mock.native = { on: vi.fn(() => vi.fn()), getEvents: async () => [], disconnect: vi.fn(async () => {}), rpc: {
    metadata: { isProcessing: async () => ({ processing: false }), contextInfo: async () => ({ contextInfo: null }) },
    model: { getCurrent: async () => ({ modelId: 'native' }), list: async () => ({ list: [] }) },
    skills: { ensureLoaded: async () => {}, list: async () => ({ skills: [] }) },
    tasks: { list: async () => ({ tasks: [] }) },
  } };
  mock.client = { start: async () => {}, stop: async () => [], forceStop: async () => {},
    createSession: vi.fn(async (config: unknown) => { mock.config = config; return mock.native; }),
    resumeSession: vi.fn(async (_id: string, config: unknown) => { mock.config = config; return mock.native; }),
    rpc: { sessions: { checkInUse: async () => ({ inUse: [] }) }, skills: { getDiscoveryPaths: async () => ({ paths: [] }) } } };
});
function provider() { return new CopilotAgentProvider({ executable: '/isolated/copilot' }); }
const tool = (execute = vi.fn(async () => 'bound evidence')) => ({ name: 'read_main_session', description: 'Read the bound main session',
  inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1 } }, required: ['limit'], additionalProperties: false }, execute });

it('appends instructions without replacing Copilot native policy and restores them after a cold resume', async () => {
  const first = provider(); const session = await first.createSession({ sessionId: 'local', systemPrompt: 'Existing additions', instructions: 'Role' });
  expect(mock.config.systemMessage).toEqual({ mode: 'append', content: 'Existing additions\n\nRole' });
  const handle = (await session.runtimeInfo()).persistence!; await first.dispose();
  const cold = provider(); const resumed = await cold.resumeSession(handle);
  try { expect(mock.config.systemMessage).toEqual({ mode: 'append', content: 'Existing additions\n\nRole' }); }
  finally { await resumed.dispose(); await cold.dispose(); }
}, 10000);

it('rebinds validated SDK Host tools and new instructions on cold resume and fences disposed callbacks', async () => {
  const execute = vi.fn(async () => 'bound evidence'); const first = provider();
  let session = await first.createSession({ sessionId: 'local', instructions: 'Role', tools: [tool(execute)] });
  const handle = (await session.runtimeInfo()).persistence!;
  expect(JSON.parse(handle.opaque).tools).toBeUndefined();
  for (const resume of [false, true]) {
    let cold: CopilotAgentProvider | undefined;
    if (resume) { cold = provider(); session = await cold.resumeSession(handle, { instructions: 'Updated role', tools: [tool(execute)] }); }
    const nativeTool = mock.config.tools?.[0]; expect(nativeTool).toMatchObject({ name: 'read_main_session', parameters: tool().inputSchema });
    if (resume) expect(mock.config.systemMessage).toEqual({ mode: 'append', content: 'Updated role' });
    expect(await nativeTool.handler({ limit: 2 }, {})).toBe('bound evidence');
    await expect(nativeTool.handler({ limit: 'bad' }, {})).rejects.toThrow(/argument/i);
    execute.mockRejectedValueOnce(new Error('Read failed')); await expect(nativeTool.handler({ limit: 2 }, {})).rejects.toThrow('Read failed');
    await session.dispose(); await expect(nativeTool.handler({ limit: 2 }, {})).rejects.toThrow(/closed/i);
    await cold?.dispose();
  }
  expect(execute).toHaveBeenCalledTimes(4); await first.dispose();
}, 10000);

it('rejects invalid extension schemas before native Copilot creation', async () => {
  const instance = provider();
  await expect(instance.createSession({ sessionId: 'local', tools: [{ ...tool(), inputSchema: { type: 'invalid' } }] })).rejects.toThrow(/schema/i);
  expect(mock.client.createSession).not.toHaveBeenCalled(); await instance.dispose();
}, 10000);
