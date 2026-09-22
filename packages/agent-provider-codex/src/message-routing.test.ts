import readline from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAppServerProvider } from './provider.js';
import { createFakeChildProcess } from './test-utils/fake-child.js';

class NativeFailure extends Error {
  constructor(message: string, readonly code = -32602) { super(message); }
}
const sessions: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => { for (const session of sessions.splice(0)) await session.dispose(); });
async function harness(steer: (expected: string, attempt: number) => unknown | Promise<unknown> = () => ({ turnId: 'turn-1' }), requestTimeoutMs = 1000) {
  const child = createFakeChildProcess();
  const requests: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
  const nativeResponses: Array<{ id: string; result?: unknown }> = [];
  let turns = 0;
  let steers = 0;
  const reader = readline.createInterface({ input: child.stdin });
  reader.on('line', (line) => {
    const request = JSON.parse(line) as typeof requests[number];
    if (typeof request.id !== 'number') {
      if (!request.method) nativeResponses.push(request as unknown as typeof nativeResponses[number]);
      return;
    }
    requests.push(request);
    void (async () => {
      try {
        const result = request.method === 'thread/start' ? { thread: { id: 'thread' }, model: 'model' }
          : request.method === 'skills/list' ? { data: [] }
          : request.method === 'model/list' ? { data: [{ model: 'model' }] }
          : request.method === 'collaborationMode/list' ? { data: [{ mode: 'plan', model: 'model' }, { mode: 'default', model: 'model' }] }
          : request.method === 'turn/start' ? { turn: { id: `turn-${++turns}` } }
          : request.method === 'turn/steer' ? await steer(String(request.params.expectedTurnId), ++steers)
          : {};
        child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      } catch (error) {
        child.stdout.write(`${JSON.stringify({ id: request.id, error: { code: error instanceof NativeFailure ? error.code : -32603, message: (error as Error).message } })}\n`);
      }
    })();
  });
  const session = await new CodexAppServerProvider({ spawn: () => child, requestTimeoutMs }).createSession({ sessionId: 'local', planning: true });
  sessions.push(session);
  function notify(method: string, params: object) { child.stdout.write(`${JSON.stringify({ method, params: { threadId: 'thread', ...params } })}\n`); }
  function nativeRequest(method: string, params: object) { child.stdout.write(`${JSON.stringify({ id: 'native-pending', method, params: { threadId: 'thread', ...params } })}\n`); }
  return { session, requests, notify, nativeRequest, nativeResponses };
}
const input = (text: string) => [{ type: 'text', text, text_elements: [] }];

