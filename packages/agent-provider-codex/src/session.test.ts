import { once } from 'node:events';

import { decodeServerMessage, PROTOCOL_VERSION } from '../../agent-remote-protocol/src/index.js';
import { describe, expect, it } from 'vitest';

import { CodexAppServerSession } from './session.js';
import { CodexAppServerTransport } from './app-server-transport.js';
import { createFakeChildProcess } from './test-utils/fake-child.js';

function createSessionHarness() {
  const child = createFakeChildProcess();
  const transport = new CodexAppServerTransport(child);
  const requests: Array<{ id: number; method: string; params: unknown }> = [];
  let buffered = '';
  child.stdin.on('data', (chunk) => {
    buffered += String(chunk);
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) continue;
      const message = JSON.parse(line) as { id?: number; method?: string; params?: unknown };
      if (typeof message.id === 'number' && message.method) requests.push(message as typeof requests[number]);
      if (typeof message.id === 'number' && ['collaborationMode/list', 'model/list', 'configRequirements/read'].includes(message.method ?? '')) {
        child.stdout.write(`${JSON.stringify({ id: message.id, result: { data: [] } })}\n`);
      }
    }
  });
  return { child, transport, requests };
}

async function waitForRequest(
  harness: ReturnType<typeof createSessionHarness>,
  method: string,
): Promise<{ id: number; method: string; params: unknown }> {
  while (true) {
    const found = harness.requests.find((request) => request.method === method);
    if (found) return found;
    await once(harness.child.stdin, 'data');
  }
}

