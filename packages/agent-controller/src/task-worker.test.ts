import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSessionTool } from '@orchardworks/agent-provider-sdk';
import type { TeamHostCall } from '@orchardworks/agent-remote-protocol';
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
    expect(worker.extensions.tools?.map(item => item.name)).toEqual(['read_source_session', 'report_task']);
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
    expect(extensions.toolNamespaces?.map(namespace => [namespace.name, namespace.tools.map(item => item.name)])).toEqual([['agent_remote_task', ['read_source_session', 'report_task']]]);
    expect(JSON.parse(await tool(extensions.toolNamespaces![0]!.tools, 'report_task').execute({ status: 'failed', summary: 'The runner is offline.' }) as string)).toMatchObject({ state: 'failed' });
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
    await tool(tools, 'create_task').execute({ title: 'Collect logs', brief: 'Collect them.', done_when: 'Attached.', operationId: 'op' });
    expect(calls).toEqual([{ action: 'create_task', owner: { providerId: 'codex', nativeSessionId: 'main', title: 'Chief' }, operationId: 'op', title: 'Collect logs', brief: 'Collect them.', doneWhen: 'Attached.' }]);
    await tool(tools, 'task_status').execute({});
    expect(calls[1]).toEqual({ action: 'task_status', owner: { providerId: 'codex', nativeSessionId: 'main' } });
  });
  it('keeps the tools declared but refuses them while the Relay does not run tasks', async () => {
    const { worker, calls } = await support(false);
    expect(worker.enabled(ref)).toBe(false);
    await expect(tool(worker.namespace(() => ref, true).tools, 'create_task').execute({ title: 'T', brief: 'B' })).rejects.toThrow('Update the Relay to use tasks.');
    expect(calls).toEqual([]);
  });
});
