import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AgentSession, AgentSessionConfig, AgentSessionExtensions } from '@orchardworks/agent-provider-sdk';
import { createOpenCodeSessionDirectory } from './opencode-directory.js';
import { SessionReferenceStore } from './session-reference.js';

function fixture(cwd: string) {
  let extensions: AgentSessionExtensions | undefined; let creates = 0; let resumes = 0; let reads = 0;
  const session = (id: string): AgentSession => {
    let closed = false;
    return { capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: false, interactions: { question: false, planApproval: false, toolApproval: false } },
      async *observe() {}, async sendMessage() {}, async cancel() {}, async respondToInteraction() {}, async dispose() { closed = true; },
      async runtimeInfo() { return { providerId: 'opencode', sessionId: id, cwd, status: closed ? 'closed' : 'idle', persistence: { providerId: 'opencode', sessionId: id, opaque: JSON.stringify({ cwd }) } }; } };
  };
  const provider = {
    async listSessions() { return []; }, async getSession(id: string) { return { id, title: id, cwd, updatedAt: new Date().toISOString() }; },
    async createSession(config: AgentSessionConfig) { creates++; extensions = config; return session('ask'); },
    async resumeSession(handle: { sessionId: string }, extra?: AgentSessionExtensions) { resumes++; extensions = extra; return session(handle.sessionId); },
    async readSessionHistory(id: string) { reads++; return { entries: [{ id: 'entry', turnId: 'turn', role: 'user', text: `source:${id}`, textOffset: 0, totalChars: 10 }] }; },
    async renameSession() {}, async close() {}, async validatePromptEdit() {},
  };
  return { provider, extensions: () => extensions!, counts: () => ({ creates, resumes, reads }) };
}
it('persists provider-scoped Ask grants, restores callbacks, and prevents release or editing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-opencode-ask-')); const f = fixture(root);
  const store = new SessionReferenceStore(root, 'opencode');
  let directory = createOpenCodeSessionDirectory(f.provider, [], store, true);
  try {
    expect(directory.supportsSourceReferences).toBe(true);
    expect(await directory.create({ sourceNativeSessionId: 'source', systemPrompt: 'Extra instructions' })).toBe('ask');
    expect(directory.requiresController!('ask')).toBe(true); expect(await directory.canReleaseSession!('ask')).toBe(false);
    expect(f.extensions().systemPrompt).toContain('Extra instructions');
    await expect(directory.validatePromptEdit!({ nativeSessionId: 'ask', turnId: 't', messageId: 'm' })).rejects.toThrow(/Ask/);
    expect(JSON.parse(await f.extensions().tools![0]!.execute({ limit: 1 })).sourceSessionId).toBe('source');
    await directory.close();
    directory = createOpenCodeSessionDirectory(f.provider, [], new SessionReferenceStore(root, 'opencode'), true);
    await directory.open('ask');
    expect(f.extensions().tools![0]!.name).toBe('read_source_session'); expect(directory.requiresController!('ask')).toBe(true);
    expect(f.counts()).toEqual({ creates: 1, resumes: 1, reads: 1 });
    await expect(new SessionReferenceStore(root).get('ask')).rejects.toThrow(/invalid/);
  } finally { await directory.close(); await rm(root, { recursive: true, force: true }); }
}, 10000);
it('rechecks source authorization on create, callback read, and resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-opencode-source-')); const f = fixture(root);
  const directory = createOpenCodeSessionDirectory(f.provider, [], new SessionReferenceStore(root, 'opencode'), true);
  let allowed = false; const checked: string[] = [];
  directory.setSourceAccessCheck!(async id => { checked.push(id); if (!allowed) throw new Error('Source workspace is outside allowed roots.'); });
  try {
    await expect(directory.create({ sourceNativeSessionId: 'source' })).rejects.toThrow(/outside/); expect(f.counts().creates).toBe(0);
    allowed = true; await directory.create({ sourceNativeSessionId: 'source' });
    allowed = false; await expect(f.extensions().tools![0]!.execute({})).rejects.toThrow(/outside/); expect(f.counts().reads).toBe(0);
    await (await directory.open('ask')).dispose();
    await expect(directory.open('ask')).rejects.toThrow(/outside/); expect(f.counts().resumes).toBe(0);
    expect(checked).toEqual(['source', 'source', 'source', 'source']);
  } finally { await directory.close(); await rm(root, { recursive: true, force: true }); }
}, 10000);
it('fails closed on saved Ask grants while ordinary sessions work without the plugin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-opencode-offline-')); const f = fixture(root);
  const store = new SessionReferenceStore(root, 'opencode'); await store.set({ sourceNativeSessionId: 'source', systemPrompt: 'source', handle: { providerId: 'opencode', sessionId: 'ask', opaque: JSON.stringify({ cwd: root }) } });
  const directory = createOpenCodeSessionDirectory(f.provider, [], store, false);
  try {
    expect(directory.supportsSourceReferences).toBe(false);
    await expect(directory.open('ask')).rejects.toThrow(/plugin/);
    await expect(directory.create({ sourceNativeSessionId: 'source' })).rejects.toThrow(/plugin/);
    expect((await (await directory.open('ordinary')).runtimeInfo()).sessionId).toBe('ordinary');
  } finally { await directory.close(); await rm(root, { recursive: true, force: true }); }
}, 10000);
