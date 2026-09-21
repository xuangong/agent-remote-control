import { expect, it } from 'vitest';
import { runShare, type ShareContext, type ShareIO } from './share-command.js';

const context: ShareContext = { serverUrl: 'https://agents.example', hostId: 'host-1',
  providers: [{ providerId: 'codex', displayName: 'Codex' }, { providerId: 'claude', displayName: 'Claude' }] };
const summary = (providerId: string, nativeSessionId: string, updatedAt = '2026-09-21T00:00:00Z') => ({
  providerId, nativeSessionId, title: 'Same title', workspace: '/project', createdAt: updatedAt, updatedAt, state: 'idle' });
function terminal(answers: string[]) {
  let output = ''; const prompts: string[] = []; const codes: string[] = [];
  const io: ShareIO = { write: text => { output += text; }, ask: async text => {
    prompts.push(text); const answer = answers.shift(); if (answer === undefined) throw Error('Unexpected prompt'); return answer;
  }, qr: async url => { codes.push(url); return 'QR'; } };
  return { io, prompts, codes, get output() { return output; } };
}
it('guides provider selection and retries missing sessions before emitting a credential-free link', async () => {
  const t = terminal(['9', '2', '', 'missing', 'found']);
  await runShare([], async request => {
    if (request.action === 'share-context') return context;
    expect(request).toMatchObject({ providerId: 'claude', hostId: 'host-1', serverUrl: context.serverUrl });
    return request.nativeSessionId === 'found' ? { status: 200, body: JSON.stringify(summary('claude', 'found')) }
      : { status: 404, body: '{}' };
  }, t.io);
  expect(t.output).toContain('1. Codex'); expect(t.output).toContain('2. Claude');
  expect(t.output).toContain('not found');
  expect(t.codes).toEqual(['https://agents.example/?host=host-1&provider=claude&session=found']);
});
it('lists all enabled providers in recency order and revalidates the selected identity', async () => {
  const t = terminal(['2']);
  await runShare(['list-sessions'], async request => {
    if (request.action === 'share-context') return context;
    if (request.nativeSessionId) return { status: 200, body: JSON.stringify(summary(String(request.providerId), String(request.nativeSessionId))) };
    return { status: 200, body: JSON.stringify({ items: [summary(String(request.providerId), String(request.providerId) + '-id',
      request.providerId === 'claude' ? '2026-09-21T01:00:00Z' : '2026-09-21T00:00:00Z')], hasMore: false }) };
  }, t.io);
  expect(t.output.indexOf('claude-id')).toBeLessThan(t.output.indexOf('codex-id'));
  expect(t.codes[0]).toContain('provider=codex&session=codex-id'); expect(t.output).toContain('/project');
});
it('never generates a code for a stale, unavailable, or mismatched catalog result', async () => {
  for (const result of [summary('codex', 'other'), { ...summary('codex', 'id'), state: 'unavailable' }]) {
    const t = terminal(['1', 'id']);
    await expect(runShare([], async request => request.action === 'share-context' ? context : { status: 200, body: JSON.stringify(result) }, t.io)).rejects.toThrow();
    expect(t.codes).toEqual([]);
  }
});
it('cancels without catalog reads and rejects unsupported arguments', async () => {
  const t = terminal(['q']);
  await runShare([], async request => { expect(request.action).toBe('share-context'); return context; }, t.io);
  expect(t.codes).toEqual([]);
  await expect(runShare(['unknown'], async () => context, t.io)).rejects.toThrow(/Usage/);
});
it('rejects a credential-bearing site URL before printing it', async () => {
  const t = terminal([]);
  await expect(runShare([], async () => ({ ...context, serverUrl: 'https://user:private@agents.example' }), t.io)).rejects.toThrow(/site/i);
  expect(t.output).not.toContain('private');
});
it('merges provider pages without skipping a busy provider when browsing older sessions', async () => {
  const t = terminal(['n', '1']);
  await runShare(['list-sessions'], async request => {
    if (request.action === 'share-context') return context;
    if (request.nativeSessionId) return { status: 200, body: JSON.stringify(summary(String(request.providerId), String(request.nativeSessionId))) };
    const offset = request.cursor ? 20 : 0;
    const items = request.providerId === 'claude' ? [summary('claude', 'old', '2020-01-01T00:00:00Z')]
      : Array.from({ length: offset ? 3 : 20 }, (_, i) => summary('codex', `id-${offset+i}`, new Date(Date.UTC(2026, 8, 21, 0, 60-offset-i)).toISOString()));
    return { status: 200, body: JSON.stringify({ items, hasMore: request.providerId === 'codex' && !offset, nextCursor: offset ? undefined : 'next' }) };
  }, t.io);
  expect(t.codes[0]).toContain('session=id-20');
});
it('handles an empty catalog without asking for a selection', async () => {
  const t = terminal([]);
  await runShare(['list-sessions'], async request => request.action === 'share-context' ? context
    : { status: 200, body: JSON.stringify({ items: [], hasMore: false }) }, t.io);
  expect(t.output).toContain('No sessions'); expect(t.codes).toEqual([]);
});
