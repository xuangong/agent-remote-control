import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AgentSession, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { CodexAppServerProvider } from './provider.js';
import { spawnCodexAppServer } from './native.js';

async function fixture(tool = false) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'arc-codex-evidence-')));
  const home = join(directory, 'home'); await mkdir(home);
  const bodies: any[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      if (request.method !== 'POST' || request.url !== '/v1/responses') { response.writeHead(404).end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); bodies.push(body);
      const userInputs = body.input?.filter((item: any) => item.role === 'user').length ?? 0;
      const callId = `source-call-${userInputs}`;
      const toolOutput = body.input?.some((item: any) => item.type === 'function_call_output' && item.call_id === callId);
      const id = `response-${bodies.length}`;
      response.setHeader('content-type', 'text/event-stream');
      response.end([
        { type: 'response.created', response: { id } },
        { type: 'response.output_item.done', item: tool && !toolOutput
          ? { type: 'function_call', id: `source-function-${userInputs}`, call_id: callId, name: 'read_source_session', arguments: '{}' }
          : { type: 'message', role: 'assistant', id: `answer-${bodies.length}`, content: [{ type: 'output_text', text: 'EVIDENCE_NATIVE_OK' }] } },
        { type: 'response.completed', response: { id, usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } },
      ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  await writeFile(join(home, 'config.toml'), `model = "mock-model"\nmodel_provider = "mock"\nmodel_reasoning_effort = "medium"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[features]\nplugins = false\n[model_providers.mock]\nname = "Local succession evidence test"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
  const diagnostics: string[] = [];
  const provider = new CodexAppServerProvider({ executable: process.env.ARC_CODEX_SUCCESSION_TEST_EXECUTABLE, onDiagnostic: line => diagnostics.push(line),
    spawn: ({ cwd }) => {
      const child = spawnCodexAppServer({ executable: process.env.ARC_CODEX_SUCCESSION_TEST_EXECUTABLE, cwd,
        env: { CODEX_HOME: home, OPENAI_API_KEY: 'local-test', LC_ALL: 'C' } });
      child.stdout.on('data', chunk => diagnostics.push(String(chunk)));
      return child;
    },
    env: { CODEX_HOME: home, OPENAI_API_KEY: 'local-test', LC_ALL: 'C' }, requestTimeoutMs: 10000 });
  const sessions: AgentSession[] = [];
  return { directory, provider, bodies, sessions, diagnostics, async close() {
    await Promise.allSettled(sessions.map(session => session.dispose()));
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  } };
}

const observations = new WeakMap<AgentSession, AsyncIterator<ProviderStreamItem>>();
async function completed(session: AgentSession, run: () => Promise<unknown>): Promise<void> {
  let stream = observations.get(session);
  if (!stream) {
    stream = session.observe()[Symbol.asyncIterator](); observations.set(session, stream);
    for (;;) { const item = await stream.next(); if (item.done || item.value.type === 'history_boundary') break; }
  }
  await run();
  for (;;) {
    const item = await stream.next(); if (item.done) throw new Error('Native stream ended');
    if (item.value.type !== 'observation') continue;
    if (item.value.event.type === 'turn_failed') throw new Error(item.value.event.error);
    if (item.value.event.type === 'turn_completed') return;
  }
}

async function select(session: AgentSession, id: string, value: string): Promise<void> {
  await session.setSessionSetting!(id, value);
  await expect.poll(async () => (await session.runtimeInfo()).settings?.find(setting => setting.id === id)?.value,
    { timeout: 5000 }).toBe(value);
}

it.runIf(!!process.env.ARC_CODEX_SUCCESSION_TEST_EXECUTABLE)('creates zero-turn native state, starts the exact first input once, and inspects it after a cold resume', async () => {
  const f = await fixture();
  try {
    const creation = await f.provider.nativeEvidence.createEmpty({ sessionId: 'successor', cwd: f.directory });
    if (creation.status !== 'created') throw new Error(JSON.stringify({ creation, diagnostics: f.diagnostics }));
    expect(f.bodies).toHaveLength(0);
    const session = await f.provider.resumeSession(creation.handle).catch(error => { throw new Error(`${String(error)}\n${f.diagnostics.join('\n')}`); }); f.sessions.push(session);
    expect(f.bodies).toHaveLength(0);
    const readiness = await session.nativeEvidence!.inspectReadiness().catch(error => { throw new Error(`${String(error)}\n${f.diagnostics.join('\n')}`); });
    expect(readiness).toEqual({ cwd: f.directory, idle: true, pendingInputs: 0, pendingInteractions: 0, activeChildren: 0 });
    const witness = await session.nativeEvidence!.prepareInput([{ type: 'text', text: 'Frozen succession context\n\nFirst real input.' }]);
    expect(witness.selections.reasoningEffort).toBe('medium');
    await completed(session, async () => expect(await session.nativeEvidence!.dispatchInput(witness)).toEqual({ disposition: 'started' }));
    expect(f.bodies).toHaveLength(1);
    const proof = await session.nativeEvidence!.inspectInput(witness);
    expect(proof).toMatchObject({ status: 'materialized', proof: { inputId: witness.inputId }, execution: { disposition: 'started' } });
    const persistence = (await session.runtimeInfo()).persistence!;
    await session.dispose();
    const resumed = await f.provider.resumeSession(persistence); f.sessions.push(resumed);
    expect(await resumed.nativeEvidence!.inspectInput(witness)).toEqual(proof);
    expect(f.bodies).toHaveLength(1);
  } finally { await f.close(); }
}, 30000);

it.runIf(!!process.env.ARC_CODEX_SUCCESSION_TEST_EXECUTABLE)('preserves same-provider selections and does not overwrite later native settings with the original creation handle', async () => {
  const f = await fixture();
  try {
    const source = await f.provider.createSession({ sessionId: 'source', cwd: f.directory,
      systemPrompt: 'Act as a careful reviewer.', instructions: 'Keep the agreed acceptance criteria.' }); f.sessions.push(source);
    const model = (await source.runtimeInfo()).settings?.find(setting => setting.id === 'model')?.options[0]?.value;
    if (!model) throw new Error('Native model catalog is empty');
    await select(source, 'model', model);
    await select(source, 'effort', 'high');
    await select(source, 'approval', 'on-request');
    await select(source, 'sandbox', 'workspaceWrite');
    await source.setPlanning!(true);
    const expected = (await source.nativeEvidence!.prepareInput([{ type: 'text', text: 'selection probe' }])).selections;
    expect(expected.system).toBe('Act as a careful reviewer.\n\nKeep the agreed acceptance criteria.');
    const creation = await f.provider.nativeEvidence.createEmpty({ sessionId: 'successor', cwd: f.directory,
      selectionSourceSessionId: (await source.runtimeInfo()).persistence!.sessionId });
    if (creation.status !== 'created') throw new Error(JSON.stringify({ creation, diagnostics: f.diagnostics }));
    expect(f.bodies).toHaveLength(0);
    const target = await f.provider.resumeSession(creation.handle); f.sessions.push(target);
    expect((await target.runtimeInfo()).planning?.active).toBe(true);
    const witness = await target.nativeEvidence!.prepareInput([{ type: 'text', text: 'first real input' }]);
    expect(witness.selections).toEqual(expected);
    expect(JSON.parse(witness.selections.providerOptions!).collaborationMode.mode).toBe('plan');
    await completed(target, () => target.nativeEvidence!.dispatchInput(witness));
    await select(target, 'effort', 'low');
    await select(target, 'approval', 'never');
    await select(target, 'sandbox', 'readOnly');
    await completed(target, () => target.sendMessage('Persist the current native selections.'));
    const current = (await target.nativeEvidence!.prepareInput([{ type: 'text', text: 'next' }])).selections;
    await target.dispose();
    const restored = await f.provider.resumeSession(creation.handle); f.sessions.push(restored);
    expect((await restored.nativeEvidence!.prepareInput([{ type: 'text', text: 'next' }])).selections).toEqual(current);
    expect(f.bodies).toHaveLength(2);
  } finally { await f.close(); }
}, 30000);

it.runIf(!!process.env.ARC_CODEX_SUCCESSION_TEST_EXECUTABLE)('retains native dynamic tools after cold resume and dispatches them through the rebound Host handler', async () => {
  const f = await fixture(true); let calls = 0;
  const tools = [{ name: 'read_source_session', description: 'Read the source session', inputSchema: { type: 'object', properties: {} },
    execute: async () => { calls++; return 'SOURCE_NATIVE_OK'; } }];
  try {
    const created = await f.provider.createSession({ sessionId: 'source-reader', cwd: f.directory, tools }); f.sessions.push(created);
    await completed(created, () => created.sendMessage('Initialize the source reader.'));
    const handle = (await created.runtimeInfo()).persistence!;
    await created.dispose();
    const beforeResume = f.bodies.length;
    const resumed = await f.provider.resumeSession(handle, { tools }); f.sessions.push(resumed);
    await completed(resumed, () => resumed.sendMessage('Read the source.'));
    expect(calls).toBe(2);
    expect(f.bodies[beforeResume].tools).toContainEqual(expect.objectContaining({ name: 'read_source_session' }));
    expect(f.bodies.some(body => body.input?.some((item: any) => item.type === 'function_call_output' && JSON.stringify(item).includes('SOURCE_NATIVE_OK')))).toBe(true);
  } finally { await f.close(); }
}, 30000);

it.runIf(!!process.env.ARC_CODEX_SUCCESSION_TEST_EXECUTABLE)('an empty successor created with a role carries its instructions and tools into its first turn', async () => {
  const f = await fixture(true); let calls = 0;
  const tool = { name: 'read_source_session', description: 'Read the source session', inputSchema: { type: 'object', properties: {} },
    execute: async () => { calls++; return 'ROLE_TOOL_OK'; } };
  try {
    const creation = await f.provider.nativeEvidence.createEmpty({ sessionId: 'successor', cwd: f.directory,
      extensions: { instructions: 'You hold the Team role.', tools: [{ ...tool, execute: async () => { throw new Error('Not attached'); } }] } });
    if (creation.status !== 'created') throw new Error(JSON.stringify({ creation, diagnostics: f.diagnostics }));
    const session = await f.provider.resumeSession(creation.handle, { instructions: 'You hold the Team role.', tools: [tool] }); f.sessions.push(session);
    await completed(session, () => session.sendMessage('Use your role.'));
    expect(calls).toBe(1);
    const request = JSON.stringify(f.bodies[0]);
    expect(request).toContain('You hold the Team role.');
    expect(f.bodies[0].tools?.some((item: { name?: string }) => item.name === 'read_source_session')).toBe(true);
  } finally { await f.close(); }
}, 30000);
