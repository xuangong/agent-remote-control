import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { CodexAppServerProvider } from '@agent-remote-controller/agent-provider-codex';
import type { AgentProviderAdapter, AgentSessionConfig } from '@agent-remote-controller/agent-provider-sdk';

import { createProtocolValidationServer } from '../server.js';
import {
  loadCompatibilityManifest,
  requireProviderCompatibility,
  type CompatibilityManifest,
} from './compatibility.js';

const LAB_ORIGIN = process.env.AGENT_REMOTE_ORIGIN ?? 'http://127.0.0.1:6175';

export interface CodexValidationServerOptions {
  executable: string;
  compatibility?: CompatibilityManifest;
}

export interface CodexProviderFixture {
  provider: AgentProviderAdapter;
  directoryProvider: CodexAppServerProvider;
  workspace: string;
  close(): Promise<void>;
}

export async function createCodexProviderFixture(options: CodexValidationServerOptions): Promise<CodexProviderFixture> {
  if (!isAbsolute(options.executable)) throw new Error('Codex executable must be an explicit absolute path.');
  const compatibility = requireProviderCompatibility(
    options.compatibility ?? loadCompatibilityManifest(),
    'codex',
  );
  const expectedVersion = `${compatibility.native.name} ${compatibility.native.version}`;
  const version = execFileSync(options.executable, ['--version'], { encoding: 'utf8' }).replace(/\r\n/g, '\n').trim();
  if (version !== expectedVersion) throw new Error(`Codex executable must report ${expectedVersion}; got ${version}.`);

  const codexHome = mkdtempSync(join(tmpdir(), 'borgee-codex-home-'));
  const workspace = mkdtempSync(join(tmpdir(), 'borgee-codex-workspace-'));
  const skillDirectory = join(workspace, '.agents', 'skills', 'remote-fixture-skill');
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(join(skillDirectory, 'SKILL.md'), '---\nname: remote-fixture-skill\ndescription: Verify native skill discovery\n---\nFollow the user instructions.\n');
  mkdirSync(join(codexHome, 'prompts'), { recursive: true });
  writeFileSync(join(codexHome, 'prompts', 'remote-fixture-prompt.md'), '---\ndescription: Verify native prompt discovery\n---\n$ARGUMENTS');
  const responses = await startResponsesFixture();
  writeFileSync(join(codexHome, 'config.toml'), codexConfig(responses.url));
  const directoryProvider = new CodexAppServerProvider({
    executable: options.executable,
    env: { CODEX_HOME: codexHome, OPENAI_API_KEY: 'borgee-local-fixture' },
    requestTimeoutMs: 15_000,
  });
  const provider = withCodexDefaults(directoryProvider, workspace);
  return {
    provider,
    directoryProvider,
    workspace,
    async close(): Promise<void> {
      await responses.close();
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}

export async function createCodexValidationServer(options: CodexValidationServerOptions) {
  const fixture = await createCodexProviderFixture(options);
  const server = createProtocolValidationServer({ providers: [fixture.provider], labOrigin: LAB_ORIGIN });
  return {
    ...server,
    async close(): Promise<void> {
      try {
        await server.close();
      } finally {
        await fixture.close();
      }
    },
  };
}

function withCodexDefaults(provider: AgentProviderAdapter, workspace: string): AgentProviderAdapter {
  return {
    descriptor: { ...provider.descriptor, displayName: 'Codex (fixture)' },
    createSession(config: AgentSessionConfig) {
      return provider.createSession({ ...config, cwd: config.cwd ?? workspace, model: config.model ?? 'mock-model' });
    },
    resumeSession: (handle) => provider.resumeSession(handle),
  };
}

function codexConfig(responsesUrl: string): string {
  return `model = "mock-model"
model_provider = "borgee_fixture"
approval_policy = "never"
sandbox_mode = "read-only"

[model_providers.borgee_fixture]
name = "Borgee deterministic Responses fixture"
base_url = "${responsesUrl}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
`;
}

async function startResponsesFixture(): Promise<{ url: string; close(): Promise<void> }> {
  let responseOrdinal = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        response.writeHead(404).end('not found');
        return;
      }
      const body = Buffer.concat(chunks).toString('utf8');
      const parsedBody = JSON.parse(body) as {
        input?: Array<{ type?: string; call_id?: string; output?: string; role?: string; content?: Array<{ text?: string }> }>;
      };
      const ordinal = ++responseOrdinal;
      const userInput = parsedBody.input?.filter((item) => item.role === 'user').at(-1);
      if (userInput?.content?.some((part) => part.text === 'Hold this native turn for an interrupt.')) {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        response.write(sse([responseCreated(`response-interrupt-${ordinal}`)]));
        return;
      }
      const responseBody = hasExpectedQuestionAnswer(parsedBody.input)
        ? assistantMessageSse('CODEX_BROWSER_CONTINUATION_OK', ordinal)
        : hasQuestionOutput(parsedBody.input)
          ? assistantMessageSse('CODEX_CORRELATION_MISSING', ordinal)
          : requestUserInputSse(ordinal);
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      }).end(responseBody);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Responses fixture has no TCP address.');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => closeHttpServer(server),
  };
}