describe('Codex immediate message delivery', () => {
  it.each(['question', 'approval'] as const)('steers an active turn with pending %s without answering or closing it', async (kind) => {
    const h = await harness();
    await h.session.sendMessage('Start');
    h.nativeRequest(kind === 'question' ? 'item/tool/requestUserInput' : 'item/commandExecution/requestApproval', kind === 'question'
      ? { turnId: 'turn-1', itemId: 'question', questions: [{ id: 'path', header: 'Path', question: 'Which path?', options: [{ label: 'A', description: 'Path A' }] }] }
      : { turnId: 'turn-1', itemId: 'command', command: 'pwd', availableDecisions: ['accept', 'decline'] });
    h.notify('thread/status/changed', { status: { type: 'active', activeFlags: [kind === 'question' ? 'waitingOnUserInput' : 'waitingOnApproval'] } });
    await h.session.sendMessage('Also preserve the existing files.');
    expect(h.requests.filter(({ method }) => method === 'turn/start')).toHaveLength(1);
    expect(h.requests.find(({ method }) => method === 'turn/steer')?.params).toMatchObject({ expectedTurnId: 'turn-1', input: input('Also preserve the existing files.') });
    expect(h.nativeResponses).toEqual([]);
    expect((await h.session.runtimeInfo()).status).toBe('waiting');
    await h.session.respondToInteraction(`${kind === 'question' ? 'question' : 'tool'}:native-pending`, kind === 'question'
      ? { kind: 'question', answers: [{ questionId: 'path', selectedValues: ['A'] }] }
      : { kind: 'tool_approval', decision: 'deny' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.nativeResponses).toEqual([{ id: 'native-pending', result: kind === 'question' ? { answers: { path: { answers: ['A'] } } } : { decision: 'decline' } }]);
  });

  it.each(['native question', 'plan review', 'command menu'] as const)('does not start a turn while an idle %s remains pending', async (kind) => {
    const h = await harness();
    if (kind === 'native question') h.nativeRequest('item/tool/requestUserInput', {
      itemId: 'question', questions: [{ id: 'path', header: 'Path', question: 'Which path?', options: [{ label: 'A', description: 'Path A' }] }],
    });
    else if (kind === 'command menu') await h.session.executeCommand!('model', '');
    else {
      h.notify('item/completed', { turnId: 'finished-turn', item: { id: 'plan', type: 'plan', text: 'Proposed plan' } });
      h.notify('turn/completed', { turn: { id: 'finished-turn', status: 'completed' } });
    }
    await expect(h.session.sendMessage('Do the work')).rejects.toThrow('pending');
    expect(h.requests.some(({ method }) => method === 'turn/start' || method === 'turn/steer')).toBe(false);
    expect(h.nativeResponses).toEqual([]);
  });

  it('does not start over a pending native request after a steer reports no active turn', async () => {
    const h = await harness(() => { throw new NativeFailure('no active turn to steer'); });
    await h.session.sendMessage('Start');
    h.nativeRequest('item/commandExecution/requestApproval', { turnId: 'turn-1', itemId: 'command', command: 'pwd', availableDecisions: ['accept', 'decline'] });
    await expect(h.session.sendMessage('Follow up')).rejects.toThrow('pending');
    expect(h.requests.filter(({ method }) => method === 'turn/steer')).toHaveLength(1);
    expect(h.requests.filter(({ method }) => method === 'turn/start')).toHaveLength(1);
    expect(h.nativeResponses).toEqual([]);
  });

  it('starts idle turns and steers busy turns with unchanged text and Planning', async () => {
    const h = await harness();
    await h.session.sendMessage('Start');
    await h.session.sendMessage('  also check\nthis  ');
    expect(h.requests.filter(({ method }) => method === 'turn/start')).toHaveLength(1);
    expect(h.requests.find(({ method }) => method === 'turn/steer')?.params).toEqual({ threadId: 'thread', expectedTurnId: 'turn-1', input: input('  also check\nthis  ') });
    expect(h.requests.find(({ method }) => method === 'turn/start')?.params).toMatchObject({ collaborationMode: { mode: 'plan' } });
    expect((await h.session.runtimeInfo()).planning?.active).toBe(true);
    h.notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    await h.session.sendMessage('Next');
    expect(h.requests.filter(({ method }) => method === 'turn/start')).toHaveLength(2);
  });

  it('starts once only after the native runtime explicitly rejects a stale active turn', async () => {
    const h = await harness(() => { throw new NativeFailure('no active turn to steer'); });
    await h.session.sendMessage('Start');
    await h.session.sendMessage('Follow up');
    expect(h.requests.filter(({ method }) => method === 'turn/steer')).toHaveLength(1);
    expect(h.requests.filter(({ method }) => method === 'turn/start').at(-1)?.params).toMatchObject({ input: input('Follow up'), collaborationMode: { mode: 'plan' } });
    expect(h.requests.filter(({ method }) => method === 'turn/start')).toHaveLength(2);
  });

  it('retries one native turn mismatch using only the explicitly reported actual ID', async () => {
    const h = await harness((expected, attempt) => {
      if (attempt === 1) throw new NativeFailure(`expected active turn id \`${expected}\` but found \`turn-review\``);
      return { turnId: expected };
    });
    await h.session.sendMessage('Start');
    await h.session.sendMessage('Follow up');
    expect(h.requests.filter(({ method }) => method === 'turn/steer').map(({ params }) => params.expectedTurnId)).toEqual(['turn-1', 'turn-review']);
    expect(h.requests.filter(({ method }) => method === 'turn/start')).toHaveLength(1);
    await h.session.cancel!();
    expect(h.requests.at(-1)?.params.turnId).toBe('turn-review');
  });

  it.each([
    ['ordinary failure', () => { throw new NativeFailure('provider disconnected', -32603); }, 1],
    ['ambiguous error with matching text', () => { throw new NativeFailure('no active turn to steer', -32603); }, 1],
    ['non-steerable review', () => { throw new NativeFailure('cannot steer a review turn'); }, 1],
    ['repeated mismatch', (expected: string, attempt: number) => { throw new NativeFailure(`expected active turn id \`${expected}\` but found \`turn-${attempt + 1}\``); }, 2],
  ] as const)('does not resubmit after %s', async (_label, steer, attempts) => {
    const h = await harness(steer);
    await h.session.sendMessage('Start');
    await expect(h.session.sendMessage('Follow up')).rejects.toThrow();
    expect(h.requests.filter(({ method }) => method === 'turn/steer')).toHaveLength(attempts);
    expect(h.requests.filter(({ method }) => method === 'turn/start')).toHaveLength(1);
  });

  it('does not resubmit after a native request timeout', async () => {
    const h = await harness(() => new Promise(() => {}), 20);
    await h.session.sendMessage('Start');
    await expect(h.session.sendMessage('Follow up')).rejects.toThrow(/timed out/i);
    expect(h.requests.filter(({ method }) => method === 'turn/steer')).toHaveLength(1);
    expect(h.requests.filter(({ method }) => method === 'turn/start')).toHaveLength(1);
  });

  it('does not start over a newer native turn that arrives during a rejected steer', async () => {
    const h = await harness(() => {
      h.notify('turn/started', { turn: { id: 'newer-turn' } });
      throw new NativeFailure('no active turn to steer');
    });
    await h.session.sendMessage('Start');
    await expect(h.session.sendMessage('Follow up')).rejects.toThrow('no active turn');
    expect(h.requests.filter(({ method }) => method === 'turn/start')).toHaveLength(1);
    await h.session.cancel!();
    expect(h.requests.at(-1)?.params.turnId).toBe('newer-turn');
  });

  it('does not turn a newer native active status into an idle retry', async () => {
    const h = await harness(() => {
      h.notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
      h.notify('thread/status/changed', { status: { type: 'active', activeFlags: [] } });
      throw new NativeFailure('no active turn to steer');
    });
    await h.session.sendMessage('Start');
    await expect(h.session.sendMessage('Follow up')).rejects.toThrow('no active turn');
    expect(h.requests.filter(({ method }) => method === 'turn/start')).toHaveLength(1);
    expect((await h.session.runtimeInfo()).status).toBe('running');
  });

  it('keeps explicit steer strict and rejects unsupported next-turn delivery in every state', async () => {
    const h = await harness(() => { throw new NativeFailure('no active turn to steer'); });
    expect(h.session.capabilities.queueMessage).not.toBe(true);
    await expect(h.session.sendMessage('Queued', { delivery: 'next_turn' })).rejects.toThrow('next-turn');
    await h.session.sendMessage('Start');
    await expect(h.session.sendMessage('Queued', { delivery: 'next_turn' })).rejects.toThrow('next-turn');
    await expect(h.session.steer!('Strict')).rejects.toThrow('no active turn');
    expect(h.requests.filter(({ method }) => method === 'turn/start')).toHaveLength(1);
  });
});

const richParts = [
  { type: 'text', text: 'before ' },
  { type: 'image', path: '/managed/one.png', mediaType: 'image/png', sha256: 'a'.repeat(64), label: 'image #1' },
  { type: 'text', text: ' between ' },
  { type: 'image', path: '/managed/two.png', mediaType: 'image/png', sha256: 'b'.repeat(64), label: 'image #2' },
  { type: 'text', text: ' after' },
] as const;
it('preserves ordered images for both turn start and steer, including image-only input', async () => {
  const h = await harness();
  await h.session.sendMessageContent!(richParts);
  await h.session.sendMessageContent!(richParts);
  const expected = richParts.flatMap(part => part.type === 'text'
    ? [{ type: 'text', text: part.text, text_elements: [] }] : [
      { type: 'text', text: `[${part.label}]`, text_elements: [{ byteRange: { start: 0, end: 10 }, placeholder: `[${part.label}]` }] },
      { type: 'localImage', path: part.path },
    ]);
  expect(h.requests.find(r => r.method === 'turn/start')?.params.input).toEqual(expected);
  expect(h.requests.find(r => r.method === 'turn/steer')?.params.input).toEqual(expected);
  await h.session.sendMessageContent!([richParts[1]]);
  expect(h.requests.at(-1)?.params.input).toEqual([expected[1], expected[2]]);
  expect(h.session.capabilities.imageInput).toMatchObject({ maxImages: 8 });
});
it('preserves rich input when an explicitly rejected stale steer becomes a start', async () => {
  const h = await harness(() => { throw new NativeFailure('no active turn to steer'); });
  await h.session.sendMessage('Start');
  await h.session.sendMessageContent!(richParts);
  expect(h.requests.filter(r => r.method === 'turn/start').at(-1)?.params.input)
    .toEqual(h.requests.find(r => r.method === 'turn/steer')?.params.input);
});
