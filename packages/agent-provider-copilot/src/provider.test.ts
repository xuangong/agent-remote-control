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
    metadata: {isProcessing: vi.fn(async () => ({processing: false}))},
    permissions: {handlePendingPermissionRequest: vi.fn(async () => ({success: true}))},
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
    mock.handler(event('tool.execution_start', {toolCallId: 'call', toolName: 'bash'}));
    mock.handler(event('permission.requested', {requestId: 'approval', permissionRequest: {kind: 'shell', toolCallId: 'call', command: 'pwd'}}));
    const pending = mock.config.onPermissionRequest({kind: 'shell', toolCallId: 'call', command: 'pwd'}); await Promise.resolve();
    let request = seen.values.flatMap(v => v.type === 'observation' && v.event.type === 'interaction_requested' ? [v.event.request] : []).at(-1)!;
    // The async iterator can be draining initial runtime updates.
    await new Promise(resolve => setImmediate(resolve));
    request = seen.values.flatMap(v => v.type === 'observation' && v.event.type === 'interaction_requested' ? [v.event.request] : []).at(-1)!;
    await expect(session.respondToInteraction(request.requestId, {kind: 'tool_approval', decision: 'allow', scope: 'session'})).rejects.toThrow();
    await session.respondToInteraction(request.requestId, {kind: 'tool_approval', decision: 'allow', scope: 'once'});
    expect(await pending).toEqual({kind: 'no-result'});
    expect(mock.native.rpc.permissions.handlePendingPermissionRequest).toHaveBeenCalledWith({requestId: 'approval', result: {kind: 'approve-once', approvedInteractively: true}});
    mock.handler(event('user_input.requested', {requestId: 'question', question: 'Choose', choices: ['A', 'B'], allowFreeform: false}));
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
    mock.handler(event('user_input.requested', {requestId: 'stop', question: 'Stop?'}));
    const pending = mock.config.onUserInputRequest({question: 'Stop?'}); const rejected = expect(pending).rejects.toThrow('canceled'); await provider.dispose(); await rejected;
    expect((await resumed.runtimeInfo()).status).toBe('closed');
  }, 10000);
});
it('does not advertise a mutable model setting with an empty native catalog', async () => {
  mock.native.rpc.model.list.mockResolvedValue({list: []}); const {provider, session} = await open();
  expect(session.capabilities.sessionSettings).toBe(false); expect((await session.runtimeInfo()).settings?.[0]).toMatchObject({value: 'model-a', mutable: false});
  await provider.dispose();
}, 10000);
it('interrupts only the main turn and settles its pending callback', async () => {
  const {provider, session} = await open(); mock.handler(event('user_input.requested', {requestId: 'cancel-question', question: 'Question'})); const pending = mock.config.onUserInputRequest({question: 'Question'});
  const rejected = expect(pending).rejects.toThrow('canceled'); await session.cancel(); await rejected;
  expect(mock.native.rpc.interruptMainTurn).toHaveBeenCalledWith({}); expect(mock.native.abort).not.toHaveBeenCalled(); await provider.dispose();
}, 10000);
it('forces owned runtime cleanup when graceful shutdown reports errors', async () => {
  const {provider} = await open(); mock.client.stop.mockResolvedValue([new Error('Shutdown failure')]); await provider.dispose(); expect(mock.client.forceStop).toHaveBeenCalledOnce();
}, 10000);
it('keeps the historical final text when matching deltas and final arrive in the live buffer', async () => {
  const final = event('assistant.message', {messageId: 'final', content: 'Complete answer'});
  mock.native.getEvents.mockImplementation(async () => {
    mock.handler(event('assistant.message_delta', {messageId: 'final', deltaContent: 'Com'})); mock.handler(final); return [final];
  });
  const {provider, session} = await open(); const seen = await collect(session); await provider.dispose(); await seen.done;
  expect(seen.values.flatMap(v => v.type === 'observation' && v.event.type === 'timeline' && v.event.item.type === 'assistant_message' ? [v.event.item.text] : [])).toEqual(['Complete answer']);
}, 10000);
it('preserves final child history against buffered child deltas', async () => {
  mock.native.rpc.tasks.list.mockResolvedValue({tasks: [{type: 'agent', id: 'child', toolCallId: 'spawn', description: 'Child', agentType: 'explore', status: 'idle', startedAt: new Date().toISOString()}]});
  const final = event('assistant.message', {messageId: 'cf', content: 'Complete child answer'}, {agentId: 'child'});
  mock.native.rpc.eventLog.read.mockImplementation(async () => {
    mock.handler(event('assistant.message_delta', {messageId: 'cf', deltaContent: 'Com'}, {agentId: 'child'})); mock.handler(final);
    return {events: [final], cursor: 'end', hasMore: false};
  });
  const {provider, session} = await open(); const child = await session.openChildSession('child'); const seen = await collect(child); await provider.dispose(); await seen.done;
  expect(seen.values.flatMap(v => v.type === 'observation' && v.event.type === 'timeline' && v.event.item.type === 'assistant_message' ? [v.event.item.text] : [])).toEqual(['Complete child answer']);
}, 10000);
it('cancels root approvals without retiring child approvals when SDK callback session IDs are identical', async () => {
  const {provider, session} = await open(); const seen = await collect(session); const id = (await session.runtimeInfo()).sessionId;
  for (const [requestId, agentId] of [['root-approval', undefined], ['child-approval', 'child']]) {
    const request = {kind: 'shell', command: 'pwd'};
    mock.handler(event('permission.requested', {requestId, permissionRequest: request}, {agentId}));
    expect(await mock.config.onPermissionRequest(request, {sessionId: id})).toEqual({kind: 'no-result'});
  }
  await session.cancel();
  await expect(session.respondToInteraction('root-approval', {kind: 'tool_approval', decision: 'allow', scope: 'once'})).rejects.toThrow('Unknown');
  await session.respondToInteraction('child-approval', {kind: 'tool_approval', decision: 'allow', scope: 'once'});
  await provider.dispose(); await seen.done;
  const retired = seen.values.flatMap(v => v.type === 'observation' && v.event.type === 'interaction_resolved' ? [v.event] : []);
  expect(retired.map(v => [v.requestId, v.response])).toEqual([['root-approval', {kind: 'tool_approval', decision: 'cancel'}], ['child-approval', {kind: 'tool_approval', decision: 'allow', scope: 'once'}]]);
}, 10000);
it('retires public prompts on native completion including child task cancellation', async () => {
  const {provider, session} = await open(); const seen = await collect(session);
  mock.handler(event('permission.requested', {requestId: 'child-permission', permissionRequest: {kind: 'shell'}}, {agentId: 'child'}));
  mock.handler(event('permission.completed', {requestId: 'child-permission', result: {kind: 'user-not-available'}}, {agentId: 'child'}));
  mock.handler(event('user_input.requested', {requestId: 'child-question', question: 'Child?'} , {agentId: 'child'}));
  const answer = mock.config.onUserInputRequest({question: 'Child?'}); const rejected = expect(answer).rejects.toThrow('canceled');
  mock.handler(event('user_input.completed', {requestId: 'child-question'}, {agentId: 'child'})); await rejected;
  await provider.dispose(); await seen.done;
  expect(seen.values.filter(v => v.type === 'observation' && v.event.type === 'interaction_requested')).toHaveLength(2);
  expect(seen.values.filter(v => v.type === 'observation' && v.event.type === 'interaction_resolved')).toHaveLength(2);
}, 10000);
it('rejects ambiguous identical question callbacks visibly instead of guessing native ownership', async () => {
  const {provider, session} = await open(); const seen = await collect(session);
  mock.handler(event('user_input.requested', {requestId: 'q-root', question: 'Same?'}));
  mock.handler(event('user_input.requested', {requestId: 'q-child', question: 'Same?'}, {agentId: 'child'}));
  await expect(mock.config.onUserInputRequest({question: 'Same?'})).rejects.toThrow('no unique native request identity');
  await provider.dispose(); await seen.done;
  expect(seen.values.filter(v => v.type === 'observation' && v.event.type === 'interaction_resolved')).toHaveLength(2);
  expect(seen.values.some(v => v.type === 'observation' && v.event.type === 'timeline' && v.event.item.type === 'error')).toBe(true);
}, 10000);
it('correlates different simultaneous questions by unique native payload and preserves child on root cancel', async () => {
  const {provider, session} = await open();
  mock.handler(event('user_input.requested', {requestId: 'q-root', question: 'Root?'}));
  mock.handler(event('user_input.requested', {requestId: 'q-child', question: 'Child?'}, {agentId: 'child'}));
  const root = mock.config.onUserInputRequest({question: 'Root?'}); const rootRejected = expect(root).rejects.toThrow('canceled');
  const child = mock.config.onUserInputRequest({question: 'Child?'});
  await session.cancel(); await rootRejected;
  await session.respondToInteraction('q-child', {kind: 'question', answers: [{questionId: 'answer', selectedValues: [], customText: 'Child answer'}]});
  expect(await child).toEqual({answer: 'Child answer', wasFreeform: true}); await provider.dispose();
}, 10000);
it('disconnects a late native open after its deadline instead of retaining an orphan', async () => {
  let finish!: (native: unknown) => void;
  mock.client.createSession.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
  const provider = new CopilotAgentProvider({executable: '/test/copilot', requestTimeoutMs: 10});
  await expect(provider.createSession({sessionId: 'public', cwd: process.cwd()})).rejects.toThrow('timed out');
  finish(mock.native); await new Promise(resolve => setImmediate(resolve));
  expect(mock.native.disconnect).toHaveBeenCalledOnce(); expect(mock.native.on).not.toHaveBeenCalled(); await provider.dispose();
}, 10000);
it('completes one foreground turn after multi-step question work reaches assistant idle', async () => {
  const {provider, session} = await open(); const seen = await collect(session);
  mock.handler(event('assistant.turn_start', {turnId: '0'}));
  mock.handler(event('assistant.message', {messageId: 'm1', content: 'Checking'}));
  mock.handler(event('tool.execution_start', {toolCallId: 'ask', toolName: 'ask_user'}));
  mock.handler(event('assistant.turn_end', {turnId: '0'}));
  mock.handler(event('assistant.turn_start', {turnId: '1'}));
  mock.handler(event('assistant.message', {messageId: 'm2', content: 'Final answer'}));
  mock.handler(event('assistant.turn_end', {turnId: '1'}));
  await new Promise(resolve => setImmediate(resolve));
  expect(seen.values.some(v => v.type === 'observation' && v.event.type === 'turn_completed')).toBe(false);
  mock.handler(event('assistant.idle', {})); await provider.dispose(); await seen.done;
  const events = seen.values.flatMap(v => v.type === 'observation' ? [v.event] : []);
  expect(events.filter(e => e.type === 'turn_started')).toHaveLength(1); expect(events.filter(e => e.type === 'turn_completed')).toHaveLength(1);
  expect((events.find(e => e.type === 'turn_started') as any).turnId).toBe((events.find(e => e.type === 'turn_completed') as any).turnId);
}, 10000);
it('keeps an active child history turn open and completes repeated rounds from native task idle snapshots', async () => {
  const task = {type: 'agent', id: 'child', toolCallId: 'spawn', description: 'Child', agentType: 'explore', status: 'running', startedAt: new Date().toISOString()};
  mock.native.rpc.tasks.list.mockImplementation(async () => ({tasks: [{...task}]}));
  const history = [event('user.message', {content: 'First'}, {agentId: 'child'}), event('assistant.turn_start', {turnId: '0'}, {agentId: 'child'}), event('assistant.turn_end', {turnId: '0'}, {agentId: 'child'})];
  mock.native.rpc.eventLog.read.mockResolvedValue({events: history, cursor: 'end', hasMore: false});
  const {provider, session} = await open(); const child = await session.openChildSession('child'); const seen = await collect(child);
  await new Promise(resolve => setImmediate(resolve));
  expect(seen.values.some(v => v.type === 'observation' && v.event.type === 'turn_completed')).toBe(false);
  mock.handler(event('assistant.turn_start', {turnId: '1'}, {agentId: 'child'}));
  mock.handler(event('assistant.message', {messageId: 'c1', content: 'First final'}, {agentId: 'child'}));
  task.status = 'idle'; await session.refreshChildren();
  await child.sendMessage('Second'); task.status = 'running';
  mock.handler(event('assistant.turn_start', {turnId: '0'}, {agentId: 'child'}));
  mock.handler(event('assistant.turn_end', {turnId: '0'}, {agentId: 'child'}));
  mock.handler(event('assistant.message', {messageId: 'c2', content: 'Second final'}, {agentId: 'child'}));
  task.status = 'idle'; await session.refreshChildren(); await session.refreshChildren();
  await provider.dispose(); await seen.done;
  const lifecycle = seen.values.flatMap(v => v.type === 'observation' && ['turn_started', 'turn_completed'].includes(v.event.type) ? [v.event as any] : []);
  expect(lifecycle.map(e => e.type)).toEqual(['turn_started', 'turn_completed', 'turn_started', 'turn_completed']);
  expect(lifecycle[0].turnId).toBe(lifecycle[1].turnId); expect(lifecycle[2].turnId).toBe(lifecycle[3].turnId); expect(lifecycle[0].turnId).not.toBe(lifecycle[2].turnId);
}, 10000);
it('keeps an active root history turn continuous through buffered next step and live idle', async () => {
  const history = [event('user.message', {content: 'Work'}), event('assistant.turn_start', {turnId: '0'}), event('assistant.turn_end', {turnId: '0'})];
  mock.native.getEvents.mockImplementation(async () => {mock.handler(event('assistant.turn_start', {turnId: '1'})); return history;});
  mock.native.rpc.metadata.isProcessing.mockResolvedValue({processing: true});
  const {provider, session} = await open(); const seen = await collect(session); await new Promise(resolve => setImmediate(resolve));
  expect(seen.values.some(v => v.type === 'observation' && v.event.type === 'turn_completed')).toBe(false);
  mock.handler(event('assistant.message', {messageId: 'root-final', content: 'Final answer'})); mock.handler(event('assistant.turn_end', {turnId: '1'})); mock.handler(event('assistant.idle', {}));
  await provider.dispose(); await seen.done;
  const lifecycle = seen.values.flatMap(v => v.type === 'observation' && ['turn_started', 'turn_completed'].includes(v.event.type) ? [v.event as any] : []);
  expect(lifecycle.map(e => e.type)).toEqual(['turn_started', 'turn_completed']); expect(lifecycle[0].turnId).toBe(lifecycle[1].turnId);
}, 10000);
it('applies a native idle snapshot received while child history is still loading', async () => {
  const task = {type: 'agent', id: 'child', toolCallId: 'spawn', description: 'Child', agentType: 'explore', status: 'running', startedAt: new Date().toISOString()};
  mock.native.rpc.tasks.list.mockImplementation(async () => ({tasks: [{...task}]}));
  let finish!: (page: unknown) => void; let reading!: () => void;
  const started = new Promise<void>(resolve => {reading = resolve;});
  mock.native.rpc.eventLog.read.mockImplementation(() => new Promise(resolve => {finish = resolve; reading();}));
  const {provider, session} = await open(); const opening = session.openChildSession('child'); await started;
  task.status = 'idle'; await session.refreshChildren();
  finish({events: [event('user.message', {content: 'Child'}, {agentId: 'child'}), event('assistant.turn_start', {turnId: '0'}, {agentId: 'child'}), event('assistant.turn_end', {turnId: '0'}, {agentId: 'child'})], cursor: 'end', hasMore: false});
  const child = await opening; const seen = await collect(child); await provider.dispose(); await seen.done;
  expect(seen.values.flatMap(v => v.type === 'observation' && ['turn_started', 'turn_completed'].includes(v.event.type) ? [v.event.type] : [])).toEqual(['turn_started', 'turn_completed']);
  const completion = seen.values.findIndex(v => v.type === 'observation' && v.event.type === 'turn_completed');
  expect(completion).toBeGreaterThan(seen.values.findIndex(v => v.type === 'history_boundary'));
}, 10000);
it('derives an untagged child permission owner from native tool identity and sends a user approval decision', async () => {
  const {provider, session} = await open(); const seen = await collect(session);
  mock.handler(event('tool.execution_start', {toolCallId: 'root-tool', toolName: 'bash'}));
  mock.handler(event('tool.execution_start', {toolCallId: 'child-tool', toolName: 'bash'}, {agentId: 'child'}));
  mock.handler(event('permission.requested', {requestId: 'root-permission', permissionRequest: {kind: 'shell', toolCallId: 'root-tool'}, promptRequest: {kind: 'commands', toolCallId: 'root-tool'}}));
  mock.handler(event('permission.requested', {requestId: 'child-permission', permissionRequest: {kind: 'shell', toolCallId: 'child-tool'}, promptRequest: {kind: 'commands', toolCallId: 'child-tool'}}));
  await session.cancel();
  await session.respondToInteraction('child-permission', {kind: 'tool_approval', decision: 'allow', scope: 'once'});
  expect(mock.native.rpc.permissions.handlePendingPermissionRequest).toHaveBeenCalledWith({requestId: 'child-permission', result: {kind: 'approve-once', approvedInteractively: true}});
  await provider.dispose(); await seen.done;
  const retired = seen.values.flatMap(v => v.type === 'observation' && v.event.type === 'interaction_resolved' ? [v.event] : []);
  expect(retired.map(e => [e.requestId, e.response])).toEqual([['root-permission', {kind: 'tool_approval', decision: 'cancel'}], ['child-permission', {kind: 'tool_approval', decision: 'allow', scope: 'once'}]]);
}, 10000);
it('applies a stable native idle snapshot after buffered final text, not before it', async () => {
  const history = [event('user.message', {content: 'Work'}), event('assistant.turn_start', {turnId: '0'}), event('assistant.turn_end', {turnId: '0'})];
  mock.native.getEvents.mockImplementation(async () => {
    mock.handler(event('assistant.turn_start', {turnId: '1'}));
    mock.handler(event('assistant.message', {messageId: 'buffered-final', content: 'Buffered final answer'}));
    mock.handler(event('assistant.turn_end', {turnId: '1'})); return history;
  });
  mock.native.rpc.metadata.isProcessing.mockResolvedValue({processing: false});
  const {provider, session} = await open(); const seen = await collect(session); await provider.dispose(); await seen.done;
  const completion = seen.values.findIndex(v => v.type === 'observation' && v.event.type === 'turn_completed');
  const final = seen.values.findIndex(v => v.type === 'observation' && v.event.type === 'timeline' && v.event.item.type === 'assistant_message');
  expect(completion).toBeGreaterThan(final);
  expect(seen.values.filter(v => v.type === 'observation' && v.event.type === 'turn_started')).toHaveLength(1);
  expect(seen.values.filter(v => v.type === 'observation' && v.event.type === 'turn_completed')).toHaveLength(1);
}, 10000);
it('preserves native deny and location approval receipts when completion wins the RPC response race', async () => {
  const {provider, session} = await open(); const seen = await collect(session);
  mock.handler(event('permission.requested', {requestId: 'deny', permissionRequest: {kind: 'shell'}}));
  mock.native.rpc.permissions.handlePendingPermissionRequest.mockImplementation(async () => {
    mock.handler(event('permission.completed', {requestId: 'deny', result: {kind: 'denied-interactively-by-user'}})); return {success: true};
  });
  await session.respondToInteraction('deny', {kind: 'tool_approval', decision: 'deny'});
  expect(mock.native.rpc.permissions.handlePendingPermissionRequest).toHaveBeenCalledWith({requestId: 'deny', result: {kind: 'reject'}});
  mock.handler(event('permission.requested', {requestId: 'location', permissionRequest: {kind: 'shell'}}));
  mock.handler(event('permission.completed', {requestId: 'location', result: {kind: 'approved-for-location'}}));
  await provider.dispose(); await seen.done;
  const receipts = seen.values.flatMap(v => v.type === 'observation' && v.event.type === 'interaction_resolved' ? [v.event.response] : []);
  expect(receipts).toEqual([{kind: 'tool_approval', decision: 'deny'}, {kind: 'tool_approval', decision: 'allow', scope: 'once'}]);
}, 10000);
