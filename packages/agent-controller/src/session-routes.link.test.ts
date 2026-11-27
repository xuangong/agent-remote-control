import { describe, expect, it, vi } from 'vitest';
import type { RemoteSessionSummary } from '@orchardworks/agent-session-runtime';
import { readControllerLocation } from '@orchardworks/agent-remote-protocol/model';
import { handleSessionRequest, type SessionCallerCatalog, type SessionRouteContext } from './session-routes.js';

function summary(providerId: string, nativeSessionId: string, updatedAt: string, workspace?: string): RemoteSessionSummary {
  return { providerId, nativeSessionId, title: `Title ${nativeSessionId}`, updatedAt, state: 'idle', ...(workspace ? { workspace } : {}) } as RemoteSessionSummary;
}

function context(sessions: Record<string, RemoteSessionSummary[]>, extra: Partial<SessionCallerCatalog> = {}): SessionRouteContext & { catalog: SessionCallerCatalog } {
  const catalog: SessionCallerCatalog = {
    providers: () => Object.keys(sessions),
    sessions: async id => sessions[id] ?? [],
    session: async ref => sessions[ref.providerId]?.find(item => item.nativeSessionId === ref.nativeSessionId),
    history: async () => ({ entries: [] }),
    liveState: () => undefined,
    ...extra,
  };
  return { hostId: async () => 'desk', catalog, isShared: () => false, siteOrigin: () => 'https://arc.example' };
}
const owner = { kind: 'owner' } as const;

describe('session list by directory', () => {
  const sessions = { claude: [
    summary('claude', 'old', '2026-11-01T00:00:00.000Z', '/work/app'),
    summary('claude', 'new', '2026-11-03T00:00:00.000Z', '/work/app/'),
    summary('claude', 'other', '2026-11-04T00:00:00.000Z', '/work/other'),
    summary('claude', 'none', '2026-11-05T00:00:00.000Z'),
  ] };

  it('keeps the sessions whose working directory is the one asked for, newest first', async () => {
    const answer = await handleSessionRequest({ command: 'list', providerId: 'claude', cwd: '/work/app' }, owner, context(sessions));
    expect('result' in answer && (answer.result.sessions as Array<{ address: string }>).map(item => item.address)).toEqual(['desk/claude/new', 'desk/claude/old']);
  });

  it('asks the provider to list again first when told to refresh', async () => {
    const order: string[] = [];
    const refreshListing = vi.fn(async (id: string) => { order.push(`refresh ${id}`); });
    const base = context(sessions, { refreshListing });
    const catalog = { ...base.catalog, sessions: async (id: string) => { order.push(`list ${id}`); return sessions.claude; } };
    await handleSessionRequest({ command: 'list', providerId: 'claude', refresh: true }, owner, { ...base, catalog });
    expect(order).toEqual(['refresh claude', 'list claude']);
  });

  it('lists without refreshing a provider that cannot list on request', async () => {
    const answer = await handleSessionRequest({ command: 'list', providerId: 'claude', refresh: true }, owner, context(sessions));
    expect('result' in answer).toBe(true);
  });

  it.each([{ cwd: '' }, { cwd: 3 }, { refresh: 'yes' }])('rejects an invalid list option %j', async option => {
    const answer = await handleSessionRequest({ command: 'list', providerId: 'claude', ...option }, owner, context(sessions));
    expect(answer).toMatchObject({ error: { code: 'invalid_request' } });
  });
});

describe('session link with a use', () => {
  const sessions = { claude: [summary('claude', 'abc', '2026-11-01T00:00:00.000Z', '/work/app')] };
  const link = async (use?: unknown) => {
    const answer = await handleSessionRequest({ command: 'link', target: 'desk/claude/abc', ...(use ? { use } : {}) }, owner, context(sessions));
    if (!('result' in answer)) throw new Error(JSON.stringify(answer));
    return new URL(answer.result.url as string);
  };

  it('opens the session when no use is asked for', async () => {
    const url = await link();
    expect(url.origin).toBe('https://arc.example');
    expect(readControllerLocation(url.searchParams)).toEqual({ hostId: 'desk', providerId: 'claude', nativeSessionId: 'abc' });
  });

  it('carries a bot use with or without its name', async () => {
    expect(readControllerLocation((await link({ kind: 'bot', name: 'Reuse test' })).searchParams).sessionUse).toEqual({ kind: 'bot', name: 'Reuse test' });
    expect(readControllerLocation((await link({ kind: 'bot' })).searchParams).sessionUse).toEqual({ kind: 'bot' });
  });

  it('carries no credential beyond what a session link has', async () => {
    const url = await link({ kind: 'bot', name: 'x' });
    expect([...url.searchParams.keys()].sort()).toEqual(['as', 'host', 'name', 'provider', 'session']);
  });

  it.each([{ kind: 'bot', name: '' }, { kind: 'other' }, 'bot', { kind: 'bot', name: 'a'.repeat(61) }, { kind: 'bot', name: 3 }, { kind: 'window' }])('refuses the use %j', async use => {
    const answer = await handleSessionRequest({ command: 'link', target: 'desk/claude/abc', use }, owner, context(sessions));
    expect(answer).toMatchObject({ error: { code: 'invalid_request' } });
  });
});
