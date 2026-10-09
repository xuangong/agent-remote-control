import { expect, it } from 'vitest';
import type { AgentSession, AgentSessionConfig, AgentSessionExtensions } from '@orchardworks/agent-provider-sdk';
import { createCodexSessionDirectory } from './directory.js';
import { createManagedStdioDirectory } from './stdio-directory.js';

function extensions(calls: string[], label = 'original'): AgentSessionExtensions {
  return { instructions: 'Coordinate this delivery.', systemPrompt: 'Use the work record.', tools: [{
    name: 'read_work', description: 'Read the current work record.',
    inputSchema: { type: 'object', properties: { revision: { type: 'number' } }, required: ['revision'] },
    async execute() { calls.push(label); return label; },
  }] };
}

function harness(providerId: 'codex' | 'claude' | 'copilot') {
  const created: AgentSessionConfig[] = [];
  const resumed: (AgentSessionExtensions | undefined)[] = [];
  let disposals = 0;
  let pauseResume: (() => Promise<void>) | undefined;
  function native(bound: AgentSessionExtensions = {}): AgentSession {
    let closed = false;
    return {
      capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
        interactions: { question: false, planApproval: false, toolApproval: false } },
      async *observe() { yield { type: 'history_boundary' }; },
      async runtimeInfo() { return { providerId, sessionId: 'native', status: closed ? 'closed' : 'idle',
        persistence: { providerId, sessionId: 'native', opaque: '{}' } }; },
      async sendMessage() { await bound.tools?.[0]?.execute({ revision: 1 }); },
      async respondToInteraction() {},
      async dispose() { closed = true; disposals++; },
    };
  }
  const methods = {
    async createSession(config: AgentSessionConfig) { created.push(config); return native(config); },
    async resumeSession(_handle: unknown, bound?: AgentSessionExtensions) {
      resumed.push(bound); await pauseResume?.(); return native(bound);
    },
    async openChildSession() { return native(); },
  };
  const directory = providerId === 'codex'
    ? createCodexSessionDirectory({ ...methods, listSessions: async () => ({ sessions: [] }) }, [])
    : createManagedStdioDirectory(providerId, providerId, { ...methods, listSessions: async () => [] }, []);
  return { directory, created, resumed, disposals: () => disposals,
    pauseResume: (pause: () => Promise<void>) => { pauseResume = pause; } };
}

it.each(['codex', 'claude', 'copilot'] as const)('%s rejects binding TPM extensions to a cached ordinary runtime', async providerId => {
  const h = harness(providerId); const calls: string[] = [];
  try {
    const id = await h.directory.create({});
    await expect(h.directory.open(id, { extensions: extensions(calls) })).rejects.toThrow(/extensions.*reopen/i);
    expect(h.created).toHaveLength(1); expect(h.resumed).toHaveLength(0); expect(h.disposals()).toBe(0);
    await (await h.directory.open(id)).sendMessage('The ordinary session remains available.');
    expect(calls).toEqual([]);
  } finally { await h.directory.close(); }
});

it.each(['codex', 'claude', 'copilot'] as const)('%s reuses equivalent TPM extensions with fresh callback closures', async providerId => {
  const h = harness(providerId); const calls: string[] = [];
  try {
    const id = await h.directory.create(extensions(calls));
    const fresh = extensions(calls, 'fresh');
    fresh.tools![0]!.inputSchema = { required: ['revision'], properties: { revision: { type: 'number' } }, type: 'object' };
    const session = await h.directory.open(id, { extensions: fresh });
    await session.sendMessage('Read the bound record.');
    expect(await h.directory.open(id)).toBe(session);
    expect(calls).toEqual(['original']); expect(h.created).toHaveLength(1); expect(h.resumed).toHaveLength(0);
  } finally { await h.directory.close(); }
});

const changes: Array<[string, (value: AgentSessionExtensions) => void]> = [
  ['instructions', value => { value.instructions = 'A different delivery.'; }],
  ['system prompt', value => { value.systemPrompt = 'A different base prompt.'; }],
  ['tool name', value => { value.tools![0]!.name = 'update_work'; }],
  ['tool description', value => { value.tools![0]!.description = 'Read another record.'; }],
  ['tool schema', value => { value.tools![0]!.inputSchema = { type: 'object', properties: { revision: { type: 'string' } } }; }],
];
for (const providerId of ['codex', 'claude', 'copilot'] as const) {
  it.each(changes)(`${providerId} rejects a changed cached %s without replacing the runtime`, async (_field, change) => {
    const h = harness(providerId); const calls: string[] = [];
    try {
      const id = await h.directory.create(extensions(calls));
      const changed = extensions(calls, 'changed'); change(changed);
      await expect(h.directory.open(id, { extensions: changed })).rejects.toThrow(/extensions.*reopen/i);
      expect(h.created).toHaveLength(1); expect(h.resumed).toHaveLength(0); expect(h.disposals()).toBe(0);
      await (await h.directory.open(id)).sendMessage('The original binding still works.');
      expect(calls).toEqual(['original']);
    } finally { await h.directory.close(); }
  });
}

it.each(['codex', 'claude', 'copilot'] as const)('%s forwards extensions on cold resume and validates the resumed cache', async providerId => {
  const h = harness(providerId); const calls: string[] = [];
  try {
    const first = await h.directory.open('native', { extensions: extensions(calls) });
    await first.dispose();
    const next = await h.directory.open('native', { extensions: extensions(calls, 'resumed') });
    await next.sendMessage('Read after cold resume.');
    const changed = extensions(calls, 'changed'); changed.instructions = 'Another delivery.';
    await expect(h.directory.open('native', { extensions: changed })).rejects.toThrow(/extensions.*reopen/i);
    expect(h.resumed).toHaveLength(2); expect(calls).toEqual(['resumed']); expect(h.disposals()).toBe(1);
  } finally { await h.directory.close(); }
});

it.each(['claude', 'copilot'] as const)('%s checks extension identity after waiting for an ordinary concurrent open', async providerId => {
  const h = harness(providerId); const calls: string[] = [];
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  h.pauseResume(async () => { started(); await gate; });
  try {
    const ordinary = h.directory.open('native'); await ready;
    const tpm = h.directory.open('native', { extensions: extensions(calls) });
    const rejected = expect(tpm).rejects.toThrow(/extensions.*reopen/i);
    release(); await ordinary; await rejected;
    expect(h.resumed).toHaveLength(1); expect(h.disposals()).toBe(0); expect(calls).toEqual([]);
  } finally { release(); await h.directory.close(); }
});
