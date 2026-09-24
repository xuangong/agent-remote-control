import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
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
  mock.client = {rpc: {sessions: {checkInUse: vi.fn(async () => ({inUse: []})), close: vi.fn(async () => ({}))}, skills: {getDiscoveryPaths: vi.fn(async () => ({paths: [{path: '/native/project/skills'}]}))}}, start: vi.fn(async () => {}), stop: vi.fn(async () => []), forceStop: vi.fn(async () => {}), createSession: vi.fn(async (config: unknown) => {mock.config = config; return mock.native;}), resumeSession: vi.fn(async (_id: string, config: unknown) => {mock.config = config; return mock.native;}), getSessionMetadata: vi.fn(async () => undefined), listSessions: vi.fn(async () => [])};
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
it('reads only current regular bounded skill documents without following final symlinks', async () => {
 const {mkdtemp, writeFile, symlink, rm} = await import('node:fs/promises');
 const {tmpdir} = await import('node:os'); const {join} = await import('node:path');
 const home = await mkdtemp(join(tmpdir(), 'copilot-resource-'));
 const {provider, session} = await open();
 const path = join(home, 'SKILL.md');
 const skill = {name: 'native', description: 'Native skill', userInvocable: true, enabled: true, path};
 mock.native.rpc.skills.list.mockResolvedValue({skills: [skill]});
 try {
  await writeFile(path, 'Skill body');
  expect(await session.readResource('copilot:skill:native')).toMatchObject({status: 'available', bytes: Buffer.from('Skill body')});
  await writeFile(path, Buffer.alloc(256 * 1024 + 1));
  expect((await session.readResource('copilot:skill:native')).status).toBe('unavailable');
  await rm(path); await symlink(join(home, 'target'), path); await writeFile(join(home, 'target'), 'Secret');
  expect((await session.readResource('copilot:skill:native')).status).toBe('unavailable');
  mock.native.rpc.skills.list.mockResolvedValue({skills: [{...skill, path: home}]});
  expect((await session.readResource('copilot:skill:native')).status).toBe('unavailable');
  mock.native.rpc.skills.list.mockResolvedValue({skills: [{...skill, enabled: false}]});
  expect((await session.readResource('copilot:skill:native')).status).toBe('unavailable');
 } finally { await provider.dispose(); await rm(home, {recursive: true, force: true}); }
}, 10000);

it('rejects busy model changes and does not claim deferred writes are confirmed', async () => {
 const {provider, session} = await open();
 try {
  mock.native.rpc.metadata.isProcessing.mockResolvedValue({processing: true});
  await expect(session.setSessionSetting('model', 'model-b')).rejects.toThrow('idle');
  expect(mock.native.rpc.model.switchTo).not.toHaveBeenCalled();
  mock.native.rpc.metadata.isProcessing.mockResolvedValue({processing: false});
  mock.native.rpc.model.switchTo.mockResolvedValue({deferred: true});
  await expect(session.setSessionSetting('model', 'model-b')).rejects.toThrow('pending');
  expect((await session.runtimeInfo()).model).toBe('model-a');
  mock.native.rpc.model.getCurrent.mockResolvedValue({modelId: 'model-b'});
  mock.handler(event('session.model_change', {newModel: 'model-b'}));
  await vi.waitFor(async () => expect((await session.runtimeInfo()).model).toBe('model-b'), {timeout: 1000});
 } finally { await provider.dispose(); }
}, 10000);


it('does not infer idle activity from persisted Copilot metadata', async () => {
  mock.client.listSessions.mockResolvedValue([{sessionId: 'external', summary: 'Original session', startTime: new Date(1000), modifiedTime: new Date(2000), isRemote: false}]);
  const provider = new CopilotAgentProvider({executable: '/test/copilot'});
  try {
    expect(await provider.listSessions()).toEqual([expect.objectContaining({nativeSessionId: 'external', state: 'unknown'})]);
    expect(mock.client.resumeSession).not.toHaveBeenCalled();
    expect(mock.native.rpc.metadata.isProcessing).not.toHaveBeenCalled();
  } finally { await provider.dispose(); }
});

