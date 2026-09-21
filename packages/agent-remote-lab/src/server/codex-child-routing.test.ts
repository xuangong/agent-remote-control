// @vitest-environment node
import { expect, it } from 'vitest';
import WebSocket from 'ws';
import { CodexAppServerProvider } from '@orchardworks/agent-provider-codex';
import {
  AgentReplica, HttpWebSocketTransport, RemoteSessionClient,
  type RemoteSessionStatus, type WebSocketLike,
} from '@orchardworks/agent-remote-web';
import { createFakeChildProcess, type FakeChildProcess } from '../../../agent-provider-codex/src/test-utils/fake-child.js';
import { createProtocolValidationServer } from '../server.js';
import { createCodexDirectory } from './codex-directory.js';

const origin = 'http://127.0.0.1:5175';
const childThread = {
  id: 'native-child', parentThreadId: 'native-parent', agentNickname: 'Transport reviewer', agentRole: 'explorer',
  createdAt: 100, cwd: '/workspace', status: { type: 'active', activeFlags: [] }, canAcceptDirectInput: true,
  turns: [{ id: 'child-turn', status: 'inProgress', items: [{ id: 'child-history', type: 'agentMessage', text: 'Child history before attachment' }] }],
};

function scriptedCodex() {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const replies: Array<{ process: FakeChildProcess; message: Record<string, unknown> }> = [];
  let runtime: FakeChildProcess | undefined;
  const write = (process: FakeChildProcess, value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const provider = new CodexAppServerProvider({ requestTimeoutMs: 3_000, spawn() {
    const process = createFakeChildProcess();
    let buffered = '';
    process.stdin.on('data', (chunk) => {
      buffered += String(chunk);
      const lines = buffered.split('\n');
      buffered = lines.pop()!;
      for (const line of lines.filter(Boolean)) {
        const message = JSON.parse(line);
        if (!message.method) { replies.push({ process, message }); continue; }
        if (message.id === undefined) continue;
        requests.push(message);
        let result: unknown = { data: [] };
        if (message.method === 'model/list') result = { data: [{ model: 'codex', displayName: 'Codex' }] };
        if (message.method === 'configRequirements/read') result = { requirements: null };
        if (message.method === 'thread/start') {
          runtime = process;
          result = { thread: { id: 'native-parent' }, cwd: '/workspace', model: 'codex' };
        }
        if (message.method === 'thread/read') {
          result = { thread: { ...childThread, turns: message.params.includeTurns ? childThread.turns : [] } };
        }
        if (message.method === 'thread/turns/list') {
          result = { data: [...childThread.turns].reverse(), nextCursor: null };
        }
        queueMicrotask(() => write(process, { id: message.id, result }));
      }
    });
    return process;
  } });
  return {
    provider, requests, replies,
    runtime: () => runtime,
    emit(value: unknown) {
      if (!runtime) throw new Error('The parent native runtime must be created before emitting notifications.');
      write(runtime, value);
    },
  };
}

function messages(replica: AgentReplica): string[] {
  return replica.getState().timeline.entries.flatMap(({ item }) => item.type === 'assistant_message' ? [item.text] : []);
}

it('routes an unopened child approval through directory attachment and the real Remote wire without mixing parent output', async () => {
  const native = scriptedCodex();
  const server = createProtocolValidationServer({
    providers: [native.provider], directories: [createCodexDirectory(native.provider, '/workspace')], labOrigin: origin,
  });
  const clients: RemoteSessionClient[] = [];
  try {
    const { url } = await server.http.listen(0, '127.0.0.1');
    const post = async (path: string, body: unknown): Promise<{ agentId: string; nativeSessionId: string }> => {
      const response = await fetch(`${url}/v1/remote/${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body), signal: AbortSignal.timeout(3_000),
      });
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);
      return result;
    };
    const transport = new HttpWebSocketTransport(url, {
      webSocketFactory: (address) => new WebSocket(address, { origin }) as unknown as WebSocketLike,
    });
    const connect = async (agentId: string) => {
      const replica = new AgentReplica();
      const client = new RemoteSessionClient(agentId, transport, replica, { historyPageSize: 100, operationTimeoutMs: 3_000 });
      clients.push(client);
      let status: RemoteSessionStatus = 'idle';
      client.subscribeStatus((value) => { status = value; });
      client.start();
      await expect.poll(() => status, { timeout: 3_000 }).toBe('ready');
      return { client, replica };
    };
    const parent = await post('create', { providerId: 'codex', operationId: '00000000-0000-4000-8000-000000000001', workspaceId: '/workspace' });
    expect(parent.nativeSessionId).toBe('native-parent');
    const parentView = await connect(parent.agentId);
    native.emit({ method: 'item/agentMessage/delta', params: { threadId: 'native-parent', turnId: 'parent-turn', itemId: 'parent-reply', delta: 'Parent reply' } });
    native.emit({ method: 'item/completed', params: {
      threadId: 'native-parent', turnId: 'parent-turn', item: { type: 'collabAgentToolCall', id: 'spawn-child', tool: 'spawnAgent', status: 'completed',
        senderThreadId: 'native-parent', receiverThreadIds: ['native-child'], prompt: 'Review transport', agentsStates: { 'native-child': { status: 'running', message: null } } },
    } });
    native.emit({ id: 'native-child-approval', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'native-child', turnId: 'child-turn', itemId: 'child-command', command: 'echo approved', cwd: '/workspace',
    } });
    await expect.poll(() => parentView.replica.getState().agent?.runtimeInfo.childSessions, { timeout: 3_000 }).toMatchObject([{
      nativeSessionId: 'native-child', parentTurnId: 'parent-turn', parentCallId: 'spawn-child', status: 'waiting',
    }]);
    expect(parentView.replica.getState().pendingInteractions).toEqual([]);
    expect(native.replies.find(({ message }) => message.id === 'native-child-approval')).toBeUndefined();

    const child = await post('child/attach', { providerId: 'codex', parentNativeSessionId: parent.nativeSessionId, nativeSessionId: 'native-child' });
    expect(child.agentId).not.toBe(parent.agentId);
    const childView = await connect(child.agentId);
    await expect.poll(() => childView.replica.getState().pendingInteractions, { timeout: 3_000 }).toMatchObject([{
      kind: 'tool_approval', requestId: 'tool:native-child-approval',
    }]);
    expect(messages(childView.replica)).toEqual(['Child history before attachment']);
    await childView.client.respondToInteraction('tool:native-child-approval', { kind: 'tool_approval', decision: 'allow', scope: 'once' });
    await expect.poll(() => native.replies.find(({ message }) => message.id === 'native-child-approval')?.message, { timeout: 3_000 }).toEqual({
      id: 'native-child-approval', result: { decision: 'accept' },
    });
    expect(native.replies.find(({ message }) => message.id === 'native-child-approval')?.process).toBe(native.runtime());
    expect(childView.replica.getState().pendingInteractions).toEqual([]);
    native.emit({ method: 'item/agentMessage/delta', params: { threadId: 'native-child', turnId: 'child-turn', itemId: 'child-live', delta: 'Child continued after approval' } });
    await expect.poll(() => messages(childView.replica), { timeout: 3_000 }).toEqual(['Child history before attachment', 'Child continued after approval']);
    expect(messages(parentView.replica)).toEqual(['Parent reply']);
    expect(parentView.replica.getState().pendingInteractions).toEqual([]);
    expect(native.requests.filter(({ method }) => method === 'thread/start')).toHaveLength(1);
    expect(native.requests.filter(({ method }) => method === 'thread/resume')).toHaveLength(0);
  } finally {
    for (const client of clients) client.stop();
    await server.close();
  }
}, 10_000);
