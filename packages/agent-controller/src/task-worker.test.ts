import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSessionTool } from '@orchardworks/agent-provider-sdk';
import { parseTaskInputs, type TeamHostCall } from '@orchardworks/agent-remote-protocol';
import { supportHarness } from './test-utils/call-for-support-harness.js';
import { WorkerSupport } from './call-for-support-worker.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
async function harness(toolNamespaces = false) { const h = await supportHarness({ tasks: true, toolNamespaces }); cleanups.push(() => h.close()); return h; }
const owner = { providerId: 'codex', nativeSessionId: 'worker', title: 'Chief' };
const createTask = { action: 'create_task' as const, owner, operationId: 'op', title: 'Collect logs', brief: 'Collect the build logs of the last run.' };
const tool = (tools: readonly AgentSessionTool[] | undefined, name: string) => tools?.find(item => item.name === name) ?? (() => { throw new Error(`No ${name} tool.`); })();

describe('a task between a main session and its worker', () => {
  it('starts the worker where the owner works, with only its task tools, and delivers the framed brief', async () => {
    const h = await harness();
    expect(await h.host(createTask)).toMatchObject({ state: 'working' });
    expect(h.created).toHaveLength(1);
    const worker = h.created[0]!;
    expect(worker.creation.cwd).toBe(h.directory);
    expect(worker.extensions.tools?.map(item => item.name)).toEqual(['read_source_session', 'report_task', 'ask_owner']);
    expect(worker.extensions.instructions).toContain('worker of task');
    await h.runtime.tick();
    expect(h.sessions.get(worker.id)!.deliveries).toEqual([{ text: expect.stringMatching(/^\[Task \S+ · brief · from Chief\]\nTask: Collect logs\n/), delivery: 'immediate' }]);
    // The owner keeps its own tools: its seat in the task carries none.
    expect(await h.runtime.extensions(h.ref('codex', 'worker'))).toBeUndefined();
  });

  it('holds the result until the owner is idle, outside the CLI\'s own queue, then forgets the finished task\'s seats', async () => {
    const h = await harness();
    await h.host(createTask);
    const worker = h.created[0]!;
    await h.runtime.tick();
    h.busy('worker', true);
    expect(JSON.parse(await tool(worker.extensions.tools, 'report_task').execute({ status: 'done', summary: 'The logs are in /tmp/logs.' }) as string)).toMatchObject({ state: 'done' });
    await h.runtime.tick();
    // The owner's provider has a native next-turn queue; a task result still waits for the turn to end.
    expect(h.sessions.get('worker')!.deliveries).toEqual([]);
    // The worker reported and its brief settled: its seat is forgotten and its session becomes an ordinary one.
    expect(await h.runtime.extensions(h.ref('codex', worker.id))).toBeUndefined();
    h.busy('worker', false);
    await h.runtime.tick();
    const result = [{ text: expect.stringMatching(/^\[Task \S+ · done · Collect logs\]\nThe logs are in \/tmp\/logs\.\n/), delivery: 'immediate' }];
    expect(h.sessions.get('worker')!.deliveries).toEqual(result);
    // Later polls neither deliver the result again nor keep the owner's seat.
    await h.runtime.tick(); await h.runtime.tick();
    expect(h.sessions.get('worker')!.deliveries).toEqual(result);
  });

  it('gives the worker its tools as a namespace where the provider takes one, so reporting needs no approval', async () => {
    const h = await harness(true);
    await h.host(createTask);
    const { extensions } = h.created[0]!;
    expect(extensions.tools).toBeUndefined();
    expect(extensions.toolNamespaces?.map(namespace => [namespace.name, namespace.tools.map(item => item.name)])).toEqual([['agent_remote_task', ['read_source_session', 'report_task', 'ask_owner']]]);
    expect(JSON.parse(await tool(extensions.toolNamespaces![0]!.tools, 'report_task').execute({ status: 'failed', summary: 'The runner is offline.' }) as string)).toMatchObject({ state: 'failed' });
  });

  it('delivers the results of several tasks that finished during one turn as one input', async () => {
    const h = await harness();
    await h.host(createTask);
    await h.host({ ...createTask, operationId: 'op-2', title: 'Run tests', brief: 'Run the unit tests.' });
    const [logs, tests] = h.created;
    await h.runtime.tick();
    h.busy('worker', true);
    await tool(tests!.extensions.tools, 'report_task').execute({ status: 'failed', summary: 'Two tests fail.' });
    await tool(logs!.extensions.tools, 'report_task').execute({ status: 'done', summary: 'Logs attached.' });
    await h.runtime.tick();
    expect(h.sessions.get('worker')!.deliveries).toEqual([]);
    h.busy('worker', false);
    await h.runtime.tick();
    const deliveries = h.sessions.get('worker')!.deliveries;
    expect(deliveries).toHaveLength(1);
    const results = parseTaskInputs(deliveries[0]!.text)?.map(input => [input.kind, input.kind === 'brief' || input.kind === 'message' ? '' : input.title]);
    expect(results).toHaveLength(2);
    expect(results).toEqual(expect.arrayContaining([['failed', 'Run tests'], ['done', 'Collect logs']]));
    await h.runtime.tick(); await h.runtime.tick();
    expect(h.sessions.get('worker')!.deliveries).toHaveLength(1);
  });

  it('tells the owner of a pending interaction in the worker and of a question it asks, and delivers the answer', async () => {
    const h = await harness();
    const { taskId } = await h.host(createTask);
    const worker = h.created[0]!;
    await h.runtime.tick();
    h.busy(worker.id, true); h.interaction(worker.id, 'Run npm test?');
    await h.runtime.tick();
    expect(h.team(taskId).task).toMatchObject({ state: 'needs_input', waiting: { reason: 'interaction', text: 'Run npm test? npm test' } });
    h.interaction(worker.id);
    await h.runtime.tick();
    expect(h.team(taskId).task?.state).toBe('working');
    await tool(worker.extensions.tools, 'ask_owner').execute({ question: 'Which branch?' });
    h.busy(worker.id, false);
    await h.runtime.tick();
    const inputs = h.sessions.get('worker')!.deliveries.flatMap(delivery => parseTaskInputs(delivery.text) ?? []);
    expect(inputs.map(input => input.kind)).toEqual(['needs_you', 'question']);
    const owner = new WorkerSupport({ request: call => h.host(call), available: () => true, tasks: () => true, stateDirectory: h.directory, title: async () => 'Chief' });
    await tool(owner.namespace(() => h.ref('codex', 'worker'), false).tools, 'message_task').execute({ taskId, text: 'Use main.' });
    await h.runtime.tick();
    expect(h.sessions.get(worker.id)!.deliveries.map(delivery => parseTaskInputs(delivery.text)?.[0]?.kind)).toEqual(['brief', 'message']);
    expect(h.team(taskId).task?.state).toBe('working');
  });

  it('tells the owner what the person typed to the worker, and not the inputs the Relay sent it', async () => {
    const h = await harness();
    const { taskId } = await h.host(createTask);
    const worker = h.created[0]!;
    await h.runtime.tick();
    h.userMessage(worker.id, h.sessions.get(worker.id)!.deliveries[0]!.text, 'brief');
    h.userMessage(worker.id, 'Skip the old logs.', 'u1');
    await new Promise(resolve => setTimeout(resolve, 20));
    await h.runtime.tick();
    const told = h.sessions.get('worker')!.deliveries.flatMap(delivery => parseTaskInputs(delivery.text) ?? []);
    expect(told).toEqual([expect.objectContaining({ kind: 'told', taskId, body: 'Skip the old logs.' })]);
  });

  it('stops a cancelled task\'s running worker turn and lets its runtime go', async () => {
    const h = await harness();
    const { taskId } = await h.host(createTask);
    const worker = h.created[0]!;
    await h.runtime.tick();
    h.busy(worker.id, true);
    await h.runtime.tick();
    const owner = new WorkerSupport({ request: call => h.host(call), available: () => true, tasks: () => true, stateDirectory: h.directory, title: async () => 'Chief' });
    expect(JSON.parse(await tool(owner.namespace(() => h.ref('codex', 'worker'), false).tools, 'cancel_task').execute({ taskId }) as string)).toEqual({ taskId, state: 'cancelled' });
    await h.runtime.tick();
    expect(h.cancelled).toEqual([worker.id]);
    expect(h.released).toContain(worker.id);
  });

  it('starts a read-only worker that may not write, and a worktree worker whose report carries its patch', async () => {
    const h = await harness();
    await h.host({ ...createTask, operationId: 'read', workspace: 'read_only' });
    expect(h.created[0]!.extensions).toMatchObject({ access: 'read_only' });
    expect(h.created[0]!.extensions.instructions).toContain('read-only');
    const { taskId } = await h.host({ ...createTask, operationId: 'tree', title: 'Edit', workspace: 'worktree', commit: h.commit });
    const worker = h.created[1]!;
    expect(worker.creation.cwd).not.toBe(h.directory);
    await writeFile(join(worker.creation.cwd!, 'a.txt'), 'two\n');
    await tool(worker.extensions.tools, 'report_task').execute({ status: 'done', summary: 'Changed a.txt.' });
    const summary = h.team(taskId).task!.result!.summary, path = /apply with git apply\): (\S+)$/.exec(summary)?.[1];
    expect(summary).toMatch(/^Changed a\.txt\.\n\nPatch/);
    expect(await readFile(path!, 'utf8')).toContain('+two');
    // Once the result is delivered and the task forgotten, its worktree goes.
    await h.runtime.tick(); await h.runtime.tick();
    expect(await stat(worker.creation.cwd!).then(() => true, () => false)).toBe(false);
  });

  it('reports one task listing to the owner', async () => {
    const h = await harness();
    const { taskId } = await h.host(createTask);
    expect(await h.host({ action: 'task_status', owner: { providerId: 'codex', nativeSessionId: 'worker' } })).toEqual({ tasks: [expect.objectContaining({ taskId, state: 'working', title: 'Collect logs' })] });
  });
});