it('publishes native reasoning effort and applies only supported selections', async () => {
 mock.native.rpc.model.getCurrent.mockResolvedValue({modelId: 'model-a', reasoningEffort: 'medium'});
 mock.native.rpc.model.list.mockResolvedValue({list: [{id: 'model-a', name: 'A', capabilities: {supports: {reasoning_effort: ['low', 'medium', 'high'], vision: true}, limits: {vision: {max_prompt_images: 1, max_prompt_image_size: 3145728, supported_media_types: ['image/png']}}}}]});
 mock.native.rpc.model.setReasoningEffort = vi.fn(async () => {mock.native.rpc.model.getCurrent.mockResolvedValue({modelId: 'model-a', reasoningEffort: 'high'}); return {reasoningEffort: 'high'};});
 const {provider, session} = await open();
 try {
  expect((await session.runtimeInfo()).settings).toContainEqual(expect.objectContaining({id: 'reasoning_effort', value: 'medium', options: [{value: 'low', label: 'low'}, {value: 'medium', label: 'medium'}, {value: 'high', label: 'high'}]}));
  expect(session.capabilities.imageInput).toMatchObject({mediaTypes: ['image/png'], maxImages: 1, maxImageBytes: 3145728});
  await session.setSessionSetting('reasoning_effort', 'high');
  expect((await session.runtimeInfo()).settings).toContainEqual(expect.objectContaining({id: 'reasoning_effort', value: 'high'}));
  await expect(session.setSessionSetting('reasoning_effort', 'extreme')).rejects.toThrow();
 } finally {await provider.dispose();}
}, 10000);
it('publishes native planning mode and completes identity-bound plan approval', async () => {
 let mode = 'plan'; mock.native.rpc.mode = {get: vi.fn(async () => mode), set: vi.fn(async (p: any) => {mode = p.mode;})};
 const {provider, session} = await open(); const seen = await collect(session);
 try {
  expect(session.capabilities.planning).toBe(true); expect((await session.runtimeInfo()).planning).toEqual({active: true});
  await session.setPlanning!(false); expect((await session.runtimeInfo()).planning).toEqual({active: false});
  const data = {requestId: 'plan', summary: 'Plan', planContent: 'Build it', actions: ['exit_only', 'interactive', 'autopilot'], recommendedAction: 'interactive'};
  mock.handler(event('exit_plan_mode.requested', data)); const reply = mock.config.onExitPlanModeRequest(data);
  await new Promise(r => setImmediate(r));
  expect(seen.values).toContainEqual(expect.objectContaining({event: expect.objectContaining({type: 'interaction_requested', request: {kind: 'plan_approval', requestId: 'plan', plan: 'Build it', allowedActions: ['approve', 'approve_and_resume', 'reject']}})}));
  await session.respondToInteraction('plan', {kind: 'plan_approval', action: 'approve_and_resume'});
  expect(await reply).toEqual({approved: true, selectedAction: 'interactive'});
 } finally {await provider.dispose(); await seen.done;}
}, 10000);
it('loads native todos and publishes serialized refreshes including a cleared list', async () => {
 let rows: any[] = [{id: '1', title: 'Implement', status: 'in_progress'}, {id: '2', title: 'Verify', status: 'done'}];
 mock.native.rpc.plan = {readSqlTodos: vi.fn(async () => ({rows}))};
 const {provider, session} = await open(); const seen = await collect(session);
 try {
  await new Promise(r => setImmediate(r));
  expect(seen.values).toContainEqual(expect.objectContaining({event: expect.objectContaining({type: 'timeline', item: {type: 'todo', items: [{id: '1', text: 'Implement', completed: false, status: 'in_progress'}, {id: '2', text: 'Verify', completed: true, status: 'completed'}]}})}));
  rows = []; mock.handler(event('session.todos_changed', {})); await new Promise(r => setImmediate(r));
  expect(seen.values).toContainEqual(expect.objectContaining({event: expect.objectContaining({type: 'timeline', item: {type: 'todo', items: []}})}));
 } finally {await provider.dispose(); await seen.done;}
}, 10000);

it('maps native elicitation to validated forms and external actions', async () => {
 const {provider, session} = await open(); const seen = await collect(session);
 try {
  const payload = {message: 'Preferences', mode: 'form', elicitationSource: 'test-mcp', requestedSchema: {type: 'object', required: ['name'], properties: {name: {type: 'string', minLength: 2}, secret: {type: 'string', writeOnly: true}}}};
  mock.handler(event('elicitation.requested', {requestId: 'form', ...payload}));
  const result = mock.config.onElicitationRequest(payload); await Promise.resolve();
  await expect(session.respondToInteraction('form', {kind: 'form', action: 'submit', values: {name: 'x'}})).rejects.toThrow();
  await session.respondToInteraction('form', {kind: 'form', action: 'submit', values: {name: 'Alice', secret: 'private-value'}});
  expect(await result).toEqual({action: 'accept', content: {name: 'Alice', secret: 'private-value'}});
  const url = {message: 'Sign in', mode: 'url', url: 'https://example.com/auth', elicitationSource: 'test-mcp'};
  mock.handler(event('elicitation.requested', {requestId: 'url', ...url})); const external = mock.config.onElicitationRequest(url); await Promise.resolve();
  await session.respondToInteraction('url', {kind: 'external_action', action: 'completed'}); expect(await external).toEqual({action: 'accept'});
 } finally {await provider.dispose(); await seen.done;}
 expect(JSON.stringify(seen.values)).not.toContain('private-value');
 expect(seen.values.filter(v => v.type === 'observation' && v.event.type === 'interaction_requested')).toHaveLength(2);
}, 10000);

