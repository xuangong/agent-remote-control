import { createServer } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import type { SessionMessageInfo } from '@opencode/client';
import type { NativeInput } from './v2-native.js';
import { readOpenCodeInputResponse } from './input-response.js';
import { OpenCodeTransport } from './transport.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const user = (): SessionMessageInfo => ({ type: 'user', id: 'msg_input', text: 'Exact original text', time: { created: 100 } });
const assistant = (): SessionMessageInfo => ({ type: 'assistant', id: 'msg_response', agent: 'build', model: { providerID: 'test', id: 'model' }, content: [], time: { created: 50 } });

async function fixture(messages: SessionMessageInfo[]) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://fixture'); requests.push(url.pathname);
    if (url.pathname !== '/api/session/ses_input/message') { response.writeHead(404).end(); return; }
    const offset = Number(url.searchParams.get('cursor') ?? 0), limit = Number(url.searchParams.get('limit') ?? 200);
    const data = messages.toReversed().slice(offset, offset + limit);
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data, cursor: { next: String(offset + limit) } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const transport = new OpenCodeTransport({ serverUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requestTimeoutMs: 1000 });
  cleanups.push(() => transport.close());
  const read = (current: () => boolean = () => true, expected: NativeInput = { text: 'Exact original text' }) => readOpenCodeInputResponse(transport, 'ses_input', 'msg_input', expected, current);
  return { read, requests, messages };
}

test('ordinary lost acknowledgements use exact native sequence without persisted event logs', async () => {
  const f = await fixture([user(), assistant()]);
  expect(await f.read()).toBe('msg_response');
  expect(f.requests).toEqual(['/api/session/ses_input/message']);
  expect(await f.read(() => false)).toBeUndefined();
}, 5000);

test('matches normalized inline attachment bytes and rejects changed attachment facts', async () => {
  const input = user();
  if (input.type !== 'user') throw new Error('Expected user fixture.');
  input.files = [{ mime: 'image/png', data: 'YWJj', name: 'example.png', source: { type: 'inline' } }];
  const expected = { text: input.text, files: [{ uri: 'data:image/png;base64,YWJj', name: 'example.png' }] };
  const f = await fixture([input, assistant()]);
  expect(await f.read(() => true, expected)).toBe('msg_response');
  for (const changed of [{ mime: 'image/jpeg' }, { data: 'ZGVm' }, { name: 'other.png' }, { description: 'Injected extra instructions' }]) {
    const original = structuredClone(input.files[0]!);
    Object.assign(input.files[0]!, changed);
    expect(await f.read(() => true, expected)).toBeUndefined();
    input.files[0] = original;
  }
  expect(await f.read(() => true, { text: input.text, files: [{ uri: 'file:///path/image.png', name: 'example.png' }] })).toBeUndefined();
}, 5000);

test.each(['agent-switched', 'model-switched', 'location-switched', 'user', 'synthetic', 'system', 'skill', 'shell', 'compaction', 'idle'])('does not infer execution across a native %s boundary', async type => {
  const boundary = { type, id: 'msg_boundary', text: 'Other input', time: { created: 200 } } as SessionMessageInfo;
  const f = await fixture([user(), boundary, assistant()]);
  expect(await f.read()).toBeUndefined();
}, 5000);

test.each(['missing', 'text', 'files', 'agents', 'skills', 'metadata'])('does not settle mismatching %s evidence', async kind => {
  const input: any = user();
  if (kind === 'text') input.text += ' changed';
  if (kind === 'files') input.files = [{ mime: 'text/plain', data: 'extra' }];
  if (kind === 'agents') input.agents = [{ id: 'other' }];
  if (kind === 'skills') input.skills = [{ id: 'other' }];
  if (kind === 'metadata') input.metadata = { changed: true };
  const f = await fixture([...(kind === 'missing' ? [] : [input]), assistant()]);
  expect(await f.read()).toBeUndefined();
}, 5000);

test('preserves sequence evidence across pages and never treats an earlier assistant as the response', async () => {
  const prefix: SessionMessageInfo[] = Array.from({ length: 200 }, (_, index) => ({ ...assistant(), id: `msg_old_${index}` }));
  const f = await fixture([...prefix, user()]);
  expect(await f.read()).toBeUndefined();
  f.messages.push(assistant());
  expect(await f.read()).toBe('msg_response');
  expect(f.requests).toHaveLength(4);
}, 5000);
