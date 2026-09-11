import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderStreamItem } from '@borgee/agent-provider-sdk';
const mock = vi.hoisted(() => ({client: {} as any, native: {} as any, config: {} as any, handler: undefined as any, history: [] as any[]}));
vi.mock('@github/copilot-sdk', () => ({RuntimeConnection: {forStdio: (x: unknown) => x}, CopilotClient: class {
  constructor() { return mock.client; }
}}));
import { CopilotAgentProvider } from './provider.js';
let sequence = 0;
function event(type: string, data: unknown, extra = {}) { return {id: `e${++sequence}`, timestamp: new Date().toISOString(), parentId: null, type, data, ...extra}; }
beforeEach(() => {
  mock.history = []; mock.handler = undefined;
  mock.native = {on: vi.fn((handler: unknown) => {mock.handler = handler; return vi.fn();}), getEvents: vi.fn(async () => mock.history), send: vi.fn(async () => 'm'), abort: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), rpc: {
    interruptMainTurn: vi.fn(async () => ({interrupted: true})),
    commands: {invoke: vi.fn(async () => ({kind: 'agent-prompt', prompt: 'Resolved skill instructions', displayPrompt: '/native-cmd args'}))},
    model: {getCurrent: vi.fn(async () => ({modelId: 'model-a'})), list: vi.fn(async () => ({list: [{id: 'model-a', name: 'Model A'}, {id: 'model-b', name: 'Model B'}]})), switchTo: vi.fn(async () => ({}))},
    skills: {ensureLoaded: vi.fn(async () => {}), list: vi.fn(async () => ({skills: [{name: 'native', commandName: 'native-cmd', description: 'Native skill', userInvocable: true, enabled: true}]}))},
    tasks: {list: vi.fn(async () => ({tasks: []})), sendMessage: vi.fn(async () => ({sent: true})), cancel: vi.fn(async () => ({cancelled: true}))},
    eventLog: {read: vi.fn(async () => ({events: [], cursor: 'end', hasMore: false}))}
  }};
  mock.client = {rpc: {skills: {getDiscoveryPaths: vi.fn(async () => ({paths: [{path: '/native/project/skills'}]}))}}, start: vi.fn(async () => {}), stop: vi.fn(async () => []), forceStop: vi.fn(async () => {}), createSession: vi.fn(async (config: unknown) => {mock.config = config; return mock.native;}), resumeSession: vi.fn(async (_id: string, config: unknown) => {mock.config = config; return mock.native;}), listSessions: vi.fn(async () => [])};
});
async function open() { const provider = new CopilotAgentProvider({executable: '/test/copilot'}); return {provider, session: await provider.createSession({sessionId: 'public', cwd: process.cwd()})}; }
async function collect(session: {observe(): AsyncIterable<ProviderStreamItem>}) { const values: ProviderStreamItem[] = []; const done = (async () => {for await (const value of session.observe()) values.push(value);})(); return {values, done}; }
describe('Copilot native adapter', () => {
  it('joins durable history with buffered live events once and retains background input after idle', async () => {
    const historical = event('user.message', {content: 'Earlier'});
    mock.native.getEvents.mockImplementation(async () => {mock.handler(historical); mock.handler(event('assistant.message', {messageId: 'm', content: 'Live'})); return [historical];});
    const {provider, session} = await open(); const seen = await collect(session);
    mock.handler(event('assistant.idle', {})); await session.sendMessage('Follow up');
    expect(mock.native.disconnect).not.toHaveBeenCalled(); await provider.dispose(); await seen.done;
    const boundary = seen.values.findIndex(v => v.type === 'history_boundary'); expect(boundary).toBe(1);
    expect(seen.values.filter(v => v.type === 'observation' && v.event.type === 'timeline')).toHaveLength(2);
    expect(mock.native.send).toHaveBeenCalledWith({prompt: 'Follow up', mode: 'immediate'});
  }, 10000);
  it('validates callback approvals and questions before resolving the native callback', async () => {
    const {provider, session} = await open(); const seen = await collect(session);
    const pending = mock.config.onPermissionRequest({kind: 'shell', toolCallId: 'call', command: 'pwd'}); await Promise.resolve();
    let request = seen.values.flatMap(v => v.type === 'observation' && v.event.type === 'interaction_requested' ? [v.event.request] : []).at(-1)!;
    // The async iterator can be draining initial runtime updates.
    await new Promise(resolve => setImmediate(resolve));
    request = seen.values.flatMap(v => v.type === 'observation' && v.event.type === 'interaction_requested' ? [v.event.request] : []).at(-1)!;
    await expect(session.respondToInteraction(request.requestId, {kind: 'tool_approval', decision: 'allow', scope: 'session'})).rejects.toThrow();
    await session.respondToInteraction(request.requestId, {kind: 'tool_approval', decision: 'allow', scope: 'once'});
    expect(await pending).toEqual({kind: 'approved'});
    const answer = mock.config.onUserInputRequest({question: 'Choose', choices: ['A', 'B'], allowFreeform: false}); await new Promise(resolve => setImmediate(resolve));
    request = seen.values.flatMap(v => v.type === 'observation' && v.event.type === 'interaction_requested' ? [v.event.request] : []).at(-1)!;
    await session.respondToInteraction(request.requestId, {kind: 'question', answers: [{questionId: 'answer', selectedValues: ['B']}]}); expect(await answer).toEqual({answer: 'B', wasFreeform: false});
    await provider.dispose(); await seen.done;
  }, 10000);
  it('uses native skill command names and model selection, rejects unknown controls', async () => {
    const {provider, session} = await open(); expect(session.capabilities.commands).toBe(true);
    expect(mock.config.skillDirectories).toEqual(['/native/project/skills']);
    await session.executeCommand('native', 'args'); expect(mock.native.rpc.commands.invoke).toHaveBeenCalledWith({name: 'native-cmd', input: 'args'}); expect(mock.native.send).toHaveBeenCalledWith({prompt: 'Resolved skill instructions', displayPrompt: '/native-cmd args', mode: 'immediate'});
    await session.setSessionSetting('model', 'model-b'); expect(mock.native.rpc.model.switchTo).toHaveBeenCalledWith({modelId: 'model-b'});
    await expect(session.setSessionSetting('permissions', 'allow')).rejects.toThrow();
    expect((await session.readResource('/etc/passwd')).status).toBe('unavailable'); await provider.dispose();
  }, 10000);
  it('keeps child ownership on the parent and delivers repeated child inputs through public tasks RPC', async () => {
    mock.native.rpc.tasks.list.mockResolvedValue({tasks: [{type: 'agent', id: 'child', toolCallId: 'spawn', description: 'Child', agentType: 'explore', status: 'idle', startedAt: new Date().toISOString()}]});
    const childEvent = event('assistant.message', {messageId: 'cm', content: 'Child history'}, {agentId: 'child'});
    mock.native.rpc.eventLog.read.mockResolvedValue({events: [childEvent], cursor: 'end', hasMore: false});
    const {provider, session} = await open(); const child = await session.openChildSession('child'); const seen = await collect(child);
    await child.sendMessage('First'); await child.sendMessage('Second'); expect(mock.native.rpc.tasks.sendMessage.mock.calls).toEqual([[{id: 'child', message: 'First'}], [{id: 'child', message: 'Second'}]]);
    expect(mock.client.resumeSession).not.toHaveBeenCalled(); mock.handler(event('assistant.message', {messageId: 'cm2', content: 'Child live'}, {agentId: 'child'}));
    await child.dispose(); await seen.done; expect(mock.native.disconnect).not.toHaveBeenCalled();
    expect(seen.values.filter(v => v.type === 'observation')).toHaveLength(2); await provider.dispose();
  }, 10000);
  it('resumes native history without creating a second root and closes pending interactions on dispose', async () => {
    const {provider, session} = await open(); const handle = (await session.runtimeInfo()).persistence!; await session.dispose();
    const resumed = await provider.resumeSession(handle); expect(mock.client.resumeSession).toHaveBeenCalledWith(handle.sessionId, expect.any(Object));
    const pending = mock.config.onUserInputRequest({question: 'Stop?'}); const rejected = expect(pending).rejects.toThrow('closed'); await provider.dispose(); await rejected;
    expect((await resumed.runtimeInfo()).status).toBe('closed');
  }, 10000);
});
it('does not advertise a mutable model setting with an empty native catalog', async () => {
  mock.native.rpc.model.list.mockResolvedValue({list: []}); const {provider, session} = await open();
  expect(session.capabilities.sessionSettings).toBe(false); expect((await session.runtimeInfo()).settings?.[0]).toMatchObject({value: 'model-a', mutable: false});
  await provider.dispose();
}, 10000);
it('interrupts only the main turn and settles its pending callback', async () => {
  const {provider, session} = await open(); const pending = mock.config.onUserInputRequest({question: 'Question'});
  const rejected = expect(pending).rejects.toThrow('canceled'); await session.cancel(); await rejected;
  expect(mock.native.rpc.interruptMainTurn).toHaveBeenCalledWith({}); expect(mock.native.abort).not.toHaveBeenCalled(); await provider.dispose();
}, 10000);
it('forces owned runtime cleanup when graceful shutdown reports errors', async () => {
  const {provider} = await open(); mock.client.stop.mockResolvedValue([new Error('Shutdown failure')]); await provider.dispose(); expect(mock.client.forceStop).toHaveBeenCalledOnce();
}, 10000);
