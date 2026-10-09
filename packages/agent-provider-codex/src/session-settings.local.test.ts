import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AgentSession } from '@orchardworks/agent-provider-sdk';
import { CodexAppServerProvider } from './provider.js';

function finishResponse(response: ServerResponse): void {
  response.setHeader('content-type', 'text/event-stream');
  response.end([
    { type: 'response.created', response: { id: 'settings-response' } },
    { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'settings-answer', content: [{ type: 'output_text', text: 'SETTINGS_OK' }] } },
    { type: 'response.completed', response: { id: 'settings-response', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}

it.each(['approval', 'sandbox'])('queues native %s changes during a running response and confirms them without interruption', async id => {
  const home = await mkdtemp(join(tmpdir(), 'arc-native-settings-'));
  const inputs: Array<{ model: string; reasoning?: { effort?: string } }> = [];
  let heldResponse: ServerResponse | undefined;
  let releaseResponses = false;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      if (request.url !== '/v1/responses') { response.writeHead(404).end(); return; }
      inputs.push(JSON.parse(Buffer.concat(chunks).toString()));
      if (releaseResponses) finishResponse(response);
      else heldResponse = response;
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local address');
  await writeFile(join(home, 'config.toml'), `model = "gpt-5.4"\nmodel_reasoning_effort = "high"\nmodel_provider = "mock"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.mock]\nname = "Local settings transport"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
  const provider = new CodexAppServerProvider({
    executable: process.env.BORGEE_CODEX_TEST_EXECUTABLE ?? 'codex',
    env: { CODEX_HOME: home, OPENAI_API_KEY: 'local-settings-test' }, requestTimeoutMs: 10000,
  });
  let session: AgentSession | undefined;
  try {
    session = await provider.createSession({ sessionId: 'settings-native', cwd: home, model: 'gpt-5.4' });
    const nativeModel = (await session.runtimeInfo()).settings?.find(setting => setting.id === 'model')?.options[0]?.value;
    if (!nativeModel) throw new Error('Native model catalog is empty');
    await session.setSessionSetting!('model', nativeModel);
    await expect.poll(async () => (await session!.runtimeInfo()).model, { timeout: 10000 }).toBe(nativeModel);
    const stream = session.observe()[Symbol.asyncIterator]();
    await expect(stream.next()).resolves.toMatchObject({ value: { type: 'history_boundary' } });
    const setting = (await session.runtimeInfo()).settings?.find(setting => setting.id === id);
    expect(setting?.mutable).toBe(true);
    const value = id === 'model' ? setting?.options.find(option => option.value !== setting.value)?.value
      : id === 'effort' ? setting?.options.find(option => option.value !== setting.value)?.value : id === 'approval' ? 'on-request' : 'workspaceWrite';
    if (!value) throw new Error('Native model catalog has no alternative');
    await session.sendMessage('Reply with SETTINGS_OK.');
    await expect.poll(() => heldResponse !== undefined, { timeout: 10000 }).toBe(true);
    await expect(session.setSessionSetting!(id, value)).resolves.toEqual({ status: 'pending' });
    expect((await session.runtimeInfo()).settings?.find(setting => setting.id === id)?.value).toBe(setting?.value);
    releaseResponses = true;
    finishResponse(heldResponse!);
    const completed = async () => {
      for (;;) {
        const next = await stream.next();
        if (next.done) throw new Error('Native stream ended before turn completion');
        if (next.value.type !== 'observation') continue;
        const event = next.value.event;
        if (event.type === 'turn_failed' || event.type === 'turn_canceled') throw new Error(JSON.stringify(event));
        if (event.type === 'turn_completed') return;
      }
    };
    await completed();
    expect((await session.runtimeInfo({ refreshSettings: true })).settings?.find(setting => setting.id === id)?.value).toBe(value);
    expect(inputs).toHaveLength(1);
    await session.sendMessage('Reply with SETTINGS_OK again.');
    await completed();
    expect(inputs).toHaveLength(2);
    if (id === 'model') expect(inputs[1]?.model).toBe(value);
    if (id === 'effort') expect(inputs[1]?.reasoning?.effort).toBe(value);
  } finally {
    heldResponse?.destroy();
    await session?.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
}, 30000);

it.each([true, false])('applies repeated native changes at step boundaries when live switching is %s', async enabled => {
  const home = await mkdtemp(join(tmpdir(), 'arc-native-step-settings-'));
  const inputs: Array<{ model: string; reasoning?: { effort?: string } }> = [];
  const responses: ServerResponse[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      if (request.url !== '/v1/responses') { response.writeHead(404).end(); return; }
      inputs.push(JSON.parse(Buffer.concat(chunks).toString()));
      responses.push(response);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local address');
  const catalog = new URL('./test-utils/step-model-catalog.json', import.meta.url).pathname;
  await writeFile(join(home, 'config.toml'), `model = "step-settings-a"
model_catalog_json = ${JSON.stringify(catalog)}
model_reasoning_effort = "high"
model_provider = "mock"
approval_policy = "never"
sandbox_mode = "read-only"
[features]
step_model_switching = ${enabled}
[model_providers.mock]
name = "Local step settings transport"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`);
  const provider = new CodexAppServerProvider({ executable: process.env.BORGEE_CODEX_TEST_EXECUTABLE ?? 'codex',
    env: { CODEX_HOME: home, OPENAI_API_KEY: 'local-settings-test' }, requestTimeoutMs: 10000 });
  let session: AgentSession | undefined;
  const nextStep = (index: number) => {
    const response = responses[index]!;
    response.setHeader('content-type', 'text/event-stream');
    response.end([
      { type: 'response.created', response: { id: `step-${index}` } },
      { type: 'response.output_item.done', item: { type: 'function_call', name: 'exec_command', call_id: `call-${index}`, arguments: JSON.stringify({ cmd: 'printf step-boundary', max_output_tokens: 20 }) } },
      { type: 'response.completed', response: { id: `step-${index}`, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  };
  try {
    session = await provider.createSession({ sessionId: 'step-settings-native', cwd: home, model: 'step-settings-a' });
    const stream = session.observe()[Symbol.asyncIterator]();
    await stream.next();
    const completedTurnIds: string[] = [];
    const completed = async () => {
      for (;;) {
        const next = await stream.next();
        if (next.done) throw new Error('Native stream ended before completion');
        if (next.value.type !== 'observation') continue;
        const event = next.value.event;
        if (event.type === 'turn_failed' || event.type === 'turn_canceled') throw new Error(JSON.stringify(event));
        if (event.type === 'turn_completed') { completedTurnIds.push(event.turnId); return; }
      }
    };
    await session.sendMessage('Use exec_command to print step-boundary, then reply SETTINGS_OK.');
    await expect.poll(() => inputs.length, { timeout: 10000 }).toBe(1);
    await expect(session.setSessionSetting!('model', 'step-settings-b')).resolves.toEqual({ status: enabled ? 'pending' : 'deferred' });
    if (enabled) {
      nextStep(0);
      await expect.poll(() => inputs.length, { timeout: 10000 }).toBe(2);
      expect(inputs[1]).toMatchObject({ model: 'step-settings-b', reasoning: { effort: 'high' } });
      await expect(session.setSessionSetting!('effort', 'low')).resolves.toEqual({ status: 'pending' });
      nextStep(1);
      await expect.poll(() => inputs.length, { timeout: 10000 }).toBe(3);
      expect(inputs[2]).toMatchObject({ model: 'step-settings-b', reasoning: { effort: 'low' } });
      await expect(session.setSessionSetting!('model', 'step-settings-a')).resolves.toEqual({ status: 'pending' });
      nextStep(2);
      await expect.poll(() => inputs.length, { timeout: 10000 }).toBe(4);
      expect(inputs[3]).toMatchObject({ model: 'step-settings-a', reasoning: { effort: 'low' } });
    }
    finishResponse(responses.at(-1)!);
    await completed();
    if (!enabled) {
      await session.setSessionSetting!('model', 'step-settings-b');
      await expect.poll(async () => (await session!.runtimeInfo()).model, { timeout: 10000 }).toBe('step-settings-b');
    }
    expect(completedTurnIds).toHaveLength(1);
    const expected = enabled ? { model: 'step-settings-a', reasoning: { effort: 'low' } } : { model: 'step-settings-b', reasoning: { effort: 'high' } };
    await expect.poll(async () => (await session!.runtimeInfo({ refreshSettings: true })).model, { timeout: 10000 }).toBe(expected.model);
    await session.sendMessage('Reply SETTINGS_OK again.');
    await expect.poll(() => inputs.length, { timeout: 10000 }).toBe(enabled ? 5 : 2);
    expect(inputs.at(-1)).toMatchObject(expected);
    finishResponse(responses.at(-1)!);
    await completed();
    expect(new Set(completedTurnIds).size).toBe(2);
    expect(inputs[0]).toMatchObject({ model: 'step-settings-a', reasoning: { effort: 'high' } });
  } finally {
    for (const response of responses) response.destroy();
    await session?.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
}, 45000);
