import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderStreamItem } from '@orchardworks/agent-provider-sdk';

const mock = vi.hoisted(() => ({ client: {} as any, native: {} as any, handler: undefined as any }));
vi.mock('@github/copilot-sdk', () => ({ RuntimeConnection: { forStdio: (x: unknown) => x }, CopilotClient: class { constructor() { return mock.client; } } }));
import { CopilotAgentProvider } from './provider.js';
import { copilotLimitResetsAt, copilotUsageLimited } from './usage-limit.js';

let sequence = 0;
const event = (type: string, data: unknown, timestamp = new Date().toISOString()) => ({ id: `e${++sequence}`, timestamp, parentId: null, type, data }) as any;
beforeEach(() => {
  mock.handler = undefined;
  mock.native = { on: vi.fn((handler: unknown) => { mock.handler = handler; return vi.fn(); }), getEvents: vi.fn(async () => []), send: vi.fn(async () => 'm'), abort: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), rpc: {
    metadata: { isProcessing: vi.fn(async () => ({ processing: false })), contextInfo: vi.fn(async () => ({ contextInfo: null })) },
    usage: { getMetrics: vi.fn(async () => ({ totalPremiumRequestCost: 0, totalUserRequests: 0, totalApiDurationMs: 0, sessionStartTime: new Date(0).toISOString(), codeChanges: { linesAdded: 0, linesRemoved: 0, filesModifiedCount: 0, filesModified: [] }, modelMetrics: {} })) },
    model: { getCurrent: vi.fn(async () => ({ modelId: 'model-a' })), list: vi.fn(async () => ({ list: [{ id: 'model-a', name: 'Model A' }] })), switchTo: vi.fn(async () => ({})) },
    skills: { ensureLoaded: vi.fn(async () => {}), list: vi.fn(async () => ({ skills: [] })) },
    tasks: { list: vi.fn(async () => ({ tasks: [] })) },
    eventLog: { read: vi.fn(async () => ({ events: [], cursor: 'end', hasMore: false })) },
  } };
  mock.client = { rpc: { sessions: { checkInUse: vi.fn(async () => ({ inUse: [] })), close: vi.fn(async () => ({})) }, skills: { getDiscoveryPaths: vi.fn(async () => ({ paths: [] })) } },
    start: vi.fn(async () => {}), stop: vi.fn(async () => []), forceStop: vi.fn(async () => {}), createSession: vi.fn(async () => mock.native), resumeSession: vi.fn(async () => mock.native),
    getSessionMetadata: vi.fn(async () => undefined), listSessions: vi.fn(async () => []) };
});

describe('the usage limit Copilot reports', () => {
  it('is a session error of type rate_limit or quota, and its reset comes with an auto-mode switch, in seconds', () => {
    expect(copilotUsageLimited(event('session.error', { errorType: 'rate_limit', errorCode: 'user_weekly_rate_limited', message: 'Rate limited' }))).toBe(true);
    expect(copilotUsageLimited(event('session.error', { errorType: 'quota', errorCode: 'quota_exceeded', message: 'Quota exceeded' }))).toBe(true);
    expect(copilotUsageLimited(event('session.error', { errorType: 'model', message: 'Model unavailable' }))).toBe(false);
    expect(copilotLimitResetsAt(event('auto_mode_switch.requested', { requestId: 'r1', retryAfterSeconds: 90 }, '2026-11-22T10:00:00.000Z'))).toBe(Date.parse('2026-11-22T10:01:30.000Z'));
    expect(copilotLimitResetsAt(event('auto_mode_switch.requested', { requestId: 'r2' }))).toBeUndefined();
  });

  it('fails the turn as native_usage_limited and reports the limit, with its reset once Copilot says it, until the next turn starts', async () => {
    const provider = new CopilotAgentProvider({ executable: '/test/copilot' });
    const session = await provider.createSession({ sessionId: 'public', cwd: process.cwd() });
    const values: ProviderStreamItem[] = [];
    const done = (async () => { for await (const value of session.observe()) values.push(value); })();
    const events = () => values.flatMap(value => value.type === 'observation' ? [value.event] : []);
    try {
      mock.handler(event('assistant.turn_start', { turnId: '0' }));
      mock.handler(event('session.error', { errorType: 'rate_limit', errorCode: 'user_weekly_rate_limited', message: 'You reached the weekly rate limit.' }));
      await vi.waitFor(() => expect(events().find(value => value.type === 'turn_failed')).toMatchObject({ code: 'native_usage_limited', error: 'You reached the weekly rate limit.' }));
      expect((await session.runtimeInfo()).usageLimit).toEqual({});
      mock.handler(event('auto_mode_switch.requested', { requestId: 'r1', errorCode: 'user_weekly_rate_limited', retryAfterSeconds: 3600 }, '2026-11-22T10:00:00.000Z'));
      const resetsAt = Date.parse('2026-11-22T11:00:00.000Z');
      expect((await session.runtimeInfo()).usageLimit).toEqual({ resetsAt });
      await vi.waitFor(() => expect(events().filter(value => value.type === 'runtime_updated').at(-1)).toMatchObject({ runtimeInfo: { usageLimit: { resetsAt } } }));
      mock.handler(event('assistant.turn_start', { turnId: '0' }));
      expect((await session.runtimeInfo()).usageLimit).toBeUndefined();
    } finally { await provider.dispose(); await done.catch(() => undefined); }
  });
});