describe('the main session\'s task tools', () => {
  async function support(tasks: boolean) {
    const directory = await mkdtemp(join(tmpdir(), 'task-tools-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const calls: TeamHostCall[] = [];
    const worker = new WorkerSupport({ request: async call => { calls.push(call); return { ok: true }; }, available: () => true, tasks: () => tasks, stateDirectory: directory,
      title: async () => 'Chief' });
    return { worker, calls };
  }
  const ref = { controllerId: 'controller', providerId: 'codex', nativeSessionId: 'main' };
  it('offers every session the namespace while the Relay runs tasks, and starts a task as the session', async () => {
    const { worker, calls } = await support(true);
    expect(worker.enabled(ref)).toBe(true);
    expect(worker.enabledByDefault()).toBe(true);
    const tools = worker.namespace(() => ref, false).tools;
    expect(tools.map(item => item.name).filter(name => name.includes('task') || name.includes('assistant'))).toEqual(['create_task', 'task_status', 'list_assistants', 'message_assistant', 'message_task', 'cancel_task', 'mark_task_done']);
    await tool(tools, 'create_task').execute({ title: 'Collect logs', brief: 'Collect them.', done_when: 'Attached.', operationId: 'op' });
    expect(calls).toEqual([{ action: 'create_task', owner: { providerId: 'codex', nativeSessionId: 'main', title: 'Chief' }, operationId: 'op', title: 'Collect logs', brief: 'Collect them.', doneWhen: 'Attached.' }]);
    await tool(tools, 'task_status').execute({});
    expect(calls[1]).toEqual({ action: 'task_status', owner: { providerId: 'codex', nativeSessionId: 'main' } });
    // A provider that cannot keep a session read-only is refused before anything is asked of the Relay.
    await expect(tool(tools, 'create_task').execute({ title: 'T', brief: 'B', workspace: 'read_only' })).rejects.toThrow('cannot work read-only');
    expect(calls).toHaveLength(2);
  });
  it('keeps the tools declared but refuses them while the Relay does not run tasks', async () => {
    const { worker, calls } = await support(false);
    expect(worker.enabled(ref)).toBe(false);
    await expect(tool(worker.namespace(() => ref, true).tools, 'create_task').execute({ title: 'T', brief: 'B' })).rejects.toThrow('Update the Relay to use tasks.');
    expect(calls).toEqual([]);
  });
});

describe('messages between assistants', () => {
  const groups = [{ window: { id: 'g', title: 'g', revision: 1, views: [['v1', 'worker'], ['v2', 'tracker']].map(([id, nativeSessionId]) => ({ id, placement: 'primary',
    binding: { hostId: 'host', providerId: 'codex', nativeSessionId, title: nativeSessionId } })) }, bots: { rank: 'm', members: { v1: { name: 'Chief' }, v2: { name: 'Tracker' } } } }] as never;
  it('reaches the other main session between its turns, after its task updates, and the reply comes back', async () => {
    const h = await supportHarness({ tasks: true, groups, sessions: ['tracker'] });
    cleanups.push(() => h.close());
    const chief = new WorkerSupport({ request: call => h.host(call), available: () => true, tasks: () => true, stateDirectory: h.directory, title: async () => 'Chief' });
    const tracker = new WorkerSupport({ request: call => h.host(call), available: () => true, tasks: () => true, stateDirectory: h.directory, title: async () => 'Tracker' });
    const tools = (worker: WorkerSupport, id: string) => worker.namespace(() => h.ref('codex', id), false).tools;
    expect(JSON.parse(await tool(tools(chief, 'worker'), 'list_assistants').execute({}) as string)).toEqual({ assistants: [{ id: 'g/v2', name: 'Tracker' }] });
    h.busy('tracker', true);
    const sent = JSON.parse(await tool(tools(chief, 'worker'), 'message_assistant').execute({ to: 'Tracker', text: 'Is the branch cut?' }) as string);
    expect(sent).toMatchObject({ outcome: 'delivered' });
    await h.runtime.tick();
    // A message never steers or queues into a running turn.
    expect(h.sessions.get('tracker')!.deliveries).toEqual([]);
    h.busy('tracker', false);
    await h.runtime.tick();
    expect(h.sessions.get('tracker')!.deliveries.map(delivery => [delivery.delivery, parseTaskInputs(delivery.text)])).toEqual([['immediate', [{ kind: 'assistant', messageId: sent.messageId, from: 'Chief', body: 'Is the branch cut?' }]]]);
    await tool(tools(tracker, 'tracker'), 'message_assistant').execute({ to: 'Chief', text: 'Yes.', reply_to: sent.messageId });
    await h.runtime.tick();
    expect(parseTaskInputs(h.sessions.get('worker')!.deliveries[0]!.text)).toEqual([expect.objectContaining({ kind: 'assistant', from: 'Tracker', replyTo: sent.messageId, body: 'Yes.' })]);
    // The main sessions keep their own tools.
    expect(await h.runtime.extensions(h.ref('codex', 'tracker'))).toBeUndefined();
  });
});