it('keeps completed child approvals in the parent history that owns live interactions', async () => {
 mock.history = [event('permission.requested', {requestId: 'child-r', permissionRequest: {kind: 'shell', toolCallId: 't'}}, {agentId: 'child'}), event('permission.completed', {requestId: 'child-r', result: {kind: 'approved'}}, {agentId: 'child'})];
 const {provider, session} = await open(); const seen = await collect(session); await provider.dispose(); await seen.done;
 expect(seen.values).toContainEqual(expect.objectContaining({delivery: 'history', event: expect.objectContaining({type: 'timeline', item: expect.objectContaining({type: 'interaction', request: expect.objectContaining({requestId: 'child-r'})})})}));
 expect(seen.values.some(v => v.type === 'observation' && v.event.type === 'interaction_requested')).toBe(false);
}, 10000);
it('invalidates canceled plan callbacks without inventing a user rejection', async () => {
 const {provider, session} = await open(); const seen = await collect(session);
 const payload = {summary: 'Plan', planContent: 'Build', actions: ['interactive'], recommendedAction: 'interactive'};
 mock.handler(event('exit_plan_mode.requested', {...payload, requestId: 'plan-cancel'}));
 const reply = mock.config.onExitPlanModeRequest(payload); const rejected = expect(reply).rejects.toThrow('canceled');
 await session.cancel(); await rejected; await provider.dispose(); await seen.done;
 expect(seen.values).toContainEqual(expect.objectContaining({event: {type: 'interaction_invalidated', provider: 'copilot', requestId: 'plan-cancel', reason: expect.any(String)}}));
 expect(seen.values.some(v => v.type === 'observation' && v.event.type === 'interaction_resolved' && v.event.requestId === 'plan-cancel')).toBe(false);
}, 10000);

it('publishes an overlapping completed approval once without leaving a pending prompt', async () => {
 const requested = event('permission.requested', {requestId: 'overlap', permissionRequest: {kind: 'shell'}});
 const completed = event('permission.completed', {requestId: 'overlap', result: {kind: 'approved'}});
 mock.native.getEvents.mockImplementation(async () => {mock.handler(requested); return [requested, completed];});
 const {provider, session} = await open(); const seen = await collect(session);
 expect((await session.runtimeInfo()).status).toBe('idle');
 await provider.dispose(); await seen.done;
 expect(seen.values.filter(v => v.type === 'observation' && v.event.type === 'timeline' && v.event.item.type === 'interaction')).toHaveLength(1);
 expect(seen.values.some(v => v.type === 'observation' && v.event.type.startsWith('interaction_'))).toBe(false);
}, 10000);

it('exposes acknowledged native tool permissions without an unsupported allow-all getter', async () => {
 mock.native.rpc.permissions.setApproveAll = vi.fn(async () => ({success: true}));
 const {provider, session} = await open();
 try {
  expect((await session.runtimeInfo()).settings).toContainEqual(expect.objectContaining({id: 'tool_approval_mode', category: 'permissions', value: 'ask'}));
  mock.native.rpc.metadata.isProcessing.mockResolvedValue({processing: true});
  await session.setSessionSetting('tool_approval_mode', 'allow');
  expect(mock.native.rpc.permissions.setApproveAll).toHaveBeenLastCalledWith({enabled: true});
  expect((await session.runtimeInfo()).settings?.find(s => s.id === 'tool_approval_mode')?.value).toBe('allow');
  mock.handler(event('session.permissions_changed', {allowAllPermissions: false}));
  expect((await session.runtimeInfo()).settings?.find(s => s.id === 'tool_approval_mode')?.value).toBe(null);
 } finally {await provider.dispose();}
}, 10000);
it('does not claim a tool policy after an unconfirmed change', async () => {
 mock.native.rpc.permissions.setApproveAll = vi.fn(async () => ({success: true}));
 const {provider, session} = await open();
 try {
  mock.native.rpc.permissions.setApproveAll.mockRejectedValueOnce(new Error('Permission change timed out'));
  await expect(session.setSessionSetting('tool_approval_mode', 'allow')).rejects.toThrow('timed out');
  expect((await session.runtimeInfo()).settings?.find(s => s.id === 'tool_approval_mode')?.value).toBe(null);
 } finally {await provider.dispose();}
}, 10000);
it('probes restored permission support without resetting or guessing restored policy', async () => {
 mock.native.rpc.permissions.configure = vi.fn(async () => ({success: true}));
 const provider = new CopilotAgentProvider({executable: '/test/copilot'});
 try {
  const session = await provider.resumeSession({providerId: 'copilot', sessionId: 'restored', opaque: JSON.stringify({cwd: process.cwd()})});
  expect(mock.native.rpc.permissions.configure).toHaveBeenCalledWith({});
  expect((await session.runtimeInfo()).settings?.find(s => s.id === 'tool_approval_mode')?.value).toBe(null);
 } finally {await provider.dispose();}
}, 10000);
it('keeps an interactive session-scope decision when native completion arrives before the RPC result', async () => {
 const {provider, session} = await open(); const seen = await collect(session);
 mock.handler(event('permission.requested', {requestId: 'read-session', permissionRequest: {kind: 'read', path: '/workspace/file'}, promptRequest: {kind: 'read', path: '/workspace/file'}}));
 mock.native.rpc.permissions.handlePendingPermissionRequest.mockImplementation(async (params: unknown) => {
  expect(params).toEqual({requestId: 'read-session', result: {kind: 'approve-for-session', approval: {kind: 'read'}}});
  mock.handler(event('permission.completed', {requestId: 'read-session', result: {kind: 'approved'}}));
  return {success: true};
 });
 try { await session.respondToInteraction('read-session', {kind: 'tool_approval', decision: 'allow', scope: 'session'}); }
 finally {await provider.dispose(); await seen.done;}
 const resolved = seen.values.flatMap(v => v.type === 'observation' && v.event.type === 'interaction_resolved' ? [v.event] : []);
 expect(resolved).toHaveLength(1); expect(resolved[0]).toMatchObject({response: {kind: 'tool_approval', decision: 'allow', scope: 'session'}});
}, 10000);

