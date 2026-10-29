import { realpathSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentProvider } from './provider.js';
import { Channel } from './channel.js';
import { claudeReadOnlyOptions } from './permission-modes.js';

const cwd = realpathSync(process.cwd());

function fixture(transcripts = true) {
  const captured: Options[] = [];
  const setPermissionMode = vi.fn(async () => {});
  const permissionModes = { read: vi.fn(async () => 'bypassPermissions' as const), write: vi.fn(async () => {}) };
  const catalog = { list: async () => [], info: async () => transcripts ? ({ cwd }) as any : undefined, messages: async () => [], children: async () => [] };
  const provider = () => new ClaudeAgentProvider({ catalog, permissionModes, query: ({ options }) => {
    captured.push(options);
    const stream = new Channel<any>();
    return { [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](), initializationResult: async () => ({}),
      close: () => stream.close(), interrupt: async () => {}, setPermissionMode } as any;
  } });
  return { captured, provider, setPermissionMode, permissionModes };
}

it('opens a read-only session with read-only options and refuses permission and planning changes', async () => {
  const f = fixture(); const provider = f.provider();
  expect(provider.descriptor.sessionAccess).toEqual({ readOnly: true });
  const session = await provider.createSession({ sessionId: 'local', cwd, access: 'read_only', planning: true, tools: [] });
  try {
    expect(f.captured[0]).toMatchObject(claudeReadOnlyOptions(cwd));
    expect(session.capabilities.planning).toBe(false);
    const info = await session.runtimeInfo();
    expect(info.planning).toEqual({ active: false });
    const permissions = info.settings!.find(setting => setting.id === 'permissions')!;
    expect(permissions).toMatchObject({ value: 'dontAsk', mutable: false });
    expect(permissions.options).toHaveLength(1);
    await expect(session.setSessionSetting!('permissions', 'bypassPermissions')).rejects.toThrow(/read-only/i);
    await expect(session.setPlanning!(true)).rejects.toThrow(/read-only/i);
    expect(f.setPermissionMode).not.toHaveBeenCalled();
    expect(f.permissionModes.write).not.toHaveBeenCalled();
    expect(JSON.parse(info.persistence!.opaque)).toMatchObject({ access: 'read_only' });
  } finally { await provider.dispose(); }
}, 10000);

it('keeps a persisted read-only session read-only when it is resumed without access', async () => {
  const f = fixture(); const first = f.provider();
  const session = await first.createSession({ sessionId: 'local', cwd, access: 'read_only' });
  const handle = (await session.runtimeInfo()).persistence!;
  await first.dispose();
  const cold = f.provider();
  const resumed = await cold.resumeSession(handle, { instructions: 'Review.' });
  try {
    expect(f.captured[1]).toMatchObject({ resume: handle.sessionId, ...claudeReadOnlyOptions(cwd) });
    await expect(resumed.setSessionSetting!('permissions', 'default')).rejects.toThrow(/read-only/i);
  } finally { await cold.dispose(); }
}, 10000);

it('makes a writable session read-only when resumed with read-only access', async () => {
  const f = fixture(); const first = f.provider();
  const session = await first.createSession({ sessionId: 'local', cwd });
  expect(f.captured[0]?.disallowedTools).toBeUndefined();
  const handle = (await session.runtimeInfo()).persistence!;
  await first.dispose();
  const cold = f.provider();
  await cold.resumeSession(handle, { access: 'read_only' });
  try { expect(f.captured[1]).toMatchObject(claudeReadOnlyOptions(cwd)); } finally { await cold.dispose(); }
}, 10000);

it('keeps read-only access in the creation handle of a session that has no transcript yet', async () => {
  const f = fixture(false); const provider = f.provider();
  const created = await provider.nativeEvidence!.createEmpty({ sessionId: '00000000-0000-4000-8000-000000000001', cwd });
  if (created.status !== 'created') throw new Error('Expected an empty handle.');
  const session = await provider.resumeSession(created.handle, { access: 'read_only' }, { initializeEmpty: true });
  const handle = (await session.runtimeInfo()).persistence!;
  await provider.dispose();
  expect(JSON.parse(handle.opaque)).toMatchObject({ kind: 'claude-empty-session', config: { access: 'read_only' } });
  const cold = f.provider();
  await cold.resumeSession(handle, {}, { initializeEmpty: true });
  try { expect(f.captured[1]).toMatchObject(claudeReadOnlyOptions(cwd)); } finally { await cold.dispose(); }
}, 10000);

it('protects the directory a read-only session runs in when it names no workspace', async () => {
  const f = fixture(); const provider = f.provider();
  await provider.createSession({ sessionId: 'local', access: 'read_only' });
  try { expect(f.captured[0]).toMatchObject(claudeReadOnlyOptions(cwd)); } finally { await provider.dispose(); }
}, 10000);
