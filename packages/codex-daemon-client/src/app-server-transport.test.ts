import { once } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { CodexAppServerTransport, CodexAppServerRpcError } from './app-server-transport.js';
import { createFakeChildProcess } from './test-utils/fake-child.js';

describe('CodexAppServerTransport', () => {
  it('keeps a pending request alive when stdout contains non-JSON diagnostics', async () => {
    const child = createFakeChildProcess();
    const transport = new CodexAppServerTransport(child);
    const request = transport.request('model/list', {});

    child.stdout.write('localized startup message\n');
    child.stdout.write('{"id":1,"result":{"data":[]}}\n');

    await expect(request).resolves.toEqual({ data: [] });
    await transport.dispose();
  });

  it('answers server requests through the registered handler', async () => {
    const child = createFakeChildProcess();
    const transport = new CodexAppServerTransport(child);
    transport.setRequestHandler('item/tool/requestUserInput', async (params, requestId) => ({
      answers: { question: { answers: [`${requestId}:${String((params as { value: string }).value)}`] } },
    }));
    const output = once(child.stdin, 'data');

    child.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 'request-7', method: 'item/tool/requestUserInput', params: { value: 'yes' },
    })}\n`);

    const [chunk] = await output;
    expect(String(chunk)).toBe('{"id":"request-7","result":{"answers":{"question":{"answers":["request-7:yes"]}}}}\n');
    await transport.dispose();
  });

  it('rejects JSON-RPC errors with their code and data', async () => {
    const child = createFakeChildProcess();
    const transport = new CodexAppServerTransport(child);
    const request = transport.request('thread/read', {});
    child.stdout.write('{"id":1,"error":{"code":-32602,"message":"invalid thread","data":{"field":"threadId"}}}\n');

    await expect(request).rejects.toMatchObject<CodexAppServerRpcError>({
      name: 'CodexAppServerRpcError', code: -32602, data: { field: 'threadId' },
    });
    await transport.dispose();
  });

  it('disposes idempotently, rejects pending requests, and clears their timers', async () => {
    vi.useFakeTimers();
    const child = createFakeChildProcess();
    const transport = new CodexAppServerTransport(child, { requestTimeoutMs: 60_000 });
    const pending = transport.request('thread/read', { threadId: 'thread-1' });

    expect(vi.getTimerCount()).toBe(1);
    await transport.dispose();
    await transport.dispose();

    await expect(pending).rejects.toThrow('Codex app-server transport is closed');
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});

describe('native request diagnostics', () => {
  it.each([
    ['thread/turns/list', -32602, 'thread private-session is not loaded: /private/workspace', 'thread_not_loaded'],
    ['thread/read', -32602, 'thread not found: private-session', 'thread_not_found'],
    ['thread/items/list', -32602, 'Invalid cursor: secret-cursor', 'invalid_cursor'],
    ['thread/read', -32603, 'Too many open files (os error 24): /private/rollout', 'file_limit'],
    ['thread/read', -32602, 'sensitive arbitrary native message', 'invalid_params'],
    ['thread/read', -32603, 'sensitive arbitrary native message', 'internal_error'],
    ['thread/read', 'secret-code', 'sensitive arbitrary native message', 'native_error'],
  ])('records safe rejection details for %s (%s, %s)', async (method, code, message, reason) => {
    const child = createFakeChildProcess(); const diagnostics: string[] = [];
    const transport = new CodexAppServerTransport(child, { onDiagnostic: line => diagnostics.push(line) });
    try {
      const request = transport.request(method, { threadId: 'private-session', cursor: 'secret-cursor' });
      child.stdout.write(JSON.stringify({ id: 1, error: { code, message, data: { token: 'secret-token' } } }) + '\n');
      await expect(request).rejects.toMatchObject({ code, message });
      const rejected = diagnostics.map(line => JSON.parse(line)).find(value => value.outcome === 'rejected');
      expect(rejected).toMatchObject({ event: 'codex_request', phase: 'history', method, reason,
        ...(typeof code === 'number' ? { rpcCode: code } : {}), requestId: 1, sessionRef: expect.stringMatching(/^[a-f0-9]{16}$/), hasCursor: true });
      expect(diagnostics.join('')).not.toMatch(/private-session|private\/|secret-|sensitive arbitrary/);
    } finally { await transport.dispose(); }
  });
});