it('refuses to resume a native session held outside the managed Controller', async () => {
  mock.client.rpc.sessions.checkInUse.mockResolvedValue({inUse:['busy']});
  const provider = new CopilotAgentProvider({executable:'/test/copilot'});
  try {
    await expect(provider.resumeSession({providerId:'copilot',sessionId:'busy',opaque:'{}'})).rejects.toThrow('unmanaged native client');
    expect(mock.client.resumeSession).not.toHaveBeenCalled();
  } finally {await provider.dispose();}
});

it('restores the authoritative workspace when opening by native session ID', async () => {
  mock.client.getSessionMetadata.mockResolvedValue({sessionId: 'cold', context: {workingDirectory: process.cwd()}});
  const provider = new CopilotAgentProvider({executable: '/test/copilot'});
  try {
    const session = await provider.resumeSession({providerId: 'copilot', sessionId: 'cold', opaque: '{}'});
    expect(mock.config.workingDirectory).toBe(process.cwd());
    const info = await session.runtimeInfo();
    expect(info.cwd).toBe(process.cwd());
    expect(JSON.parse(info.persistence!.opaque).cwd).toBe(process.cwd());
    expect(mock.client.listSessions).not.toHaveBeenCalled();
  } finally { await provider.dispose(); }
}, 10000);

it('preserves an existing persistence workspace when metadata is unavailable', async () => {
  const provider = new CopilotAgentProvider({executable: '/test/copilot'});
  try {
    const session = await provider.resumeSession({providerId: 'copilot', sessionId: 'saved', opaque: JSON.stringify({cwd: process.cwd()})});
    expect((await session.runtimeInfo()).cwd).toBe(process.cwd());
    expect(mock.client.getSessionMetadata).not.toHaveBeenCalled();
  } finally {await provider.dispose();}
}, 10000);
it('does not open a cold native session using the Controller process directory when metadata is missing', async () => {
  const provider = new CopilotAgentProvider({executable: '/test/copilot'});
  try {
    await expect(provider.resumeSession({providerId: 'copilot', sessionId: 'missing', opaque: '{}'})).rejects.toThrow(/workspace/);
    mock.client.getSessionMetadata.mockRejectedValueOnce(new Error('Metadata unavailable'));
    await expect(provider.resumeSession({providerId: 'copilot', sessionId: 'unreadable', opaque: '{}'})).rejects.toThrow('Metadata unavailable');
    expect(mock.client.resumeSession).not.toHaveBeenCalled();
    expect(mock.client.createSession).not.toHaveBeenCalled();
  } finally {await provider.dispose();}
}, 10000);

it('reads an opened workspace before native metadata has been persisted', async () => {
  const {provider, session} = await open();
  try {
    const info = await session.runtimeInfo();
    expect(await provider.sessionWorkspace(info.sessionId!)).toBe(info.cwd);
    expect(mock.client.getSessionMetadata).not.toHaveBeenCalled();
  } finally {await provider.dispose();}
}, 10000);
