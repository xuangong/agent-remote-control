import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { RemoteSessionSummary } from '@orchardworks/agent-remote-relay';
import { SESSION_STATE_STALE_MS } from '@orchardworks/agent-remote-protocol';
import { SessionListing, type SessionListingPage } from './session-listing.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function file() { const root = await mkdtemp(join(tmpdir(), 'arc-listing-')); roots.push(root); return join(root, 'nested', 'codex.json'); }

const summary = (id: string, updated: number, state: RemoteSessionSummary['state'] = 'idle', title = id): RemoteSessionSummary => ({
  nativeSessionId: id, providerId: 'codex', title, createdAt: new Date(0).toISOString(), updatedAt: new Date(updated * 1000).toISOString(), state });

/** A native agent that pages its sessions newest first and records every page request. */
function native(sessions: RemoteSessionSummary[]) {
  const requests: Array<{ limit: number; cursor?: string }> = [];
  const failures = new Map<number, Error>();
  const holds = new Map<number, Promise<void>>();
  async function readPage(query: { limit: number; cursor?: string }): Promise<SessionListingPage<RemoteSessionSummary>> {
    requests.push(query);
    const page = requests.length;
    await holds.get(page);
    const failure = failures.get(page);
    if (failure) throw failure;
    const ordered = [...sessions].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const offset = query.cursor ? Number(query.cursor) : 0;
    return { sessions: ordered.slice(offset, offset + query.limit), ...(offset + query.limit < ordered.length ? { nextCursor: String(offset + query.limit) } : {}) };
  }
  return { readPage, requests, sessions, failPage(page: number, error: Error) { failures.set(page, error); },
    holdPage(page: number) { let release!: () => void; holds.set(page, new Promise(resolve => { release = resolve; })); return () => release(); } };
}

it('never lists the native sessions until a refresh is requested', async () => {
  const agent = native([summary('a', 3), summary('b', 2)]);
  const listing = new SessionListing(agent.readPage);
  expect(await listing.sessions()).toEqual([]);
  expect(listing.status()).toMatchObject({ refreshing: false, complete: false });
  expect(listing.status().listedAt).toBeUndefined();
  expect(agent.requests).toEqual([]);
});

it('lists every page on request and serves that listing afterwards without asking again', async () => {
  let clock = 1_000_000;
  const agent = native(Array.from({ length: 120 }, (_, index) => summary(`s${index}`, 1_000 + index)));
  const listing = new SessionListing(agent.readPage, { now: () => clock });
  await listing.refresh();
  expect(agent.requests).toEqual([{ limit: 50 }, { limit: 50, cursor: '50' }, { limit: 50, cursor: '100' }]);
  expect(await listing.sessions()).toHaveLength(120);
  expect(listing.status()).toMatchObject({ refreshing: false, complete: true, listedAt: new Date(clock).toISOString() });
  clock += 60_000;
  await listing.sessions(); await listing.sessions();
  expect(agent.requests).toHaveLength(3);
});

it('runs one listing at a time and reports it while it runs', async () => {
  const agent = native([summary('a', 3)]);
  const listing = new SessionListing(agent.readPage);
  const release = agent.holdPage(1);
  const first = listing.refresh(), second = listing.refresh();
  await Promise.resolve();
  expect(listing.status().refreshing).toBe(true);
  release();
  await Promise.all([first, second]);
  expect(agent.requests).toHaveLength(1);
  expect(listing.status().refreshing).toBe(false);
});

it('keeps the pages it read and the older sessions it knew when a later page fails', async () => {
  const agent = native(Array.from({ length: 150 }, (_, index) => summary(`s${index}`, 1_000 + index)));
  const listing = new SessionListing(agent.readPage);
  await listing.refresh();
  agent.sessions.push(summary('new', 5_000));
  agent.sessions.splice(agent.sessions.findIndex(item => item.nativeSessionId === 's149'), 1);
  agent.failPage(5, new Error('Codex did not answer a native request before its deadline.'));
  await listing.refresh();
  const ids = (await listing.sessions()).map(item => item.nativeSessionId);
  expect(ids).toContain('new');
  expect(ids).not.toContain('s149');
  // The first page reached s100; everything older stays as the previous listing saw it.
  expect(ids).toContain('s0');
  expect(ids).toHaveLength(150);
  expect(listing.status()).toMatchObject({ refreshing: false, complete: false, error: 'Codex did not answer a native request before its deadline.' });
});

