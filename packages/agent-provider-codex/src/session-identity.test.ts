import { describe, expect, it } from 'vitest';
import type { ProviderObservation, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';

import { CodexAppServerProvider } from './provider.js';
import { createScriptedAppServer } from './test-utils/scripted-app-server.js';

const modes = { data: [
  { name: 'Default', mode: 'default', model: 'test-model', reasoning_effort: null, developer_instructions: null },
  { name: 'Plan', mode: 'plan', model: 'test-model', reasoning_effort: 'medium', developer_instructions: 'Plan carefully.' },
] };

async function open(planning = false, turns: unknown[] = [], diagnostics: string[] = []) {
  const server = createScriptedAppServer({
    'collaborationMode/list': () => modes,
    'thread/start': () => ({ thread: { id: 'thread-1' }, model: 'test-model', cwd: '/workspace' }),
    'thread/resume': () => ({ thread: { id: 'thread-1' }, model: 'test-model', cwd: '/workspace' }),
    'thread/read': () => ({ thread: { id: 'thread-1', cwd: '/workspace', turns } }),
  });
  const provider = new CodexAppServerProvider({ spawn: () => server.child, onDiagnostic: line => diagnostics.push(line) });
  const session = turns.length > 0 || diagnostics.length > 0
    ? await provider.resumeSession({ providerId: 'codex', sessionId: 'thread-1', opaque: JSON.stringify({ cwd: '/workspace' }) })
    : await provider.createSession({ sessionId: 'local', planning });
  const stream = session.observe()[Symbol.asyncIterator]();
  const seen: ProviderStreamItem[] = [];
  const history: ProviderObservation[] = [];
  for (;;) {
    const next = await stream.next();
    if (next.done || next.value.type === 'history_boundary') break;
    if (next.value.type === 'observation') history.push(next.value);
  }
  const send = (message: object) => server.child.stdout.write(`${JSON.stringify(message)}\n`);
  const notify = (method: string, params: object) => send({ method, params: { threadId: 'thread-1', ...params } });
  /** Reads live observations until `done` matches one. */
  const until = async (done: (observation: ProviderObservation) => boolean): Promise<ProviderObservation[]> => {
    const collected: ProviderObservation[] = [];
    for (let count = 0; count < 40; count += 1) {
      const next = await stream.next();
      if (next.done) break;
      seen.push(next.value);
      if (next.value.type !== 'observation') continue;
      collected.push(next.value);
      if (done(next.value)) return collected;
    }
    throw new Error(`The expected observation did not arrive; saw ${collected.map(({ event }) => event.type).join(', ')}`);
  };
  return { server, session, history, send, notify, until };
}

const question = (id: number | string, itemId: string | undefined, turnId = 'turn-1') => ({
  id, method: 'item/tool/requestUserInput', params: {
    threadId: 'thread-1', turnId, ...(itemId ? { itemId } : {}), isBlocking: true,
    questions: [{ id: 'q', header: 'Q', question: 'Choose', isOther: false, isSecret: false, options: [{ label: 'Yes', description: 'Y' }] }],
  },
});
const answer = { kind: 'question' as const, answers: [{ questionId: 'q', selectedValues: ['Yes'] }] };
const resolved = (observations: ProviderObservation[]) => observations.find(({ event }) => event.type === 'interaction_resolved')!;

describe('Codex interaction identity', () => {
  it('keys an interaction by the native item it belongs to, live-only, completed with its resolution', async () => {
    const f = await open();
    try {
      f.send(question(7, 'question-item-1'));
      await f.until(({ event }) => event.type === 'interaction_requested');
      await f.session.respondToInteraction!('question:7', answer);
      expect(resolved(await f.until(({ event }) => event.type === 'interaction_resolved')).itemIdentity).toEqual({ key: 'interaction:question-item-1', completes: true, liveOnly: true });
    } finally { await f.session.dispose(); }
  });

  it('does not meet a carried interaction of an earlier process life that had the same request number', async () => {
    const keys: string[] = [];
    for (const itemId of ['question-item-1', 'question-item-9']) {
      const f = await open();
      try {
        f.send(question(3, itemId));
        await f.until(({ event }) => event.type === 'interaction_requested');
        await f.session.respondToInteraction!('question:3', answer);
        keys.push(resolved(await f.until(({ event }) => event.type === 'interaction_resolved')).itemIdentity!.key);
      } finally { await f.session.dispose(); }
    }
    expect(keys).toEqual(['interaction:question-item-1', 'interaction:question-item-9']);
  });

  it('keys a request that names no item by its turn and request id, and a cancelled one the same way', async () => {
    const f = await open();
    try {
      f.send(question(5, undefined, 'turn-7'));
      await f.until(({ event }) => event.type === 'interaction_requested');
      f.notify('serverRequest/resolved', { requestId: 5 });
      const closed = resolved(await f.until(({ event }) => event.type === 'interaction_resolved'));
      expect(closed.itemIdentity).toEqual({ key: 'interaction:turn-7:question:5', completes: true, liveOnly: true });
    } finally { await f.session.dispose(); }
  });

  it('gives the plan approval of a plan-mode turn the key of its request, and shows the plan as a message first', async () => {
    const f = await open(true);
    try {
      f.notify('turn/started', { turn: { id: 'turn-1' } });
      f.notify('item/started', { turnId: 'turn-1', item: { type: 'plan', id: 'plan-1', text: '' } });
      f.notify('item/plan/delta', { turnId: 'turn-1', itemId: 'plan-1', delta: '# Plan' });
      f.notify('item/completed', { turnId: 'turn-1', item: { type: 'plan', id: 'plan-1', text: '# Plan' } });
      f.notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
      const seen = await f.until(({ event }) => event.type === 'interaction_requested');
      const plan = seen.filter(({ itemIdentity }) => itemIdentity?.key === 'assistant:plan-1').map(({ event }) => event.type === 'timeline' && 'text' in event.item ? event.item.text : undefined);
      expect(plan).toEqual(['# Plan', '']);
      const request = seen.at(-1)!.event;
      if (request.type !== 'interaction_requested') throw new Error('Missing plan approval');
      await f.session.respondToInteraction!(request.request.requestId, { kind: 'plan_approval', action: 'reject' });
      expect(resolved(await f.until(({ event }) => event.type === 'interaction_resolved')).itemIdentity).toEqual({ key: `interaction:${request.request.requestId}`, completes: true, liveOnly: true });
    } finally { await f.session.dispose(); }
  });

  it('marks a closed permission request unavailable with an error the history never holds, keyed by its message', async () => {
    const f = await open();
    try {
      f.send({ id: 9, method: 'item/permissions/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'perm-1', permissions: { network: { enabled: true } } } });
      await f.until(({ event }) => event.type === 'interaction_requested');
      f.notify('serverRequest/resolved', { requestId: 9 });
      const seen = await f.until(({ event }) => event.type === 'timeline');
      expect(seen.at(-1)!.itemIdentity).toMatchObject({ completes: true, liveOnly: true, key: expect.stringMatching(/^error:[0-9a-f]{16}$/) });
    } finally { await f.session.dispose(); }
  });
});

describe('Codex timeline identity through a session', () => {
  it('sends a failing MCP server to the diagnostic sink and shows it once as a live-only item', async () => {
    const lines: string[] = [];
    const f = await open(false, [{ id: 'turn-1', status: 'completed', startedAt: 1, items: [{ type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'hi' }], startedAtMs: 1 }] }], lines);
    try {
      f.notify('mcpServer/startupStatus/updated', { name: 'docs', status: 'failed', error: 'spawn ENOENT' });
      f.notify('turn/started', { turn: { id: 'turn-2' } });
      const seen = await f.until(({ event }) => event.type === 'turn_started');
      expect(seen.filter(({ event }) => event.type === 'timeline').map(({ itemIdentity }) => itemIdentity)).toEqual([{ key: 'startup:docs', completes: true, liveOnly: true }]);
      expect(lines.map(line => { try { return JSON.parse(line) as { event?: string }; } catch { return {}; } }).filter(entry => entry.event === 'codex_startup_notice')).toHaveLength(1);
    } finally { await f.session.dispose(); }
  });

  it('opens the same session five times and adds no item after the first', async () => {
    const turns = [{ id: 'turn-1', status: 'completed', startedAt: 1, items: [
      { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'hi' }], startedAtMs: 1, completedAtMs: 1 },
      { type: 'reasoning', id: 'r1', summary: ['a', 'b'], content: [], startedAtMs: 2, completedAtMs: 3 },
      { type: 'commandExecution', id: 'c1', command: 'pwd', cwd: '/workspace', status: 'completed', aggregatedOutput: '/', exitCode: 0, startedAtMs: 4, completedAtMs: 5 },
      { type: 'agentMessage', id: 'm1', text: 'done', startedAtMs: 6, completedAtMs: 7 },
    ] }];
    const opened: string[][] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const f = await open(false, turns);
      try {
        await f.session.runtimeInfo();
        opened.push(f.history.filter(({ event }) => event.type === 'timeline').map(({ itemIdentity }) => itemIdentity!.key));
      } finally { await f.session.dispose(); }
    }
    expect(opened[0]).toEqual(['user:u1', 'reasoning:r1', 'tool:c1', 'assistant:m1']);
    for (const keys of opened) expect(keys).toEqual(opened[0]);
  });
});