function respond(harness: ReturnType<typeof createSessionHarness>, id: number, result: unknown): void {
  harness.child.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

describe('CodexAppServerSession', () => {
  it('drains observations accepted before an unexpected transport exit', async () => {
    const harness = createSessionHarness();
    const starting = CodexAppServerSession.create(harness.transport, {
      sessionId: 'local', cwd: '/workspace',
    });
    respond(harness, (await waitForRequest(harness, 'initialize')).id, {});
    respond(harness, (await waitForRequest(harness, 'thread/start')).id, {
      thread: { id: 'thread-drain' }, model: 'gpt-5.4', cwd: '/workspace',
    });
    const session = await starting;
    const iterator = session.observe()[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      value: { type: 'history_boundary' }, done: false,
    });

    harness.child.stdout.write(`${JSON.stringify({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-drain', turnId: 'turn-before-exit',
        itemId: 'message-before-exit', delta: 'Output before app-server exit.',
      },
    })}\n`);
    harness.child.emitExit(17);

    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'observation',
        event: {
          type: 'timeline', item: {
            type: 'assistant_message', text: 'Output before app-server exit.',
          },
        },
      },
      done: false,
    });
    await expect(iterator.next()).rejects.toThrow('exited with code 17');
    await session.dispose();
  });

  it('resumes, reads history, emits one boundary, and then emits live observations', async () => {
    const harness = createSessionHarness();
    const starting = CodexAppServerSession.resume(harness.transport, {
      providerId: 'codex', sessionId: 'thread-1', opaque: JSON.stringify({ cwd: '/workspace' }),
    });
    respond(harness, (await waitForRequest(harness, 'initialize')).id, {});
    respond(harness, (await waitForRequest(harness, 'thread/resume')).id, { thread: { id: 'thread-1' }, model: 'gpt-5.4', cwd: '/workspace' });
    respond(harness, (await waitForRequest(harness, 'thread/read')).id, {
      thread: { id: 'thread-1', turns: [{
        id: 'turn-old', startedAt: 1, completedAt: 2,
        items: [{ type: 'agentMessage', id: 'old-message', text: 'History' }],
      }] },
    });
    const session = await starting;
    const iterator = session.observe()[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: {
      type: 'observation', delivery: 'history', sourceKey: 'item:old-message:completed',
    } });
    await expect(iterator.next()).resolves.toEqual({ value: { type: 'history_boundary' }, done: false });

    harness.child.stdout.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: {
      threadId: 'thread-1', turnId: 'turn-live', itemId: 'live-message', delta: 'Live',
    } })}\n`);
    await expect(iterator.next()).resolves.toMatchObject({ value: {
      type: 'observation', delivery: 'live', event: {
        type: 'timeline', item: { type: 'assistant_message', text: 'Live' },
      },
    } });
    await session.dispose();
  });

  it('absorbs item notifications already represented by a concurrent thread read', async () => {
    const harness = createSessionHarness();
    const starting = CodexAppServerSession.resume(harness.transport, {
      providerId: 'codex', sessionId: 'thread-1', opaque: JSON.stringify({ cwd: '/workspace' }),
    });
    respond(harness, (await waitForRequest(harness, 'initialize')).id, {});
    respond(harness, (await waitForRequest(harness, 'thread/resume')).id, {
      thread: { id: 'thread-1' }, model: 'gpt-5.4', cwd: '/workspace',
    });
    const readRequest = await waitForRequest(harness, 'thread/read');

    harness.child.stdout.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: {
      threadId: 'thread-1', turnId: 'turn-overlap', itemId: 'overlap-message', delta: 'Hello',
    } })}\n`);
    respond(harness, readRequest.id, {
      thread: { id: 'thread-1', turns: [{
        id: 'turn-overlap', startedAt: 1, completedAt: 2,
        items: [{ type: 'agentMessage', id: 'overlap-message', text: 'Hello' }],
      }] },
    });
    const session = await starting;
    const iterator = session.observe()[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: {
      type: 'observation', delivery: 'history', sourceKey: 'item:overlap-message:completed',
    } });
    await expect(iterator.next()).resolves.toEqual({
      value: { type: 'history_boundary' }, done: false,
    });

    harness.child.stdout.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: {
      threadId: 'thread-1', turnId: 'turn-live', itemId: 'live-message', delta: 'After boundary',
    } })}\n`);
    await expect(iterator.next()).resolves.toMatchObject({ value: {
      type: 'observation', delivery: 'live',
      sourceKey: expect.stringMatching(/^item:live-message:assistant:delta:[0-9a-f]{8}$/),
      event: { type: 'timeline', item: { type: 'assistant_message', text: 'After boundary' } },
    } });
    await session.dispose();
  });

  it('preserves a buffered completion that extends the concurrent history item', async () => {
    const harness = createSessionHarness();
    const starting = CodexAppServerSession.resume(harness.transport, {
      providerId: 'codex', sessionId: 'thread-1', opaque: JSON.stringify({ cwd: '/workspace' }),
    });
    respond(harness, (await waitForRequest(harness, 'initialize')).id, {});
    respond(harness, (await waitForRequest(harness, 'thread/resume')).id, {
      thread: { id: 'thread-1' }, model: 'gpt-5.4', cwd: '/workspace',
    });
    const readRequest = await waitForRequest(harness, 'thread/read');

    harness.child.stdout.write(`${JSON.stringify({
      method: 'item/completed', params: {
        threadId: 'thread-1', turnId: 'turn-overlap',
        item: { type: 'agentMessage', id: 'overlap-message', text: 'Hello' },
      },
    })}\n`);
    respond(harness, readRequest.id, {
      thread: { id: 'thread-1', turns: [{
        id: 'turn-overlap', startedAt: 1,
        items: [{ type: 'agentMessage', id: 'overlap-message', text: 'Hel' }],
      }] },
    });
    const session = await starting;
    const iterator = session.observe()[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: {
      type: 'observation', delivery: 'history',
      event: { type: 'timeline', item: { type: 'assistant_message', text: 'Hel' } },
    } });
    await expect(iterator.next()).resolves.toEqual({
      value: { type: 'history_boundary' }, done: false,
    });
    await expect(iterator.next()).resolves.toMatchObject({ value: {
      type: 'observation', delivery: 'live',
      event: { type: 'timeline', item: { type: 'assistant_message', text: 'lo' } },
    } });
    await session.dispose();
  });

  it('starts turns with text, model, and reasoning effort', async () => {
    const harness = createSessionHarness();
    const starting = CodexAppServerSession.create(harness.transport, {
      sessionId: 'local', cwd: '/workspace', model: 'gpt-5.4', reasoningEffort: 'high',
    });
    respond(harness, (await waitForRequest(harness, 'initialize')).id, {});
    respond(harness, (await waitForRequest(harness, 'thread/start')).id, {
      thread: { id: 'thread-1' }, model: 'gpt-5.4', cwd: '/workspace', reasoningEffort: 'high',
    });
    const session = await starting;
    const send = session.sendMessage('Hello Codex');
    const turnStart = await waitForRequest(harness, 'turn/start');

    expect(turnStart.params).toEqual({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'Hello Codex', text_elements: [] }],
      model: 'gpt-5.4',
      effort: 'high',
    });
    respond(harness, turnStart.id, { turn: { id: 'turn-1' } });
    await send;
    await session.dispose();
  });

  it('projects native thread settings and status into runtime updates', async () => {
    const harness = createSessionHarness();
    const starting = CodexAppServerSession.create(harness.transport, {
      sessionId: 'local', cwd: '/workspace', model: 'gpt-5.4',
    });
    respond(harness, (await waitForRequest(harness, 'initialize')).id, {});
    respond(harness, (await waitForRequest(harness, 'thread/start')).id, {
      thread: { id: 'thread-1' }, model: 'gpt-5.4', cwd: '/workspace',
    });
    const session = await starting;
    const iterator = session.observe()[Symbol.asyncIterator]();
    await iterator.next();

    harness.child.stdout.write(`${JSON.stringify({
      method: 'thread/settings/updated', params: {
        threadId: 'thread-1',
        threadSettings: {
          cwd: '/next-workspace', model: 'gpt-5.6-codex', effort: 'high',
          collaborationMode: { mode: 'plan', settings: { model: 'gpt-5.6-codex' } },
        },
      },
    })}\n`);
    await expect(iterator.next()).resolves.toMatchObject({ value: {
      event: { type: 'runtime_updated', runtimeInfo: {
        providerId: 'codex', sessionId: 'thread-1', status: 'idle',
        cwd: '/next-workspace', model: 'gpt-5.6-codex', mode: 'plan',
      } },
    } });

    harness.child.stdout.write(`${JSON.stringify({
      method: 'thread/status/changed', params: {
        threadId: 'thread-1', status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
      },
    })}\n`);
    await expect(iterator.next()).resolves.toMatchObject({ value: {
      event: { type: 'runtime_updated', runtimeInfo: { status: 'waiting' } },
    } });
    await expect(session.runtimeInfo()).resolves.toMatchObject({
      status: 'waiting', cwd: '/next-workspace', model: 'gpt-5.6-codex', mode: 'plan',
    });
    await session.dispose();
  });

  it('closes a pending interaction when Codex reports that its server request was resolved', async () => {
    const harness = createSessionHarness();
    const starting = CodexAppServerSession.create(harness.transport, { sessionId: 'local', cwd: '/workspace' });
    respond(harness, (await waitForRequest(harness, 'initialize')).id, {});
    respond(harness, (await waitForRequest(harness, 'thread/start')).id, {
      thread: { id: 'thread-1' }, model: 'gpt-5.4', cwd: '/workspace',
    });
    const session = await starting;
    const iterator = session.observe()[Symbol.asyncIterator]();
    await iterator.next();

    harness.child.stdout.write(`${JSON.stringify({
      id: 7, method: 'item/tool/requestUserInput', params: {
        threadId: 'thread-1', turnId: 'turn-1', itemId: 'question-tool-1', isBlocking: true,
        questions: [{
          id: 'confirm', header: 'Confirm', question: 'Continue?', isOther: false, isSecret: false,
          options: [{ label: 'Yes', description: 'Continue' }],
        }],
      },
    })}\n`);
    await expect(iterator.next()).resolves.toMatchObject({ value: {
      event: { type: 'interaction_requested', request: { requestId: 'question:7' } },
    } });

    harness.child.stdout.write(`${JSON.stringify({
      method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 7 },
    })}\n`);
    await expect(iterator.next()).resolves.toMatchObject({ value: {
      event: {
        type: 'interaction_resolved', requestId: 'question:7',
        response: { kind: 'question', answers: [], dismissed: true },
      },
    } });
    await expect(session.respondToInteraction('question:7', {
      kind: 'question', answers: [], dismissed: true,
    })).rejects.toThrow('No pending Codex interaction question:7');
    await session.dispose();
  });

  it('round-trips a strict question response without choosing a fallback option', async () => {
    const harness = createSessionHarness();
    const starting = CodexAppServerSession.create(harness.transport, { sessionId: 'local', cwd: '/workspace' });
    respond(harness, (await waitForRequest(harness, 'initialize')).id, {});
    respond(harness, (await waitForRequest(harness, 'thread/start')).id, { thread: { id: 'thread-1' }, model: 'gpt-5.4', cwd: '/workspace' });
    const session = await starting;
    const iterator = session.observe()[Symbol.asyncIterator]();
    await iterator.next();
    const responseLine = once(harness.child.stdin, 'data');

    harness.child.stdout.write(`${JSON.stringify({
      id: 'native-question-1', method: 'item/tool/requestUserInput', params: {
        threadId: 'thread-1', turnId: 'turn-1', itemId: 'question-tool-1', isBlocking: true,
        questions: [{
          id: 'path', header: 'Path', question: 'Which path?', isOther: true, isSecret: false,
          options: [{ label: 'A', description: 'Use A' }, { label: 'B', description: 'Use B' }],
        }],
      },
    })}\n`);
    const requested = await iterator.next();
    expect(requested.value).toMatchObject({ event: { type: 'interaction_requested', request: {
      kind: 'question', requestId: 'question:native-question-1', questions: [{
        questionId: 'path', selection: 'single', allowCustomText: true,
        options: [{ value: 'A', label: 'A' }, { value: 'B', label: 'B' }],
      }],
    } } });

    await session.respondToInteraction('question:native-question-1', {
      kind: 'question', answers: [{ questionId: 'path', selectedValues: [], customText: 'A custom path' }],
    });
    const [chunk] = await responseLine;
    expect(String(chunk)).toContain('"answers":{"path":{"answers":["A custom path"]}}');
    expect(String(chunk)).not.toContain('"A"');
    await session.dispose();
  });

  it.each([
    ['missing command fields', {}],
    ['empty command and reason', { command: '', reason: '' }],
  ])('encodes a command approval with %s as a schema-valid generic tool request', async (_caseName, nativeParams) => {
    const harness = createSessionHarness();
    const starting = CodexAppServerSession.create(harness.transport, { sessionId: 'local', cwd: '/workspace' });
    respond(harness, (await waitForRequest(harness, 'initialize')).id, {});
    respond(harness, (await waitForRequest(harness, 'thread/start')).id, {
      thread: { id: 'thread-1' }, model: 'gpt-5.4', cwd: '/workspace',
    });
    const session = await starting;
    const iterator = session.observe()[Symbol.asyncIterator]();
    await iterator.next();
    const responseLine = once(harness.child.stdin, 'data');

    harness.child.stdout.write(`${JSON.stringify({
      id: 'native-command-missing', method: 'item/commandExecution/requestApproval', params: {
        threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-tool-1',
        ...nativeParams,
      },
    })}\n`);
    const requested = await iterator.next();
    if (requested.done || requested.value.type !== 'observation' || requested.value.event.type !== 'interaction_requested') {
      throw new Error('Expected a Codex command approval request');
    }
    const request = requested.value.event.request;
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'interaction_requested' as const,
      payload: { agentId: 'agent-1', request },
    };

    expect(decodeServerMessage(JSON.stringify(message))).toEqual({ status: 'ok', value: message });
    expect(request).toMatchObject({
      kind: 'tool_approval', requestId: 'tool:native-command-missing',
      detail: { type: 'other', description: 'Run a command' },
    });

    await session.respondToInteraction('tool:native-command-missing', {
      kind: 'tool_approval', decision: 'deny', message: 'Not now',
    });
    const [chunk] = await responseLine;
    expect(JSON.parse(String(chunk))).toEqual({ id: 'native-command-missing', result: { decision: 'decline' } });
    await session.dispose();
  });

  it('preserves a native command approval and maps a session approval response', async () => {
    const harness = createSessionHarness();
    const starting = CodexAppServerSession.create(harness.transport, { sessionId: 'local', cwd: '/workspace' });
    respond(harness, (await waitForRequest(harness, 'initialize')).id, {});
    respond(harness, (await waitForRequest(harness, 'thread/start')).id, {
      thread: { id: 'thread-1' }, model: 'gpt-5.4', cwd: '/workspace',
    });
    const session = await starting;
    const iterator = session.observe()[Symbol.asyncIterator]();
    await iterator.next();
    const responseLine = once(harness.child.stdin, 'data');

    harness.child.stdout.write(`${JSON.stringify({
      id: 'native-command-present', method: 'item/commandExecution/requestApproval', params: {
        threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-tool-2',
        command: 'pnpm test', cwd: '/workspace', reason: 'Run the test suite',
      },
    })}\n`);
    const requested = await iterator.next();
    expect(requested).toMatchObject({ value: { event: { type: 'interaction_requested', request: {
      kind: 'tool_approval', requestId: 'tool:native-command-present', summary: 'Run the test suite',
      detail: { type: 'shell', command: 'pnpm test', cwd: '/workspace' },
    } } } });

    await session.respondToInteraction('tool:native-command-present', {
      kind: 'tool_approval', decision: 'allow', scope: 'session',
    });
    const [chunk] = await responseLine;
    expect(JSON.parse(String(chunk))).toEqual({ id: 'native-command-present', result: { decision: 'acceptForSession' } });
    await session.dispose();
  });

  it('rejects stale and invalid question responses instead of guessing', async () => {
    const harness = createSessionHarness();
    const starting = CodexAppServerSession.create(harness.transport, { sessionId: 'local' });
    respond(harness, (await waitForRequest(harness, 'initialize')).id, {});
    respond(harness, (await waitForRequest(harness, 'thread/start')).id, { thread: { id: 'thread-1' }, model: 'gpt-5.4', cwd: '/workspace' });
    const session = await starting;

    await expect(session.respondToInteraction('missing', { kind: 'question', answers: [] }))
      .rejects.toThrow('No pending Codex interaction missing');
    await session.dispose();
  });
});
