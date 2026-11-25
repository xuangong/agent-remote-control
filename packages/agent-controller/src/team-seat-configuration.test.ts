import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AgentSessionExtensions } from '@orchardworks/agent-provider-sdk';
import type { NativeSessionRef, TeamSeat } from '@orchardworks/agent-remote-protocol';
import { TeamRuntime, type TeamRuntimeAccess } from './team.js';
import type { SessionCreation } from './role-session-creation.js';

it('creates a task worker\'s seat with its model, effort and access, and keeps the access when the seat is reattached', async () => {
  const root = await mkdtemp(join(tmpdir(), 'team-seat-configuration-'));
  const created: Array<{ provider: string; creation: SessionCreation; extensions: AgentSessionExtensions }> = [];
  const access: TeamRuntimeAccess = {
    controllerId: 'controller', available: () => true, supportedProviders: () => ['claude'],
    sessionRouting: { resolve: anchor => ({ anchor, target: anchor, operationIds: [] }), assertCurrent() {} },
    async create(provider, creation, extensions) { created.push({ provider, creation, extensions }); return 'reviewer-native'; },
    tasks: () => true,
    async acquire() { return { agent: { snapshot: () => ({ payload: { runtimeInfo: { cwd: root } } }) }, release() {} } as never; }, async execute() { throw new Error('unused'); },
  };
  const runtime = new TeamRuntime(root, access, async () => [], 1_000_000);
  const seat: TeamSeat = { teamId: 'team', source: { hostId: 'host', providerId: 'codex', nativeSessionId: 'worker', title: 'Worker' }, task: { title: 'Review' },
    member: { id: 'reviewer', hostId: 'host', providerId: 'claude', role: 'leader', name: 'Reviewer', responsibility: 'Review.', cwd: root, creation: 'reserved',
      activity: 'unknown', summary: '', updatedAt: 1, model: 'opus', reasoningEffort: 'max', access: 'read_only' } };
  try {
    const member = await runtime.create(seat);
    expect(member).toMatchObject({ creation: 'ready', nativeSessionId: 'reviewer-native' });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ provider: 'claude', creation: { cwd: root, model: 'opus', reasoningEffort: 'max' }, extensions: { access: 'read_only' } });
    const holder: NativeSessionRef = { controllerId: 'controller', providerId: 'claude', nativeSessionId: 'reviewer-native' };
    expect(await runtime.extensions(holder, () => holder)).toMatchObject({ access: 'read_only' });
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

it('creates a bot\'s seat in the folder the Relay chose without reading its source, which lives on another Host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'team-seat-folder-'));
  const created: SessionCreation[] = [];
  const acquired: string[] = [];
  const access: TeamRuntimeAccess = {
    controllerId: 'controller', available: () => true, supportedProviders: () => ['claude'],
    sessionRouting: { resolve: anchor => ({ anchor, target: anchor, operationIds: [] }), assertCurrent() {} },
    async create(_provider, creation) { created.push(creation); return 'builder-native'; }, tasks: () => true,
    async acquire(_provider, id) { acquired.push(id); throw new Error('The source session is on another Host.'); }, async execute() { throw new Error('unused'); },
  };
  const runtime = new TeamRuntime(root, access, async () => [], 1_000_000);
  const seat = (id: string, cwd?: string): TeamSeat => ({ teamId: id, source: { hostId: 'mac', providerId: 'claude', nativeSessionId: 'chief', title: 'Chief' }, task: { title: 'Build' },
    member: { id: `${id}-builder`, hostId: 'studio', providerId: 'claude', role: 'leader', name: 'Worker', responsibility: 'Build.', ...(cwd ? { cwd } : {}), creation: 'reserved', activity: 'unknown', summary: '', updatedAt: 1 } });
  try {
    expect(await runtime.create(seat('chosen', '/work/shop'))).toMatchObject({ creation: 'ready', cwd: '/work/shop' });
    expect(created).toEqual([expect.objectContaining({ cwd: '/work/shop' })]);
    expect(acquired).toEqual([]);
    // Without a chosen folder the seat still starts where its source works.
    await expect(runtime.create(seat('default'))).rejects.toThrow('another Host');
    expect(acquired).toEqual(['chief']);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
