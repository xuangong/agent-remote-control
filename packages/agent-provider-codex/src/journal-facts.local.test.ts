import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { call, message, patch, pause, reasoning, shell, startResponsesFixture, stalled, type ResponsesFixture, type ResponsesScript, type ResponsesFixtureOptions } from './test-utils/native-responses-fixture.js';
import { RawAppServer, type RawMessage } from './test-utils/raw-app-server.js';
import { CodexEventProjector } from './projector.js';

const executable = process.env.BORGEE_CODEX_TEST_EXECUTABLE ?? 'codex';
const DUMP = process.env.JOURNAL_FACTS_DUMP;
/** Set JOURNAL_FACTS_DUMP to a directory to keep every scenario's raw notifications and history pages for reading. */
const dump = (name: string, value: unknown) => { if (DUMP) { mkdirSync(DUMP, { recursive: true }); writeFileSync(join(DUMP, `${name}.json`), JSON.stringify(value, null, 1)); } };

async function scenario<T>(script: ResponsesScript, options: ResponsesFixtureOptions, run: (server: RawAppServer, f: ResponsesFixture, threadId: string) => Promise<T>, onRequest?: (m: any) => unknown, startParams: object = {}): Promise<T> {
  const f = await startResponsesFixture(script, options);
  const server = new RawAppServer(executable, f.cwd, f.env, onRequest);
  try {
    await server.initialize();
    const started = await server.request('thread/start', { cwd: f.cwd, model: 'mock-model', ...startParams });
    return await run(server, f, started.thread.id);
  } finally { await server.close(); await f.close(); }
}

const turn = async (server: RawAppServer, threadId: string, text: string, extra: object = {}) => {
  const from = server.notifications.length;
  const started = await server.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }], ...extra });
  return { from, turnId: started.turn.id as string };
};
const done = (server: RawAppServer, from: number) => server.until('turn/completed', () => true, from);
const read = (server: RawAppServer, threadId: string) => server.request('thread/read', { threadId, includeTurns: true });



interface Native { notifications: RawMessage[]; serverRequests: RawMessage[]; turns: any[]; items: any[] }
const native = async (name: string, server: RawAppServer, threadId: string): Promise<Native> => {
  const page = await server.request('thread/turns/list', { threadId, limit: 50, sortDirection: 'asc', itemsView: 'full' });
  const turns = page.data as any[];
  const value = { notifications: server.notifications, serverRequests: server.serverRequests, turns, items: turns.flatMap(turn => turn.items) };
  dump(name, { ...value, read: await server.request('thread/read', { threadId, includeTurns: true }) });
  return value;
};
const live = (run: Native, method: string, type?: string) => run.notifications.filter(entry => entry.method === method && (type === undefined || entry.params.item?.type === type));
const idsOf = (entries: RawMessage[]) => entries.map(entry => entry.params.item.id as string);
const answerNative = (message: any): unknown => {
  if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') return { decision: 'accept' };
  if (message.method === 'item/tool/requestUserInput') return { answers: { profession: { answers: ['Engineer'] } } };
  return {};
};
const question = call('q1', 'request_user_input', { questions: [{ id: 'profession', header: 'Profession', question: 'Choose', options: [{ label: 'Engineer', description: 'Build' }, { label: 'Designer', description: 'Design' }] }] });
const planMode = { collaborationMode: { mode: 'plan', settings: { model: 'mock-model', reasoning_effort: null, developer_instructions: null } } };
const patchModel = { model: 'step-settings-a' };

