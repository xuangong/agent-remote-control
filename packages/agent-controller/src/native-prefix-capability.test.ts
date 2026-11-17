import { expect, test } from 'vitest';
import { createCodexSessionDirectory } from './directory.js';
import { createOpenCodeSessionDirectory } from './opencode-directory.js';

const target = { nativeSessionId: 'source', turnId: 'turn', messageId: 'message' };
for (const providerId of ['codex', 'opencode'] as const) test.each(['absent', 'validate', 'create', 'verify', 'bound', 'oversized'])('%s rejects incomplete native prefix capability (%s) before effects', async malformed => {
  let effects = 0;
  const capability = { createdSessionIdMaxLength: 36, async validate() { effects++; }, async create() { effects++; throw new Error('unexpected'); }, async verify() { effects++; } };
  if (malformed === 'bound') capability.createdSessionIdMaxLength = 0;
  else if (malformed === 'oversized') capability.createdSessionIdMaxLength = 513;
  else if (malformed !== 'absent') Object.defineProperty(capability, malformed, { value: true });
  const provider = { createdSessionIdMaxLength: 36, nativePrefix: malformed === 'absent' ? undefined : capability,
    // Legacy convenience methods alone must not authorize durable creation.
    async validatePromptEdit() { effects++; }, async forkForPromptEdit() { effects++; throw new Error('unexpected'); }, async verifyPromptEditBranch() { effects++; },
    async createSession() { throw new Error('unused'); }, async resumeSession() { throw new Error('unused'); }, async openChildSession() { throw new Error('unused'); },
    async getSession() { return undefined; }, async renameSession() {}, async close() {} };
  const directory = providerId === 'codex' ? createCodexSessionDirectory({ ...provider, listSessions: async () => ({ sessions: [] }) }, [])
    : createOpenCodeSessionDirectory({ ...provider, listSessions: async () => [] }, []);
  try {
    expect(await directory.supportsNativePrefix!(target)).toBe(false);
    await expect(directory.createNativePrefix!(target, {}, undefined, async () => { throw new Error('unexpected checkpoint'); })).rejects.toThrow(/unavailable/);
    await expect(directory.verifyNativePrefix!(target, { providerId, sessionId: 'candidate', opaque: '{}' })).rejects.toThrow(/unavailable/);
    expect(effects).toBe(0);
    expect(await directory.supportsBoundedSourceCreate!({ sourceNativeSessionId: 'source' })).toBe(true);
  } finally { await directory.close(); }
});

for (const providerId of ['codex', 'opencode'] as const) test(`${providerId} rejects a missing durable checkpoint before calling a complete capability`, async () => {
  let creates = 0;
  const provider = { nativePrefix: { createdSessionIdMaxLength: 36, async validate() {}, async verify() {}, async create() { creates++; throw new Error('unexpected native create'); } },
    async createSession() { throw new Error('unused'); }, async resumeSession() { throw new Error('unused'); }, async openChildSession() { throw new Error('unused'); },
    async getSession() { return undefined; }, async renameSession() {}, async close() {} };
  const directory = providerId === 'codex' ? createCodexSessionDirectory({ ...provider, listSessions: async () => ({ sessions: [] }) }, [])
    : createOpenCodeSessionDirectory({ ...provider, listSessions: async () => [] }, []);
  try {
    expect(await directory.supportsNativePrefix!(target)).toBe(true);
    await expect(directory.createNativePrefix!(target, {}, undefined, undefined as never)).rejects.toThrow(/checkpoint/);
    expect(creates).toBe(0);
  } finally { await directory.close(); }
});
