import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { AgentSession } from '@orchardworks/agent-provider-sdk';
import { createManagedStdioDirectory, type ManagedStdioProvider } from './stdio-directory.js';
import { SESSION_CREATION_RETENTION_MS, SessionCreationStore } from './session-creation-store.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))); });
async function root() { const path = await mkdtemp(join(tmpdir(), 'arc-session-creations-')); roots.push(path); return path; }

/** A native agent that saves a session only with its first message; `history` is the workspace of its transcript. */
function fixture() {
  const resumes: Array<{ opaque: string; initializeEmpty?: true }> = [];
  let history: string | undefined;
  const native = (id: string, opaque: string): AgentSession => {
    let closed = false;
    return { capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false, interactions: { question: false, toolApproval: false, planApproval: false } },
      async *observe() { yield { type: 'history_boundary' }; },
      async runtimeInfo() { return { providerId: 'claude', sessionId: id, status: closed ? 'closed' : 'idle', cwd: '/workspace', persistence: { providerId: 'claude', sessionId: id, opaque } }; },
      async sendMessage() {}, async respondToInteraction() {}, async dispose() { closed = true; } };
  };
  const provider: ManagedStdioProvider = { listSessions: async () => [],
    async createSession(config) { return native('created', JSON.stringify({ cwd: config.cwd, model: config.model })); },
    async resumeSession(handle, _extensions, options) {
      resumes.push({ opaque: handle.opaque, ...(options?.initializeEmpty ? { initializeEmpty: true as const } : {}) });
      return native(handle.sessionId, handle.opaque);
    },
    async sessionWorkspace(_id, handle) { return history ?? (handle ? JSON.parse(handle.opaque).cwd : undefined); },
  };
  return { provider, resumes, setHistory(workspace: string) { history = workspace; } };
}

it('reopens a session that never received input from its creation handle, and lets native history win once it has some', async () => {
  const f = fixture(), path = await root();
  const make = () => createManagedStdioDirectory('claude', 'Claude', f.provider, [], undefined, undefined, new SessionCreationStore(path, 'claude'));
  let directory = make();
  try {
    const id = await directory.create({ cwd: '/workspace', model: 'chosen-model' });
    const creation = JSON.stringify({ cwd: '/workspace', model: 'chosen-model' });
    // Its process ends before any input, while this Controller keeps running.
    await (await directory.open(id)).dispose();
    await directory.open(id);
    expect(f.resumes).toEqual([{ opaque: creation, initializeEmpty: true }]);
    await directory.close();
    // After a restart only the saved creation handle knows the session; the workspace policy reads it first.
    directory = make();
    expect(await directory.sessionWorkspace!(id)).toBe('/workspace');
    await directory.open(id);
    expect(f.resumes.at(-1)).toEqual({ opaque: creation, initializeEmpty: true });
    await directory.close();
    // A session that was not created here, or that has native history, resumes as before.
    directory = make();
    await directory.open('elsewhere');
    expect(f.resumes.at(-1)).toEqual({ opaque: '{}' });
    f.setHistory('/workspace');
    await directory.open(id);
    expect(f.resumes.at(-1)).toEqual({ opaque: '{}' });
  } finally { await directory.close(); }
});

it('keeps creation handles for their provider and retention period only', async () => {
  const path = await root();
  let now = 1_000;
  const store = new SessionCreationStore(path, 'claude', () => now);
  const old = { providerId: 'claude', sessionId: 'old', opaque: '{"model":"a"}' };
  await store.set(old);
  now += SESSION_CREATION_RETENTION_MS - 1;
  expect(await store.get('old')).toEqual(old);
  expect(await store.get('missing')).toBeUndefined();
  await store.set({ providerId: 'claude', sessionId: 'new', opaque: '{}' });
  expect(await readdir(path)).toHaveLength(2);
  now += 1;
  expect(await store.get('old')).toBeUndefined();
  // Expired handles are removed with the next creation.
  await store.set({ providerId: 'claude', sessionId: 'newer', opaque: '{}' });
  expect(await readdir(path)).toHaveLength(2);
  await expect(store.set({ providerId: 'codex', sessionId: 'other', opaque: '{}' })).rejects.toThrow(/provider/);
  expect(await new SessionCreationStore(path, 'codex').get('new')).toBeUndefined();
});