it('keeps the previous listing untouched when the first page fails', async () => {
  const agent = native([summary('a', 3), summary('b', 2)]);
  const listing = new SessionListing(agent.readPage);
  await listing.refresh();
  const listedAt = listing.status().listedAt;
  agent.failPage(2, new Error('Codex is unavailable.'));
  await listing.refresh();
  expect((await listing.sessions()).map(item => item.nativeSessionId).sort()).toEqual(['a', 'b']);
  expect(listing.status()).toMatchObject({ listedAt, error: 'Codex is unavailable.' });
});

it('stops at the page limit and lists only the newest sessions', async () => {
  const agent = native(Array.from({ length: 30 }, (_, index) => summary(`s${index}`, 1_000 + index)));
  const listing = new SessionListing(agent.readPage, { pageSize: 10, pageLimit: 2 });
  await listing.refresh();
  expect(agent.requests).toHaveLength(2);
  expect((await listing.sessions()).map(item => item.nativeSessionId)).toHaveLength(20);
  expect(listing.status().complete).toBe(true);
});

it('reports a listed state only while it is recent and leaves an old one unknown', async () => {
  let clock = 1_000_000;
  const agent = native([summary('busy', 3, 'running')]);
  const listing = new SessionListing(agent.readPage, { now: () => clock });
  await listing.refresh();
  expect((await listing.sessions())[0]?.state).toBe('running');
  clock += SESSION_STATE_STALE_MS;
  expect((await listing.sessions())[0]?.state).toBe('unknown');
});

it('adds sessions the Controller learns about and changes their titles without listing', async () => {
  const agent = native([]);
  const listing = new SessionListing(agent.readPage);
  await listing.record(summary('created', 9, 'idle', 'New Codex session'));
  await listing.retitle('created', 'Release plan');
  await listing.retitle('unknown', 'Ignored');
  expect(await listing.sessions()).toEqual([expect.objectContaining({ nativeSessionId: 'created', title: 'Release plan' })]);
  expect(agent.requests).toEqual([]);
});

it('keeps a session the Controller created while a listing was running', async () => {
  const agent = native([summary('a', 3)]);
  const listing = new SessionListing(agent.readPage);
  const release = agent.holdPage(1);
  const refresh = listing.refresh();
  await listing.record(summary('created', 9));
  release(); await refresh;
  expect((await listing.sessions()).map(item => item.nativeSessionId).sort()).toEqual(['a', 'created']);
});

it('keeps the last listing across restarts', async () => {
  const path = await file();
  let clock = 1_000_000;
  const agent = native([summary('a', 3, 'running'), summary('b', 2)]);
  const first = new SessionListing(agent.readPage, { file: path, now: () => clock });
  await first.refresh();
  await first.record(summary('created', 9));
  await first.close();
  const restarted = new SessionListing(native([]).readPage, { file: path, now: () => clock });
  expect((await restarted.sessions()).map(item => item.nativeSessionId).sort()).toEqual(['a', 'b', 'created']);
  expect((await restarted.sessions()).find(item => item.nativeSessionId === 'a')?.state).toBe('running');
  expect(restarted.status()).toMatchObject({ complete: true, listedAt: new Date(clock).toISOString() });
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 1 });
});

it('starts empty from an unreadable saved listing', async () => {
  const path = await file();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '{"version":1,"sessions":[{"summary":{"nativeSessionId":7}}]}');
  const listing = new SessionListing(native([]).readPage, { file: path });
  expect(await listing.sessions()).toEqual([]);
});

it('stops listing after it is closed', async () => {
  const agent = native(Array.from({ length: 120 }, (_, index) => summary(`s${index}`, 1_000 + index)));
  const listing = new SessionListing(agent.readPage);
  const release = agent.holdPage(1);
  const refresh = listing.refresh();
  await vi.waitFor(() => expect(agent.requests).toHaveLength(1));
  const closed = listing.close();
  release(); await refresh; await closed;
  expect(agent.requests).toHaveLength(1);
});
