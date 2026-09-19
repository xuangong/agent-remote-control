import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { expect, it } from 'vitest';
import type { AgentSession, AgentUserMessagePart } from '@agent-remote-controller/agent-provider-sdk';
import { CodexAppServerProvider } from './provider.js';

function pixel(red: number, green: number): Buffer {
  function chunk(type: string, data: Buffer) { const header = Buffer.alloc(4); header.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([header, body, crc]); }
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0,red,green,0]))), chunk('IEND', Buffer.alloc(0))]);
}
it('preserves ordered images through a private native app-server and fresh history', async () => {
  const executable = process.env.BORGEE_CODEX_TEST_EXECUTABLE ?? 'codex';
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
  const directory = await mkdtemp(join(tmpdir(), 'arc-native-images-'));
  const inputs: unknown[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      if (request.url !== '/v1/responses') { response.writeHead(404).end(); return; }
      inputs.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.setHeader('content-type', 'text/event-stream');
      response.end([
        { type: 'response.created', response: { id: 'image-response' } },
        { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'image-answer', content: [{ type: 'output_text', text: 'IMAGE_TRANSPORT_OK' }] } },
        { type: 'response.completed', response: { id: 'image-response', usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } },
      ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing local address');
  const home = join(directory, 'home');
  const { mkdir } = await import('node:fs/promises'); await mkdir(home);
  await writeFile(join(home, 'config.toml'), `model = "mock-model"\nmodel_provider = "mock"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.mock]\nname = "Local image transport"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
  const provider = new CodexAppServerProvider({ executable, env: { CODEX_HOME: home, OPENAI_API_KEY: 'local-image-test' }, requestTimeoutMs: 10000 });
  let session: AgentSession | undefined;
  try {
    const bytes = [pixel(255,0), pixel(0,255)];
    const hashes = bytes.map(value => createHash('sha256').update(value).digest('hex'));
    const paths = bytes.map((_, index) => join(directory, `image-${index}.png`));
    await Promise.all(bytes.map((value, index) => writeFile(paths[index]!, value)));
    session = await provider.createSession({ sessionId: 'image-native', cwd: directory, model: 'mock-model' });
    const stream = session.observe()[Symbol.asyncIterator]();
    await expect(stream.next()).resolves.toMatchObject({ value: { type: 'history_boundary' } });
    await session.sendMessageContent!([
      { type: 'text', text: 'Before ' }, { type: 'image', path: paths[0]!, mediaType: 'image/png', sha256: hashes[0]!, label: 'image #1' },
      { type: 'text', text: ' between ' }, { type: 'image', path: paths[1]!, mediaType: 'image/png', sha256: hashes[1]!, label: 'image #2' }, { type: 'text', text: ' after' },
    ]);
    let liveParts: AgentUserMessagePart[] | undefined;
    for (;;) {
      const next = await stream.next();
      if (next.done) throw new Error('Native stream ended before completion');
      if (next.value.type !== 'observation') continue;
      const event = next.value.event;
      if (event.type === 'timeline' && event.item.type === 'user_message') liveParts = event.item.content;
      if (event.type === 'turn_failed') throw new Error(JSON.stringify(event));
      if (event.type === 'turn_completed') break;
    }
    expect(liveParts?.map(part => part.type), version).toEqual(['text','image','text','image','text']);
    const persistence = (await session.runtimeInfo()).persistence!; await session.dispose();
    session = await provider.resumeSession(persistence);
    let replay: AgentUserMessagePart[] | undefined;
    for await (const event of session.observe()) {
      if (event.type === 'history_boundary') break;
      if (event.event.type === 'timeline' && event.event.item.type === 'user_message') replay = event.event.item.content;
    }
    expect(replay?.map(part => part.type), version).toEqual(['text','image','text','image','text']);
    expect(replay?.filter(part => part.type === 'image').map(part => part.sha256), version).toEqual(hashes);
    const request = inputs[0] as { input: Array<{ role?: string; content?: Array<{ type: string; text?: string }> }> };
    const user = request.input.findLast(item => item.role === 'user');
    expect(user?.content?.filter(part => part.type === 'input_image' || ['Before ', ' between ', ' after'].includes(part.text ?? '')).map(part => part.type)).toEqual(['input_text','input_image','input_text','input_image','input_text']);
  } finally {
    await session?.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true });
  }
}, 30000);
