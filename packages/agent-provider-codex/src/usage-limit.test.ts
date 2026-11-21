import { once } from 'node:events';

import type { ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { describe, expect, it } from 'vitest';

import { CodexAppServerTransport } from './app-server-transport.js';
import { CodexAppServerSession } from './session.js';
import { createFakeChildProcess } from './test-utils/fake-child.js';
import { codexLimitResetsAt, codexUsageLimited, mergeCodexRateLimits } from './usage-limit.js';

const RESETS_AT_S = 1_795_300_000;

describe('the usage limit Codex reports', () => {
  it('is named by the error of the turn it stopped, as a usage or a rate limit', () => {
    expect(codexUsageLimited({ message: 'Usage limit reached', codexErrorInfo: 'usageLimitExceeded' })).toBe(true);
    expect(codexUsageLimited({ message: 'Too many requests', codexErrorInfo: 'rateLimitExceeded' })).toBe(true);
    expect(codexUsageLimited({ message: 'Context full', codexErrorInfo: 'contextWindowExceeded' })).toBe(false);
    expect(codexUsageLimited({ message: 'No detail', codexErrorInfo: null })).toBe(false);
    expect(codexUsageLimited(undefined)).toBe(false);
  });

  it('resets when the latest used-up window resets, in milliseconds, and a sparse update keeps the windows it leaves out', () => {
    let limits = mergeCodexRateLimits(new Map(), { rateLimits: { limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: RESETS_AT_S },
      secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: RESETS_AT_S + 600_000 } } });
    expect(codexLimitResetsAt(limits)).toBe(RESETS_AT_S * 1000);
    limits = mergeCodexRateLimits(limits, { rateLimits: { limitId: 'codex', primary: null, secondary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: RESETS_AT_S + 600_000 } } });
    expect(codexLimitResetsAt(limits)).toBe((RESETS_AT_S + 600_000) * 1000);
    expect(codexLimitResetsAt(mergeCodexRateLimits(new Map(), { rateLimits: { limitId: 'codex', primary: { usedPercent: 70, resetsAt: RESETS_AT_S } } }))).toBeUndefined();
  });
});

function harness() {
  const child = createFakeChildProcess();
  const transport = new CodexAppServerTransport(child);
  const requests: Array<{ id: number; method: string }> = [];
  let buffered = '';
  child.stdin.on('data', chunk => {
    buffered += String(chunk);
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) continue;
      const message = JSON.parse(line) as { id?: number; method?: string };
      if (typeof message.id === 'number' && message.method) requests.push({ id: message.id, method: message.method });
      if (typeof message.id === 'number' && message.method === 'thread/turns/list') child.stdout.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Method not found' } })}\n`);
      if (typeof message.id === 'number' && ['collaborationMode/list', 'model/list', 'configRequirements/read'].includes(message.method ?? '')) child.stdout.write(`${JSON.stringify({ id: message.id, result: { data: [] } })}\n`);
    }
  });
  const request = async (method: string) => { for (;;) { const found = requests.find(entry => entry.method === method); if (found) return found; await once(child.stdin, 'data'); } };
  const respond = (id: number, result: unknown) => { child.stdout.write(`${JSON.stringify({ id, result })}\n`); };
  const notify = (method: string, params: unknown) => { child.stdout.write(`${JSON.stringify({ method, params })}\n`); };
  return { transport, request, respond, notify };
}

describe('a Codex session the account limit stops', () => {
  it('fails the turn as native_usage_limited, reports the limit with its reset until the next turn starts', async () => {
    const native = harness();
    const starting = CodexAppServerSession.resume(native.transport, { providerId: 'codex', sessionId: 'thread-1', opaque: '{}' });
    native.respond((await native.request('initialize')).id, {});
    native.respond((await native.request('thread/resume')).id, { thread: { id: 'thread-1' } });
    native.respond((await native.request('thread/read')).id, { thread: { id: 'thread-1', status: { type: 'idle' }, turns: [] } });
    const session = await starting;
    const items: ProviderStreamItem[] = [];
    const reading = (async () => { for await (const item of session.observe()) items.push(item); })();
    const events = () => items.flatMap(item => item.type === 'observation' ? [item.event] : []);
    const limits = () => events().flatMap(event => event.type === 'runtime_updated' ? [event.runtimeInfo.usageLimit] : []);
    try {
      native.notify('account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: RESETS_AT_S }, secondary: null } });
      native.notify('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress' } });
      native.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed', error: { message: 'You have hit your usage limit.', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null } } });
      await expect.poll(() => events().find(event => event.type === 'turn_failed')).toMatchObject({ code: 'native_usage_limited', error: 'You have hit your usage limit.' });
      await expect.poll(() => limits().at(-1)).toEqual({ resetsAt: RESETS_AT_S * 1000 });
      // The rate-limit notification is runtime state, never a row of the conversation.
      expect(events().filter(event => event.type === 'timeline' && event.item.type === 'error' && event.item.message.includes('rateLimits'))).toEqual([]);
      expect((await session.runtimeInfo()).usageLimit).toEqual({ resetsAt: RESETS_AT_S * 1000 });
      native.notify('turn/started', { threadId: 'thread-1', turn: { id: 'turn-2', status: 'inProgress' } });
      await expect.poll(async () => (await session.runtimeInfo()).usageLimit).toBeUndefined();
      expect(limits().at(-1)).toBeUndefined();
    } finally { await session.dispose(); await reading.catch(() => undefined); }
  });
});
