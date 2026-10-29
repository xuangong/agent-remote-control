import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AgentSessionExtensions } from '@orchardworks/agent-provider-sdk';
import type { NativeSessionRef, TeamSeat } from '@orchardworks/agent-remote-protocol';
import { TeamRuntime, type TeamRuntimeAccess } from './team.js';
import type { SessionCreation } from './role-session-creation.js';

it('creates a seat with its model, effort and access, and keeps the access when the seat is reattached', async () => {
  const root = await mkdtemp(join(tmpdir(), 'team-seat-configuration-'));
  const created: Array<{ provider: string; creation: SessionCreation; extensions: AgentSessionExtensions }> = [];
  const access: TeamRuntimeAccess = {
    controllerId: 'controller', available: () => true, supportedProviders: () => ['claude'],
    sessionRouting: { resolve: anchor => ({ anchor, target: anchor, operationIds: [] }), assertCurrent() {} },
    async create(provider, creation, extensions) { created.push({ provider, creation, extensions }); return 'reviewer-native'; },
    async acquire() { throw new Error('unused'); }, async execute() { throw new Error('unused'); },
  };
  const runtime = new TeamRuntime(root, access, async () => [], 1_000_000);
  const seat: TeamSeat = { teamId: 'team', source: { hostId: 'host', providerId: 'codex', nativeSessionId: 'worker', title: 'Worker' },
    member: { id: 'reviewer', hostId: 'host', providerId: 'claude', role: 'member', name: 'Reviewer', responsibility: 'Review.', cwd: root, creation: 'reserved',
      activity: 'unknown', summary: '', updatedAt: 1, model: 'opus', reasoningEffort: 'max', access: 'read_only', workspace: { kind: 'shared' } } };
  try {
    const member = await runtime.create(seat);
    expect(member).toMatchObject({ creation: 'ready', nativeSessionId: 'reviewer-native' });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ provider: 'claude', creation: { cwd: root, model: 'opus', reasoningEffort: 'max' }, extensions: { access: 'read_only' } });
    const holder: NativeSessionRef = { controllerId: 'controller', providerId: 'claude', nativeSessionId: 'reviewer-native' };
    expect(await runtime.extensions(holder, () => holder)).toMatchObject({ access: 'read_only' });
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
