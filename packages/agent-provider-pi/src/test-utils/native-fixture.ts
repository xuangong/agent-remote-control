import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TimelineStore, projectTimelineRows } from '@orchardworks/agent-timeline';
import type { AgentSession, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { piInvocation, resolvePiExecutable } from '../executable.js';
import { PiAgentProvider, type PiAgentProviderOptions } from '../provider.js';

/** One request the scripted model server receives: the OpenAI chat completions body pi sends. */
export interface ModelRequest { model: string; messages: Array<{ role: string; content: unknown; tool_calls?: unknown }>; tools?: Array<{ function: { name: string } }> }
export type ModelReply = string | { name: string; arguments: object } | { thinking: string; text: string };

/** The pi executable the native tests run: `AGENT_PI_TEST_EXECUTABLE`, or the pi the Controller would find. */
export const nativePiExecutable = (): string => resolvePiExecutable(process.env.AGENT_PI_TEST_EXECUTABLE);

const chunk = (body: ModelRequest, delta: unknown, finish: string | null = null) => ({ id: 'fixture-completion', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] });
const usage = (body: ModelRequest) => ({ id: 'fixture-completion', object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } });

/** Streams one scripted reply the way an OpenAI-compatible server does: text in two parts, or one tool call, then usage. */
export function reply(res: ServerResponse, body: ModelRequest, content: ModelReply): void {
  const parts: unknown[] = [];
  if (typeof content === 'string') parts.push(chunk(body, { role: 'assistant', content: content.slice(0, Math.ceil(content.length / 2)) }), chunk(body, { content: content.slice(Math.ceil(content.length / 2)) }), chunk(body, {}, 'stop'));
  else if ('thinking' in content) parts.push(chunk(body, { role: 'assistant', reasoning_content: content.thinking }), chunk(body, { content: content.text }), chunk(body, {}, 'stop'));
  else parts.push(chunk(body, { role: 'assistant', tool_calls: [{ index: 0, id: `fixture-tool-${crypto.randomUUID()}`, type: 'function', function: { name: content.name, arguments: JSON.stringify(content.arguments) } }] }), chunk(body, {}, 'tool_calls'));
  parts.push(usage(body));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(`${parts.map(part => `data: ${JSON.stringify(part)}\n\n`).join('')}data: [DONE]\n\n`);
}

export async function waitFor(test: () => unknown | Promise<unknown>, label = 'a native fixture condition'): Promise<void> {
  const end = Date.now() + 25_000;
  while (!await test()) { if (Date.now() > end) throw new Error(`Timed out waiting for ${label}.`); await new Promise(resolve => setTimeout(resolve, 20)); }
}

export function observe(session: AgentSession) {
  const items: ProviderStreamItem[] = [];
  const store = new TimelineStore('native-fixture');
  const done = (async () => { for await (const item of session.observe()) {
    items.push(item);
    if (item.type === 'observation' && item.event.type === 'timeline') store.append({ providerId: item.event.provider, sourceKey: item.sourceKey, nativeRevision: item.nativeRevision, occurredAt: item.occurredAt, turnId: item.event.turnId, item: item.event.item });
  } })().catch(() => undefined);
  return { items, done, timeline: () => projectTimelineRows(store.rows()), events: () => items.flatMap(item => item.type === 'observation' ? [item.event] : []) };
}

/**
 * A temporary pi profile whose only model is a scripted OpenAI-compatible server on loopback, and a provider over the real pi CLI.
 * Nothing signs in and no session of the person's own pi is touched.
 */
export async function fixture(handler: (body: ModelRequest, res: ServerResponse, index: number) => void, options: Partial<PiAgentProviderOptions> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'pi-native-test-'));
  const agentDirectory = join(home, 'agent'), cwd = join(home, 'workspace');
  await mkdir(agentDirectory); await mkdir(cwd);
  const requests: ModelRequest[] = []; const errors: unknown[] = []; const diagnostics: string[] = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const piece of req) chunks.push(piece as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as ModelRequest;
      requests.push(body); handler(body, res, requests.length);
    } catch (error) { errors.push(error); res.writeHead(500); res.end('Fixture failure'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  writeFileSync(join(agentDirectory, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl, api: 'openai-completions', apiKey: 'fixture-key', compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    models: [{ id: 'm1', name: 'Model one', contextWindow: 100000 }, { id: 'm2', name: 'Model two', reasoning: true, contextWindow: 100000 }] } } }));
  writeFileSync(join(agentDirectory, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'm1', defaultThinkingLevel: 'off', quietStartup: true }));
  const environment = { PI_CODING_AGENT_DIR: agentDirectory, PI_CODING_AGENT_SESSION_DIR: undefined, PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
  const provider = new PiAgentProvider({ executable: nativePiExecutable(), env: environment, requestTimeoutMs: 15_000, onDiagnostic: line => diagnostics.push(line), ...options });
  return { home, cwd, agentDirectory, provider, baseUrl, requests, errors, diagnostics, environment,
    async close() { try { await provider.dispose(); } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true }); } } };
}

/** The version the pi executable reports, asked of the CLI itself in a temporary profile. */
export function piRuntimeVersion(): string {
  const profile = mkdtempSync(join(tmpdir(), 'pi-version-'));
  try {
    const { command, args } = piInvocation(nativePiExecutable(), ['--version']);
    const run = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000, env: { ...process.env, PI_CODING_AGENT_DIR: join(profile, 'agent'), PI_SKIP_VERSION_CHECK: '1', PI_OFFLINE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    // pi prints its version on whichever stream its release uses.
    const output = `${run.stdout}\n${run.stderr}`;
    const version = /^v?(\d+\.\d+\.\d+)$/m.exec(output.trim())?.[1];
    if (!version) throw new Error(`pi reported no version: ${output.slice(0, 200)}`);
    return version;
  } finally { rmSync(profile, { recursive: true, force: true }); }
}