describe('what the native Codex 0.169 runtime does, which the journal keys depend on', () => {
  it('FC1, FC7: item ids are equal in notifications and in history for every item type, and a tool projects equally from both', async () => {
    const run = await scenario((request, index) => index === 0 ? [...reasoning('r1', ['Part one', 'Part two']), ...message('m1', 'Patching.', ['Patch', 'ing.']), ...patch('p1', '*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch')]
      : index === 1 ? shell('c1', 'printf SETTLED_OK') : message('m2', 'ANSWER', ['ANS', 'WER']), { patchTool: true, sandboxMode: 'workspace-write' },
      async (server, f, threadId) => { const { from } = await turn(server, threadId, 'First'); await done(server, from); return native('settled', server, threadId); }, undefined, patchModel);
    const types = ['userMessage', 'reasoning', 'agentMessage', 'fileChange', 'commandExecution'];
    for (const type of types) {
      const completed = idsOf(live(run, 'item/completed', type));
      expect(completed.length, `${type} completed live`).toBeGreaterThan(0);
      expect(run.items.filter(item => item.type === type).map(item => item.id), `${type} in history`).toEqual(completed);
    }
    const projector = new CodexEventProjector('thread', { delivery: 'live' });
    for (const type of ['commandExecution', 'fileChange']) {
      const liveItem = live(run, 'item/completed', type)[0]!.params.item;
      const fromLive = projector.projectNotification('item/completed', { threadId: 'thread', turnId: 't', item: liveItem })!.event;
      const fromHistory = new CodexEventProjector('thread', { delivery: 'history' }).projectHistoryItem(run.items.find(item => item.id === liveItem.id), 't')!.event;
      expect(fromLive, `${type} projected from the live completion`).toEqual(fromHistory);
    }
    expect(live(run, 'item/reasoning/summaryPartAdded').map(entry => entry.params.summaryIndex), 'FC6: every summary part is announced with its index').toEqual([0, 1]);
    expect(run.items.find(item => item.type === 'reasoning').summary).toEqual(['Part one', 'Part two']);
  }, 60_000);

  it('FC2: an approval and a question are not in history, and every history item is a type the projector knows', async () => {
    const run = await scenario((request, index) => index === 0 ? question : index === 1 ? call('c1', 'exec_command', { cmd: 'touch approved.txt', sandbox_permissions: 'require_escalated', justification: 'Write a file', max_output_tokens: 200 }) : message('m1', 'FINAL'),
      { approvalPolicy: 'on-request' }, async (server, f, threadId) => { const { from } = await turn(server, threadId, 'Ask then write'); await done(server, from); return native('approval', server, threadId); },
      answerNative, { config: { 'features.default_mode_request_user_input': true } });
    expect(run.serverRequests.map(entry => entry.method).sort()).toEqual(['item/commandExecution/requestApproval', 'item/tool/requestUserInput']);
    expect(run.serverRequests.map(entry => entry.params.itemId).sort(), 'a request names the native item it belongs to').toEqual(['c1', 'q1']);
    expect(run.items.map(item => item.type)).toEqual(['userMessage', 'commandExecution', 'agentMessage']);
    expect(run.items.some(item => item.id === 'q1')).toBe(false);
  }, 60_000);

  it('FC3: an interrupted turn keeps its user message, a command that was under way as failed, and nothing it streamed', async () => {
    const partial = [{ type: 'response.output_item.added', item: { type: 'message', role: 'assistant', id: 'm1', content: [] } }, { type: 'response.output_text.delta', item_id: 'm1', delta: 'Half of ' }];
    const thought = [{ type: 'response.output_item.added', item: { type: 'reasoning', id: 'r1', summary: [] } }, { type: 'response.reasoning_summary_part.added', item_id: 'r1', summary_index: 0 }, { type: 'response.reasoning_summary_text.delta', item_id: 'r1', summary_index: 0, delta: 'Thinking ' }];
    const run = await scenario((request, index) => index === 0 ? stalled([...thought, ...partial]) : stalled(shell('c1', 'sleep 30')), {}, async (server, f, threadId) => {
      const first = await turn(server, threadId, 'Stream then stop');
      await server.until('item/agentMessage/delta', () => true, first.from);
      await server.request('turn/interrupt', { threadId, turnId: first.turnId });
      await server.until('turn/completed', () => true, first.from);
      const second = await turn(server, threadId, 'Run then stop');
      await server.until('item/started', params => params.item?.type === 'commandExecution', second.from);
      // Interrupted at once, the native runtime sometimes records the command and sometimes does not; once it is under way it always does.
      await new Promise(resolve => { setTimeout(resolve, 1500); });
      await server.request('turn/interrupt', { threadId, turnId: second.turnId });
      await server.until('turn/completed', () => true, second.from);
      const sameProcess = await native('interrupted', server, threadId);
      // What a reopen reads comes from the rollout a new process loads, which is not what the process that ran the turn reports.
      await server.close();
      const fresh = new RawAppServer(executable, f.cwd, f.env);
      try {
        await fresh.initialize();
        await fresh.request('thread/resume', { threadId });
        expect(sameProcess.items.map(item => item.type), 'the process that ran the turn does not report the interrupted command').toEqual(['userMessage', 'userMessage']);
        return await native('interrupted-reopened', fresh, threadId);
      } finally { await fresh.close(); }
    });
    expect(live(run, 'turn/completed').map(entry => entry.params.turn.status)).toEqual([]);
    expect(run.turns.map(turn => turn.status)).toEqual(['interrupted', 'interrupted']);
    expect(run.items.map(item => item.type), 'history holds neither the streamed text nor the reasoning, and the interrupted command it records').toEqual(['userMessage', 'userMessage', 'commandExecution']);
    expect(run.items[2].status, 'the command history records for the interrupted turn failed; the live row never left running').toBe('failed');
  }, 90_000);

  it('FC4: the plan item of a plan-mode turn has the same id live and in history, and history lists it before the message it was cut from', async () => {
    const run = await scenario(() => [...message('m0', 'x').slice(0, 1), { type: 'response.output_text.delta', item_id: 'm0', delta: 'Here is the plan.\n\n' }, pause(40), { type: 'response.output_text.delta', item_id: 'm0', delta: '<proposed_plan>\n- one\n' }, pause(40),
      { type: 'response.output_text.delta', item_id: 'm0', delta: '</proposed_plan>\nBye' }, { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'm0', content: [{ type: 'output_text', text: 'Here is the plan.\n\n<proposed_plan>\n- one\n</proposed_plan>\nBye' }] } }], {},
      async (server, f, threadId) => { const { from } = await turn(server, threadId, 'Plan it', planMode); await done(server, from); return native('plan-mode', server, threadId); });
    const planId = idsOf(live(run, 'item/completed', 'plan'));
    expect(planId).toHaveLength(1);
    expect(live(run, 'item/plan/delta').every(entry => entry.params.itemId === planId[0])).toBe(true);
    expect(run.items.map(item => item.type)).toEqual(['userMessage', 'plan', 'agentMessage']);
    expect(run.items[1].id).toBe(planId[0]);
    const [text, plan] = ['m0', planId[0]!].map(id => run.items.find(item => item.id === id));
    expect(text.startedAtMs, 'the message started before the plan, as the live stream saw it').toBeLessThan(plan.startedAtMs);
  }, 60_000);

  it('FC5: a compaction is a turn of its own with an item whose id is equal in both, history keeps the items before it, and the deprecated notice is never sent', async () => {
    const run = await scenario((request, index) => index === 0 ? message('m1', 'ANSWER_1') : message(`s${index}`, 'SUMMARY'), {}, async (server, f, threadId) => {
      const first = await turn(server, threadId, 'First'); await done(server, first.from);
      const from = server.notifications.length;
      await server.request('thread/compact/start', { threadId });
      await server.until('item/completed', params => params.item?.type === 'contextCompaction', from);
      await server.until('turn/completed', () => true, from);
      return native('compaction', server, threadId);
    });
    const compaction = idsOf(live(run, 'item/completed', 'contextCompaction'));
    expect(compaction).toHaveLength(1);
    expect(run.items.filter(item => item.type === 'contextCompaction').map(item => item.id)).toEqual(compaction);
    expect(run.items.map(item => item.type)).toEqual(['userMessage', 'agentMessage', 'contextCompaction']);
    expect(run.notifications.filter(entry => entry.method === 'thread/compacted')).toEqual([]);
  }, 60_000);

  it('FC9: a steered message has its own item id, equal in the notifications and in history', async () => {
    const run = await scenario((request, index) => index === 0 ? shell('c1', 'sleep 2') : message('m1', 'AFTER_STEER'), {}, async (server, f, threadId) => {
      const first = await turn(server, threadId, 'Run');
      await server.until('item/started', params => params.item?.type === 'commandExecution', first.from);
      await server.request('turn/steer', { threadId, expectedTurnId: first.turnId, clientUserMessageId: 'steer-1', input: [{ type: 'text', text: 'Also this', text_elements: [] }] });
      await done(server, first.from);
      return native('steer', server, threadId);
    });
    const users = idsOf(live(run, 'item/completed', 'userMessage'));
    expect(users).toHaveLength(2);
    expect(run.items.filter(item => item.type === 'userMessage').map(item => item.id)).toEqual(users);
    expect(run.items.map(item => item.type)).toEqual(['userMessage', 'commandExecution', 'userMessage', 'agentMessage']);
  }, 60_000);

  it('FC8: a failing MCP server is announced to its thread and never written to history, a failed turn is one error in both, and an ordinary turn raises no error', async () => {
    const run = await scenario((request, index) => index === 0 ? message('m1', 'ONE') : { status: 500, body: JSON.stringify({ error: { message: 'model exploded' } }) }, { config: '\n[mcp_servers.broken]\ncommand = "/nonexistent/arc-broken-mcp"\n' }, async (server, f, threadId) => {
      const first = await turn(server, threadId, 'First'); await done(server, first.from);
      const second = await turn(server, threadId, 'Second'); await server.until('turn/completed', () => true, second.from);
      await new Promise(resolve => { setTimeout(resolve, 500); });
      return native('errors', server, threadId);
    });
    const startup = run.notifications.filter(entry => entry.method === 'mcpServer/startupStatus/updated');
    expect(startup.map(entry => entry.params.status)).toEqual(['starting', 'failed']);
    expect(run.items.every(item => ['userMessage', 'agentMessage'].includes(item.type)), 'a start-up failure is not in history').toBe(true);
    expect(run.turns.map(turn => turn.status)).toEqual(['completed', 'failed']);
    expect(run.turns[1].error.message).toBeTruthy();
    const firstTurn = run.notifications.slice(0, run.notifications.findIndex(entry => entry.method === 'turn/completed') + 1).filter(entry => !entry.method.startsWith('mcpServer/'));
    expect([...new Set(firstTurn.map(entry => entry.method))].sort(), 'the notification methods of an ordinary turn; the projector must know every one of them').toEqual([
      'account/rateLimits/updated', 'item/agentMessage/delta', 'item/completed', 'item/started', 'remoteControl/status/changed', 'thread/readState/changed', 'thread/started', 'thread/status/changed', 'thread/tokenUsage/updated', 'turn/completed', 'turn/started', 'warning',
    ]);
  }, 90_000);

  it('plan updates are live only: turn/plan/updated arrives and history holds no trace of it', async () => {
    const run = await scenario((request, index) => index === 0 ? call('p1', 'update_plan', { plan: [{ step: 'alpha', status: 'in_progress' }, { step: 'beta', status: 'pending' }] }) : index === 1 ? call('p2', 'update_plan', { plan: [{ step: 'alpha', status: 'completed' }, { step: 'beta', status: 'in_progress' }] }) : message('m1', 'DONE'),
      { config: '\n[tools.update_plan]\nenabled = true\n' }, async (server, f, threadId) => { const { from } = await turn(server, threadId, 'Plan'); await done(server, from); return native('todos', server, threadId); });
    expect(live(run, 'turn/plan/updated')).toHaveLength(2);
    expect(run.items.map(item => item.type)).toEqual(['userMessage', 'agentMessage']);
  }, 60_000);

  it('parallel tool calls run one after the other and history keeps that order', async () => {
    const run = await scenario((request, index) => index === 0 ? [...call('c1', 'exec_command', { cmd: 'sleep 1; echo slow', max_output_tokens: 100 }), ...call('c2', 'exec_command', { cmd: 'echo fast', max_output_tokens: 100 })] : message('m1', 'BOTH'), { patchTool: true },
      async (server, f, threadId) => { const { from } = await turn(server, threadId, 'Run both'); await done(server, from); return native('parallel', server, threadId); }, undefined, patchModel);
    expect(run.items.filter(item => item.type === 'commandExecution').map(item => item.id)).toEqual(idsOf(live(run, 'item/started', 'commandExecution')));
  }, 60_000);
});