function hasQuestionOutput(
  input: Array<{ type?: string; call_id?: string; output?: string }> | undefined,
): boolean {
  return input?.some((item) => item.type === 'function_call_output' && item.call_id === 'call1') ?? false;
}

function hasExpectedQuestionAnswer(
  input: Array<{ type?: string; call_id?: string; output?: string }> | undefined,
): boolean {
  return input?.some((item) => item.type === 'function_call_output'
    && item.call_id === 'call1'
    && item.output?.includes('Yes (Recommended)')) ?? false;
}

function requestUserInputSse(ordinal: number): string {
  const responseId = `response-question-${ordinal}`;
  return sse([
    responseCreated(responseId),
    {
      type: 'response.output_item.done',
      item: {
        type: 'function_call', call_id: 'call1', name: 'request_user_input',
        arguments: JSON.stringify({
          questions: [{
            id: 'confirm_path', header: 'Confirm', question: 'Proceed with the shared Agent Remote path?',
            options: [
              { label: 'Yes (Recommended)', description: 'Continue through the real app-server.' },
              { label: 'No', description: 'Stop the deterministic flow.' },
            ],
          }],
        }),
      },
    },
    responseCompleted(responseId),
  ]);
}

function assistantMessageSse(text: string, ordinal: number): string {
  const responseId = `response-continuation-${ordinal}`;
  return sse([
    responseCreated(responseId),
    {
      type: 'response.output_item.done',
      item: {
        type: 'message', role: 'assistant', id: `codex-final-${ordinal}`,
        content: [{ type: 'output_text', text }],
      },
    },
    responseCompleted(responseId),
  ]);
}

function responseCreated(id: string): object {
  return { type: 'response.created', response: { id } };
}

function responseCompleted(id: string): object {
  return {
    type: 'response.completed',
    response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
  };
}

function sse(events: readonly object[]): string {
  return events.map((event) => {
    const type = (event as { type: string }).type;
    return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
  }).join('');
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

const entry = process.argv[1] === undefined ? undefined : new URL(`file://${process.argv[1]}`).href;
if (entry === import.meta.url) {
  const executable = process.env.BORGEE_CODEX_TEST_EXECUTABLE;
  if (!executable) throw new Error('BORGEE_CODEX_TEST_EXECUTABLE must name the explicit Codex 0.148.0 executable.');
  const server = await createCodexValidationServer({ executable });
  const address = await server.http.listen(Number(process.env.AGENT_REMOTE_PORT ?? 5910), '127.0.0.1');
  process.stdout.write(`Codex Agent Remote relay listening on ${address.url}\n`);
  const close = async (): Promise<void> => {
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
}
