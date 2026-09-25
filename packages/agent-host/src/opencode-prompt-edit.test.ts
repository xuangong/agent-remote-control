import { expect, test } from 'vitest';
import type { AgentSession } from '@orchardworks/agent-provider-sdk';
import { createOpenCodeSessionDirectory } from './opencode-directory.js';

function fixture() {
  let forks = 0; let childOpens = 0;
  const session = (id: string): AgentSession => ({
    capabilities: { sessionControl: 'shared', history: true, sendMessage: true, steer: false, cancel: true, readResource: false, interactions: { question: true, planApproval: false, toolApproval: true } },
    async *observe() { yield { type: 'history_boundary' }; },
    async runtimeInfo() { return { providerId: 'opencode', sessionId: id, cwd: process.cwd(), status: 'idle', persistence: { providerId: 'opencode', sessionId: id, opaque: JSON.stringify({ cwd: process.cwd() }) } }; },
    async sendMessage() {}, async respondToInteraction() {}, async cancel() {}, async dispose() {},
  });
  const provider = {
    async listSessions() { return []; }, async getSession(id: string) { return { id, title: id, cwd: process.cwd(), updatedAt: new Date().toISOString() }; },
    async createSession() { return session('created'); }, async resumeSession() { return session('resumed'); }, async renameSession() {}, async close() {},
    async validatePromptEdit() {}, async forkForPromptEdit(target: { messageId: string }) { expect(target.messageId).toBe('prompt'); forks++; return session('branch'); },
    async openChildSession(parent: string, child: string) { expect(parent).toBe('parent'); expect(child).toBe('child'); childOpens++; return session(child); },
  };
  return { provider, counts: () => ({ forks, childOpens }) };
}

test('advertises verified prompt editing and retains the native branch for the Host projection', async () => {
  const f = fixture(); const directory = createOpenCodeSessionDirectory(f.provider, []);
  try {
    expect(directory.supportsPromptEditing).toBe(true);
    const id = await directory.create({ editNativeSessionId: 'source', editTurnId: 'prompt', editMessageId: 'prompt' });
    expect(id).toBe('branch'); expect((await (await directory.open(id)).runtimeInfo()).sessionId).toBe('branch');
    expect(f.counts().forks).toBe(1);
  } finally { await directory.close(); }
}, 10000);

test('checks source access before validation and fork and rejects incomplete edit identities', async () => {
  const f = fixture(); const directory = createOpenCodeSessionDirectory(f.provider, []);
  try {
    directory.setSourceAccessCheck?.(async () => { throw new Error('Outside allowed workspace'); });
    await expect(directory.validatePromptEdit!({ nativeSessionId: 'outside', turnId: 'prompt', messageId: 'prompt' })).rejects.toThrow('Outside');
    await expect(directory.create({ editNativeSessionId: 'outside', editTurnId: 'prompt', editMessageId: 'prompt' })).rejects.toThrow('Outside');
    await expect(directory.create({ editNativeSessionId: 'source' })).rejects.toThrow();
    expect(f.counts().forks).toBe(0);
  } finally { await directory.close(); }
}, 10000);

test('opens and reuses verified native children while checking both source workspaces', async () => {
  const f = fixture(); const directory = createOpenCodeSessionDirectory(f.provider, []); const checked: string[] = [];
  try {
    directory.setSourceAccessCheck?.(async id => { checked.push(id); });
    const child = await directory.openChild!('parent', 'child');
    expect(await directory.open('child')).toBe(child);
    expect(await directory.openChild!('parent', 'child')).toBe(child);
    expect(checked).toContain('parent'); expect(checked).toContain('child');
    expect(f.counts().childOpens).toBe(1);
  } finally { await directory.close(); }
}, 10000);
